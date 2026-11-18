export const DEFAULT_PUBLIC_SITE_ORIGIN = 'https://zezo-forge-fouad.netlify.app';

/**
 * Parse a configured public URL as an origin only. This prevents path, query,
 * credentials, and non-HTTPS production values from becoming user-facing links.
 *
 * @param {string | null | undefined} candidate
 * @param {{ allowHttp?: boolean }} [options]
 * @returns {string}
 */
export function normalizePublicSiteOrigin(candidate, { allowHttp = false } = {}) {
  const value = String(candidate || '').trim();
  if (!value) return '';

  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
    const originOnly = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    if (!allowedProtocol || !originOnly) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** @param {Record<string, string | undefined>} [env] */
export function getPublicSiteOrigin(env = process.env) {
  if (env.ZEZO_STAGING === 'true') {
    const preview = normalizePublicSiteOrigin(env.DEPLOY_PRIME_URL || env.URL, { allowHttp: env.NODE_ENV !== 'production' });
    return preview || DEFAULT_PUBLIC_SITE_ORIGIN;
  }
  const configured = normalizePublicSiteOrigin(env.ZEZO_PUBLIC_URL, { allowHttp: env.NODE_ENV !== 'production' });
  return configured || DEFAULT_PUBLIC_SITE_ORIGIN;
}

/**
 * Build user-facing links without trusting Host headers in production. Staging
 * prefers Netlify's deploy-specific origin; only local development falls back
 * to the request origin when no explicit URL is configured.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ isStaging?: boolean, requestOrigin?: string }} [context]
 * @returns {string}
 */
export function getRequestPublicSiteOrigin(env = process.env, { isStaging = false, requestOrigin = '' } = {}) {
  const allowHttp = env.NODE_ENV !== 'production';
  if (isStaging) {
    const preview = normalizePublicSiteOrigin(env.DEPLOY_PRIME_URL || env.URL, { allowHttp });
    if (preview) return preview;
    // A hosted staging server without its own origin must fail closed. Falling
    // back to the production host can send invitation/reset links to real users.
    if (!allowHttp) return '';
    return normalizePublicSiteOrigin(requestOrigin, { allowHttp: true }) || '';
  }

  const configured = normalizePublicSiteOrigin(env.ZEZO_PUBLIC_URL, { allowHttp });
  if (configured) return configured;
  if (env.NODE_ENV === 'production') return DEFAULT_PUBLIC_SITE_ORIGIN;
  return normalizePublicSiteOrigin(requestOrigin, { allowHttp: true }) || DEFAULT_PUBLIC_SITE_ORIGIN;
}
