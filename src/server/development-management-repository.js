import { developmentManagerRole, developmentTechnicalStages } from './development-management.js';

const iso = value => value instanceof Date ? value.toISOString() : value;

export function scopedDevelopmentProjectSql(alias, managerParam, stagesParam) {
  return `COALESCE((${alias}.data->>'isDuplicate') = 'true', FALSE) = FALSE
    AND ${alias}.status IS DISTINCT FROM 'cancelled'
    AND CASE WHEN NULLIF(${alias}.data->'developmentReview'->>'managerId', '') IS NOT NULL
      THEN ${alias}.data->'developmentReview'->>'managerId' = ${managerParam}
      ELSE ${alias}."projectStage" = ANY(${stagesParam}::text[]) OR ${alias}.status = ANY(${stagesParam}::text[])
        OR ${alias}.data->'developmentReview'->>'inReview' = 'true'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.data->'projectHistory') = 'array'
          THEN ${alias}.data->'projectHistory' ELSE '[]'::jsonb END) entry WHERE entry->>'stage' = ANY(${stagesParam}::text[]))
    END`;
}

export async function loadDevelopmentManagement(client, { user, projectId = '', workspace = false, action = '', write = false }) {
  const values = [];
  const where = [];
  if (projectId) {
    values.push(projectId);
    where.push(`req.id = $${values.length}`);
  }
  if (user.role === developmentManagerRole) {
    const managerParam = `$${values.push(user.id)}`;
    const stagesParam = `$${values.push(developmentTechnicalStages)}`;
    where.push(scopedDevelopmentProjectSql('req', managerParam, stagesParam));
  }
  const readProject = workspace || projectId;
  const projectsResult = readProject ? await client.query(`
    SELECT req.id, req."customerId", req."developerId", req.status, req."projectStage", req."agreedAmount", req.data,
      req."createdAt", req."updatedAt", EXISTS(SELECT 1 FROM payments p WHERE p."requestId" = req.id) AS has_payment,
      EXISTS(SELECT 1 FROM commissions c WHERE c."requestId" = req.id AND c.kind = 'developer' AND c.amount <> 0) AS has_developer_commission,
      EXISTS(SELECT 1 FROM projects p JOIN project_assignments a ON a."projectId" = p.id WHERE p."requestId" = req.id
        AND a."developerId" = req."developerId" AND a.state NOT IN ('', 'offered', 'reassigned', 'declined')) AS has_developer_progress
    FROM project_requests req
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY req."createdAt" DESC
    ${write ? 'FOR UPDATE OF req' : ''}
  `, values) : { rows: [] };
  const leads = projectsResult.rows.map(row => ({
    ...row.data, id: row.id, developerUserId: row.developerId || null, clientId: row.customerId || null,
    status: row.status || row.data?.status || 'new', projectStage: row.projectStage || row.data?.projectStage,
    contractAmount: row.agreedAmount ?? row.data?.contractAmount, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    hasDeveloperCommission: row.has_developer_commission, hasDeveloperProgress: row.has_developer_progress
  }));
  const payments = projectsResult.rows.filter(row => row.has_payment).map(row => ({ leadId: row.id }));
  const directory = workspace || ['profile', 'review', 'assignment', 'delegation'].includes(action);
  const priorDeveloperIds = action === 'assignment' ? leads.map(lead => lead.developerUserId).filter(Boolean) : [];
  const userRows = directory ? await client.query(`
    SELECT id, username, "fullName", role, active, "createdAt",
      data->>'accountDisabledAt' AS "accountDisabledAt", data->'developmentProfile' AS "developmentProfile"
    FROM user_accounts
    WHERE role = ANY($1::text[]) OR id = ANY($2::text[])
    ORDER BY "fullName", username
  `, [['admin', 'developer', developmentManagerRole], priorDeveloperIds]) : { rows: [] };
  const users = userRows.rows.map(row => ({
    id: row.id, name: row.fullName || row.username || '', username: row.username, role: row.role,
    active: row.active, accountDisabledAt: row.accountDisabledAt, developmentProfile: row.developmentProfile,
    createdAt: iso(row.createdAt)
  }));
  const workloadRows = workspace || action === 'profile' ? await client.query(`
    SELECT id, "developerId" AS "developerUserId", status, "projectStage",
      data->>'developerDueDate' AS "developerDueDate", data->>'developerUpdatedAt' AS "developerUpdatedAt",
      data->>'developerRespondedAt' AS "developerRespondedAt", data->>'developerAssignedAt' AS "developerAssignedAt"
    FROM project_requests WHERE "developerId" IS NOT NULL AND (data->>'isDuplicate') IS DISTINCT FROM 'true'
  `) : { rows: [] };
  const conversations = [];
  const lead = leads[0];
  if (lead?.clientId && lead.developmentReview?.allowCustomerConversation === true && action.startsWith('conversation')) {
    const rows = await client.query(`
      SELECT id, status, "customerId", data->>'leadId' AS "leadId", data->>'department' AS department, "updatedAt"
      FROM conversations
      WHERE "customerId" = $1 AND data->>'leadId' = $2 AND COALESCE(data->>'department', 'orders') IN ('orders', 'development')
      ORDER BY "updatedAt" DESC
      ${write ? 'FOR UPDATE' : ''}
    `, [lead.clientId, lead.id]);
    const ids = rows.rows.map(row => row.id);
    const messages = ids.length ? await client.query(`
      SELECT id, "conversationId", body, "createdAt", data->>'senderType' AS "senderType",
        data->>'visibility' AS visibility, data->'attachments' AS attachments
      FROM conversation_messages WHERE "conversationId" = ANY($1::text[])
        AND data->>'senderType' IN ('client', 'staff') AND COALESCE(data->>'internal', '') <> 'true'
        AND COALESCE(data->>'visibility', 'public') IN ('public', 'customer')
      ORDER BY "createdAt", id
    `, [ids]) : { rows: [] };
    for (const row of rows.rows) {
      conversations.push({ id: row.id, clientId: row.customerId, leadId: row.leadId, department: row.department,
        status: row.status, updatedAt: iso(row.updatedAt),
        messages: messages.rows.filter(message => message.conversationId === row.id).map(message => ({
          ...message, text: message.body, createdAt: iso(message.createdAt), attachments: message.attachments || []
        })) });
    }
  }
  return { leads, payments, users, workload: workloadRows.rows, conversations };
}

export async function saveDevelopmentProfile(client, developer, updatedAt) {
  await client.query(`UPDATE user_accounts SET data = data || jsonb_build_object('developmentProfile', $2::jsonb), "updatedAt" = $3 WHERE id = $1 AND role = 'developer'`,
    [developer.id, JSON.stringify(developer.developmentProfile), updatedAt]);
}

export async function saveDevelopmentProject(client, lead, { action, previousDeveloperId, revision, commissionRate }) {
  const changed = { developmentReview: lead.developmentReview, updatedAt: lead.updatedAt };
  if (action === 'delegation' && lead.technicalRequirements !== undefined) changed.technicalRequirements = lead.technicalRequirements;
  if (action === 'assignment' || revision) {
    Object.assign(changed, { projectStage: lead.projectStage, projectHistory: lead.projectHistory,
      developerTaskStatus: lead.developerTaskStatus, developerTaskNote: lead.developerTaskNote });
  }
  if (revision) changed.developerUpdatedAt = lead.developerUpdatedAt;
  if (action === 'assignment') Object.assign(changed, { developerUserId: lead.developerUserId, developerAssignedAt: lead.developerAssignedAt,
    developerDueDate: lead.developerDueDate, developerRespondedAt: null, developerDeclinedAt: null });
  const json = JSON.stringify(changed);
  if (action !== 'assignment' && !revision) {
    await client.query('UPDATE project_requests SET data = data || $2::jsonb, "updatedAt" = $3 WHERE id = $1', [lead.id, json, lead.updatedAt]);
    await client.query('UPDATE projects SET data = data || $2::jsonb, "updatedAt" = $3 WHERE "requestId" = $1', [lead.id, json, lead.updatedAt]);
    return;
  }
  await client.query(`UPDATE project_requests SET "developerId" = $2, "projectStage" = $3, data = data || $4::jsonb, "updatedAt" = $5 WHERE id = $1`,
    [lead.id, lead.developerUserId, lead.projectStage, json, lead.updatedAt]);
  const project = await client.query(`
    INSERT INTO projects (id, "requestId", "developerId", stage, "dueAt", data, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    ON CONFLICT ("requestId") DO UPDATE SET "developerId" = EXCLUDED."developerId", stage = EXCLUDED.stage,
      "dueAt" = EXCLUDED."dueAt", data = projects.data || EXCLUDED.data, "updatedAt" = EXCLUDED."updatedAt"
    RETURNING id
  `, [`project_${lead.id}`, lead.id, lead.developerUserId, lead.projectStage, lead.developerDueDate || null, json, lead.createdAt, lead.updatedAt]);
  const projectId = project.rows[0].id;
  if (revision) {
    await client.query(`UPDATE project_assignments SET state = $3, data = data || $4::jsonb WHERE "projectId" = $1 AND "developerId" = $2`,
      [projectId, lead.developerUserId, lead.developerTaskStatus, json]);
    return;
  }
  if (previousDeveloperId) {
    await client.query(`UPDATE project_assignments SET state = 'reassigned', data = data || jsonb_build_object('reassignedAt', $3::text)
      WHERE "projectId" = $1 AND "developerId" = $2 AND state IN ('', 'offered')`, [projectId, previousDeveloperId, lead.updatedAt]);
  }
  await client.query(`
    INSERT INTO project_assignments (id, "projectId", "developerId", state, "commissionPercent", "expectedCommission", data, "assignedAt", "respondedAt")
    VALUES ($1, $2, $3, 'offered', $4, $5, $6::jsonb, $7, NULL)
    ON CONFLICT (id) DO UPDATE SET state = 'offered', data = project_assignments.data || EXCLUDED.data,
      "assignedAt" = EXCLUDED."assignedAt", "respondedAt" = NULL
  `, [`assignment_${lead.id}_${lead.developerUserId}`, projectId, lead.developerUserId, commissionRate,
    Math.round((Number(lead.contractAmount) || 0) * commissionRate) / 100, json, lead.developerAssignedAt]);
}

export async function saveDevelopmentMessage(client, conversation, message) {
  await client.query(`UPDATE conversations SET status = $2, "updatedAt" = $3, data = data || jsonb_build_object('status', $2::text, 'updatedAt', $4::text) WHERE id = $1`,
    [conversation.id, conversation.status, conversation.updatedAt, conversation.updatedAt]);
  await client.query(`INSERT INTO conversation_messages (id, "conversationId", "senderId", body, data, "createdAt") VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [message.id, conversation.id, message.senderId, message.text, JSON.stringify(message), message.createdAt]);
}

export async function saveDevelopmentEvents(client, audits, notifications) {
  for (const audit of audits) {
    await client.query(`INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt") VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [audit.id, audit.actorId, audit.action, audit.target, JSON.stringify(audit), audit.at]);
  }
  for (const notification of notifications) {
    await client.query(`INSERT INTO system_notifications (id, "userId", type, data, "createdAt") VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (id) DO NOTHING`,
      [notification.id, notification.userId, notification.type, JSON.stringify(notification), notification.createdAt]);
  }
}
