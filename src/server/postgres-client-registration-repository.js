import { withPostgresScopedTransaction } from './postgres-runtime.js';

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

async function resolveReferral(client, visitorHash, requestedCode) {
  let code = requestedCode || '';
  let attributedUserId = null;
  let attributedLinkId = '';
  if (visitorHash) {
    const attribution = await client.query(`
      SELECT "userId", code, data
      FROM referral_attributions
      WHERE "visitorHash" = $1 AND "expiresAt" > NOW()
      LIMIT 1
    `, [visitorHash]);
    const row = attribution.rows[0];
    if (row) {
      code = String(row.code || '');
      attributedUserId = row.userId;
      attributedLinkId = String(asObject(row.data).linkId || '');
    }
  }
  if (!code) return null;

  const result = await client.query(`
    SELECT u.id, u.email, u.data, link.id AS link_id
    FROM user_accounts u
    LEFT JOIN referral_links link ON link."userId" = u.id AND link.code = $1
    WHERE u.active = TRUE
      AND u.role = ANY($2::text[])
      AND (
        ($3::text IS NOT NULL AND u.id = $3)
        OR ($3::text IS NULL AND (link.id IS NOT NULL OR u.data ->> 'referralCode' = $1))
      )
    ORDER BY CASE WHEN link.id IS NULL THEN 1 ELSE 0 END
    LIMIT 1
  `, [code, ['marketer', 'developer'], attributedUserId]);
  const referrer = result.rows[0];
  if (!referrer) return null;
  return {
    userId: referrer.id,
    code,
    linkId: referrer.link_id || attributedLinkId || `legacy_${referrer.id}`
  };
}

/** Create a customer account, session, audit record, and optional verification outbox entry atomically. */
export async function createPostgresClientRegistration({
  user, referralVisitorHash = '', referralCode = '', auditId, at,
  verificationRequired = false, sessionHash = '', sessionExpiresAt = null, outboxMessage = null
}) {
  try {
    return await withPostgresScopedTransaction(async client => {
      // Serialize only registrations for the same normalized email. This keeps duplicate
      // checks race-safe without waiting on the legacy company-wide advisory lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zezo-account-email:${user.email.toLowerCase()}`]);
      const duplicate = await client.query(
        'SELECT 1 FROM user_accounts WHERE username = $1 OR LOWER(email) = LOWER($2) LIMIT 1',
        [user.username, user.email]
      );
      if (duplicate.rowCount) return { kind: 'duplicate' };

      const referral = await resolveReferral(client, referralVisitorHash, referralCode);
      const persistedUser = { ...user };
      if (referral && referral.userId !== persistedUser.id) {
        persistedUser.referralUserId = referral.userId;
        persistedUser.referralCode = referral.code;
        persistedUser.referralLinkId = referral.linkId;
        persistedUser.referralBoundAt = at;
      }

      await client.query(`
        INSERT INTO user_accounts
          (id, email, username, role, active, "fullName", "passwordHash", data, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, 'client', $4, $5, $6, $7::jsonb, $8, $8)
      `, [persistedUser.id, persistedUser.email, persistedUser.username, persistedUser.active,
        persistedUser.name, persistedUser.passwordHash, JSON.stringify(persistedUser), at]);

      await client.query(`
        INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
        VALUES ($1, $2, 'client_registered', $2, $3::jsonb, $4)
      `, [auditId, persistedUser.id, JSON.stringify({ actor: persistedUser.username, role: 'client', detail: persistedUser.referralCode ? `Referral ${persistedUser.referralCode}` : '' }), at]);

      if (outboxMessage) {
        await client.query(`
          INSERT INTO outbox_messages (id, recipient, state, attempts, data, "createdAt", "updatedAt")
          VALUES ($1, $2, 'pending', 0, $3::jsonb, $4, $4)
        `, [outboxMessage.id, outboxMessage.recipient, JSON.stringify(outboxMessage.data), at]);
      }

      if (!verificationRequired && sessionHash && sessionExpiresAt) {
        await client.query(
          'INSERT INTO auth_sessions (id, "userId", "expiresAt", data) VALUES ($1, $2, $3, $4::jsonb)',
          [sessionHash, persistedUser.id, sessionExpiresAt, '{}']
        );
      }
      return { kind: 'created', user: persistedUser };
    });
  } catch (error) {
    if (error?.code === '23505') return { kind: 'duplicate' };
    throw error;
  }
}
