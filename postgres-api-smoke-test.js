import { Readable } from 'node:stream';
import pg from 'pg';
import { init, handle } from './server.js';
import { closePostgresPool } from './src/server/postgres-runtime.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStagingSession, STAGING_ACCESS_COOKIE } from './src/server/staging-auth.js';
import { provisionFirstOwner } from './src/server/owner-bootstrap.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the PostgreSQL API smoke test.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const stagingAccessCookie = process.env.ZEZO_STAGING === 'true'
  ? `${STAGING_ACCESS_COOKIE}=${encodeURIComponent(createStagingSession())}`
  : '';
const syntheticIds = [];
const testSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const password = `Synthetic!${testSuffix}2026`;
const ownerUsername = `pg_owner_${testSuffix}`;
const customerEmail = `pg_customer_${testSuffix}@example.test`;
const results = [];
let syntheticConversationId = '';
let syntheticLeadId = '';
const employeeIds = [];
let preexistingOutboxIds = [];
const rateBucket = value => createHash('sha256').update(`zezo-rate:${value}`).digest('hex');
const testRateBuckets = [
  rateBucket('login:first-admin:127.0.0.1'), rateBucket(`login:127.0.0.1:${ownerUsername}`),
  rateBucket('client-registration:127.0.0.1'), rateBucket(`login:127.0.0.1:${customerEmail}`),
  rateBucket('conversation:create:127.0.0.1'), rateBucket('public-enquiry:127.0.0.1'),
  rateBucket('quote:127.0.0.1'), rateBucket('quote:referral:127.0.0.1'), rateBucket('referral:127.0.0.1')
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, path, { body, rawBody, contentType = 'application/json', cookie = '' } = {}) {
  const startedAt = performance.now();
  const requestBytes = rawBody !== undefined ? Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody) : body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(requestBytes?.length ? [requestBytes] : []);
  req.method = method;
  req.url = path;
  const requestCookie = [stagingAccessCookie, cookie].filter(Boolean).join('; ');
  req.headers = { 'content-type': contentType, ...(requestCookie ? { cookie: requestCookie } : {}) };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    responseHeaders: {},
    chunks: [],
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.responseHeaders = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      this.writableEnded = true;
      return this;
    }
  };
  await handle(req, res);
  const text = Buffer.concat(res.chunks).toString('utf8');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.statusCode, headers: res.responseHeaders, data, bytes: Buffer.concat(res.chunks), durationMs: performance.now() - startedAt };
}

function multipartForm(fields, file, boundary) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    chunks.push(file.content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { rawBody: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function cookieFrom(response) {
  const value = response.headers['Set-Cookie'];
  assert(typeof value === 'string' && value.startsWith('zezo_session='), 'Authentication response did not issue a session cookie.');
  return value.split(';', 1)[0];
}

function currentTotp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >> bitCount) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

await client.connect();
try {
  preexistingOutboxIds = (await client.query('SELECT id FROM outbox_messages')).rows.map(row => row.id);
  await client.query('DELETE FROM rate_limit_buckets WHERE key = ANY($1::text[])', [testRateBuckets]);
  await init();
  const health = await request('GET', '/api/health');
  assert(health.status === 200 && health.data.storage === 'postgresql', 'API did not report PostgreSQL storage.');
  results.push('API runtime uses PostgreSQL');

  const dashboardLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await dashboardLockHolder.connect();
  let anonymousDashboard;
  try {
    await dashboardLockHolder.query('BEGIN');
    await dashboardLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    const pendingDashboard = request('GET', '/api/dashboard').then(value => ({ done: true, value }));
    const pendingAnonymousInvite = request('POST', '/api/admin/invite', { body: {} }).then(value => ({ done: true, value }));
    anonymousDashboard = await Promise.race([
      pendingDashboard,
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 1000))
    ]);
    var anonymousInvite = await Promise.race([
      pendingAnonymousInvite,
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 1000))
    ]);
  } finally {
    await dashboardLockHolder.query('ROLLBACK').catch(() => {});
    await dashboardLockHolder.end();
  }
  assert(anonymousDashboard?.done === true && anonymousDashboard.value.status === 401,
    'Anonymous dashboard access must be rejected before waiting on the legacy global PostgreSQL lock.');
  results.push('anonymous dashboard access is rejected before the legacy global PostgreSQL lock');
  assert(anonymousInvite?.done === true && anonymousInvite.value.status === 401,
    'Anonymous team invitation access must be rejected before waiting on the legacy global PostgreSQL lock.');
  results.push('anonymous team invitation access is rejected before the legacy global PostgreSQL lock');

  const publicBefore = await request('GET', '/api/public');
  assert(!Object.hasOwn(publicBefore.data, 'adminSetupAvailable'), 'Public PostgreSQL configuration must never disclose Owner setup state.');
  assert(Object.keys(publicBefore.data.templatePrices || {}).length === 40, 'Public runtime read did not return the 40 template price entries.');
  assert(Object.values(publicBefore.data.templatePrices).every(price => Number(price) === 200), 'Default template starting prices changed in the PostgreSQL public read.');
  assert(Object.keys(publicBefore.data.templateActive || {}).length === 40, 'Public runtime read did not return template availability.');
  results.push('lock-free public runtime read preserves all 40 template prices and availability');

  // Hold the legacy global advisory lock from a second PostgreSQL connection.
  // The targeted public repository must still answer while legacy API writes wait.
  const lockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await lockHolder.connect();
  let lockedPublicRead;
  try {
    await lockHolder.query('BEGIN');
    await lockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    const pendingRead = request('GET', '/api/public').then(value => ({ done: true, value }));
    lockedPublicRead = await Promise.race([
      pendingRead,
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 800))
    ]);
  } finally {
    await lockHolder.query('ROLLBACK').catch(() => {});
    await lockHolder.end();
  }
  assert(lockedPublicRead?.done === true && lockedPublicRead.value.status === 200,
    'Public runtime read queued behind the legacy global PostgreSQL advisory lock.');
  results.push('public runtime read completed while the legacy global advisory lock was held');

  const publicOwnerAttempt = await request('POST', '/api/setup', {
    body: { name: 'Synthetic Public Owner Attempt', username: `public_owner_${testSuffix}`, password }
  });
  assert(publicOwnerAttempt.status === 410, 'The public API must permanently reject Owner creation before a first Owner exists.');
  const bootstrap = await provisionFirstOwner({ client, name: 'Synthetic ZEZO Owner', username: ownerUsername, email: `owner_${testSuffix}@example.test`, password });
  const ownerId = bootstrap.id;
  syntheticIds.push(ownerId);
  let duplicateBootstrapError = null;
  try {
    await provisionFirstOwner({ client, name: 'Synthetic Second Owner', username: `${ownerUsername}_two`, email: `owner_two_${testSuffix}@example.test`, password });
  } catch (error) { duplicateBootstrapError = error; }
  assert(/Owner bootstrap is closed/.test(duplicateBootstrapError?.message || ''), 'Private first-Owner bootstrap must refuse a second Owner after provisioning.');
  assert(!(await client.query('SELECT 1 FROM user_accounts WHERE username = $1', [`${ownerUsername}_two`])).rowCount, 'A second Owner row was created by the private bootstrap path.');
  let ownerCookie = '';
  results.push('public Owner API refused provisioning, private one-time bootstrap created one Owner, and a second bootstrap attempt was rejected');

  const changedPassword = `${password}-Changed!`;
  const initialOwnerLogin = await request('POST', '/api/auth/login', {
    body: { username: ownerUsername, password, accountType: 'management' }
  });
  assert(initialOwnerLogin.status === 200, `Private-bootstrap Owner could not sign in (${initialOwnerLogin.status}).`);
  ownerCookie = cookieFrom(initialOwnerLogin);
  const passwordUpdate = await request('POST', '/api/auth/password', {
    body: { currentPassword: password, newPassword: changedPassword }, cookie: ownerCookie
  });
  assert(passwordUpdate.status === 200, `Owner password update failed with ${passwordUpdate.status}.`);
  const ownerLogin = await request('POST', '/api/auth/login', {
    body: { username: ownerUsername, password: changedPassword, accountType: 'management' }
  });
  assert(ownerLogin.status === 200, `Owner login failed with ${ownerLogin.status}.`);
  ownerCookie = cookieFrom(ownerLogin);
  const ownerMfaSetup = await request('GET', '/api/auth/mfa/setup', { cookie: ownerCookie });
  assert(ownerMfaSetup.status === 200 && ownerMfaSetup.data.secret, `Owner session did not survive a reload from PostgreSQL (status ${ownerMfaSetup.status}).`);
  const mfaEnable = await request('POST', '/api/auth/mfa/enable', {
    body: { code: currentTotp(ownerMfaSetup.data.secret) }, cookie: ownerCookie
  });
  assert(mfaEnable.status === 200, `Owner MFA activation failed with ${mfaEnable.status}.`);
  const secureOwnerLogin = await request('POST', '/api/auth/login', {
    body: { username: ownerUsername, password: changedPassword, accountType: 'management', mfaCode: currentTotp(ownerMfaSetup.data.secret) }
  });
  assert(secureOwnerLogin.status === 200, `Owner login with MFA failed with ${secureOwnerLogin.status}.`);
  ownerCookie = cookieFrom(secureOwnerLogin);
  const ownerDashboard = await request('GET', '/api/dashboard', { cookie: ownerCookie });
  assert(ownerDashboard.status === 200 && ownerDashboard.data.user?.role === 'admin', 'Owner dashboard did not reload from PostgreSQL.');
  results.push('Owner password, MFA, secure login, and persistent session');

  const setupAfterOwner = await request('GET', '/api/public');
  assert(!Object.hasOwn(setupAfterOwner.data, 'adminSetupAvailable'), 'Public configuration must never expose Owner setup state.');
  const secondSetup = await request('POST', '/api/setup', {
    body: { name: 'Synthetic Second Owner', username: `${ownerUsername}_two`, password }
  });
  assert(secondSetup.status === 410, 'Public Owner creation must remain permanently closed after bootstrap.');
  results.push('public Owner setup remains closed before and after bootstrap');

  const customerPassword = `Customer!${testSuffix}Longer`;
  const referralUserId = `usr_ref_${testSuffix}`;
  const referralLinkId = `rfl_ref_${testSuffix}`;
  const referralCode = `ZPG${testSuffix.toUpperCase()}`;
  const referralEmail = `pg_referrer_${testSuffix}@example.test`;
  const referralUser = { id: referralUserId, name: 'Synthetic Marketer', username: `pg_referrer_${testSuffix}`, email: referralEmail, role: 'marketer', active: true, referralCode, currentReferralCode: referralCode, currentReferralLinkId: referralLinkId, createdAt: new Date().toISOString() };
  await client.query(`
    INSERT INTO user_accounts (id, email, username, role, active, "fullName", "passwordHash", data, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, 'marketer', TRUE, $4, NULL, $5::jsonb, NOW(), NOW())
  `, [referralUserId, referralEmail, referralUser.username, referralUser.name, JSON.stringify(referralUser)]);
  await client.query(`
    INSERT INTO referral_links (id, "userId", code, month, active, data, "createdAt")
    VALUES ($1, $2, $3, '2026-11', TRUE, $4::jsonb, NOW())
  `, [referralLinkId, referralUserId, referralCode, JSON.stringify({ id: referralLinkId, userId: referralUserId, code: referralCode, month: '2026-11', kind: 'monthly' })]);
  syntheticIds.push(referralUserId);

  const customerRegistrationBody = { name: 'Synthetic Test Customer', email: customerEmail, password: customerPassword, confirmPassword: customerPassword, student: false, role: 'admin' };
  const registrationLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await registrationLockHolder.connect();
  let customerRegistration;
  let registrationPromise;
  let registrationTimedOut = false;
  let registrationTimeoutHandle;
  try {
    await registrationLockHolder.query('BEGIN');
    await registrationLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    registrationPromise = request('POST', '/api/client/register', { body: customerRegistrationBody });
    customerRegistration = await Promise.race([
      registrationPromise,
      new Promise((_, reject) => {
        registrationTimeoutHandle = setTimeout(() => reject(new Error('Customer registration waited on the legacy global advisory lock.')), 5000);
        registrationTimeoutHandle.unref?.();
      })
    ]).catch(error => { registrationTimedOut = true; throw error; });
  } finally {
    clearTimeout(registrationTimeoutHandle);
    await registrationLockHolder.query('ROLLBACK').catch(() => {});
    await registrationLockHolder.end();
  }
  if (registrationTimedOut) {
    customerRegistration = await registrationPromise;
    if (customerRegistration.data.user?.id) syntheticIds.push(customerRegistration.data.user.id);
    throw new Error('Customer registration waited on the legacy global advisory lock.');
  }
  assert(customerRegistration.status === 201, `Synthetic customer registration failed with ${customerRegistration.status}.`);
  assert(customerRegistration.data.user?.role === 'client', 'Client registration request could not escalate its role to Owner.');
  const customerId = customerRegistration.data.user.id;
  syntheticIds.push(customerId);
  const duplicateCustomerRegistration = await request('POST', '/api/client/register', { body: customerRegistrationBody });
  assert(duplicateCustomerRegistration.status === 409, 'Customer registration allowed a duplicate email.');
  const referralCustomerEmail = `pg_referral_customer_${testSuffix}@example.test`;
  const referralCustomerRegistration = await request('POST', '/api/client/register', {
    body: { ...customerRegistrationBody, name: 'Synthetic Referral Customer', email: referralCustomerEmail },
    cookie: `zezo_ref=${referralCode}`
  });
  assert(referralCustomerRegistration.status === 201 && referralCustomerRegistration.data.user?.role === 'client',
    `Synthetic referral customer registration failed with ${referralCustomerRegistration.status}.`);
  const referralCustomerId = referralCustomerRegistration.data.user.id;
  syntheticIds.push(referralCustomerId);
  const customerReferral = await client.query(`SELECT data ->> 'referralUserId' AS referrer_id, data ->> 'referralCode' AS referral_code FROM user_accounts WHERE id = $1`, [referralCustomerId]);
  assert(customerReferral.rows[0]?.referrer_id === referralUserId && customerReferral.rows[0]?.referral_code === referralCode,
    'Customer registration did not preserve the marketing referral attribution.');
  const persistedRegistration = await client.query(`
    SELECT
      (SELECT count(*)::int FROM user_accounts WHERE email = $1) AS account_count,
      (SELECT count(*)::int FROM outbox_messages WHERE recipient = $1 AND data ->> 'kind' = 'client_email_verification') AS verification_count,
      (SELECT count(*)::int FROM audit_entries WHERE "actorId" = $2 AND action = 'client_registered') AS audit_count,
      (SELECT count(*)::int FROM auth_sessions WHERE "userId" = $2) AS session_count
  `, [customerEmail, customerId]);
  const expectedVerificationCount = customerRegistration.data.verificationRequired ? 1 : 0;
  const expectedRegistrationSessionCount = customerRegistration.data.verificationRequired ? 0 : 1;
  assert(Number(persistedRegistration.rows[0].account_count) === 1 && Number(persistedRegistration.rows[0].verification_count) === expectedVerificationCount &&
    Number(persistedRegistration.rows[0].audit_count) === 1 && Number(persistedRegistration.rows[0].session_count) === expectedRegistrationSessionCount,
    'Customer account, expected verification message, audit, or session was not saved exactly once.');
  let customerCookie = cookieFrom(customerRegistration);
  if (customerRegistration.data.verificationRequired) {
    const verificationMessage = await client.query("SELECT data ->> 'text' AS text FROM outbox_messages WHERE recipient = $1 AND data ->> 'kind' = 'client_email_verification' LIMIT 1", [customerEmail]);
    const verificationTokenMatch = /verifyEmail=([^\s]+)/.exec(verificationMessage.rows[0]?.text || '');
    assert(verificationTokenMatch, 'New customer verification message did not contain a verification link.');
    const verified = await request('POST', '/api/auth/verify-email', { body: { token: decodeURIComponent(verificationTokenMatch[1]) } });
    assert(verified.status === 200, `Customer verification did not finish (${verified.status}).`);
    customerCookie = cookieFrom(verified);
  }
  const customerDashboard = await request('GET', '/api/dashboard', { cookie: customerCookie });
  assert(customerDashboard.status === 200 && customerDashboard.data.user?.role === 'client', 'Customer session did not persist between requests.');
  results.push('customer registration bypasses legacy global lock, preserves referral, prevents duplicates, and atomically saves account/audit/session/verification state');

  await request('POST', '/api/auth/logout', { cookie: customerCookie });
  customerCookie = '';
  const customerLogin = await request('POST', '/api/auth/login', {
    body: { username: customerEmail, password: customerPassword, accountType: 'client' }
  });
  assert(customerLogin.status === 200, `Customer login after logout failed with ${customerLogin.status}.`);
  customerCookie = cookieFrom(customerLogin);
  const customerDashboardAfterLogin = await request('GET', '/api/dashboard', { cookie: customerCookie });
  assert(customerDashboardAfterLogin.status === 200 && customerDashboardAfterLogin.data.user?.email === customerEmail, 'Customer profile did not survive logout and login.');
  results.push('customer logout, login, and profile recovery');

  const employees = {};
  for (const role of ['order_manager', 'marketer', 'developer', 'hr_manager', 'marketing_manager']) {
    const email = `pg_${role}_${testSuffix}@example.test`;
    const inviteRequest = () => request('POST', '/api/admin/invite', {
      body: { name: `Synthetic ${role}`, username: `pg_${role}_${testSuffix}`, email, role }, cookie: ownerCookie
    });
    let invite;
    if (role === 'order_manager') {
      const legacyLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await legacyLockHolder.connect();
      try {
        await legacyLockHolder.query('BEGIN');
        await legacyLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
        const invitationStartedAt = Date.now();
        const concurrentInvites = await Promise.race([
          Promise.all([inviteRequest, inviteRequest].map(async requestInvite => {
            const startedAt = Date.now();
            const result = await requestInvite();
            return { ...result, durationMs: Date.now() - startedAt };
          })),
          new Promise(resolve => setTimeout(() => resolve(null), 1200))
        ]);
        if (concurrentInvites) {
          invite = concurrentInvites.find(value => value.status === 201);
          assert(Boolean(invite) && concurrentInvites.filter(value => value.status === 409).length === 1,
            'Concurrent duplicate staff invitations must produce exactly one invitation and one conflict.');
          console.log(`[SCOPED_API_TIMING] ${JSON.stringify({ path: '/api/admin/invite', method: 'POST', concurrency: 2, totalMs: Date.now() - invitationStartedAt, responses: concurrentInvites.map(({ status, durationMs }) => ({ status, durationMs })) })}`);
        }
      } finally {
        await legacyLockHolder.query('ROLLBACK').catch(() => {});
        await legacyLockHolder.end();
      }
      assert(invite?.status === 201, 'Owner invitation must complete without waiting on the legacy global PostgreSQL lock.');
      results.push('authorized team invitation completed while the legacy global PostgreSQL lock was held; concurrent duplicate invitations produced one account');
    } else invite = await inviteRequest();
    assert(invite.status === 201 && invite.data.activationToken, `Owner invitation for ${role} failed with ${invite.status}.`);
    const invitationRows = await client.query(
      `SELECT i.status, i.email, u.active, u.data->>'activationHash' AS activation_hash,
        o.state AS outbox_state, o.data->>'kind' AS outbox_kind
       FROM employee_invitations i
       JOIN user_accounts u ON u.id = i.data->>'employeeId'
       LEFT JOIN outbox_messages o ON o.recipient = i.email AND o.data->>'kind' = 'team_invitation'
       WHERE i.id = $1`,
      [`invitation_${invite.data.user.id}`]
    );
    assert(invitationRows.rowCount === 1 && invitationRows.rows[0].status === 'pending' && invitationRows.rows[0].active === false &&
      /^[a-f0-9]{64}$/.test(invitationRows.rows[0].activation_hash || '') && invitationRows.rows[0].outbox_state === 'pending' && invitationRows.rows[0].outbox_kind === 'team_invitation',
      `Invitation for ${role} was not saved atomically with its hashed activation token and durable outbox message.`);
    const duplicateInvite = await inviteRequest();
    assert(duplicateInvite.status === 409, `Replaying the same ${role} invitation must not create a duplicate account.`);
    const activation = await request('POST', '/api/auth/activate', {
      body: { token: invite.data.activationToken, password: `Employee!${role}${testSuffix}Long` }
    });
    assert(activation.status === 200 && activation.data.user?.role === role, `Employee activation for ${role} failed with ${activation.status}.`);
    const employeeCookie = cookieFrom(activation);
    if (['order_manager', 'hr_manager', 'marketing_manager'].includes(role)) {
      const mfaSetup = await request('GET', '/api/auth/mfa/setup', { cookie: employeeCookie });
      assert(mfaSetup.status === 200 && mfaSetup.data.secret, `MFA setup for ${role} failed with ${mfaSetup.status}.`);
      const mfaEnabled = await request('POST', '/api/auth/mfa/enable', {
        body: { code: currentTotp(mfaSetup.data.secret) }, cookie: employeeCookie
      });
      assert(mfaEnabled.status === 200, `MFA enable for ${role} failed with ${mfaEnabled.status}.`);
    }
    employees[role] = { id: activation.data.user.id, email, cookie: employeeCookie };
    employeeIds.push(activation.data.user.id);
    syntheticIds.push(activation.data.user.id);
  }
  for (const role of ['order_manager', 'marketer', 'developer', 'hr_manager', 'marketing_manager']) {
    const dashboard = await request('GET', '/api/dashboard', { cookie: employees[role].cookie });
    assert(dashboard.status === 200 && dashboard.data.role === role, `${role} dashboard mismatch: HTTP ${dashboard.status}, response role ${dashboard.data.role ?? 'missing'}, error ${dashboard.data.error ?? 'none'}.`);
  }
  const marketerHome = await request('GET', '/api/dashboard', { cookie: employees.marketer.cookie });
  assert(Boolean(marketerHome.data.referralLink) && marketerHome.data.users === undefined, 'Marketer dashboard exposed team data or omitted its own referral link.');
  const hrPaymentDenied = await request('POST', '/api/admin/payment', {
    body: { leadId: 'synthetic-not-found', amount: 1, kind: 'payment', verified: true, idempotencyKey: `denied_${testSuffix}` }, cookie: employees.hr_manager.cookie
  });
  assert(hrPaymentDenied.status === 403, 'HR manager was able to access the owner-only payment endpoint.');
  const marketerInviteDenied = await request('POST', '/api/admin/invite', {
    body: { name: 'Unauthorized synthetic invite', username: `bad_${testSuffix}`, email: `bad_${testSuffix}@example.test`, role: 'admin' }, cookie: employees.marketer.cookie
  });
  assert(marketerInviteDenied.status === 403, 'Marketer was able to create a staff invitation.');
  results.push('secure employee invitations, activation, and role-specific dashboards for order manager, HR, marketer, and developer');
  results.push('server-side denial of owner-only payments for HR and staff invitations for marketers');

  const permissionsLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await permissionsLockHolder.connect();
  let permissionChange;
  const permissionStartedAt = Date.now();
  try {
    await permissionsLockHolder.query('BEGIN');
    await permissionsLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    permissionChange = await Promise.race([
      request('PATCH', `/api/admin/permissions/${encodeURIComponent(employees.marketer.id)}`, {
        body: { role: 'marketer', active: true, permissions: { 'conversations.read': 'all' } }, cookie: ownerCookie
      }),
      new Promise(resolve => setTimeout(async () => {
        const activity = await client.query(`
          SELECT wait_event_type, wait_event, left(query, 140) AS query
          FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
            AND backend_type = 'client backend'
          ORDER BY query_start DESC LIMIT 8
        `).catch(() => ({ rows: [] }));
        resolve({ timedOut: true, activity: activity.rows });
      }, 1200))
    ]);
  } finally {
    await permissionsLockHolder.query('ROLLBACK').catch(() => {});
    await permissionsLockHolder.end();
  }
  assert(permissionChange?.status === 200,
    `Owner permission changes must not wait behind the legacy global PostgreSQL advisory lock (received ${permissionChange?.status ?? (permissionChange?.timedOut ? 'timeout' : 'no response')}${permissionChange ? `: ${JSON.stringify(permissionChange.data || permissionChange.activity || {})}` : ''}).`);
  console.log(`[SCOPED_API_TIMING] ${JSON.stringify({ path: `/api/admin/permissions/${encodeURIComponent(employees.marketer.id)}`, method: 'PATCH', concurrency: 1, apiMs: Date.now() - permissionStartedAt, globalAdvisoryLockHeld: true })}`);
  assert(permissionChange.data.user?.effectivePermissions?.['conversations.read'] === 'all', 'Permission changes were not effective in the saved response.');
  const permissionPersisted = await client.query(`
    SELECT u.role, u.active, u.data->'permissionOverrides'->>'conversations.read' AS conversation_scope,
      (SELECT count(*)::int FROM auth_sessions s WHERE s."userId" = u.id) AS sessions,
      (SELECT count(*)::int FROM audit_entries a WHERE a."targetId" = u.id AND a.action = 'employee_permissions_updated') AS audit_count
    FROM user_accounts u WHERE u.id = $1
  `, [employees.marketer.id]);
  assert(permissionPersisted.rows[0]?.role === 'marketer' && permissionPersisted.rows[0].active === true &&
    permissionPersisted.rows[0].conversation_scope === 'all' && Number(permissionPersisted.rows[0].sessions) === 0 &&
    Number(permissionPersisted.rows[0].audit_count) === 1,
  'Scoped permission update must save one row, revoke prior sessions, and append one audit entry atomically.');
  const ownerEscalation = await request('PATCH', `/api/admin/permissions/${encodeURIComponent(employees.marketer.id)}`, {
    body: { role: 'admin', active: true, permissions: {} }, cookie: ownerCookie
  });
  assert(ownerEscalation.status === 400, 'The scoped permission update must reject Owner role assignment.');
  const protectOwner = await request('PATCH', `/api/admin/permissions/${encodeURIComponent(ownerId)}`, {
    body: { role: 'marketer', active: false, permissions: {} }, cookie: ownerCookie
  });
  assert(protectOwner.status === 409, 'The permission manager must preserve Owner protection.');
  const refreshedMarketerLogin = await request('POST', '/api/auth/login', {
    body: { username: `pg_marketer_${testSuffix}`, password: `Employee!marketer${testSuffix}Long`, accountType: 'employee' }
  });
  assert(refreshedMarketerLogin.status === 200, 'Marketer could not establish a fresh session after permission changes revoked old sessions.');
  employees.marketer.cookie = cookieFrom(refreshedMarketerLogin);
  results.push('Owner permission changes use row-scoped transactions, remain unblocked by the legacy global lock, apply immediately, revoke sessions, audit once, and reject Owner escalation');

  const visitorId = `phase3visitor${testSuffix}`;
  const trackedVisit = await request('POST', '/api/referral-events', {
    body: { code: marketerHome.data.user.referralCode, type: 'visit', visitorId, eventId: `phase3event${testSuffix}` }
  });
  assert(trackedVisit.status === 202, `Synthetic referral event was rejected with ${trackedVisit.status}.`);
  const visitorHash = createHash('sha256').update(visitorId).digest('hex');
  const trackedRows = await client.query('SELECT (SELECT count(*) FROM referral_events WHERE "visitorHash" = $1) + (SELECT count(*) FROM referral_attributions WHERE "visitorHash" = $1) AS count', [visitorHash]);
  assert(Number(trackedRows.rows[0].count) === 2, 'Synthetic visit and attribution were not saved to PostgreSQL.');
  const revokedConsent = await request('POST', '/api/referral-consent/revoke', { body: { visitorId } });
  assert(revokedConsent.status === 202, `Visitor consent revocation failed with ${revokedConsent.status}.`);
  const revokedRows = await client.query('SELECT (SELECT count(*) FROM referral_events WHERE "visitorHash" = $1) + (SELECT count(*) FROM referral_attributions WHERE "visitorHash" = $1) AS count', [visitorHash]);
  assert(Number(revokedRows.rows[0].count) === 0, 'Consent revocation did not delete the visitor tracking rows from PostgreSQL.');
  results.push('referral visit and attribution storage, followed by consent revocation deletion');

  const createdConversation = await request('POST', '/api/conversations', {
    body: { templateId: 'web-copper-table', message: 'Synthetic question about customizing the restaurant template.', source: 'postgres_api_test' },
    cookie: customerCookie
  });
  assert(createdConversation.status === 201, `Customer conversation creation failed with ${createdConversation.status}.`);
  syntheticConversationId = createdConversation.data.conversation.id;
  results.push('customer template conversation saved and reloaded from PostgreSQL');

  const assignedConversation = await request('PATCH', `/api/conversations/${syntheticConversationId}`, {
    body: { assignedUserId: employees.order_manager.id }, cookie: ownerCookie
  });
  assert(assignedConversation.status === 200, `Owner could not assign the test conversation (${assignedConversation.status}).`);
  const orderManagerDashboard = await request('GET', '/api/dashboard', { cookie: employees.order_manager.cookie });
  assert(orderManagerDashboard.status === 200 && orderManagerDashboard.data.conversations?.some(row => row.id === syntheticConversationId), 'Assigned order manager could not read its conversation.');
  const marketerConversationAccess = await request('GET', `/api/conversations/${syntheticConversationId}`, { cookie: employees.marketer.cookie });
  assert(marketerConversationAccess.status === 404, 'Unassigned marketer read a customer conversation outside the role scope.');
  results.push('server-enforced conversation assignment access and denial for an unrelated marketer');

  const ownerConversations = await request('GET', '/api/conversations', { cookie: ownerCookie });
  assert(ownerConversations.status === 200 && ownerConversations.data.conversations?.some(row => row.id === syntheticConversationId), 'Owner could not read the persisted customer conversation.');
  const conversationLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await conversationLockHolder.connect();
  let coreConversationReads;
  try {
    await conversationLockHolder.query('BEGIN');
    await conversationLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    coreConversationReads = await Promise.race([
      Promise.all([
        request('GET', '/api/conversations', { cookie: ownerCookie }),
        request('GET', `/api/conversations/${syntheticConversationId}`, { cookie: ownerCookie })
      ]).then(values => ({ done: true, values })),
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 1000))
    ]);
  } finally {
    await conversationLockHolder.query('ROLLBACK').catch(() => {});
    await conversationLockHolder.end();
  }
  assert(coreConversationReads?.done && coreConversationReads.values[0].status === 200 && coreConversationReads.values[0].data.conversations?.some(row => row.id === syntheticConversationId) && coreConversationReads.values[1].status === 200,
    'Authenticated conversation list/detail reads still wait on the global advisory lock or lost their access checks.');
  results.push('authenticated conversation list and detail reads bypass the global advisory lock while preserving authorization');
  const managementLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await managementLockHolder.connect();
  let managementDashboardsWhileLocked;
  try {
    await managementLockHolder.query('BEGIN');
    await managementLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    managementDashboardsWhileLocked = await Promise.race([
      Promise.all([
        request('GET', '/api/dashboard', { cookie: ownerCookie }),
        request('GET', '/api/dashboard', { cookie: employees.order_manager.cookie }),
        request('GET', '/api/dashboard', { cookie: employees.hr_manager.cookie }),
        request('GET', '/api/dashboard', { cookie: employees.marketer.cookie })
      ]).then(values => ({ done: true, values })),
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 2500))
    ]);
  } finally {
    await managementLockHolder.query('ROLLBACK').catch(() => {});
    await managementLockHolder.end();
  }
  assert(managementDashboardsWhileLocked?.done && managementDashboardsWhileLocked.values.every(row => row.status === 200), 'Owner or manager dashboards waited on the global advisory lock.');
  assert(managementDashboardsWhileLocked.values[1].data.conversations?.some(row => row.id === syntheticConversationId), 'Order Manager lost the assigned conversation in its scoped dashboard.');
  assert(!managementDashboardsWhileLocked.values[1].data.users && !managementDashboardsWhileLocked.values[1].data.financeSummary, 'Order Manager dashboard exposed owner-only data.');
  results.push('Owner and management dashboards bypass the global advisory lock; Order Manager dashboard remains scoped');
  const ownerReply = await request('POST', `/api/conversations/${syntheticConversationId}/messages`, {
    body: { message: 'Synthetic ZEZO reply saved for the database integration test.' }, cookie: ownerCookie
  });
  assert(ownerReply.status === 201, `Owner conversation reply failed with ${ownerReply.status}.`);
  const attachmentBytes = Buffer.from('%PDF-1.4 synthetic test attachment');
  const uploadedAttachment = await request('POST', `/api/conversations/${syntheticConversationId}/messages`, {
    ...multipartForm({ message: 'A synthetic attachment for protected PostgreSQL storage.' }, { name: 'synthetic-note.pdf', type: 'application/pdf', content: attachmentBytes }, `zezo_${testSuffix}`),
    cookie: customerCookie
  });
  assert(uploadedAttachment.status === 201, `Customer attachment upload failed with ${uploadedAttachment.status}.`);
  const attachmentRow = await client.query('SELECT id, "ownerId", "fileName", content FROM stored_attachments WHERE "fileName" = $1', ['synthetic-note.pdf']);
  assert(attachmentRow.rowCount === 1 && attachmentRow.rows[0].ownerId === customerId && attachmentRow.rows[0].content.equals(attachmentBytes), 'Synthetic attachment bytes or owner were not persisted in PostgreSQL.');
  const customerAttachment = await request('GET', `/api/conversations/${syntheticConversationId}/files/0`, { cookie: customerCookie });
  assert(customerAttachment.status === 200 && customerAttachment.bytes.equals(attachmentBytes), 'Customer could not download the stored conversation attachment.');
  const marketerAttachment = await request('GET', `/api/conversations/${syntheticConversationId}/files/0`, { cookie: employees.marketer.cookie });
  assert(marketerAttachment.status === 404, 'Unassigned marketer downloaded a protected customer attachment.');
  const exactLimitAttachment = Buffer.alloc(4 * 1024 * 1024, 0x61);
  exactLimitAttachment.write('%PDF-1.7\n');
  const exactLimitUpload = await request('POST', `/api/conversations/${syntheticConversationId}/messages`, {
    ...multipartForm({ message: 'Synthetic maximum-size attachment boundary test.' }, { name: 'synthetic-limit.pdf', type: 'application/pdf', content: exactLimitAttachment }, `zezo_limit_${testSuffix}`),
    cookie: customerCookie
  });
  assert(exactLimitUpload.status === 201, `A valid 4 MB synthetic attachment was rejected with ${exactLimitUpload.status}.`);
  const limitAttachmentRow = await client.query('SELECT "sizeBytes" FROM stored_attachments WHERE "fileName" = $1', ['synthetic-limit.pdf']);
  assert(limitAttachmentRow.rowCount === 1 && Number(limitAttachmentRow.rows[0].sizeBytes) === 4 * 1024 * 1024, 'The exact 4 MB attachment was not persisted correctly.');
  const oversizeAttachment = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
  oversizeAttachment.write('%PDF-1.7\n');
  let oversizeStatus = 0;
  try {
    const oversizeUpload = await request('POST', `/api/conversations/${syntheticConversationId}/messages`, {
      ...multipartForm({ message: 'Synthetic oversized attachment boundary test.' }, { name: 'synthetic-oversize.pdf', type: 'application/pdf', content: oversizeAttachment }, `zezo_oversize_${testSuffix}`),
      cookie: customerCookie
    });
    oversizeStatus = oversizeUpload.status;
  } catch (error) { oversizeStatus = error.status || 500; }
  assert(oversizeStatus === 400, `An attachment larger than 4 MB should be rejected, got ${oversizeStatus}.`);
  const oversizedRow = await client.query('SELECT count(*)::int AS count FROM stored_attachments WHERE "fileName" = $1', ['synthetic-oversize.pdf']);
  assert(Number(oversizedRow.rows[0].count) === 0, 'Oversized attachment bytes were persisted.');
  results.push('BYTEA attachment access controls plus exact 4 MB accepted / 4 MB + 1 byte rejected boundary');
  const quoteLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await quoteLockHolder.connect();
  let quoteWhileLocked;
  let acceptWhileLocked;
  try {
    await quoteLockHolder.query('BEGIN');
    await quoteLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    quoteWhileLocked = await Promise.race([
      request('POST', `/api/conversations/${syntheticConversationId}/quote`, {
        body: { amount: 200, scope: 'Single landing page with the agreed demo layout.', included: 'One responsive page and contact details.' }, cookie: ownerCookie
      }).then(value => ({ done: true, value })),
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 1500))
    ]);
    if (quoteWhileLocked?.done && quoteWhileLocked.value.status === 201) {
      const staffAcceptance = await request('POST', `/api/conversations/${syntheticConversationId}/accept-quote`, { cookie: employees.order_manager.cookie });
      assert(staffAcceptance.status === 403, 'An Order Manager must not accept a quote on behalf of the customer.');
      acceptWhileLocked = await Promise.race([
        request('POST', `/api/conversations/${syntheticConversationId}/accept-quote`, { cookie: customerCookie }).then(value => ({ done: true, value })),
        new Promise(resolve => setTimeout(() => resolve({ done: false }), 1500))
      ]);
    }
  } finally {
    await quoteLockHolder.query('ROLLBACK').catch(() => {});
    await quoteLockHolder.end();
  }
  assert(quoteWhileLocked?.done && quoteWhileLocked.value.status === 201 && quoteWhileLocked.value.data.conversation.quote?.amount === 200, 'Owner quote creation queued behind the global advisory lock.');
  assert(acceptWhileLocked?.done && acceptWhileLocked.value.status === 200, 'Customer quote acceptance queued behind the global advisory lock.');
  const acceptedQuoteRow = await client.query('SELECT state FROM quotes WHERE "conversationId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [syntheticConversationId]);
  const acceptedQuoteConversation = await client.query("SELECT data -> 'agreedPriceSnapshot' AS snapshot FROM conversations WHERE id = $1", [syntheticConversationId]);
  assert(acceptedQuoteRow.rows[0]?.state === 'accepted' && Number(acceptedQuoteConversation.rows[0]?.snapshot?.amount) === 200, 'Quote acceptance was not committed atomically with its immutable price snapshot.');
  const repeatedQuoteAcceptances = await Promise.all(Array.from({ length: 4 }, () => request('POST', `/api/conversations/${syntheticConversationId}/accept-quote`, { cookie: customerCookie })));
  assert(repeatedQuoteAcceptances.every(row => row.status === 409), 'An already accepted quote was accepted again by a duplicate request.');
  const acceptedMessageCount = await client.query(`SELECT count(*)::int AS count FROM conversation_messages WHERE "conversationId" = $1 AND body LIKE 'تم قبول عرض السعر%'`, [syntheticConversationId]);
  assert(Number(acceptedMessageCount.rows[0].count) === 1, 'Concurrent repeated acceptances wrote more than one acceptance message.');
  results.push('two-account conversation, protected attachments, quote and acceptance complete under the legacy lock using row-scoped PostgreSQL transactions');

  const officialOrder = await request('POST', '/api/leads', {
    body: {
      service: 'web', category: 'site', details: 'Synthetic landing page project request for PostgreSQL persistence checks.',
      budget: '100–300 ILS', consent: 'true', phone: '+971501234567', whatsappCountryCode: '+971',
      whatsappLocalNumber: '501234567', templateId: 'web-copper-table', templateAction: 'customize',
      conversationId: syntheticConversationId, referralCode: marketerHome.data.user.referralCode, lang: 'en'
    }, cookie: customerCookie
  });
  assert(officialOrder.status === 201 && officialOrder.data.id, `Customer official order creation failed with ${officialOrder.status}.`);
  syntheticLeadId = officialOrder.data.id;
  const publicTrackPath = `/api/track?token=${encodeURIComponent(officialOrder.data.trackingToken)}&lang=en`;
  const publicTrack = await request('GET', publicTrackPath);
  assert(publicTrack.status === 200 && publicTrack.data.status && publicTrack.data.service === 'web' && !('email' in publicTrack.data) && !('phone' in publicTrack.data), 'Lock-free tracking read did not return the customer-safe project status fields.');
  const trackLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await trackLockHolder.connect();
  let trackWhileLocked;
  try {
    await trackLockHolder.query('BEGIN');
    await trackLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    const pendingTrackRead = request('GET', publicTrackPath).then(value => ({ done: true, value }));
    trackWhileLocked = await Promise.race([
      pendingTrackRead,
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 800))
    ]);
  } finally {
    await trackLockHolder.query('ROLLBACK').catch(() => {});
    await trackLockHolder.end();
  }
  assert(trackWhileLocked?.done === true && trackWhileLocked.value.status === 200, 'Public tracking read queued behind the global advisory lock.');
  results.push('tracking-token status read is lock-free and exposes only the customer-safe status fields');
  const orderDashboard = await request('GET', '/api/dashboard', { cookie: customerCookie });
  assert(orderDashboard.status === 200 && orderDashboard.data.orders?.some(row => row.id === syntheticLeadId), 'Official order was not available after reloading from PostgreSQL.');
  const ownerAfterOrder = await request('GET', '/api/dashboard', { cookie: ownerCookie });
  assert(ownerAfterOrder.status === 200 && ownerAfterOrder.data.leads?.some(row => row.id === syntheticLeadId), 'Owner could not read the persisted official order.');
  const crmLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await crmLockHolder.connect();
  let crmWhileLocked;
  try {
    await crmLockHolder.query('BEGIN');
    await crmLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    crmWhileLocked = await Promise.race([
      Promise.all([
        request('GET', '/api/crm', { cookie: ownerCookie }),
        request('GET', '/api/dashboard', { cookie: customerCookie })
      ]).then(values => ({ done: true, values })),
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 1000))
    ]);
  } finally {
    await crmLockHolder.query('ROLLBACK').catch(() => {});
    await crmLockHolder.end();
  }
  assert(crmWhileLocked?.done && crmWhileLocked.values[0].status === 200 && crmWhileLocked.values[0].data.items?.some(row => row.orders?.some(order => order.id === syntheticLeadId)) && crmWhileLocked.values[1].status === 200 && crmWhileLocked.values[1].data.orders?.some(row => row.id === syntheticLeadId),
    'Targeted CRM or client dashboard read waited on the global advisory lock or omitted the persisted order.');
  results.push('Owner CRM and client dashboard read normalized records without the global advisory lock');
  results.push('official customer order linked to conversation and visible through CRM dashboards');

  const assignment = await request('PATCH', `/api/projects/${syntheticLeadId}/assignment`, {
    body: { developerUserId: employees.developer.id, developerDueDate: '2026-12-01' }, cookie: ownerCookie
  });
  assert(assignment.status === 200, `Owner could not assign the synthetic project (${assignment.status}).`);
  const developerDashboard = await request('GET', '/api/dashboard', { cookie: employees.developer.cookie });
  assert(developerDashboard.status === 200 && developerDashboard.data.projects?.some(project => project.id === syntheticLeadId), 'Developer did not see the assigned project.');
  const employeeLockHolder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await employeeLockHolder.connect();
  let developerDashboardWhileLocked;
  try {
    await employeeLockHolder.query('BEGIN');
    await employeeLockHolder.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    developerDashboardWhileLocked = await Promise.race([
      request('GET', '/api/dashboard', { cookie: employees.developer.cookie }).then(value => ({ done: true, value })),
      new Promise(resolve => setTimeout(() => resolve({ done: false }), 1000))
    ]);
  } finally {
    await employeeLockHolder.query('ROLLBACK').catch(() => {});
    await employeeLockHolder.end();
  }
  assert(developerDashboardWhileLocked?.done && developerDashboardWhileLocked.value.status === 200 && developerDashboardWhileLocked.value.data.projects?.some(project => project.id === syntheticLeadId),
    'Developer dashboard still waited on the global advisory lock or lost the assigned project.');
  assert(!developerDashboardWhileLocked.value.data.projects?.some(project => project.id !== syntheticLeadId), 'Developer dashboard exposed another employee project.');
  results.push('developer dashboard reads scoped project, commission, wallet, and referral data without the global advisory lock');
  const developerDecision = await request('POST', `/api/developer/projects/${syntheticLeadId}/decision`, {
    body: { decision: 'accept', note: 'Synthetic acceptance for the database test.' }, cookie: employees.developer.cookie
  });
  assert(developerDecision.status === 200, `Developer could not accept the assigned project (${developerDecision.status}).`);
  const idempotencyKey = `synthetic_${testSuffix}_payment`;
  const payment = await request('POST', '/api/admin/payment', {
    body: { leadId: syntheticLeadId, amount: 200, kind: 'payment', verified: true, idempotencyKey }, cookie: ownerCookie
  });
  assert(payment.status === 201 && payment.data.lead?.paidTotal === 200, `Verified synthetic payment failed with ${payment.status}.`);
  const duplicatePayment = await request('POST', '/api/admin/payment', {
    body: { leadId: syntheticLeadId, amount: 200, kind: 'payment', verified: true, idempotencyKey }, cookie: ownerCookie
  });
  assert(duplicatePayment.status === 200 && duplicatePayment.data.duplicate === true, 'Payment idempotency did not return the existing payment.');
  const concurrentDuplicates = await Promise.all(Array.from({ length: 8 }, () => request('POST', '/api/admin/payment', {
    body: { leadId: syntheticLeadId, amount: 200, kind: 'payment', verified: true, idempotencyKey }, cookie: ownerCookie
  })));
  assert(concurrentDuplicates.every(result => result.status === 200 && result.data.duplicate === true), 'Concurrent duplicate payment requests were not idempotent.');
  const paymentLatency = concurrentDuplicates.map(result => result.durationMs).sort((a, b) => a - b);
  const percentile = fraction => Number(paymentLatency[Math.max(0, Math.ceil(fraction * paymentLatency.length) - 1)].toFixed(1));
  const paymentConcurrency = {
    route: 'POST /api/admin/payment', requests: concurrentDuplicates.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: Number(paymentLatency.at(-1).toFixed(1)),
    nonDuplicateResponses: concurrentDuplicates.filter(result => !result.data.duplicate).length,
    errors: concurrentDuplicates.filter(result => result.status !== 200).length
  };
  const duplicateRows = await client.query('SELECT count(*)::int AS count FROM payments WHERE "requestId" = $1 AND "idempotencyKey" = $2', [syntheticLeadId, idempotencyKey]);
  assert(Number(duplicateRows.rows[0].count) === 1, 'Concurrent payment requests created more than one payment row.');
  const normalizedCommissions = await client.query('SELECT kind, "ratePercent"::float8 AS rate, amount::float8 AS amount, status FROM commissions WHERE "requestId" = $1 ORDER BY kind', [syntheticLeadId]);
  assert(normalizedCommissions.rowCount === 2, 'A project must retain one marketing and one developer commission record.');
  assert(normalizedCommissions.rows.some(row => row.kind === 'referral' && row.rate === 15 && row.amount === 30), 'The normalized Rookie commission row is missing or incorrect.');
  assert(normalizedCommissions.rows.some(row => row.kind === 'developer' && row.rate === 25 && row.amount === 0), 'Developer commission must stay unearned before delivery review and completion.');
  console.log(`[FINANCE_CONCURRENCY] ${JSON.stringify(paymentConcurrency)}`);
  const developerFile = Buffer.from('%PDF-1.4 synthetic project delivery');
  const developerUpload = await request('POST', `/api/developer/projects/${syntheticLeadId}/files`, {
    ...multipartForm({}, { name: 'synthetic-delivery.pdf', type: 'application/pdf', content: developerFile }, `zezo_delivery_${testSuffix}`),
    cookie: employees.developer.cookie
  });
  assert(developerUpload.status === 201, `Developer could not upload synthetic delivery (${developerUpload.status}).`);
  const developerSubmit = await request('PATCH', `/api/developer/projects/${syntheticLeadId}`, {
    body: { status: 'review_requested', note: 'Synthetic delivery submitted for review.' }, cookie: employees.developer.cookie
  });
  assert(developerSubmit.status === 200, `Developer could not submit the delivery for review (${developerSubmit.status}).`);
  const ownerReview = await request('POST', `/api/admin/projects/${syntheticLeadId}/review`, {
    body: { decision: 'approved', note: 'Synthetic QA review passed.' }, cookie: ownerCookie
  });
  assert(ownerReview.status === 200 && ownerReview.data.project?.reviewNote === 'Synthetic QA review passed.', `Owner delivery review failed with ${ownerReview.status}.`);
  const projectCompletion = await request('PATCH', `/api/admin/projects/${syntheticLeadId}/stage`, {
    body: { stage: 'completed', note: 'Synthetic project delivered.' }, cookie: ownerCookie
  });
  assert(projectCompletion.status === 200, `Owner could not complete the synthetic project (${projectCompletion.status}).`);
  const developerFinalDashboard = await request('GET', '/api/dashboard', { cookie: employees.developer.cookie });
  const completedDeveloperProject = developerFinalDashboard.data.projects?.find(project => project.id === syntheticLeadId);
  assert(Number(completedDeveloperProject?.commissionAmount) === 50 && Number(completedDeveloperProject?.developerCommissionRate) === 25, 'Developer execution commission was not calculated as 25% of the 200 ILS verified collection.');
  const finalCommissions = await client.query('SELECT kind, "ratePercent"::float8 AS rate, amount::float8 AS amount, status FROM commissions WHERE "requestId" = $1 ORDER BY kind', [syntheticLeadId]);
  assert(finalCommissions.rowCount === 2, 'Project completion must not duplicate either commission.');
  assert(finalCommissions.rows.some(row => row.kind === 'developer' && row.rate === 25 && row.amount === 50 && row.status === 'pending'), 'The normalized developer commission should accrue at 25% after delivery review and remain pending during the configured hold period.');
  assert(finalCommissions.rows.some(row => row.kind === 'referral' && row.rate === 15 && row.amount === 30), 'The normalized Rookie commission row changed during delivery completion.');
  const marketerAfterPayment = await request('GET', '/api/dashboard', { cookie: employees.marketer.cookie });
  assert(marketerAfterPayment.data.leads?.some(row => row.id === syntheticLeadId && Number(row.commissionAmount) === 30), 'Rookie marketing commission was not persisted at 15% of the paid 200 ILS project.');
  results.push(`concurrent duplicate payment requests remain idempotent (p50 ${paymentConcurrency.p50Ms}ms / p95 ${paymentConcurrency.p95Ms}ms; one payment row); normalized project commissions retain 25% developer (50 ILS) and 15% marketer (30 ILS) separately`);

  const storedConversation = await client.query('SELECT count(*)::int AS count FROM conversations WHERE id = $1', [syntheticConversationId]);
  const storedMessages = await client.query('SELECT count(*)::int AS count FROM conversation_messages WHERE "conversationId" = $1', [syntheticConversationId]);
  const storedQuote = await client.query('SELECT count(*)::int AS count FROM quotes WHERE "conversationId" = $1', [syntheticConversationId]);
  const storedRequest = await client.query('SELECT count(*)::int AS count FROM project_requests WHERE id = $1', [syntheticLeadId]);
  const storedPayment = await client.query('SELECT count(*)::int AS count FROM payments WHERE "requestId" = $1 AND "idempotencyKey" = $2', [syntheticLeadId, idempotencyKey]);
  const storedCommissions = await client.query('SELECT kind, amount FROM commissions WHERE "requestId" = $1 ORDER BY kind', [syntheticLeadId]);
  const storedProject = await client.query('SELECT count(*)::int AS count FROM projects WHERE "requestId" = $1', [syntheticLeadId]);
  const storedAssignment = await client.query('SELECT "commissionPercent", "expectedCommission" FROM project_assignments WHERE "projectId" = $1 AND "developerId" = $2', [`project_${syntheticLeadId}`, employees.developer.id]);
  const storedCrm = await client.query('SELECT count(*)::int AS count FROM crm_records WHERE data::text LIKE $1', [`%${syntheticLeadId}%`]);
  const storedRates = await client.query('SELECT count(*)::int AS count FROM rate_limit_buckets');
  const storedSetting = await client.query('SELECT count(*)::int AS count FROM app_settings WHERE key = $1', ['zezo-runtime']);
  assert(Number(storedConversation.rows[0].count) === 1 && Number(storedMessages.rows[0].count) >= 3 && Number(storedQuote.rows[0].count) === 1, 'Normalized conversation, message, or quote rows were not saved.');
  assert(Number(storedRequest.rows[0].count) === 1 && Number(storedPayment.rows[0].count) === 1, 'Normalized request/payment rows or idempotency storage are incorrect.');
  assert(storedCommissions.rows.some(row => row.kind === 'referral' && Number(row.amount) === 30), 'The normalized commission row does not preserve the marketer commission.');
  assert(Number(storedProject.rows[0].count) === 1 && storedAssignment.rowCount === 1 && Number(storedAssignment.rows[0].commissionPercent) === 25 && Number(storedAssignment.rows[0].expectedCommission) === 50, 'Normalized project assignment did not preserve the 25% / 50 ILS developer fee.');
  assert(Number(storedCrm.rows[0].count) > 0 && Number(storedRates.rows[0].count) > 0 && Number(storedSetting.rows[0].count) === 1, 'CRM, shared rate limits, or settings were not persisted to PostgreSQL.');
  results.push('conversation, message, quote, request, project, assignment, CRM, commissions, payment, rate-limit, and settings tables verified directly');

  const storedUsers = await client.query(
    'SELECT id, role FROM user_accounts WHERE id = ANY($1::text[]) ORDER BY role',
    [syntheticIds]
  );
  assert(storedUsers.rowCount === syntheticIds.length, 'Expected every synthetic Owner, referrer, customer, and employee in PostgreSQL user_accounts.');
  const storedSessions = await client.query(
    'SELECT id FROM auth_sessions WHERE "userId" = ANY($1::text[])',
    [syntheticIds]
  );
  assert(storedSessions.rowCount >= 2 && storedSessions.rows.every(row => /^[a-f0-9]{64}$/.test(row.id)), 'Expected only opaque SHA-256 session hashes persisted in PostgreSQL.');
  results.push('normalized account and hashed session rows persisted');

  const originalPrices = ownerDashboard.data.settings?.prices;
  const originalHoldDays = Number(ownerDashboard.data.settings?.commissionHoldDays ?? 14);
  assert(Array.isArray(originalPrices) && originalPrices.length > 0, 'Owner test fixture did not expose existing service prices.');
  const testHoldSetting = await request('POST', '/api/admin/pricing', {
    body: { prices: originalPrices, commissionHoldDays: 0 }, cookie: ownerCookie
  });
  assert(testHoldSetting.status === 200, `Could not make synthetic commissions eligible for withdrawal stress (${testHoldSetting.status}).`);

  try {
    const syntheticSettlement = await request('POST', `/api/admin/leads/${syntheticLeadId}/settlement`, {
      body: { contractAmount: 1000, projectCosts: 0, note: 'Synthetic financial concurrency test only.' }, cookie: ownerCookie
    });
    assert(syntheticSettlement.status === 201, `Synthetic settlement setup failed with ${syntheticSettlement.status}.`);

    const uniquePaymentRequests = await Promise.all(Array.from({ length: 12 }, (_, index) => request('POST', '/api/admin/payment', {
      body: {
        leadId: syntheticLeadId,
        amount: 100,
        kind: 'payment',
        verified: true,
        idempotencyKey: `stress_${testSuffix}_payment_${index}`
      }, cookie: ownerCookie
    })));
    const acceptedUniquePayments = uniquePaymentRequests.filter(result => result.status === 201);
    const rejectedBeyondBalance = uniquePaymentRequests.filter(result => result.status === 400);
    const unexpectedPaymentResponses = uniquePaymentRequests.filter(result => ![201, 400].includes(result.status));
    assert(acceptedUniquePayments.length === 8 && rejectedBeyondBalance.length === 4 && unexpectedPaymentResponses.length === 0,
      `Concurrent distinct payments did not stop at the remaining contract balance (accepted ${acceptedUniquePayments.length}, rejected ${rejectedBeyondBalance.length}, unexpected ${unexpectedPaymentResponses.length}).`);
    const uniquePaymentLatency = uniquePaymentRequests.map(result => result.durationMs).sort((a, b) => a - b);
    const stressPercentile = (values, fraction) => Number(values[Math.max(0, Math.ceil(fraction * values.length) - 1)].toFixed(1));
    const totalPaymentRows = await client.query('SELECT count(*)::int AS count FROM payments WHERE "requestId" = $1', [syntheticLeadId]);
    assert(Number(totalPaymentRows.rows[0].count) === 9, 'Distinct concurrent payment requests overpaid or duplicated the synthetic contract.');
    const stressCommissions = await client.query('SELECT kind, "ratePercent"::float8 AS rate, amount::float8 AS amount FROM commissions WHERE "requestId" = $1 ORDER BY kind', [syntheticLeadId]);
    assert(stressCommissions.rowCount === 2 && stressCommissions.rows.some(row => row.kind === 'referral' && row.rate === 15 && row.amount === 150) && stressCommissions.rows.some(row => row.kind === 'developer' && row.rate === 25 && row.amount === 250),
      'Concurrent distinct payments changed or duplicated the 15% referral / 25% developer commissions.');

    for (const role of ['marketer', 'developer']) {
      const profile = await request('PATCH', '/api/profile', {
        body: { email: employees[role].email, payoutHandle: `synthetic_${testSuffix}_${role}` }, cookie: employees[role].cookie
      });
      assert(profile.status === 200, `Could not configure a synthetic payout destination for ${role} (${profile.status}).`);
    }
    const eligibleMarketerWallet = await request('GET', '/api/dashboard', { cookie: employees.marketer.cookie });
    const eligibleDeveloperWallet = await request('GET', '/api/dashboard', { cookie: employees.developer.cookie });
    assert(Number(eligibleMarketerWallet.data.wallet?.referral?.available) >= 100 && Number(eligibleDeveloperWallet.data.wallet?.developer?.available) >= 100,
      'Synthetic marketing and development wallets did not meet the existing 100 ILS minimum withdrawal.');

    const withdrawalAttempts = await Promise.all([
      ...Array.from({ length: 12 }, () => request('POST', '/api/marketer/withdrawals', {
        body: { amount: 100, method: 'binance' }, cookie: employees.marketer.cookie
      })),
      ...Array.from({ length: 12 }, () => request('POST', '/api/marketer/withdrawals', {
        body: { amount: 100, method: 'binance' }, cookie: employees.developer.cookie
      }))
    ]);
    const withdrawalSuccesses = withdrawalAttempts.filter(result => result.status === 201);
    const withdrawalConflicts = withdrawalAttempts.filter(result => result.status === 409);
    const unexpectedWithdrawalResponses = withdrawalAttempts.filter(result => ![201, 409].includes(result.status));
    assert(withdrawalSuccesses.length === 2 && withdrawalConflicts.length === 22 && unexpectedWithdrawalResponses.length === 0,
      `Concurrent monthly withdrawal requests were not reserved once per employee (created ${withdrawalSuccesses.length}, conflicts ${withdrawalConflicts.length}, unexpected ${unexpectedWithdrawalResponses.length}).`);
    const withdrawalLatency = withdrawalAttempts.map(result => result.durationMs).sort((a, b) => a - b);
    const savedWithdrawals = await client.query('SELECT id, "userId", amount::float8 AS amount, status FROM withdrawal_requests WHERE "userId" = ANY($1::text[]) ORDER BY "userId"', [[employees.marketer.id, employees.developer.id]]);
    assert(savedWithdrawals.rowCount === 2 && savedWithdrawals.rows.every(row => Number(row.amount) === 100 && row.status === 'pending'), 'Concurrent withdrawal reservations were missing or duplicated in PostgreSQL.');
    const firstDeveloperWithdrawal = savedWithdrawals.rows.find(row => row.userId === employees.developer.id);
    assert(Boolean(firstDeveloperWithdrawal), 'Developer withdrawal reservation was not created.');
    const priorMonthDate = new Date(); priorMonthDate.setUTCMonth(priorMonthDate.getUTCMonth() - 1);
    const priorMonth = `${priorMonthDate.getUTCFullYear()}-${String(priorMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
    await client.query("UPDATE withdrawal_requests SET data = jsonb_set(data, '{month}', to_jsonb($2::text), true) WHERE id = $1", [firstDeveloperWithdrawal.id, priorMonth]);
    const secondDeveloperWithdrawal = await request('POST', '/api/marketer/withdrawals', {
      body: { amount: 100, method: 'binance' }, cookie: employees.developer.cookie
    });
    assert(secondDeveloperWithdrawal.status === 201, `A later-month partial withdrawal could not reserve the still-available commission (${secondDeveloperWithdrawal.status}).`);
    const walletWithTwoReservations = await request('GET', '/api/dashboard', { cookie: employees.developer.cookie });
    assert(Number(walletWithTwoReservations.data.wallet?.developer?.reserved) === 200 && Number(walletWithTwoReservations.data.wallet?.developer?.available) === 50,
      'The developer wallet did not preserve the unreserved remainder after two partial requests across months.');
    const rejectedFollowup = await request('PATCH', `/api/admin/withdrawals/${secondDeveloperWithdrawal.data.withdrawal?.id}`, {
      body: { status: 'rejected', note: 'Synthetic release test.' }, cookie: ownerCookie
    });
    assert(rejectedFollowup.status === 200, `Owner could not release the synthetic partial withdrawal (${rejectedFollowup.status}).`);
    const allSavedWithdrawals = await client.query('SELECT id, "userId", amount::float8 AS amount, status FROM withdrawal_requests WHERE "userId" = ANY($1::text[]) ORDER BY "userId", "createdAt"', [[employees.marketer.id, employees.developer.id]]);
    assert(allSavedWithdrawals.rowCount === 3 && allSavedWithdrawals.rows.filter(row => row.status === 'pending').length === 2 && allSavedWithdrawals.rows.filter(row => row.status === 'rejected').length === 1,
      'Partial withdrawal follow-up or rejection was not saved exactly once.');
    const withdrawalKeys = allSavedWithdrawals.rows.map(row => `withdrawal:${row.id}:requested`);
    const reservedLedgerRows = await client.query('SELECT count(*)::int AS count FROM finance_ledger_entries WHERE "idempotencyKey" = ANY($1::text[])', [withdrawalKeys]);
    assert(Number(reservedLedgerRows.rows[0].count) === 3, 'Concurrent withdrawals duplicated or omitted finance-ledger reservations.');

    const walletReadStartedAt = performance.now();
    const walletReads = await Promise.all(Array.from({ length: 12 }, (_, index) => request('GET', '/api/dashboard', {
      cookie: index % 2 ? employees.marketer.cookie : employees.developer.cookie
    })));
    const walletReadDurations = walletReads.map(result => result.durationMs).sort((a, b) => a - b);
    assert(walletReads.every(result => result.status === 200), 'Concurrent employee wallet reads failed after withdrawal reservation.');
    const reservedMarketerWallet = await request('GET', '/api/dashboard', { cookie: employees.marketer.cookie });
    const reservedDeveloperWallet = await request('GET', '/api/dashboard', { cookie: employees.developer.cookie });
    assert(Number(reservedMarketerWallet.data.wallet?.referral?.reserved) === 100 && Number(reservedMarketerWallet.data.wallet?.referral?.available) === 50, 'Marketing wallet did not retain its unreserved commission remainder.');
    assert(Number(reservedDeveloperWallet.data.wallet?.developer?.reserved) === 100 && Number(reservedDeveloperWallet.data.wallet?.developer?.available) === 150, 'Developer wallet did not restore the rejected reservation while retaining the first pending request.');
    const paymentStress = {
      route: 'POST /api/admin/payment', requests: uniquePaymentRequests.length,
      accepted: acceptedUniquePayments.length, rejectedAtContractBalance: rejectedBeyondBalance.length,
      p50Ms: stressPercentile(uniquePaymentLatency, 0.5), p95Ms: stressPercentile(uniquePaymentLatency, 0.95),
      finalPaidTotalIls: 1000, distinctPaymentRows: Number(totalPaymentRows.rows[0].count)
    };
    const withdrawalStress = {
      route: 'POST /api/marketer/withdrawals', requests: withdrawalAttempts.length,
      created: withdrawalSuccesses.length + 1, monthlyConflicts: withdrawalConflicts.length,
      p50Ms: stressPercentile(withdrawalLatency, 0.5), p95Ms: stressPercentile(withdrawalLatency, 0.95),
      uniqueReservationLedgerRows: Number(reservedLedgerRows.rows[0].count)
    };
    const walletStress = {
      route: 'GET /api/dashboard (marketer/developer wallets)', requests: walletReads.length,
      p50Ms: stressPercentile(walletReadDurations, 0.5), p95Ms: stressPercentile(walletReadDurations, 0.95),
      errors: walletReads.filter(result => result.status !== 200).length
    };
    console.log(`[FINANCE_STRESS] ${JSON.stringify({ payments: paymentStress, withdrawals: withdrawalStress, walletReads: walletStress, wallMs: Number((performance.now() - walletReadStartedAt).toFixed(1))})}`);
    results.push(`concurrent distinct payments stop exactly at contract balance (8 accepted / 4 rejected, p50 ${paymentStress.p50Ms}ms / p95 ${paymentStress.p95Ms}ms); 24 simultaneous withdrawal requests reserve once per employee (p50 ${withdrawalStress.p50Ms}ms / p95 ${withdrawalStress.p95Ms}ms); partial carry-over and rejection release preserve remaining wallet balances`);
  } finally {
    const restoredPricing = await request('POST', '/api/admin/pricing', {
      body: { prices: originalPrices, commissionHoldDays: originalHoldDays }, cookie: ownerCookie
    });
    assert(restoredPricing.status === 200, `Could not restore synthetic commission hold setting (${restoredPricing.status}).`);
  }

  for (const result of results) console.log(`PASS ${result}`);
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (syntheticIds.length) {
    await client.query('BEGIN').catch(() => {});
    try {
      await client.query('DELETE FROM project_assignments WHERE "projectId" = $1', [`project_${syntheticLeadId}`]);
      await client.query('DELETE FROM commissions WHERE "requestId" = $1 OR "userId" = ANY($2::text[])', [syntheticLeadId, syntheticIds]);
      await client.query('DELETE FROM payments WHERE "requestId" = $1', [syntheticLeadId]);
      await client.query('DELETE FROM finance_ledger_entries WHERE "requestId" = $1 OR "employeeId" = ANY($2::text[])', [syntheticLeadId, syntheticIds]);
      await client.query('DELETE FROM referral_events WHERE "requestId" = $1 OR "resourceId" = $2 OR "userId" = ANY($3::text[])', [syntheticLeadId, syntheticConversationId, syntheticIds]);
      await client.query('DELETE FROM referral_attributions WHERE "requestId" = $1 OR "userId" = ANY($2::text[])', [syntheticLeadId, syntheticIds]);
      await client.query('DELETE FROM referral_links WHERE "userId" = ANY($1::text[])', [syntheticIds]);
      await client.query('DELETE FROM rank_requests WHERE "userId" = ANY($1::text[])', [syntheticIds]);
      await client.query('DELETE FROM system_notifications WHERE "userId" = ANY($1::text[]) OR data::text LIKE $2 OR data::text LIKE $3', [syntheticIds, `%${syntheticLeadId}%`, `%${syntheticConversationId}%`]);
      await client.query('DELETE FROM audit_entries WHERE "actorId" = ANY($1::text[]) OR "targetId" = ANY($2::text[])', [syntheticIds, [syntheticLeadId, syntheticConversationId]]);
      await client.query('DELETE FROM crm_records WHERE data::text LIKE $1', [`%${syntheticLeadId}%`]);
      await client.query(`DELETE FROM employee_invitations WHERE data->>'employeeId' = ANY($1::text[])`, [syntheticIds]);
      await client.query('DELETE FROM outbox_messages WHERE recipient = ANY($1::text[])', [syntheticIds.map(id => `${id}@example.test`)]);
      await client.query('DELETE FROM withdrawal_requests WHERE "userId" = ANY($1::text[])', [syntheticIds]);
      await client.query('DELETE FROM projects WHERE "requestId" = $1', [syntheticLeadId]);
      await client.query('DELETE FROM project_requests WHERE id = $1', [syntheticLeadId]);
      await client.query('DELETE FROM stored_attachments WHERE "ownerId" = ANY($1::text[])', [syntheticIds]);
      await client.query('DELETE FROM conversations WHERE id = $1', [syntheticConversationId]);
      await client.query('DELETE FROM user_accounts WHERE id = ANY($1::text[])', [syntheticIds]);
      await client.query('DELETE FROM rate_limit_buckets WHERE key = ANY($1::text[])', [testRateBuckets]);
      await client.query('DELETE FROM outbox_messages WHERE NOT (id = ANY($1::text[]))', [preexistingOutboxIds]);
      const remaining = await client.query(
        'SELECT (SELECT count(*) FROM user_accounts WHERE id = ANY($1::text[])) + (SELECT count(*) FROM auth_sessions WHERE "userId" = ANY($1::text[])) AS count',
        [syntheticIds]
      );
      assert(Number(remaining.rows[0].count) === 0, 'Synthetic test accounts or sessions remained after cleanup.');
      await client.query('COMMIT');
      console.log('PASS synthetic account and session cleanup');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('CLEANUP WARNING: synthetic test rows could not be removed.');
      process.exitCode = 1;
    }
  }
  await client.end();
  await closePostgresPool();
}

