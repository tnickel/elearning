import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

async function run() {
  console.log('Starting Temporal Worker...');
  
  const maxRetries = 12; // Try for up to 1 minute
  const retryIntervalMs = 5000;
  let worker: any = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const connection = await NativeConnection.connect({
        address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
      });

      worker = await Worker.create({
        workflowsPath: path.resolve(__dirname, './workflows.ts'),
        activities,
        taskQueue: process.env.TEMPORAL_QUEUE || 'elearning-tasks',
        connection,
      });
      break; // Success!
    } catch (err: any) {
      console.warn(`[Attempt ${attempt}/${maxRetries}] Temporal Server not ready yet: ${err.message}. Retrying in ${retryIntervalMs / 1000}s...`);
      if (attempt === maxRetries) {
        console.error('Failed to start Temporal Worker after maximum retries:', err);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }

  try {
    console.log('Temporal Worker successfully started and listening on task queue:', process.env.TEMPORAL_QUEUE || 'elearning-tasks');
    await worker.run();
  } catch (err) {
    console.error('Temporal Worker run encountered an error:', err);
    process.exit(1);
  }
}

run();
