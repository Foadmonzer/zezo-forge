import { expect, test } from '@playwright/test';
import { request as playwrightRequest } from 'playwright';
import { createHmac, randomUUID, scryptSync } from 'node:crypto';
import pg from 'pg';

function assertIsolatedEnvironment(baseURL, connectionString) {
  const environmentError = 'Development Manager regression requires the local ZEZO CI application and its isolated zezo_ci database.';
  if (!URL.canParse(baseURL) || !URL.canParse(connectionString)) throw new Error(environmentError);
  const site = new URL(baseURL);
  const database = new URL(connectionString);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  const ciService = Boolean(process.env.CI) && database.hostname === 'postgres';
  if (site.protocol !== 'http:' || !loopback.includes(site.hostname) ||
      !['postgresql:', 'postgres:'].includes(database.protocol) ||
      (!loopback.includes(database.hostname) && !ciService) ||
      database.pathname !== '/zezo_ci' || database.username !== 'zezo_ci') {
    throw new Error(environmentError);
  }
}

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of secret.trim()) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function responseJson(response, operation, statuses = [200]) {
  expect(statuses, `${operation} returned HTTP ${response.status()}`).toContain(response.status());
  return response.json();
}

async function seedProject(db, id, { customerId, marketerId, stage, developerId = null, withFinancialHistory = false }) {
  const title = `Synthetic technical project ${id}`;
  const status = withFinancialHistory ? 'completed' : 'review';
  const data = {
    service: title, category: 'web', details: 'Synthetic technical requirements for the isolated acceptance test.',
    name: 'Synthetic customer', email: 'dm-customer-private@example.test', phone: '0500000198',
    budget: 'private-budget-marker', clientId: customerId, developerUserId: developerId,
    referralUserId: marketerId, contractAmount: 360, attachments: [], paidTotal: withFinancialHistory ? 120 : 0,
    ...(withFinancialHistory && { developerTaskStatus: 'approved', developerReviewStatus: 'approved',
      developerCommissionPaidAmount: 30, commissionPaidAmount: 18 })
  };
  await db.query(`
    INSERT INTO project_requests (id, "customerId", "referrerId", "developerId", status, "projectStage", "agreedAmount", data, "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 360, $7, NOW())
  `, [id, customerId, marketerId, developerId, status, stage, data]);
  await db.query(`
    INSERT INTO projects (id, "requestId", "developerId", stage, data, "updatedAt")
    VALUES ($1, $2, $3, $4, $5, NOW())
  `, [`project_${id}`, id, developerId, stage, data]);
  await db.query(`
    INSERT INTO referral_attributions (id, "userId", "requestId", code, "visitorHash", "expiresAt", data)
    VALUES ($1, $2, $3, $4, $1, NOW() + INTERVAL '1 day', '{}')
  `, [`attribution_${id}`, marketerId, id, `synthetic_referral_${id}`]);
  if (!withFinancialHistory) return;

  await db.query(`
    INSERT INTO project_assignments (id, "projectId", "developerId", state, "commissionPercent", "expectedCommission", data)
    VALUES ($1, $2, $3, 'approved', 25, 90, '{}')
  `, [`assignment_${id}_${developerId}`, `project_${id}`, developerId]);
  await db.query(`
    INSERT INTO payments (id, "requestId", amount, status, "idempotencyKey", data)
    VALUES ($1, $2, 120, 'verified', $1, '{"kind":"payment","verified":true}')
  `, [`payment_${id}`, id]);
  await db.query(`
    INSERT INTO commissions (id, "userId", "requestId", kind, "ratePercent", amount, status, "sourcePaymentId", data)
    VALUES ($1, $2, $3, 'referral', 15, 18, 'paid', $4, '{"commissionPaidAmount":18}'),
           ($5, $6, $3, 'developer', 25, 30, 'paid', $4, '{"developerCommissionPaidAmount":30,"developerReviewStatus":"approved"}')
  `, [`commission_referral_${id}`, marketerId, id, `payment_${id}`, `commission_developer_${id}`, developerId]);
  await db.query(`
    INSERT INTO wallet_transactions (id, "userId", "requestId", type, status, amount, "idempotencyKey", data)
    VALUES ($1, $2, $3, 'commission_credit', 'paid', 18, $1, '{}')
  `, [`wallet_${id}`, marketerId, id]);
  await db.query(`
    INSERT INTO finance_ledger_entries (id, type, status, "requestId", "employeeId", amount, "idempotencyKey", data)
    VALUES ($1, 'customer_payment', 'verified', $2, $3, 120, $1, '{}')
  `, [`ledger_${id}`, id, marketerId]);
}

async function seedConversationAndFile(db, projectId, customerId, developerId) {
  const conversationId = `conversation_${projectId}`;
  const message = `Scoped synthetic customer message for ${projectId}`;
  const file = Buffer.from(`Synthetic developer file for ${projectId}`);
  const attachmentId = `attachment_${projectId}`;
  const fileData = {
    originalName: 'synthetic-development-delivery.txt', storedName: attachmentId,
    attachmentId, storage: 'postgres', size: file.length, contentType: 'text/plain'
  };
  await db.query(`
    INSERT INTO conversations (id, "customerId", status, source, data, "updatedAt")
    VALUES ($1, $2, 'open', 'website', $3, NOW())
  `, [conversationId, customerId, { leadId: projectId, clientId: customerId, department: 'orders' }]);
  await db.query(`
    INSERT INTO conversation_messages (id, "conversationId", "senderId", body, data)
    VALUES ($1, $2, $3, $4, '{"senderType":"client"}')
  `, [`msg_${projectId}`, conversationId, customerId, message]);
  await db.query(`
    INSERT INTO stored_attachments (id, "ownerId", "fileName", "contentType", "sizeBytes", content)
    VALUES ($1, $2, $3, 'text/plain', $4, $5)
  `, [attachmentId, developerId, fileData.originalName, file.length, file]);
  await db.query(`
    UPDATE project_requests SET data = data || $2::jsonb WHERE id = $1
  `, [projectId, { linkedConversationId: conversationId, conversationId, developerAttachments: [fileData] }]);
  return { conversationId, message, file };
}

async function financialSnapshot(db, projectIds) {
  const snapshot = {};
  for (const table of ['payments', 'commissions', 'wallet_transactions', 'finance_ledger_entries', 'referral_attributions']) {
    // Fixed table allowlist above; IDs are parameterized.
    const result = await db.query(`SELECT to_jsonb(entry) AS entry FROM ${table} entry WHERE "requestId" = ANY($1) ORDER BY id`, [projectIds]);
    snapshot[table] = result.rows;
  }
  return snapshot;
}

async function whileLegacyLockIsHeld(connectionString, operation) {
  const blocker = new pg.Client({ connectionString });
  await blocker.connect();
  let timer;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('A development manager request blocked on the company-wide advisory lock.')), 2500);
      })
    ]);
  } finally {
    clearTimeout(timer);
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
}

export async function runDevelopmentManagerRegression({ browser, ownerApi, baseURL, testInfo }) {
  const connectionString = process.env.DATABASE_URL;
  assertIsolatedEnvironment(baseURL, connectionString);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const db = new pg.Client({ connectionString, application_name: 'zezo-development-manager-regression' });
  const contexts = [];
  const browserContexts = [];
  const newApi = async () => {
    const api = await playwrightRequest.newContext({ baseURL });
    contexts.push(api);
    return api;
  };
  const invitePayload = (role, label) => {
    const username = `dm_${label}_${suffix}`;
    return { role, username, name: `Synthetic ${label}`, email: `${username}@example.test` };
  };
  const inviteAndActivate = async (role, label) => {
    const details = invitePayload(role, label);
    const password = `Synthetic!${label}!${suffix}!2026`;
    const invite = await responseJson(await ownerApi.post('/api/admin/invite', { data: details }), `invite ${role}`, [201]);
    const api = await newApi();
    const activated = await responseJson(await api.post('/api/auth/activate', {
      data: { token: invite.activationToken, password }
    }), `activate ${role}`);
    await api.post('/api/auth/logout');
    return { ...details, id: activated.user.id, password, api };
  };
  const login = async (account, accountType) => responseJson(await account.api.post('/api/auth/login', {
    data: { username: account.username, password: account.password, accountType }
  }), `sign in ${account.role}`);
  const secureManagerSession = async account => {
    const enrolled = await login(account, 'management');
    expect(enrolled.user.role).toBe(account.role);
    expect((await account.api.get('/api/dashboard')).status()).toBe(428);
    const setup = await responseJson(await account.api.get('/api/auth/mfa/setup'), 'read synthetic authenticator setup');
    await responseJson(await account.api.post('/api/auth/mfa/enable', { data: { code: totp(setup.secret) } }), 'enable mandatory authenticator');
    return setup.secret;
  };
  const techPath = '/api/development-manager';
  const techProjectPath = id => `${techPath}/projects/${id}`;
  const assignedId = `dm_delegated_${suffix}`;
  const financialId = `dm_financial_${suffix}`;
  const foreignId = `dm_foreign_${suffix}`;
  const customerId = `dm_customer_${suffix}`;

  await db.connect();
  try {
    const manager = await inviteAndActivate('development_manager', 'manager');
    const developer = await inviteAndActivate('developer', 'developer');
    const otherDeveloper = await inviteAndActivate('developer', 'other_developer');
    const marketer = await inviteAndActivate('marketer', 'marketer');
    const hr = await inviteAndActivate('hr_manager', 'hr');
    const marketingManager = await inviteAndActivate('marketing_manager', 'marketing_manager');

    let managerSecret;
    await test.step('Require MFA and restrict appointment of the Development Manager', async () => {
      expect((await manager.api.get(techPath)).status()).toBe(401);
      managerSecret = await secureManagerSession(manager);
      await secureManagerSession(hr);
      await secureManagerSession(marketingManager);
      await login(marketer, 'employee');
      for (const account of [hr, marketer, marketingManager]) {
        expect((await account.api.get(techPath)).status(), `${account.role} cannot access the technical workspace`).toBe(403);
      }
      expect((await hr.api.post('/api/admin/invite', { data: invitePayload('development_manager', 'unauthorized') })).status()).toBe(403);
      expect((await hr.api.patch(`/api/admin/permissions/${otherDeveloper.id}`, { data: { role: 'development_manager' } })).status()).toBe(403);
      expect((await ownerApi.patch(`/api/admin/permissions/${otherDeveloper.id}`, {
        data: { role: 'development_manager', permissions: { 'conversations.read': 'all' } }
      })).status()).toBe(403);
      const earlierNotices = [
        { id: `dm_legacy_referral_${suffix}`, type: 'project', tab: 'referral' },
        { id: `dm_legacy_finance_${suffix}`, type: 'commission', tab: 'development' }
      ];
      for (const { id, type, tab } of earlierNotices) {
        await db.query(`
          INSERT INTO system_notifications (id, "userId", type, data) VALUES ($1, $2, $3, $4)
        `, [id, otherDeveloper.id, type, { eventKey: `former-role:${id}`, titleEn: 'Synthetic legacy private alert', target: { tab, id: assignedId, kind: 'lead' } }]);
      }
      await login(otherDeveloper, 'employee');
      const beforePromotion = await responseJson(await otherDeveloper.api.get('/api/notifications'), 'read permitted alerts with the former role');
      expect(beforePromotion.notifications.map(item => item.id)).toEqual(expect.arrayContaining(earlierNotices.map(item => item.id)));
      const promoted = await responseJson(await ownerApi.patch(`/api/admin/permissions/${otherDeveloper.id}`, {
        data: { role: 'development_manager' }
      }), 'appoint Development Manager');
      expect(promoted.user.role).toBe('development_manager');
      expect((await otherDeveloper.api.get(techPath)).status()).toBe(401);
      const temporaryManager = { ...otherDeveloper, role: 'development_manager' };
      const temporaryMfaSecret = await secureManagerSession(temporaryManager);
      const afterPromotion = await responseJson(await temporaryManager.api.get('/api/notifications'), 'read alerts after promotion');
      expect(afterPromotion.unreadCount).toBe(0);
      for (const { id } of earlierNotices) {
        expect(afterPromotion.notifications.some(item => item.id === id)).toBe(false);
        expect((await temporaryManager.api.patch(`/api/notifications/${id}`)).status()).toBe(404);
      }
      const restored = await responseJson(await ownerApi.patch(`/api/admin/permissions/${otherDeveloper.id}`, {
        data: { role: 'developer' }
      }), 'restore synthetic developer role');
      expect(restored.user.role).toBe('developer');
      await login(developer, 'employee');
      await responseJson(await otherDeveloper.api.post('/api/auth/login', { data: {
        username: otherDeveloper.username, password: otherDeveloper.password, accountType: 'employee', mfaCode: totp(temporaryMfaSecret)
      } }), 'sign in restored developer with authenticator');
      expect((await developer.api.get(techPath)).status()).toBe(403);
    });

    const customerEmail = `${customerId}@example.test`;
    const customerPassword = `Synthetic!customer!${suffix}!2026`;
    const salt = randomUUID().replaceAll('-', '');
    await db.query(`
      INSERT INTO user_accounts (id, email, username, role, active, "fullName", "passwordHash", data, "updatedAt")
      VALUES ($1, $2, $2, 'client', TRUE, 'Synthetic technical customer', $3, $4, NOW())
    `, [customerId, customerEmail, scryptSync(customerPassword, salt, 64).toString('hex'),
      { salt, department: 'customers', permissionOverrides: {} }]);
    const customerApi = await newApi();
    const customerLogin = await login({ api: customerApi, username: customerEmail, password: customerPassword, role: 'client' }, 'client');
    expect(customerLogin.user.role).toBe('client');
    expect((await customerApi.get(techPath)).status()).toBe(403);
    for (const [id, stage, withFinancialHistory] of [[assignedId, 'under_review', false], [financialId, 'completed', true], [foreignId, 'new_request', false]]) {
      await seedProject(db, id, { customerId, marketerId: marketer.id, stage,
        developerId: withFinancialHistory ? developer.id : null, withFinancialHistory });
    }
    const scopedResources = await seedConversationAndFile(db, assignedId, customerId, developer.id);
    const foreignResources = await seedConversationAndFile(db, foreignId, customerId, otherDeveloper.id);
    const financialBefore = await financialSnapshot(db, [assignedId, financialId, foreignId]);

    let details;
    const project = async id => (await responseJson(await manager.api.get(techPath), 'read scoped technical workspace'))
      .projects.find(item => item.id === id);
    await test.step('Limit data and routes to authorized technical work', async () => {
      const dashboard = await responseJson(await manager.api.get('/api/dashboard'), 'read manager dashboard');
      expect(dashboard.user.role).toBe('development_manager');
      for (const key of ['employees', 'leads', 'wallet', 'commissions', 'payments', 'referralIntelligence', 'treasury']) {
        expect(dashboard[key], `Unexpected management dashboard field ${key}`).toBeUndefined();
      }
      const initialResponse = await manager.api.get(techPath);
      const initial = await responseJson(initialResponse, 'read manager workspace before delegation');
      expect(initialResponse.headers()['cache-control']).toContain('no-store');
      expect(initial.projects.some(item => item.id === assignedId || item.id === foreignId)).toBe(false);
      const delegation = await responseJson(await ownerApi.patch(`${techProjectPath(assignedId)}/delegation`, {
        data: { managerId: manager.id, allowCustomerConversation: false, version: 0 }
      }), 'delegate one technical project');
      details = await project(assignedId);
      expect(details.version).toBeGreaterThan(0);
      expect(delegation).toBeTruthy();
      const workspace = await responseJson(await manager.api.get(techPath), 'read delegated technical workspace');
      expect(workspace.developers.some(person => person.id === developer.id)).toBe(true);
      expect(workspace.developers.some(person => [marketer.id, hr.id].includes(person.id))).toBe(false);
      const visible = JSON.stringify(workspace);
      for (const privateValue of [foreignResources.message, 'dm-customer-private@example.test', '0500000198', 'private-budget-marker', marketer.email, marketer.id]) {
        expect(visible).not.toContain(privateValue);
      }
      for (const key of ['contractAmount', 'paidTotal', 'commissionAmount', 'referralUserId', 'passwordHash']) {
        expect(details[key], `Unexpected project field ${key}`).toBeUndefined();
      }
      for (const route of ['/api/admin/finance', '/api/referral-intelligence', '/api/crm']) {
        expect((await manager.api.get(route)).status(), route).toBe(403);
      }
      expect((await manager.api.post('/api/admin/payment', { data: { leadId: assignedId, amount: 10, verified: true, kind: 'payment' } })).status()).toBe(403);
      expect((await manager.api.patch('/api/admin/withdrawals/unknown', { data: { status: 'approved' } })).status()).toBe(403);
      expect((await manager.api.post('/api/admin/invite', { data: invitePayload('developer', 'unauthorized') })).status()).toBe(403);
      expect((await manager.api.patch(`/api/admin/permissions/${developer.id}`, { data: { role: 'development_manager' } })).status()).toBe(403);
      expect([403, 404]).toContain((await manager.api.get(`/api/conversations/${foreignResources.conversationId}`)).status());
      expect((await manager.api.get(`/api/developer/attachment/${foreignId}/0`)).status()).toBe(403);
      expect([403, 404]).toContain((await manager.api.get(`${techProjectPath(foreignId)}/files/0`)).status());
      expect([403, 404]).toContain((await manager.api.get(`${techProjectPath(assignedId)}/conversation`)).status());
      const permittedFile = await manager.api.get(`${techProjectPath(assignedId)}/files/0`);
      expect(permittedFile.status()).toBe(200);
      expect(await permittedFile.body()).toEqual(scopedResources.file);
      await responseJson(await ownerApi.patch(`${techProjectPath(assignedId)}/delegation`, {
        data: { managerId: manager.id, allowCustomerConversation: true, version: details.version }
      }), 'grant delegated customer conversation access');
      const conversation = await responseJson(await manager.api.get(`${techProjectPath(assignedId)}/conversation`), 'read delegated customer conversation');
      expect(JSON.stringify(conversation)).toContain(scopedResources.message);
      expect([403, 404]).toContain((await manager.api.get(`${techProjectPath(foreignId)}/conversation`)).status());
      expect([403, 404]).toContain((await manager.api.post(`${techProjectPath(assignedId)}/conversation`, {
        data: { conversationId: foreignResources.conversationId, message: 'This message must stay out of a foreign conversation.' }
      })).status());
      const reply = 'Synthetic reply from the delegated technical manager.';
      const replied = await responseJson(await manager.api.post(`${techProjectPath(assignedId)}/conversation`, {
        data: { conversationId: scopedResources.conversationId, message: reply }
      }), 'reply within delegated technical conversation', [201]);
      expect(JSON.stringify(replied)).toContain(reply);
      const visibleToCustomer = await responseJson(await customerApi.get(`/api/conversations/${scopedResources.conversationId}`), 'read authorized response as the project customer');
      expect(JSON.stringify(visibleToCustomer)).toContain(reply);

      const managerNotices = await responseJson(await manager.api.get('/api/notifications?limit=20'), 'read private manager notifications');
      const delegationNotice = managerNotices.notifications.find(item => item.titleEn === 'A technical project was delegated to you');
      expect(delegationNotice).toBeTruthy();
      expect((await developer.api.patch(`/api/notifications/${delegationNotice.id}`)).status()).toBe(404);
      expect(await financialSnapshot(db, [assignedId, financialId, foreignId])).toEqual(financialBefore);
    });

    await test.step('Persist technical review and reject stale or competing assignments', async () => {
      details = await project(assignedId);
      const review = { category: 'web', complexity: 'medium', skills: ['Next.js', 'PostgreSQL'], estimateDays: 3,
        priority: 'normal', note: 'Synthetic review without changes to funding or attribution.', version: details.version };
      const crossOrigin = await manager.api.patch(`${techProjectPath(assignedId)}/review`, {
        headers: { Origin: 'https://example.test' }, data: review
      });
      expect(crossOrigin.status()).toBe(403);
      await whileLegacyLockIsHeld(connectionString, async () => {
        await responseJson(await manager.api.get(techPath), 'read manager workspace while the company-wide lock is held');
        expect((await manager.api.patch('/api/admin/withdrawals/unknown', { data: { status: 'approved' } })).status()).toBe(403);
      });
      await responseJson(await manager.api.patch(`${techProjectPath(assignedId)}/review`, { data: review }), 'save technical review');
      expect((await manager.api.patch(`${techProjectPath(assignedId)}/review`, { data: review })).status()).toBe(409);
      expect([403, 404]).toContain((await manager.api.patch(`${techProjectPath(foreignId)}/review`, { data: { ...review, version: 0 } })).status());
      details = await project(assignedId);
      expect(details.review).toMatchObject({ category: 'web', complexity: 'medium', skills: ['Next.js', 'PostgreSQL'], estimateDays: 3 });
      expect((await manager.api.post(`${techProjectPath(assignedId)}/assignment`, { data: { developerId: marketer.id, version: details.version } })).status()).toBe(400);
      const contenders = [developer, otherDeveloper];
      const outcomes = await Promise.all(contenders.map(account => manager.api.post(`${techProjectPath(assignedId)}/assignment`, {
        data: { developerId: account.id, version: details.version, note: 'Synthetic competing assignment.' }
      })));
      expect(outcomes.filter(outcome => outcome.ok())).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status() === 409)).toHaveLength(1);
      const winner = contenders[outcomes.findIndex(outcome => outcome.ok())];
      const replacement = contenders.find(account => account !== winner);
      details = await project(assignedId);
      expect(details.developerId).toBe(winner.id);
      const dashboard = await responseJson(await winner.api.get('/api/dashboard'), 'read assigned developer dashboard');
      expect(dashboard.projects.some(item => item.id === assignedId)).toBe(true);
      await responseJson(await manager.api.post(`${techProjectPath(assignedId)}/assignment`, {
        data: { developerId: replacement.id, version: details.version, reason: 'Synthetic change before acceptance.' }
      }), 'reassign an unaccepted technical project', [200, 201]);
      const history = await db.query(`
        SELECT "developerId", state FROM project_assignments WHERE "projectId" = $1 ORDER BY "assignedAt", id
      `, [`project_${assignedId}`]);
      expect(history.rows).toHaveLength(2);
      expect(history.rows).toEqual(expect.arrayContaining([
        { developerId: replacement.id, state: 'offered' },
        { developerId: winner.id, state: expect.not.stringMatching(/^offered$/) }
      ]));
      const savedHistory = await project(assignedId);
      expect(savedHistory.review.assignmentHistory[0]).toMatchObject({ fromDeveloperId: winner.id, developerId: replacement.id });
      const retainedConversation = await responseJson(await manager.api.get(`${techProjectPath(assignedId)}/conversation`), 'read retained customer conversation after reassignment');
      expect(JSON.stringify(retainedConversation)).toContain(scopedResources.message);
      const retainedFile = await manager.api.get(`${techProjectPath(assignedId)}/files/0`);
      expect(retainedFile.status()).toBe(200);
      expect(await retainedFile.body()).toEqual(scopedResources.file);
      const funded = await project(financialId);
      expect(funded).toBeTruthy();
      expect(funded.canAssign).toBe(false);
      expect([403, 409]).toContain((await manager.api.post(`${techProjectPath(financialId)}/assignment`, {
        data: { developerId: otherDeveloper.id, version: funded.version, reason: 'This cannot reassign existing commission history.' }
      })).status());
      expect(await financialSnapshot(db, [assignedId, financialId, foreignId])).toEqual(financialBefore);

      expect((await winner.api.post(`/api/developer/projects/${assignedId}/decision`, { data: { decision: 'accept' } })).status()).toBe(404);
      await responseJson(await replacement.api.post(`/api/developer/projects/${assignedId}/decision`, {
        data: { decision: 'accept', note: 'Synthetic developer acceptance after reassignment.' }
      }), 'accept assignment in existing developer workflow');
      const accepted = await responseJson(await replacement.api.get('/api/dashboard'), 'read accepted developer task');
      expect(accepted.projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: assignedId, taskStatus: 'accepted' })]));
      expect(accepted.user.referralCode).toBeTruthy();
      const deliveryFile = Buffer.from('%PDF-1.4\n% Synthetic technical delivery attachment.\n');
      await responseJson(await replacement.api.post(`/api/developer/projects/${assignedId}/files`, {
        multipart: { attachment: { name: 'synthetic-technical-delivery.pdf', mimeType: 'application/pdf', buffer: deliveryFile } }
      }), 'upload developer delivery in the existing workflow', [201]);
      const deliveredFile = await manager.api.get(`${techProjectPath(assignedId)}/files/1`);
      expect(deliveredFile.status()).toBe(200);
      expect(await deliveredFile.body()).toEqual(deliveryFile);
      await responseJson(await replacement.api.patch(`/api/developer/projects/${assignedId}`, {
        data: { status: 'review_requested', note: 'Synthetic work sent for technical review.' }
      }), 'submit work for technical review through the existing developer API');
      const financialBeforeRevision = await financialSnapshot(db, [assignedId, financialId, foreignId]);
      const historicalCommissions = snapshot => snapshot.commissions.filter(({ entry }) => entry.requestId === financialId)
        .map(({ entry }) => ({ id: entry.id, userId: entry.userId, amount: entry.amount, status: entry.status, sourcePaymentId: entry.sourcePaymentId }));
      expect(historicalCommissions(financialBeforeRevision)).toEqual(historicalCommissions(financialBefore));
      const submitted = await project(assignedId);
      const revision = 'Synthetic technical revision before the Owner decision.';
      await responseJson(await manager.api.patch(`${techProjectPath(assignedId)}/review`, {
        data: { requestRevision: revision, version: submitted.version }
      }), 'request a technical revision without approving payment or delivery');
      const revised = await project(assignedId);
      expect(revised).toMatchObject({ projectStage: 'needs_revisions', developerTaskStatus: 'revision_requested' });
      const developerNotifications = await responseJson(await replacement.api.get('/api/notifications?limit=100'), 'read the assigned developer notifications');
      expect(developerNotifications.notifications).toEqual(expect.arrayContaining([
        expect.objectContaining({ titleEn: 'Technical delivery revisions requested' })
      ]));
      expect(await financialSnapshot(db, [assignedId, financialId, foreignId])).toEqual(financialBeforeRevision);
    });

    await test.step('Render the Arabic workspace on a desktop and mobile-sized browser', async () => {
      const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
      browserContexts.push(context);
      const page = await context.newPage();
      await page.goto('/team');
      await expect(page.locator('html')).toHaveAttribute('data-zezo-app-ready', 'true');
      const form = page.locator('#managerLoginForm');
      await form.locator('[name="username"]').fill(manager.username);
      await form.locator('[name="password"]').fill(manager.password);
      await form.locator('button[type="submit"]').click();
      const challenge = form.locator('[name="mfaCode"]');
      await expect(challenge).toBeVisible();
      await expect(page.locator('#dashboardBackdrop.open')).toHaveCount(0);
      await challenge.fill(totp(managerSecret));
      await form.locator('button[type="submit"]').click();
      await expect(page.locator('[data-development-manager]').first()).toBeVisible();
      await page.locator('[data-dash-tab="technical-requests"]').click();
      const delegatedProject = page.locator(`[data-dm-project="${assignedId}"]`).first();
      await expect(delegatedProject).toBeVisible();
      await delegatedProject.locator('[data-dm-open="review"]').click();
      await expect(delegatedProject.locator('[data-dm-review]')).toBeVisible();
      for (const tab of ['finance', 'commissions', 'withdrawals', 'employees', 'permissions', 'referral']) {
        await expect(page.locator(`[data-dash-tab="${tab}"]`)).toHaveCount(0);
      }
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await page.setViewportSize({ width, height });
        const dashboard = page.locator('#dashboardBackdrop .dashboard');
        const fitsViewport = await dashboard.evaluate(element => {
          const viewport = document.documentElement.clientWidth;
          const bounds = element.getBoundingClientRect();
          return bounds.left >= -1 && bounds.right <= viewport + 1 && element.scrollWidth <= element.clientWidth + 1;
        });
        expect(fitsViewport, `The ${width}px workspace must not overflow horizontally`).toBe(true);
        const path = testInfo.outputPath(`development-manager-${width}.png`);
        await delegatedProject.locator('[data-dm-review]').scrollIntoViewIfNeeded();
        await page.screenshot({ path, animations: 'disabled' });
        await testInfo.attach(`development-manager-${width}`, { path, contentType: 'image/png' });
      }
    });

    await test.step('Revoke a Development Manager and invalidate their old session', async () => {
      await responseJson(await ownerApi.patch(`/api/admin/permissions/${manager.id}`, { data: { role: 'developer' } }), 'revoke Development Manager role');
      expect((await manager.api.get(techPath)).status()).toBe(401);
      const newLogin = await manager.api.post('/api/auth/login', { data: {
        username: manager.username, password: manager.password, accountType: 'employee', mfaCode: totp(managerSecret)
      } });
      expect(newLogin.status()).toBe(200);
      expect((await manager.api.get(techPath)).status()).toBe(403);
    });
  } finally {
    await Promise.allSettled(browserContexts.map(context => context.close()));
    await Promise.allSettled(contexts.map(context => context.dispose()));
    await db.end();
  }
}
