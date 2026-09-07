import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

function reloadEnv() {
  dotenv.config({ override: true });
}

export function writeSilentMockMp3(absPath: string): void {
  const frameSize = 417;
  const frameCount = 76;
  const frame = Buffer.alloc(frameSize, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const silent = Buffer.concat(Array(frameCount).fill(frame));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, silent);
}

/**
 * Synthesize speech via ElevenLabs (or mock). Returns public URL path.
 */
export async function synthesizeSpeechToFile(opts: {
  text: string;
  outRelativePath: string; // e.g. audio/foo.mp3 under public/
}): Promise<string> {
  reloadEnv();
  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const isMock = !apiKey || apiKey === 'mock-elevenlabs-key';

  const abs = path.join(process.cwd(), 'public', opts.outRelativePath.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  if (isMock) {
    writeSilentMockMp3(abs);
    return `/${opts.outRelativePath.replace(/^\//, '')}`;
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  }

  const buf = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(abs, buf);
  return `/${opts.outRelativePath.replace(/^\//, '')}`;
}

export function isMockMediaUrl(url: string | null | undefined): boolean {
  const u = String(url || '');
  return (
    !u ||
    u.includes('w3schools.com') ||
    u.includes('_tts_mock') ||
    u.includes('mov_bbb')
  );
}

export function computeSlidePipelineStatus(lessons: Array<{ contentPayload: any; videoUrl?: string | null }>) {
  if (!lessons || lessons.length === 0) {
    return {
      slidesReady: false,
      narrationsReady: false,
      audioReady: false,
      slideCount: 0,
      narrationsDone: 0,
      audioDone: 0,
    };
  }

  const slides: any[] = [];
  let totalLessons = lessons.length;
  let lessonsWithScript = 0;
  let lessonsWithAudio = 0;
  let totalSlides = 0;

  for (const les of lessons) {
    const payload = (les.contentPayload || {}) as any;
    const lessonSlides = payload.slides || [];
    totalSlides += lessonSlides.length;
    for (const s of lessonSlides) {
      slides.push({ ...s, _lessonVideoUrl: les.videoUrl });
    }

    const script = (payload.teleprompter_script || '').trim();
    const slideNotes = lessonSlides.map((s: any) => (s.speaker_notes || '').trim()).filter(Boolean);
    if (script.length > 10 || slideNotes.length > 0) {
      lessonsWithScript++;
    }

    const hasLessonAudio = !!(les.videoUrl && String(les.videoUrl).trim() && !isMockMediaUrl(les.videoUrl));
    const hasSlideAudio = lessonSlides.some(
      (s: any) => s.audio_url && String(s.audio_url).trim() && !isMockMediaUrl(s.audio_url)
    );
    if (hasLessonAudio || hasSlideAudio) {
      lessonsWithAudio++;
    }
  }

  const imageSlides = slides.filter((s) => s.layout === 'image' || s.image_url);
  const isPptxImageDeck = imageSlides.length > 0 && imageSlides.length === slides.length;

  if (isPptxImageDeck) {
    const slidesReady = imageSlides.every((s) => !!s.image_url);
    const narrationsReady = imageSlides.every((s) => !!(s.speaker_notes && String(s.speaker_notes).trim()));
    const audioReady = imageSlides.every(
      (s) => !!(s.audio_url && String(s.audio_url).trim() && !isMockMediaUrl(s.audio_url))
    );
    return {
      slidesReady,
      narrationsReady,
      audioReady,
      slideCount: imageSlides.length,
      narrationsDone: imageSlides.filter((s) => s.speaker_notes && String(s.speaker_notes).trim()).length,
      audioDone: imageSlides.filter(
        (s) => s.audio_url && String(s.audio_url).trim() && !isMockMediaUrl(s.audio_url)
      ).length,
    };
  }

  // Standard AI Wizard Course Pipeline
  const slidesReady = totalLessons > 0 && totalSlides > 0;
  const narrationsReady = totalLessons > 0 && lessonsWithScript === totalLessons;
  const audioReady = totalLessons > 0 && lessonsWithAudio === totalLessons;

  return {
    slidesReady,
    narrationsReady,
    audioReady,
    slideCount: totalSlides || totalLessons,
    narrationsDone: lessonsWithScript,
    audioDone: lessonsWithAudio,
  };
}
