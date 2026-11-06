import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { claimNextOutboxMessage, completeOutboxMessage, OUTBOX_PROVIDER_IDEMPOTENCY_WINDOW_HOURS } from './src/server/outbox-repository.js';
import { closePostgresPool } from './src/server/postgres-runtime.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the isolated PostgreSQL Outbox test.');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '');
const pendingId = `synthetic_outbox_${suffix}`;
const staleId = `${pendingId}_stale`;
const retryLimitId = `${pendingId}_retry_limit`;
const createdRows = [pendingId, staleId, retryLimitId];

await client.connect();
try {
  const payload = id => ({ id, to: 'synthetic@example.test', recipientType: 'direct', subject: 'Synthetic outbox test', text: 'No email is sent by this test.', kind: 'test' });
  for (const id of createdRows) {
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

  console.log('PASS PostgreSQL Outbox claim is atomic and lease protected');
  console.log('PASS worker restart recovers an expired lease while preserving the provider idempotency key');
  console.log('PASS stale worker completion is rejected and sent messages are not reclaimed');
  console.log('PASS ambiguous sends outside the provider idempotency window fail closed for manual review');
  console.log('PASS an ambiguous fifth attempt also fails closed instead of remaining stuck or being resent');
  console.log('PASS no email provider was called; all messages and addresses were synthetic');
} finally {
  await client.query('DELETE FROM outbox_messages WHERE id = ANY($1::text[])', [createdRows]).catch(() => {});
  await client.end();
  await closePostgresPool();
}
