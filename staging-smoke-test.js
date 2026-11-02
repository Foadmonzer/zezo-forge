import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dataDir = await mkdtemp(join(tmpdir(), 'zezo-staging-test-'));
const accessPassword = `Staging-${randomBytes(30).toString('base64url')}`;
process.env.ZEZO_STAGING = 'true';
process.env.ZEZO_STAGING_ACCESS_PASSWORD = accessPassword;
process.env.ZEZO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'production';
process.env.ZEZO_WHATSAPP_NUMBER = '+971500000000';
process.env.ZEZO_PUBLIC_URL = 'https://wrong-live-host.example';
process.env.RESEND_API_KEY = 'test-only-never-used';
process.env.ZEZO_FROM_EMAIL = 'test@example.test';
process.env.ZEZO_NOTIFICATION_EMAIL = 'test@example.test';
process.env.OPENAI_API_KEY = 'test-only-never-used';
process.env.OPENAI_MODEL = 'test-model';

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.statusCode = 0; this.chunks = []; }
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}
let stagingCookie = '';
async function call(handle, method, url, { body, rawBody, contentType, auth = true, forwardedHttps = false } = {}) {
  const payload = rawBody !== undefined ? Buffer.from(rawBody) : body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(payload === null ? [] : [payload]);
  req.method = method; req.url = url; req.headers = {};
  if (payload !== null) req.headers['content-type'] = contentType || (rawBody !== undefined ? 'application/x-www-form-urlencoded' : 'application/json');
  if (auth && stagingCookie) req.headers.cookie = stagingCookie;
  if (forwardedHttps) req.headers['x-forwarded-proto'] = 'https';
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const res = new Response();
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handle(req, res); await finished;
  return { status: res.statusCode, headers: res.headers, body: res.body, json: () => JSON.parse(res.body || '{}') };
}

try {
  const app = await import('./server.js');
  assert.equal(await app.init(), true, 'production-mode staging permits the protected initial Owner setup');
  const gate = await call(app.handle, 'GET', '/', { auth: false });
  assert.equal(gate.status, 200, 'unauthenticated visitors receive the staging password page');
  assert.match(gate.body, /name="password"/);
  const badLogin = await call(app.handle, 'POST', '/__staging/login', { auth: false, rawBody: 'password=incorrect', forwardedHttps: true });
  assert.equal(badLogin.status, 401, 'incorrect staging password is rejected');
  const stagingLogin = await call(app.handle, 'POST', '/__staging/login', { auth: false, rawBody: 'password=' + encodeURIComponent(accessPassword), forwardedHttps: true });
  assert.equal(stagingLogin.status, 303, 'correct staging password creates a browser session');
  assert.match(stagingLogin.headers['Set-Cookie'], /zezo_staging_access=.*; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
  stagingCookie = stagingLogin.headers['Set-Cookie'].split(';')[0];
  const apiBlocked = await call(app.handle, 'GET', '/api/public', { auth: false });
  assert.equal(apiBlocked.status, 401, 'API data remains protected without the staging session cookie');
  const robots = await call(app.handle, 'GET', '/robots.txt', { auth: false });
  assert.equal(robots.status, 200, 'robots file is reachable for crawler exclusion');
  assert.match(robots.body, /Disallow: \//);
  assert.match(robots.headers['X-Robots-Tag'], /noindex/);
  const home = await call(app.handle, 'GET', '/', { forwardedHttps: true });
  assert.equal(home.status, 200);
  assert.match(home.body, /data-zezo-staging="true"/);
  assert.match(home.body, /ZEZO \/ STAGING/);
  assert.match(home.headers['X-Robots-Tag'], /noindex/);
  const publicConfig = await call(app.handle, 'GET', '/api/public');
  assert.equal(publicConfig.status, 200);
  const settings = publicConfig.json();
  assert.equal(settings.stagingMode, true);
  assert.equal(settings.whatsappUrl, '', 'test environment never opens the live WhatsApp contact');
  assert.equal(settings.emailReady, false, 'test environment never sends email');
  assert.equal(settings.aiQuoteReady, false, 'test environment never calls an AI provider');
  assert.equal(settings.adminSetupAvailable, true);
  const password = `Owner-${randomBytes(30).toString('base64url')}`;
  const ownerSetup = await call(app.handle, 'POST', '/api/setup', { body: { name: 'Test Owner', username: 'stagingowner', password }, forwardedHttps: true });
  assert.equal(ownerSetup.status, 201, `first owner creation succeeds: ${ownerSetup.body}`);
  assert.equal(ownerSetup.json().user.mustChangePassword, true, 'the first Owner must change the temporary password');
  const sessionCookie = Array.isArray(ownerSetup.headers['Set-Cookie']) ? ownerSetup.headers['Set-Cookie'].join(';') : String(ownerSetup.headers['Set-Cookie'] || '');
  assert.match(sessionCookie, /; Secure(?:;|$)/, 'sessions created through the HTTPS tunnel use Secure cookies');
  const closed = await call(app.handle, 'GET', '/api/public');
  assert.equal(closed.json().adminSetupAvailable, false, 'initial Owner setup closes after the first Owner is created');
  const secondSetup = await call(app.handle, 'POST', '/api/setup', { body: { name: 'Second Owner', username: 'secondowner', password } });
  assert.equal(secondSetup.status, 409, 'second public Owner setup is refused');
  const staticAsset = await call(app.handle, 'GET', '/app.js');
  assert.match(staticAsset.headers['X-Robots-Tag'], /noindex/);
  const badStatic = await call(app.handle, 'GET', '/missing-staging-file');
  assert.equal(badStatic.status, 200, 'unknown public routes fall back to the single-page app entry point');
  assert.match(badStatic.headers['X-Robots-Tag'], /noindex/);
  console.log('PASS — isolated staging data, required access password, noindex headers and robots.txt, visible staging banner, disabled email/AI/WhatsApp integrations, secure first Owner setup, and setup lock after creation.');
} finally {
  await rm(dataDir, { recursive: true, force: true });
  for (const key of ['ZEZO_STAGING','ZEZO_STAGING_ACCESS_PASSWORD','ZEZO_DATA_DIR','NODE_ENV','ZEZO_WHATSAPP_NUMBER','ZEZO_PUBLIC_URL','RESEND_API_KEY','ZEZO_FROM_EMAIL','ZEZO_NOTIFICATION_EMAIL','OPENAI_API_KEY','OPENAI_MODEL']) delete process.env[key];
}
