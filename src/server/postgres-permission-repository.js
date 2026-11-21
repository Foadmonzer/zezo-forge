import { withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Update one employee account without loading or rewriting the company snapshot. */
export async function updatePostgresEmployeePermissions({
  sessionHash, actorId, targetId, updatedAt, auditId, applyChanges
}) {
  return withPostgresScopedTransaction(async client => {
    const actorResult = await client.query(`
      SELECT s.id AS session_id, u.id, u.email, u.username, u.role, u.active,
        u."fullName", u."passwordHash", u.data, u."createdAt"
      FROM auth_sessions s
      JOIN user_accounts u ON u.id = s."userId"
      WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > NOW() AND u.active = TRUE
      FOR SHARE OF s, u
    `, [sessionHash, actorId]);
    const actorRow = actorResult.rows[0];
    if (!actorRow) return { kind: 'unauthenticated' };

    const actor = {
      ...object(actorRow.data), id: actorRow.id, email: actorRow.email || '',
      username: actorRow.username || '', role: actorRow.role, active: actorRow.active,
      name: actorRow.fullName || actorRow.data?.name || '',
      createdAt: actorRow.createdAt instanceof Date ? actorRow.createdAt.toISOString() : actorRow.createdAt
    };
    if (actor.role !== 'admin') return { kind: 'forbidden' };

    const targetResult = await client.query(`
      SELECT id, email, username, role, active, "fullName", data, "createdAt"
      FROM user_accounts WHERE id = $1 FOR UPDATE
    `, [targetId]);
    const targetRow = targetResult.rows[0];
    if (!targetRow) return { kind: 'missing' };
    const target = {
      ...object(targetRow.data), id: targetRow.id, email: targetRow.email || '',
      username: targetRow.username || '', role: targetRow.role, active: targetRow.active,
      name: targetRow.fullName || targetRow.data?.name || '',
      createdAt: targetRow.createdAt instanceof Date ? targetRow.createdAt.toISOString() : targetRow.createdAt
    };
    if (target.role === 'admin') return { kind: 'owner_protected' };

    const change = applyChanges({ actor, target });
    if (change.kind) return change;

    await client.query(`
      UPDATE user_accounts
      SET role = $2, active = $3, data = $4::jsonb, "updatedAt" = $5
      WHERE id = $1
    `, [target.id, target.role, target.active !== false, JSON.stringify(target), updatedAt]);
    await client.query('DELETE FROM auth_sessions WHERE "userId" = $1', [target.id]);
    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, 'employee_permissions_updated', $3, $4::jsonb, $5)
    `, [auditId, actor.id, target.id, JSON.stringify({
      actor: actor.username, role: actor.role, detail: JSON.stringify(change.auditDetail)
    }), updatedAt]);
    return { kind: 'updated', actor, target };
  });
}
