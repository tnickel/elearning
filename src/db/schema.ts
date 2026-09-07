import { pgTable, uuid, text, integer, timestamp, jsonb, customType, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Custom pgvector type — 384 dims match local all-MiniLM-L6-v2 (no zero-padding).
// Remote providers must request the same dimension or fail cleanly.
export const EMBEDDING_DIMENSIONS = 384;
export const pgVector384 = customType<{ data: number[] }>({
  dataType() {
    return 'vector(384)';
  },
  toDriver(value: number[]): string {
    if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Vector must be an array of length ${EMBEDDING_DIMENSIONS}. Got ${value ? value.length : 'null'}`);
    }
    return `[${value.join(',')}]`;
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === 'string') {
      return value.slice(1, -1).split(',').map(Number);
    }
    return value as number[];
  }
});

// 1. Users Table
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['student', 'admin', 'system'] }).notNull().default('student'),
  tenantId: uuid('tenant_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Relations for Users
export const usersRelations = relations(users, ({ many }) => ({
  courses: many(courses),
  activityLogs: many(activityLogs),
}));

// 2. Courses Table
export const courses = pgTable('courses', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull(),
  status: text('status', { enum: ['curriculum_draft', 'content_draft', 'generating', 'pending_approval', 'active', 'failed'] }).notNull().default('curriculum_draft'),
  topic: text('topic').notNull(),
  progress: jsonb('progress'), // contains { percent: number, step: string }
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Relations for Courses
export const coursesRelations = relations(courses, ({ one, many }) => ({
  user: one(users, {
    fields: [courses.userId],
    references: [users.id],
  }),
  modules: many(modules),
}));

// 3. Modules Table
export const modules = pgTable('modules', {
  id: uuid('id').defaultRandom().primaryKey(),
  courseId: uuid('course_id').references(() => courses.id, { onDelete: 'cascade' }).notNull(),
  sequenceOrder: integer('sequence_order').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  courseIdx: index('modules_course_id_idx').on(t.courseId),
}));

// Relations for Modules
export const modulesRelations = relations(modules, ({ one, many }) => ({
  course: one(courses, {
    fields: [modules.courseId],
    references: [courses.id],
  }),
  lessons: many(lessons),
}));

// 4. Lessons Table
export const lessons = pgTable('lessons', {
  id: uuid('id').defaultRandom().primaryKey(),
  moduleId: uuid('module_id').references(() => modules.id, { onDelete: 'cascade' }).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  sequenceOrder: integer('sequence_order').notNull().default(0), // stable order inside a module (createdAt ties inside one tx)
  title: text('title').notNull(),
  contentPayload: jsonb('content_payload').notNull(), // contains teleprompter script, text, quiz
  videoUrl: text('video_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  moduleIdx: index('lessons_module_id_idx').on(t.moduleId),
}));

// Relations for Lessons
export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  module: one(modules, {
    fields: [lessons.moduleId],
    references: [modules.id],
  }),
  embeddings: many(embeddings),
}));

// 5. Embeddings Table (Vektortabelle für RAG mit RLS)
export const embeddings = pgTable('embeddings', {
  id: uuid('id').defaultRandom().primaryKey(),
  lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'cascade' }).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  embedding: pgVector384('embedding').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  lessonIdx: index('embeddings_lesson_id_idx').on(t.lessonId),
}));

// Relations for Embeddings
export const embeddingsRelations = relations(embeddings, ({ one }) => ({
  lesson: one(lessons, {
    fields: [embeddings.lessonId],
    references: [lessons.id],
  }),
}));

// 6. ActivityLogs Table (SHA-256 manipulationssichere Kette)
export const activityLogs = pgTable('activity_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  sessionId: text('session_id').notNull(),
  durationSec: integer('duration_sec').notNull(),
  cryptoHash: text('crypto_hash').notNull(),
  previousHash: text('previous_hash').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index('activity_logs_session_id_timestamp_idx').on(t.sessionId, t.timestamp),
  userIdx: index('activity_logs_user_id_idx').on(t.userId),
}));

// Relations for ActivityLogs
export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
}));
