import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
import { db } from '../src/db/index';
import { courses, modules, lessons, users } from '../src/db/schema';

async function main() {
  console.log('Seeding Sample 1-Slide Minikurs into Database...');

  // 1. Find or create an admin user
  let [user] = await db.select().from(users).limit(1);
  if (!user) {
    const tenantId = 'de305d54-75b4-431b-adb2-eb6b9e546014';
    [user] = await db.insert(users).values({
      email: 'admin@tenant-alpha.com',
      role: 'admin',
      tenantId,
    }).returning();
    console.log(`Created default admin user: ${user.email} (${user.id})`);
  }

  const tenantId = user.tenantId;
  const courseTopic = 'Minikurs: Klebetechnik & Kleisterarten im Handwerk';

  // 2. Delete existing course with this title if present
  const existingCourses = await db.select().from(courses).where(and(eq(courses.topic, courseTopic), eq(courses.tenantId, tenantId)));
  for (const c of existingCourses) {
    await db.delete(courses).where(eq(courses.id, c.id));
    console.log(`Deleted existing course ${c.id}`);
  }

  // 3. Create course directly with status: 'active' (freigegeben!)
  const [course] = await db.insert(courses).values({
    userId: user.id,
    tenantId,
    topic: courseTopic,
    status: 'active', // Published / Freigegeben!
    progress: {
      percent: 100,
      step: 'Freigegeben & bereit zum Lernen',
      duration: '1_slide',
      modules: 1,
      lessons: 1,
      slides: 1,
    },
  }).returning();

  console.log(`Created Course: ${course.topic} (ID: ${course.id}, Status: ${course.status})`);

  // 4. Create single module
  const [module] = await db.insert(modules).values({
    courseId: course.id,
    sequenceOrder: 1,
    title: 'Schnellstart Klebetechnik',
  }).returning();

  // 5. Create 1 single lesson with 1 interactive slide containing 3 image cues
  const detailedScript = (
    'Herzlich willkommen zu diesem praxisnahen Minikurs über die richtige Klebetechnik im Handwerk! ' +
    'Auf der Werkbank siehst du die elementaren Werkzeuge und Gebinde für den professionellen Einsatz vorbereitet. ' +
    'Vor jedem Arbeitsbeginn ist es entscheidend, die Beschaffenheit des Untergrunds und die spezifischen Materialeigenschaften genau abzuwiegen... ' +
    'Beim Tapezieren setzen wir standardmäßig auf Methylcellulose. ' +
    'Nach dem klumpenfreien Anrühren und einer ausreichenden Quellzeit wird der Kleister mit dem breiten Deckenquast zügig von der Mitte zu den Rändern aufgetragen. ' +
    'So stellen wir sicher, dass die Kanten optimal durchfeuchtet sind und sich die Bahnen an der Wand später ohne Blasenbildung perfekt andrücken lassen... ' +
    'Im direkten Vergleich siehst du den klaren Unterschied zum weißen PVAc-Holzleim: ' +
    'Während der Tapetenkleister diffusionsoffen und flexibel bleibt, bindet Holzleim chemisch ab und härtet glasklar zu einer extrem zugfesten Verbindung aus. ' +
    'Mit diesem Wissen wählst du für jedes Material zielsicher die richtige Verbindungstechnik.'
  );

  const slide1 = {
    title: 'Kleisterarten & fachgerechte Verarbeitung',
    layout: 'bullets',
    layout_type: 'Illustrated',
    bullets: [
      'Tapetenkleister (Methylcellulose): quellfähig, transparent & diffusionsoffen',
      'Verarbeitung: Klumpenfrei anrühren, Quellzeit einhalten, satt mit Quast einstreichen',
      'Holzleim (PVAc): weißer Holzleim, bindet chemisch ab & trocknet hochfest',
    ],
    speaker_notes: detailedScript,
    narration: detailedScript,
    image_url: '/images/minikurs_kleister_cue0.png',
    image_cues: [
      {
        timestamp_percent: 0,
        prompt: 'Professionelle Nahaufnahme einer geordneten Handwerker-Werkbank mit Kleister und Werkzeug',
        transition: 'fade',
        image_url: '/images/minikurs_kleister_cue0.png',
      },
      {
        timestamp_percent: 42,
        prompt: 'Handwerker trägt mit Quast gleichmäßig Tapetenkleister auf die Rückseite einer Tapetenbahn auf',
        transition: 'slide_left',
        image_url: '/images/minikurs_kleister_cue1.png',
      },
      {
        timestamp_percent: 78,
        prompt: 'Gegenüberstellung im Makro-Detail: links transparenter Tapetenkleister, rechts weißer Holzleim',
        transition: 'fade',
        image_url: '/images/minikurs_kleister_cue2.png',
      },
    ],
    audio_url: '/audio/minikurs_kleister.mp3',
  };

  const contentPayload = {
    slides: [slide1],
    teleprompter_script: slide1.narration,
    text_content: (
      '# Kleisterarten & Verarbeitung im Handwerk\n\n' +
      'Die richtige Wahl des Klebstoffs ist im Handwerk die wichtigste Grundlage für saubere, dauerhafte Ergebnisse.\n\n' +
      '## 1. Tapetenkleister (Methylcellulose)\n' +
      '- Pulverförmig, wird mit kaltem Wasser klumpenfrei angerührt.\n' +
      '- Reversible Verbindung: Tapeten lassen sich später bei Renovierungen wieder ablösen.\n\n' +
      '## 2. Holzleim (PVAc)\n' +
      '- Weißleim auf Polyvinylacetat-Basis.\n' +
      '- Zieht tief in Holzfasern ein und bindet unter Druck extrem fest ab.\n'
    ),
    quiz: [
      {
        question: 'Welcher Klebstoff ist typischerweise reversibel und diffusionsoffen?',
        options: [
          'Methylcellulose-Tapetenkleister',
          'Polyurethan-2K-Kleber',
          'Epoxidharz-Klebstoff',
          'Heißkleber',
        ],
        correct_option_index: 0,
        explanation: 'Methylcellulose ist wasserlöslich, diffusionsoffen und ideal für Tapeten.',
      },
    ],
  };

  const [lesson] = await db.insert(lessons).values({
    moduleId: module.id,
    tenantId,
    sequenceOrder: 1,
    title: 'Kleisterarten & Verarbeitung',
    contentPayload,
    videoUrl: '/audio/minikurs_kleister.mp3',
  }).returning();

  console.log(`Created Lesson: ${lesson.title} (ID: ${lesson.id})`);
  console.log(`\n🎉 Minikurs erfolgreich angelegt und freigegeben!`);
  console.log(`Thema: ${course.topic}`);
  console.log(`Lektion: ${lesson.title} mit genau 1 Folie und 3 fotorealistischen Bildwechseln.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error seeding minikurs:', err);
  process.exit(1);
});
