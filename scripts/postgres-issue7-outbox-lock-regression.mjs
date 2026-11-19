import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { closePostgresPool, withPostgresTransaction } from '../src/server/postgres-runtime.js';
import { claimNextOutboxMessage, completeOutboxMessage } from '../src/server/outbox-repository.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL lock regression.');

const { Client, Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '');
const holdMs = 200;
const createdIds = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

async function insertMessage(id) {
  createdIds.push(id);
  await pool.query(`
    INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
    VALUES ($1, 'issue7-test@example.invalid', 'pending', 0, $2::jsonb, NOW(), NOW())
  `, [id, JSON.stringify({ kind: 'issue7_synthetic_lock_test', recipientType: 'direct', to: 'issue7-test@example.invalid' })]);
}

async function holdGlobalAndUnrelatedTableLocks() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const entered = deferred();
  await client.connect();
  const work = (async () => {
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
      // Mirror the beginning of the legacy whole-store lock sequence and stop
      // before its final outbox_messages lock. A scoped outbox worker should not
      // wait behind unrelated company-state locks or the global advisory queue.
      await client.query(`LOCK TABLE app_settings, user_accounts, project_requests, commissions,
        withdrawal_requests, finance_ledger_entries, system_notifications
        IN SHARE ROW EXCLUSIVE MODE`);
      entered.resolve();
      await sleep(holdMs);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  })();
  await entered.promise;
  return { work };
}

async function legacyClaim(id) {
  return withPostgresTransaction(async client => {
    const leaseToken = randomUUID();
    const result = await client.query(`
      WITH candidate AS (
        SELECT id FROM outbox_messages WHERE id = $1 AND state = 'pending' FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_messages AS message
      SET state = 'sending', attempts = message.attempts + 1,
          data = message.data || jsonb_build_object('leaseToken', $2::text), "updatedAt" = NOW()
      FROM candidate WHERE message.id = candidate.id
      RETURNING message.id, message.state, message.data
    `, [id, leaseToken]);
    return { row: result.rows[0] || null, leaseToken };
  });
}

async function sampleClaim(phase, iteration) {
  const id = `issue7_outbox_${suffix}_${phase}_${iteration}`;
  await insertMessage(id);
  const { work: holder } = await holdGlobalAndUnrelatedTableLocks();
  const start = performance.now();
  let claimed;
  if (phase === 'before') {
    claimed = await legacyClaim(id);
  } else {
    const row = await claimNextOutboxMessage({ messageIds: [id] });
    claimed = { row, leaseToken: row?.leaseToken };
  }
  const elapsed = performance.now() - start;
  await holder;
  assert.ok(claimed.row, `Synthetic outbox message was not claimed in ${phase} sample ${iteration}.`);
  if (phase === 'after') {
    const completed = await completeOutboxMessage(id, claimed.leaseToken, { state: 'failed', lastError: 'Synthetic lock regression cleanup.' });
    assert.ok(completed, 'Only the current lease owner may complete the synthetic message.');
  }
  await pool.query('DELETE FROM outbox_messages WHERE id = $1', [id]);
  createdIds.pop();
  return elapsed;
}

await pool.query('SELECT 1');
try {
  const before = [];
  const after = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    before.push(await sampleClaim('before', iteration));
    after.push(await sampleClaim('after', iteration));
  }

  const result = {
    scenario: 'Outbox claims while the legacy global advisory queue and unrelated company table locks are held',
    blocker_ms: holdMs,
    legacy_global_transaction: { samples: before.length, p50_ms: percentile(before, 0.5), p95_ms: percentile(before, 0.95) },
    scoped_outbox_transaction: { samples: after.length, p50_ms: percentile(after, 0.5), p95_ms: percentile(after, 0.95) },
    synthetic_messages_sent: 0
  };
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.legacy_global_transaction.p50_ms >= holdMs * 0.8, 'Baseline did not wait on the simulated legacy lock holder.');
  assert.ok(result.scoped_outbox_transaction.p95_ms < holdMs, 'Scoped outbox claims still wait for unrelated global locks.');
  console.log('PASS scoped outbox claim bypasses the global queue while retaining the outbox table compatibility lock');
} finally {
  await pool.query('DELETE FROM outbox_messages WHERE id = ANY($1::text[])', [createdIds]).catch(() => {});
  await pool.end();
  await closePostgresPool();
}
