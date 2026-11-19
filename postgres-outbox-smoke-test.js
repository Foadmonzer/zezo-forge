import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { claimNextOutboxMessage, completeOutboxMessage, OUTBOX_PROVIDER_IDEMPOTENCY_WINDOW_HOURS } from './src/server/outbox-repository.js';
import { postgresOutboxSettings, processPostgresOutbox } from './src/server/outbox-worker.js';
import { closePostgresPool } from './src/server/postgres-runtime.js';
import { sendWithResend } from './src/server/resend-mail.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the isolated PostgreSQL Outbox test.');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '');
const pendingId = `synthetic_outbox_${suffix}`;
const staleId = `${pendingId}_stale`;
const retryLimitId = `${pendingId}_retry_limit`;
const sendId = `${pendingId}_send`;
const beforeCutoffId = `${pendingId}_before_cutoff`;
const otherRecipientId = `${pendingId}_other_recipient`;
const adminId = `${pendingId}_admin`;
const expiredId = `${pendingId}_expired`;
const financialId = `${pendingId}_financial`;
const scopedRows = [sendId, beforeCutoffId, otherRecipientId, adminId, expiredId, financialId];
const createdRows = [pendingId, staleId, retryLimitId, ...scopedRows];

await client.connect();
try {
  const payload = id => ({ id, to: 'synthetic@example.test', recipientType: 'direct', subject: 'Synthetic outbox test', text: 'No email is sent by this test.', kind: 'test' });
  for (const id of [pendingId, staleId, retryLimitId]) {
    await client.query(
      'INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt") VALUES ($1, $2, $3, 0, $4::jsonb, NOW(), NOW())',
      [id, 'synthetic@example.test', 'pending', JSON.stringify(payload(id))]
    );
  }

  const first = await claimNextOutboxMessage({ messageIds: [pendingId] });
  assert.equal(first?.id, pendingId, 'Worker did not claim the synthetic message.');
  assert.equal(first.attempts, 1);
  assert.equal(first.data.leaseToken, first.leaseToken);
  const duplicateClaim = await claimNextOutboxMessage({ messageIds: [pendingId] });
  assert.equal(duplicateClaim, null, 'A second worker claimed a message before its lease expired.');

  await client.query(
    `UPDATE outbox_messages SET data = data || jsonb_build_object(
       'lastAttemptAt', NOW()::text,
       'workerLeaseUntil', (NOW() - INTERVAL '1 second')::text
     ) WHERE id = $1`,
    [pendingId]
  );
  const restarted = await claimNextOutboxMessage({ messageIds: [pendingId] });
  assert.equal(restarted?.id, pendingId, 'Expired worker lease was not recovered.');
  assert.equal(restarted.attempts, 2);
  assert.equal(restarted.id, first.id, 'Retry changed the stable provider idempotency key.');
  assert.notEqual(restarted.leaseToken, first.leaseToken, 'Retry reused the stale lease token.');
  assert.equal(await completeOutboxMessage(pendingId, first.leaseToken, { state: 'sent', providerId: 'wrong-worker' }), null,
    'A stale worker was allowed to finish another worker’s lease.');
  const sent = await completeOutboxMessage(pendingId, restarted.leaseToken, { state: 'sent', providerId: 'synthetic-provider-id' });
  assert.equal(sent?.state, 'sent');
  assert.equal(sent.data.providerId, 'synthetic-provider-id');
  assert.equal(await claimNextOutboxMessage({ messageIds: [pendingId] }), null, 'A sent message was claimed again.');

  await client.query(
    `UPDATE outbox_messages SET state = 'sending', attempts = 1, data = data || jsonb_build_object(
       'lastAttemptAt', (NOW() - (($2::int + 1) * INTERVAL '1 hour'))::text,
       'workerLeaseUntil', (NOW() - INTERVAL '1 second')::text,
       'leaseToken', 'expired-synthetic-token'
     ) WHERE id = $1`,
    [staleId, OUTBOX_PROVIDER_IDEMPOTENCY_WINDOW_HOURS]
  );
  assert.equal(await claimNextOutboxMessage({ messageIds: [staleId] }), null, 'An ambiguous send outside the provider idempotency window was resent.');
  const uncertain = await client.query('SELECT state, data ->> \'lastError\' AS "lastError" FROM outbox_messages WHERE id = $1', [staleId]);
  assert.equal(uncertain.rows[0]?.state, 'uncertain');
  assert.match(uncertain.rows[0]?.lastError || '', /uncertain/i);

  await client.query(
    `UPDATE outbox_messages SET state = 'sending', attempts = 5, data = data || jsonb_build_object(
       'lastAttemptAt', NOW()::text,
       'workerLeaseUntil', (NOW() - INTERVAL '1 second')::text,
       'leaseToken', 'retry-limit-synthetic-token'
     ) WHERE id = $1`,
    [retryLimitId]
  );
  assert.equal(await claimNextOutboxMessage({ messageIds: [retryLimitId] }), null, 'A message at its retry limit was sent again after a worker restart.');
  const retryLimited = await client.query('SELECT state, data ->> \'lastError\' AS "lastError" FROM outbox_messages WHERE id = $1', [retryLimitId]);
  assert.equal(retryLimited.rows[0]?.state, 'uncertain');
  assert.match(retryLimited.rows[0]?.lastError || '', /retry limit/i);

  const testRecipient = `synthetic-${suffix}@example.test`;
  const scopedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ZEZO_ENABLE_EMAIL_DELIVERY: 'true',
    ZEZO_OUTBOX_WORKER_ENABLED: 'true',
    ZEZO_EMAIL_QUEUE_ACTIVE_SINCE: new Date(Date.now() - 60_000).toISOString(),
    ZEZO_EMAIL_TEST_RECIPIENT: testRecipient.toUpperCase(),
    ZEZO_NOTIFICATION_EMAIL: 'synthetic-admin@example.test',
    ZEZO_FROM_EMAIL: 'Example <sender@example.test>',
    RESEND_API_KEY: 'synthetic-local-only-provider-key'
  };
  assert.equal(postgresOutboxSettings({ ...scopedEnv, ZEZO_STAGING: 'true' }), null);
  assert.equal(postgresOutboxSettings({ ...scopedEnv, ZEZO_EMAIL_QUEUE_ACTIVE_SINCE: '' }), null);
  assert.equal(postgresOutboxSettings({ ...scopedEnv, ZEZO_EMAIL_TEST_RECIPIENT: 'not-an-address' }), null);
  assert.equal(postgresOutboxSettings(scopedEnv)?.allowAdmin, false);

  for (const id of scopedRows) {
    const queueItem = { ...payload(id), to: id === otherRecipientId ? 'someone-else@example.test' : testRecipient };
    if (id === adminId) queueItem.recipientType = 'admin';
    if (id === financialId) queueItem.kind = 'withdrawal_requested';
    if (id === expiredId) {
      queueItem.kind = 'team_invitation';
      queueItem.expiresAt = new Date(Date.now() - 1000).toISOString();
    }
    await client.query(`
      INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
      VALUES ($1, $2, 'pending', 0, $3::jsonb, NOW() - ($4 * INTERVAL '1 hour'), NOW())
    `, [id, queueItem.to, JSON.stringify(queueItem), id === beforeCutoffId ? 2 : 0]);
  }

  const sentKeys = [];
  const stubFetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(JSON.parse(options.body).to, testRecipient);
    sentKeys.push(options.headers['Idempotency-Key']);
    if (sentKeys.length === 1) return Response.json({ message: 'Provider response that must never be persisted.' }, { status: 503 });
    return Response.json({ id: 'synthetic-accepted-message' }, { status: 200 });
  };
  const runWorker = () => processPostgresOutbox({ env: scopedEnv, allowedKinds: ['test', 'team_invitation'], fetchImpl: stubFetch });

  // Simulate the whole-store compatibility transaction blocking the scheduler.
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE outbox_messages IN SHARE ROW EXCLUSIVE MODE');
    assert.deepEqual(await runWorker(), { processed: 0, sent: 0, retry: 0, failed: 0, uncertain: 0, deferred: 'claim' });
    assert.deepEqual(sentKeys, []);
    const unclaimed = await client.query('SELECT state, attempts FROM outbox_messages WHERE id = $1', [sendId]);
    assert.deepEqual(unclaimed.rows[0], { state: 'pending', attempts: 0 });
  } finally {
    await client.query('ROLLBACK');
  }

  assert.deepEqual(await runWorker(), { processed: 1, sent: 0, retry: 1, failed: 0, uncertain: 0 });
  assert.deepEqual(await runWorker(), { processed: 0, sent: 0, retry: 0, failed: 0, uncertain: 0 });
  const retried = await client.query('SELECT state, data FROM outbox_messages WHERE id = $1', [sendId]);
  assert.equal(retried.rows[0]?.state, 'retry');
  assert.equal(retried.rows[0]?.data?.deliveryUncertain, true);
  assert.equal(retried.rows[0]?.data?.lastError, 'Email provider rejected the request (HTTP 503).');
  await client.query(`UPDATE outbox_messages SET data = data || jsonb_build_object('retryAt', (NOW() - INTERVAL '1 minute')::text) WHERE id = $1`, [sendId]);
  const batches = await Promise.all([runWorker(), runWorker()]);
  assert.equal(batches.reduce((total, batch) => total + batch.sent, 0), 1);
  assert.deepEqual(sentKeys, [sendId, sendId]);
  const finalStates = await client.query('SELECT id, state FROM outbox_messages WHERE id = ANY($1::text[])', [scopedRows]);
  assert.deepEqual(Object.fromEntries(finalStates.rows.map(row => [row.id, row.state])), {
    [sendId]: 'sent', [beforeCutoffId]: 'pending', [otherRecipientId]: 'pending', [adminId]: 'pending', [expiredId]: 'failed', [financialId]: 'pending'
  });
  await assert.rejects(sendWithResend({
    to: testRecipient, subject: 'Synthetic check', text: 'No live email', idempotencyKey: sendId, env: scopedEnv,
    fetchImpl: async () => Response.json({ unrelated: 'value' }, { status: 200 })
  }), error => error.uncertain && error.retryable && error.message === 'Email provider acceptance could not be verified.');

  const completionId = `${pendingId}_completion_lock`;
  createdRows.push(completionId);
  await client.query(`
    INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
    VALUES ($1, $2, 'pending', 0, $3::jsonb, NOW(), NOW())
  `, [completionId, testRecipient, JSON.stringify({ ...payload(completionId), to: testRecipient })]);
  const completionKeys = [];
  const providerId = 'synthetic-accepted-before-lock';
  const accept = async (_, options) => {
    completionKeys.push(options.headers['Idempotency-Key']);
    if (completionKeys.length === 1) {
      await client.query('BEGIN');
      await client.query('LOCK TABLE outbox_messages IN SHARE ROW EXCLUSIVE MODE');
    }
    return Response.json({ id: providerId });
  };
  const runCompletionTest = () => processPostgresOutbox({ env: scopedEnv, allowedKinds: ['test'], fetchImpl: accept });
  try {
    assert.deepEqual(await runCompletionTest(), { processed: 0, sent: 0, retry: 0, failed: 0, uncertain: 0, deferred: 'completion' });
    const leased = await client.query('SELECT state, attempts FROM outbox_messages WHERE id = $1', [completionId]);
    assert.deepEqual(leased.rows[0], { state: 'sending', attempts: 1 });
  } finally {
    await client.query('ROLLBACK');
  }
  await client.query(`UPDATE outbox_messages SET data = data || jsonb_build_object('workerLeaseUntil', (NOW() - INTERVAL '1 minute')::text) WHERE id = $1`, [completionId]);
  assert.equal((await runCompletionTest()).sent, 1);
  assert.deepEqual(completionKeys, [completionId, completionId]);

  console.log('PASS PostgreSQL Outbox claim is atomic and lease protected');
  console.log('PASS worker restart recovers an expired lease while preserving the provider idempotency key');
  console.log('PASS stale worker completion is rejected and sent messages are not reclaimed');
  console.log('PASS ambiguous sends outside the provider idempotency window fail closed for manual review');
  console.log('PASS an ambiguous fifth attempt also fails closed instead of remaining stuck or being resent');
  console.log('PASS retry backoff, stable idempotency, provider acceptance, and cutoff/recipient restrictions');
  console.log('PASS a busy table defers claims and completions without losing the lease or changing the provider idempotency key');
  console.log('PASS no external email provider was called; all addresses and responses were synthetic');
} finally {
  await client.query('DELETE FROM outbox_messages WHERE id = ANY($1::text[])', [createdRows]).catch(() => {});
  await client.end();
  await closePostgresPool();
}
