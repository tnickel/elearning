import { db } from '../db';
import { activityLogs } from '../db/schema';
import { eq, desc, asc } from 'drizzle-orm';
import crypto from 'crypto';

// In-memory mutex map to serialize concurrent heartbeats per session (Befund 22)
const sessionLocks = new Map<string, Promise<any>>();

/**
 * Appends a new activity heartbeat to the user's session hash chain.
 * Computes: SHA256(UserID + "|" + SessionID + "|" + Timestamp.toISOString() + "|" + ActiveDuration + "|" + PreviousHash)
 */
export async function recordHeartbeat(
  userId: string,
  sessionId: string,
  durationSec: number
): Promise<{ cryptoHash: string; previousHash: string; timestamp: Date; durationSec: number }> {
  // Concurrency serialization per session (Befund 22)
  const prevLock = sessionLocks.get(sessionId) || Promise.resolve();
  let releaseLock: () => void = () => {};
  const currentLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  sessionLocks.set(sessionId, prevLock.then(() => currentLock));

  await prevLock;

  try {
    // 1. Fetch the last entry in the chain for this specific session
    const [lastLog] = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.sessionId, sessionId))
      .orderBy(desc(activityLogs.timestamp))
      .limit(1);

    // Enforce session user binding (prevent cross-user session spoofing)
    if (lastLog && lastLog.userId !== userId) {
      throw new Error(`Unauthorized: sessionId ${sessionId} belongs to another user.`);
    }

    // Cap duration to a reasonable maximum (positive integer up to 180s) AND to
    // the wall-clock time elapsed since the previous block (plus tolerance).
    // Without the delta check a client could claim e.g. 180s per 10s tick and
    // inflate the tracked learning time while the chain still verifies.
    let cappedDuration = Math.min(Math.max(1, Math.round(durationSec)), 180);
    if (lastLog) {
      const deltaSec = Math.max(0, (Date.now() - new Date(lastLog.timestamp).getTime()) / 1000);
      const maxPlausible = Math.floor(deltaSec) + 5; // tolerance for clock jitter/latency
      if (cappedDuration > maxPlausible) {
        cappedDuration = Math.max(1, maxPlausible);
      }
    }

    // 2. Set previous hash fallback (64 zeroes for genesis block)
    const previousHash = lastLog 
      ? lastLog.cryptoHash 
      : '0000000000000000000000000000000000000000000000000000000000000000';

    const timestamp = new Date();

    // 3. Construct payload cryptographically binding userId and compute SHA-256 hash (Befund 23)
    const hashData = `${userId}|${sessionId}|${timestamp.toISOString()}|${cappedDuration}|${previousHash}`;
    const cryptoHash = crypto.createHash('sha256').update(hashData).digest('hex');

    // 4. Save heartbeat to DB
    await db.insert(activityLogs).values({
      userId,
      sessionId,
      durationSec: cappedDuration,
      cryptoHash,
      previousHash,
      timestamp,
    });

    return { cryptoHash, previousHash, timestamp, durationSec: cappedDuration };
  } finally {
    releaseLock();
    sessionLocks.delete(sessionId);
  }
}

/**
 * Validates the cryptographic integrity of a session's activity log chain.
 * Recomputes all hashes in order and checks for insertion, deletion, or modification.
 */
export async function verifyHashChain(sessionId: string): Promise<{
  valid: boolean;
  empty?: boolean;
  tamperedIndex: number | null;
  count: number;
  totalDurationSec?: number;
  expectedHash?: string;
  actualHash?: string;
  message?: string;
}> {
  // 1. Retrieve all activity logs for this session ordered chronologically.
  //    id acts as tiebreaker so blocks written within the same millisecond
  //    still verify in their insert order.
  const logs = await db
    .select()
    .from(activityLogs)
    .where(eq(activityLogs.sessionId, sessionId))
    .orderBy(asc(activityLogs.timestamp), asc(activityLogs.id));

  if (logs.length === 0) {
    return { valid: false, empty: true, tamperedIndex: null, count: 0, message: 'Session contains no heartbeat records.' };
  }

  const sessionOwner = logs[0].userId;

  let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

  // 2. Walk the chain
  for (let i = 0; i < logs.length; i++) {
    const entry = logs[i];

    if (entry.userId !== sessionOwner) {
      console.warn(`[TIME TRACKING TAMPERED] User ID mismatch at index ${i} for session ${sessionId}.`);
      return {
        valid: false,
        tamperedIndex: i,
        count: logs.length,
        message: `User mismatch at index ${i}`,
      };
    }

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

    // Recompute the block hash including userId
    const hashData = `${entry.userId}|${entry.sessionId}|${entry.timestamp.toISOString()}|${entry.durationSec}|${entry.previousHash}`;
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

  const totalDurationSec = logs.reduce((sum, entry) => sum + entry.durationSec, 0);
  return { valid: true, tamperedIndex: null, count: logs.length, totalDurationSec };
}
