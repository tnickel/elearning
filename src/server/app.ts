import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Connection, Client } from '@temporalio/client';
import { db, withTenant, inList } from '../db';
import { users, courses, modules, lessons, embeddings, activityLogs } from '../db/schema';
import { eq, desc, asc, sql, and } from 'drizzle-orm';
import { authenticateToken, generateToken, UserPayload, ensureSecretEnv } from './auth';
import { recordHeartbeat, verifyHashChain } from './timeTracking';
import { runMigrations } from '../db/migrations';
import { OfficeParser } from 'officeparser';
import { renderPptxToPngs, publishSlideImages, cleanupWorkDir } from './pptxRender';
import { synthesizeSpeechToFile, computeSlidePipelineStatus } from './tts';
import { exportCourseToMp4, ExportProgress } from './videoExport';

dotenv.config();

const exportJobs = new Set<string>();

const app = express();

// CORS restricted to the configured origins (the frontend is served same-origin anyway).
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3010,http://127.0.0.1:3010')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

// Capture the raw request bytes so webhook HMAC can be computed over the exact
// payload a provider signed (re-serializing req.body would not match it).
app.use(express.json({
  verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; },
}));

const PORT = process.env.PORT || 3010;
const WEBHOOK_SECRET = ensureSecretEnv('WEBHOOK_SECRET', ['heygen-webhook-secret-key-12345']);
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8085';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_QUEUE = process.env.TEMPORAL_QUEUE || 'elearning-tasks';

// Serve static frontend files
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/course_output', express.static(path.join(process.cwd(), 'course_output')));

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

// 1. JWT Authentication / User Login or Registration (local demo: email + role picker)
app.post('/api/auth/login', async (req, res) => {
  const { email, role, tenantId } = req.body;
  console.log(`[LOGIN ATTEMPT] Email: "${email}", Requested Role: "${role}", TenantId: "${tenantId}"`);

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const allowedAdminEmails = (process.env.ADMIN_EMAILS || 'admin@tenant-alpha.com')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const emailLower = String(email).trim().toLowerCase();
    const isAllowedAdmin = allowedAdminEmails.includes(emailLower);
    const requestedAdmin = role === 'admin';
    // Local demo: admin only for whitelisted emails; everyone else stays/becomes student.
    const assignedRole = requestedAdmin && isAllowedAdmin ? 'admin' : 'student';
    const assignedTenantId = tenantId || 'de305d54-75b4-431b-adb2-eb6b9e546014';

    if (requestedAdmin && !isAllowedAdmin) {
      console.warn(
        `[LOGIN] Admin-Rolle verweigert für "${email}" — nicht in ADMIN_EMAILS. ` +
          `Nutze z.B. admin@tenant-alpha.com oder setze ADMIN_EMAILS in .env.`
      );
    }

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user) {
      [user] = await db.insert(users).values({
        email: String(email).trim(),
        role: assignedRole as any,
        tenantId: assignedTenantId,
      }).returning();
      console.log(`[LOGIN SUCCESS] Created new user: ${email} with Role: ${user.role}, Tenant: ${user.tenantId}`);
    } else {
      // Update role/tenant for demo login so switching Admin↔Schüler works for
      // whitelisted admin emails (fixes "stuck as student" after first login).
      const needsUpdate = user.role !== assignedRole || user.tenantId !== assignedTenantId;
      if (needsUpdate) {
        await db.update(users)
          .set({ role: assignedRole as any, tenantId: assignedTenantId })
          .where(eq(users.id, user.id));
        user = { ...user, role: assignedRole as any, tenantId: assignedTenantId };
        console.log(`[LOGIN SUCCESS] Updated user: ${email} → Role: ${user.role}, Tenant: ${user.tenantId}`);
      } else {
        console.log(`[LOGIN SUCCESS] Authenticated existing user: ${email} (Role: ${user.role})`);
      }
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

// Endpoint to list all users (P0.2 FIX: Admin only)
app.get('/api/auth/users', authenticateToken, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  try {
    const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
    res.json(allUsers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Trigger Course Generation Workflow (Legacy - Redirected to Step 1 Wizard flow)
app.post('/api/courses/generate', authenticateToken, async (req, res) => {
  const { topic, duration, mode } = req.body;
  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' });
  }
  const user = req.user!;
  try {
    const isConceptMode = mode === 'concept';
    const [course] = await db.insert(courses).values({
      userId: user.id,
      tenantId: user.tenantId,
      topic,
      status: 'generating',
      progress: {
        duration: duration || '2_weeks',
        mode: isConceptMode ? 'concept' : 'full',
        percent: 0,
        step: isConceptMode ? 'Konzept-Entwurf angelegt…' : 'Warte auf Lehrplan-Generierung…',
      },
    }).returning();
    res.status(202).json({
      message: 'Course draft initiated.',
      courseId: course.id,
      mode: isConceptMode ? 'concept' : 'full',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Finalize a course draft as concept-only (curriculum frame completed without slides)
app.post('/api/courses/:id/finish-concept', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const courseId = req.params.id;
  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const currentProgress = (course.progress as any) || {};
    await db.update(courses).set({
      status: 'content_draft',
      progress: {
        ...currentProgress,
        mode: 'concept',
        percent: 100,
        step: 'Didaktisches Konzept fertiggestellt',
      },
    }).where(eq(courses.id, courseId));
    res.json({ success: true, message: 'Didaktisches Konzept erfolgreich gespeichert' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PowerPoint .pptx Import Endpoint — renders slides 1:1 as PNGs via PowerPoint + pdftoppm
app.post('/api/courses/import-pptx', express.raw({ type: '*/*', limit: '50mb' }), authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admins only' });
  }

  const filename = (req.query.filename as string) || 'Importierter Kurs.pptx';
  const courseTopic = filename.replace(/\.pptx$/i, '');
  let workDir: string | null = null;

  try {
    const fileBuffer = req.body as Buffer;
    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: 'No file buffer provided' });
    }

    console.log(`[PPTX IMPORT] Rendering "${filename}" (${fileBuffer.length} bytes) to PNGs...`);

    // 1) Optional text extraction for titles / RAG (does not drive visuals)
    const textBySlide: Array<{ title: string; bullets: string[] }> = [];
    try {
      const ast = await OfficeParser.parseOffice(fileBuffer);
      const slideNodes = (ast.content || []).filter((n: any) => n.type === 'slide');
      slideNodes.forEach((slideNode: any) => {
        let title = '';
        const bullets: string[] = [];
        const collect = (n: any) => {
          if (n.type === 'heading' || (n.type === 'paragraph' && !title)) {
            if (!title && n.text?.trim()) title = n.text.trim();
            else if (n.text?.trim()) bullets.push(n.text.trim());
          } else if ((n.type === 'list' || n.type === 'paragraph') && n.text?.trim()) {
            bullets.push(n.text.trim());
          }
          if (n.children) n.children.forEach(collect);
        };
        if (slideNode.children) slideNode.children.forEach(collect);
        if (!title && slideNode.text?.trim()) {
          const lines = slideNode.text.split('\n').map((l: string) => l.trim()).filter(Boolean);
          if (lines.length) {
            title = lines[0];
            bullets.push(...lines.slice(1));
          }
        }
        textBySlide.push({ title: title || '', bullets: bullets.filter((b) => b !== title) });
      });
    } catch (parseErr: any) {
      console.warn(`[PPTX IMPORT] Text parse skipped: ${parseErr.message}`);
    }

    // 2) 1:1 visual render
    const rendered = await renderPptxToPngs(fileBuffer);
    workDir = rendered.workDir;

    // 3) Create course, then publish PNGs under public/slides/{courseId}/
    const [newCourse] = await db.insert(courses).values({
      userId: user.id,
      tenantId: user.tenantId,
      topic: courseTopic,
      status: 'content_draft',
      progress: { percent: 40, step: 'PowerPoint 1:1 importiert – Sprechtexte ausstehend', source: 'pptx' },
    }).returning();

    const published = publishSlideImages(newCourse.id, rendered.slides);

    const slidesPayload = published.map((img, idx) => {
      const text = textBySlide[idx] || { title: '', bullets: [] as string[] };
      return {
        title: text.title || `Folie ${idx + 1}`,
        layout: 'image',
        bullets: text.bullets,
        image_url: img.imageUrl,
        speaker_notes: '',
      };
    });

    const [newMod] = await db.insert(modules).values({
      courseId: newCourse.id,
      sequenceOrder: 1,
      title: 'Modul 1: Importierte Präsentation',
    }).returning();

    const text_content = `# ${courseTopic}\n\nDieser Kurs wurde aus einer PowerPoint-Präsentation importiert.\n\nDie Folien werden **1:1** als gerenderte Bilder angezeigt (Original-Layout und Grafiken).`;
    const teleprompter_script = `Willkommen zum Kurs über ${courseTopic}. Dieser Kurs wurde aus deiner PowerPoint-Präsentation erstellt. Lass uns durch die Folien gehen.`;

    await db.insert(lessons).values({
      moduleId: newMod.id,
      tenantId: user.tenantId,
      sequenceOrder: 1,
      title: 'Präsentationsinhalte',
      contentPayload: {
        text_content,
        teleprompter_script,
        slides: slidesPayload,
        source: 'pptx',
        quiz: [
          {
            question: `Worum geht es hauptsächlich im Kurs ${courseTopic}?`,
            options: [
              `Um das Thema ${courseTopic}.`,
              'Um ein anderes Thema.',
              'Um Webdesign.',
              'Um allgemeine BWL.',
            ],
            correct_option_index: 0,
            explanation: `Der Kurs behandelt das Thema ${courseTopic} basierend auf der importierten Präsentation.`,
          },
        ],
      },
    });

    console.log(`[PPTX IMPORT] Success! Course "${courseTopic}" with ${slidesPayload.length} 1:1 slide images.`);
    return res.json({
      success: true,
      courseId: newCourse.id,
      topic: courseTopic,
      slideCount: slidesPayload.length,
    });
  } catch (err: any) {
    console.error('[PPTX IMPORT ERROR]', err);
    return res.status(500).json({ error: `Fehler beim PowerPoint-Import: ${err.message}` });
  } finally {
    if (workDir) cleanupWorkDir(workDir);
  }
});

async function loadCourseLessons(courseId: string) {
  const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
  const moduleIds = courseModules.map((m) => m.id);
  if (moduleIds.length === 0) return { courseModules, allLessons: [] as typeof lessons.$inferSelect[] };
  const allLessons = await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds));
  return { courseModules, allLessons };
}

function resolveFallbackSlideImage(slide: any, courseTopic: string = ''): string {
  if (slide.hide_image === true || slide.layout === 'mermaid' || slide.layout === 'code') {
    return '';
  }
  const textToSearch = `${slide.title || ''} ${(slide.bullets || []).join(' ')} ${courseTopic || ''}`.toLowerCase();
  if (textToSearch.includes('docker') || textToSearch.includes('container') || textToSearch.includes('kubernetes') || textToSearch.includes('podman') || textToSearch.includes('devops')) {
    return (slide.title && slide.title.length % 2 === 0) ? '/images/container-intro.png' : '/images/docker-motivation.png';
  }
  if (textToSearch.includes('security') || textToSearch.includes('cyber') || textToSearch.includes('owasp') || textToSearch.includes('pentest') || textToSearch.includes('angriff') || textToSearch.includes('hack') || textToSearch.includes('passwort') || textToSearch.includes('auth')) {
    return '/images/cybersecurity.png';
  }
  if (textToSearch.includes('db') || textToSearch.includes('database') || textToSearch.includes('datenbank') || textToSearch.includes('postgres') || textToSearch.includes('sql') || textToSearch.includes('nosql') || textToSearch.includes('server') || textToSearch.includes('cloud')) {
    return '/images/database.png';
  }
  if (textToSearch.includes('llm') || textToSearch.includes('prompt') || textToSearch.includes('ki') || textToSearch.includes('ai')) {
    return '/images/llm-foundations.png';
  }
  return '/images/coding.png';
}

function flattenImageSlides(allLessons: any[], courseTopic: string = '') {
  type Flat = { lessonId: string; slideIndex: number; slide: any };
  const out: Flat[] = [];
  for (const lesson of allLessons) {
    const payload = (lesson.contentPayload || {}) as any;
    const lessonSlides = payload.slides || [];
    lessonSlides.forEach((slide: any, slideIndex: number) => {
      let effectiveImageUrl = slide.image_url || slide.imageUrl || '';
      const effectiveCues = Array.isArray(slide.image_cues) ? slide.image_cues : [];

      if (!effectiveImageUrl && effectiveCues.length > 0) {
        const firstWithUrl = effectiveCues.find((c: any) => c.image_url && String(c.image_url).trim());
        if (firstWithUrl) effectiveImageUrl = firstWithUrl.image_url;
      }

      if (!effectiveImageUrl && slide.layout !== 'image') {
        effectiveImageUrl = resolveFallbackSlideImage(slide, courseTopic);
      }

      const audioUrl = slide.audio_url || (lessonSlides.length === 1 ? lesson.videoUrl : '');

      if (slide.layout === 'image' || effectiveImageUrl || effectiveCues.length > 0) {
        out.push({
          lessonId: lesson.id,
          slideIndex,
          slide: {
            ...slide,
            image_url: effectiveImageUrl,
            image_cues: effectiveCues,
            audio_url: audioUrl,
          },
        });
      }
    });
  }
  return out;
}

async function narrateOneSlide(opts: {
  courseTopic: string;
  tenantId: string;
  slide: any;
  slideIndex: number;
  totalSlides: number;
}): Promise<{ speaker_notes: string; summary?: string }> {
  let imageBase64: string | undefined;
  const imageUrl = opts.slide.image_url || opts.slide.imageUrl;
  if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('/')) {
    const publicDir = path.resolve(process.cwd(), 'public');
    const normalizedRel = path.normalize(imageUrl).replace(/^[\\\/]+/, '');
    const abs = path.resolve(publicDir, normalizedRel);
    if (abs.startsWith(publicDir + path.sep) && fs.existsSync(abs)) {
      imageBase64 = fs.readFileSync(abs).toString('base64');
    }
  }

  const aiRes = await fetch(`${AI_SERVICE_URL}/generate-slide-narration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      course_topic: opts.courseTopic,
      slide_title: opts.slide.title || '',
      slide_bullets: opts.slide.bullets || [],
      slide_index: opts.slideIndex,
      total_slides: opts.totalSlides,
      image_base64: imageBase64,
      image_mime: 'image/png',
      tenant_id: opts.tenantId,
    }),
  });

  if (!aiRes.ok) {
    throw new Error(`AI Service ${aiRes.status}: ${await aiRes.text()}`);
  }
  return aiRes.json() as Promise<{ speaker_notes: string; summary?: string }>;
}

function rebuildTeleprompter(payload: any) {
  const notes = (payload.slides || [])
    .map((s: any) => (s.speaker_notes || '').trim())
    .filter(Boolean);
  if (notes.length > 0) {
    payload.teleprompter_script = notes.join('\n\n');
  }
  return payload;
}

/**
 * Generate Vision-based speaker scripts for all image slides in a course.
 * Runs in background; progress is written to courses.progress.
 */
app.post('/api/courses/:id/generate-narrations', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const courseId = req.params.id;

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const { allLessons } = await loadCourseLessons(courseId);
    if (allLessons.length === 0) {
      return res.status(400).json({ error: 'Keine Lektionen im Kurs' });
    }

    const flat = flattenImageSlides(allLessons);
    if (flat.length === 0) {
      return res.status(400).json({
        error: 'Keine Folien mit Bildern gefunden. Sprechtext-Generierung ist für PowerPoint-Imports (layout:image) gedacht.',
      });
    }

    const onlyMissing = !!req.body?.onlyMissing;
    const jobs = onlyMissing
      ? flat.filter((j) => !(j.slide.speaker_notes && String(j.slide.speaker_notes).trim()))
      : flat;

    if (jobs.length === 0) {
      return res.json({ success: true, message: 'Alle Sprechtexte sind bereits vorhanden', total: 0 });
    }

    await db.update(courses).set({
      status: 'generating',
      progress: {
        percent: 45,
        step: `Generiere Sprechtexte (0/${jobs.length})…`,
        source: (course.progress as any)?.source || 'pptx',
      },
    }).where(eq(courses.id, courseId));

    res.json({ success: true, message: 'Sprechtext-Generierung gestartet', total: jobs.length });

    (async () => {
      try {
        const lessonPayloads = new Map<string, any>();
        for (const lesson of allLessons) {
          lessonPayloads.set(lesson.id, JSON.parse(JSON.stringify(lesson.contentPayload || {})));
        }

        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i];
          const pct = Math.round(45 + ((i + 1) / jobs.length) * 35);
          await db.update(courses).set({
            progress: {
              percent: pct,
              step: `Sprechtext Folie ${i + 1}/${jobs.length}: „${job.slide.title || 'Folie'}“…`,
              source: (course.progress as any)?.source || 'pptx',
            },
          }).where(eq(courses.id, courseId));

          const narration = await narrateOneSlide({
            courseTopic: course.topic,
            tenantId: user.tenantId,
            slide: job.slide,
            slideIndex: job.slideIndex,
            totalSlides: (lessonPayloads.get(job.lessonId)?.slides || []).length || flat.length,
          });

          const payload = lessonPayloads.get(job.lessonId);
          if (payload?.slides?.[job.slideIndex]) {
            payload.slides[job.slideIndex].speaker_notes = narration.speaker_notes;
            if (narration.summary) {
              payload.slides[job.slideIndex].summary = narration.summary;
            }
          }
        }

        for (const lesson of allLessons) {
          const payload = lessonPayloads.get(lesson.id);
          if (!payload) continue;
          rebuildTeleprompter(payload);
          if (!payload.text_content || String(payload.text_content).includes('1:1')) {
            const lines = (payload.slides || []).map((s: any, idx: number) => {
              const sum = s.summary || s.speaker_notes?.slice(0, 120) || '';
              return `## Folie ${idx + 1}: ${s.title || ''}\n\n${sum}`;
            });
            payload.text_content = `# ${course.topic}\n\n${lines.join('\n\n')}`;
          }
          await db.update(lessons).set({ contentPayload: payload }).where(eq(lessons.id, lesson.id));
        }

        const pipeline = computeSlidePipelineStatus(
          allLessons.map((l) => ({
            contentPayload: lessonPayloads.get(l.id) || l.contentPayload,
            videoUrl: l.videoUrl,
          }))
        );

        await db.update(courses).set({
          status: 'content_draft',
          progress: {
            percent: pipeline.audioReady ? 100 : 80,
            step: pipeline.narrationsReady
              ? 'Sprechtexte fertig – bereit für Vertonung'
              : 'Sprechtexte teilweise generiert',
            source: (course.progress as any)?.source || 'pptx',
            pipeline,
          },
        }).where(eq(courses.id, courseId));

        console.log(`[NARRATION] Course ${courseId}: ${jobs.length} slide scripts generated.`);
      } catch (bgErr: any) {
        console.error('[NARRATION] Background failed:', bgErr);
        await db.update(courses).set({
          status: 'failed',
          progress: {
            percent: 100,
            step: `Sprechtext-Fehler: ${bgErr.message}`,
            source: (course.progress as any)?.source || 'pptx',
          },
        }).where(eq(courses.id, courseId));
      }
    })();
  } catch (err: any) {
    console.error('[NARRATION]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Flat slide list + pipeline status for PPTX studio wizard */
app.get('/api/courses/:id/pptx-studio', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const courseId = req.params.id;
  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const { allLessons } = await loadCourseLessons(courseId);
    const pipeline = computeSlidePipelineStatus(allLessons);
    const slides = flattenImageSlides(allLessons).map((f, globalIndex) => ({
      globalIndex,
      lessonId: f.lessonId,
      slideIndex: f.slideIndex,
      title: f.slide.title || `Folie ${globalIndex + 1}`,
      image_url: f.slide.image_url || '',
      bullets: f.slide.bullets || [],
      speaker_notes: f.slide.speaker_notes || '',
      summary: f.slide.summary || '',
      audio_url: f.slide.audio_url || '',
      hasNotes: !!(f.slide.speaker_notes && String(f.slide.speaker_notes).trim()),
      hasAudio: !!(f.slide.audio_url && String(f.slide.audio_url).trim()),
    }));

    res.json({
      course: { id: course.id, topic: course.topic, status: course.status, progress: course.progress },
      pipeline,
      slides,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Save speaker notes / title for one slide */
app.put('/api/courses/:id/slides/:lessonId/:slideIndex', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { id: courseId, lessonId, slideIndex: slideIndexStr } = req.params;
  const slideIndex = parseInt(slideIndexStr, 10);
  const { speaker_notes, title } = req.body || {};

  try {
    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    const payload = JSON.parse(JSON.stringify(lesson.contentPayload || {}));
    if (!payload.slides?.[slideIndex]) {
      return res.status(404).json({ error: 'Slide not found' });
    }
    if (typeof speaker_notes === 'string') {
      payload.slides[slideIndex].speaker_notes = speaker_notes;
    }
    if (typeof title === 'string' && title.trim()) {
      payload.slides[slideIndex].title = title.trim();
    }
    rebuildTeleprompter(payload);
    await db.update(lessons).set({ contentPayload: payload }).where(eq(lessons.id, lessonId));

    const { allLessons } = await loadCourseLessons(courseId);
    const pipeline = computeSlidePipelineStatus(
      allLessons.map((l) => (l.id === lessonId ? { ...l, contentPayload: payload } : l))
    );
    await db.update(courses).set({
      progress: {
        ...((await db.select().from(courses).where(eq(courses.id, courseId)).limit(1))[0]?.progress as any || {}),
        source: 'pptx',
        pipeline,
        step: 'Folie gespeichert',
      },
    }).where(eq(courses.id, courseId));

    res.json({ success: true, slide: payload.slides[slideIndex], pipeline });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Generate narration for a single slide (sync) */
app.post('/api/courses/:id/slides/:lessonId/:slideIndex/narrate', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { id: courseId, lessonId, slideIndex: slideIndexStr } = req.params;
  const slideIndex = parseInt(slideIndexStr, 10);

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    const payload = JSON.parse(JSON.stringify(lesson.contentPayload || {}));
    const slide = payload.slides?.[slideIndex];
    if (!slide) return res.status(404).json({ error: 'Slide not found' });

    const narration = await narrateOneSlide({
      courseTopic: course.topic,
      tenantId: user.tenantId,
      slide,
      slideIndex,
      totalSlides: payload.slides.length,
    });

    payload.slides[slideIndex].speaker_notes = narration.speaker_notes;
    if (narration.summary) payload.slides[slideIndex].summary = narration.summary;
    rebuildTeleprompter(payload);
    await db.update(lessons).set({ contentPayload: payload }).where(eq(lessons.id, lessonId));

    const { allLessons } = await loadCourseLessons(courseId);
    const pipeline = computeSlidePipelineStatus(
      allLessons.map((l) => (l.id === lessonId ? { ...l, contentPayload: payload } : l))
    );

    res.json({ success: true, speaker_notes: narration.speaker_notes, summary: narration.summary, pipeline });
  } catch (err: any) {
    console.error('[NARRATE ONE]', err);
    res.status(500).json({ error: err.message });
  }
});

/** TTS for a single slide */
app.post('/api/courses/:id/slides/:lessonId/:slideIndex/tts', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { id: courseId, lessonId, slideIndex: slideIndexStr } = req.params;
  const slideIndex = parseInt(slideIndexStr, 10);

  if (!courseId || !/^[a-zA-Z0-9_-]+$/.test(courseId)) {
    return res.status(400).json({ error: 'Invalid course ID format' });
  }

  try {
    const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

    const payload = JSON.parse(JSON.stringify(lesson.contentPayload || {}));
    const slide = payload.slides?.[slideIndex];
    if (!slide) return res.status(404).json({ error: 'Slide not found' });

    const text = (slide.speaker_notes || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Kein Sprechtext für diese Folie. Bitte zuerst Text generieren oder eingeben.' });
    }

    const rel = `audio/${courseId}/slide-${String(slideIndex).padStart(3, '0')}-${Date.now()}.mp3`;
    const audioUrl = await synthesizeSpeechToFile({ text, outRelativePath: rel });
    payload.slides[slideIndex].audio_url = audioUrl;
    await db.update(lessons).set({ contentPayload: payload }).where(eq(lessons.id, lessonId));

    // Also set lesson videoUrl to first available slide audio if missing (classroom fallback)
    if (!lesson.videoUrl) {
      await db.update(lessons).set({ videoUrl: audioUrl }).where(eq(lessons.id, lessonId));
    }

    const { allLessons } = await loadCourseLessons(courseId);
    const pipeline = computeSlidePipelineStatus(
      allLessons.map((l) => (l.id === lessonId ? { ...l, contentPayload: payload, videoUrl: lesson.videoUrl || audioUrl } : l))
    );

    await db.update(courses).set({
      progress: {
        percent: pipeline.audioReady ? 95 : 85,
        step: pipeline.audioReady ? 'Alle Folien vertont' : `Vertonung ${pipeline.audioDone}/${pipeline.slideCount}`,
        source: 'pptx',
        pipeline,
      },
    }).where(eq(courses.id, courseId));

    res.json({ success: true, audio_url: audioUrl, pipeline });
  } catch (err: any) {
    console.error('[TTS ONE]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Batch TTS for all slides that have speaker_notes */
app.post('/api/courses/:id/generate-tts', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const courseId = req.params.id;
  const onlyMissing = !!req.body?.onlyMissing;

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const { allLessons } = await loadCourseLessons(courseId);
    const flat = flattenImageSlides(allLessons).filter((j) => {
      const hasNotes = !!(j.slide.speaker_notes && String(j.slide.speaker_notes).trim());
      const hasAudio = !!(j.slide.audio_url && String(j.slide.audio_url).trim());
      if (!hasNotes) return false;
      if (onlyMissing && hasAudio) return false;
      return true;
    });

    if (flat.length === 0) {
      return res.status(400).json({
        error: 'Keine Folien zum Vertonen. Bitte zuerst Sprechtexte anlegen.',
      });
    }

    await db.update(courses).set({
      status: 'generating',
      progress: {
        percent: 82,
        step: `Vertone Folien (0/${flat.length})…`,
        source: 'pptx',
      },
    }).where(eq(courses.id, courseId));

    res.json({ success: true, message: 'Vertonung gestartet', total: flat.length });

    (async () => {
      try {
        const lessonPayloads = new Map<string, any>();
        for (const lesson of allLessons) {
          lessonPayloads.set(lesson.id, JSON.parse(JSON.stringify(lesson.contentPayload || {})));
        }

        for (let i = 0; i < flat.length; i++) {
          const job = flat[i];
          await db.update(courses).set({
            progress: {
              percent: Math.round(82 + ((i + 1) / flat.length) * 15),
              step: `Vertone Folie ${i + 1}/${flat.length}…`,
              source: 'pptx',
            },
          }).where(eq(courses.id, courseId));

          const payload = lessonPayloads.get(job.lessonId);
          const text = (payload.slides[job.slideIndex].speaker_notes || '').trim();
          const rel = `audio/${courseId}/slide-${String(job.slideIndex).padStart(3, '0')}-${Date.now()}.mp3`;
          const audioUrl = await synthesizeSpeechToFile({ text, outRelativePath: rel });
          payload.slides[job.slideIndex].audio_url = audioUrl;
        }

        for (const lesson of allLessons) {
          const payload = lessonPayloads.get(lesson.id);
          if (!payload) continue;
          const firstAudio = (payload.slides || []).find((s: any) => s.audio_url)?.audio_url;
          await db.update(lessons)
            .set({
              contentPayload: payload,
              ...(firstAudio && !lesson.videoUrl ? { videoUrl: firstAudio } : {}),
            })
            .where(eq(lessons.id, lesson.id));
        }

        const pipeline = computeSlidePipelineStatus(
          allLessons.map((l) => ({
            contentPayload: lessonPayloads.get(l.id) || l.contentPayload,
            videoUrl: l.videoUrl,
          }))
        );

        await db.update(courses).set({
          status: pipeline.audioReady ? 'pending_approval' : 'content_draft',
          progress: {
            percent: pipeline.audioReady ? 100 : 90,
            step: pipeline.audioReady ? 'Folien, Texte und Vertonung fertig – Freigabe möglich' : 'Vertonung teilweise fertig',
            source: 'pptx',
            pipeline,
          },
        }).where(eq(courses.id, courseId));

        console.log(`[TTS BATCH] Course ${courseId}: ${flat.length} slides voiced.`);
      } catch (bgErr: any) {
        console.error('[TTS BATCH] failed:', bgErr);
        await db.update(courses).set({
          status: 'failed',
          progress: {
            percent: 100,
            step: `Vertonungs-Fehler: ${bgErr.message}`,
            source: 'pptx',
          },
        }).where(eq(courses.id, courseId));
      }
    })();
  } catch (err: any) {
    console.error('[TTS BATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Export course slides + per-slide audio as one MP4 (ffmpeg).
 * Runs in background; poll GET .../export-mp4/status or progress.export.
 */
app.post('/api/courses/:id/export-mp4', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const courseId = req.params.id;

  if (exportJobs.has(courseId)) {
    return res.status(409).json({ error: 'Export läuft bereits für diesen Kurs' });
  }

  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const { allLessons } = await loadCourseLessons(courseId);
    const flat = flattenImageSlides(allLessons, course.topic);
    if (flat.length === 0) {
      return res.status(400).json({ error: 'Keine Folienbilder zum Exportieren gefunden' });
    }

    const withAudio = flat.filter((s) => s.slide.audio_url && String(s.slide.audio_url).trim());
    if (withAudio.length === 0) {
      return res.status(400).json({
        error: 'Keine Vertonung vorhanden. Bitte zuerst Folien vertonen, dann exportieren.',
      });
    }

    const prevProgress = (course.progress || {}) as any;
    const exportState: ExportProgress = {
      status: 'running',
      percent: 0,
      step: 'Export gestartet…',
      updatedAt: new Date().toISOString(),
    };

    await db.update(courses).set({
      progress: {
        ...prevProgress,
        export: exportState,
        step: `MP4-Export (0/${flat.length})…`,
      },
    }).where(eq(courses.id, courseId));

    exportJobs.add(courseId);
    res.json({ success: true, message: 'MP4-Export gestartet', total: flat.length });

    (async () => {
      try {
        const downloadUrl = await exportCourseToMp4({
          courseId,
          topic: course.topic,
          slides: flat.map((f, i) => ({
            index: i,
            layout: f.slide.layout || 'bullets',
            title: f.slide.title,
            bullets: f.slide.bullets,
            codeSnippet: f.slide.code_snippet,
            codeLanguage: f.slide.code_language,
            mermaidCode: f.slide.mermaid_code,
            imageUrl: f.slide.image_url,
            imageCues: f.slide.image_cues,
            audioUrl: f.slide.audio_url,
          })),
          onProgress: async (percent, step) => {
            const [fresh] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
            const prog = ((fresh?.progress || prevProgress) as any) || {};
            await db.update(courses).set({
              progress: {
                ...prog,
                step: `MP4-Export: ${step}`,
                export: {
                  status: 'running',
                  percent,
                  step,
                  updatedAt: new Date().toISOString(),
                },
              },
            }).where(eq(courses.id, courseId));
          },
        });

        const [fresh] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
        const prog = ((fresh?.progress || {}) as any) || {};
        await db.update(courses).set({
          progress: {
            ...prog,
            step: 'MP4-Export fertig',
            export: {
              status: 'ready',
              percent: 100,
              step: 'MP4-Export fertig',
              downloadUrl,
              updatedAt: new Date().toISOString(),
            },
          },
        }).where(eq(courses.id, courseId));

        console.log(`[EXPORT MP4] Course ${courseId} -> ${downloadUrl}`);
      } catch (bgErr: any) {
        console.error('[EXPORT MP4] failed:', bgErr);
        const [fresh] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
        const prog = ((fresh?.progress || {}) as any) || {};
        await db.update(courses).set({
          progress: {
            ...prog,
            step: `MP4-Export fehlgeschlagen: ${bgErr.message}`,
            export: {
              status: 'failed',
              percent: 0,
              step: bgErr.message,
              error: bgErr.message,
              updatedAt: new Date().toISOString(),
            },
          },
        }).where(eq(courses.id, courseId));
      } finally {
        exportJobs.delete(courseId);
      }
    })();
  } catch (err: any) {
    exportJobs.delete(courseId);
    console.error('[EXPORT MP4]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/courses/:id/export-mp4/status', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, req.params.id)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const exportInfo = ((course.progress as any)?.export || {
      status: 'idle',
      percent: 0,
      step: 'Kein Export',
    }) as ExportProgress;
    res.json({
      ...exportInfo,
      running: exportJobs.has(req.params.id),
      topic: course.topic,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// OPTION C: Pure Didactic Concept Generation (Staged GLM-5.3 + PDF)
app.post('/api/courses/generate-concept', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  const { topic, duration, customPrompt } = req.body;
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: 'Thema darf nicht leer sein' });
  }

  let courseId: string | null = null;
  try {
    // 1. Create course entry with status concept_generating
    const [newCourse] = await db.insert(courses).values({
      tenantId: user.tenantId,
      topic: topic.trim(),
      status: 'concept_generating',
      progress: {
        mode: 'concept',
        duration: duration || '2_weeks',
        percent: 15,
        step: 'Didaktisches Rahmenkonzept wird stufenweise generiert...',
      },
    }).returning();
    courseId = newCourse.id;

    // 2. Call AI Service /generate-concept
    const payload = {
      topic: topic.trim(),
      duration: duration || '2_weeks',
      tenant_id: user.tenantId,
      custom_prompt: customPrompt || undefined,
      course_id: courseId,
    };

    let response: Response;
    try {
      response = await fetch(`${AI_SERVICE_URL}/generate-concept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000), // 5 minutes max for multi-week staged generation
      });
    } catch (fetchErr: any) {
      const timedOut = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError';
      throw new Error(
        timedOut
          ? `AI-Service Timeout nach 300s unter ${AI_SERVICE_URL}. Bitte erneut versuchen.`
          : `AI-Service nicht erreichbar unter ${AI_SERVICE_URL} (${fetchErr?.message || 'fetch failed'}).`
      );
    }

    if (!response.ok) {
      throw new Error(`AI Service returned status ${response.status}: ${await response.text()}`);
    }

    const concept = (await response.json()) as any;
    if (!concept?.modules || !Array.isArray(concept.modules) || concept.modules.length === 0) {
      throw new Error('AI-Service lieferte kein gültiges Konzept (modules leer).');
    }

    // 3. Persist modules and lessons atomically
    await db.transaction(async (tx) => {
      await tx.delete(modules).where(eq(modules.courseId, courseId!));

      for (let i = 0; i < concept.modules.length; i++) {
        const modData = concept.modules[i];
        const [newModule] = await tx.insert(modules).values({
          courseId: courseId!,
          sequenceOrder: modData.week_number || (i + 1),
          title: modData.title,
        }).returning();

        if (Array.isArray(modData.lessons)) {
          for (const [lesIdx, lesData] of modData.lessons.entries()) {
            await tx.insert(lessons).values({
              moduleId: newModule.id,
              tenantId: user.tenantId,
              sequenceOrder: lesIdx + 1,
              title: lesData.title,
              contentPayload: {
                description: lesData.description,
                learning_objectives: lesData.learning_objectives || [],
                target_ue: lesData.target_ue || 8,
                methodology: lesData.methodology || 'Praxis-Lab',
                practical_exercise: lesData.practical_exercise || '',
                slides: [],
                text_content: '',
                teleprompter_script: '',
                quiz: [],
              },
            });
          }
        }
      }

      await tx.update(courses)
        .set({
          status: 'concept_ready',
          topic: concept.course_title || topic,
          progress: {
            mode: 'concept',
            percent: 100,
            step: 'Didaktisches Rahmenkonzept & PDF erfolgreich erstellt',
            duration: duration || '2_weeks',
            pdfUrl: concept.pdf_url || `/course_output/${courseId}/didaktisches_konzept.pdf`,
            total_ue: concept.total_ue,
            duration_desc: concept.duration_desc,
            executive_summary: concept.executive_summary,
            target_audience: concept.target_audience,
            prerequisites: concept.prerequisites,
            didactic_approach: concept.didactic_approach,
          },
        })
        .where(eq(courses.id, courseId!));
    });

    res.json({
      success: true,
      courseId,
      pdfUrl: concept.pdf_url || `/course_output/${courseId}/didaktisches_konzept.pdf`,
      concept,
    });
  } catch (err: any) {
    console.error('[generate-concept] Error:', err);
    if (courseId) {
      try {
        await db.update(courses)
          .set({
            status: 'failed',
            progress: {
              mode: 'concept',
              percent: 0,
              step: `Konzept-Generierung fehlgeschlagen: ${err.message}`,
              error: err.message,
            },
          })
          .where(eq(courses.id, courseId));
      } catch (updateErr: any) {
        console.error('[generate-concept] Could not persist failure status:', updateErr?.message);
      }
    }
    res.status(500).json({ error: err.message });
  }
});

// GET Didactic Concept details for a course
app.get('/api/courses/:id/concept', authenticateToken, async (req, res) => {
  try {
    const [course] = await db.select().from(courses).where(eq(courses.id, req.params.id)).limit(1);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const courseModules = await db.select().from(modules).where(eq(modules.courseId, course.id)).orderBy(asc(modules.sequenceOrder));
    const fullModules = [];

    for (const mod of courseModules) {
      const modLessons = await db.select().from(lessons).where(eq(lessons.moduleId, mod.id)).orderBy(asc(lessons.sequenceOrder));
      fullModules.push({
        ...mod,
        lessons: modLessons.map(l => ({
          id: l.id,
          sequenceOrder: l.sequenceOrder,
          title: l.title,
          ...(typeof l.contentPayload === 'object' && l.contentPayload !== null ? l.contentPayload : {}),
        })),
      });
    }

    const progress = (course.progress || {}) as any;
    res.json({
      courseId: course.id,
      topic: course.topic,
      status: course.status,
      pdfUrl: progress.pdfUrl || `/course_output/${course.id}/didaktisches_konzept.pdf`,
      progress,
      modules: fullModules,
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
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    const targetTenantId = course ? course.tenantId : user.tenantId;

    // 1. Call Python AI Service
    const payload = {
      topic,
      tenant_id: targetTenantId,
      duration: duration || '2_weeks',
      custom_prompt: customPrompt || undefined
    };

    let response: Response;
    try {
      response = await fetch(`${AI_SERVICE_URL}/generate-curriculum`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // LLM curriculum can take up to a few minutes for complex requests
        signal: AbortSignal.timeout(300_000),
      });
    } catch (fetchErr: any) {
      const timedOut = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError';
      throw new Error(
        timedOut
          ? `AI-Service Timeout nach 300s unter ${AI_SERVICE_URL}. Bitte LLM-Key/Netz prüfen oder erneut versuchen.`
          : `AI-Service nicht erreichbar unter ${AI_SERVICE_URL} (${fetchErr?.message || 'fetch failed'}). Bitte python src/ai_service/main.py starten.`
      );
    }

    if (!response.ok) {
      throw new Error(`AI Service returned status ${response.status}: ${await response.text()}`);
    }

    const curriculum = (await response.json()) as any;
    if (!curriculum?.modules || !Array.isArray(curriculum.modules) || curriculum.modules.length === 0) {
      throw new Error('AI-Service lieferte keinen gültigen Lehrplan (modules leer). Bitte erneut generieren.');
    }

    // Save modules and lessons in database atomically (Befund 27)
    await db.transaction(async (tx) => {
      // Delete existing modules/lessons if regenerating inside transaction
      await tx.delete(modules).where(eq(modules.courseId, courseId));

      for (let i = 0; i < curriculum.modules.length; i++) {
        const modData = curriculum.modules[i];
        const [newModule] = await tx.insert(modules).values({
          courseId,
          sequenceOrder: i + 1,
          title: modData.title,
        }).returning();

        for (const [lesIdx, lesData] of modData.lessons.entries()) {
          await tx.insert(lessons).values({
            moduleId: newModule.id,
            tenantId: targetTenantId,
            sequenceOrder: lesIdx + 1,
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
        .set({
          status: 'curriculum_draft',
          topic: curriculum.course_title || topic,
          progress: {
            duration: duration || '2_weeks',
            percent: 25,
            step: 'curriculum_draft',
          },
        })
        .where(eq(courses.id, courseId));
    });

    res.json({ success: true, message: 'Curriculum & slides generated successfully.' });
  } catch (err: any) {
    console.error('[wizard/step1-curriculum] Error:', err);
    // Persist failure so the admin dashboard does not show an empty "successful" draft
    try {
      if (courseId) {
        await db.update(courses)
          .set({
            status: 'failed',
            progress: {
              percent: 0,
              step: `Lehrplan-Generierung fehlgeschlagen: ${err.message}`,
              error: err.message,
              duration: duration || '2_weeks',
            },
          })
          .where(eq(courses.id, courseId));
      }
    } catch (updateErr: any) {
      console.error('[wizard/step1-curriculum] Could not persist failure status:', updateErr?.message);
    }
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

    const allLessons = await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds));

    // Update course status to generating content
    await db.update(courses).set({ status: 'generating', progress: { percent: 25, step: 'Generiere Lektionsinhalte...' } }).where(eq(courses.id, courseId));

    // Run generation in the background asynchronously so the client doesn't time out
    (async () => {
      try {
        const total = allLessons.length;
        const targetTenantId = course.tenantId || user.tenantId;

        for (let i = 0; i < total; i++) {
          // Check if generation was cancelled / stopped (Befund 20)
          const [currentCourse] = await db.select({ status: courses.status }).from(courses).where(eq(courses.id, courseId)).limit(1);
          if (currentCourse?.status === 'failed') {
            console.log(`[generate-content] Course generation for ${courseId} was cancelled by user. Aborting loop.`);
            return;
          }

          const lesson = allLessons[i];
          const moduleOfLesson = courseModules.find((m) => m.id === lesson.moduleId);
          const moduleTitle = moduleOfLesson ? moduleOfLesson.title : 'Modul';

          const percent = Math.round(25 + (i / total) * 50);
          await db.update(courses).set({ progress: { percent, step: `Generiere Lektion ${i + 1} von ${total}: "${lesson.title}"...` } }).where(eq(courses.id, courseId));

          const payload = {
            course_topic: course.topic,
            module_title: moduleTitle,
            lesson_title: lesson.title,
            tenant_id: targetTenantId,
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

          const content = (await response.json()) as any;
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

          // Generate embeddings under course.tenantId (Befund 28)
          const embResponse = (await fetch(`${AI_SERVICE_URL}/generate-embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: content.text_content, tenant_id: targetTenantId }),
          }).then((r) => r.json())) as any;

          // Save vector
          await withTenant(targetTenantId, async (tx) => {
            await tx.delete(embeddings).where(eq(embeddings.lessonId, lesson.id));
            await tx.insert(embeddings).values({
              lessonId: lesson.id,
              tenantId: targetTenantId,
              embedding: embResponse.embedding,
            });
          });
        }

        // Only set status to content_draft if not cancelled during generation (Befund 20)
        const [finalCourse] = await db.select({ status: courses.status }).from(courses).where(eq(courses.id, courseId)).limit(1);
        if (finalCourse?.status !== 'failed') {
          await db.update(courses).set({ status: 'content_draft', progress: { percent: 80, step: 'Lektionsinhalte generiert.' } }).where(eq(courses.id, courseId));
        }
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

    // Verify that all lessons have valid teleprompter scripts
    const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
    const moduleIds = courseModules.map((m) => m.id);
    const courseLessons = moduleIds.length > 0 ? await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds)) : [];
    
    const missingScripts = courseLessons.filter(l => {
      const payload = (l.contentPayload || {}) as any;
      const script = (payload.teleprompter_script || '').trim();
      const slideNotes = (payload.slides || []).map((s: any) => (s.speaker_notes || '').trim()).filter(Boolean);
      return script.length < 15 && slideNotes.length === 0;
    });

    if (missingScripts.length > 0) {
      const names = missingScripts.slice(0, 3).map(l => `"${l.title}"`).join(', ');
      const extra = missingScripts.length > 3 ? ` und ${missingScripts.length - 3} weitere` : '';
      return res.status(400).json({
        error: `Fehlende Sprechskripte: Für ${missingScripts.length} Lektion(en) (${names}${extra}) wurde noch kein Teleprompter-Sprechskript hinterlegt. Bitte zuerst in Schritt 2 die Lektionsinhalte generieren oder manuell erfassen.`
      });
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
      // Students only see released courses for their tenant
      list = await db.select().from(courses)
        .where(and(eq(courses.tenantId, user.tenantId), eq(courses.status, 'active')))
        .orderBy(desc(courses.createdAt));
    }

    // Enrich with Folien / Sprechtext / Vertonung readiness (admin dashboard checkmarks)
    if (user.role === 'admin' && list.length > 0) {
      const enriched = await Promise.all(list.map(async (course) => {
        const isPptx = (course.progress as any)?.source === 'pptx';
        try {
          const { allLessons } = await loadCourseLessons(course.id);
          const pipeline = computeSlidePipelineStatus(allLessons);
          return { ...course, pipeline, isPptx };
        } catch {
          return { ...course, pipeline: null, isPptx };
        }
      }));
      return res.json(enriched);
    }

    res.json(list.map((c) => ({ ...c, isPptx: (c.progress as any)?.source === 'pptx', pipeline: null })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Removes quiz answer keys and coding solutions from a lesson payload for students.
function stripQuizAnswersForStudent(lesson: any) {
  const payload = lesson?.contentPayload;
  if (!payload) {
    return lesson;
  }

  const nextPayload: any = { ...payload };

  if (Array.isArray(payload.quiz) && payload.quiz.length > 0) {
    nextPayload.quiz = payload.quiz.map((q: any) => ({
      question: q?.question,
      options: Array.isArray(q?.options) ? [...q.options] : q?.options,
    }));
  }

  // Keep starter code + criteria; hide Musterlösung until (optional) reveal is added server-side.
  if (payload.exercise && typeof payload.exercise === 'object') {
    const { solution, ...rest } = payload.exercise;
    nextPayload.exercise = {
      ...rest,
      solution: undefined,
      has_solution: !!(solution && Object.keys(solution || {}).length > 0),
    };
  }

  return {
    ...lesson,
    contentPayload: nextPayload,
  };
}

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

    // Students may only open released courses
    if (user.role !== 'admin' && course.status !== 'active') {
      return res.status(403).json({ error: 'Kurs ist noch nicht freigegeben' });
    }

    const courseModules = await db.select().from(modules)
      .where(eq(modules.courseId, id))
      .orderBy(asc(modules.sequenceOrder));

    const moduleIds = courseModules.map((m) => m.id);

    let courseLessons: any[] = [];
    if (moduleIds.length > 0) {
      // Deterministic order: module sequence first, then lesson sequence.
      // createdAt alone is ambiguous because lessons inserted inside one
      // transaction share the same timestamp.
      const rows = await db.select({ lesson: lessons })
        .from(lessons)
        .innerJoin(modules, eq(lessons.moduleId, modules.id))
        .where(inList(lessons.moduleId, moduleIds))
        .orderBy(asc(modules.sequenceOrder), asc(lessons.sequenceOrder), asc(lessons.createdAt), asc(lessons.id));
      courseLessons = rows.map((r) => r.lesson);
    }

    // Students must not receive quiz solutions upfront: strip answer keys and
    // explanations. Scoring happens server-side via /quiz-submit.
    if (user.role !== 'admin') {
      courseLessons = courseLessons.map(stripQuizAnswersForStudent);
    }

    res.json({ course, modules: courseModules, lessons: courseLessons });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4b. Server-Side Quiz Scoring (students never receive the answer key upfront)
app.post('/api/courses/:id/lessons/:lessonId/quiz-submit', authenticateToken, async (req, res) => {
  const user = req.user!;
  const { id: courseId, lessonId } = req.params;
  const { questionIndex, selectedIndex } = req.body ?? {};

  if (!Number.isInteger(questionIndex) || questionIndex < 0 ||
      !Number.isInteger(selectedIndex) || selectedIndex < 0) {
    return res.status(400).json({ error: 'questionIndex and selectedIndex (non-negative integers) are required' });
  }

  try {
    let courseWhere: any = eq(courses.id, courseId);
    if (user.role !== 'admin') {
      courseWhere = and(eq(courses.id, courseId), eq(courses.tenantId, user.tenantId));
    }
    const [course] = await db.select().from(courses).where(courseWhere).limit(1);
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }
    if (user.role !== 'admin' && course.status !== 'active') {
      return res.status(403).json({ error: 'Kurs ist noch nicht freigegeben' });
    }

    // Verify the lesson actually belongs to this course
    const [lesson] = (await db.select({ lesson: lessons })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(and(eq(lessons.id, lessonId), eq(modules.courseId, courseId)))
      .limit(1)).map((r: any) => r.lesson);
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const quiz = lesson.contentPayload?.quiz;
    if (!Array.isArray(quiz) || questionIndex >= quiz.length) {
      return res.status(404).json({ error: 'Quiz question not found' });
    }

    const q = quiz[questionIndex];
    const correctIndex = typeof q.correct_option_index === 'number' ? q.correct_option_index : -1;
    res.json({
      isCorrect: selectedIndex === correctIndex,
      correctIndex,
      explanation: q.explanation || '',
    });
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

  // Verify HMAC-SHA256 signature over the raw request bytes (what a provider
  // actually signs). Falls back to re-serialization only if raw body is absent.
  const rawBody: Buffer | undefined = (req as any).rawBody;
  const bodyString: string = rawBody ? rawBody.toString('utf-8') : JSON.stringify(req.body);
  const computedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(bodyString)
    .digest('hex');

  const sigBuffer = Buffer.from(String(signature));
  const compBuffer = Buffer.from(computedSignature);
  if (sigBuffer.length !== compBuffer.length || !crypto.timingSafeEqual(sigBuffer, compBuffer)) {
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

  if (!sessionId || durationSec === undefined || typeof durationSec !== 'number' || durationSec <= 0) {
    return res.status(400).json({ error: 'Valid sessionId and positive numeric durationSec are required' });
  }

  try {
    const log = await recordHeartbeat(user.id, sessionId, durationSec);
    res.json({
      message: 'Heartbeat recorded securely.',
      cryptoHash: log.cryptoHash,
      previousHash: log.previousHash,
      timestamp: log.timestamp.toISOString(),
      durationSec: log.durationSec, // the value actually stored (delta-clamped)
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

// 8b. List recent tracking sessions (Admin only, feeds the verification UI)
app.get('/api/time-tracking/sessions', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }
  try {
    const rows = await db
      .select({
        sessionId: activityLogs.sessionId,
        userId: activityLogs.userId,
        blocks: sql<number>`count(*)::int`,
        totalDurationSec: sql<number>`coalesce(sum(${activityLogs.durationSec}), 0)::int`,
        lastAt: sql<string>`max(${activityLogs.timestamp})`,
      })
      .from(activityLogs)
      .groupBy(activityLogs.sessionId, activityLogs.userId)
      .orderBy(desc(sql`max(${activityLogs.timestamp})`))
      .limit(50);
    res.json(rows);
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
    // Check course existence and permissions before querying RAG (Befund 29)
    const [targetCourse] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!targetCourse) {
      return res.status(404).json({ error: 'Course not found' });
    }
    if (user.role !== 'admin' && (targetCourse.tenantId !== user.tenantId || targetCourse.status !== 'active')) {
      return res.status(403).json({ error: 'Kurs ist nicht freigegeben oder kein Zugriff' });
    }

    // A. Generate embedding vector for the question using AI Service
    const embData = (await fetch(`${AI_SERVICE_URL}/generate-embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: query, tenant_id: user.tenantId }),
    }).then((r) => r.json())) as any;

    const queryVector = embData.embedding;

    // B. Query database inside `withTenant` to enforce Postgres RLS
    const contextChunks = await withTenant(user.tenantId, async (tx) => {
      // Calculate cosine similarity: 1 - cosine_distance
      // Filter results to keep vectors of the active course
      const similarity = sql<number>`1 - (${embeddings.embedding} <=> ${JSON.stringify(queryVector)}::vector)`;
      
      return await tx
        .select({
          lessonTitle: lessons.title,
          textContent: sql`content_payload->>'text_content'`,
          similarity: similarity,
        })
        .from(embeddings)
        .innerJoin(lessons, eq(embeddings.lessonId, lessons.id))
        .innerJoin(modules, eq(lessons.moduleId, modules.id))
        .where(
          and(
            eq(embeddings.tenantId, user.tenantId),
            eq(modules.courseId, courseId)
          )
        )
        .orderBy(desc(similarity))
        .limit(3);
    });

    // C. Combine text chunks to construct context
    const contextText = contextChunks
      .map((c) => `Lektion: ${c.lessonTitle}\nInhalt: ${c.textContent || ''}`)
      .join('\n\n')
      .trim();

    if (!contextText) {
      return res.json({
        answer:
          'Für diesen Kurs sind noch keine Lektionsinhalte indexiert. Bitte im Admin-Bereich den Wizard öffnen und Schritt 2 (Inhalte & Skripte) generieren — erst dann kann der Tutor Fragen beantworten.',
        contextUsed: [],
      });
    }

    // D. Fetch AI Service endpoint to generate answer
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
      const data = (await response.json()) as any;
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
  const existing = readEnvFile();
  const merged = { ...existing, ...config };

  // Never persist known insecure default secrets: replace with a generated value.
  const insecureSecrets = new Set(['supersecretjwtkeyforauthentication123!', 'heygen-webhook-secret-key-12345']);
  if (!merged.JWT_SECRET || insecureSecrets.has(merged.JWT_SECRET)) {
    merged.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
  }
  if (!merged.WEBHOOK_SECRET || insecureSecrets.has(merged.WEBHOOK_SECRET)) {
    merged.WEBHOOK_SECRET = crypto.randomBytes(48).toString('base64url');
  }

  const standardKeys = new Set([
    'DATABASE_URL', 'PORT', 'JWT_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE',
    'TEMPORAL_ADDRESS', 'TEMPORAL_QUEUE',
    'HEYGEN_API_URL', 'HEYGEN_API_KEY', 'WEBHOOK_SECRET', 'WEBHOOK_URL',
    'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
    'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID', 'MINIMAX_VOICE_ID', 'MINIMAX_MODEL',
    'GENERATE_VIDEO', 'VIDEO_PROVIDER', 'ELEVENLABS_TTS_ONLY', 'TTS_PROVIDER',
    'AI_SERVICE_URL', 'LLM_PROVIDER', 'EMBEDDING_PROVIDER',
    'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
    'ZHIPU_API_KEY', 'ZHIPU_MODEL', 'ZHIPU_VISION_MODEL', 'ZHIPU_EMBEDDING_MODEL', 'ZHIPU_BASE_URL',
    'vLLM_BASE_URL', 'vLLM_MODEL'
  ]);

  const sections = [
    '# Database Configuration',
    `DATABASE_URL=${merged.DATABASE_URL || 'postgres://postgres:postgres@localhost:5439/elearning'}`,
    '',
    '# Server Configuration',
    `PORT=${merged.PORT || '3010'}`,
    `JWT_SECRET=${merged.JWT_SECRET}`,
    `JWT_ISSUER=${merged.JWT_ISSUER || 'elearning-platform'}`,
    `JWT_AUDIENCE=${merged.JWT_AUDIENCE || 'elearning-students'}`,
    '',
    '# Temporal Configuration',
    `TEMPORAL_ADDRESS=${merged.TEMPORAL_ADDRESS || 'localhost:7233'}`,
    `TEMPORAL_QUEUE=${merged.TEMPORAL_QUEUE || 'elearning-tasks'}`,
    '',
    '# HeyGen API & Webhooks',
    `HEYGEN_API_URL=${merged.HEYGEN_API_URL || 'http://localhost:3010/api/mock/heygen'}`,
    `HEYGEN_API_KEY=${merged.HEYGEN_API_KEY || 'mock-heygen-key'}`,
    `WEBHOOK_SECRET=${merged.WEBHOOK_SECRET}`,
    `WEBHOOK_URL=${merged.WEBHOOK_URL || 'http://localhost:3010/api/webhooks/heygen'}`,
    '',
    '# ElevenLabs configuration',
    `ELEVENLABS_API_KEY=${merged.ELEVENLABS_API_KEY || 'mock-elevenlabs-key'}`,
    `ELEVENLABS_VOICE_ID=${merged.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'}`,
    '',
    '# MiniMax Audio configuration',
    `MINIMAX_API_KEY=${merged.MINIMAX_API_KEY || ''}`,
    `MINIMAX_GROUP_ID=${merged.MINIMAX_GROUP_ID || ''}`,
    `MINIMAX_VOICE_ID=${merged.MINIMAX_VOICE_ID || 'male-qn-qingse'}`,
    `MINIMAX_MODEL=${merged.MINIMAX_MODEL || 'speech-02-hd'}`,
    '',
    '# Media Generation Config',
    `GENERATE_VIDEO=${merged.GENERATE_VIDEO !== undefined ? merged.GENERATE_VIDEO : 'false'}`,
    `VIDEO_PROVIDER=${merged.VIDEO_PROVIDER || 'elevenlabs'}`,
    `ELEVENLABS_TTS_ONLY=${merged.ELEVENLABS_TTS_ONLY !== undefined ? merged.ELEVENLABS_TTS_ONLY : 'true'}`,
    `TTS_PROVIDER=${merged.TTS_PROVIDER || 'elevenlabs'}`,
    '',
    '# AI Service Configuration (Python FastAPI)',
    `AI_SERVICE_URL=${merged.AI_SERVICE_URL || 'http://127.0.0.1:8085'}`,
    `LLM_PROVIDER=${merged.LLM_PROVIDER || 'openrouter'}`,
    `EMBEDDING_PROVIDER=${merged.EMBEDDING_PROVIDER || 'local'}`,
    '',
    '# API Keys',
    `OPENROUTER_API_KEY=${merged.OPENROUTER_API_KEY || 'mock-openrouter-key'}`,
    `OPENROUTER_MODEL=${merged.OPENROUTER_MODEL || 'google/gemini-2.5-pro'}`,
    `ZHIPU_API_KEY=${merged.ZHIPU_API_KEY || ''}`,
    `ZHIPU_MODEL=${merged.ZHIPU_MODEL || 'glm-5.3'}`,
    `ZHIPU_VISION_MODEL=${merged.ZHIPU_VISION_MODEL || 'glm-5.3-flash'}`,
    `ZHIPU_EMBEDDING_MODEL=${merged.ZHIPU_EMBEDDING_MODEL || 'embedding-3'}`,
    `ZHIPU_BASE_URL=${merged.ZHIPU_BASE_URL || 'https://api.z.ai/api/paas/v4/'}`,
    `vLLM_BASE_URL=${merged.vLLM_BASE_URL || 'http://localhost:8000/v1'}`,
    `vLLM_MODEL=${merged.vLLM_MODEL || 'meta-llama/Meta-Llama-3-8B-Instruct'}`,
  ];

  // Preserve any additional/custom keys (B11)
  const additionalKeys = Object.keys(merged).filter(k => !standardKeys.has(k));
  if (additionalKeys.length > 0) {
    sections.push('', '# Custom / Additional Environment Variables');
    for (const k of additionalKeys) {
      sections.push(`${k}=${merged[k]}`);
    }
  }

  fs.writeFileSync(envPath, sections.join('\n'), 'utf-8');
}

function maskKey(key: string): string {
  if (!key || key.length < 6) return '******';
  if (key === 'mock-openrouter-key' || key === 'mock-elevenlabs-key' || key === 'mock-heygen-key' || key === 'mock-minimax-key') {
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

const PROMPTS_DIR = path.join(process.cwd(), 'config', 'prompts');

function getSafePromptPath(id: string): string | null {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const resolved = path.resolve(PROMPTS_DIR, `${id}.json`);
  if (!resolved.startsWith(path.resolve(PROMPTS_DIR))) return null;
  return resolved;
}

function readPromptFile(id: string) {
  const filePath = getSafePromptPath(id);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function adminOrLocalAuth(req: any, res: any, next: any) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    return authenticateToken(req, res, () => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin permissions required' });
      }
      next();
    });
  }
  // P0.5 FIX: Never trust Host headers for auth bypass.
  // Explicit opt-in only via environment variable ALLOW_LOCAL_ADMIN=true, checking physical socket IP.
  if (process.env.ALLOW_LOCAL_ADMIN === 'true') {
    const remoteIp = req.socket?.remoteAddress || '';
    const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
    if (isLoopback) {
      req.user = { id: 'local-admin', email: 'admin@tenant-alpha.com', role: 'admin', tenantId: 'de305d54-75b4-431b-adb2-eb6b9e546014' };
      return next();
    }
  }
  return res.status(401).json({ error: 'Access token is required' });
}

// 11c. GET all Prompts (Admin only)
app.get('/api/admin/prompts', adminOrLocalAuth, async (req: any, res: any) => {
  try {
    if (!fs.existsSync(PROMPTS_DIR)) {
      return res.json([]);
    }
    const files = fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.json'));
    const prompts = files.map(file => {
      const data = JSON.parse(fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8'));
      const defSys = data.default_system_prompt || '';
      const defUsr = data.default_user_prompt || '';
      const curSys = data.system_prompt || '';
      const curUsr = data.user_prompt || '';
      data.is_customized = (curSys !== defSys) || (curUsr !== defUsr);
      return data;
    });
    res.json(prompts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11d. GET single Prompt (Admin only)
app.get('/api/admin/prompts/:id', adminOrLocalAuth, async (req, res) => {
  try {
    const data = readPromptFile(req.params.id);
    if (!data) return res.status(404).json({ error: 'Prompt-Schablone nicht gefunden' });
    const defSys = data.default_system_prompt || '';
    const defUsr = data.default_user_prompt || '';
    data.is_customized = (data.system_prompt !== defSys) || (data.user_prompt !== defUsr);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11e. PUT update Prompt (Admin only)
app.put('/api/admin/prompts/:id', adminOrLocalAuth, async (req, res) => {
  try {
    const data = readPromptFile(req.params.id);
    if (!data) return res.status(404).json({ error: 'Prompt-Schablone nicht gefunden' });

    const { system_prompt, user_prompt } = req.body;
    if (typeof system_prompt === 'string') data.system_prompt = system_prompt;
    if (typeof user_prompt === 'string') data.user_prompt = user_prompt;

    const defSys = data.default_system_prompt || '';
    const defUsr = data.default_user_prompt || '';
    data.is_customized = (data.system_prompt !== defSys) || (data.user_prompt !== defUsr);
    data.updated_at = new Date().toISOString();

    const filePath = getSafePromptPath(req.params.id);
    if (!filePath) return res.status(400).json({ error: 'Invalid prompt ID' });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    res.json({ success: true, prompt: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11f. POST reset Prompt to factory default (Admin only)
app.post('/api/admin/prompts/:id/reset', adminOrLocalAuth, async (req, res) => {
  try {
    const data = readPromptFile(req.params.id);
    if (!data) return res.status(404).json({ error: 'Prompt-Schablone nicht gefunden' });

    data.system_prompt = data.default_system_prompt || data.system_prompt;
    data.user_prompt = data.default_user_prompt || data.user_prompt;
    data.is_customized = false;
    data.updated_at = new Date().toISOString();

    const filePath = getSafePromptPath(req.params.id);
    if (!filePath) return res.status(400).json({ error: 'Invalid prompt ID' });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    res.json({ success: true, prompt: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11g. POST preview Prompt with mock variables (Admin only)
app.post('/api/admin/prompts/:id/preview', adminOrLocalAuth, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  try {
    const data = readPromptFile(req.params.id);
    if (!data) return res.status(404).json({ error: 'Prompt-Schablone nicht gefunden' });

    const { system_prompt, user_prompt, sample_variables } = req.body;
    let sysText = typeof system_prompt === 'string' ? system_prompt : data.system_prompt;
    let usrText = typeof user_prompt === 'string' ? user_prompt : data.user_prompt;

    const sample = {
      course_title: 'KI-Softwareentwicklung & Agenten-Workflows',
      target_audience: 'Softwareentwickler mit Backend-Erfahrung',
      duration_desc: '8 Wochen (40 Unterrichtstage insgesamt, Mo-Fr)',
      total_weeks: '8',
      target_days: '40',
      day_number: '1',
      day_theme: 'Grundlagen & Moderne Entwicklungsumgebungen',
      didactic_approach: 'Konzepteinführung gefolgt von geführten Programmierübungen',
      daily_milestone: 'Lauffähiges Modul und verstandene Konzepte für Tag 1',
      theory_ue: '3',
      practice_ue: '4',
      assessment_ue: '1',
      ue_title: 'Theorie 1: Einführung in LLM-APIs & Schemas',
      learning_objective: 'Verständnis für typisierte JSON-Schemas und API-Aufrufe',
      content_outline_formatted: '- API-Anbindung\n- Fehlerbehandlung\n- Validierung',
      topic: 'KI-Softwareentwicklung',
      duration_str: 'zweiwöchigen',
      course_topic: 'KI-Softwareentwicklung',
      module_title: 'Modul 1: Grundlagen',
      lesson_title: 'Lektion 1: Erste Schritte',
      position: 'Folie 1 von 5',
      slide_title: 'Architektur-Überblick',
      bullets_txt: '- Client-Server\n- Datenbank\n- Queue',
      ...(sample_variables || {})
    };

    for (const [k, v] of Object.entries(sample)) {
      sysText = sysText.split(`{${k}}`).join(String(v));
      usrText = usrText.split(`{${k}}`).join(String(v));
    }

    res.json({
      success: true,
      rendered_system_prompt: sysText,
      rendered_user_prompt: usrText,
    });
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
  const llmProvider = env.LLM_PROVIDER || 'zhipu';
  const zhipuKey = env.ZHIPU_API_KEY || '';
  const openRouterKey = env.OPENROUTER_API_KEY || '';
  const elevenlabsKey = env.ELEVENLABS_API_KEY || '';
  const minimaxKey = env.MINIMAX_API_KEY || '';
  const minimaxGroupId = env.MINIMAX_GROUP_ID || '';

  const stats = {
    provider: llmProvider,
    zhipu: { success: false, usage: 'Nicht konfiguriert', model: env.ZHIPU_MODEL || 'glm-5.3-flash', label: 'Z.AI Coding Plan' },
    openrouter: { success: false, usage: 'Nicht konfiguriert', label: '' },
    elevenlabs: { success: false, usage: 'Nicht konfiguriert', characterCount: 0, characterLimit: 0 },
    minimax: { success: false, usage: 'Nicht konfiguriert', balance: '' },
  };

  // 1a. Check Z.AI / Zhipu usage
  if (zhipuKey && zhipuKey !== 'mock-zhipu-key') {
    stats.zhipu = {
      success: true,
      usage: 'Flatrate (GLM Coding Plan)',
      model: env.ZHIPU_MODEL || 'glm-5.3-flash',
      label: 'Z.AI Flatrate Aktiv',
    };
  } else if (zhipuKey === 'mock-zhipu-key') {
    stats.zhipu = {
      success: true,
      usage: 'Flatrate (Mock-Modus)',
      model: 'glm-5.3-flash',
      label: 'Demo Key',
    };
  }

  // 1b. Fetch OpenRouter usage
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

  // 3. MiniMax connection check
  if (minimaxKey && minimaxGroupId) {
    try {
      const response = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${minimaxGroupId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${minimaxKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'speech-02-turbo',
          text: 'T',
          stream: false,
          voice_setting: { voice_id: 'German_FriendlyMan' },
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        if (data?.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) {
          stats.minimax = {
            success: false,
            usage: `Fehler: ${data.base_resp.status_msg}`,
            balance: '0',
          };
        } else {
          stats.minimax = {
            success: true,
            usage: 'Verbunden (Guthaben im Web-Console prüfen)',
            balance: 'Aktiv',
          };
        }
      } else {
        const errText = await response.text();
        stats.minimax = {
          success: false,
          usage: `HTTP Fehler: ${response.status}`,
          balance: '0',
        };
      }
    } catch (err: any) {
      stats.minimax = {
        success: false,
        usage: 'Verbindungsfehler',
        balance: '0',
      };
    }
  } else if (minimaxKey || minimaxGroupId) {
    stats.minimax = {
      success: false,
      usage: 'API Key oder Group ID fehlt',
      balance: '0',
    };
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
    const env = readEnvFile();
    apiKey = env.OPENROUTER_API_KEY || '';
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
    const env = readEnvFile();
    apiKey = env.ELEVENLABS_API_KEY || '';
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

// 12c. Test MiniMax Key & Group ID (Admin only)
app.post('/api/admin/config/test-minimax', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  let { apiKey, groupId, voiceId } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API-Key ist erforderlich' });
  if (!groupId) return res.status(400).json({ error: 'Group ID ist erforderlich' });

  if (apiKey.includes('***')) {
    const env = readEnvFile();
    apiKey = env.MINIMAX_API_KEY || '';
  }
  if (!voiceId) voiceId = process.env.MINIMAX_VOICE_ID || 'male-qn-qingse';

  try {
    const response = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${groupId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'speech-02-turbo',
        text: 'T',
        stream: false,
        voice_setting: { voice_id: voiceId },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(400).json({
        error: `HTTP Fehler von MiniMax (${response.status}): ${errText.slice(0, 150)}`,
      });
    }

    const data = await response.json() as any;
    if (data?.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) {
      return res.status(400).json({
        error: `${data.base_resp.status_msg} (MiniMax Code ${data.base_resp.status_code})`,
      });
    }

    return res.json({
      success: true,
      balance: 'Aktiv',
      voiceId,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Verbindungsfehler: ${err.message}` });
  }
});

// 12d. Test Zhipu / z.ai Key (Admin only)
app.post('/api/admin/config/test-zhipu', authenticateToken, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  let { apiKey, baseUrl } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'API-Key ist erforderlich' });
  }

  if (apiKey.includes('***')) {
    const env = readEnvFile();
    apiKey = env.GLM_API_KEY || env.ZHIPU_API_KEY || '';
  }
  if (!baseUrl) {
    const env = readEnvFile();
    baseUrl = env.GLM_BASE_URL || env.ZHIPU_BASE_URL || process.env.GLM_BASE_URL || 'https://api.z.ai/api/coding/paas/v4/';
  }

  if (!apiKey || apiKey === 'mock-zhipu-key' || apiKey === 'mock-glm-key') {
    return res.status(400).json({ error: 'Kein gültiger API-Key konfiguriert' });
  }

  try {
    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${cleanBaseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (response.ok) {
      const data = (await response.json()) as any;
      const rawList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      const models = rawList.map((m: any) => (typeof m === 'string' ? m : (m?.id || m?.name || ''))).filter(Boolean);
      return res.json({
        success: true,
        label: 'GLM / Z.ai verbunden',
        modelsCount: models.length,
        models,
      });
    } else {
      const errText = await response.text();
      let hint = '';
      if (errText.includes('1113')) {
        hint = ' (Z.ai Code 1113: Bei Coding-Plan-Abos muss der Endpunkt https://api.z.ai/api/coding/paas/v4/ aktiv sein)';
      }
      return res.status(400).json({
        error: `Fehler von GLM/Z.ai (${response.status}): ${errText.slice(0, 150)}${hint}`,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: `Netzwerkfehler zu GLM/Z.ai: ${err.message}` });
  }
});

// Alias for test-glm
app.post('/api/admin/config/test-glm', authenticateToken, async (req, res, next) => {
  // Delegate directly to test-zhipu logic
  req.url = '/api/admin/config/test-zhipu';
  app._router.handle(req, res, next);
});

// ==================== MOCK HEYGEN API ENDPOINTS ====================

// Mock Endpoint to simulate HeyGen video rendering (B3 FIX: Protect endpoint and restrict webhookUrl to loopback to prevent SSRF)
app.post('/api/mock/heygen/generate', adminOrLocalAuth, (req, res) => {
  const { videoId, courseId, script, audioUrl, webhookUrl } = req.body;

  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return res.status(400).json({ error: 'webhookUrl is required' });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid webhookUrl format' });
  }

  const allowedHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  if (!allowedHosts.includes(parsedUrl.hostname.toLowerCase())) {
    return res.status(400).json({ error: 'webhookUrl must target localhost / loopback address' });
  }
  
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

// ==================== COURSE FACTORY INSPECTOR & IMPORT API ====================

const COURSE_OUTPUT_DIR = path.join(process.cwd(), 'course_output');

function getSafeCourseFactoryPath(...segments: string[]): string | null {
  for (const seg of segments) {
    if (!seg || !/^[a-zA-Z0-9_-]+$/.test(seg)) return null;
  }
  const resolved = path.resolve(COURSE_OUTPUT_DIR, ...segments);
  const root = path.resolve(COURSE_OUTPUT_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// 1. Get Course Factory Overview
app.get('/api/course-factory/overview', adminOrLocalAuth, async (req, res) => {
  try {
    const masterPath = path.join(COURSE_OUTPUT_DIR, 'master_curriculum.json');
    if (!fs.existsSync(masterPath)) {
      return res.json({ exists: false, message: 'No course_output generated yet.' });
    }

    const curriculum = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
    
    // Scan generated weeks & days on disk
    const generatedTree: Record<string, number[]> = {};
    if (fs.existsSync(COURSE_OUTPUT_DIR)) {
      const entries = fs.readdirSync(COURSE_OUTPUT_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('week_')) {
          const weekNum = entry.name.replace('week_', '');
          const weekPath = path.join(COURSE_OUTPUT_DIR, entry.name);
          const dayEntries = fs.readdirSync(weekPath, { withFileTypes: true });
          const days: number[] = [];
          for (const d of dayEntries) {
            if (d.isDirectory() && d.name.startsWith('day_')) {
              days.push(parseInt(d.name.replace('day_', ''), 10));
            }
          }
          days.sort((a, b) => a - b);
          generatedTree[weekNum] = days;
        }
      }
    }

    res.json({
      exists: true,
      curriculum,
      generatedTree,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Day Plan
app.get('/api/course-factory/day', adminOrLocalAuth, async (req, res) => {
  const rawWeek = String(req.query.week || '').replace(/^week_/, '');
  const rawDay = String(req.query.day || '').replace(/^day_/, '');

  if (!/^\d+$/.test(rawWeek) || !/^\d+$/.test(rawDay)) {
    return res.status(400).json({ error: 'Parameters week and day must be valid numbers' });
  }

  try {
    const dayPlanPath = getSafeCourseFactoryPath(`week_${rawWeek}`, `day_${rawDay}`, `day_${rawDay}_plan.json`);
    if (!dayPlanPath || !fs.existsSync(dayPlanPath)) {
      return res.status(404).json({ error: `Day plan not found at week ${rawWeek}, day ${rawDay}` });
    }

    const data = JSON.parse(fs.readFileSync(dayPlanPath, 'utf-8'));
    const dayDir = getSafeCourseFactoryPath(`week_${rawWeek}`, `day_${rawDay}`);

    if (Array.isArray(data.units) && dayDir && fs.existsSync(dayDir)) {
      const subdirs = fs.readdirSync(dayDir);
      for (const unit of data.units) {
        const prefix = `ue_${unit.ue_number}_`;
        const matchingDir = subdirs.find(d => d.startsWith(prefix));
        if (matchingDir) {
          const files = fs.readdirSync(path.join(dayDir, matchingDir));
          unit.isGenerated = files.length > 0;
        } else {
          unit.isGenerated = false;
        }
      }
    }

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Unit Artifacts
app.get('/api/course-factory/ue', adminOrLocalAuth, async (req, res) => {
  const rawWeek = String(req.query.week || '').replace(/^week_/, '');
  const rawDay = String(req.query.day || '').replace(/^day_/, '');
  const rawUe = String(req.query.ue || '').replace(/^ue_/, '');

  if (!/^\d+$/.test(rawWeek) || !/^\d+$/.test(rawDay) || !/^\d+$/.test(rawUe)) {
    return res.status(400).json({ error: 'Parameters week, day, and ue must be valid numbers' });
  }

  try {
    const dayDir = getSafeCourseFactoryPath(`week_${rawWeek}`, `day_${rawDay}`);
    if (!dayDir || !fs.existsSync(dayDir)) {
      return res.status(404).json({ error: `Day directory not found at week ${rawWeek}, day ${rawDay}` });
    }

    const entries = fs.readdirSync(dayDir, { withFileTypes: true });
    const ueDirEntry = entries.find(e => e.isDirectory() && e.name.startsWith(`ue_${rawUe}_`));

    if (!ueDirEntry) {
      return res.status(404).json({ error: `UE directory for UE ${rawUe} not found` });
    }

    const ueDir = getSafeCourseFactoryPath(`week_${rawWeek}`, `day_${rawDay}`, ueDirEntry.name);
    if (!ueDir || !fs.existsSync(ueDir)) {
      return res.status(404).json({ error: `UE directory not found` });
    }
    const artifacts: Record<string, any> = {
      folderName: ueDirEntry.name,
    };

    // Video Script Artifacts
    const slidesPath = path.join(ueDir, 'slides.json');
    if (fs.existsSync(slidesPath)) {
      artifacts.slides = JSON.parse(fs.readFileSync(slidesPath, 'utf-8'));
    }
    const scriptPath = path.join(ueDir, 'elevenlabs_script.txt');
    if (fs.existsSync(scriptPath)) {
      artifacts.elevenlabsScript = fs.readFileSync(scriptPath, 'utf-8');
    }

    // Coding Exercise Artifacts
    const instructionsPath = path.join(ueDir, 'instructions.md');
    if (fs.existsSync(instructionsPath)) {
      artifacts.instructions = fs.readFileSync(instructionsPath, 'utf-8');
    }
    const bpDir = path.join(ueDir, 'boilerplate');
    if (fs.existsSync(bpDir)) {
      artifacts.boilerplate = {};
      for (const f of fs.readdirSync(bpDir)) {
        if (!f.includes('..')) {
          artifacts.boilerplate[f] = fs.readFileSync(path.join(bpDir, f), 'utf-8');
        }
      }
    }
    const solDir = path.join(ueDir, 'solution');
    if (fs.existsSync(solDir)) {
      artifacts.solution = {};
      for (const f of fs.readdirSync(solDir)) {
        if (!f.includes('..')) {
          artifacts.solution[f] = fs.readFileSync(path.join(solDir, f), 'utf-8');
        }
      }
    }
    const critPath = path.join(ueDir, 'validation_criteria.json');
    if (fs.existsSync(critPath)) {
      artifacts.validationCriteria = JSON.parse(fs.readFileSync(critPath, 'utf-8'));
    }

    // Quiz Artifacts
    const quizPath = path.join(ueDir, 'quiz.json');
    if (fs.existsSync(quizPath)) {
      artifacts.quiz = JSON.parse(fs.readFileSync(quizPath, 'utf-8'));
    }

    res.json(artifacts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Import Checked Course into PostgreSQL DB
app.post('/api/course-factory/import', adminOrLocalAuth, async (req, res) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permissions required' });
  }

  try {
    const masterPath = path.join(COURSE_OUTPUT_DIR, 'master_curriculum.json');
    if (!fs.existsSync(masterPath)) {
      return res.status(400).json({ error: 'Kein master_curriculum.json in course_output gefunden.' });
    }

    const curriculum = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));

    // Insert Course
    const [course] = await db.insert(courses).values({
      userId: user.id,
      tenantId: user.tenantId,
      topic: curriculum.course_title,
      status: 'curriculum_draft',
      progress: { duration: `${curriculum.total_weeks || 8}_weeks`, percent: 50, step: 'content_draft' },
    }).returning();

    // Iterate through weeks (as modules)
    for (let w = 0; w < curriculum.weeks.length; w++) {
      const week = curriculum.weeks[w];
      const [newModule] = await db.insert(modules).values({
        courseId: course.id,
        sequenceOrder: week.week_number,
        title: `Woche ${week.week_number}: ${week.week_theme}`,
      }).returning();

      // Read days for this week
      for (const dayOverview of week.days) {
        const dayNum = dayOverview.day_number;
        const dayPlanPath = path.join(COURSE_OUTPUT_DIR, `week_${week.week_number}`, `day_${dayNum}`, `day_${dayNum}_plan.json`);
        
        let units: any[] = [];
        if (fs.existsSync(dayPlanPath)) {
          const planData = JSON.parse(fs.readFileSync(dayPlanPath, 'utf-8'));
          units = planData.units || [];
        }

        for (const unit of units) {
          const ueDirMatch = `ue_${unit.ue_number}_`;
          const dayDir = path.join(COURSE_OUTPUT_DIR, `week_${week.week_number}`, `day_${dayNum}`);
          let ueDir: string | null = null;
          if (fs.existsSync(dayDir)) {
            const dEntries = fs.readdirSync(dayDir);
            const found = dEntries.find(d => d.startsWith(ueDirMatch));
            if (found) ueDir = path.join(dayDir, found);
          }

          let slides: any[] = [];
          let teleprompterScript = '';
          let textContent = '';
          let quizQuestions: any[] = [];
          let exerciseData: any = null;
          let boilerplateFiles: Record<string, string> = {};
          let solutionFiles: Record<string, string> = {};
          let valCriteria: string[] = [];

          if (ueDir && fs.existsSync(ueDir)) {
            const sPath = path.join(ueDir, 'slides.json');
            if (fs.existsSync(sPath)) {
              try {
                const sData = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
                // Map Course Factory slides to Learning Player format (Befund 12)
                slides = (sData.slides || []).map((s: any) => {
                  let layout = 'bullets';
                  let codeSnippet = '';
                  let mermaidCode = '';

                  if (s.layout_type === 'Code_Snippet') {
                    layout = 'code';
                    codeSnippet = (s.on_slide_text?.bullet_points_or_code || []).join('\n');
                  } else if (s.layout_type === 'Diagram') {
                    layout = 'mermaid';
                    mermaidCode = s.visual_description?.includes('graph') ? s.visual_description : '';
                  } else if (s.layout_type === 'Illustrated') {
                    layout = 'illustrated';
                  }

                  const imageCues = (s.image_cues || []).map((c: any) => ({
                    timestamp_percent: c.timestamp_percent ?? 0,
                    prompt: c.prompt || '',
                    transition: c.transition || 'fade',
                    image_url: c.image_url ? (c.image_url.startsWith('/') ? c.image_url : `/${c.image_url.replace(/\\/g, '/')}`) : '',
                  }));
                  const primaryImageUrl = s.image_url || (imageCues.length > 0 ? imageCues[0].image_url : '');

                  return {
                    title: s.on_slide_text?.heading || s.title || `Folie ${s.slide_number || 1}`,
                    layout: s.layout || layout,
                    bullets: s.on_slide_text?.bullet_points_or_code || s.bullets || [],
                    speaker_notes: s.elevenlabs_script || s.speaker_notes || '',
                    narration: s.elevenlabs_script || s.narration || '',
                    code_snippet: s.code_snippet || codeSnippet,
                    code_language: s.code_language || 'python',
                    mermaid_code: s.mermaid_code || mermaidCode,
                    visual_description: s.visual_description || '',
                    layout_type: s.layout_type,
                    image_url: primaryImageUrl ? (primaryImageUrl.startsWith('/') ? primaryImageUrl : `/${primaryImageUrl.replace(/\\/g, '/')}`) : '',
                    image_cues: imageCues,
                  };
                });
              } catch (_) {}
            }
            const scriptP = path.join(ueDir, 'elevenlabs_script.txt');
            if (fs.existsSync(scriptP)) {
              teleprompterScript = fs.readFileSync(scriptP, 'utf-8');
            }
            const instrP = path.join(ueDir, 'instructions.md');
            if (fs.existsSync(instrP)) {
              textContent = fs.readFileSync(instrP, 'utf-8');
            }
            const qPath = path.join(ueDir, 'quiz.json');
            if (fs.existsSync(qPath)) {
              const qData = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
              quizQuestions = (qData.questions || [])
                .map((q: any) => {
                  const optLetter = String(q.correct_option || '').trim().toUpperCase();
                  const matchedIdx = ['A', 'B', 'C', 'D'].indexOf(optLetter);
                  if (matchedIdx < 0) {
                    // Fail-closed: never map an invalid letter to a silent wrong answer
                    console.warn(`[course-factory/import] Frage übersprungen (ungültiger correct_option "${q.correct_option}"): ${q.question_text}`);
                    return null;
                  }
                  return {
                    question: q.question_text,
                    options: [q.options?.A || '', q.options?.B || '', q.options?.C || '', q.options?.D || ''],
                    correct_option_index: matchedIdx,
                    explanation: q.explanation,
                  };
                })
                .filter((q: any) => q !== null);
            }

            // Extract coding exercise artifacts (Befund 13)
            const exPath = path.join(ueDir, 'exercise.json');
            if (fs.existsSync(exPath)) {
              try { exerciseData = JSON.parse(fs.readFileSync(exPath, 'utf-8')); } catch (_) {}
            }
            const bpDir = path.join(ueDir, 'boilerplate');
            const solDir = path.join(ueDir, 'solution');
            const valPath = path.join(ueDir, 'validation_criteria.json');

            if (fs.existsSync(bpDir) && fs.statSync(bpDir).isDirectory()) {
              for (const bf of fs.readdirSync(bpDir)) {
                const bfp = path.join(bpDir, bf);
                if (fs.statSync(bfp).isFile()) boilerplateFiles[bf] = fs.readFileSync(bfp, 'utf-8');
              }
            }
            if (fs.existsSync(solDir) && fs.statSync(solDir).isDirectory()) {
              for (const sf of fs.readdirSync(solDir)) {
                const sfp = path.join(solDir, sf);
                if (fs.statSync(sfp).isFile()) solutionFiles[sf] = fs.readFileSync(sfp, 'utf-8');
              }
            }
            if (fs.existsSync(valPath)) {
              try { valCriteria = JSON.parse(fs.readFileSync(valPath, 'utf-8')); } catch (_) {}
            }

            if (unit.ue_type === 'practice' || unit.target_agent === 'coding_exercise_agent') {
              let practiceMd = textContent || `# ${unit.ue_title}\n\n${unit.learning_objective}`;
              if (Object.keys(boilerplateFiles).length > 0) {
                practiceMd += '\n\n## Starter-Code (# TODO)\n';
                for (const [fname, code] of Object.entries(boilerplateFiles)) {
                  practiceMd += `\n**Datei: \`${fname}\`**\n\`\`\`python\n${code}\n\`\`\`\n`;
                }
              }
              if (valCriteria.length > 0) {
                practiceMd += '\n\n## Akzeptanzkriterien\n';
                for (const c of valCriteria) {
                  practiceMd += `- ${c}\n`;
                }
              }
              textContent = practiceMd;
            }
          }

          const [newLesson] = await db.insert(lessons).values({
            moduleId: newModule.id,
            tenantId: user.tenantId,
            sequenceOrder: unit.ue_number || 1,
            title: `Tag ${dayNum} - UE ${unit.ue_number}: ${unit.ue_title}`,
            contentPayload: {
              description: unit.learning_objective,
              estimated_duration_minutes: 45,
              slides,
              text_content: textContent,
              teleprompter_script: teleprompterScript,
              quiz: quizQuestions,
              target_agent: unit.target_agent,
              ue_type: unit.ue_type,
              exercise: (() => {
                // Normalize Factory exercise.json (files[]) + disk dirs into player maps.
                const fromJsonBp: Record<string, string> = {};
                const fromJsonSol: Record<string, string> = {};
                if (exerciseData?.files && Array.isArray(exerciseData.files)) {
                  for (const f of exerciseData.files) {
                    if (f?.filename && typeof f.boilerplate_code === 'string') {
                      fromJsonBp[f.filename] = f.boilerplate_code;
                    }
                    if (f?.filename && typeof f.solution_code === 'string') {
                      fromJsonSol[f.filename] = f.solution_code;
                    }
                  }
                }
                const boilerplate = Object.keys(boilerplateFiles).length > 0 ? boilerplateFiles : fromJsonBp;
                const solution = Object.keys(solutionFiles).length > 0 ? solutionFiles : fromJsonSol;
                const criteria = valCriteria.length > 0
                  ? valCriteria
                  : (Array.isArray(exerciseData?.validation_criteria) ? exerciseData.validation_criteria : []);

                if (Object.keys(boilerplate).length === 0 && !exerciseData) {
                  return undefined;
                }
                return {
                  exercise_title: exerciseData?.exercise_title || exerciseData?.ue_title || unit.ue_title,
                  difficulty_level: exerciseData?.difficulty_level,
                  student_instructions_md: exerciseData?.student_instructions_md,
                  boilerplate,
                  solution,
                  validation_criteria: criteria,
                };
              })(),
            },
          }).returning();

          // Generate RAG embeddings for this lesson (Befund 14)
          const textForEmbedding = `${unit.ue_title}\n${unit.learning_objective}\n${textContent || ''}`.slice(0, 8000);
          try {
            const embRes = await fetch(`${AI_SERVICE_URL}/generate-embeddings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: textForEmbedding, tenant_id: user.tenantId }),
            });
            if (embRes.ok) {
              const embData = await embRes.json() as any;
              if (embData?.embedding) {
                await withTenant(user.tenantId, async (tx) => {
                  await tx.delete(embeddings).where(eq(embeddings.lessonId, newLesson.id));
                  await tx.insert(embeddings).values({
                    lessonId: newLesson.id,
                    tenantId: user.tenantId,
                    embedding: embData.embedding,
                  });
                });
              }
            }
          } catch (embErr) {
            console.warn(`[course-factory/import] Could not generate embeddings for lesson ${newLesson.id}:`, embErr);
          }
        }
      }
    }

    res.json({ success: true, courseId: course.id, message: `Kurs "${curriculum.course_title}" erfolgreich in Datenbank importiert!` });
  } catch (err: any) {
    console.error('[course-factory/import] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

let runningOrchestratorProcess: ChildProcess | null = null;

// 5. Get Live Generation Progress
app.get('/api/course-factory/progress', adminOrLocalAuth, async (req, res) => {
  try {
    const env = readEnvFile();
    const activeProvider = env.LLM_PROVIDER || process.env.LLM_PROVIDER || 'glm';
    const isGlm = ['glm', 'zhipu', 'zai'].includes(activeProvider.toLowerCase());
    const activeModel = isGlm ? (env.GLM_MODEL || env.ZHIPU_MODEL || 'glm-5.3') : (env.OPENROUTER_MODEL || 'google/gemini-2.5-pro');

    const progressPath = path.join(COURSE_OUTPUT_DIR, 'progress.json');
    if (!fs.existsSync(progressPath)) {
      return res.json({
        status: runningOrchestratorProcess ? 'running' : 'idle',
        current_phase: 'none',
        current_step: 'Bereit zum Start',
        total_ues: 320,
        completed_ues: 0,
        percent: 0,
        llm_provider: activeProvider,
        llm_model: activeModel,
        isRunning: runningOrchestratorProcess !== null,
      });
    }

    const data = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    res.json({
      ...data,
      llm_provider: data.llm_provider || activeProvider,
      llm_model: data.llm_model || activeModel,
      isRunning: runningOrchestratorProcess !== null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Start / Resume Course Factory Generation
app.post('/api/course-factory/start-generation', adminOrLocalAuth, async (req, res) => {
  if (runningOrchestratorProcess) {
    return res.status(400).json({ error: 'Course Factory läuft bereits im Hintergrund.' });
  }

  const { topic, audience, durationPreset, maxWeeks, maxDays, forceMock, forceRegenerate, llmProvider } = req.body;
  const courseTopic = topic || 'KI-gestützte Softwareentwicklung und Agenten-Workflows';
  const targetAudience = audience || 'Softwareentwickler mit Backend-Erfahrung';

  let effWeeks = maxWeeks ? Number(maxWeeks) : undefined;
  let effDays = maxDays ? Number(maxDays) : undefined;

  if (durationPreset) {
    switch (durationPreset) {
      case '1slide':
      case '1_slide':
      case 'mini':
      case 'minikurs':
        effDays = 1;
        effWeeks = 1;
        break;
      case '1day':
      case '1_day':
        effDays = 1;
        effWeeks = 1;
        break;
      case '1week':
        effWeeks = 1;
        effDays = 5;
        break;
      case '2weeks':
        effWeeks = 2;
        effDays = 10;
        break;
      case '4weeks':
      case '1month':
        effWeeks = 4;
        effDays = 20;
        break;
      case '6weeks':
        effWeeks = 6;
        effDays = 30;
        break;
      case '8weeks':
      case '2months':
        effWeeks = 8;
        effDays = 40;
        break;
    }
  }

  // Ensure stop_requested is false in progress.json so it starts cleanly
  try {
    const progressPath = path.join(COURSE_OUTPUT_DIR, 'progress.json');
    if (fs.existsSync(progressPath)) {
      const data = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      data.stop_requested = false;
      data.status = 'running';
      data.current_step = 'Starte Pipeline & prüfe Checkpoints...';
      if (llmProvider) {
        data.llm_provider = llmProvider;
        data.llm_model = ['glm', 'zhipu', 'zai'].includes(String(llmProvider).toLowerCase()) ? 'glm-5.3' : 'google/gemini-2.5-pro';
      }
      fs.writeFileSync(progressPath, JSON.stringify(data, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error('Error resetting progress.json before start:', e);
  }

  const pyArgs = [
    '-m', 'src.course_factory.orchestrator',
    '--topic', courseTopic,
    '--audience', targetAudience,
    '--output-dir', 'course_output',
  ];

  if (llmProvider) {
    const normProvider = String(llmProvider).toLowerCase().trim();
    pyArgs.push('--llm-provider', normProvider);
    process.env.LLM_PROVIDER = normProvider;
  }

  if (forceMock || process.env.NODE_ENV === 'test') {
    pyArgs.push('--mock');
  }

  if (forceRegenerate) {
    pyArgs.push('--force-regenerate');
  }

  if (effWeeks) {
    pyArgs.push('--max-weeks', String(effWeeks));
  }
  if (effDays) {
    pyArgs.push('--max-days', String(effDays));
  }

  try {
    console.log(`[COURSE FACTORY START] Spawning: python ${pyArgs.join(' ')}`);
    runningOrchestratorProcess = spawn('python', pyArgs, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });

    runningOrchestratorProcess.on('exit', (code) => {
      console.log(`[COURSE FACTORY EXIT] Process exited with code ${code}`);
      runningOrchestratorProcess = null;
    });

    res.json({ success: true, message: 'Course Factory Pipeline im Hintergrund gestartet.' });
  } catch (err: any) {
    runningOrchestratorProcess = null;
    res.status(500).json({ error: err.message });
  }
});

// 7. Stop / Pause Course Factory Generation
app.post('/api/course-factory/stop-generation', adminOrLocalAuth, async (req, res) => {
  try {
    const progressPath = path.join(COURSE_OUTPUT_DIR, 'progress.json');
    if (fs.existsSync(progressPath)) {
      const data = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      data.stop_requested = true;
      data.status = 'stopping';
      data.current_step = 'Stop-Signal empfangen – halte nach aktueller Einheit an...';
      fs.writeFileSync(progressPath, JSON.stringify(data, null, 2), 'utf-8');
    }

    if (runningOrchestratorProcess) {
      // Graceful timeout (4 seconds) then kill if process hasn't exited cleanly
      setTimeout(() => {
        if (runningOrchestratorProcess) {
          console.log('[COURSE FACTORY STOP] Graceful timeout expired, killing process.');
          try {
            runningOrchestratorProcess.kill();
          } catch (e) {}
          runningOrchestratorProcess = null;
        }
      }, 4000);
    }

    res.json({ success: true, message: 'Stop-Signal gesendet. Die Pipeline pausiert an der aktuellen Einheit.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

export { app };


