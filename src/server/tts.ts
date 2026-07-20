import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

function reloadEnv() {
  dotenv.config({ override: true });
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
    // Tiny silent-ish placeholder: write empty file marker + use remote demo URL is awkward for <audio src>.
    // Write a minimal valid-ish mp3 header is complex; copy a 1-byte stub and return path —
    // frontend can still show player; for mock use w3schools only if no local file needed.
    // Prefer writing the remote isn't possible. Create empty file and return path; browser may fail play.
    fs.writeFileSync(abs, Buffer.alloc(0));
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

export function computeSlidePipelineStatus(lessons: Array<{ contentPayload: any; videoUrl?: string | null }>) {
  const slides: any[] = [];
  for (const les of lessons) {
    const payload = (les.contentPayload || {}) as any;
    for (const s of payload.slides || []) {
      slides.push({ ...s, _lessonVideoUrl: les.videoUrl });
    }
  }

  const hasSlides = slides.length > 0 && slides.every((s) => s.layout === 'image' ? !!s.image_url : true);
  const imageSlides = slides.filter((s) => s.layout === 'image' || s.image_url);
  const relevant = imageSlides.length > 0 ? imageSlides : slides;

  const slidesReady = relevant.length > 0 && relevant.every((s) => !!(s.image_url || s.layout !== 'image'));
  const narrationsReady =
    relevant.length > 0 && relevant.every((s) => !!(s.speaker_notes && String(s.speaker_notes).trim()));
  const audioReady =
    relevant.length > 0 &&
    relevant.every(
      (s) => !!(s.audio_url && String(s.audio_url).trim()) || !!(s._lessonVideoUrl && String(s._lessonVideoUrl).trim())
    );

  // For pptx image decks, require per-slide audio_url for green check (lesson-level videoUrl alone is weaker)
  const pptxAudioReady =
    imageSlides.length > 0
      ? imageSlides.every((s) => !!(s.audio_url && String(s.audio_url).trim()))
      : audioReady;

  return {
    slidesReady: imageSlides.length > 0 ? imageSlides.every((s) => !!s.image_url) : hasSlides,
    narrationsReady,
    audioReady: pptxAudioReady,
    slideCount: relevant.length,
    narrationsDone: relevant.filter((s) => s.speaker_notes && String(s.speaker_notes).trim()).length,
    audioDone: relevant.filter((s) => s.audio_url && String(s.audio_url).trim()).length,
  };
}
