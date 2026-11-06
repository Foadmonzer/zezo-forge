import pg from 'pg';
import { randomUUID } from 'node:crypto';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required for the PostgreSQL smoke test.');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
const makeId = (prefix) => `${prefix}-${randomUUID()}`;
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectConstraint(name, expectedCode, operation) {
  await client.query(`SAVEPOINT ${name}`);
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assert(
    failure?.code === expectedCode,
    `Expected PostgreSQL error ${expectedCode} for ${name}, received ${failure?.code ?? 'no error'}`
  );
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
}

await client.connect();

try {
  await client.query('BEGIN');

  const userId = makeId('synthetic-user');
  const requestId = makeId('synthetic-request');
  const conversationId = makeId('synthetic-conversation');

  await client.query(
    'INSERT INTO user_accounts (id, role, data, "createdAt", "updatedAt") VALUES ($1, $2, $3::jsonb, now(), now())',
    [userId, 'customer', '{}']
  );
  await client.query(
    'INSERT INTO project_requests (id, "customerId", data, "createdAt", "updatedAt") VALUES ($1, $2, $3::jsonb, now(), now())',
    [requestId, userId, '{}']
  );
  results.push('account and request relation');

  await expectConstraint('invalid_customer_fk', '23503', () =>
    client.query(
      'INSERT INTO project_requests (id, "customerId", data, "createdAt", "updatedAt") VALUES ($1, $2, $3::jsonb, now(), now())',
      [makeId('invalid-request'), makeId('missing-user'), '{}']
    )
  );
  results.push('foreign key rejects missing customer');

  await expectConstraint('invalid_project_developer_fk', '23503', () =>
    client.query(
      'INSERT INTO project_requests (id, "developerId", data, "createdAt", "updatedAt") VALUES ($1, $2, $3::jsonb, now(), now())',
      [makeId('invalid-developer-request'), makeId('missing-developer'), '{}']
    )
  );
  results.push('foreign key rejects missing project developer');

  await client.query(
    'INSERT INTO conversations (id, "customerId", status, data, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4::jsonb, now(), now())',
    [conversationId, userId, 'new', '{}']
  );
  await client.query(
    'INSERT INTO conversation_messages (id, "conversationId", "senderId", body, "createdAt") VALUES ($1, $2, $3, $4, now())',
    [makeId('synthetic-message'), conversationId, userId, 'Synthetic PostgreSQL test message']
  );
  await client.query(
    'INSERT INTO quotes (id, "conversationId", amount, state, data, "createdAt") VALUES ($1, $2, 200, $3, $4::jsonb, now())',
    [makeId('synthetic-quote'), conversationId, 'draft', '{}']
  );
  results.push('conversation, message, and quote relations');

  const idempotencyKey = makeId('payment-key');
  await client.query(
    'INSERT INTO payments (id, "requestId", amount, status, "idempotencyKey", data, "createdAt") VALUES ($1, $2, 100, $3, $4, $5::jsonb, now())',
    [makeId('synthetic-payment'), requestId, 'test', idempotencyKey, '{}']
  );
  await expectConstraint('duplicate_payment_key', '23505', () =>
    client.query(
      'INSERT INTO payments (id, "requestId", amount, status, "idempotencyKey", data, "createdAt") VALUES ($1, $2, 100, $3, $4, $5::jsonb, now())',
      [makeId('synthetic-payment'), requestId, 'test', idempotencyKey, '{}']
    )
  );
  await expectConstraint('invalid_payment_request_fk', '23503', () =>
    client.query(
      'INSERT INTO payments (id, "requestId", amount, status, data, "createdAt") VALUES ($1, $2, 100, $3, $4::jsonb, now())',
      [makeId('invalid-payment'), makeId('missing-payment-request'), 'synthetic', '{}']
    )
  );
  results.push('payment idempotency key uniqueness');

  const commission = [makeId('synthetic-commission'), userId, requestId, 'marketing', 15, 15, 'pending', '{}'];
  await client.query(
    'INSERT INTO commissions (id, "userId", "requestId", kind, "ratePercent", amount, status, data, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())',
    commission
  );
  await expectConstraint('duplicate_commission', '23505', () =>
    client.query(
      'INSERT INTO commissions (id, "userId", "requestId", kind, "ratePercent", amount, status, data, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())',
      [makeId('synthetic-commission'), userId, requestId, 'marketing', 15, 15, 'pending', '{}']
    )
  );
  await expectConstraint('invalid_commission_request_fk', '23503', () =>
    client.query(
      'INSERT INTO commissions (id, "userId", "requestId", kind, "ratePercent", amount, status, data, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())',
      [makeId('invalid-commission'), userId, makeId('missing-commission-request'), 'marketing', 15, 15, 'pending', '{}']
    )
  );
  results.push('commission deduplication uniqueness');

  await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
  const dependents = await client.query(
    'SELECT (SELECT count(*) FROM conversation_messages WHERE "conversationId" = $1) + (SELECT count(*) FROM quotes WHERE "conversationId" = $1) AS count',
    [conversationId]
  );
  assert(Number(dependents.rows[0].count) === 0, 'Conversation child rows were not cascaded.');
  results.push('conversation child cascade');

  await client.query('ROLLBACK');
  results.push('synthetic fixture rollback');
  for (const result of results) console.log(`PASS ${result}`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
