const sendEndpoint = 'https://api.resend.com/emails';

export function resendConfigured(env = process.env) {
  return Boolean(env.RESEND_API_KEY?.trim() && env.ZEZO_FROM_EMAIL?.trim());
}

export class ResendMailError extends Error {
  constructor(message, { status = 0, retryable = false, uncertain = false, retryAfterSeconds = 0 } = {}) {
    super(message);
    this.name = 'ResendMailError';
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryDelay(response) {
  const header = response.headers.get('retry-after');
  if (!header) return 0;
  const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(21_600, Math.max(0, Math.ceil(seconds))) : 0;
}

/** Resend acceptance is not confirmation that the recipient received the message. */
export async function sendWithResend({ to, subject, text, html, idempotencyKey, fetchImpl = fetch, env = process.env, timeoutMs = 6000 }) {
  if (!resendConfigured(env)) throw new ResendMailError('Email provider is not configured.');
  if (typeof idempotencyKey !== 'string' || !/^[a-z\d_-]{1,256}$/i.test(idempotencyKey)) {
    throw new ResendMailError('Email idempotency key is invalid.');
  }

  let response;
  try {
    const body = { from: env.ZEZO_FROM_EMAIL, to, subject, text };
    if (html) body.html = html;
    response = await fetchImpl(sendEndpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new ResendMailError('Email provider connection failed.', { retryable: true, uncertain: true });
  }

  const status = response.status;
  if (response.ok) {
    const result = await response.json().catch(() => null);
    if (typeof result?.id !== 'string' || !/^[a-z\d_-]{1,120}$/i.test(result.id)) {
      throw new ResendMailError('Email provider acceptance could not be verified.', { status, retryable: true, uncertain: true });
    }
    return { id: result.id };
  }

  const retryAfterSeconds = retryDelay(response);
  if (status === 409) {
    const result = await response.json().catch(() => null);
    const retryable = result?.name === 'concurrent_idempotent_requests' || result?.code === 'concurrent_idempotent_requests';
    throw new ResendMailError('Email provider reported an idempotency conflict.', { status, retryable, uncertain: true, retryAfterSeconds });
  }
  if (response.body) await response.body.cancel().catch(() => {});
  const uncertain = status === 408 || status >= 500;
  const retryable = uncertain || status === 429 || status === 401 || status === 403;
  throw new ResendMailError(`Email provider rejected the request (HTTP ${status}).`, { status, retryable, uncertain, retryAfterSeconds });
}
