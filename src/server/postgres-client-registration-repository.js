import { createHash } from 'node:crypto';
import { withPostgresScopedTransaction } from './postgres-runtime.js';

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

async function resolveReferral(client, visitorHash) {
  // Only a server-issued opaque first-party cookie can prove a referral.
  // Ignore referral codes and visitor IDs sent in request bodies or URLs.
  if (!visitorHash) return null;
  const attribution = await client.query(`
    SELECT a."userId", a.code, a.data, u.email
    FROM referral_attributions a
    JOIN user_accounts u ON u.id = a."userId"
    LEFT JOIN referral_links l ON l."userId" = u.id AND l.code = a.code AND l.active = TRUE
    WHERE a."visitorHash" = $1 AND a."expiresAt" > NOW()
      AND u.active = TRUE AND u.role = ANY($2::text[])
      AND (l.id IS NOT NULL OR u.data->>'referralCode' = a.code OR u.data->>'currentReferralCode' = a.code)
    LIMIT 1 FOR UPDATE OF a
  `, [visitorHash, ['marketer', 'developer']]);
  const row = attribution.rows[0];
  if (!row) return null;
  const code = String(row.code || '');
  const referrer = await client.query(`
    SELECT u.id, u.email, l.id AS link_id
    FROM user_accounts u
    LEFT JOIN referral_links l ON l."userId" = u.id AND l.code = $2 AND l.active = TRUE
    WHERE u.id = $1 AND u.active = TRUE AND u.role = ANY($3::text[])
      AND (l.id IS NOT NULL OR u.data->>'referralCode' = $2 OR u.data->>'currentReferralCode' = $2)
    LIMIT 1
  `, [row.userId, code, ['marketer', 'developer']]);
  const active = referrer.rows[0];
  if (!active) return null;
  return { userId: active.id, email: String(active.email || '').trim().toLowerCase(), code,
    linkId: active.link_id || String(asObject(row.data).linkId || `legacy_${active.id}`) };
}

/** Create a customer account, session, audit record, and optional verification outbox entry atomically. */
export async function createPostgresClientRegistration({
  user, referralVisitorHash = '', auditId, at,
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

      const referral = await resolveReferral(client, referralVisitorHash);
      const persistedUser = { ...user };
      if (referral && referral.userId !== persistedUser.id && referral.email !== String(persistedUser.email || '').trim().toLowerCase()) {
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

      if (persistedUser.referralUserId && referralVisitorHash) {
        const signupEventId = `rfe_signup_${createHash('sha256').update(`${persistedUser.referralUserId}:${persistedUser.id}`).digest('hex').slice(0, 32)}`;
        await client.query(`
          INSERT INTO referral_events (id, "userId", code, "eventType", "resourceId", "idempotencyKey", data, "createdAt")
          VALUES ($1, $2, $3, 'client_signup', $4, $5, $6::jsonb, $7)
          ON CONFLICT ("idempotencyKey") DO NOTHING
        `, [signupEventId, persistedUser.referralUserId, persistedUser.referralCode, persistedUser.id,
          `client_signup:${persistedUser.id}`, JSON.stringify({ linkId: persistedUser.referralLinkId, clientId: persistedUser.id, attributedAt: at }), at]);
        await client.query(`
          UPDATE referral_attributions
          SET "expiresAt" = $2,
              data = data || jsonb_build_object('boundClientId', $3::text, 'boundAt', $2::text)
          WHERE "visitorHash" = $1 AND "expiresAt" > $2
        `, [referralVisitorHash, at, persistedUser.id]);
      }

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

/** Consume a pending client's email confirmation and issue their session atomically. */
export async function verifyPostgresClientEmail({ verificationHash, sessionHash, sessionExpiresAt, auditId, at }) {
  return withPostgresScopedTransaction(async client => {
    const { rows: [account] } = await client.query(`
      SELECT id, email, username, role, "fullName", "passwordHash", data, "createdAt"
      FROM user_accounts
      WHERE role = 'client' AND active = FALSE
        AND data ->> 'emailVerificationHash' = $1
        AND COALESCE(data ->> 'accountDisabledAt', '') IN ('', 'false', '0')
      LIMIT 1 FOR UPDATE
    `, [verificationHash]);
    if (!account) return null;

    const previous = asObject(account.data);
    const tokenExpiresAt = Number(previous.emailVerificationExpires);
    if (previous.emailVerified === true || !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) return null;

    const data = { ...previous, active: true, emailVerified: true, emailVerifiedAt: at };
    delete data.emailVerificationHash;
    delete data.emailVerificationExpires;
    await client.query(`
      UPDATE user_accounts SET active = TRUE, data = $2::jsonb, "updatedAt" = $3 WHERE id = $1
    `, [account.id, JSON.stringify(data), at]);
    await client.query(`
      INSERT INTO auth_sessions (id, "userId", "expiresAt", data)
      VALUES ($1, $2, $3, '{}')
    `, [sessionHash, account.id, sessionExpiresAt]);
    await client.query(`
      INSERT INTO audit_entries (id, "actorId", action, "targetId", data, "createdAt")
      VALUES ($1, $2, 'client_email_verified', $2, $3::jsonb, $4)
    `, [auditId, account.id, JSON.stringify({ actor: account.username, role: account.role, detail: '' }), at]);

    return {
      ...data, id: account.id, email: account.email || '', username: account.username || '', role: account.role,
      name: account.fullName || data.name || '', passwordHash: account.passwordHash, createdAt: account.createdAt.toISOString()
    };
  });
}
