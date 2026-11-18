import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePostgresPool, withPostgresScopedTransaction, withPostgresTransaction } from '../src/server/postgres-runtime.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the isolated PostgreSQL lock regression test.');

const suffix = randomUUID().replaceAll('-', '');
const poolClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
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

function metrics(values) {
  return { samples: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: Number(Math.max(...values).toFixed(2)) };
}

async function insertAudit(id) {
  createdIds.push(id);
  return withPostgresScopedTransaction(client => client.query(`
    INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
    VALUES ($1, NULL, 'issue7_synthetic_concurrency', NULL, $2::jsonb, NOW())
  `, [id, JSON.stringify({ synthetic: true, suite: 'issue7' })]));
}

async function holdPriorLegacyLocks(milliseconds, snapshotId) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const entered = deferred();
  await client.connect();
  const work = (async () => {
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
      await client.query(`LOCK TABLE app_settings, user_accounts, project_requests, commissions,
        withdrawal_requests, finance_ledger_entries, system_notifications, audit_entries, outbox_messages
        IN SHARE ROW EXCLUSIVE MODE`);
      entered.resolve();
      await sleep(milliseconds);
      await client.query(`UPDATE audit_entries
        SET data = data || jsonb_build_object('snapshotPersisted', TRUE)
        WHERE id = $1`, [snapshotId]);
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

async function holdCurrentCompatibilityLocks(milliseconds, snapshotId) {
  const entered = deferred();
  const work = withPostgresTransaction(async client => {
    const snapshot = await client.query(`
      SELECT id, "actorId", action, "targetId", data, "createdAt"
      FROM audit_entries WHERE id = $1
    `, [snapshotId]);
    entered.resolve();
    await sleep(milliseconds);
    const row = snapshot.rows[0];
    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (id) DO UPDATE SET "actorId" = EXCLUDED."actorId", action = EXCLUDED.action,
        "targetId" = EXCLUDED."targetId", data = EXCLUDED.data, "createdAt" = EXCLUDED."createdAt"
    `, [row.id, row.actorId, row.action, row.targetId, JSON.stringify({ ...row.data, snapshotPersisted: true }), row.createdAt]);
  });
  await entered.promise;
  return { work };
}

async function runBatchWithHolder(hold, phase, batchNumber, writers = 10, holdMs = 180) {
  const snapshotId = `issue7_${suffix}_${phase}_${batchNumber}_snapshot`;
  createdIds.push(snapshotId);
  await poolClient.query(`
    INSERT INTO audit_entries (id, action, data, "createdAt")
    VALUES ($1, 'issue7_legacy_snapshot_seed', $2::jsonb, NOW())
  `, [snapshotId, JSON.stringify({ synthetic: true, suite: 'issue7', snapshotPersisted: false })]);
  const { work: holder } = await hold(holdMs, snapshotId);
  const start = performance.now();
  await Promise.all(Array.from({ length: writers }, (_, writer) =>
    insertAudit(`issue7_${suffix}_${phase}_${batchNumber}_${writer}`)));
  const elapsed = performance.now() - start;
  await holder;
  return elapsed;
}

await poolClient.connect();
try {
  await poolClient.query('SELECT 1');

  const priorLockBatch = [];
  const currentLockBatch = [];
  for (let iteration = 0; iteration < 10; iteration += 1) {
    priorLockBatch.push(await runBatchWithHolder(holdPriorLegacyLocks, 'before', iteration));
    currentLockBatch.push(await runBatchWithHolder(holdCurrentCompatibilityLocks, 'after', iteration));
  }

  const inserted = await poolClient.query('SELECT COUNT(*)::int AS count FROM audit_entries WHERE id LIKE $1', [`issue7_${suffix}_%`]);
  assert.equal(inserted.rows[0]?.count, 220, 'Concurrent append-only audit writes or compatibility snapshot rows were lost.');
  const persistedSnapshots = await poolClient.query("SELECT COUNT(*)::int AS count FROM audit_entries WHERE id LIKE $1 AND data->>'snapshotPersisted' = 'true'", [`issue7_${suffix}_%_snapshot`]);
  assert.equal(persistedSnapshots.rows[0]?.count, 20, 'Legacy audit upserts did not persist their snapshot state.');

  const rollbackId = `issue7_${suffix}_rollback`;
  createdIds.push(rollbackId);
  await assert.rejects(withPostgresScopedTransaction(async client => {
    await client.query(`INSERT INTO audit_entries (id, action, data, "createdAt") VALUES ($1, 'issue7_rollback', '{}'::jsonb, NOW())`, [rollbackId]);
    throw new Error('synthetic rollback sentinel');
  }), /synthetic rollback sentinel/);
  const rolledBack = await poolClient.query('SELECT COUNT(*)::int AS count FROM audit_entries WHERE id = $1', [rollbackId]);
  assert.equal(rolledBack.rows[0]?.count, 0, 'Failed scoped transactions must roll back their writes.');

  const report = {
    scenario: '10 concurrent append-only audit writes while one compatibility transaction holds its table locks for 180 ms',
    baseline_previous_lock_set: metrics(priorLockBatch),
    after_audit_lock_removal: metrics(currentLockBatch),
    audit_rows_preserved: inserted.rows[0]?.count,
    rollback_test: 'passed',
    external_messages_or_financial_rows: 0
  };
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS every synthetic audit insert committed while compatibility snapshots were active');
  console.log('PASS a failing scoped transaction rolled back its insert');
} finally {
  await poolClient.query('DELETE FROM audit_entries WHERE id = ANY($1::text[])', [createdIds]).catch(() => {});
  await poolClient.end();
  await closePostgresPool();
}
