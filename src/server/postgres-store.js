import { withPostgresTransaction } from './postgres-runtime.js';

const isoDate = value => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
};

const nullableDate = value => {
  if (value == null || value === '') return null;
  const date = isoDate(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const json = value => JSON.stringify(value ?? {});
const safeNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const safeText = value => String(value ?? '');

export async function deleteReferralTrackingForVisitor(visitorHash) {
  if (!visitorHash) return { events: 0, attributions: 0 };
  return withPostgresTransaction(async client => {
    const events = await client.query(
      'DELETE FROM referral_events WHERE "visitorHash" = $1 AND "eventType" = ANY($2::text[])',
      [visitorHash, ['visit', 'service_view', 'template_view', 'whatsapp_click']]
    );
    const attributions = await client.query('DELETE FROM referral_attributions WHERE "visitorHash" = $1', [visitorHash]);
    return { events: events.rowCount || 0, attributions: attributions.rowCount || 0 };
  });
}

async function rows(client, sql) {
  return (await client.query(sql)).rows;
}

async function upsert(client, table, primaryKey, columns, records) {
  for (const record of records) {
    const names = columns.map(([name]) => `"${name}"`);
    const values = columns.map(([, get]) => get(record));
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updates = columns.filter(([name]) => name !== primaryKey).map(([name]) => `"${name}" = EXCLUDED."${name}"`);
    const statement = `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("${primaryKey}") DO UPDATE SET ${updates.join(', ')}`;
    await client.query(statement, values);
  }
}

function withId(row) {
  return row?.data && typeof row.data === 'object' ? { ...row.data, id: row.id } : { ...(row || {}) };
}

export async function loadNormalizedStore(client, defaultStore) {
  const next = defaultStore();
  const settings = await client.query('SELECT value FROM app_settings WHERE key = $1', ['zezo-runtime']);
  if (settings.rowCount) next.settings = { ...next.settings, ...(settings.rows[0].value || {}) };

  const userRows = await rows(client, 'SELECT id, email, username, role, active, "fullName", "passwordHash", data, "createdAt" FROM user_accounts ORDER BY "createdAt"');
  next.users = userRows.map(row => ({
    ...(row.data || {}), id: row.id, email: row.email || '', username: row.username || '', role: row.role,
    active: row.active, name: row.fullName || row.data?.name || '', passwordHash: row.passwordHash || undefined,
    createdAt: isoDate(row.createdAt).toISOString()
  }));

  // Keep each read on the transaction's single pg Client sequentially. Running Promise.all
  // here queues concurrent queries on one connection and triggers pg's active-query warning.
  const requestRows = await rows(client, 'SELECT id, "customerId", "referrerId", "developerId", status, "projectStage", "templateId", "agreedAmount", data, "createdAt", "updatedAt" FROM project_requests ORDER BY "createdAt"');
  const crmRows = await rows(client, 'SELECT id, status, source, data, "createdAt", "updatedAt" FROM crm_records ORDER BY "updatedAt" DESC');
  const conversationRows = await rows(client, 'SELECT id, "customerId", "assignedToId", status, "templateId", source, data, "createdAt", "updatedAt" FROM conversations ORDER BY "createdAt"');
  const messageRows = await rows(client, 'SELECT id, "conversationId", "senderId", body, "attachmentId", data, "createdAt" FROM conversation_messages ORDER BY "createdAt", id');
  const quoteRows = await rows(client, 'SELECT id, "conversationId", amount, currency, state, data, "createdAt" FROM quotes ORDER BY "createdAt"');
  const paymentRows = await rows(client, 'SELECT id, "requestId", amount, currency, status, "idempotencyKey", data, "createdAt" FROM payments ORDER BY "createdAt"');
  const withdrawalRows = await rows(client, 'SELECT id, "userId", amount, status, "reviewedBy", data, "createdAt", "updatedAt" FROM withdrawal_requests ORDER BY "createdAt" DESC');
  const financeRows = await rows(client, 'SELECT id, type, status, "requestId", "employeeId", amount, currency, "idempotencyKey", data, "createdAt" FROM finance_ledger_entries ORDER BY "createdAt" DESC');
  const expenseRows = await rows(client, 'SELECT id, category, status, amount, currency, "recordedBy", data, "createdAt" FROM expense_records ORDER BY "createdAt" DESC');
  const notificationRows = await rows(client, 'SELECT id, "userId", type, "readAt", data, "createdAt" FROM system_notifications ORDER BY "createdAt" DESC');
  const auditRows = await rows(client, 'SELECT id, "actorId", action, "targetId", data, "createdAt" FROM audit_entries ORDER BY "createdAt" DESC LIMIT 500');
  const referralLinkRows = await rows(client, 'SELECT id, "userId", code, month, active, data, "createdAt" FROM referral_links ORDER BY "createdAt"');
  const referralEventRows = await rows(client, 'SELECT id, "userId", code, "eventType", "visitorHash", "resourceId", "requestId", "idempotencyKey", data, "createdAt" FROM referral_events ORDER BY "createdAt"');
  const attributionRows = await rows(client, 'SELECT id, "userId", "requestId", code, "visitorHash", "expiresAt", data, "createdAt" FROM referral_attributions WHERE "expiresAt" > NOW() ORDER BY "createdAt" DESC LIMIT 200000');
  const rankRows = await rows(client, 'SELECT id, "userId", "fromRank", "requestedRank", "salesCount", "commissionPercent", state, "reviewedBy", data, "createdAt", "reviewedAt" FROM rank_requests ORDER BY "createdAt" DESC');
  const campaignRows = await rows(client, 'SELECT id, state, data, "createdAt", "updatedAt" FROM marketing_campaigns ORDER BY "createdAt" DESC');
  const outboxRows = await rows(client, 'SELECT id, recipient, state, attempts, data, "createdAt", "updatedAt" FROM outbox_messages ORDER BY "createdAt" DESC');
  const projectRows = await rows(client, 'SELECT id, "requestId", "developerId", stage, "dueAt", data, "createdAt", "updatedAt" FROM projects');
  const assignmentRows = await rows(client, 'SELECT id, "projectId", "developerId", state, "commissionPercent", "expectedCommission", data, "assignedAt", "respondedAt" FROM project_assignments');
  const commissionRows = await rows(client, 'SELECT id, "userId", "requestId", kind, "ratePercent", amount, status, "sourcePaymentId", data, "createdAt" FROM commissions');
  const templatePriceRows = await rows(client, 'SELECT "templateId", price, active, currency, data FROM template_prices');
  const invitationRows = await rows(client, 'SELECT id, email, role, status, "expiresAt", "invitedById", data, "createdAt" FROM employee_invitations ORDER BY "createdAt" DESC');

  next.leads = requestRows.map(row => ({
    ...withId(row), clientId: row.customerId || row.data?.clientId || null,
    referralUserId: row.referrerId || row.data?.referralUserId || null,
    developerUserId: row.developerId || row.data?.developerUserId || null,
    status: row.status || row.data?.status || 'new', projectStage: row.projectStage || row.data?.projectStage || 'new_request',
    templateId: row.templateId || row.data?.templateId || '',
    contractAmount: row.agreedAmount == null ? row.data?.contractAmount ?? null : safeNumber(row.agreedAmount),
    createdAt: isoDate(row.createdAt).toISOString(), updatedAt: isoDate(row.updatedAt).toISOString()
  }));
  const leadById = new Map(next.leads.map(item => [item.id, item]));
  for (const row of projectRows) {
    const lead = leadById.get(row.requestId);
    if (!lead) continue;
    const projectData = row.data || {};
    lead.projectStage = row.stage || lead.projectStage;
    lead.developerUserId = row.developerId || lead.developerUserId || null;
    if (row.dueAt) lead.developerDueDate = isoDate(row.dueAt).toISOString();
    for (const key of ['developerTaskStatus', 'developerReviewStatus', 'developerCommissionRate', 'developerCommissionAmount', 'developerCommissionStatus', 'developerCommissionPaidAmount', 'developerCommissionOffsetAmount', 'developerCommissionDebtRemaining', 'developerWithdrawalId', 'projectHistory', 'projectStartedAt', 'projectDeliveredAt', 'projectCompletedAt']) {
      if (projectData[key] !== undefined) lead[key] = projectData[key];
    }
  }
  for (const row of assignmentRows) {
    const lead = leadById.get(row.projectId?.replace(/^project_/, '')) || leadById.get(row.projectId);
    if (!lead || (lead.developerUserId && lead.developerUserId !== row.developerId)) continue;
    const assignment = row.data || {};
    lead.developerUserId = row.developerId;
    lead.developerTaskStatus = row.state;
    lead.developerCommissionRate = safeNumber(row.commissionPercent) || 25;
    if (row.expectedCommission != null) lead.developerCommissionExpected = safeNumber(row.expectedCommission);
    for (const key of ['developerDueDate', 'developerAssignedAt', 'developerAcceptedAt', 'developerDeclinedAt', 'developerTaskNote']) if (assignment[key] !== undefined) lead[key] = assignment[key];
  }
  for (const row of commissionRows) {
    const lead = leadById.get(row.requestId);
    if (!lead) continue;
    const detail = row.data || {};
    if (row.kind === 'developer') {
      lead.developerUserId = row.userId;
      lead.developerCommissionRate = safeNumber(row.ratePercent);
      lead.developerCommissionAmount = safeNumber(row.amount);
      lead.developerCommissionStatus = row.status;
      for (const key of ['developerCommissionPaidAmount', 'developerCommissionOffsetAmount', 'developerCommissionDebtRemaining', 'developerWithdrawalId', 'developerReviewStatus', 'developerCommissionReview', 'developerCommissionHoldUntil']) if (detail[key] !== undefined) lead[key] = detail[key];
    } else {
      lead.referralUserId = row.userId;
      lead.commissionRate = safeNumber(row.ratePercent);
      lead.commissionAmount = safeNumber(row.amount);
      lead.commissionStatus = row.status;
      for (const key of ['commissionPaidAmount', 'commissionOffsetAmount', 'commissionDebtRemaining', 'withdrawalId', 'commissionRank', 'commissionRateSetAt', 'commissionHoldUntil']) if (detail[key] !== undefined) lead[key] = detail[key];
    }
  }
  next.crmLeads = crmRows.map(withId);
  next.conversations = conversationRows.map(row => ({
    ...withId(row), clientId: row.customerId || row.data?.clientId || null,
    assignedUserId: row.assignedToId || row.data?.assignedUserId || null,
    status: row.status || 'new', templateId: row.templateId || row.data?.templateId || '',
    source: row.source || row.data?.source || 'website', messages: [], quote: null,
    createdAt: isoDate(row.createdAt).toISOString(), updatedAt: isoDate(row.updatedAt).toISOString()
  }));
  const conversationById = new Map(next.conversations.map(item => [item.id, item]));
  for (const row of messageRows) {
    const conversation = conversationById.get(row.conversationId);
    if (!conversation) continue;
    conversation.messages.push({ ...(row.data || {}), id: row.id, senderId: row.senderId || row.data?.senderId || null, text: row.body, createdAt: isoDate(row.createdAt).toISOString() });
  }
  for (const row of quoteRows) {
    const conversation = conversationById.get(row.conversationId);
    if (conversation) conversation.quote = { ...(row.data || {}), id: row.id, amount: safeNumber(row.amount), currency: row.currency, status: row.state };
  }
  next.payments = paymentRows.map(row => ({ ...withId(row), leadId: row.data?.leadId || row.requestId, amount: safeNumber(row.amount), currency: row.currency, status: row.status, idempotencyKey: row.idempotencyKey || null, createdAt: isoDate(row.createdAt).toISOString() }));
  next.withdrawals = withdrawalRows.map(row => ({ ...withId(row), userId: row.userId, amount: safeNumber(row.amount), status: row.status, reviewedBy: row.reviewedBy || null, createdAt: isoDate(row.createdAt).toISOString(), updatedAt: isoDate(row.updatedAt).toISOString() }));
  next.financeLedger = financeRows.map(row => ({ ...withId(row), leadId: row.data?.leadId || row.requestId || null, employeeId: row.employeeId || null, amountCents: Math.round(safeNumber(row.amount) * 100), currency: row.currency, type: row.type, statusSnapshot: row.status, idempotencyKey: row.idempotencyKey || null, createdAt: isoDate(row.createdAt).toISOString() }));
  next.expenses = expenseRows.map(row => ({ ...withId(row), amount: safeNumber(row.amount), currency: row.currency, createdAt: isoDate(row.createdAt).toISOString() }));
  next.notifications = notificationRows.map(row => ({ ...withId(row), userId: row.userId, readAt: row.readAt ? isoDate(row.readAt).toISOString() : null, createdAt: isoDate(row.createdAt).toISOString() }));
  next.audit = auditRows.map(row => ({ ...withId(row), actorId: row.actorId || '', actor: row.data?.actor || '', role: row.data?.role || '', action: row.action, target: row.targetId || '', detail: row.data?.detail || '', at: isoDate(row.createdAt).toISOString() }));
  next.referralLinks = referralLinkRows.map(row => ({ ...withId(row), userId: row.userId, code: row.code, month: row.month, active: row.active, createdAt: isoDate(row.createdAt).toISOString() }));
  next.referralEvents = referralEventRows.map(row => ({ ...withId(row), userId: row.userId, code: row.code || '', type: row.eventType, visitorHash: row.visitorHash || null, resourceId: row.resourceId || '', leadId: row.data?.leadId || row.requestId || '', followupId: row.data?.followupId || '', idempotencyKey: row.idempotencyKey || null, reversedAt: row.data?.reversedAt || '', createdAt: isoDate(row.createdAt).toISOString() }));
  next.referralVisits = next.referralEvents.filter(row => row.type === 'visit').map(row => ({ referralUserId: row.userId, visitorHash: row.visitorHash, createdAt: row.createdAt }));
  next.referralAttributions = attributionRows.map(row => ({ ...(row.data || {}), id: row.id, userId: row.userId, requestId: row.requestId || '', code: row.code, visitorHash: row.visitorHash, expiresAt: isoDate(row.expiresAt).getTime(), firstSeenAt: row.data?.firstSeenAt || isoDate(row.createdAt).toISOString() }));
  next.rankRequests = rankRows.map(row => ({ ...withId(row), userId: row.userId, fromRank: row.fromRank, requestedRank: row.requestedRank, salesCount: row.salesCount, commissionPercent: row.commissionPercent == null ? null : safeNumber(row.commissionPercent), state: row.state, reviewedBy: row.reviewedBy || null, createdAt: isoDate(row.createdAt).toISOString(), reviewedAt: row.reviewedAt ? isoDate(row.reviewedAt).toISOString() : null }));
  next.campaigns = campaignRows.map(withId);
  next.mailQueue = outboxRows.map(row => ({ ...withId(row), recipient: row.recipient || '', state: row.state, attempts: row.attempts, createdAt: isoDate(row.createdAt).toISOString(), updatedAt: isoDate(row.updatedAt).toISOString() }));
  for (const row of invitationRows) {
    const user = next.users.find(item => item.id === row.data?.employeeId || item.id === row.id);
    if (!user) continue;
    user.invitationId = row.id; user.email ||= row.email || ''; user.role = row.role || user.role;
    user.inviteStatus = row.status; user.inviteExpiresAt = isoDate(row.expiresAt).toISOString(); user.inviteCreatedBy ||= row.invitedById;
  }

  const priceMap = { ...(next.settings.templatePrices || {}) };
  const activeMap = { ...(next.settings.templateActive || {}) };
  const inclusionMap = { ...(next.settings.templateInclusions || {}) };
  for (const row of templatePriceRows) {
    priceMap[row.templateId] = safeNumber(row.price);
    activeMap[row.templateId] = row.active;
    if (row.data?.inclusion) inclusionMap[row.templateId] = row.data.inclusion;
  }
  next.settings.templatePrices = priceMap;
  next.settings.templateActive = activeMap;
  next.settings.templateInclusions = inclusionMap;
  return next;
}

export async function persistNormalizedStore(client, store) {
  const userIds = new Set(store.users.map(user => user.id));
  const dateField = (row, key, fallback = row.createdAt) => isoDate(row[key] || fallback);
  const userRows = store.users.map(user => ({ ...user, createdAt: user.createdAt || new Date().toISOString() }));
  await upsert(client, 'user_accounts', 'id', [
    ['id', row => row.id], ['email', row => row.email || null], ['username', row => row.username || null], ['role', row => row.role],
    ['active', row => row.active !== false], ['fullName', row => safeText(row.name || row.fullName).slice(0, 120) || null],
    ['passwordHash', row => row.passwordHash || null], ['data', row => json(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'passwordHash')))],
    ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', () => new Date()]
  ], userRows);

  const leads = store.leads || [];
  await upsert(client, 'project_requests', 'id', [
    ['id', row => row.id], ['customerId', row => userIds.has(row.clientId) ? row.clientId : null], ['referrerId', row => userIds.has(row.referralUserId) ? row.referralUserId : null],
    ['developerId', row => row.developerUserId || null], ['status', row => row.status || null], ['projectStage', row => row.projectStage || null], ['templateId', row => row.templateId || null],
    ['agreedAmount', row => row.contractAmount == null ? null : safeNumber(row.contractAmount)], ['currency', () => 'ILS'], ['data', row => json(row)],
    ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => dateField(row, 'updatedAt')]
  ], leads);

  const projectRows = leads.map(lead => ({
    lead, id: `project_${lead.id}`, requestId: lead.id, developerId: lead.developerUserId || null,
    stage: lead.projectStage || 'new_request', dueAt: nullableDate(lead.developerDueDate),
    createdAt: lead.createdAt, updatedAt: lead.updatedAt || lead.createdAt
  }));
  await upsert(client, 'projects', 'id', [
    ['id', row => row.id], ['requestId', row => row.requestId], ['developerId', row => row.developerId], ['stage', row => row.stage],
    ['dueAt', row => row.dueAt], ['data', row => json(row.lead)], ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => isoDate(row.updatedAt)]
  ], projectRows);

  const assignments = leads.filter(lead => lead.developerUserId).map(lead => ({
    id: `assignment_${lead.id}_${lead.developerUserId}`, projectId: `project_${lead.id}`, developerId: lead.developerUserId,
    state: lead.developerTaskStatus || 'offered', commissionPercent: 25,
    expectedCommission: safeNumber(lead.contractAmount) * 0.25, lead,
    assignedAt: lead.developerAssignedAt || lead.createdAt, respondedAt: lead.developerAcceptedAt || lead.developerDeclinedAt || null
  }));
  await upsert(client, 'project_assignments', 'id', [
    ['id', row => row.id], ['projectId', row => row.projectId], ['developerId', row => row.developerId], ['state', row => row.state],
    ['commissionPercent', row => row.commissionPercent], ['expectedCommission', row => row.expectedCommission], ['data', row => json(row.lead)],
    ['assignedAt', row => isoDate(row.assignedAt)], ['respondedAt', row => nullableDate(row.respondedAt)]
  ], assignments);

  const crmRows = (store.crmLeads || []).map(row => ({ ...row, updatedAt: row.updatedAt || row.createdAt }));
  await upsert(client, 'crm_records', 'id', [
    ['id', row => row.id], ['status', row => row.status || null], ['source', row => row.source || null], ['data', row => json(row)],
    ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => isoDate(row.updatedAt)]
  ], crmRows);

  const conversations = store.conversations || [];
  await upsert(client, 'conversations', 'id', [
    ['id', row => row.id], ['customerId', row => userIds.has(row.clientId) ? row.clientId : null], ['assignedToId', row => userIds.has(row.assignedUserId) ? row.assignedUserId : null],
    ['status', row => row.status || 'new'], ['templateId', row => row.templateId || null], ['source', row => row.source || null],
    ['data', row => json(({ ...row, messages: undefined, quote: undefined }))], ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => isoDate(row.updatedAt)]
  ], conversations);
  const messages = conversations.flatMap(conversation => (conversation.messages || []).map(message => ({ conversation, message })));
  await upsert(client, 'conversation_messages', 'id', [
    ['id', row => row.message.id], ['conversationId', row => row.conversation.id], ['senderId', row => userIds.has(row.message.senderId) ? row.message.senderId : null],
    ['body', row => safeText(row.message.text)], ['attachmentId', row => row.message.attachments?.[0]?.attachmentId || null], ['data', row => json(row.message)],
    ['createdAt', row => isoDate(row.message.createdAt)]
  ], messages);
  const quotes = conversations.filter(conversation => conversation.quote?.id).map(conversation => ({ conversation, quote: conversation.quote }));
  await upsert(client, 'quotes', 'id', [
    ['id', row => row.quote.id], ['conversationId', row => row.conversation.id], ['amount', row => safeNumber(row.quote.amount)], ['currency', row => row.quote.currency || 'ILS'],
    ['state', row => row.quote.status || 'draft'], ['data', row => json(row.quote)], ['createdAt', row => isoDate(row.quote.createdAt || row.conversation.createdAt)]
  ], quotes);

  const payments = (store.payments || []).map(row => ({ ...row, requestId: row.leadId || row.requestId }));
  await upsert(client, 'payments', 'id', [
    ['id', row => row.id], ['requestId', row => row.requestId], ['amount', row => safeNumber(row.amount)], ['currency', row => row.currency || 'ILS'],
    ['status', row => row.status || row.kind || 'recorded'], ['idempotencyKey', row => row.idempotencyKey || null], ['data', row => json(row)], ['createdAt', row => isoDate(row.createdAt || row.at)]
  ], payments);

  const commissions = [];
  for (const lead of leads) {
    if (lead.referralUserId && lead.commissionRate != null && Number.isFinite(Number(lead.commissionAmount))) commissions.push({
      id: `commission_referral_${lead.id}`, userId: lead.referralUserId, requestId: lead.id, kind: 'referral', ratePercent: safeNumber(lead.commissionRate),
      amount: safeNumber(lead.commissionAmount), status: lead.commissionStatus || 'pending', sourcePaymentId: null,
      details: Object.fromEntries(Object.entries(lead).filter(([key]) => ['commissionPaidAmount', 'commissionOffsetAmount', 'commissionDebtRemaining', 'withdrawalId', 'commissionRank', 'commissionRateSetAt', 'commissionHoldUntil'].includes(key))), createdAt: lead.createdAt
    });
    if (lead.developerUserId) commissions.push({
      id: `commission_developer_${lead.id}`, userId: lead.developerUserId, requestId: lead.id, kind: 'developer', ratePercent: 25,
      amount: safeNumber(lead.developerCommissionAmount), status: lead.developerCommissionStatus || 'pending', sourcePaymentId: null,
      details: Object.fromEntries(Object.entries(lead).filter(([key]) => key.startsWith('developerCommission') || ['developerWithdrawalId', 'developerReviewStatus', 'developerReviewApprovedAt', 'developerCommissionHoldUntil'].includes(key))), createdAt: lead.createdAt
    });
  }
  await upsert(client, 'commissions', 'id', [
    ['id', row => row.id], ['userId', row => row.userId], ['requestId', row => row.requestId], ['kind', row => row.kind], ['ratePercent', row => row.ratePercent],
    ['amount', row => row.amount], ['currency', () => 'ILS'], ['status', row => row.status], ['sourcePaymentId', row => row.sourcePaymentId],
    ['data', row => json(row.details)], ['createdAt', row => isoDate(row.createdAt)]
  ], commissions.filter(row => userIds.has(row.userId)));

  const withdrawals = (store.withdrawals || []).filter(row => userIds.has(row.userId));
  await upsert(client, 'withdrawal_requests', 'id', [
    ['id', row => row.id], ['userId', row => row.userId], ['amount', row => safeNumber(row.amount)], ['status', row => row.status || 'pending'],
    ['reviewedBy', row => userIds.has(row.reviewedBy) ? row.reviewedBy : null], ['data', row => json(row)],
    ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => dateField(row, 'updatedAt')]
  ], withdrawals);

  const rankRequests = (store.rankRequests || []).filter(row => userIds.has(row.userId));
  await upsert(client, 'rank_requests', 'id', [
    ['id', row => row.id], ['userId', row => row.userId], ['fromRank', row => row.fromRank || 'rookie'], ['requestedRank', row => row.requestedRank || row.toRank || 'pro'],
    ['salesCount', row => Math.max(0, Math.floor(safeNumber(row.salesCount)))], ['commissionPercent', row => row.commissionPercent == null ? null : safeNumber(row.commissionPercent)],
    ['state', row => row.state || row.status || 'pending'], ['reviewedBy', row => row.reviewedBy || null], ['data', row => json(row)],
    ['createdAt', row => isoDate(row.createdAt)], ['reviewedAt', row => nullableDate(row.reviewedAt)]
  ], rankRequests);

  const links = (store.referralLinks || []).filter(row => userIds.has(row.userId));
  await upsert(client, 'referral_links', 'id', [
    ['id', row => row.id], ['userId', row => row.userId], ['code', row => row.code], ['month', row => row.month || 'legacy'], ['active', row => row.active !== false],
    ['createdAt', row => isoDate(row.createdAt)], ['data', row => json(row)]
  ], links);

  const events = (store.referralEvents || []).filter(row => userIds.has(row.userId));
  await upsert(client, 'referral_events', 'id', [
    ['id', row => row.id], ['userId', row => row.userId], ['code', row => row.code || null], ['eventType', row => row.type || 'unknown'],
    ['visitorHash', row => row.visitorHash || null], ['resourceId', row => row.resourceId || null], ['requestId', row => row.leadId || row.requestId || null],
    ['idempotencyKey', row => row.idempotencyKey || null], ['createdAt', row => isoDate(row.createdAt)], ['data', row => json(row)]
  ], events);
  await client.query('DELETE FROM referral_events WHERE NOT (id = ANY($1::text[]))', [events.map(row => row.id)]);
  await client.query('DELETE FROM referral_attributions WHERE "expiresAt" <= NOW()');
  const attributions = (store.referralAttributions || []).filter(row => userIds.has(row.userId) && row.visitorHash && Number(row.expiresAt) > Date.now());
  await upsert(client, 'referral_attributions', 'id', [
    ['id', row => row.id || `att_${row.visitorHash}`], ['userId', row => row.userId], ['requestId', row => row.requestId || null], ['code', row => row.code],
    ['visitorHash', row => row.visitorHash], ['expiresAt', row => new Date(Number(row.expiresAt))], ['createdAt', row => isoDate(row.firstSeenAt || row.createdAt)], ['data', row => json(row)]
  ], attributions);

  const financeEntries = store.financeLedger || [];
  await upsert(client, 'finance_ledger_entries', 'id', [
    ['id', row => row.id], ['type', row => row.type || 'adjustment'], ['status', row => row.statusSnapshot || row.status || 'posted'],
    ['requestId', row => row.leadId || row.requestId || null], ['employeeId', row => userIds.has(row.employeeId) ? row.employeeId : null],
    ['amount', row => safeNumber(row.amountCents) / 100], ['currency', row => row.currency || 'ILS'], ['idempotencyKey', row => row.idempotencyKey || null],
    ['data', row => json(row)], ['createdAt', row => isoDate(row.postedAt || row.createdAt)]
  ], financeEntries);
  const expenses = store.expenses || [];
  await upsert(client, 'expense_records', 'id', [
    ['id', row => row.id], ['category', row => row.category || row.service || 'operating'], ['status', row => row.status || 'recorded'], ['amount', row => safeNumber(row.amount)],
    ['currency', row => row.currency || 'ILS'], ['recordedBy', row => row.createdBy || 'system'], ['data', row => json(row)], ['createdAt', row => isoDate(row.createdAt || row.date)]
  ], expenses);

  const crmNotifications = (store.notifications || []).filter(row => userIds.has(row.userId));
  await upsert(client, 'system_notifications', 'id', [
    ['id', row => row.id], ['userId', row => row.userId], ['type', row => row.type || null], ['readAt', row => nullableDate(row.readAt)],
    ['data', row => json(row)], ['createdAt', row => isoDate(row.createdAt)]
  ], crmNotifications);
  await upsert(client, 'audit_entries', 'id', [
    ['id', row => row.id], ['actorId', row => userIds.has(row.actorId) ? row.actorId : null], ['action', row => row.action || 'event'], ['targetId', row => row.target || row.targetId || null],
    ['data', row => json(row)], ['createdAt', row => isoDate(row.at || row.createdAt)]
  ], store.audit || []);
  await upsert(client, 'marketing_campaigns', 'id', [
    ['id', row => row.id], ['state', row => row.state || null], ['data', row => json(row)], ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => dateField(row, 'updatedAt')]
  ], store.campaigns || []);
  await upsert(client, 'outbox_messages', 'id', [
    ['id', row => row.id], ['recipient', row => row.to || row.recipient || null], ['state', row => row.state || 'queued'], ['attempts', row => Math.max(0, Math.floor(safeNumber(row.attempts)))],
    ['data', row => json(row)], ['createdAt', row => isoDate(row.createdAt)], ['updatedAt', row => dateField(row, 'updatedAt')]
  ], store.mailQueue || []);

  const invitations = store.users.filter(user => user.inviteStatus || user.inviteCreatedBy || user.invitationId).map(user => ({
    id: user.invitationId || `invitation_${user.id}`, email: user.email || null, role: user.role, status: user.inviteStatus || (user.active ? 'accepted' : 'pending'),
    expiresAt: isoDate(user.inviteExpiresAt || user.activationExpires || Date.now() + 86400000), invitedById: user.inviteCreatedBy || 'system', employeeId: user.id, createdAt: user.createdAt, user
  }));
  await upsert(client, 'employee_invitations', 'id', [
    ['id', row => row.id], ['email', row => row.email], ['role', row => row.role], ['status', row => row.status], ['expiresAt', row => row.expiresAt],
    ['invitedById', row => row.invitedById], ['data', row => json({ employeeId: row.employeeId })], ['createdAt', row => isoDate(row.createdAt)]
  ], invitations);

  const settingsData = store.settings || {};
  await client.query(
    'INSERT INTO app_settings (key, value, "updatedAt") VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()',
    ['zezo-runtime', json(settingsData)]
  );
  const templatePrices = Object.keys(settingsData.templatePrices || {}).map(templateId => ({
    templateId, price: safeNumber(settingsData.templatePrices[templateId]), active: settingsData.templateActive?.[templateId] !== false,
    inclusion: settingsData.templateInclusions?.[templateId] || null
  }));
  await upsert(client, 'template_prices', 'templateId', [
    ['templateId', row => row.templateId], ['price', row => row.price], ['active', row => row.active], ['currency', () => 'ILS'],
    ['data', row => json({ inclusion: row.inclusion })], ['updatedAt', () => new Date()]
  ], templatePrices);
}
