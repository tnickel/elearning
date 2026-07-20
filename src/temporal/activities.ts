import { db, withTenant, inList } from '../db';
import { courses, modules, lessons, embeddings } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'mock-elevenlabs-key';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const HEYGEN_API_URL = process.env.HEYGEN_API_URL || 'http://localhost:3000/api/mock/heygen';
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY || 'mock-heygen-key';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/api/webhooks/heygen';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID || '';
const MINIMAX_VOICE_ID = process.env.MINIMAX_VOICE_ID || 'male-qn-qingse';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'speech-02-hd';

// Helper to make API calls to Python AI Service
async function callAiService(endpoint: string, body: any) {
  const url = `${AI_SERVICE_URL}${endpoint}`;
  console.log(`[callAiService] Fetching URL: ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI Service error on ${endpoint}: ${errText}`);
  }
  
  return await response.json();
}

// 1. Generate Curriculum
export async function generateCurriculum(courseId: string, topic: string, tenantId: string, duration?: string): Promise<void> {
  console.log(`Generating curriculum for course ${courseId} on topic: ${topic} with duration: ${duration || '2_weeks'}`);
  
  const curriculum = (await callAiService('/generate-curriculum', {
    topic,
    tenant_id: tenantId,
    duration: duration || '2_weeks',
  })) as any;

  // Save modules and lessons in database
  await db.transaction(async (tx) => {
    // Check if course exists
    const [existingCourse] = await tx.select().from(courses).where(eq(courses.id, courseId));
    if (!existingCourse) {
      throw new Error(`Course ${courseId} not found`);
    }

    // Insert modules and lessons
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
          tenantId: tenantId,
          title: lesData.title,
          contentPayload: {
            description: lesData.description,
            estimated_duration_minutes: lesData.estimated_duration_minutes,
            text_content: '',
            teleprompter_script: '',
            quiz: [],
          },
        });
      }
    }
  });

  console.log(`Curriculum successfully created and stored in DB for course ${courseId}.`);
}

// 2. Generate Lessons Content and pgvector Embeddings
export async function generateLessonsAndEmbeddings(courseId: string, topic: string, tenantId: string): Promise<void> {
  console.log(`Generating lessons content and embeddings for course ${courseId}...`);

  // Fetch all lessons of the course
  const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
  const moduleIds = courseModules.map((m) => m.id);
  
  if (moduleIds.length === 0) {
    throw new Error(`No modules found for course ${courseId}`);
  }

  const allLessons = await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds));

  const total = allLessons.length;
  for (let i = 0; i < total; i++) {
    const lesson = allLessons[i];
    const moduleOfLesson = courseModules.find((m) => m.id === lesson.moduleId);
    const moduleTitle = moduleOfLesson ? moduleOfLesson.title : 'Modul';

    const percent = Math.round(25 + (i / total) * 50);
    await updateCourseProgress(courseId, percent, `Generiere Lektion ${i + 1} von ${total}: "${lesson.title}"...`);

    console.log(`Generating content for lesson: ${lesson.title}`);
    
    // Generate detailed content via Instructor
    const content = (await callAiService('/generate-lesson', {
      course_topic: topic,
      module_title: moduleTitle,
      lesson_title: lesson.title,
      tenant_id: tenantId,
    })) as any;

    // Update lesson details in the database
    await db.update(lessons)
      .set({ contentPayload: content })
      .where(eq(lessons.id, lesson.id));

    // Generate 1536-dimensional embeddings for RAG
    // We embed the text content (theory) of the lesson
    console.log(`Generating vector embedding for lesson: ${lesson.title}`);
    const embeddingResponse = (await callAiService('/generate-embeddings', {
      text: content.text_content,
      tenant_id: tenantId,
    })) as any;

    // Save vector in the database (with RLS)
    await withTenant(tenantId, async (tx) => {
      await tx.insert(embeddings).values({
        lessonId: lesson.id,
        tenantId: tenantId,
        embedding: embeddingResponse.embedding,
      });
    });
  }

  console.log(`Finished content generation and vector embedding indexing for course ${courseId}.`);
}

// 3. Initiate ElevenLabs Audio and HeyGen Avatar Video rendering
export async function startVideoRendering(courseId: string, tenantId: string): Promise<{ videoId: string; awaitWebhook: boolean; mediaUrl?: string }> {
  // Reload environment variables dynamically from the .env file on disk
  dotenv.config({ override: true });


  const GENERATE_VIDEO = process.env.GENERATE_VIDEO === 'true';
  const VIDEO_PROVIDER = process.env.VIDEO_PROVIDER || 'elevenlabs';
  const TTS_PROVIDER = process.env.TTS_PROVIDER || 'elevenlabs';

  const currentElevenLabsApiKey = process.env.ELEVENLABS_API_KEY || 'mock-elevenlabs-key';
  const currentElevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  const currentMiniMaxApiKey = process.env.MINIMAX_API_KEY || '';
  const currentMiniMaxGroupId = process.env.MINIMAX_GROUP_ID || '';
  const currentMiniMaxVoiceId = process.env.MINIMAX_VOICE_ID || 'German_FriendlyMan';
  const currentMiniMaxModel = process.env.MINIMAX_MODEL || 'speech-02-hd';

  console.log(`Initiating media generation for course ${courseId} (GENERATE_VIDEO: ${GENERATE_VIDEO}, VIDEO_PROVIDER: ${VIDEO_PROVIDER}, TTS_PROVIDER: ${TTS_PROVIDER})...`);

  // Fetch all modules of the course
  const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
  const moduleIds = courseModules.map((m) => m.id);

  if (moduleIds.length === 0) {
    throw new Error(`No modules found for course ${courseId}`);
  }

  // Fetch all lessons of the course
  const allLessons = await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds));

  if (allLessons.length === 0) {
    throw new Error(`No lessons found for course ${courseId}`);
  }

  const isMockElevenLabs = !currentElevenLabsApiKey || currentElevenLabsApiKey === 'mock-elevenlabs-key';
  const isMockMiniMax = !currentMiniMaxApiKey || !currentMiniMaxGroupId;

  // Make sure the public/audio directory exists
  const audioDir = path.join(process.cwd(), 'public', 'audio');
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  let overallMediaUrl = '';

  // Loop over all lessons and generate media for each!
  for (let i = 0; i < allLessons.length; i++) {
    const lesson = allLessons[i];
    const payload = lesson.contentPayload as any;
    // Prefer per-slide speaker_notes (PPTX Vision pipeline); fall back to lesson teleprompter
    const slideNotes = (payload.slides || [])
      .map((s: any) => (s.speaker_notes || '').trim())
      .filter(Boolean);
    const script =
      slideNotes.length > 0
        ? slideNotes.join('\n\n')
        : (payload.teleprompter_script || 'Willkommen bei dieser Lektion.');

    let lessonMediaUrl = '';

    await updateCourseProgress(
      courseId,
      Math.round(80 + ((i + 1) / allLessons.length) * 10),
      `TTS Lektion ${i + 1}/${allLessons.length}: „${lesson.title}“…`
    );

    if (TTS_PROVIDER === 'minimax' && !isMockMiniMax) {
      // ── MiniMax TTS ──────────────────────────────────────────────────────────
      console.log(`[TTS/MiniMax] Generating audio for lesson ${i + 1}/${allLessons.length}: "${lesson.title}" (model: ${currentMiniMaxModel}, voice: ${currentMiniMaxVoiceId})...`);
      try {
        const response = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${currentMiniMaxGroupId}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentMiniMaxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: currentMiniMaxModel,
            text: script,
            stream: false,
            voice_setting: {
              voice_id: currentMiniMaxVoiceId,
              speed: 1.0,
              vol: 1.0,
              pitch: 0,
            },
            output_format: 'hex',
          }),
        });

        if (!response.ok) {
          throw new Error(`MiniMax returned status ${response.status}: ${await response.text()}`);
        }

        const data = await response.json() as any;
        if (data?.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) {
          throw new Error(`MiniMax API Error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
        }
        // MiniMax returns base64-encoded audio in data.audio.audio
        if (!data?.audio?.audio) {
          throw new Error('MiniMax response missing audio data');
        }
        const audioBuffer = Buffer.from(data.audio.audio, 'hex');
        const fileName = `audio-${courseId}-${lesson.id}.mp3`;
        fs.writeFileSync(path.join(audioDir, fileName), audioBuffer);
        lessonMediaUrl = `/audio/${fileName}`;
        console.log(`[TTS/MiniMax] Audio synthesized successfully for lesson: "${lesson.title}".`);
      } catch (err: any) {
        console.error(`[TTS/MiniMax] Call failed for lesson "${lesson.title}": ${err.message}. Using fallback mock audio.`);
        lessonMediaUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
      }
    } else if (TTS_PROVIDER === 'minimax' && isMockMiniMax) {
      console.log(`[TTS/MiniMax] Running in MOCK mode for lesson "${lesson.title}" (API key or Group ID missing).`);
      lessonMediaUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
    } else if (!isMockElevenLabs) {
      // ── ElevenLabs TTS ───────────────────────────────────────────────────────
      console.log(`[TTS] Generating ElevenLabs audio for lesson ${i + 1}/${allLessons.length}: "${lesson.title}" using voice ID ${currentElevenLabsVoiceId}...`);
      try {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${currentElevenLabsVoiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': currentElevenLabsApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: script,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });

        if (!response.ok) {
          throw new Error(`ElevenLabs returned status ${response.status}: ${await response.text()}`);
        }

        console.log(`[TTS] ElevenLabs audio synthesized successfully for lesson: "${lesson.title}".`);
        
        const arrayBuf = await response.arrayBuffer();
        const fileName = `audio-${courseId}-${lesson.id}.mp3`;
        fs.writeFileSync(path.join(audioDir, fileName), Buffer.from(arrayBuf));
        lessonMediaUrl = `/audio/${fileName}`;
      } catch (err: any) {
        console.error(`[TTS] ElevenLabs call failed for lesson "${lesson.title}": ${err.message}. Using fallback mock audio.`);
        lessonMediaUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
      }
    } else {
      console.log(`[TTS] ElevenLabs running in MOCK mode for lesson "${lesson.title}". Using mock audio.`);
      lessonMediaUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
    }

    // Update lesson media URL in the database
    await db.update(lessons)
      .set({ videoUrl: lessonMediaUrl })
      .where(eq(lessons.id, lesson.id));

    if (i === 0) {
      overallMediaUrl = lessonMediaUrl;
    }
  }

  // B. Return immediately if we do NOT want video avatar rendering (Audio-only)
  if (!GENERATE_VIDEO) {
    console.log(`Audio-only generation complete for all lessons.`);
    return { videoId: '', awaitWebhook: false, mediaUrl: overallMediaUrl };
  }

  // C. Video Avatar rendering (If GENERATE_VIDEO is true, we trigger HeyGen/ElevenLabs lip-sync)
  // For simplicity, we trigger the video generation for the FIRST lesson only (which matches HeyGen's webhook flow)
  const firstLesson = allLessons[0];
  const firstLessonPayload = firstLesson.contentPayload as any;
  const firstLessonScript = firstLessonPayload.teleprompter_script || 'Willkommen beim Kurs.';
  
  const videoId = `${VIDEO_PROVIDER === 'heygen' ? 'hgv' : 'elv'}_${uuidv4()}`;
  console.log(`Triggering ${VIDEO_PROVIDER} video rendering with videoId: ${videoId}`);

  if (VIDEO_PROVIDER === 'heygen') {
    const isMockHeyGen = HEYGEN_API_URL.includes('localhost') || HEYGEN_API_KEY === 'mock-heygen-key';
    if (isMockHeyGen) {
      await fetch(`${HEYGEN_API_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId,
          courseId,
          script: firstLessonScript,
          audioUrl: overallMediaUrl || 'https://www.w3schools.com/html/mov_bbb.mp4',
          webhookUrl: WEBHOOK_URL,
        }),
      });
    } else {
      const response = await fetch(`${HEYGEN_API_URL}/v2/video/generate`, {
        method: 'POST',
        headers: {
          'X-Api-Key': HEYGEN_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          video_inputs: [{
            character: { type: 'avatar', avatar_id: 'Anna_marketing_professional' },
            voice: { type: 'audio', audio_url: overallMediaUrl || 'https://www.w3schools.com/html/mov_bbb.mp4' },
          }],
          callback_url: WEBHOOK_URL,
          test: true,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HeyGen API returned error: ${errText}`);
      }
    }
  } else {
    await fetch(`${HEYGEN_API_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        courseId,
        script: firstLessonScript,
        audioUrl: overallMediaUrl || 'https://www.w3schools.com/html/mov_bbb.mp4',
        webhookUrl: WEBHOOK_URL,
      }),
    });
  }

  console.log(`Video rendering triggered. Video ID is ${videoId}.`);
  return { videoId, awaitWebhook: true };
}

// 4. Update Course Status
export async function setCourseStatus(courseId: string, status: 'generating' | 'pending_approval' | 'active' | 'failed', videoUrl?: string): Promise<void> {
  console.log(`Updating status of course ${courseId} to: ${status}`);
  
  await db.update(courses)
    .set({ status })
    .where(eq(courses.id, courseId));

  // Only apply a shared videoUrl for true avatar-video webhooks.
  // Audio-only TTS already writes a unique /audio/... URL per lesson in startVideoRendering —
  // overwriting all lessons with mediaUrl (first lesson) made every lesson play the same sound.
  if (videoUrl && !videoUrl.startsWith('/audio/')) {
    const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
    const moduleIds = courseModules.map((m) => m.id);
    if (moduleIds.length > 0) {
      await db.update(lessons)
        .set({ videoUrl })
        .where(inList(lessons.moduleId, moduleIds));
    }
  }
}

// Update Course Generation Progress (percent and current step)
export async function updateCourseProgress(courseId: string, percent: number, step: string): Promise<void> {
  console.log(`[PROGRESS] Course ${courseId} progress: ${percent}% - ${step}`);
  await db.update(courses)
    .set({ progress: { percent, step } })
    .where(eq(courses.id, courseId));
}

// ==================== SAGA COMPENSATING ACTIONS ====================

export async function compensateCurriculum(courseId: string): Promise<void> {
  console.log(`SAGA: Deleting course modules and lessons for course ${courseId}`);
  await db.delete(modules).where(eq(modules.courseId, courseId));
}

export async function compensateEmbeddings(courseId: string): Promise<void> {
  console.log(`SAGA: Deleting vector embeddings for course ${courseId}`);
  // Fetch lesson IDs
  const courseModules = await db.select().from(modules).where(eq(modules.courseId, courseId));
  const moduleIds = courseModules.map((m) => m.id);
  if (moduleIds.length > 0) {
    const courseLessons = await db.select().from(lessons).where(inList(lessons.moduleId, moduleIds));
    const lessonIds = courseLessons.map((l) => l.id);
    if (lessonIds.length > 0) {
      await db.delete(embeddings).where(inList(embeddings.lessonId, lessonIds));
    }
  }
}

export async function compensateVideo(videoId: string): Promise<void> {
  console.log(`SAGA: Cancelling HeyGen video rendering for job ${videoId}`);
  try {
    // If not mock, call HeyGen cancel endpoint
    if (HEYGEN_API_KEY !== 'mock-heygen-key') {
      await fetch(`${HEYGEN_API_URL}/v2/video/cancel`, {
        method: 'POST',
        headers: {
          'X-Api-Key': HEYGEN_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ video_id: videoId }),
      });
    }
  } catch (err: any) {
    console.error(`Saga video compensation failed: ${err.message}`);
  }
}
