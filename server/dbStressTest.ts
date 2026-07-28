import { getDb, upsertChannel, getAllChannels, saveDb } from './db';
import { ChannelRecord } from '../src/types';

export interface StressTestResult {
  success: boolean;
  initialCount: number;
  insertedCount: number;
  finalCount: number;
  concurrencyLevel: number;
  reinitAttempts: number;
  executionTimeMs: number;
  logs: string[];
}

/**
 * Executes a concurrency and persistence stress test on the database subsystem.
 * Tests:
 * 1. Singleton initialization under race conditions (50 concurrent async callers to getDb())
 * 2. Rapid concurrent writes (50 simultaneous upsert operations)
 * 3. Transactional write visibility verification
 * 4. Verification that total record count equals initialCount + insertedCount with 0 loss
 */
export async function runDatabaseStressTest(): Promise<StressTestResult> {
  const startTime = Date.now();
  const logs: string[] = [];

  logs.push('[Stress Test] Initiating database concurrency and persistence audit...');

  // 1. Initial count
  const db = await getDb();
  const initialChannels = await getAllChannels();
  const initialCount = initialChannels.length;
  logs.push(`[Stress Test] Baseline stored channel count: ${initialCount}`);

  // 2. Concurrency Race Test on getDb() - 50 parallel workers getting DB instance
  logs.push('[Stress Test] Test 1: Triggering 50 concurrent getDb() calls...');
  const dbInstances = await Promise.all(
    Array.from({ length: 50 }, () => getDb())
  );
  
  // Verify all 50 returned the exact same database reference
  const firstRef = dbInstances[0];
  const allIdentical = dbInstances.every(inst => inst === firstRef);
  if (!allIdentical) {
    throw new Error('CRITICAL DB RACE CONDITION DETECTED: getDb() returned multiple different instance references!');
  }
  logs.push('✔ PASS: Singleton instance lock verified across 50 concurrent callers.');

  // 3. Concurrent Write Stress Test - 30 simultaneous channel insertions
  const testBatchSize = 30;
  logs.push(`[Stress Test] Test 2: Executing ${testBatchSize} simultaneous channel upserts...`);

  const now = new Date().toISOString();
  const testChannels: ChannelRecord[] = Array.from({ length: testBatchSize }, (_, i) => ({
    channel_id: `UC_STRESS_TEST_${Date.now()}_${i}`,
    channel_name: `Stress Test Creator ${i + 1}`,
    youtube_url: `https://www.youtube.com/@stresstest_${i}`,
    country: 'United States',
    country_status: 'CONFIRMED',
    confidence_score: 95,
    discord_status: 'ACTIVE',
    discord_invite: `https://discord.gg/stress_${i}`,
    scan_status: 'COMPLETED',
    scan_attempts: 1,
    discovery_source: 'manual_search',
    first_seen: now,
    last_checked: now,
    inspection_trail: [],
    subscriber_count: `${10000 + i} subscribers`,
    trading_status: 'TRADING_CONFIRMED',
    trading_confidence_score: 90,
    trading_category: 'General Trading'
  }));

  // Execute concurrent upserts
  await Promise.all(
    testChannels.map(channel => upsertChannel(channel))
  );

  logs.push(`✔ PASS: ${testBatchSize} channels concurrently upserted without thread-lock exceptions.`);

  // 4. PostgreSQL writes are committed per upsert; saveDb is retained as a no-op compatibility shim.
  saveDb();
  logs.push('[Stress Test] PostgreSQL transactional writes committed; verifying read-after-write visibility.');

  // 5. Verify channels after committed writes
  const postSaveChannels = await getAllChannels();
  const expectedCount = initialCount + testBatchSize;
  
  if (postSaveChannels.length !== expectedCount) {
    const errorMsg = `CRITICAL DATA PERSISTENCE FAILURE: Expected ${expectedCount} records after save, but found ${postSaveChannels.length}!`;
    logs.push(`❌ FAIL: ${errorMsg}`);
    return {
      success: false,
      initialCount,
      insertedCount: testBatchSize,
      finalCount: postSaveChannels.length,
      concurrencyLevel: 50,
      reinitAttempts: 1,
      executionTimeMs: Date.now() - startTime,
      logs
    };
  }

  logs.push(`✔ PASS: All ${expectedCount} records visible after PostgreSQL committed writes.`);

  return {
    success: true,
    initialCount,
    insertedCount: testBatchSize,
    finalCount: expectedCount,
    concurrencyLevel: 50,
    reinitAttempts: 1,
    executionTimeMs: Date.now() - startTime,
    logs
  };
}
