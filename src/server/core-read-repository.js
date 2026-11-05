import { queryPostgres, withPostgresScopedTransaction } from './postgres-runtime.js';

const asIso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export async function findLoginAccount(username) {
  const result = await queryPostgres(`
    SELECT id, email, username, role, active, "fullName", "passwordHash", data, "createdAt"
    FROM user_accounts
    WHERE username = $1 AND active = TRUE
    LIMIT 1
  `, [username]);
  const row = result.rows[0];
  return row ? {
    ...object(row.data), id: row.id, email: row.email || '', username: row.username || '', role: row.role,
    active: row.active, name: row.fullName || row.data?.name || '', passwordHash: row.passwordHash || undefined,
    createdAt: asIso(row.createdAt)
  } : null;
}

export async function loadSessionAccount(sessionHash) {
  const result = await queryPostgres(`
    SELECT s.id AS session_id, s."userId", s."expiresAt", u.id, u.email, u.username,
      u.role, u.active, u."fullName", u."passwordHash", u.data, u."createdAt"
    FROM auth_sessions s
    JOIN user_accounts u ON u.id = s."userId"
    WHERE s.id = $1 AND s."expiresAt" > NOW() AND u.active = TRUE
    LIMIT 1
  `, [sessionHash]);
  const row = result.rows[0];
  return row ? {
    sessionId: row.session_id,
    expires: new Date(row.expiresAt).getTime(),
    user: {
      ...object(row.data), id: row.id, email: row.email || '', username: row.username || '', role: row.role,
      active: row.active, name: row.fullName || row.data?.name || '', passwordHash: row.passwordHash || undefined,
      createdAt: asIso(row.createdAt)
    }
  } : null;
}

export async function storeLoginSessionAndAudit({ sessionHash, user, expiresAt, auditId, at }) {
  return withPostgresScopedTransaction(async client => {
    await client.query(
      'INSERT INTO auth_sessions (id, "userId", "expiresAt", data) VALUES ($1, $2, $3, $4::jsonb)',
      [sessionHash, user.id, expiresAt, '{}']
    );
    await client.query(
      'INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt") VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
      [auditId, user.id, 'login', user.id, JSON.stringify({ actor: user.username, role: user.role, detail: '' }), at]
    );
  });
}

export async function claimGuestConversations(clientId, guestHash, updatedAt) {
  if (!clientId || !guestHash) return 0;
  const result = await queryPostgres(`
    UPDATE conversations
    SET "customerId" = $1,
        data = (data - 'guestSessionHash') || jsonb_build_object('clientId', $1),
        "updatedAt" = $3
    WHERE "customerId" IS NULL AND data ->> 'guestSessionHash' = $2
  `, [clientId, guestHash, updatedAt]);
  return result.rowCount || 0;
}

function conversationWhere(user, { permissionScope, department, conversationId, guestHash }) {
  const values = [];
  const clauses = [];
  const add = (sql, ...items) => {
    let statement = sql;
    for (const value of items) {
      values.push(value);
      statement = statement.replace('?', `$${values.length}`);
    }
    clauses.push(statement);
  };

  if (conversationId) add('c.id = ?', conversationId);
  if (user.role === 'admin') return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
  if (user.role === 'client') {
    if (guestHash) {
      add('(c."customerId" = ? OR (c."customerId" IS NULL AND c.data ->> \'guestSessionHash\' = ?))', user.id, guestHash);
    } else add('c."customerId" = ?', user.id);
    return { where: `WHERE ${clauses.join(' AND ')}`, values };
  }

  if (user.role === 'guest') {
    if (!guestHash) return { where: 'WHERE FALSE', values: [] };
    add('c."customerId" IS NULL AND c.data ->> \'guestSessionHash\' = ?', guestHash);
    return { where: `WHERE ${clauses.join(' AND ')}`, values };
  }

  if (permissionScope === 'all') return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
  if (permissionScope === 'assigned') add('c."assignedToId" = ?', user.id);
  else if (permissionScope === 'department') add("COALESCE(NULLIF(c.data ->> 'department', ''), 'orders') = ?", department);
  else return { where: 'WHERE FALSE', values: [] };
  return { where: `WHERE ${clauses.join(' AND ')}`, values };
}

export async function loadConversationViews(user, options = {}) {
  const { where, values } = conversationWhere(user, options);
  const conversations = await queryPostgres(`
    SELECT c.id, c."customerId", c."assignedToId", c.status, c."templateId", c.source, c.data, c."createdAt", c."updatedAt",
      customer."fullName" AS customer_name, customer.email AS customer_email,
      assignee."fullName" AS assignee_name
    FROM conversations c
    LEFT JOIN user_accounts customer ON customer.id = c."customerId"
    LEFT JOIN user_accounts assignee ON assignee.id = c."assignedToId"
    ${where}
    ORDER BY c."updatedAt" DESC, c.id
    ${options.conversationId ? 'LIMIT 1' : 'LIMIT 500'}
  `, values);
  const rows = conversations.rows;
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const messageResult = await queryPostgres(`
    SELECT m.id, m."conversationId", m."senderId", m.body, m.data, m."createdAt",
      sender."fullName" AS sender_name
    FROM conversation_messages m
    LEFT JOIN user_accounts sender ON sender.id = m."senderId"
    WHERE m."conversationId" = ANY($1::text[])
    ORDER BY m."createdAt", m.id
  `, [ids]);
  const quoteResult = await queryPostgres(
    'SELECT id, "conversationId", amount, currency, state, data, "createdAt" FROM quotes WHERE "conversationId" = ANY($1::text[]) ORDER BY "createdAt" DESC',
    [ids]
  );
  const messages = new Map(ids.map(id => [id, []]));
  for (const message of messageResult.rows) {
    const data = object(message.data);
    messages.get(message.conversationId).push({
      id: message.id, senderType: data.senderType || (message.senderId ? 'staff' : 'guest'), senderId: message.senderId,
      senderName: message.sender_name || '', text: message.body, createdAt: asIso(message.createdAt), attachments: Array.isArray(data.attachments) ? data.attachments : []
    });
  }
  const quotes = new Map();
  for (const quote of quoteResult.rows) {
    if (quotes.has(quote.conversationId)) continue;
    quotes.set(quote.conversationId, {
      ...object(quote.data), id: quote.id, amount: Number(quote.amount), currency: quote.currency, status: quote.state,
      createdAt: asIso(quote.createdAt)
    });
  }

  return rows.map(row => {
    const data = object(row.data);
    let attachmentIndex = 0;
    const clientName = row.customer_name || data.clientName || '';
    return {
      id: row.id, createdAt: asIso(row.createdAt), updatedAt: asIso(row.updatedAt), templateId: row.templateId || data.templateId || '',
      templateName: data.templateName || '', templateService: data.templateService || '', templateCategory: data.templateCategory || '',
      source: row.source || data.source || 'website', referralCode: data.referralCode || '', referralLinkId: data.referralLinkId || null,
      referralUserId: data.referralUserId || null, clientId: row.customerId || null, clientName,
      ...(user.role === 'admin' ? { clientEmail: row.customer_email || '' } : {}), status: row.status,
      department: data.department || 'orders', assignedUserId: row.assignedToId || '', assignedUserName: row.assignee_name || '',
      leadId: data.leadId || null, conversionRequested: Boolean(data.conversionRequestedAt), quote: quotes.get(row.id) || data.quote || null,
      agreedPriceSnapshot: data.agreedPriceSnapshot || null,
      messages: (messages.get(row.id) || []).map(message => ({
        id: message.id, senderType: message.senderType,
        senderName: message.senderType === 'staff' ? (message.senderName || 'ZEZO') : message.senderType === 'client' ? (clientName || 'Client') : 'ZEZO visitor',
        text: message.text, createdAt: message.createdAt,
        attachments: message.attachments.map(file => {
          const item = { index: attachmentIndex++, name: file.originalName || file.name || 'attachment', size: Number(file.size || 0) };
          return item;
        })
      }))
    };
  });
}

export async function loadCrmRecordsForViewer({ user, scope, filters = {} }) {
  const values = [];
  const clauses = [];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
  if (user.role === 'marketer' || user.role === 'developer') add("data ->> 'referralUserId' = ?", user.id);
  else if (user.role === 'marketing_manager') {
    if (scope === 'assigned') add("data ->> 'assignedUserId' = ?", user.id);
    else if (scope === 'department' && (user.department || 'marketing') !== 'orders') clauses.push('FALSE');
    else if (!['all', 'department'].includes(scope)) clauses.push('FALSE');
  }
  if (filters.from) add('"createdAt" >= ?::date', filters.from);
  if (filters.to) add('"createdAt" < (?::date + INTERVAL \'1 day\')', filters.to);
  if (filters.status) add("status = ?", filters.status);
  if (filters.employee) {
    values.push(filters.employee);
    const index = values.length;
    clauses.push(`(data ->> 'referralUserId' = $${index} OR data ->> 'assignedUserId' = $${index})`);
  }
  if (filters.service) add("data ->> 'service' = ?", filters.service);
  if (filters.search) {
    values.push(`%${filters.search}%`);
    const index = values.length;
    clauses.push(`LOWER(CONCAT_WS(' ', data ->> 'name', data ->> 'phone', data ->> 'email', data ->> 'service', data ->> 'details', data ->> 'referralCode')) LIKE $${index}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await queryPostgres(`SELECT id, data, status, "createdAt", "updatedAt" FROM crm_records ${where} ORDER BY "updatedAt" DESC`, values);
  return result.rows.map(row => ({ ...object(row.data), id: row.id, status: row.status || row.data?.status || '', createdAt: asIso(row.createdAt), updatedAt: asIso(row.updatedAt) }));
}

export async function loadReferralEventsForUsers(userIds, { from = '', to = '', service = '' } = {}) {
  if (!userIds.length) return [];
  const values = [userIds];
  const clauses = ['"userId" = ANY($1::text[])', "COALESCE(data ->> 'reversedAt', '') = ''"];
  if (from) { values.push(from); clauses.push(`"createdAt" >= $${values.length}::date`); }
  if (to) { values.push(to); clauses.push(`"createdAt" < ($${values.length}::date + INTERVAL '1 day')`); }
  if (service) {
    values.push(service);
    const index = values.length;
    clauses.push(`(("eventType" IN ('service_view','whatsapp_click') AND "resourceId" = $${index}) OR ("eventType" = 'template_view' AND data ->> 'service' = $${index}))`);
  }
  const result = await queryPostgres(`SELECT "userId", "eventType", "visitorHash", "resourceId", "requestId", data, "createdAt" FROM referral_events WHERE ${clauses.join(' AND ')}`, values);
  return result.rows.map(row => ({ ...object(row.data), userId: row.userId, type: row.eventType, visitorHash: row.visitorHash || '', resourceId: row.resourceId || '', leadId: row.requestId || row.data?.leadId || '', createdAt: asIso(row.createdAt) }));
}

export async function loadCrmRelatedRows(records) {
  const userIds = [...new Set(records.flatMap(row => [row.assignedUserId, row.referralUserId]).filter(Boolean))];
  const orderIds = [...new Set(records.flatMap(row => Array.isArray(row.orderIds) ? row.orderIds : []))];
  const [usersResult, requestsResult] = await Promise.all([
    userIds.length ? queryPostgres('SELECT id, "fullName", role, data FROM user_accounts WHERE id = ANY($1::text[])', [userIds]) : Promise.resolve({ rows: [] }),
    orderIds.length ? queryPostgres('SELECT id, status, data, "createdAt" FROM project_requests WHERE id = ANY($1::text[])', [orderIds]) : Promise.resolve({ rows: [] })
  ]);
  return {
    users: new Map(usersResult.rows.map(row => [row.id, { ...object(row.data), id: row.id, name: row.fullName || row.data?.name || '', role: row.role }])),
    orders: new Map(requestsResult.rows.map(row => [row.id, { ...object(row.data), id: row.id, status: row.status || row.data?.status || '', createdAt: asIso(row.createdAt) }]))
  };
}

export async function loadClientDashboardData(clientId) {
  const requestResult = await queryPostgres(`
    SELECT id, "customerId", "referrerId", "developerId", status, "projectStage", "templateId", "agreedAmount", data, "createdAt", "updatedAt"
    FROM project_requests
    WHERE "customerId" = $1
    ORDER BY "createdAt" DESC
  `, [clientId]);
  const leads = requestResult.rows.map(row => ({
    ...object(row.data), id: row.id, clientId: row.customerId || null, referralUserId: row.referrerId || row.data?.referralUserId || null,
    developerUserId: row.developerId || row.data?.developerUserId || null, status: row.status || row.data?.status || 'new',
    projectStage: row.projectStage || row.data?.projectStage || 'new_request', templateId: row.templateId || row.data?.templateId || '',
    contractAmount: row.agreedAmount == null ? row.data?.contractAmount ?? null : Number(row.agreedAmount),
    createdAt: asIso(row.createdAt), updatedAt: asIso(row.updatedAt)
  }));
  const ids = leads.map(lead => lead.id);
  if (!ids.length) return { leads, payments: [] };
  const paymentResult = await queryPostgres(`
    SELECT id, "requestId", amount, currency, status, data, "createdAt"
    FROM payments WHERE "requestId" = ANY($1::text[]) ORDER BY "createdAt", id
  `, [ids]);
  const payments = paymentResult.rows.map(row => ({
    ...object(row.data), id: row.id, leadId: row.requestId, amount: Number(row.amount), currency: row.currency,
    status: row.status, createdAt: asIso(row.createdAt)
  }));
  return { leads, payments };
}

// Minimal, role-owned dashboard data for marketers and developers. This keeps
// personal dashboards off the compatibility-store loader while retaining the
// existing serializer and its privacy rules in server.js.
export async function loadEmployeeDashboardData(userId) {
  const [requestResult, crmResult, eventResult, linkResult, withdrawalResult, ledgerResult, rankResult, settingsResult] = await Promise.all([
    queryPostgres(`
      SELECT id, "customerId", "referrerId", "developerId", status, "projectStage", "templateId", "agreedAmount", data, "createdAt", "updatedAt"
      FROM project_requests
      WHERE "referrerId" = $1 OR "developerId" = $1
      ORDER BY "createdAt" DESC
    `, [userId]),
    queryPostgres(`SELECT id, status, data, "createdAt", "updatedAt" FROM crm_records WHERE data ->> 'referralUserId' = $1 ORDER BY "updatedAt" DESC`, [userId]),
    queryPostgres('SELECT id, "userId", code, "eventType", "visitorHash", "resourceId", "requestId", "idempotencyKey", data, "createdAt" FROM referral_events WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]),
    queryPostgres('SELECT id, "userId", code, month, active, data, "createdAt" FROM referral_links WHERE "userId" = $1 ORDER BY "createdAt"', [userId]),
    queryPostgres('SELECT id, "userId", amount, status, data, "createdAt", "updatedAt" FROM withdrawal_requests WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]),
    queryPostgres('SELECT id, type, status, "requestId", "employeeId", amount, currency, "idempotencyKey", data, "createdAt" FROM finance_ledger_entries WHERE "employeeId" = $1 ORDER BY "createdAt" DESC LIMIT 250', [userId]),
    queryPostgres('SELECT id, "userId", "fromRank", "requestedRank", "salesCount", "commissionPercent", state, "reviewedBy", data, "createdAt", "reviewedAt" FROM rank_requests WHERE "userId" = $1 ORDER BY "createdAt" DESC', [userId]),
    queryPostgres('SELECT value FROM app_settings WHERE key = $1', ['zezo-runtime'])
  ]);

  const leads = requestResult.rows.map(row => ({
    ...object(row.data), id: row.id, clientId: row.customerId || row.data?.clientId || null,
    referralUserId: row.referrerId || row.data?.referralUserId || null,
    developerUserId: row.developerId || row.data?.developerUserId || null,
    status: row.status || row.data?.status || 'new', projectStage: row.projectStage || row.data?.projectStage || 'new_request',
    templateId: row.templateId || row.data?.templateId || '',
    contractAmount: row.agreedAmount == null ? row.data?.contractAmount ?? null : Number(row.agreedAmount),
    createdAt: asIso(row.createdAt), updatedAt: asIso(row.updatedAt)
  }));
  const leadIds = leads.map(row => row.id);
  if (leadIds.length) {
    const [projectResult, assignmentResult, commissionResult] = await Promise.all([
      queryPostgres('SELECT id, "requestId", "developerId", stage, "dueAt", data FROM projects WHERE "requestId" = ANY($1::text[])', [leadIds]),
      queryPostgres('SELECT id, "projectId", "developerId", state, "commissionPercent", "expectedCommission", data, "assignedAt", "respondedAt" FROM project_assignments WHERE "developerId" = $1 AND "projectId" = ANY($2::text[])', [userId, leadIds.map(id => `project_${id}`)]),
      queryPostgres('SELECT id, "userId", "requestId", kind, "ratePercent", amount, status, data FROM commissions WHERE "userId" = $1 AND "requestId" = ANY($2::text[])', [userId, leadIds])
    ]);
    const leadById = new Map(leads.map(row => [row.id, row]));
    for (const row of projectResult.rows) {
      const lead = leadById.get(row.requestId);
      if (!lead) continue;
      const data = object(row.data);
      lead.projectStage = row.stage || lead.projectStage;
      lead.developerUserId = row.developerId || lead.developerUserId || null;
      if (row.dueAt) lead.developerDueDate = asIso(row.dueAt);
      for (const key of ['developerTaskStatus', 'developerReviewStatus', 'developerCommissionRate', 'developerCommissionAmount', 'developerCommissionStatus', 'developerCommissionPaidAmount', 'developerCommissionOffsetAmount', 'developerCommissionDebtRemaining', 'developerWithdrawalId', 'projectHistory', 'projectStartedAt', 'projectDeliveredAt', 'projectCompletedAt']) {
        if (data[key] !== undefined) lead[key] = data[key];
      }
    }
    for (const row of assignmentResult.rows) {
      const lead = leadById.get(row.projectId.replace(/^project_/, ''));
      if (!lead || (lead.developerUserId && lead.developerUserId !== row.developerId)) continue;
      const data = object(row.data);
      lead.developerUserId = row.developerId;
      lead.developerTaskStatus = row.state;
      lead.developerCommissionRate = Number(row.commissionPercent) || 25;
      if (row.expectedCommission != null) lead.developerCommissionExpected = Number(row.expectedCommission);
      for (const key of ['developerDueDate', 'developerAssignedAt', 'developerAcceptedAt', 'developerDeclinedAt', 'developerTaskNote']) if (data[key] !== undefined) lead[key] = data[key];
    }
    for (const row of commissionResult.rows) {
      const lead = leadById.get(row.requestId);
      if (!lead) continue;
      const data = object(row.data);
      if (row.kind === 'developer') {
        lead.developerUserId = row.userId;
        lead.developerCommissionRate = Number(row.ratePercent);
        lead.developerCommissionAmount = Number(row.amount);
        lead.developerCommissionStatus = row.status;
        for (const key of ['developerCommissionPaidAmount', 'developerCommissionOffsetAmount', 'developerCommissionDebtRemaining', 'developerWithdrawalId', 'developerReviewStatus', 'developerCommissionReview', 'developerCommissionHoldUntil']) if (data[key] !== undefined) lead[key] = data[key];
      } else {
        lead.referralUserId = row.userId;
        lead.commissionRate = Number(row.ratePercent);
        lead.commissionAmount = Number(row.amount);
        lead.commissionStatus = row.status;
        for (const key of ['commissionPaidAmount', 'commissionOffsetAmount', 'commissionDebtRemaining', 'withdrawalId', 'commissionRank', 'commissionRateSetAt', 'commissionHoldUntil']) if (data[key] !== undefined) lead[key] = data[key];
      }
    }
  }

  const mapJsonRows = (rows, mapper = row => row) => rows.map(source => mapper({ ...object(source.data), id: source.id }, source));
  return {
    leads,
    crmLeads: crmResult.rows.map(row => ({ ...object(row.data), id: row.id, status: row.status || row.data?.status || '', createdAt: asIso(row.createdAt), updatedAt: asIso(row.updatedAt) })),
    referralEvents: mapJsonRows(eventResult.rows, (row, source) => ({ ...row, userId: source.userId, code: source.code || '', type: source.eventType, visitorHash: source.visitorHash || null, resourceId: source.resourceId || '', leadId: source.requestId || row.leadId || '', idempotencyKey: source.idempotencyKey || null, reversedAt: row.reversedAt || '', createdAt: asIso(source.createdAt) })),
    referralLinks: mapJsonRows(linkResult.rows, (row, source) => ({ ...row, userId: source.userId, code: source.code, month: source.month, active: source.active, createdAt: asIso(source.createdAt) })),
    withdrawals: mapJsonRows(withdrawalResult.rows, (row, source) => ({ ...row, userId: source.userId, amount: Number(source.amount), status: source.status, createdAt: asIso(source.createdAt), updatedAt: asIso(source.updatedAt) })),
    financeLedger: mapJsonRows(ledgerResult.rows, (row, source) => ({ ...row, leadId: row.leadId || source.requestId || null, employeeId: source.employeeId || null, amountCents: Math.round(Number(source.amount) * 100), currency: source.currency, type: source.type, statusSnapshot: source.status, idempotencyKey: source.idempotencyKey || null, postedAt: asIso(source.createdAt) })),
    rankRequests: mapJsonRows(rankResult.rows, (row, source) => ({ ...row, userId: source.userId, fromRank: source.fromRank, requestedRank: source.requestedRank, salesCount: source.salesCount, commissionPercent: source.commissionPercent == null ? null : Number(source.commissionPercent), state: source.state, reviewedBy: source.reviewedBy || null, createdAt: asIso(source.createdAt), reviewedAt: source.reviewedAt ? asIso(source.reviewedAt) : null })),
    settings: settingsResult.rows[0]?.value || {}
  };
}
