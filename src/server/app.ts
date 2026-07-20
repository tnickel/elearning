import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Connection, Client } from '@temporalio/client';
import { db, withTenant, inList } from '../db';
import { users, courses, modules, lessons, embeddings } from '../db/schema';
import { eq, desc, asc, sql, and } from 'drizzle-orm';
import { authenticateToken, generateToken, UserPayload } from './auth';
import { recordHeartbeat, verifyHashChain } from './timeTracking';
import { runMigrations } from '../db/migrations';
import { OfficeParser } from 'officeparser';
import { renderPptxToPngs, publishSlideImages, cleanupWorkDir } from './pptxRender';
import { synthesizeSpeechToFile, computeSlidePipelineStatus } from './tts';

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
      progress: { duration: duration || '2_weeks', percent: 0, step: 'curriculum_draft' },
    }).returning();
    res.status(202).json({
      message: 'Course draft initiated.',
      courseId: course.id,
    });
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

function flattenImageSlides(allLessons: any[]) {
  type Flat = { lessonId: string; slideIndex: number; slide: any };
  const out: Flat[] = [];
  for (const lesson of allLessons) {
    const payload = (lesson.contentPayload || {}) as any;
    (payload.slides || []).forEach((slide: any, slideIndex: number) => {
      if (slide.layout === 'image' || slide.image_url) {
        out.push({ lessonId: lesson.id, slideIndex, slide });
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
    const abs = path.join(process.cwd(), 'public', imageUrl.replace(/^\//, ''));
    if (fs.existsSync(abs)) {
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

    let response: Response;
    try {
      response = await fetch(`${AI_SERVICE_URL}/generate-curriculum`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (fetchErr: any) {
      throw new Error(
        `AI-Service nicht erreichbar unter ${AI_SERVICE_URL} (${fetchErr?.message || 'fetch failed'}). Bitte python src/ai_service/main.py starten.`
      );
    }

    if (!response.ok) {
      throw new Error(`AI Service returned status ${response.status}: ${await response.text()}`);
    }

    const curriculum = (await response.json()) as any;

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

    const allLessons = await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds));

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

          // Generate embeddings
          const embResponse = (await fetch(`${AI_SERVICE_URL}/generate-embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: content.text_content, tenant_id: user.tenantId }),
          }).then((r) => r.json())) as any;

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

    // Enrich with Folien / Sprechtext / Vertonung readiness (admin dashboard checkmarks)
    if (user.role === 'admin' && list.length > 0) {
      const enriched = await Promise.all(list.map(async (course) => {
        const isPptx = (course.progress as any)?.source === 'pptx';
        if (!isPptx) {
          return { ...course, pipeline: null, isPptx: false };
        }
        try {
          const { allLessons } = await loadCourseLessons(course.id);
          const pipeline = computeSlidePipelineStatus(allLessons);
          return { ...course, pipeline, isPptx: true };
        } catch {
          return { ...course, pipeline: null, isPptx: true };
        }
      }));
      return res.json(enriched);
    }

    res.json(list.map((c) => ({ ...c, isPptx: (c.progress as any)?.source === 'pptx', pipeline: null })));
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
        .where(inList(lessons.moduleId, moduleIds))
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
    '# MiniMax Audio configuration',
    `MINIMAX_API_KEY=${config.MINIMAX_API_KEY || ''}`,
    `MINIMAX_GROUP_ID=${config.MINIMAX_GROUP_ID || ''}`,
    `MINIMAX_VOICE_ID=${config.MINIMAX_VOICE_ID || 'male-qn-qingse'}`,
    `MINIMAX_MODEL=${config.MINIMAX_MODEL || 'speech-02-hd'}`,
    '',
    '# Media Generation Config',
    `GENERATE_VIDEO=${config.GENERATE_VIDEO !== undefined ? config.GENERATE_VIDEO : 'false'}`,
    `VIDEO_PROVIDER=${config.VIDEO_PROVIDER || 'elevenlabs'}`,
    `ELEVENLABS_TTS_ONLY=${config.ELEVENLABS_TTS_ONLY !== undefined ? config.ELEVENLABS_TTS_ONLY : 'true'}`,
    `TTS_PROVIDER=${config.TTS_PROVIDER || 'elevenlabs'}`,
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
  const minimaxKey = env.MINIMAX_API_KEY || '';
  const minimaxGroupId = env.MINIMAX_GROUP_ID || '';

  const stats = {
    openrouter: { success: false, usage: 'Nicht konfiguriert', label: '' },
    elevenlabs: { success: false, usage: 'Nicht konfiguriert', characterCount: 0, characterLimit: 0 },
    minimax: { success: false, usage: 'Nicht konfiguriert', balance: '' },
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

