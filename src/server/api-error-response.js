import { randomUUID } from 'node:crypto';

const safeMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function safeErrorName(error) {
  const name = error && typeof error === 'object' && typeof error.name === 'string'
    ? error.name
    : 'unknown';
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) ? name : 'unknown';
}

function safeErrorCode(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'unknown';
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'unknown';
}

/**
 * Convert an uncaught application error into a stable JSON API response.
 * Raw error messages and request URLs can contain credentials, tokens, or
 * customer input, so callers may log only the returned, sanitized metadata.
 */
export function buildApiFailure(error, method, requestId = randomUUID()) {
  const normalizedMethod = safeMethods.has(method) ? method : 'UNKNOWN';
  const log = {
    requestId,
    method: normalizedMethod,
    errorName: safeErrorName(error),
    errorCode: safeErrorCode(error)
  };

  const response = Response.json({
    error: 'تعذر إكمال الطلب. حاول مجدداً بعد قليل / The request could not be completed. Please try again shortly.',
    requestId
  }, {
    status: 500,
    headers: {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Request-Id': requestId
    }
  });

  return { response, log };
}
