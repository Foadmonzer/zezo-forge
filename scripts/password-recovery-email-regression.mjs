import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { passwordRecoveryEmailReady, renderPasswordRecoveryEmail } from '../src/server/password-recovery-mailer.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (!parsed || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) || !/(?:^|[_-])(?:test|ci)(?:$|[_-])/i.test(parsed.pathname)) {
  throw new Error('This test only runs against localhost PostgreSQL with a database name clearly marked test or ci.');
}
if (process.env.ZEZO_ENABLE_EMAIL_DELIVERY === 'true') throw new Error('Disable the real Resend mailer before running this test.');

const prefix = `prmail_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const oldPassword = 'Initial-Synthetic-Passphrase-47!';
const nextPassword = 'New-Synthetic-Passphrase-83!';
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const users = [];
const messages = [];
const smtpEvents = [];
let rejectNextData = false;
let apiProcess;
let smtpServer;

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}
async function getFreePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
function createSmtpSink() {
  return createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 zezo-test-smtp ESMTP\r\n');
    let buffer = '';
    let collecting = false;
    let message = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer) {
        if (collecting) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) {
            const keep = Math.min(4, buffer.length);
            if (buffer.length > keep) {
              message += buffer.slice(0, -keep);
              buffer = buffer.slice(-keep);
            }
            break;
          }
          message += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          collecting = false;
          if (rejectNextData) {
            rejectNextData = false;
            socket.write('451 4.3.0 synthetic delivery failure\r\n');
          } else {
            messages.push(message);
            socket.write('250 2.0.0 synthetic message accepted\r\n');
          }
          message = '';
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const command = line.split(/[\s:]/, 1)[0].toUpperCase();
        smtpEvents.push(command);
        if (command === 'EHLO' || command === 'HELO') socket.write('250-zezo-test-smtp\r\n250 PIPELINING\r\n');
        else if (command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP') socket.write('250 2.0.0 ok\r\n');
        else if (command === 'DATA') { collecting = true; message = ''; socket.write('354 end with <CRLF>.<CRLF>\r\n'); }
        else if (command === 'QUIT') { socket.write('221 2.0.0 closing connection\r\n'); socket.end(); }
        else if (command === 'AUTH') socket.write('502 5.5.1 auth disabled in local test sink\r\n');
        else socket.write('250 2.0.0 ok\r\n');
      }
    });
  });
}

async function waitForApi(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local API process exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/public`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error('Local API process did not become ready.');
}

async function api(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  return { response, text, data };
}

async function seedUser(email) {
  const id = `${prefix}_${users.length}`;
  const salt = randomBytes(16).toString('hex');
  const data = { name: 'Synthetic Password Reset Client', email, username: email, role: 'client', salt };
  const now = new Date();
  await pool.query(`
    INSERT INTO user_accounts (id, email, username, role, active, "fullName", "passwordHash", data, "createdAt", "updatedAt")
    VALUES ($1,$2,$2,'client',TRUE,$3,$4,$5::jsonb,$6,$6)
  `, [id, email, data.name, scryptSync(oldPassword, salt, 64).toString('hex'), JSON.stringify(data), now]);
  const rawSession = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO auth_sessions (id, "userId", "expiresAt", data) VALUES ($1,$2,$3,$4::jsonb)', [digest(rawSession), id, new Date(Date.now() + 60 * 60_000), '{}']);
  const user = { id, email, rawSession };
  users.push(user);
  return user;
}

try {
  await pool.query('SELECT 1');
  const rateKey = digest('zezo-rate:password-reset-ip:127.0.0.1');
  await pool.query('DELETE FROM rate_limit_buckets WHERE key = $1', [rateKey]);
  const smtpPort = await listen(smtpServer = createSmtpSink());
  const apiServer = await getFreePort();

  const baseUrl = `http://127.0.0.1:${apiServer}`;
  apiProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      PORT: String(apiServer),
      ZEZO_STAGING: 'false',
      ZEZO_ENABLE_EMAIL_DELIVERY: 'false',
      ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL: 'true',
      ZEZO_GMAIL_SMTP_USER: 'zezo.info.2026@gmail.com',
      ZEZO_GMAIL_SMTP_APP_PASSWORD: 'test-only-not-a-real-secret',
      ZEZO_TEST_SMTP_HOST: '127.0.0.1',
      ZEZO_TEST_SMTP_PORT: String(smtpPort),
      ZEZO_PUBLIC_URL: baseUrl,
      ZEZO_DATA_DIR: join(tmpdir(), `zezo-password-recovery-${prefix}`)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let childOutput = '';
  apiProcess.stdout.on('data', value => { childOutput += value.toString(); });
  apiProcess.stderr.on('data', value => { childOutput += value.toString(); });
  await waitForApi(baseUrl, apiProcess);

  const copyAr = renderPasswordRecoveryEmail({ resetUrl: `${baseUrl}/#resetPassword=synthetic-token`, language: 'ar' });
  const copyEn = renderPasswordRecoveryEmail({ resetUrl: `${baseUrl}/#resetPassword=synthetic-token`, language: 'en' });
  assert.equal(passwordRecoveryEmailReady({ ZEZO_GMAIL_SMTP_USER: 'zezo.info.2026@gmail.com', ZEZO_GMAIL_SMTP_APP_PASSWORD: 'test', ZEZO_PUBLIC_URL: 'https://zezo-forge-fouad.netlify.app' }), true, 'the explicit Gmail credentials should enable recovery when no separate toggle exists');
  assert.equal(passwordRecoveryEmailReady({ ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL: 'false', ZEZO_GMAIL_SMTP_USER: 'zezo.info.2026@gmail.com', ZEZO_GMAIL_SMTP_APP_PASSWORD: 'test', ZEZO_PUBLIC_URL: 'https://zezo-forge-fouad.netlify.app' }), false);
  assert.equal(passwordRecoveryEmailReady({ ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL: 'true', ZEZO_GMAIL_SMTP_USER: 'someone-else@gmail.com', ZEZO_GMAIL_SMTP_APP_PASSWORD: 'test', ZEZO_PUBLIC_URL: 'https://zezo-forge-fouad.netlify.app' }), false);
  assert.equal(passwordRecoveryEmailReady({ ZEZO_ENABLE_PASSWORD_RECOVERY_EMAIL: 'true', ZEZO_GMAIL_SMTP_USER: 'zezo.info.2026@gmail.com', ZEZO_GMAIL_SMTP_APP_PASSWORD: 'test', ZEZO_PUBLIC_URL: 'http://zezo-forge-fouad.netlify.app' }), false);
  assert.match(copyAr.subject, /إعادة تعيين/);
  assert.match(copyAr.html, /صالح لمدة ساعة/);
  assert.match(copyAr.text, /يرجى عدم الرد/);
  assert.match(copyEn.subject, /Reset your ZEZO Forge password/);
  assert.match(copyEn.html, /expires in 1 hour/);
  assert.match(copyEn.text, /Please do not reply/);

  const client = await seedUser(`${prefix}.client@example.test`);
  const known = await api(baseUrl, '/api/auth/forgot-password', { email: client.email, lang: 'en' });
  assert.equal(known.response.status, 202, known.text);
  assert.equal(messages.length, 1, `known synthetic account should trigger one SMTP delivery; response=${known.response.status}; smtp=${smtpEvents.join(',')}; logs=${childOutput}`);
  const decodedMail = messages[0].replace(/=\r?\n/g, '').replace(/=([A-F0-9]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const rawToken = decodedMail.match(/#resetPassword=([A-Za-z0-9_-]+)/)?.[1];
  assert(rawToken, 'captured synthetic email did not contain its reset link');
  assert.equal(rawToken.length, 43, 'captured reset token should have the expected opaque token length');
  assert.match(messages[0], /Reset your ZEZO Forge password/);
  assert.match(messages[0], /zezo-forge-fouad\.netlify\.app|127\.0\.0\.1/);

  const stored = await pool.query('SELECT data FROM user_accounts WHERE id=$1', [client.id]);
  assert.equal(stored.rows[0].data.passwordResetHash, digest(rawToken), 'database should store only the reset-token hash');
  assert.notEqual(stored.rows[0].data.passwordResetHash, rawToken);
  const outbox = await pool.query("SELECT id, state, data FROM outbox_messages WHERE data->>'kind'='account_password_reset' AND recipient=$1 ORDER BY \"createdAt\" DESC LIMIT 1", [client.email]);
  assert.equal(outbox.rows[0]?.state, 'sent');
  assert(!JSON.stringify(outbox.rows[0]?.data).includes(rawToken), 'outbox must not persist the reset token or email body');
  assert(!JSON.stringify(outbox.rows[0]?.data).includes('resetPassword='), 'outbox must not persist the reset URL');

  const missing = await api(baseUrl, '/api/auth/forgot-password', { email: `${prefix}.missing@example.test`, lang: 'en' });
  assert.equal(missing.response.status, known.response.status);
  assert.deepEqual(missing.data, known.data, 'known and unknown account responses must be indistinguishable');
  assert.equal(messages.length, 1, 'unknown address must not create an SMTP message');

  const reset = await api(baseUrl, '/api/auth/reset-password', { token: rawToken, password: nextPassword });
  assert.equal(reset.response.status, 200, reset.text);
  assert.match(reset.response.headers.get('set-cookie') || '', /Max-Age=0/);
  const oldSession = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: `zezo_session=${encodeURIComponent(client.rawSession)}` } });
  assert.equal((await oldSession.json()).authenticated, false, 'reset must revoke previous sessions');
  const reuse = await api(baseUrl, '/api/auth/reset-password', { token: rawToken, password: 'Another-New-Passphrase-62!' });
  assert.equal(reuse.response.status, 400, 'reset token must be one-time');
  const oldLogin = await api(baseUrl, '/api/auth/login', { accountType: 'client', username: client.email, password: oldPassword });
  assert.equal(oldLogin.response.status, 401, 'old password must stop working');
  const newLogin = await api(baseUrl, '/api/auth/login', { accountType: 'client', username: client.email, password: nextPassword });
  assert.equal(newLogin.response.status, 200, newLogin.text);

  const failedClient = await seedUser(`${prefix}.smtp-failure@example.test`);
  rejectNextData = true;
  const failed = await api(baseUrl, '/api/auth/forgot-password', { email: failedClient.email, lang: 'ar' });
  assert.equal(failed.response.status, known.response.status);
  assert.deepEqual(failed.data, known.data, 'SMTP failure must not reveal account existence or claim delivery');
  const failedOutbox = await pool.query("SELECT state, data FROM outbox_messages WHERE data->>'kind'='account_password_reset' AND recipient=$1 ORDER BY \"createdAt\" DESC LIMIT 1", [failedClient.email]);
  assert.equal(failedOutbox.rows[0]?.state, 'uncertain', 'failed SMTP attempt should not be silently marked as delivered');
  assert.equal(failedOutbox.rows[0]?.data?.lastError, 'smtp_rejected', 'store only a coarse SMTP failure code');

  const logCapture = await new Promise(resolve => setTimeout(() => resolve(childOutput), 150));
  assert(!logCapture.includes(rawToken), 'server logs must not include reset token');
  assert(!logCapture.includes(client.email), 'server logs must not include recipient address');
  console.log(JSON.stringify({
    ok: true,
    cases: [
      'localized recovery email rendering',
      'real Nodemailer SMTP transaction to an isolated local sink',
      'token hash only in user row; no raw token/link in outbox',
      'known and unknown email responses are identical',
      'one-time token, session revocation, old-password rejection, new-password login',
      'SMTP failure is recorded as uncertain and does not claim delivery',
      'no recipient or reset token in application logs'
    ]
  }, null, 2));
} finally {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill();
    await Promise.race([new Promise(resolve => apiProcess.once('exit', resolve)), delay(3000)]);
  }
  if (smtpServer?.listening) await new Promise(resolve => smtpServer.close(resolve));
  if (users.length) {
    await pool.query('DELETE FROM auth_sessions WHERE "userId" = ANY($1::text[])', [users.map(user => user.id)]).catch(() => {});
    await pool.query("DELETE FROM outbox_messages WHERE data->>'kind'='account_password_reset' AND recipient LIKE $1", [`${prefix}.%`]).catch(() => {});
    await pool.query('DELETE FROM audit_entries WHERE "actorId" = ANY($1::text[])', [users.map(user => user.id)]).catch(() => {});
    await pool.query('DELETE FROM user_accounts WHERE id = ANY($1::text[])', [users.map(user => user.id)]).catch(() => {});
  }
  await pool.query('DELETE FROM rate_limit_buckets WHERE key = $1', [digest('zezo-rate:password-reset-ip:127.0.0.1')]).catch(() => {});
  await pool.end();
}
