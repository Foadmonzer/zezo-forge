import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || '';
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
if (!parsedDatabaseUrl || !['127.0.0.1', 'localhost', '::1'].includes(parsedDatabaseUrl.hostname) || !/test/i.test(parsedDatabaseUrl.pathname)) {
  throw new Error('This regression test only runs against a localhost PostgreSQL database whose name contains "test".');
}
if (process.env.ZEZO_ENABLE_EMAIL_DELIVERY === 'true') throw new Error('Disable real email delivery before running the regression test.');

const baseUrl = String(process.env.ZEZO_TEST_BASE_URL || 'http://127.0.0.1:4292').replace(/\/$/, '');
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const prefix = `zreg_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const users = new Map();
const sessions = new Map();
const conversationIds = [];
const password = 'Original-Test-Passphrase-47!';
const resetPassword = 'Updated-Test-Passphrase-83!';
const at = new Date();

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }
async function api(path, { method = 'GET', cookie = '', body, headers = {} } = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body })
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  return { response, data, elapsedMs: performance.now() - started };
}
function cookieFor(role) { return sessions.get(role).cookie; }
async function seedUser(role, overrides = {}) {
  const id = `${prefix}_${role}`;
  const username = `${prefix}.${role}`;
  const email = `${prefix}.${role}@example.test`;
  const salt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync(password, salt, 64).toString('hex');
  const data = {
    name: `Synthetic ${role}`, email, username, role, salt, department: role === 'hr_manager' ? 'orders' : role === 'order_manager' ? 'orders' : '',
    permissionOverrides: {},
    ...(role === 'admin' || role === 'marketing_manager' || role === 'hr_manager' || role === 'order_manager' ? { mfaEnabledAt: at.toISOString() } : {}),
    ...(role === 'marketer' ? { referralCode: `${prefix}_REF` } : {}),
    ...(overrides.data || {})
  };
  const now = new Date();
  await pool.query(`
    INSERT INTO user_accounts (id, email, username, role, active, "fullName", "passwordHash", data, "createdAt", "updatedAt")
    VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7::jsonb,$8,$8)
  `, [id, email, username, role, data.name, passwordHash, JSON.stringify(data), now]);
  const rawSession = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO auth_sessions (id, "userId", "expiresAt", data) VALUES ($1,$2,$3,$4::jsonb)', [digest(rawSession), id, new Date(Date.now() + 60 * 60_000), '{}']);
  users.set(role, { id, username, email, data });
  sessions.set(role, { raw: rawSession, cookie: `zezo_session=${encodeURIComponent(rawSession)}` });
}
async function seedNotification(role) {
  const id = `${prefix}_note_${role}`;
  await pool.query(`
    INSERT INTO system_notifications (id, "userId", type, data, "createdAt")
    VALUES ($1,$2,'team',$3::jsonb,$4)
  `, [id, users.get(role).id, JSON.stringify({ titleAr: `إشعار خاص ${role}`, titleEn: `Private ${role} notice`, descriptionAr: role, descriptionEn: role, target: { tab: 'overview', id: '', kind: '' } }), at]);
  return id;
}
async function createConversation({ cookie = '', key, message, referralCode = '', attachment = null }) {
  const form = new FormData();
  form.set('templateId', 'web-luma-clinic');
  form.set('message', message);
  form.set('source', 'template_catalog');
  if (referralCode) form.set('referralCode', referralCode);
  if (attachment) form.set('attachment', new Blob([attachment.content], { type: attachment.type }), attachment.name);
  const { response, data, elapsedMs } = await api('/api/conversations', { method: 'POST', cookie, headers: { 'Idempotency-Key': key }, body: form });
  return { response, data, elapsedMs };
}
async function measure(path, cookie, samples = 12) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    const { response, elapsedMs } = await api(path, { cookie });
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
    results.push(elapsedMs);
  }
  return { p50: Math.round(percentile(results, 0.50)), p95: Math.round(percentile(results, 0.95)), samples };
}

try {
  // This is an isolated localhost database explicitly named "test"; remove
  // only its shared rate-limit counters so repeated regression runs do not
  // inherit the prior run's synthetic IP quota.
  await pool.query('DELETE FROM rate_limit_buckets');
  for (const role of ['admin', 'client', 'order_manager', 'marketing_manager', 'hr_manager', 'marketer', 'developer']) {
    const overrides = role === 'hr_manager' ? { data: { permissionOverrides: { 'conversations.read': 'all', 'conversations.reply': 'all' } } } : {};
    await seedUser(role, overrides);
  }
  const noteIds = new Map();
  for (const role of users.keys()) noteIds.set(role, await seedNotification(role));

  const anonymousNotifications = await api('/api/notifications?limit=8');
  assert.equal(anonymousNotifications.response.status, 401, 'anonymous notifications must be denied');
  assert.equal((await api('/api/notifications/read-all', { method: 'POST', body: '{}' })).response.status, 401, 'anonymous read-all must be denied');
  assert.equal((await api(`/api/notifications/${encodeURIComponent(noteIds.get('admin'))}`, { method: 'PATCH' })).response.status, 401, 'anonymous mark-read must be denied');
  assert.equal((await api('/api/dashboard')).response.status, 401, 'anonymous dashboard must be denied');

  for (const role of users.keys()) {
    const session = await api('/api/auth/session', { cookie: cookieFor(role) });
    assert.equal(session.response.status, 200);
    assert.equal(session.data.user?.id, users.get(role).id);
    const inbox = await api('/api/notifications?limit=100', { cookie: cookieFor(role) });
    assert.equal(inbox.response.status, 200);
    assert.equal(inbox.data.authenticated, true);
    assert(inbox.data.notifications.some(item => item.id === noteIds.get(role)), `${role} should see its own notice`);
    for (const otherRole of users.keys()) {
      if (otherRole !== role) assert(!inbox.data.notifications.some(item => item.id === noteIds.get(otherRole)), `${role} leaked ${otherRole}'s notice`);
    }
  }
  assert.equal((await api(`/api/notifications/${encodeURIComponent(noteIds.get('admin'))}`, { method: 'PATCH', cookie: cookieFor('client') })).response.status, 404, 'client must not mark the owner notice');
  assert.equal((await api(`/api/notifications/${encodeURIComponent(noteIds.get('client'))}`, { method: 'PATCH', cookie: cookieFor('marketer') })).response.status, 404, 'employee must not mark another user notice');
  assert.equal((await api('/api/notifications/read-all', { method: 'POST', cookie: cookieFor('client'), body: '{}' })).response.status, 200);
  const readAllCheck = await pool.query('SELECT "readAt" FROM system_notifications WHERE id=$1', [noteIds.get('admin')]);
  assert.equal(readAllCheck.rows[0].readAt, null, 'client read-all changed another account');

  const guestKey = randomBytes(20).toString('hex');
  const guestMessage = 'Synthetic guest asks about template customization.';
  const guestResult = await createConversation({ key: guestKey, message: guestMessage, referralCode: users.get('marketer').data.referralCode, attachment: { name: 'synthetic.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.7\nsynthetic test file') } });
  assert.equal(guestResult.response.status, 201, JSON.stringify(guestResult.data));
  assert(guestResult.data.conversation?.id);
  conversationIds.push(guestResult.data.conversation.id);
  const guestCookie = guestResult.response.headers.getSetCookie?.()[0]?.split(';')[0] || guestResult.response.headers.get('set-cookie')?.split(';')[0] || '';
  assert.match(guestCookie, /^zezo_guest=/, 'guest conversation should establish its private session');
  const guestDuplicate = await createConversation({ cookie: guestCookie, key: guestKey, message: guestMessage, referralCode: users.get('marketer').data.referralCode });
  assert.equal(guestDuplicate.response.status, 200, 'same idempotency key should return the original conversation');
  assert.equal(guestDuplicate.data.conversation.id, guestResult.data.conversation.id);
  const guestCounts = await pool.query('SELECT (SELECT count(*)::int FROM conversations WHERE id=$1) AS chats, (SELECT count(*)::int FROM conversation_messages WHERE "conversationId"=$1) AS messages', [guestResult.data.conversation.id]);
  assert.deepEqual(guestCounts.rows[0], { chats: 1, messages: 1 }, 'duplicate submit created more than one conversation/message');
  assert.equal(guestResult.data.conversation.referralCode, users.get('marketer').data.referralCode);
  assert.equal(guestResult.data.conversation.referralUserId, users.get('marketer').id);
  const storedAttachment = guestResult.data.conversation.messages[0]?.attachments?.[0];
  assert.deepEqual(storedAttachment, { index: 0, name: 'synthetic.pdf', size: Buffer.byteLength('%PDF-1.7\nsynthetic test file') }, 'conversation attachment metadata was not returned');
  const guestFile = await api(`/api/conversations/${encodeURIComponent(guestResult.data.conversation.id)}/files/0`, { cookie: guestCookie });
  assert.equal(guestFile.response.status, 200, 'guest could not download its own attachment');
  assert.equal(guestFile.response.headers.get('content-type'), 'application/pdf');
  const unauthorizedFile = await api(`/api/conversations/${encodeURIComponent(guestResult.data.conversation.id)}/files/0`, { cookie: cookieFor('marketer') });
  assert.equal(unauthorizedFile.response.status, 404, 'unrelated employee accessed guest attachment');
  const guestRead = await api(`/api/conversations/${encodeURIComponent(guestResult.data.conversation.id)}`, { cookie: guestCookie });
  assert.equal(guestRead.response.status, 200, 'guest must be able to continue its own conversation');
  const claimDashboard = await api('/api/dashboard', { cookie: `${cookieFor('client')}; ${guestCookie}` });
  assert.equal(claimDashboard.response.status, 200, 'client dashboard should load while claiming its active guest chat');
  const claimedChat = await pool.query('SELECT "customerId", data FROM conversations WHERE id=$1', [guestResult.data.conversation.id]);
  assert.equal(claimedChat.rows[0]?.customerId, users.get('client').id, 'guest conversation was not attached to the newly signed-in account');
  assert.equal(claimedChat.rows[0]?.data?.guestSessionHash, undefined, 'guest-only access hash was not removed after account claim');
  const clientChatsAfterClaim = await api('/api/conversations', { cookie: cookieFor('client') });
  assert(clientChatsAfterClaim.data.conversations.some(item => item.id === guestResult.data.conversation.id), 'client could not find its claimed guest conversation');
  assert.equal((await api(`/api/conversations/${encodeURIComponent(guestResult.data.conversation.id)}`, { cookie: guestCookie })).response.status, 404, 'guest session retained access after the conversation was claimed');

  const clientKey = randomBytes(20).toString('hex');
  const clientCreates = await Promise.all([
    createConversation({ cookie: cookieFor('client'), key: clientKey, message: 'Synthetic client requests a template quote.' }),
    createConversation({ cookie: cookieFor('client'), key: clientKey, message: 'Synthetic client requests a template quote.' })
  ]);
  assert.deepEqual(clientCreates.map(item => item.response.status).sort(), [200, 201], 'simultaneous double-submit should return one creation and one idempotent replay');
  const clientConversation = clientCreates.find(item => item.response.status === 201);
  assert.equal(clientConversation.response.status, 201, JSON.stringify(clientConversation.data));
  conversationIds.push(clientConversation.data.conversation.id);
  const clientCreateCounts = await pool.query('SELECT (SELECT count(*)::int FROM conversations WHERE id=$1) AS chats, (SELECT count(*)::int FROM conversation_messages WHERE "conversationId"=$1) AS messages', [clientConversation.data.conversation.id]);
  assert.deepEqual(clientCreateCounts.rows[0], { chats: 1, messages: 1 }, 'concurrent double-submit created duplicate rows');
  const staffList = await api('/api/conversations', { cookie: cookieFor('marketing_manager') });
  assert(staffList.data.conversations.some(item => item.id === clientConversation.data.conversation.id), 'authorized marketing manager cannot see the conversation');
  const hrList = await api('/api/conversations', { cookie: cookieFor('hr_manager') });
  assert(hrList.data.conversations.some(item => item.id === clientConversation.data.conversation.id), 'HR with explicit read permission cannot see the conversation');
  const orderList = await api('/api/conversations', { cookie: cookieFor('order_manager') });
  assert(!orderList.data.conversations.some(item => item.id === clientConversation.data.conversation.id), 'unassigned order manager saw an out-of-scope conversation');
  await pool.query('UPDATE conversations SET "assignedToId"=$2 WHERE id=$1', [clientConversation.data.conversation.id, users.get('order_manager').id]);
  const assignedOrderList = await api('/api/conversations', { cookie: cookieFor('order_manager') });
  assert(assignedOrderList.data.conversations.some(item => item.id === clientConversation.data.conversation.id), 'assigned order manager cannot see the conversation');
  const marketerRead = await api(`/api/conversations/${encodeURIComponent(clientConversation.data.conversation.id)}`, { cookie: cookieFor('marketer') });
  assert.equal(marketerRead.response.status, 404, 'unauthorized marketer can access the conversation');

  const customerReplyKey = randomBytes(20).toString('hex');
  const customerReply = await api(`/api/conversations/${encodeURIComponent(clientConversation.data.conversation.id)}/messages`, {
    method: 'POST', cookie: cookieFor('client'), headers: { 'Idempotency-Key': customerReplyKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Synthetic client follow-up.' })
  });
  assert.equal(customerReply.response.status, 201, JSON.stringify(customerReply.data));
  const staffReplyKey = randomBytes(20).toString('hex');
  const staffReplyPayload = JSON.stringify({ message: 'Synthetic ZEZO support reply.', idempotencyKey: staffReplyKey });
  const staffReply = await api(`/api/conversations/${encodeURIComponent(clientConversation.data.conversation.id)}/messages`, {
    method: 'POST', cookie: cookieFor('marketing_manager'), headers: { 'Content-Type': 'application/json' }, body: staffReplyPayload
  });
  assert.equal(staffReply.response.status, 201, JSON.stringify(staffReply.data));
  const duplicateReply = await api(`/api/conversations/${encodeURIComponent(clientConversation.data.conversation.id)}/messages`, {
    method: 'POST', cookie: cookieFor('marketing_manager'), headers: { 'Content-Type': 'application/json' }, body: staffReplyPayload
  });
  assert.equal(duplicateReply.response.status, 200, 'same staff reply key must be idempotent');
  const customerConversation = await api(`/api/conversations/${encodeURIComponent(clientConversation.data.conversation.id)}`, { cookie: cookieFor('client') });
  assert.equal(customerConversation.response.status, 200);
  assert(customerConversation.data.conversation.messages.some(item => item.text === 'Synthetic ZEZO support reply.'));
  const conversationCounts = await pool.query('SELECT count(*)::int AS messages FROM conversation_messages WHERE "conversationId"=$1', [clientConversation.data.conversation.id]);
  assert.equal(conversationCounts.rows[0].messages, 3, 'duplicate staff send created an extra message');

  const newResetToken = randomBytes(32).toString('base64url');
  await pool.query('UPDATE user_accounts SET data=data || $2::jsonb WHERE id=$1', [users.get('client').id, JSON.stringify({ passwordResetHash: digest(newResetToken), passwordResetExpires: Date.now() + 60 * 60_000 })]);
  const reset = await api('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: newResetToken, password: resetPassword }) });
  assert.equal(reset.response.status, 200, JSON.stringify(reset.data));
  assert.match(reset.response.headers.get('set-cookie') || '', /Max-Age=0/, 'reset should clear old browser session and require a fresh MFA-aware login');
  assert.equal((await api('/api/auth/session', { cookie: cookieFor('client') })).data.authenticated, false, 'reset must revoke existing sessions');
  const tokenReuse = await api('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: newResetToken, password: 'Third-Test-Passphrase-91!' }) });
  assert.equal(tokenReuse.response.status, 400, 'reset token must be single-use');
  const oldPasswordLogin = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountType: 'client', username: users.get('client').username, password }) });
  assert.notEqual(oldPasswordLogin.response.status, 200, 'old password still works after reset');
  const newPasswordLogin = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountType: 'client', username: users.get('client').username, password: resetPassword }) });
  assert.equal(newPasswordLogin.response.status, 200, JSON.stringify(newPasswordLogin.data));
  const freshCookie = newPasswordLogin.response.headers.getSetCookie?.()[0]?.split(';')[0] || newPasswordLogin.response.headers.get('set-cookie')?.split(';')[0] || '';
  assert.match(freshCookie, /^zezo_session=/);
  assert.equal((await api('/api/auth/session', { cookie: freshCookie })).data.user?.id, users.get('client').id);
  const recoveryUnavailable = await api('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: users.get('client').email }) });
  assert.equal(recoveryUnavailable.response.status, 503, 'disabled email should return an explicit safe status instead of appearing sent');

  const measurements = {
    sessionWarm: await measure('/api/auth/session', freshCookie),
    notificationsWarm: await measure('/api/notifications?limit=8', freshCookie),
    clientDashboardWarm: await measure('/api/dashboard', freshCookie, 8)
  };
  console.log(JSON.stringify({ ok: true, cases: ['anonymous access denied', 'user-scoped notification read/mark-read', 'guest conversation idempotency/referral and safe claim into client account', 'client and authorized staff conversation/reply', 'password reset one-time/revokes sessions/requires login', 'disabled mail reports unavailable'], measurements }, null, 2));
} finally {
  const ids = [...users.values()].map(user => user.id);
  if (ids.length) {
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM system_notifications WHERE "userId" = ANY($1::text[])', [ids]);
      await pool.query('DELETE FROM auth_sessions WHERE "userId" = ANY($1::text[])', [ids]);
      await pool.query('DELETE FROM referral_attributions WHERE "userId" = ANY($1::text[])', [ids]);
      await pool.query('DELETE FROM referral_links WHERE "userId" = ANY($1::text[])', [ids]);
      await pool.query('DELETE FROM referral_events WHERE "userId" = ANY($1::text[]) OR "resourceId" = ANY($2::text[])', [ids, conversationIds]);
      if (conversationIds.length) {
        await pool.query('DELETE FROM stored_attachments WHERE id IN (SELECT "attachmentId" FROM conversation_messages WHERE "conversationId" = ANY($1::text[]) AND "attachmentId" IS NOT NULL)', [conversationIds]);
        await pool.query('DELETE FROM audit_entries WHERE "targetId" = ANY($1::text[]) OR "actorId" = ANY($2::text[])', [conversationIds, ids]);
        await pool.query('DELETE FROM conversations WHERE id = ANY($1::text[])', [conversationIds]);
      }
      await pool.query('DELETE FROM audit_entries WHERE "actorId" = ANY($1::text[])', [ids]);
      await pool.query('DELETE FROM user_accounts WHERE id = ANY($1::text[])', [ids]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  await pool.end();
}
