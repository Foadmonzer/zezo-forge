import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { handle } from '../server.js';
import { closePostgresPool } from '../src/server/postgres-runtime.js';

const database = new URL(process.env.DATABASE_URL || 'postgresql://localhost/');
assert(['127.0.0.1', 'localhost', 'postgres'].includes(database.hostname) &&
  /^(?:zezo_ci|zezo_platform|zezo_[a-z0-9_]*test[a-z0-9_]*)$/.test(database.pathname.slice(1)), 'Use an isolated local or CI database.');
assert.notEqual(process.env.ZEZO_STAGING, 'true', 'Run this test against the isolated test runtime.');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
const sha256 = input => createHash('sha256').update(input).digest('hex');
const accounts = {};
const projects = [];
const chats = [];
const address = `fd00:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}:${suffix.slice(8, 12)}::1`;

async function createAccount(name, role, data = {}) {
  const id = `feedback_${name}_${suffix}`;
  const session = randomUUID();
  await db.query(`INSERT INTO user_accounts (id, username, email, "fullName", role, active, data, "createdAt", "updatedAt")
    VALUES ($1, $1, $1 || '@example.test', $1, $2, TRUE, $3::jsonb, NOW(), NOW())`, [id, role, JSON.stringify(data)]);
  accounts[name] = { id, session };
  await db.query(`INSERT INTO auth_sessions (id, "userId", "expiresAt", data, "createdAt")
    VALUES ($1, $2, NOW() + INTERVAL '1 hour', '{}'::jsonb, NOW())`, [sha256(session), id]);
}

async function createProject(name, ownership, status = 'completed', stage = 'completed', delivered = true) {
  const id = `lead_${name}_${suffix}`;
  const data = { name: 'Private fixture title', service: 'web', ...(delivered ? { projectDeliveredAt: new Date().toISOString() } : {}) };
  await db.query(`INSERT INTO project_requests (id, "customerId", status, "projectStage", data, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())`, [id, accounts[ownership].id, status, stage, JSON.stringify(data)]);
  projects.push(id);
  return id;
}

async function request(method, path, account, body, extraHeaders = {}) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(raw);
  req.method = method;
  req.url = path;
  req.headers = { host: 'example.test', 'content-type': 'application/json', ...extraHeaders };
  if (account) req.headers.cookie = `zezo_session=${accounts[account].session}`;
  req.socket = { remoteAddress: address, encrypted: false };
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(bytes) { this.data = JSON.parse(bytes); }
  };
  await handle(req, res);
  return res;
}

try {
  await db.connect();
  await createAccount('client', 'client');
  await createAccount('other', 'client');
  await createAccount('owner', 'admin', { mfaEnabledAt: new Date().toISOString() });
  await createAccount('ownerWithoutMfa', 'admin');
  await createAccount('staff', 'order_manager', { mfaEnabledAt: new Date().toISOString() });
  await createAccount('marketer', 'marketer');

  const eligible = await createProject('completed', 'client');
  const eligibleSecond = await createProject('second', 'client');
  const completeWithoutDelivery = await createProject('undelivered', 'client', 'completed', 'completed', false);
  const active = await createProject('active', 'client', 'active', 'in_progress', false);
  const other = await createProject('foreign', 'other');
  const customerEndpoint = `/api/client/project-reviews/${eligible}`;
  const moderatorEndpoint = `/api/admin/project-reviews/${eligible}`;
  const review = { rating: 4, body: 'Synthetic project feedback for a verified delivery.' };
  assert.equal((await request('GET', customerEndpoint)).status, 401);
  assert.equal((await request('GET', customerEndpoint, 'other')).status, 404);
  assert.equal((await request('POST', `/api/client/project-reviews/${other}`, 'client', review)).status, 404);
  assert.equal((await request('POST', `/api/client/project-reviews/${active}`, 'client', review)).status, 409);
  assert.equal((await request('POST', `/api/client/project-reviews/${completeWithoutDelivery}`, 'client', review)).status, 409);
  assert.equal((await request('POST', customerEndpoint, 'client', { ...review, rating: 6 })).status, 400);
  assert.equal((await request('POST', customerEndpoint, 'client', review, { origin: 'https://another.example.test' })).status, 403);

  const concurrent = await Promise.all(Array.from({ length: 5 }, () => request('POST', customerEndpoint, 'client', review)));
  const reviewId = concurrent[0].data.review.id;
  assert.equal(concurrent.filter(result => result.status === 201).length, 1);
  assert.ok(concurrent.every(result => [200, 201].includes(result.status) && result.data.review.id === reviewId));
  assert.equal((await request('GET', customerEndpoint, 'client')).headers['Cache-Control'], 'no-store');
  assert.equal((await request('GET', '/api/reviews')).data.reviews.some(item => item.id === reviewId), false);
  assert.equal((await request('GET', '/api/admin/project-reviews', 'ownerWithoutMfa')).status, 428);
  assert.equal((await request('GET', '/api/admin/project-reviews', 'staff')).status, 403);
  assert.equal((await request('PATCH', moderatorEndpoint, 'client', { status: 'published' })).status, 403);
  assert.equal((await request('PATCH', moderatorEndpoint, 'owner', { reply: 'A pending review cannot receive this reply.' })).status, 409);
  assert.equal((await request('PATCH', moderatorEndpoint, 'owner', { status: 'published' })).status, 200);
  assert.equal((await request('PATCH', moderatorEndpoint, 'owner', { reply: 'Thank you for the detailed feedback.' })).status, 200);

  const secondReview = await request('POST', `/api/client/project-reviews/${eligibleSecond}`, 'client', { ...review, rating: 2 });
  assert.equal(secondReview.status, 201);
  assert.equal((await request('PATCH', `/api/admin/project-reviews/${eligibleSecond}`, 'owner', { status: 'published' })).status, 200);
  const highest = (await request('GET', '/api/reviews?sort=highest&limit=40')).data.reviews;
  const publicReview = highest.find(item => item.id === reviewId);
  assert.deepEqual(Object.keys(publicReview).sort(), ['body', 'id', 'rating', 'reply', 'service', 'submittedAt']);
  assert.ok(highest.findIndex(item => item.id === reviewId) < highest.findIndex(item => item.id === secondReview.data.review.id));
  assert.equal(publicReview.reply.body, 'Thank you for the detailed feedback.');
  assert.equal((await request('PATCH', moderatorEndpoint, 'owner', { status: 'hidden' })).status, 200);
  assert.equal((await request('GET', '/api/reviews?limit=40')).data.reviews.some(item => item.id === reviewId), false);

  const notices = await db.query(`SELECT "userId", data->>'eventKey' AS event FROM system_notifications
    WHERE data->>'eventKey' = ANY($1::text[]) AND "userId" = ANY($2::text[])`,
  [[`project-review:${reviewId}:submitted`, `project-review:${reviewId}:published`, `project-review:${reviewId}:reply`], Object.values(accounts).map(account => account.id)]);
  assert.deepEqual(notices.rows.filter(row => row.event.endsWith(':submitted')).map(row => row.userId).sort(), [accounts.owner.id, accounts.ownerWithoutMfa.id].sort());
  assert.equal(notices.rows.filter(row => row.userId === accounts.client.id).length, 2);
  assert.equal(notices.rows.length, 4);

  const enquiry = { message: 'Synthetic contact enquiry from the customer portal.' };
  const idempotency = { 'idempotency-key': randomUUID() };
  assert.equal((await request('POST', '/api/contact', undefined, enquiry, idempotency)).status, 401);
  assert.equal((await request('POST', '/api/contact', 'staff', enquiry, idempotency)).status, 403);
  assert.equal((await request('POST', '/api/contact', 'client', { ...enquiry, website: 'http://bot.example.test' }, idempotency)).status, 400);
  assert.equal((await request('POST', '/api/contact', 'client', enquiry, { ...idempotency, 'sec-fetch-site': 'cross-site' })).status, 403);

  const delivered = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/api/contact', 'client', enquiry, idempotency)));
  const conversation = delivered[0].data.id;
  chats.push(conversation);
  assert.equal(delivered.filter(result => result.status === 201).length, 1);
  assert.ok(delivered.every(result => [200, 201].includes(result.status) && result.data.id === conversation));
  assert.equal((await request('POST', '/api/contact', 'client', { message: `${enquiry.message} Edited.` }, idempotency)).status, 409);
  const stored = await db.query(`SELECT c."customerId", c.source, c."templateId", c.data->>'leadId' AS "leadId",
    (SELECT count(*) FROM conversation_messages WHERE "conversationId" = c.id)::int AS messages FROM conversations c WHERE c.id = $1`, [conversation]);
  assert.deepEqual(stored.rows[0], { customerId: accounts.client.id, source: 'contact', templateId: null, leadId: null, messages: 1 });
  assert.equal((await request('GET', `/api/conversations/${conversation}`, 'client')).status, 200);
  assert.equal((await request('GET', `/api/conversations/${conversation}`, 'owner')).status, 200);
  assert.equal((await request('GET', `/api/conversations/${conversation}`, 'other')).status, 404);
  assert.equal((await request('GET', `/api/conversations/${conversation}`, 'marketer')).status, 404);
  assert.equal((await request('GET', `/api/conversations/${conversation}`)).status, 404);
  for (let index = 0; index < 3; index++) await request('POST', '/api/contact', 'client', enquiry, idempotency);
  assert.equal((await request('POST', '/api/contact', 'client', enquiry, idempotency)).status, 429);

  console.log('PostgreSQL feedback regression passed: delivery and ownership, concurrent review submission, owner MFA and moderation, public redaction and sorting, scoped notifications, contact replay/deduplication, access isolation and spam protection.');
} finally {
  const ids = Object.values(accounts).map(account => account.id);
  await db.query('DELETE FROM app_settings WHERE key = ANY($1::text[])', [projects.map(id => `project-review:${id}`)]);
  await db.query(`DELETE FROM system_notifications WHERE data->'target'->>'id' = ANY($1::text[])`, [[...projects, ...chats]]);
  await db.query('DELETE FROM audit_entries WHERE "targetId" = ANY($1::text[])', [[...projects, ...chats]]);
  await db.query('DELETE FROM conversation_messages WHERE "conversationId" = ANY($1::text[])', [chats]);
  await db.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [chats]);
  await db.query('DELETE FROM project_requests WHERE id = ANY($1::text[])', [projects]);
  await db.query('DELETE FROM auth_sessions WHERE "userId" = ANY($1::text[])', [ids]);
  await db.query('DELETE FROM user_accounts WHERE id = ANY($1::text[])', [ids]);
  await Promise.all([db.end(), closePostgresPool()]);
}
