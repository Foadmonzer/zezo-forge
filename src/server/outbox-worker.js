import { claimNextOutboxMessage, completeOutboxMessage, OUTBOX_MAX_ATTEMPTS } from './outbox-repository.js';
import { ResendMailError, resendConfigured, sendWithResend } from './resend-mail.js';

const retryDelaysSeconds = [60, 300, 900, 3600];

function normalizedRecipient(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email) ? email : '';
}

export function postgresOutboxSettings(env = process.env) {
  if (env.ZEZO_STAGING === 'true' || env.ZEZO_ENABLE_EMAIL_DELIVERY !== 'true' ||
      env.ZEZO_OUTBOX_WORKER_ENABLED !== 'true' || !env.DATABASE_URL || !resendConfigured(env)) return null;

  const activation = String(env.ZEZO_EMAIL_QUEUE_ACTIVE_SINCE || '').trim();
  const cutoff = Date.parse(activation);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(activation) || !Number.isFinite(cutoff)) return null;
  const protectedRecipient = normalizedRecipient(env.ZEZO_EMAIL_TEST_RECIPIENT);
  if (env.ZEZO_EMAIL_TEST_RECIPIENT && !protectedRecipient) return null;

  const adminRecipient = normalizedRecipient(env.ZEZO_NOTIFICATION_EMAIL);
  const allowAdmin = Boolean(adminRecipient && (!protectedRecipient || adminRecipient === protectedRecipient));
  return { notBefore: new Date(cutoff).toISOString(), onlyRecipient: protectedRecipient || null, adminRecipient, allowAdmin };
}

/** Send a short batch from the durable Outbox. Netlify can safely interrupt a leased item. */
export async function processPostgresOutbox({ env = process.env, maxMessages = 2, budgetMs = 16_000, allowedKinds = null, fetchImpl = fetch } = {}) {
  const counts = { processed: 0, sent: 0, retry: 0, failed: 0, uncertain: 0 };
  const settings = postgresOutboxSettings(env);
  if (!settings) return counts;
  const deadline = performance.now() + budgetMs;

  while (counts.processed < maxMessages && performance.now() < deadline) {
    const claimed = await claimNextOutboxMessage({ ...settings, allowedKinds });
    if (!claimed) break;
    const payload = claimed.data || {};
    const recipient = payload.recipientType === 'admin'
      ? settings.adminRecipient
      : normalizedRecipient(payload.to || claimed.recipient);
    let result;
    let pauseBatch = false;
    if (!recipient || (settings.onlyRecipient && recipient !== settings.onlyRecipient)) {
      result = { state: payload.deliveryUncertain ? 'uncertain' : 'failed', lastError: 'Email recipient is not permitted.', deliveryUncertain: Boolean(payload.deliveryUncertain) };
    } else {
      try {
        const accepted = await sendWithResend({
          to: recipient, subject: payload.subject, text: payload.text, html: payload.html,
          idempotencyKey: claimed.id, fetchImpl, env
        });
        result = { state: 'sent', providerId: accepted.id };
      } catch (error) {
        if (!(error instanceof ResendMailError)) throw error;
        const deliveryUncertain = Boolean(payload.deliveryUncertain || error.uncertain);
        const canRetry = error.retryable && claimed.attempts < OUTBOX_MAX_ATTEMPTS;
        const state = canRetry ? 'retry' : deliveryUncertain ? 'uncertain' : 'failed';
        const delay = retryDelaysSeconds[claimed.attempts - 1] || retryDelaysSeconds.at(-1);
        result = { state, lastError: error.message, retryAfterSeconds: Math.max(delay, error.retryAfterSeconds), deliveryUncertain };
        // Provider-wide errors should not consume attempts on the whole backlog.
        pauseBatch = error.status === 401 || error.status === 403 || error.status === 429 || error.status === 0 || error.status >= 500;
      }
    }

    const completed = await completeOutboxMessage(claimed.id, claimed.leaseToken, result);
    counts.processed += 1;
    if (completed) counts[result.state] += 1;
    if (pauseBatch) break;
  }
  return counts;
}
