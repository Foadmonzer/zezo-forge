import { createHash, randomUUID } from 'node:crypto';
import { queryPostgres, withPostgresScopedTransaction } from './postgres-runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const digest = value => createHash('sha256').update(String(value || '')).digest('hex');
const referralCookieHash = value => value ? digest(value) : '';

async function resolveActiveReferrer(client, code) {
  const result = await client.query(`
    SELECT u.id AS "userId", u.email, u.data,
      l.id AS "linkId", l.month AS "linkMonth"
    FROM user_accounts u
    LEFT JOIN referral_links l
      ON l."userId" = u.id AND l.code = $1 AND l.active = TRUE
    WHERE u.active = TRUE AND u.role = ANY($2::text[])
      AND (l.id IS NOT NULL OR u.data->>'referralCode' = $1 OR u.data->>'currentReferralCode' = $1)
    ORDER BY (l.id IS NOT NULL) DESC
    LIMIT 1
  `, [String(code || '').trim().slice(0, 40), ['marketer', 'developer']]);
  const row = result.rows[0];
  if (!row) return null;
  const data = object(row.data);
  return {
    userId: row.userId,
    email: String(row.email || '').trim().toLowerCase(),
    code: String(code || '').trim().slice(0, 40),
    linkId: row.linkId || (data.currentReferralCode === code ? data.currentReferralLinkId : '') || `legacy_${row.userId}`,
    month: row.linkMonth || 'legacy'
  };
}

async function resolveActiveStoredReferrer(client, userId, code) {
  const result = await client.query(`
    SELECT u.id AS "userId", u.email, u.data,
      l.id AS "linkId", l.month AS "linkMonth"
    FROM user_accounts u
    LEFT JOIN referral_links l
      ON l."userId" = u.id AND l.code = $2 AND l.active = TRUE
    WHERE u.id = $1 AND u.active = TRUE AND u.role = ANY($3::text[])
  `, [userId, String(code || '').trim().slice(0, 40), ['marketer', 'developer']]);
  const row = result.rows[0];
  if (!row) return null;
  const data = object(row.data);
  const storedCode = String(code || data.referralCode || data.currentReferralCode || '').trim().slice(0, 40);
  if (!storedCode || (row.linkId == null && data.referralCode !== storedCode && data.currentReferralCode !== storedCode)) return null;
  return {
    userId: row.userId,
    email: String(row.email || '').trim().toLowerCase(),
    code: storedCode,
    linkId: row.linkId || (data.currentReferralCode === storedCode ? data.currentReferralLinkId : '') || `legacy_${row.userId}`,
    month: row.linkMonth || 'legacy'
  };
}

/** Capture first-touch referral in a short transaction. The browser only receives an opaque HttpOnly cookie. */
export async function capturePostgresReferralAttribution({ cookieHash, code, at, expiresAt }) {
  if (!cookieHash || !code) return { kind: 'invalid' };
  return withPostgresScopedTransaction(async client => {
    // Serialize only this anonymous browser's attribution; unrelated visitors never wait on this lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`referral-cookie:${cookieHash}`]);
    const existingResult = await client.query(`
      SELECT id, "userId", code, "expiresAt", data
      FROM referral_attributions
      WHERE "visitorHash" = $1
      LIMIT 1
      FOR UPDATE
    `, [cookieHash]);
    const existing = existingResult.rows[0];
    if (existing && new Date(existing.expiresAt).getTime() > Date.parse(at)) {
      const referrer = await resolveActiveStoredReferrer(client, existing.userId, existing.code);
      if (!referrer) return { kind: 'unavailable' };
      return { kind: 'existing', attribution: { ...referrer, expiresAt: new Date(existing.expiresAt).toISOString() } };
    }

    const referrer = await resolveActiveReferrer(client, code);
    if (!referrer) return { kind: 'unavailable' };
    const attributionId = existing?.id || `refattr_${randomUUID()}`;
    const data = { linkId: referrer.linkId, firstSeenAt: at, lastSeenAt: at, source: 'first_party_referral_cookie' };
    await client.query(`
      INSERT INTO referral_attributions (id, "userId", code, "visitorHash", "expiresAt", data, "createdAt")
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT ("visitorHash") DO UPDATE
      SET id = EXCLUDED.id, "userId" = EXCLUDED."userId", code = EXCLUDED.code,
          "expiresAt" = EXCLUDED."expiresAt", data = EXCLUDED.data, "createdAt" = EXCLUDED."createdAt"
      WHERE referral_attributions."expiresAt" <= $7
    `, [attributionId, referrer.userId, referrer.code, cookieHash, expiresAt, JSON.stringify(data), at]);
    return { kind: 'captured', attribution: { ...referrer, expiresAt } };
  });
}

export async function getPostgresReferralAttribution(cookieHash) {
  if (!cookieHash) return null;
  const result = await queryPostgres(`
    SELECT "userId", code, "expiresAt", data
    FROM referral_attributions
    WHERE "visitorHash" = $1 AND "expiresAt" > NOW()
    LIMIT 1
  `, [cookieHash]);
  const row = result.rows[0];
  if (!row) return null;
  const referrerResult = await queryPostgres(`
    SELECT u.id AS "userId", u.email, u.data,
      l.id AS "linkId", l.month AS "linkMonth"
    FROM user_accounts u
    LEFT JOIN referral_links l
      ON l."userId" = u.id AND l.code = $2 AND l.active = TRUE
    WHERE u.id = $1 AND u.active = TRUE AND u.role = ANY($3::text[])
  `, [row.userId, row.code, ['marketer', 'developer']]);
  const active = referrerResult.rows[0];
  if (!active) return null;
  const data = object(active.data);
  const storedCode = String(row.code || '').trim().slice(0, 40);
  if (!storedCode || (active.linkId == null && data.referralCode !== storedCode && data.currentReferralCode !== storedCode)) return null;
  return {
    userId: active.userId,
    email: String(active.email || '').trim().toLowerCase(),
    code: storedCode,
    linkId: active.linkId || (data.currentReferralCode === storedCode ? data.currentReferralLinkId : '') || `legacy_${active.userId}`,
    month: active.linkMonth || 'legacy',
    expiresAt: new Date(row.expiresAt).toISOString()
  };
}

export async function recordPostgresReferralEvent({ cookieHash, type, eventId, resourceId = '', followupId = '', analyticsVisitorHash = '', at }) {
  if (!cookieHash || !type || !eventId) return { kind: 'invalid' };
  return withPostgresScopedTransaction(async client => {
    const attributionResult = await client.query(`
      SELECT "userId", code, data FROM referral_attributions
      WHERE "visitorHash" = $1 AND "expiresAt" > $2
      LIMIT 1 FOR UPDATE
    `, [cookieHash, at]);
    const attribution = attributionResult.rows[0];
    if (!attribution) return { kind: 'missing_attribution' };
    const referrer = await resolveActiveStoredReferrer(client, attribution.userId, attribution.code);
    if (!referrer) return { kind: 'missing_attribution' };
    const linkId = String(object(attribution.data).linkId || referrer.linkId || '');
    const daily = ['visit', 'service_view', 'template_view'].includes(type);
    const stablePart = daily
      ? digest(`${referrer.userId}:${linkId}:${cookieHash}:${type}:${resourceId}:${String(at).slice(0, 10)}`)
      : String(eventId).slice(0, 80);
    const idempotencyKey = `public:${type}:${stablePart}`.slice(0, 180);
    const eventIdValue = `rfe_${randomUUID()}`;
    const data = { linkId, month: referrer.month, followupId: followupId || '', reversedAt: '', analyticsVisitorHash: analyticsVisitorHash || '' };
    const inserted = await client.query(`
      INSERT INTO referral_events (id, "userId", code, "eventType", "visitorHash", "resourceId", "idempotencyKey", data, "createdAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING id
    `, [eventIdValue, referrer.userId, referrer.code, type, cookieHash,
      resourceId || null, idempotencyKey, JSON.stringify(data), at]);
    return inserted.rowCount ? { kind: 'created' } : { kind: 'duplicate' };
  });
}

export async function deletePostgresReferralAnalyticsByVisitor(visitorHash) {
  if (!visitorHash) return 0;
  return withPostgresScopedTransaction(async client => {
    const result = await client.query(`
      DELETE FROM referral_events
      WHERE "eventType" = ANY($1::text[])
        AND data->>'analyticsVisitorHash' = $2
    `, [['visit', 'service_view', 'template_view', 'whatsapp_click'], visitorHash]);
    return result.rowCount || 0;
  });
}
