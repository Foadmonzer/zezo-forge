import { withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export async function issuePostgresPasswordReset({ email, resetHash, expiresAt, outboxMessage, at }) {
  return withPostgresScopedTransaction(async client => {
    const selected = await client.query(`
      SELECT id, email, username, role, active, "fullName", data, "createdAt"
      FROM user_accounts
      WHERE lower(email) = $1 AND active = TRUE
      LIMIT 1 FOR UPDATE
    `, [email]);
    const row = selected.rows[0];
    if (!row) return { kind: 'not_found' };

    const data = { ...object(row.data), passwordResetHash: resetHash, passwordResetExpires: expiresAt };
    await client.query(
      'UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1',
      [row.id, JSON.stringify(data), at]
    );
    if (outboxMessage) {
      await client.query(`
        INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
        VALUES ($1, $2, 'pending', 0, $3::jsonb, $4, $4)
      `, [outboxMessage.id, row.email || email, JSON.stringify(outboxMessage), at]);
    }
    return { kind: 'queued' };
  });
}

export async function consumePostgresPasswordReset({ resetHash, credential, auditId, at }) {
  return withPostgresScopedTransaction(async client => {
    const selected = await client.query(`
      SELECT id, email, username, role, active, "fullName", "passwordHash", data, "createdAt"
      FROM user_accounts
      WHERE data ->> 'passwordResetHash' = $1 AND active = TRUE
      LIMIT 1 FOR UPDATE
    `, [resetHash]);
    const row = selected.rows[0];
    if (!row) return { kind: 'invalid' };

    const previous = object(row.data);
    const expiresAt = Number(previous.passwordResetExpires || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      const expiredData = { ...previous };
      delete expiredData.passwordResetHash;
      delete expiredData.passwordResetExpires;
      await client.query('UPDATE user_accounts SET data = $2::jsonb, "updatedAt" = $3 WHERE id = $1', [row.id, JSON.stringify(expiredData), at]);
      return { kind: 'expired' };
    }

    const data = { ...previous, salt: credential.salt, mustChangePassword: false };
    delete data.passwordResetHash;
    delete data.passwordResetExpires;
    await client.query(`
      UPDATE user_accounts
      SET "passwordHash" = $2, data = $3::jsonb, "updatedAt" = $4
      WHERE id = $1
    `, [row.id, credential.passwordHash, JSON.stringify(data), at]);

    await client.query('DELETE FROM auth_sessions WHERE "userId" = $1', [row.id]);
    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, 'password_reset', $2, $3::jsonb, $4)
    `, [auditId, row.id, JSON.stringify({ actor: 'self-service', role: row.role, detail: '' }), at]);

    return {
      kind: 'reset',
      user: {
        ...data, id: row.id, email: row.email || '', username: row.username || '', role: row.role,
        active: row.active, name: row.fullName || data.name || '', passwordHash: credential.passwordHash,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString()
      }
    };
  });
}
