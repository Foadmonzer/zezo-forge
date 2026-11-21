import { randomBytes } from 'node:crypto';
import { withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Create a team invitation with short, row-scoped PostgreSQL writes. */
export async function createPostgresEmployeeInvitation({
  sessionHash, inviterId, user, invitation, auditId, outboxMessage, authorize
}) {
  return withPostgresScopedTransaction(async client => {
    const authResult = await client.query(`
      SELECT s.id AS session_id, u.id, u.email, u.username, u.role, u.active,
        u."fullName", u.data, u."createdAt"
      FROM auth_sessions s
      JOIN user_accounts u ON u.id = s."userId"
      WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > NOW() AND u.active = TRUE
      FOR SHARE OF s, u
    `, [sessionHash, inviterId]);
    const authRow = authResult.rows[0];
    if (!authRow) return { kind: 'unauthenticated' };

    const inviter = {
      ...object(authRow.data), id: authRow.id, email: authRow.email || '',
      username: authRow.username || '', role: authRow.role, active: authRow.active,
      name: authRow.fullName || authRow.data?.name || '',
      createdAt: authRow.createdAt instanceof Date ? authRow.createdAt.toISOString() : authRow.createdAt
    };
    const authorizationError = authorize(inviter);
    if (authorizationError) return { kind: 'forbidden', ...authorizationError };

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zezo-account-email:${user.email.toLowerCase()}`]);

    const duplicate = await client.query(
      'SELECT 1 FROM user_accounts WHERE username = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
      [user.username, user.email]
    );
    if (duplicate.rowCount) return { kind: 'duplicate' };

    await client.query(`
      INSERT INTO user_accounts
        (id, email, username, role, active, "fullName", "passwordHash", data, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, FALSE, $5, NULL, $6::jsonb, $7, $7)
    `, [user.id, user.email, user.username, user.role, user.name, JSON.stringify(user), user.createdAt]);

    await client.query(`
      INSERT INTO employee_invitations
        (id, email, role, status, "expiresAt", "invitedById", data, "createdAt")
      VALUES ($1, $2, $3, 'pending', $4, $5, $6::jsonb, $7)
    `, [invitation.id, user.email, user.role, invitation.expiresAt, inviter.id, JSON.stringify({ employeeId: user.id }), user.createdAt]);

    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, 'employee_invited', $3, $4::jsonb, $5)
    `, [auditId, inviter.id, user.id, JSON.stringify({ actor: inviter.username, role: inviter.role, detail: `${user.role} ${user.username}` }), user.createdAt]);

    const managers = await client.query(`
      SELECT id, role FROM user_accounts
      WHERE active = TRUE AND role IN ('admin', 'hr_manager') AND id <> $1
    `, [inviter.id]);
    for (const manager of managers.rows) {
      const notificationId = `ntf_${cryptoRandomId()}`;
      const tab = manager.role === 'admin' ? 'team' : 'people';
      const data = {
        eventKey: `audit:${auditId}`, type: 'team', importance: 'high',
        titleAr: 'دعوة موظف تنتظر المراجعة', titleEn: 'Employee invitation needs review',
        descriptionAr: 'تم تجهيز دعوة موظف. راجعها ضمن إدارة الفريق.',
        descriptionEn: 'An employee invitation was prepared. Review it in Team management.',
        target: { tab, id: user.id, kind: 'employee' }
      };
      await client.query(`
        INSERT INTO system_notifications (id, "userId", type, "readAt", data, "createdAt")
        VALUES ($1, $2, 'team', NULL, $3::jsonb, $4)
      `, [notificationId, manager.id, JSON.stringify(data), user.createdAt]);
    }

    await client.query(`
      INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
      VALUES ($1, $2, 'pending', 0, $3::jsonb, $4, $4)
    `, [outboxMessage.id, outboxMessage.recipient, JSON.stringify(outboxMessage.data), user.createdAt]);

    return { kind: 'created', user, inviter };
  }).catch(error => {
    if (error?.code === '23505') return { kind: 'duplicate' };
    throw error;
  });
}

async function loadInvitationActor(client, sessionHash, actorId) {
  const result = await client.query(`
    SELECT s.id AS session_id, u.id, u.email, u.username, u.role, u.active,
      u."fullName", u.data, u."createdAt"
    FROM auth_sessions s
    JOIN user_accounts u ON u.id = s."userId"
    WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > NOW() AND u.active = TRUE
    FOR SHARE OF s, u
  `, [sessionHash, actorId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...object(row.data), id: row.id, email: row.email || '', username: row.username || '',
    role: row.role, active: row.active, name: row.fullName || row.data?.name || '',
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
  };
}

async function loadInvitationTarget(client, employeeId) {
  const result = await client.query(`
    SELECT i.id AS invitation_id, i.email AS invitation_email, i.role AS invitation_role,
      i.status AS invitation_status, i."expiresAt" AS invitation_expires_at,
      i."invitedById" AS invitation_inviter_id, i.data AS invitation_data,
      u.id AS employee_id, u.email AS account_email, u.username, u.role AS account_role,
      u.active, u."fullName", u."passwordHash", u.data AS account_data, u."createdAt", u."updatedAt"
    FROM employee_invitations i
    JOIN user_accounts u ON u.id = i.data->>'employeeId'
    WHERE u.id = $1
    ORDER BY i."createdAt" DESC, i.id DESC
    LIMIT 1
    FOR UPDATE OF i, u
  `, [employeeId]);
  const row = result.rows[0];
  if (!row) return null;
  const data = object(row.account_data);
  return {
    ...data,
    id: row.employee_id,
    name: row.fullName || data.name || '',
    email: row.account_email || row.invitation_email || '',
    username: row.username || data.username || '',
    role: row.account_role || row.invitation_role,
    active: row.active,
    passwordHash: row.passwordHash || data.passwordHash || null,
    inviteStatus: row.invitation_status,
    inviteExpiresAt: row.invitation_expires_at instanceof Date ? row.invitation_expires_at.toISOString() : row.invitation_expires_at,
    inviteCreatedBy: data.inviteCreatedBy || row.invitation_inviter_id,
    inviteApprovalStatus: data.inviteApprovalStatus || '',
    invitationId: row.invitation_id,
    _invitationData: object(row.invitation_data),
    _accountData: data,
    _invitationExpiresAt: row.invitation_expires_at
  };
}

function appendInvitationAudit(client, { auditId, actor, employee, action, at, detail }) {
  return client.query(`
    INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  `, [auditId, actor.id, action, employee.id, JSON.stringify({ actor: actor.username, role: actor.role, detail }), at]);
}

/** Revoke an unaccepted invitation and its account-level activation token atomically. */
export async function revokePostgresEmployeeInvitation({
  sessionHash, actorId, employeeId, auditId, revokedAt, authorize
}) {
  return withPostgresScopedTransaction(async client => {
    const actor = await loadInvitationActor(client, sessionHash, actorId);
    if (!actor) return { kind: 'unauthenticated' };
    const employee = await loadInvitationTarget(client, employeeId);
    if (!employee) return { kind: 'missing' };
    const authorizationError = authorize(actor, employee);
    if (authorizationError) return { kind: 'forbidden', ...authorizationError };
    if (employee.active || employee.passwordHash) return { kind: 'accepted' };
    if (!['pending', 'pending_approval'].includes(employee.inviteStatus)) return { kind: 'not_pending' };

    const data = { ...employee._accountData, inviteStatus: 'revoked', inviteRevokedAt: revokedAt,
      inviteRevokedBy: actor.id, activationHash: null, activationExpires: 0, inviteExpiresAt: null };
    await client.query('UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1', [employee.id, JSON.stringify(data), revokedAt]);
    await client.query('UPDATE employee_invitations SET status = \'revoked\' WHERE id = $1', [employee.invitationId]);
    await appendInvitationAudit(client, {
      auditId, actor, employee, action: 'employee_invitation_revoked', at: revokedAt,
      detail: employee.role
    });
    return { kind: 'revoked', employee: { ...employee, ...data, inviteStatus: 'revoked', activationHash: null } };
  });
}

/** Rotate the existing account's activation token; never creates a second account. */
export async function reissuePostgresEmployeeInvitation({
  sessionHash, actorId, employeeId, activationHash, activationExpires,
  issuedAt, expiresAt, auditId, outboxMessage, authorize
}) {
  return withPostgresScopedTransaction(async client => {
    const actor = await loadInvitationActor(client, sessionHash, actorId);
    if (!actor) return { kind: 'unauthenticated' };
    const employee = await loadInvitationTarget(client, employeeId);
    if (!employee) return { kind: 'missing' };
    const authorizationError = authorize(actor, employee);
    if (authorizationError) return { kind: 'forbidden', ...authorizationError };
    if (employee.active || employee.passwordHash) return { kind: 'accepted' };
    const invitationExpired = employee._invitationExpiresAt instanceof Date
      ? employee._invitationExpiresAt.getTime() <= Date.now()
      : Date.parse(employee._invitationExpiresAt || '') <= Date.now();
    const pendingAndValid = employee.inviteStatus === 'pending' && !invitationExpired;
    const lastReissuedAt = Date.parse(employee._accountData.inviteLastReissuedAt || '');
    if (pendingAndValid && Number.isFinite(lastReissuedAt) && Date.now() - lastReissuedAt < 60_000) {
      return { kind: 'recently_reissued' };
    }
    if (!['expired', 'revoked'].includes(employee.inviteStatus) && !(employee.inviteStatus === 'pending' && invitationExpired) && !pendingAndValid) {
      return { kind: 'not_reissuable' };
    }

    const data = { ...employee._accountData, inviteStatus: 'pending', inviteExpiresAt: expiresAt,
      inviteApprovalStatus: 'approved', activationHash, activationExpires, inviteLastReissuedAt: issuedAt };
    delete data.inviteRevokedAt;
    delete data.inviteRevokedBy;
    await client.query('UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1', [employee.id, JSON.stringify(data), issuedAt]);
    await client.query(`
      UPDATE employee_invitations
      SET email = $2, role = $3, status = 'revoked'
      WHERE data->>'employeeId' = $1 AND id <> $4 AND status IN ('pending', 'pending_approval', 'expired')
    `, [employee.id, employee.email, employee.role, employee.invitationId]);
    await client.query(`
      UPDATE employee_invitations
      SET email = $2, role = $3, status = 'pending', "expiresAt" = $4
      WHERE id = $1
    `, [employee.invitationId, employee.email, employee.role, expiresAt]);
    await appendInvitationAudit(client, {
      auditId, actor, employee, action: 'employee_invitation_resent', at: issuedAt,
      detail: employee.role
    });
    const durableOutbox = {
      ...outboxMessage,
      recipient: employee.email,
      data: { ...object(outboxMessage.data), to: employee.email }
    };
    await client.query(`
      INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
      VALUES ($1, $2, 'pending', 0, $3::jsonb, $4, $4)
    `, [durableOutbox.id, durableOutbox.recipient, JSON.stringify(durableOutbox.data), issuedAt]);
    return { kind: 'reissued', employee: { ...employee, ...data, inviteStatus: 'pending' }, invitationId: employee.invitationId };
  }).catch(error => {
    if (error?.code === '23505') return { kind: 'duplicate' };
    throw error;
  });
}

function cryptoRandomId() {
  return randomBytes(9).toString('hex');
}
