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
      FOR UPDATE OF s, u
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

function cryptoRandomId() {
  return randomBytes(9).toString('hex');
}
