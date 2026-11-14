import { withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

async function selectSessionAccountForUpdate(client, sessionHash, userId) {
  const result = await client.query(
    'SELECT s.id AS session_id, s."userId", s."expiresAt", u.id, u.email, u.username, u.role, u.active, u."passwordHash", u.data ' +
    'FROM auth_sessions s JOIN user_accounts u ON u.id = s."userId" ' +
    'WHERE s.id = $1 AND s."userId" = $2 AND s."expiresAt" > NOW() AND u.active = TRUE ' +
    'FOR UPDATE OF s, u',
    [sessionHash, userId]
  );
  return result.rows[0] || null;
}

async function insertAudit(client, { auditId, user, action, detail, at }) {
  await client.query(
    'INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt") VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
    [auditId, user.id, action, user.id, JSON.stringify({ actor: user.username, role: user.role, detail }), at]
  );
}

export async function changePostgresPassword({ sessionHash, userId, currentPassword, newPassword, verifyPassword, createPasswordRecord, auditId, at }) {
  return withPostgresScopedTransaction(async client => {
    const row = await selectSessionAccountForUpdate(client, sessionHash, userId);
    if (!row) return { kind: 'unauthenticated' };

    const currentUser = { ...object(row.data), id: row.id, username: row.username || '', role: row.role, passwordHash: row.passwordHash || '' };
    if (!verifyPassword(String(currentPassword || ''), currentUser)) return { kind: 'invalid_current_password' };

    const credential = createPasswordRecord(newPassword);
    const data = { ...object(row.data), salt: credential.salt, mustChangePassword: false };
    await client.query(
      'UPDATE user_accounts SET "passwordHash" = $2, data = $3::jsonb, "updatedAt" = $4 WHERE id = $1',
      [row.id, credential.passwordHash, JSON.stringify(data), at]
    );
    await insertAudit(client, { auditId, user: currentUser, action: 'password_changed', detail: '', at });
    return { kind: 'changed' };
  });
}

export async function setupPostgresMfa({ sessionHash, userId, proposedSecret }) {
  return withPostgresScopedTransaction(async client => {
    const row = await selectSessionAccountForUpdate(client, sessionHash, userId);
    if (!row) return { kind: 'unauthenticated' };
    const data = object(row.data);
    if (data.mfaEnabledAt) return { kind: 'already_enabled' };
    const secret = data.mfaSetupSecret || proposedSecret;
    if (!data.mfaSetupSecret) {
      await client.query(
        'UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = NOW() WHERE id = $1',
        [row.id, JSON.stringify({ ...data, mfaSetupSecret: secret })]
      );
    }
    return { kind: 'ready', secret };
  });
}

export async function enablePostgresMfa({ sessionHash, userId, code, verifyTotp, auditId, at }) {
  return withPostgresScopedTransaction(async client => {
    const row = await selectSessionAccountForUpdate(client, sessionHash, userId);
    if (!row) return { kind: 'unauthenticated' };
    const oldData = object(row.data);
    if (oldData.mfaEnabledAt) return { kind: 'already_enabled' };
    if (!verifyTotp(oldData.mfaSetupSecret, code)) return { kind: 'invalid_code' };

    const data = { ...oldData, mfaSecret: oldData.mfaSetupSecret, mfaEnabledAt: at };
    delete data.mfaSetupSecret;
    const user = { id: row.id, username: row.username || '', role: row.role };
    await client.query(
      'UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1',
      [row.id, JSON.stringify(data), at]
    );
    await insertAudit(client, { auditId, user, action: 'management_mfa_enabled', detail: '', at });
    return { kind: 'enabled', user: { ...oldData, ...data, id: row.id, username: row.username || '', email: row.email || '', role: row.role, active: row.active } };
  });
}

export async function logoutPostgresSession({ sessionHash, auditId, at }) {
  return withPostgresScopedTransaction(async client => {
    const result = await client.query(
      'SELECT s.id, u.id AS user_id, u.username, u.role FROM auth_sessions s JOIN user_accounts u ON u.id = s."userId" WHERE s.id = $1 FOR UPDATE OF s',
      [sessionHash]
    );
    const row = result.rows[0];
    if (row) await insertAudit(client, {
      auditId, user: { id: row.user_id, username: row.username || '', role: row.role }, action: 'logout', detail: '', at
    });
    await client.query('DELETE FROM auth_sessions WHERE id = $1', [sessionHash]);
    return Boolean(row);
  });
}
