import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Connection, Client } from '@temporalio/client';
import { db, withTenant } from '../db';
import { users, courses, modules, lessons, embeddings } from '../db/schema';
import { eq, desc, asc, sql, and, cosineDistance, inArray } from 'drizzle-orm';
import { authenticateToken, generateToken, UserPayload } from './auth';
import { recordHeartbeat, verifyHashChain } from './timeTracking';
import { runMigrations } from '../db/migrations';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'heygen-webhook-secret-key-12345';
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_QUEUE = process.env.TEMPORAL_QUEUE || 'elearning-tasks';

// Serve static frontend files
app.use(express.static(path.join(process.cwd(), 'public')));

// Cache for Temporal client
let temporalClient: Client | null = null;

async function getTemporalClient(): Promise<Client> {
  if (!temporalClient) {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    temporalClient = new Client({ connection });
  }
  return temporalClient;
}

// ==================== REST ENDPOINTS ====================

// 1. JWT Authentication / User Login or Registration
app.post('/api/auth/login', async (req, res) => {
  const { email, role, tenantId } = req.body;
  console.log(`[LOGIN ATTEMPT] Email: "${email}", Role: "${role}", TenantId: "${tenantId}"`);

  if (!email || !role || !tenantId) {
    console.warn(`[LOGIN FAILED] Missing fields. Email: ${email}, Role: ${role}, TenantId: ${tenantId}`);
    return res.status(400).json({ error: 'Email, role, and tenantId are required' });
  }

  try {
    // Upsert user
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    
    if (!user) {
      [user] = await db.insert(users).values({
        email,
        role: role as any,
        tenantId,
      }).returning();
      console.log(`[LOGIN SUCCESS] Created new user: ${email} for tenant ${tenantId}`);
    } else {
      // Update tenantId / role if modified
      await db.update(users)
        .set({ role: role as any, tenantId })
        .where(eq(users.id, user.id));
      user.role = role;
      user.tenantId = tenantId;
      console.log(`[LOGIN SUCCESS] Updated existing user: ${email} to Role: ${role}, Tenant: ${tenantId}`);
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role as any,
      tenantId: user.tenantId,
    });

    res.json({ token, user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId } });
  } catch (err: any) {
    console.error(`[LOGIN ERROR] Exception during login for ${email}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to list all users (for easy quick login/testing)
app.get('/api/auth/users', async (req, res) => {
  try {
    const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
    res.json(allUsers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Trigger Course Generation Workflow (Legacy - Redirected to Step 1 Wizard flow)
app.post('/api/courses/generate', authenticateToken, async (req, res) => {
  const { topic, duration } = req.body;
  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' });
  }
  const user = req.user!;
  try {
    const [course] = await db.insert(courses).values({
      userId: user.id,
      tenantId: user.tenantId,
      topic,
      status: 'curriculum_draft',
    }).returning();
    res.status(202).json({
      message: 'Course draft initiated.',
      courseId: course.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// WIZARD STEP 1: Generate Curriculum & Slides from Prompt
app.post('/api/courses/wizard/step1-curriculum', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { courseId, topic, duration, customPrompt } = req.body;

  try {
    // 1. Call Python AI Service
    const payload = {
      topic,
      tenant_id: user.tenantId,
      duration: duration || '2_weeks',
      custom_prompt: customPrompt || undefined
    };

    const response = await fetch(`${AI_SERVICE_URL}/generate-curriculum`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`AI Service returned status ${response.status}: ${await response.text()}`);
    }

    const curriculum = await response.json();

    // Delete existing modules/lessons if regenerating
    await db.delete(modules).where(eq(modules.courseId, courseId));

    // Save modules and lessons in database
    await db.transaction(async (tx) => {
      for (let i = 0; i < curriculum.modules.length; i++) {
        const modData = curriculum.modules[i];
        const [newModule] = await tx.insert(modules).values({
          courseId,
          sequenceOrder: i + 1,
          title: modData.title,
        }).returning();

        for (const lesData of modData.lessons) {
          await tx.insert(lessons).values({
            moduleId: newModule.id,
            tenantId: user.tenantId,
            title: lesData.title,
            contentPayload: {
              description: lesData.description,
              estimated_duration_minutes: lesData.estimated_duration_minutes,
              slides: lesData.slides || [],
              text_content: '',
              teleprompter_script: '',
              quiz: [],
            },
          });
        }
      }

      await tx.update(courses)
        .set({ status: 'curriculum_draft', topic: curriculum.course_title || topic })
        .where(eq(courses.id, courseId));
    });

    res.json({ success: true, message: 'Curriculum & slides generated successfully.' });
  } catch (err: any) {
    console.error('[wizard/step1-curriculum] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// WIZARD SAVE CURRICULUM & SLIDES
app.put('/api/courses/wizard/save-curriculum', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { courseId, title, modules: updatedModules } = req.body;

  try {
    await db.update(courses).set({ topic: title }).where(eq(courses.id, courseId));

    for (const mod of updatedModules) {
      await db.update(modules).set({ title: mod.title }).where(eq(modules.id, mod.id));
      for (const les of mod.lessons) {
        const [existingLesson] = await db.select().from(lessons).where(eq(lessons.id, les.id)).limit(1);
        if (existingLesson) {
          const oldPayload = existingLesson.contentPayload as any;
          await db.update(lessons)
            .set({
              title: les.title,
              contentPayload: {
                ...oldPayload,
                description: les.description,
                slides: les.slides || [],
              }
            })
            .where(eq(lessons.id, les.id));
        }
      }
    }
    res.json({ success: true, message: 'Curriculum & slides updated successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// WIZARD STEP 2: Generate lesson contents (texts, scripts, quizzes)
app.post('/api/courses/wizard/step2-content', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { courseId, customPrompt } = req.body;

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
    const moduleIds = courseModules.map((m) => m.id);
    if (moduleIds.length === 0) {
      return res.status(400).json({ error: 'No modules found for course' });
    }

    const allLessons = await db.select().from(lessons).where(inArray(lessons.moduleId, moduleIds));

    // Update course status to generating content
    await db.update(courses).set({ status: 'generating', progress: { percent: 25, step: 'Generiere Lektionsinhalte...' } }).where(eq(courses.id, courseId));

    // Run generation in the background asynchronously so the client doesn't time out
    (async () => {
      try {
        const total = allLessons.length;
        for (let i = 0; i < total; i++) {
          const lesson = allLessons[i];
          const moduleOfLesson = courseModules.find((m) => m.id === lesson.moduleId);
          const moduleTitle = moduleOfLesson ? moduleOfLesson.title : 'Modul';

          const percent = Math.round(25 + (i / total) * 50);
          await db.update(courses).set({ progress: { percent, step: `Generiere Lektion ${i + 1} von ${total}: "${lesson.title}"...` } }).where(eq(courses.id, courseId));

          const payload = {
            course_topic: course.topic,
            module_title: moduleTitle,
            lesson_title: lesson.title,
            tenant_id: user.tenantId,
            custom_prompt: customPrompt || undefined
          };

          const response = await fetch(`${AI_SERVICE_URL}/generate-lesson`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            throw new Error(`AI Service returned status ${response.status}: ${await response.text()}`);
          }

          const content = await response.json();
          const existingPayload = lesson.contentPayload as any;

          await db.update(lessons)
            .set({
              contentPayload: {
                ...existingPayload,
                teleprompter_script: content.teleprompter_script,
                text_content: content.text_content,
                quiz: content.quiz,
              }
            })
            .where(eq(lessons.id, lesson.id));

          // Generate embeddings
          const embResponse = await fetch(`${AI_SERVICE_URL}/generate-embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: content.text_content, tenant_id: user.tenantId }),
          }).then((r) => r.json());

          // Save vector
          await withTenant(user.tenantId, async (tx) => {
            await tx.delete(embeddings).where(eq(embeddings.lessonId, lesson.id));
            await tx.insert(embeddings).values({
              lessonId: lesson.id,
              tenantId: user.tenantId,
              embedding: embResponse.embedding,
            });
          });
        }

        // Set status to content_draft for final preview
        await db.update(courses).set({ status: 'content_draft', progress: { percent: 80, step: 'Lektionsinhalte generiert.' } }).where(eq(courses.id, courseId));
      } catch (bgErr: any) {
        console.error('Background lesson content generation failed:', bgErr);
        await db.update(courses).set({ status: 'failed', progress: { percent: 100, step: `Fehler: ${bgErr.message}` } }).where(eq(courses.id, courseId));
      }
    })();

    res.json({ success: true, message: 'Content generation started.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// WIZARD SAVE LESSON CONTENT (text, quiz, teleprompter script)
app.put('/api/courses/wizard/save-lesson', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { lessonId, textContent, teleprompterScript, quiz } = req.body;

  try {
    const [existingLesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
    if (!existingLesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const oldPayload = existingLesson.contentPayload as any;
    await db.update(lessons)
      .set({
        contentPayload: {
          ...oldPayload,
          text_content: textContent,
          teleprompter_script: teleprompterScript,
          quiz: quiz || [],
        }
      })
      .where(eq(lessons.id, lessonId));

    res.json({ success: true, message: 'Lesson content saved successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// WIZARD STEP 3: Trigger Temporal Media (ElevenLabs Audio) Generation
app.post('/api/courses/wizard/step3-media', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { courseId } = req.body;

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    await db.update(courses).set({ status: 'generating', progress: { percent: 80, step: 'Rendere Video-Avatare und Sprache...' } }).where(eq(courses.id, courseId));

    // Trigger Temporal Workflow to render media
    const client = await getTemporalClient();
    const handle = await client.workflow.start('CourseGenerationWorkflow', {
      taskQueue: TEMPORAL_QUEUE,
      workflowId: `course-gen-${course.id}`,
      args: [{
        courseId: course.id,
        userId: user.id,
        tenantId: user.tenantId,
        topic: course.topic,
      }],
    });

    res.json({ success: true, message: 'Media rendering triggered via Temporal workflow.', workflowId: handle.workflowId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. List Courses (filtered by tenant for data safety, admins see all)
app.get('/api/courses', authenticateToken, async (req, res) => {
  const user = req.user!;
  try {
    let list;
    if (user.role === 'admin') {
      list = await db.select().from(courses)
        .orderBy(desc(courses.createdAt));
    } else {
      list = await db.select().from(courses)
        .where(eq(courses.tenantId, user.tenantId))
        .orderBy(desc(courses.createdAt));
    }
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Fetch Course Details (Modules, Lessons, and Video URL)
app.get('/api/courses/:id', authenticateToken, async (req, res) => {
  const user = req.user!;
  const { id } = req.params;

  try {
    let courseQuery = db.select().from(courses).where(eq(courses.id, id));
    if (user.role !== 'admin') {
      courseQuery = db.select().from(courses).where(and(eq(courses.id, id), eq(courses.tenantId, user.tenantId)));
    }
    const [course] = await courseQuery.limit(1);

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const courseModules = await db.select().from(modules)
      .where(eq(modules.courseId, id))
      .orderBy(asc(modules.sequenceOrder));

    const moduleIds = courseModules.map((m) => m.id);
    
    let courseLessons: any[] = [];
    if (moduleIds.length > 0) {
      courseLessons = await db.select().from(lessons)
        .where(inArray(lessons.moduleId, moduleIds))
        .orderBy(asc(lessons.createdAt));
    }

    res.json({ course, modules: courseModules, lessons: courseLessons });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Approve Course (Admin only)
app.post('/api/courses/:id/approve', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  const { id } = req.params;

  try {
    const [course] = await db.select().from(courses)
      .where(eq(courses.id, id))
      .limit(1);

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    await db.update(courses)
      .set({ status: 'active' })
      .where(eq(courses.id, id));

    res.json({ message: 'Course approved successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Cancel/Stop Course Generation (Admin only, cancels Temporal workflow and fails course)
app.post('/api/courses/:id/cancel', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { id } = req.params;

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(`course-gen-${id}`);
      await handle.cancel();
      console.log(`Cancelled Temporal workflow for course-gen-${id}`);
    } catch (wfErr: any) {
      console.warn(`Could not cancel Temporal workflow: ${wfErr.message}`);
    }

    await db.update(courses)
      .set({ status: 'failed' })
      .where(eq(courses.id, id));

    res.json({ success: true, message: 'Course generation stopped successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5c. Delete Course (Admin only, deletes course and cascades modules, lessons, embeddings)
app.delete('/api/courses/:id', authenticateToken, async (req, res) => {
  const user = req.user!;
  const { id } = req.params;
  console.log(`[DELETE ATTEMPT] CourseId: ${id}, User: ${user.email}, Role: ${user.role}`);

  if (user.role !== 'admin') {
    console.warn(`[DELETE FAILED] User ${user.email} is not admin (Role: ${user.role})`);
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
    if (!course) {
      console.warn(`[DELETE FAILED] Course ${id} not found in database`);
      return res.status(404).json({ error: 'Course not found' });
    }

    if (course.status === 'generating') {
      try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(`course-gen-${id}`);
        await handle.cancel();
        console.log(`[DELETE] Cancelled Temporal workflow for course-gen-${id} on delete`);
      } catch (wfErr: any) {
        console.warn(`[DELETE] Could not cancel Temporal workflow on delete: ${wfErr.message}`);
      }
    }

    await db.delete(courses).where(eq(courses.id, id));
    console.log(`[DELETE SUCCESS] Course ${id} deleted successfully by user ${user.email}`);
    res.json({ success: true, message: 'Course deleted successfully' });
  } catch (err: any) {
    console.error(`[DELETE ERROR] Exception during course delete:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 6. HeyGen Webhook Callback (Authenticates signature and resumes Temporal Workflow)
app.post('/api/webhooks/heygen', async (req, res) => {
  const signature = req.headers['x-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Signature header X-Signature is missing' });
  }

  // Verify HMAC-SHA256 signature
  const bodyString = JSON.stringify(req.body);
  const computedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(bodyString)
    .digest('hex');

  if (signature !== computedSignature) {
    console.warn('[WEBHOOK ERROR] Invalid HeyGen signature!');
    return res.status(403).json({ error: 'Invalid HMAC-SHA256 signature' });
  }

  const { video_id, status, video_url, course_id } = req.body;
  console.log(`[WEBHOOK SUCCESS] HeyGen callback verified for video ${video_id}. Status: ${status}`);

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`course-gen-${course_id}`);
    
    // Send signal to the running Temporal workflow
    await handle.signal('HeyGenWebhookSignal', {
      videoUrl: video_url || '',
      success: status === 'completed',
    });

    res.json({ received: true });
  } catch (err: any) {
    console.error(`[WEBHOOK ERROR] Failed to signal workflow course-gen-${course_id}:`, err.message);
    res.status(500).json({ error: `Failed to signal workflow: ${err.message}` });
  }
});

// 7. Time Tracking Heartbeat (Stateless JWT authenticates, sha256 appends)
app.post('/api/time-tracking/heartbeat', authenticateToken, async (req, res) => {
  const user = req.user!;
  const { sessionId, durationSec } = req.body;

  if (!sessionId || durationSec === undefined) {
    return res.status(400).json({ error: 'sessionId and durationSec are required' });
  }

  try {
    const log = await recordHeartbeat(user.id, sessionId, durationSec);
    res.json({
      message: 'Heartbeat recorded securely.',
      cryptoHash: log.cryptoHash,
      previousHash: log.previousHash,
      timestamp: log.timestamp.toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Verify Session Time Logs (Admin only, checks hash chains)
app.get('/api/time-tracking/verify/:sessionId', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  const { sessionId } = req.params;

  try {
    const verification = await verifyHashChain(sessionId);
    res.json(verification);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. pgvector RAG AI Tutor Chat (Strict Tenant Isolation via RLS)
app.post('/api/tutor/query', authenticateToken, async (req, res) => {
  const user = req.user!;
  const { courseId, query } = req.body;

  if (!courseId || !query) {
    return res.status(400).json({ error: 'courseId and query are required' });
  }

  try {
    // A. Generate embedding vector for the question using AI Service
    const embData = await fetch(`${AI_SERVICE_URL}/generate-embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: query, tenant_id: user.tenantId }),
    }).then((r) => r.json());

    const queryVector = embData.embedding;

    // B. Query database inside `withTenant` to enforce Postgres RLS
    const contextChunks = await withTenant(user.tenantId, async (tx) => {
      // Calculate cosine similarity: 1 - cosine_distance
      // Filter results to keep vectors of the active course
      const similarity = sql`1 - (${cosineDistance(embeddings.embedding, queryVector)})`;
      
      return await tx
        .select({
          lessonTitle: lessons.title,
          textContent: sql`content_payload->>'text_content'`,
          similarity: similarity,
        })
        .from(embeddings)
        .innerJoin(lessons, eq(embeddings.lessonId, lessons.id))
        .where(
          and(
            eq(embeddings.tenantId, user.tenantId),
            eq(modules.courseId, courseId)
          )
        )
        .innerJoin(modules, eq(lessons.moduleId, modules.id))
        .orderBy(desc(similarity))
        .limit(3);
    });

    // C. Combine text chunks to construct context
    const contextText = contextChunks
      .map((c) => `Lektion: ${c.lessonTitle}\nInhalt: ${c.textContent}`)
      .join('\n\n');

    // D. Fetch AI Service endpoint to generate answer
    // For simplicity, we can do a prompt directly to OpenRouter or call a /generate-answer mock endpoint.
    // We make a direct LLM call via the AI Service by asking it to complete a prompt.
    const prompt = `Du bist ein hilfreicher KI-Tutor. Beantworte die Frage des Schülers ausschließlich basierend auf dem folgenden Kurskontext:
---
${contextText}
---
Frage: ${query}

Antwort:`;

    // To keep it simple, we can call the generate-lesson endpoint or use standard fetch to Python service.
    // Let's add a helper inside Python Service or mock it.
    // If we call OpenRouter directly we would need keys. We call Python AI Service to get completions.
    // Let's call Python service. We will create a small endpoint "/generate-answer" on FastAPI.
    const response = await fetch(`${AI_SERVICE_URL}/generate-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, tenant_id: user.tenantId }),
    });

    let answer = 'Entschuldigung, der KI-Tutor konnte keine Verbindung zum Modell herstellen.';
    if (response.ok) {
      const data = await response.json();
      answer = data.answer;
    } else {
      // Fallback
      answer = `[RAG Tutor - Mock Antwort für Tenant ${user.tenantId}]\nBasierend auf Lektion "${contextChunks[0]?.lessonTitle || 'Einführung'}": Hier ist die Antwort auf Ihre Frage "${query}". (Postgres RLS aktiv gefiltert).`;
    }

    res.json({
      answer,
      contextUsed: contextChunks.map((c) => ({ title: c.lessonTitle, similarity: c.similarity })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper functions to manage the .env file
function readEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const result: Record<string, string> = {};
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const value = parts.slice(1).join('=').trim();
    result[key] = value;
  });
  return result;
}

function writeEnvFile(config: Record<string, string>) {
  const envPath = path.join(process.cwd(), '.env');
  const sections = [
    '# Database Configuration',
    `DATABASE_URL=${config.DATABASE_URL || 'postgres://postgres:postgres@localhost:5439/elearning'}`,
    '',
    '# Server Configuration',
    `PORT=${config.PORT || '3010'}`,
    `JWT_SECRET=${config.JWT_SECRET || 'supersecretjwtkeyforauthentication123!'}`,
    `JWT_ISSUER=${config.JWT_ISSUER || 'elearning-platform'}`,
    `JWT_AUDIENCE=${config.JWT_AUDIENCE || 'elearning-students'}`,
    '',
    '# Temporal Configuration',
    `TEMPORAL_ADDRESS=${config.TEMPORAL_ADDRESS || 'localhost:7233'}`,
    `TEMPORAL_QUEUE=${config.TEMPORAL_QUEUE || 'elearning-tasks'}`,
    '',
    '# HeyGen API & Webhooks',
    `HEYGEN_API_URL=${config.HEYGEN_API_URL || 'http://localhost:3010/api/mock/heygen'}`,
    `HEYGEN_API_KEY=${config.HEYGEN_API_KEY || 'mock-heygen-key'}`,
    `WEBHOOK_SECRET=${config.WEBHOOK_SECRET || 'heygen-webhook-secret-key-12345'}`,
    `WEBHOOK_URL=${config.WEBHOOK_URL || 'http://localhost:3010/api/webhooks/heygen'}`,
    '',
    '# ElevenLabs configuration',
    `ELEVENLABS_API_KEY=${config.ELEVENLABS_API_KEY || 'mock-elevenlabs-key'}`,
    `ELEVENLABS_VOICE_ID=${config.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'}`,
    '',
    '# Media Generation Config',
    `GENERATE_VIDEO=${config.GENERATE_VIDEO !== undefined ? config.GENERATE_VIDEO : 'false'}`,
    `VIDEO_PROVIDER=${config.VIDEO_PROVIDER || 'elevenlabs'}`,
    `ELEVENLABS_TTS_ONLY=${config.ELEVENLABS_TTS_ONLY !== undefined ? config.ELEVENLABS_TTS_ONLY : 'true'}`,
    '',
    '# AI Service Configuration (Python FastAPI)',
    `AI_SERVICE_URL=${config.AI_SERVICE_URL || 'http://127.0.0.1:8085'}`,
    `LLM_PROVIDER=${config.LLM_PROVIDER || 'openrouter'}`,
    `EMBEDDING_PROVIDER=${config.EMBEDDING_PROVIDER || 'local'}`,
    '',
    '# API Keys',
    `OPENROUTER_API_KEY=${config.OPENROUTER_API_KEY || 'mock-openrouter-key'}`,
    `OPENROUTER_MODEL=${config.OPENROUTER_MODEL || 'google/gemini-2.5-pro'}`,
    `vLLM_BASE_URL=${config.vLLM_BASE_URL || 'http://localhost:8000/v1'}`,
    `vLLM_MODEL=${config.vLLM_MODEL || 'meta-llama/Meta-Llama-3-8B-Instruct'}`,
  ];
  fs.writeFileSync(envPath, sections.join('\n'), 'utf-8');
}

function maskKey(key: string): string {
  if (!key || key.length < 6) return '******';
  if (key === 'mock-openrouter-key' || key === 'mock-elevenlabs-key' || key === 'mock-heygen-key') {
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
  }
  return key.slice(0, 3) + '*'.repeat(12) + key.slice(-3);
}

// 10. GET AI Config (Admin only)
app.get('/api/admin/config', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  try {
    const env = readEnvFile();
    const masked: Record<string, string> = {};
    for (const key of Object.keys(env)) {
      if (key.includes('KEY') || key.includes('SECRET') || key.includes('PASSWORD')) {
        masked[key] = maskKey(env[key]);
      } else {
        masked[key] = env[key];
      }
    }
    res.json(masked);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11. POST AI Config (Admin only)
app.post('/api/admin/config', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  try {
    const existing = readEnvFile();
    const submitted = req.body;

    for (const key of Object.keys(submitted)) {
      const value = submitted[key];
      // Only update if it doesn't contain masks
      if (value && value.includes('***')) {
        continue;
      }
      existing[key] = value;
      process.env[key] = value; // update in-memory Node.js env
    }

    writeEnvFile(existing);
    console.log('[CONFIG] AI parameters updated successfully in .env');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// In-memory cache for usage stats to avoid hitting external API rate limits
let usageCache: { timestamp: number; data: any } | null = null;

// 11b. GET AI Usage and Costs (Admin only, cached for 60s)
app.get('/api/admin/usage', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  const now = Date.now();
  if (usageCache && (now - usageCache.timestamp < 60000)) {
    console.log('[USAGE] Returning cached usage stats');
    return res.json(usageCache.data);
  }

  const env = readEnvFile();
  const openRouterKey = env.OPENROUTER_API_KEY || '';
  const elevenlabsKey = env.ELEVENLABS_API_KEY || '';

  const stats = {
    openrouter: { success: false, usage: 'Nicht konfiguriert', label: '' },
    elevenlabs: { success: false, usage: 'Nicht konfiguriert', characterCount: 0, characterLimit: 0 },
  };

  // 1. Fetch OpenRouter usage
  if (openRouterKey && openRouterKey !== 'mock-openrouter-key') {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${openRouterKey}` },
      });
      if (response.ok) {
        const data = await response.json() as any;
        if (data && data.data) {
          stats.openrouter = {
            success: true,
            usage: `$${(data.data.usage || 0).toFixed(4)}`,
            label: data.data.label || 'API Key',
          };
        }
      } else {
        stats.openrouter.usage = 'Ungültiger Key';
      }
    } catch (err: any) {
      stats.openrouter.usage = 'Verbindungsfehler';
    }
  } else if (openRouterKey === 'mock-openrouter-key') {
    stats.openrouter = { success: true, usage: '$0.00 (Mock-Modus)', label: 'Demo Key' };
  }

  // 2. Fetch ElevenLabs usage
  if (elevenlabsKey && elevenlabsKey !== 'mock-elevenlabs-key') {
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        method: 'GET',
        headers: { 'xi-api-key': elevenlabsKey },
      });
      if (response.ok) {
        const data = await response.json() as any;
        stats.elevenlabs = {
          success: true,
          usage: `${data.character_count.toLocaleString()} / ${data.character_limit.toLocaleString()} Zeichen`,
          characterCount: data.character_count,
          characterLimit: data.character_limit,
        };
      } else {
        stats.elevenlabs.usage = 'Ungültiger Key';
      }
    } catch (err: any) {
      stats.elevenlabs.usage = 'Verbindungsfehler';
    }
  } else if (elevenlabsKey === 'mock-elevenlabs-key') {
    stats.elevenlabs = { success: true, usage: '0 / 100.000 Zeichen (Mock-Modus)', characterCount: 0, characterLimit: 100000 };
  }

  usageCache = {
    timestamp: now,
    data: stats,
  };

  res.json(stats);
});

// 12. Test OpenRouter Key (Admin only)
app.post('/api/admin/config/test-openrouter', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  let { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'API-Key ist erforderlich' });
  }

  if (apiKey.includes('***')) {
    apiKey = process.env.OPENROUTER_API_KEY || '';
  }

  if (!apiKey || apiKey === 'mock-openrouter-key') {
    return res.status(400).json({ error: 'Kein gültiger API-Key konfiguriert' });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    const data = await response.json() as any;
    if (response.ok && data && data.data) {
      return res.json({
        success: true,
        label: data.data.label || 'API Key',
        usage: data.data.usage,
      });
    } else {
      return res.status(400).json({
        error: data?.error?.message || 'Ungültiger API-Key oder Authentifizierungsfehler bei OpenRouter.',
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: `Verbindungsfehler: ${err.message}` });
  }
});

// 12b. Test ElevenLabs Key & Voice ID (Admin only)
app.post('/api/admin/config/test-elevenlabs', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  let { apiKey, voiceId } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'API-Key ist erforderlich' });
  }

  if (apiKey.includes('***')) {
    apiKey = process.env.ELEVENLABS_API_KEY || '';
  }
  if (!voiceId) {
    voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  }

  if (!apiKey || apiKey === 'mock-elevenlabs-key') {
    return res.status(400).json({ error: 'Kein gültiger API-Key konfiguriert' });
  }

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
      },
    });

    if (!response.ok) {
      const errData = await response.json() as any;
      return res.status(400).json({
        error: errData?.detail?.message || 'Ungültiger ElevenLabs API-Key.',
      });
    }

    const subData = await response.json() as any;
    let voiceName = 'Standard';
    
    try {
      const voiceResponse = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
        },
      });

      if (voiceResponse.ok) {
        const voiceData = await voiceResponse.json() as any;
        voiceName = voiceData.name || 'Unbekannt';
      } else {
        return res.status(400).json({
          error: `API Key ist gültig, aber die Voice ID "${voiceId}" wurde nicht gefunden.`,
        });
      }
    } catch (vErr) {
      console.warn('Voice validation error:', vErr);
    }

    return res.json({
      success: true,
      characterCount: subData.character_count,
      characterLimit: subData.character_limit,
      voiceName,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Verbindungsfehler: ${err.message}` });
  }
});

// ==================== MOCK HEYGEN API ENDPOINTS ====================

// Mock Endpoint to simulate HeyGen video rendering
app.post('/api/mock/heygen/generate', (req, res) => {
  const { videoId, courseId, script, audioUrl, webhookUrl } = req.body;
  
  console.log(`[MOCK HEYGEN] Starting video generation. VideoID: ${videoId}, CourseID: ${courseId}`);

  // Respond immediately with accepted status
  res.status(202).json({ success: true, video_id: videoId });

  // Simulate rendering duration of 3 seconds, then hit webhook url
  setTimeout(async () => {
    const webhookPayload = {
      video_id: videoId,
      status: 'completed',
      video_url: 'https://assets.mixkit.co/videos/preview/mixkit-software-developer-working-on-his-computer-34281-large.mp4',
      course_id: courseId,
    };

    // Calculate signature
    const computedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(JSON.stringify(webhookPayload))
      .digest('hex');

    try {
      console.log(`[MOCK HEYGEN] Video rendering complete. Sending webhook callback for course ${courseId}...`);
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': computedSignature,
        },
        body: JSON.stringify(webhookPayload),
      });
      console.log(`[MOCK HEYGEN] Webhook response status: ${response.status}`);
    } catch (err: any) {
      console.error('[MOCK HEYGEN] Failed to send webhook callback:', err.message);
    }
  }, 3000);
});

// Start Express Server
async function startServer() {
  try {
    // 1. Run migrations first
    await runMigrations();
    
    app.listen(PORT, () => {
      console.log(`Express REST API Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
}

// Only start server if run directly
if (require.main === module) {
  startServer();
}

// Trigger restart (v5)

