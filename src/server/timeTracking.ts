import { db } from '../db';
import { activityLogs } from '../db/schema';
import { eq, desc, asc } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * Appends a new activity heartbeat to the user's session hash chain.
 * Computes: SHA256(SessionID + "|" + Timestamp.toISOString() + "|" + ActiveDuration + "|" + PreviousHash)
 */
export async function recordHeartbeat(
  userId: string,
  sessionId: string,
  durationSec: number
): Promise<{ cryptoHash: string; previousHash: string; timestamp: Date }> {
  // 1. Fetch the last entry in the chain for this specific session
  const [lastLog] = await db
    .select()
    .from(activityLogs)
    .where(eq(activityLogs.sessionId, sessionId))
    .orderBy(desc(activityLogs.timestamp))
    .limit(1);

  // 2. Set previous hash fallback (64 zeroes for genesis block)
  const previousHash = lastLog 
    ? lastLog.cryptoHash 
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const timestamp = new Date();

  // 3. Construct payload and compute SHA-256 hash
  const hashData = `${sessionId}|${timestamp.toISOString()}|${durationSec}|${previousHash}`;
  const cryptoHash = crypto.createHash('sha256').update(hashData).digest('hex');

  // 4. Save heartbeat to DB
  await db.insert(activityLogs).values({
    userId,
    sessionId,
    durationSec,
    cryptoHash,
    previousHash,
    timestamp,
  });

  return { cryptoHash, previousHash, timestamp };
}

/**
 * Validates the cryptographic integrity of a session's activity log chain.
 * Recomputes all hashes in order and checks for insertion, deletion, or modification.
 */
export async function verifyHashChain(sessionId: string): Promise<{
  valid: boolean;
  tamperedIndex: number | null;
  count: number;
  expectedHash?: string;
  actualHash?: string;
}> {
  // 1. Retrieve all activity logs for this session ordered chronologically
  const logs = await db
    .select()
    .from(activityLogs)
    .where(eq(activityLogs.sessionId, sessionId))
    .orderBy(asc(activityLogs.timestamp));

  if (logs.length === 0) {
    return { valid: true, tamperedIndex: null, count: 0 };
  }

  let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

  // 2. Walk the chain
  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i];

    // Check if the link to the previous block is correct
    if (entry.previousHash !== expectedPrevHash) {
      console.warn(`[TIME TRACKING TAMPERED] Previous hash mismatch at index ${i} for session ${sessionId}.`);
      return {
        valid: false,
        tamperedIndex: i,
        count: logs.length,
        expectedHash: expectedPrevHash,
        actualHash: entry.previousHash,
      };
    }

    // Recompute the block hash
    const hashData = `${entry.sessionId}|${entry.timestamp.toISOString()}|${entry.durationSec}|${entry.previousHash}`;
    const computedHash = crypto.createHash('sha256').update(hashData).digest('hex');

    // Check if the computed hash matches the stored hash
    if (entry.cryptoHash !== computedHash) {
      console.warn(`[TIME TRACKING TAMPERED] Block hash mismatch at index ${i} for session ${sessionId}.`);
      return {
        valid: false,
        tamperedIndex: i,
        count: logs.length,
        expectedHash: computedHash,
        actualHash: entry.cryptoHash,
      };
    }

    // Advance previous hash pointer
    expectedPrevHash = entry.cryptoHash;
  }

  return { valid: true, tamperedIndex: null, count: logs.length };
}
