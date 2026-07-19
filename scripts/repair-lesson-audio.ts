import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { courses, lessons, modules } from '../src/db/schema';

async function main() {
  const [course] = await db.select().from(courses).orderBy(courses.createdAt).limit(100);
  const allCourses = await db.select().from(courses);
  const target = allCourses.find((c) => c.topic?.toLowerCase().includes('docker')) || allCourses[0];
  if (!target) {
    console.error('No course found');
    process.exit(1);
  }

  const courseModules = await db.select().from(modules).where(eq(modules.courseId, target.id));
  let repaired = 0;
  let missing = 0;

  for (const mod of courseModules) {
    const courseLessons = await db.select().from(lessons).where(eq(lessons.moduleId, mod.id));
    for (const les of courseLessons) {
      const fileName = `audio-${target.id}-${les.id}.mp3`;
      const filePath = path.join(process.cwd(), 'public', 'audio', fileName);
      if (fs.existsSync(filePath)) {
        const url = `/audio/${fileName}`;
        await db.update(lessons).set({ videoUrl: url }).where(eq(lessons.id, les.id));
        console.log(`OK  ${les.title} -> ${url}`);
        repaired++;
      } else {
        console.log(`MISS ${les.title} (${fileName})`);
        missing++;
      }
    }
  }

  console.log(`Repaired ${repaired}, missing ${missing} for course ${target.id} (${target.topic})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
