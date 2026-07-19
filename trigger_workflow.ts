import { db } from './src/db';
import { courses, users } from './src/db/schema';
import { Connection, Client } from '@temporalio/client';

async function run() {
  try {
    const allUsers = await db.select().from(users);
    console.log('Available users in DB:', allUsers.map(u => `${u.email} (${u.role})`));
    
    const adminUser = allUsers[0];
    if (!adminUser) {
      console.error('No users found in database.');
      process.exit(1);
    }

    const topic = 'docker-test-1';
    const [course] = await db.insert(courses).values({
      userId: adminUser.id,
      tenantId: adminUser.tenantId,
      topic,
      status: 'generating',
    }).returning();

    console.log(`Inserted course ${course.id} for user ${adminUser.email}. Starting workflow...`);

    const connection = await Connection.connect({
      address: 'localhost:7233',
    });
    const client = new Client({ connection });

    const handle = await client.workflow.start('CourseGenerationWorkflow', {
      taskQueue: 'elearning-tasks',
      workflowId: `course-gen-${course.id}`,
      args: [{
        courseId: course.id,
        userId: adminUser.id,
        tenantId: adminUser.tenantId,
        topic,
        duration: 'crash_course',
      }],
    });

    console.log(`Workflow started. WorkflowId: ${handle.workflowId}`);
  } catch (err: any) {
    console.error('Error starting workflow:', err.message);
  }
  process.exit(0);
}

run();
