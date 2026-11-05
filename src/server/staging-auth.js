import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STAGING_ACCESS_COOKIE = 'zezo_staging_access';
export const STAGING_SESSION_TTL_SECONDS = 12 * 60 * 60;

function passwordDigest(password) {
  return createHash('sha256').update(String(password || '')).digest();
}

export function stagingPasswordMatches(password) {
  const configuredPassword = String(process.env.ZEZO_STAGING_ACCESS_PASSWORD || '');
  if (!configuredPassword) return false;
  return timingSafeEqual(passwordDigest(password), passwordDigest(configuredPassword));
}

function signingKey() {
  const secret = String(process.env.ZEZO_STAGING_ACCESS_PASSWORD || '');
  if (!secret) return null;
  return createHash('sha256').update(`ZEZO Forge staging session v1:${secret}`).digest();
}

export function createStagingSession(now = Date.now()) {
  const key = signingKey();
  if (!key) throw new Error('ZEZO_STAGING_ACCESS_PASSWORD is required in staging mode.');
  const payload = `${Math.floor(now / 1000) + STAGING_SESSION_TTL_SECONDS}.${randomBytes(32).toString('base64url')}`;
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function isStagingSessionValid(value, now = Date.now()) {
  const key = signingKey();
  if (!key || typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^\d{10,12}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{32,64}$/.test(parts[1])) return false;
  const expiresAt = Number(parts[0]) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + STAGING_SESSION_TTL_SECONDS * 1000) return false;
  const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  let received;
  try { received = Buffer.from(parts[2], 'base64url'); }
  catch { return false; }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
