import { Readable } from 'node:stream';
import pg from 'pg';
import { init, handle } from './server.js';
import { closePostgresPool } from './src/server/postgres-runtime.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the PostgreSQL API smoke test.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const syntheticIds = [];
const testSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const password = `Synthetic!${testSuffix}2026`;
const ownerUsername = `pg_owner_${testSuffix}`;
const customerEmail = `pg_customer_${testSuffix}@example.test`;
const results = [];
let syntheticConversationId = '';
let syntheticLeadId = '';
const employeeIds = [];
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
  const requestBytes = rawBody !== undefined ? Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody) : body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(requestBytes?.length ? [requestBytes] : []);
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': contentType, ...(cookie ? { cookie } : {}) };
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
  return { status: res.statusCode, headers: res.responseHeaders, data, bytes: Buffer.concat(res.chunks) };
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
  await client.query('DELETE FROM rate_limit_buckets WHERE key = ANY($1::text[])', [testRateBuckets]);
  await init();
  const health = await request('GET', '/api/health');
  assert(health.status === 200 && health.data.storage === 'postgresql', 'API did not report PostgreSQL storage.');
  results.push('API runtime uses PostgreSQL');

  const publicBefore = await request('GET', '/api/public');
  assert(publicBefore.data.adminSetupAvailable === true, 'Fresh PostgreSQL test database must allow first Owner setup.');

  const setup = await request('POST', '/api/setup', {
    body: { name: 'Synthetic ZEZO Owner', username: ownerUsername, password }
  });
  assert(setup.status === 201, `Synthetic Owner setup failed with ${setup.status}.`);
  const ownerId = setup.data.user.id;
  syntheticIds.push(ownerId);
  let ownerCookie = cookieFrom(setup);
  results.push('first Owner creation saved to PostgreSQL');

  const changedPassword = `${password}-Changed!`;
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
  assert(setupAfterOwner.data.adminSetupAvailable === false, 'First Owner setup was not locked after account creation.');
  const secondSetup = await request('POST', '/api/setup', {
    body: { name: 'Synthetic Second Owner', username: `${ownerUsername}_two`, password }
  });
  assert(secondSetup.status === 409, 'Second Owner setup was not rejected.');
  results.push('first Owner setup locks after creation');

  const customerPassword = `Customer!${testSuffix}Longer`;
  const customerRegistration = await request('POST', '/api/client/register', {
    body: { name: 'Synthetic Test Customer', email: customerEmail, password: customerPassword, confirmPassword: customerPassword, student: false }
  });
  assert(customerRegistration.status === 201, `Synthetic customer registration failed with ${customerRegistration.status}.`);
  const customerId = customerRegistration.data.user.id;
  syntheticIds.push(customerId);
  let customerCookie = cookieFrom(customerRegistration);
  const customerDashboard = await request('GET', '/api/dashboard', { cookie: customerCookie });
  assert(customerDashboard.status === 200 && customerDashboard.data.user?.role === 'client', 'Customer session did not persist between requests.');
  results.push('customer registration and session persistence');

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
  for (const role of ['order_manager', 'marketer', 'developer', 'hr_manager']) {
    const email = `pg_${role}_${testSuffix}@example.test`;
    const invite = await request('POST', '/api/admin/invite', {
      body: { name: `Synthetic ${role}`, username: `pg_${role}_${testSuffix}`, email, role }, cookie: ownerCookie
    });
    assert(invite.status === 201 && invite.data.activationToken, `Owner invitation for ${role} failed with ${invite.status}.`);
    const activation = await request('POST', '/api/auth/activate', {
      body: { token: invite.data.activationToken, password: `Employee!${role}${testSuffix}Long` }
    });
    assert(activation.status === 200 && activation.data.user?.role === role, `Employee activation for ${role} failed with ${activation.status}.`);
    const employeeCookie = cookieFrom(activation);
    if (['order_manager', 'hr_manager'].includes(role)) {
      const mfaSetup = await request('GET', '/api/auth/mfa/setup', { cookie: employeeCookie });
      assert(mfaSetup.status === 200 && mfaSetup.data.secret, `MFA setup for ${role} failed with ${mfaSetup.status}.`);
      const mfaEnabled = await request('POST', '/api/auth/mfa/enable', {
        body: { code: currentTotp(mfaSetup.data.secret) }, cookie: employeeCookie
      });
      assert(mfaEnabled.status === 200, `MFA enable for ${role} failed with ${mfaEnabled.status}.`);
    }
    employees[role] = { id: activation.data.user.id, cookie: employeeCookie };
    employeeIds.push(activation.data.user.id);
    syntheticIds.push(activation.data.user.id);
  }
  for (const role of ['order_manager', 'marketer', 'developer', 'hr_manager']) {
    const dashboard = await request('GET', '/api/dashboard', { cookie: employees[role].cookie });
    assert(dashboard.status === 200 && dashboard.data.role === role, `${role} dashboard mismatch: HTTP ${dashboard.status}, response role ${dashboard.data.role ?? 'missing'}, error ${dashboard.data.error ?? 'none'}.`);
  }
  const marketerHome = await request('GET', '/api/dashboard', { cookie: employees.marketer.cookie });
  assert(Boolean(marketerHome.data.referralLink) && marketerHome.data.users === undefined, 'Marketer dashboard exposed team data or omitted its own referral link.');
  results.push('secure employee invitations, activation, and role-specific dashboards for order manager, HR, marketer, and developer');

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
  assert(attachmentRow.rowCount === 1 && attachmentRow.rows[0].ownerId === syntheticIds[1] && attachmentRow.rows[0].content.equals(attachmentBytes), 'Synthetic attachment bytes or owner were not persisted in PostgreSQL.');
  const customerAttachment = await request('GET', `/api/conversations/${syntheticConversationId}/files/0`, { cookie: customerCookie });
  assert(customerAttachment.status === 200 && customerAttachment.bytes.equals(attachmentBytes), 'Customer could not download the stored conversation attachment.');
  const marketerAttachment = await request('GET', `/api/conversations/${syntheticConversationId}/files/0`, { cookie: employees.marketer.cookie });
  assert(marketerAttachment.status === 404, 'Unassigned marketer downloaded a protected customer attachment.');
  const quote = await request('POST', `/api/conversations/${syntheticConversationId}/quote`, {
    body: { amount: 200, scope: 'Single landing page with the agreed demo layout.', included: 'One responsive page and contact details.' }, cookie: ownerCookie
  });
  assert(quote.status === 201 && quote.data.conversation.quote?.amount === 200, `Owner quote creation failed with ${quote.status}.`);
  const acceptedQuote = await request('POST', `/api/conversations/${syntheticConversationId}/accept-quote`, { cookie: customerCookie });
  assert(acceptedQuote.status === 200, `Customer quote acceptance failed with ${acceptedQuote.status}.`);
  results.push('two-account conversation, owner reply, protected PostgreSQL attachment upload/download, quote, and customer acceptance');

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
  const orderDashboard = await request('GET', '/api/dashboard', { cookie: customerCookie });
  assert(orderDashboard.status === 200 && orderDashboard.data.orders?.some(row => row.id === syntheticLeadId), 'Official order was not available after reloading from PostgreSQL.');
  const ownerAfterOrder = await request('GET', '/api/dashboard', { cookie: ownerCookie });
  assert(ownerAfterOrder.status === 200 && ownerAfterOrder.data.leads?.some(row => row.id === syntheticLeadId), 'Owner could not read the persisted official order.');
  results.push('official customer order linked to conversation and visible through CRM dashboards');

  const assignment = await request('PATCH', `/api/projects/${syntheticLeadId}/assignment`, {
    body: { developerUserId: employees.developer.id, developerDueDate: '2026-12-01' }, cookie: ownerCookie
  });
  assert(assignment.status === 200, `Owner could not assign the synthetic project (${assignment.status}).`);
  const developerDashboard = await request('GET', '/api/dashboard', { cookie: employees.developer.cookie });
  assert(developerDashboard.status === 200 && developerDashboard.data.projects?.some(project => project.id === syntheticLeadId), 'Developer did not see the assigned project.');
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
  const marketerAfterPayment = await request('GET', '/api/dashboard', { cookie: employees.marketer.cookie });
  assert(marketerAfterPayment.data.leads?.some(row => row.id === syntheticLeadId && Number(row.commissionAmount) === 30), 'Rookie marketing commission was not persisted at 15% of the paid 200 ILS project.');
  results.push('developer assignment with 25% expected execution fee, paid project, 15% marketer commission, and payment idempotency');

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
  assert(storedUsers.rowCount === 2 + employeeIds.length, 'Expected synthetic Owner, customer, and employees in PostgreSQL user_accounts.');
  const storedSessions = await client.query(
    'SELECT id FROM auth_sessions WHERE "userId" = ANY($1::text[])',
    [syntheticIds]
  );
  assert(storedSessions.rowCount >= 2 && storedSessions.rows.every(row => /^[a-f0-9]{64}$/.test(row.id)), 'Expected only opaque SHA-256 session hashes persisted in PostgreSQL.');
  results.push('normalized account and hashed session rows persisted');

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
