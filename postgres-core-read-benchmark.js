import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createStagingSession, STAGING_ACCESS_COOKIE } from './src/server/staging-auth.js';
import { closePostgresPool } from './src/server/postgres-runtime.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point to a disposable synthetic phase6 PostgreSQL database.');
const databaseName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
const disposableDatabase = /^zezo_phase6_[a-z0-9_]+$/i.test(databaseName) || (process.env.GITHUB_ACTIONS === 'true' && databaseName === 'zezo_ci');
if (!disposableDatabase) throw new Error('Refusing to benchmark anything but a disposable zezo_phase6_* database or the isolated GitHub Actions zezo_ci service.');
process.env.ZEZO_STAGING = 'true';
process.env.ZEZO_STAGING_ACCESS_PASSWORD ||= `Benchmark-${randomBytes(24).toString('base64url')}`;
process.env.NODE_ENV = 'test';

const { init, handle } = await import('./server.js');
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const now = new Date();
const password = `Synthetic!Phase6-${suffix}`;
const salt = randomBytes(16).toString('hex');
const passwordHash = scryptSync(password, salt, 64).toString('hex');
const sampleCount = Math.max(12, Number(process.env.BENCH_SAMPLES) || 36);
const concurrency = Math.max(2, Math.min(sampleCount, Number(process.env.BENCH_CONCURRENCY) || 12));
const waves = Math.ceil(sampleCount / concurrency);
const users = [];
const conversationIds = [];
const crmIds = [];
const gateCookie = `${STAGING_ACCESS_COOKIE}=${encodeURIComponent(createStagingSession())}`;

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.statusCode = 0; this.chunks = []; }
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function request(method, path, { body, cookie = '' } = {}) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(bytes?.length ? [bytes] : []);
  req.method = method; req.url = path;
  req.headers = { cookie: [gateCookie, cookie].filter(Boolean).join('; '), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const response = new Response();
  const finished = new Promise((resolve, reject) => { response.once('finish', resolve); response.once('error', reject); });
  const start = performance.now();
  await handle(req, response);
  await finished;
  const sessionCookie = String(response.headers['Set-Cookie'] || '').split(';', 1)[0];
  return { status: response.statusCode, body: response.body, sessionCookie, ms: performance.now() - start };
}

function stats(route, label, samples) {
  const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const percentile = fraction => Number(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)].toFixed(1));
  return { mode: label, route, samples: samples.length, concurrency, waves, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: Number(Math.max(...sorted).toFixed(1)), errors: samples.filter(sample => sample.status !== 200).length };
}

async function measure(route, label, calls) {
  const samples = [];
  for (let offset = 0; offset < calls.length; offset += concurrency) {
    const batch = calls.slice(offset, offset + concurrency);
    samples.push(...await Promise.all(batch.map(call => call())));
  }
  const result = stats(route, label, samples);
  if (result.errors) {
    const statuses = Object.fromEntries([...new Set(samples.map(sample => sample.status))].map(status => [status, samples.filter(sample => sample.status === status).length]));
    const responseSample = samples.find(sample => sample.status !== 200);
    throw new Error(`${label} ${route} returned non-200 responses: ${JSON.stringify(statuses)}; sample=${responseSample?.body || ''}`);
  }
  result.samples = samples;
  return result;
}
const compact = result => {
  const { samples, ...summary } = result;
  return summary;
};

try {
  await client.connect();
  await init();
  const usersToSeed = sampleCount;
  for (let index = 0; index < usersToSeed; index++) {
    const userId = `phase6_user_${suffix}_${index}`;
    const username = `phase6_${suffix}_${index}@example.test`;
    const sessionId = randomBytes(32).toString('base64url');
    const sessionHash = createHash('sha256').update(sessionId).digest('hex');
    const createdAt = new Date(now.getTime() + index);
    const userData = { name: `Synthetic Phase 6 Customer ${index}`, salt, student: false, emailVerified: true };
    await client.query(`
      INSERT INTO user_accounts (id,email,username,role,active,"fullName","passwordHash",data,"createdAt","updatedAt")
      VALUES ($1,$2,$2,'client',TRUE,$3,$4,$5::jsonb,$6,$6)
    `, [userId, username, userData.name, passwordHash, JSON.stringify(userData), createdAt]);
    await client.query('INSERT INTO auth_sessions (id,"userId","expiresAt",data,"createdAt") VALUES ($1,$2,NOW() + INTERVAL \'2 hours\',$3::jsonb,NOW())', [sessionHash, userId, '{}']);
    const conversationId = `phase6_chat_${suffix}_${index}`;
    conversationIds.push(conversationId);
    const conversationData = { templateName: 'Synthetic landing template', templateService: 'web', templateCategory: 'site', department: 'orders', source: 'phase6_benchmark' };
    await client.query(`
      INSERT INTO conversations (id,"customerId","assignedToId",status,"templateId",source,data,"createdAt","updatedAt")
      VALUES ($1,$2,NULL,'new','web-synthetic','phase6_benchmark',$3::jsonb,$4,$4)
    `, [conversationId, userId, JSON.stringify(conversationData), createdAt]);
    await client.query(`
      INSERT INTO conversation_messages (id,"conversationId","senderId",body,data,"createdAt")
      VALUES ($1,$2,NULL,$3,$4::jsonb,$5)
    `, [`phase6_msg_${suffix}_${index}`, conversationId, 'Synthetic conversation test message', JSON.stringify({ senderType: 'client', attachments: [] }), createdAt]);
    users.push({ id: userId, username, sessionId, cookie: `zezo_session=${encodeURIComponent(sessionId)}` });
  }

  const ownerIdForCrm = `phase6_marketer_${suffix}`;
  const ownerSessionId = randomBytes(32).toString('base64url');
  const ownerSessionHash = createHash('sha256').update(ownerSessionId).digest('hex');
  const ownerData = { name: 'Synthetic Phase 6 Marketer', salt, referralCode: `phase6code_${suffix}`, currentReferralCode: `phase6code_${suffix}`, department: 'marketing' };
  await client.query(`
    INSERT INTO user_accounts (id,email,username,role,active,"fullName","passwordHash",data,"createdAt","updatedAt")
    VALUES ($1,$2,$2,'marketer',TRUE,$3,$4,$5::jsonb,NOW(),NOW())
  `, [ownerIdForCrm, `phase6_marketer_${suffix}@example.test`, ownerData.name, passwordHash, JSON.stringify(ownerData)]);
  await client.query('INSERT INTO auth_sessions (id,"userId","expiresAt",data,"createdAt") VALUES ($1,$2,NOW() + INTERVAL \'2 hours\',$3::jsonb,NOW())', [ownerSessionHash, ownerIdForCrm, '{}']);
  let ownerCookie = `zezo_session=${encodeURIComponent(ownerSessionId)}`;
  for (let index = 0; index < sampleCount; index++) {
    const id = `phase6_crm_${suffix}_${index}`;
    crmIds.push(id);
    const data = { id, name: `Synthetic CRM enquiry ${index}`, phone: '', email: '', service: 'web', status: 'new_enquiry', source: 'phase6_benchmark', orderIds: [], referralUserId: ownerIdForCrm, assignedUserId: null, referralCode: ownerData.referralCode, createdAt: now.toISOString(), updatedAt: now.toISOString(), history: [] };
    await client.query('INSERT INTO crm_records (id,status,source,data,"createdAt","updatedAt") VALUES ($1,$2,$3,$4::jsonb,$5,$5)', [id, 'new_enquiry', 'phase6_benchmark', JSON.stringify(data), now]);
  }

  const conversations = users.map(user => () => request('GET', '/api/conversations', { cookie: user.cookie }));
  const dashboards = users.map(user => () => request('GET', '/api/dashboard', { cookie: user.cookie }));
  const crm = Array.from({ length: sampleCount }, () => () => request('GET', '/api/crm', { cookie: ownerCookie }));
  const loginUsers = [...users];
  const login = loginUsers.map(user => () => request('POST', '/api/auth/login', { body: { username: user.username, password, accountType: 'client' } }));
  const output = [];
  for (const legacy of [true, false]) {
    process.env.ZEZO_BENCH_LEGACY_CORE_READS = legacy ? 'true' : 'false';
    const mode = legacy ? 'before-lock-path' : 'targeted-postgres-read';
    const crmLogin = await request('POST', '/api/auth/login', { body: { username: `phase6_marketer_${suffix}@example.test`, password, accountType: 'employee' } });
    assert.equal(crmLogin.status, 200, `Synthetic marketer login failed for ${mode}.`);
    ownerCookie = crmLogin.sessionCookie;
    const loginResults = await measure('POST /api/auth/login', mode, login);
    output.push(compact(loginResults));
    loginUsers.forEach((user, index) => {
      if (loginResults.samples[index]?.sessionCookie) user.cookie = loginResults.samples[index].sessionCookie;
    });
    output.push(compact(await measure('GET /api/conversations', mode, conversations)));
    output.push(compact(await measure('GET /api/dashboard', mode, dashboards)));
    const marketerDashboard = Array.from({ length: sampleCount }, () => () => request('GET', '/api/dashboard', { cookie: ownerCookie }));
    output.push(compact(await measure('GET /api/dashboard (marketer)', mode, marketerDashboard)));
    output.push(compact(await measure('GET /api/crm', mode, crm)));
  }
  console.log(JSON.stringify({ database: databaseName, syntheticUsers: users.length, conversations: conversationIds.length, crmRecords: crmIds.length, results: output }, null, 2));
} finally {
  process.env.ZEZO_BENCH_LEGACY_CORE_READS = 'false';
  if (users.length) {
    await client.query('BEGIN').catch(() => {});
    try {
      const testUserIds = [...users.map(user => user.id), `phase6_marketer_${suffix}`];
      await client.query('DELETE FROM commissions WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM finance_ledger_entries WHERE "employeeId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM wallet_transactions WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM withdrawal_requests WHERE "userId" = ANY($1::text[]) OR "reviewedBy" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM rank_requests WHERE "userId" = ANY($1::text[]) OR "reviewedBy" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM referral_events WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM referral_attributions WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM referral_links WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM system_notifications WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM auth_sessions WHERE "userId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM audit_entries WHERE "actorId" = ANY($1::text[]) OR "targetId" = ANY($1::text[])', [testUserIds]);
      await client.query('DELETE FROM conversation_messages WHERE "conversationId" = ANY($1::text[])', [conversationIds]);
      await client.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [conversationIds]);
      await client.query('DELETE FROM crm_records WHERE id = ANY($1::text[])', [crmIds]);
      await client.query('DELETE FROM user_accounts WHERE id = ANY($1::text[])', [testUserIds]);
      const rateKeys = [...users.map(user => user.username), `phase6_marketer_${suffix}@example.test`]
        .map(username => createHash('sha256').update(`zezo-rate:login:127.0.0.1:${username}`).digest('hex'));
      await client.query('DELETE FROM rate_limit_buckets WHERE key = ANY($1::text[])', [rateKeys]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`Synthetic cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
  await client.end().catch(() => {});
  await closePostgresPool();
}
