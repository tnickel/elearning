import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { and, eq } from 'drizzle-orm';
import { inList, withTenant } from '../src/db';
import { courses, lessons, modules } from '../src/db/schema';

dotenv.config();

const TENANT_ID = process.env.COURSE_TENANT_ID || 'de305d54-75b4-431b-adb2-eb6b9e546014';
const COURSE_TITLE = 'LLM-Grundlagen: Verstehen, prompten, sicher anwenden';

async function main() {
  const result = await withTenant(TENANT_ID, async (tx) => {
    const [course] = await tx
      .select()
      .from(courses)
      .where(and(eq(courses.topic, COURSE_TITLE), eq(courses.tenantId, TENANT_ID)))
      .limit(1);

    if (!course) throw new Error(`Course "${COURSE_TITLE}" not found.`);

    const courseModules = await tx
      .select()
      .from(modules)
      .where(eq(modules.courseId, course.id))
      .orderBy(modules.sequenceOrder);

    const moduleIds = courseModules.map((module) => module.id);
    const courseLessons = moduleIds.length
      ? await tx.select().from(lessons).where(inList(lessons.moduleId, moduleIds))
      : [];

    return { course, courseModules, courseLessons };
  });

  const errors: string[] = [];
  let totalMinutes = 0;
  let totalSlides = 0;
  let totalQuizQuestions = 0;
  let totalScriptWords = 0;
  let totalExercises = 0;

  if (result.course.status !== 'content_draft') {
    errors.push(`Expected status content_draft, got ${result.course.status}.`);
  }
  if (result.courseModules.length !== 5) {
    errors.push(`Expected 5 modules, got ${result.courseModules.length}.`);
  }
  if (result.courseLessons.length !== 10) {
    errors.push(`Expected 10 lessons, got ${result.courseLessons.length}.`);
  }

  const moduleOrders = result.courseModules.map((module) => module.sequenceOrder);
  if (moduleOrders.join(',') !== '1,2,3,4,5') {
    errors.push(`Unexpected module order: ${moduleOrders.join(',')}.`);
  }

  for (const lesson of result.courseLessons) {
    const payload = lesson.contentPayload as any;
    const lessonSlides = payload.slides || [];
    const lessonQuiz = payload.quiz || [];
    const scriptParagraphs = String(payload.teleprompter_script || '')
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const scriptWords = String(payload.teleprompter_script || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    totalMinutes += payload.estimated_duration_minutes || 0;
    totalSlides += lessonSlides.length;
    totalQuizQuestions += lessonQuiz.length;
    totalScriptWords += scriptWords;
    if (payload.exercise) totalExercises += 1;

    if (lesson.videoUrl !== null) {
      errors.push(`${lesson.title}: videoUrl must be null before narration.`);
    }
    if (lessonSlides.length !== 4) {
      errors.push(`${lesson.title}: expected 4 slides, got ${lessonSlides.length}.`);
    }
    if (scriptParagraphs.length !== lessonSlides.length) {
      errors.push(
        `${lesson.title}: ${scriptParagraphs.length} script paragraphs for ${lessonSlides.length} slides.`,
      );
    }
    if (lessonQuiz.length !== 3) {
      errors.push(`${lesson.title}: expected 3 quiz questions, got ${lessonQuiz.length}.`);
    }
    if (
      !payload.exercise?.task ||
      !payload.exercise?.deliverable ||
      !payload.exercise?.solution_outline
    ) {
      errors.push(`${lesson.title}: incomplete exercise structure.`);
    }

    for (const slide of lessonSlides) {
      if (!['bullets', 'mermaid', 'code'].includes(slide.layout)) {
        errors.push(`${lesson.title}: unsupported slide layout "${slide.layout}".`);
      }
      if (slide.layout === 'bullets' && (slide.bullets || []).length > 4) {
        errors.push(`${lesson.title}: slide "${slide.title}" has more than 4 bullets.`);
      }
      if (slide.layout === 'mermaid' && !slide.mermaid_code) {
        errors.push(`${lesson.title}: slide "${slide.title}" has no Mermaid code.`);
      }
      if (slide.layout === 'code' && (!slide.code_language || !slide.code_snippet)) {
        errors.push(`${lesson.title}: slide "${slide.title}" has incomplete code data.`);
      }
      if (slide.image_url) {
        const imagePath = path.join(
          process.cwd(),
          'public',
          String(slide.image_url).replace(/^\//, ''),
        );
        if (!fs.existsSync(imagePath)) {
          errors.push(`${lesson.title}: image does not exist: ${slide.image_url}.`);
        }
      }
    }

    for (const question of lessonQuiz) {
      if (!Array.isArray(question.options) || question.options.length !== 4) {
        errors.push(`${lesson.title}: quiz question must have exactly 4 options.`);
      }
      if (
        !Number.isInteger(question.correct_option_index) ||
        question.correct_option_index < 0 ||
        question.correct_option_index > 3
      ) {
        errors.push(`${lesson.title}: invalid correct_option_index.`);
      }
      if (!question.explanation) {
        errors.push(`${lesson.title}: quiz explanation is missing.`);
      }
    }
  }

  if (totalMinutes !== 60) errors.push(`Expected 60 minutes, got ${totalMinutes}.`);
  if (totalSlides !== 40) errors.push(`Expected 40 slides, got ${totalSlides}.`);
  if (totalExercises !== 10) errors.push(`Expected 10 exercises, got ${totalExercises}.`);
  if (totalQuizQuestions !== 30) {
    errors.push(`Expected 30 quiz questions, got ${totalQuizQuestions}.`);
  }

  const summary = {
    courseId: result.course.id,
    status: result.course.status,
    modules: result.courseModules.length,
    lessons: result.courseLessons.length,
    durationMinutes: totalMinutes,
    slides: totalSlides,
    exercises: totalExercises,
    quizQuestions: totalQuizQuestions,
    scriptWords: totalScriptWords,
    estimatedNarrationMinutesAt110Wpm: Number((totalScriptWords / 110).toFixed(1)),
    lessonsWithMediaUrl: result.courseLessons.filter((lesson) => lesson.videoUrl).length,
    errors,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(errors.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[validate-llm-basics-course] Failed:', error);
  process.exit(1);
});
