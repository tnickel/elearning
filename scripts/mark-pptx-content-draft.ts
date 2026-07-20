import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index';
import { courses } from '../src/db/schema';

async function main() {
  const all = await db.select().from(courses);
  for (const c of all) {
    if (!c.topic?.includes('Zeitreise')) continue;
    await db.update(courses).set({
      status: 'content_draft',
      progress: {
        percent: 40,
        step: 'PowerPoint 1:1 importiert – Sprechtexte ausstehend',
        source: 'pptx',
      },
    }).where(eq(courses.id, c.id));
    console.log('Updated', c.id, c.topic);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
