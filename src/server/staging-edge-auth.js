// Web Crypto-only companion to staging-auth.js for Next.js Proxy / Netlify.
// Keep Node crypto imports out of the proxy dependency graph.
export const STAGING_ACCESS_COOKIE = 'zezo_staging_access';
export const STAGING_SESSION_TTL_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();
const sessionKeyPrefix = 'ZEZO Forge staging session v1:';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sessionSigningKey() {
  const secret = String(process.env.ZEZO_STAGING_ACCESS_PASSWORD || '');
  if (!secret) return null;
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${sessionKeyPrefix}${secret}`));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function stagingPasswordMatches(password) {
  const configuredPassword = String(process.env.ZEZO_STAGING_ACCESS_PASSWORD || '');
  const candidate = String(password || '');
  if (!configuredPassword || !candidate || candidate.length > 200) return false;

  const message = encoder.encode('ZEZO staging password verification v1');
  const configuredKey = await crypto.subtle.importKey('raw', encoder.encode(configuredPassword), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const candidateKey = await crypto.subtle.importKey('raw', encoder.encode(candidate), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = await crypto.subtle.sign('HMAC', configuredKey, message);
  return crypto.subtle.verify('HMAC', candidateKey, signature, message);
}

export async function createStagingSession(now = Date.now()) {
  const key = await sessionSigningKey();
  if (!key) throw new Error('ZEZO_STAGING_ACCESS_PASSWORD is required in staging mode.');
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const payload = `${Math.floor(now / 1000) + STAGING_SESSION_TTL_SECONDS}.${base64UrlEncode(nonce)}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function isStagingSessionValid(value, now = Date.now()) {
  const key = await sessionSigningKey();
  if (!key || typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^\d{10,12}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{32,64}$/.test(parts[1])) return false;
  const expiresAt = Number(parts[0]) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + STAGING_SESSION_TTL_SECONDS * 1000) return false;

  try {
    const signature = base64UrlDecode(parts[2]);
    if (signature.length !== 32) return false;
    return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

