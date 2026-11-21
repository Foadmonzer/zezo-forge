import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

const testUrl = process.env.ZEZO_TEST_DATABASE_URL;
if (!testUrl) throw new Error('ZEZO_TEST_DATABASE_URL is required.');
const parsedUrl = new URL(testUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname) || parsedUrl.pathname !== '/zezo_owner_password_test') {
  throw new Error('Refusing to run Owner password integration test outside the isolated loopback test database.');
}
process.env.DATABASE_URL = testUrl;
process.env.ZEZO_STAGING = 'false';

const [{ default: pg }, { init, handle }, { closePostgresPool }, { provisionFirstOwner }] = await Promise.all([
  import('pg'), import('./server.js'), import('./src/server/postgres-runtime.js'), import('./src/server/owner-bootstrap.js')
]);
const db = new pg.Client({ connectionString: testUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const oldPassword = `Synthetic!${suffix}Old2026`;
const newPassword = `Synthetic!${suffix}New2026`;
const username = `synthetic_owner_${suffix}`;
const results = [];

function currentTotp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bitCount = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) { bitCount -= 8; bytes.push((buffer >> bitCount) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

function assertSafeUiAndEndpointWiring() {
  const appSource = globalThis.appSource;
  assert(appSource.includes("if(data.role==='admin'&&tab==='profile')"), 'Owner profile tab is not routed to the isolated security form.');
  assert(appSource.includes('id="ownerPasswordForm"'), 'Owner password form is missing.');
  const handlerStart = appSource.indexOf("if(event.target.matches('#ownerPasswordForm'))");
  const handlerEnd = appSource.indexOf("if(event.target.matches('#passwordForm'))", handlerStart);
  assert(handlerStart >= 0 && handlerEnd > handlerStart, 'Owner password submit handler is missing or not isolated.');
  const handler = appSource.slice(handlerStart, handlerEnd);
  assert(handler.includes("postJson('/api/auth/password'"), 'Owner form does not use the existing password API.');
  assert(!/console\.|posthog|capture\(|analytics/i.test(handler), 'Owner password handler must not log or send analytics.');
  const legacy = globalThis.legacySource;
  assert(legacy.includes('location.pathname !== \'/\''), 'Analytics does not exclude the team portal route.');
  assert(legacy.includes('autocapture: false') && legacy.includes('disable_session_recording: true'), 'Analytics must not auto-capture or record password fields.');
  const server = globalThis.serverSource;
  const routeStart = server.indexOf("path === '/api/auth/password'");
  const routeEnd = server.indexOf("path === '/api/auth/mfa/setup'", routeStart);
  assert(routeStart >= 0 && routeEnd > routeStart, 'Existing password endpoint was not found.');
  const route = server.slice(routeStart, routeEnd);
  assert(route.includes('body.currentPassword') && route.includes('changePostgresPassword'), 'Server endpoint must verify the current password.');
  assert(!/console\.(?:log|error|warn).*password/i.test(route), 'Password endpoint must not log password values.');
  results.push('Owner form wiring uses POST /api/auth/password; no form logging/analytics; password route verifies current credential.');
}

async function request(method, path, { body, cookie = '' } = {}) {
  const input = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const req = Readable.from(input.length ? [input] : []);
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const res = {
    headersSent: false, writableEnded: false, statusCode: 200, responseHeaders: {}, chunks: [],
    writeHead(status, headers = {}) { this.statusCode = status; this.responseHeaders = headers; this.headersSent = true; return this; },
    end(chunk = '') { if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.writableEnded = true; return this; }
  };
  await handle(req, res);
  const raw = Buffer.concat(res.chunks).toString('utf8');
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  return { status: res.statusCode, headers: res.responseHeaders, data };
}
function cookieFrom(response) {
  const header = response.headers['Set-Cookie'];
  assert(typeof header === 'string' && header.startsWith('zezo_session='), 'Sign-in did not issue a session cookie.');
  return header.split(';', 1)[0];
}

const [appSource, legacySource, serverSource] = await Promise.all([
  readFile(new URL('./public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('./app/legacy-application.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./server.js', import.meta.url), 'utf8')
]);
globalThis.appSource = appSource;
globalThis.legacySource = legacySource;
globalThis.serverSource = serverSource;
assertSafeUiAndEndpointWiring();

await db.connect();
let sessionCookie = '';
try {
  await init();
  const owner = await provisionFirstOwner({
    client: db, name: 'Synthetic Password-Test Owner', username,
    email: `synthetic-${suffix}@example.test`, password: oldPassword
  });
  const initialLogin = await request('POST', '/api/auth/login', {
    body: { username, password: oldPassword, accountType: 'management' }
  });
  assert.equal(initialLogin.status, 200, 'Synthetic Owner could not sign in with the starting password.');
  sessionCookie = cookieFrom(initialLogin);

  const wrongCurrent = await request('POST', '/api/auth/password', {
    body: { currentPassword: `Wrong-${suffix}`, newPassword }, cookie: sessionCookie
  });
  assert.equal(wrongCurrent.status, 401, 'Password endpoint must reject an incorrect current password.');

  const changed = await request('POST', '/api/auth/password', {
    body: { currentPassword: oldPassword, newPassword }, cookie: sessionCookie
  });
  assert.equal(changed.status, 200, 'Password change did not succeed for the synthetic Owner.');
  const originalSessionCheck = await request('GET', '/api/auth/mfa/setup', { cookie: sessionCookie });
  assert.equal(originalSessionCheck.status, 200, 'The existing session must remain valid after password change.');
  const sessionCount = await db.query('SELECT COUNT(*)::int AS count FROM auth_sessions WHERE "userId" = $1 AND "expiresAt" > NOW()', [owner.id]);
  assert.equal(sessionCount.rows[0]?.count, 1, 'Password change must leave the current session row intact.');
  results.push('Wrong current password rejected; password changed; original authenticated session remained active.');

  const freshLogin = await request('POST', '/api/auth/login', {
    body: { username, password: newPassword, accountType: 'management' }
  });
  assert.equal(freshLogin.status, 200, 'New password did not authenticate in a fresh session.');
  const oldLogin = await request('POST', '/api/auth/login', {
    body: { username, password: oldPassword, accountType: 'management' }
  });
  assert.equal(oldLogin.status, 401, 'Old password must be rejected after password change.');
  const freshCookie = cookieFrom(freshLogin);
  const setup = await request('GET', '/api/auth/mfa/setup', { cookie: freshCookie });
  assert.equal(setup.status, 200, 'MFA setup could not be prepared for the synthetic Owner.');
  const enabled = await request('POST', '/api/auth/mfa/enable', {
    body: { code: currentTotp(setup.data.secret) }, cookie: freshCookie
  });
  assert.equal(enabled.status, 200, 'MFA could not be enabled for the synthetic Owner.');
  const secureLogin = await request('POST', '/api/auth/login', {
    body: { username, password: newPassword, accountType: 'management', mfaCode: currentTotp(setup.data.secret) }
  });
  assert.equal(secureLogin.status, 200, 'Fresh sign-in with the new password and MFA failed.');
  const oldLoginAfterMfa = await request('POST', '/api/auth/login', {
    body: { username, password: oldPassword, accountType: 'management', mfaCode: currentTotp(setup.data.secret) }
  });
  assert.equal(oldLoginAfterMfa.status, 401, 'Old password must remain rejected after MFA is enabled.');
  results.push('Fresh sign-in succeeded with new password and MFA; old password remained rejected.');

  const audit = await db.query('SELECT data::text AS payload FROM audit_entries WHERE "actorId" = $1 AND action = $2', [owner.id, 'password_changed']);
  assert.equal(audit.rowCount, 1, 'Expected one password-change audit event.');
  assert(!audit.rows[0].payload.includes(oldPassword) && !audit.rows[0].payload.includes(newPassword), 'Audit data must not contain raw passwords.');
  results.push('Audit record contains no raw password values.');
  for (const result of results) console.log(`PASS ${result}`);
} finally {
  await db.end().catch(() => {});
  await closePostgresPool();
}
