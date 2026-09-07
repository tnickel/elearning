import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { courses, modules, lessons } from '../src/db/schema';

async function verify() {
  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.topic, 'Minikurs: Klebetechnik & Kleisterarten im Handwerk'));

  if (!course) {
    console.error('Course not found!');
    process.exit(1);
  }

  const [mod] = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, course.id));

  const [les] = await db
    .select()
    .from(lessons)
    .where(eq(lessons.moduleId, mod.id));

  const payload = les.contentPayload as any;
  console.log('=== KURS BESTÄTIGUNG ===');
  console.log('ID:', course.id);
  console.log('Titel:', course.topic);
  console.log('Status:', course.status);
  console.log('Lektion:', les.title);
  console.log('Anzahl Folien:', payload.slides.length);
  console.log('Folie 1 Titel:', payload.slides[0].title);
  console.log('Folie 1 Bild-Cues:', payload.slides[0].image_cues.length);
  payload.slides[0].image_cues.forEach((cue: any, idx: number) => {
    console.log(`  Cue ${idx + 1}: ${cue.timestamp_percent}% -> ${cue.image_url} (${cue.transition})`);
  });
  console.log('Audio URL:', payload.slides[0].audio_url);
  process.exit(0);
}

verify().catch((e) => {
  console.error(e);
  process.exit(1);
});
