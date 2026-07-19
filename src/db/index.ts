import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as dotenv from 'dotenv';
import * as schema from './schema';
import { sql } from 'drizzle-orm';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/elearning',
});

export const db = drizzle(pool, { schema });

/**
 * Context manager that runs database operations inside a PostgreSQL transaction,
 * enforcing Row-Level Security (RLS) by setting the local `app.current_tenant_id` session variable.
 */
export async function withTenant<T>(
  tenantId: string,
  run: (tx: typeof db) => Promise<T>
): Promise<T> {
  return await db.transaction(async (tx) => {
    // Set local session variable for RLS using set_config (which supports parameters)
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    return await run(tx as any);
  });
}
