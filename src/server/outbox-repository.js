import { randomBytes } from 'node:crypto';
import { withPostgresScopedTransaction } from './postgres-runtime.js';

const leaseSeconds = 120;
const providerIdempotencyWindowHours = 24;
export const OUTBOX_MAX_ATTEMPTS = 5;

// Password reset tokens are processed synchronously by their own handler.
const deliveryScope = `
  data ->> 'kind' IS DISTINCT FROM 'account_password_reset'
  AND ($1::text[] IS NULL OR id = ANY($1::text[]))
  AND ($2::timestamptz IS NULL OR "createdAt" AT TIME ZONE 'UTC' >= $2::timestamptz)
  AND ($7::text[] IS NULL OR data ->> 'kind' = ANY($7::text[]))
  AND (
    (data ->> 'recipientType' = 'admin' AND $4::boolean)
    OR (data ->> 'recipientType' IS DISTINCT FROM 'admin'
        AND COALESCE(NULLIF(data ->> 'to', ''), recipient, '') <> ''
        AND ($3::text IS NULL OR LOWER(BTRIM(COALESCE(NULLIF(data ->> 'to', ''), recipient))) = $3::text))
  )`;

const leaseExpired = `COALESCE(NULLIF(data ->> 'workerLeaseUntil', '')::timestamptz, '-infinity'::timestamptz) <= NOW()`;
const firstAttempt = `COALESCE(NULLIF(data ->> 'firstAttemptAt', '')::timestamptz,
  LEAST("createdAt" AT TIME ZONE 'UTC', NULLIF(data ->> 'lastAttemptAt', '')::timestamptz))`;
// Do not begin a retry near the very end of the provider's window.
const pastIdempotencyWindow = `${firstAttempt} <= NOW() - ($5 * INTERVAL '1 hour') + INTERVAL '1 minute'`;
const linkExpired = `COALESCE(NULLIF(data ->> 'expiresAt', '')::timestamptz,
  CASE WHEN data ->> 'kind' IN ('client_email_verification', 'team_invitation')
       THEN ("createdAt" AT TIME ZONE 'UTC') + INTERVAL '24 hours' END,
  'infinity'::timestamptz) <= NOW()`;

/** Atomically lease one eligible message. Its row ID is the provider idempotency key. */
export async function claimNextOutboxMessage({ allowAdmin = false, messageIds = null, notBefore = null, onlyRecipient = null, allowedKinds = null } = {}) {
  const leaseToken = randomBytes(24).toString('hex');
  const filters = [messageIds, notBefore, onlyRecipient, allowAdmin, providerIdempotencyWindowHours, OUTBOX_MAX_ATTEMPTS, allowedKinds];
  return withPostgresScopedTransaction(async client => {
    await client.query(`SET LOCAL statement_timeout = '4000ms'`);
    // Take the table lock before acquiring any individual rows. This coordinates
    // with the older whole-store writer without serializing independent workers.
    await client.query(`LOCK TABLE outbox_messages IN ROW EXCLUSIVE MODE NOWAIT`);
    await client.query(`
      UPDATE outbox_messages
      SET state = CASE WHEN state = 'sending' OR data ->> 'deliveryUncertain' = 'true' THEN 'uncertain' ELSE 'failed' END,
          data = data || jsonb_build_object(
            'workerLeaseUntil', NULL,
            'leaseToken', NULL,
            'lastError', CASE
              WHEN attempts >= $6 THEN 'Email retry limit reached; review the delivery outcome before retrying.'
              WHEN ${linkExpired} THEN 'The email link expired before delivery could be confirmed.'
              ELSE 'Delivery outcome is uncertain after the provider idempotency window; review before retry.'
            END
          ),
          "updatedAt" = NOW()
      WHERE (${deliveryScope})
        AND state IN ('pending', 'retry', 'sending')
        AND (state <> 'sending' OR ${leaseExpired})
        AND (attempts >= $6 OR ${linkExpired} OR (attempts > 0 AND (${pastIdempotencyWindow})))
    `, filters);

    const result = await client.query(`
      WITH candidate AS (
        SELECT id
        FROM outbox_messages
        WHERE (${deliveryScope})
          AND attempts < $6
          AND NOT (${linkExpired})
          AND (attempts = 0 OR NOT (${pastIdempotencyWindow}))
          AND (
            (state IN ('pending', 'retry') AND COALESCE(NULLIF(data ->> 'retryAt', '')::timestamptz, '-infinity'::timestamptz) <= NOW())
            OR (state = 'sending' AND ${leaseExpired})
          )
        ORDER BY "createdAt", id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_messages AS message
      SET state = 'sending',
          attempts = message.attempts + 1,
          data = message.data || jsonb_build_object(
            'firstAttemptAt', CASE WHEN message.attempts = 0 THEN NOW()::text ELSE (${firstAttempt})::text END,
            'lastAttemptAt', NOW()::text,
            'workerLeaseUntil', (NOW() + ($8 * INTERVAL '1 second'))::text,
            'leaseToken', $9::text,
            'deliveryUncertain', message.state = 'sending' OR message.data ->> 'deliveryUncertain' = 'true',
            'lastError', ''
          ),
          "updatedAt" = NOW()
      FROM candidate
      WHERE message.id = candidate.id
      RETURNING message.id, message.recipient, message.state, message.attempts, message.data, message."createdAt", message."updatedAt"
    `, [...filters, leaseSeconds, leaseToken]);

    const row = result.rows[0];
    return row ? { ...row, leaseToken } : null;
  });
}

/** Complete only the worker that owns the current lease. */
export async function completeOutboxMessage(id, leaseToken, { state, providerId = '', lastError = '', retryAfterSeconds = 0, deliveryUncertain = false } = {}) {
  if (!['sent', 'retry', 'failed', 'uncertain'].includes(state)) throw new Error('Invalid outbox completion state.');
  return withPostgresScopedTransaction(async client => {
    await client.query(`SET LOCAL statement_timeout = '4000ms'`);
    await client.query(`LOCK TABLE outbox_messages IN ROW EXCLUSIVE MODE NOWAIT`);
    const result = await client.query(`
      UPDATE outbox_messages
      SET state = $3,
          data = data || jsonb_build_object(
            'workerLeaseUntil', NULL,
            'leaseToken', NULL,
            'sentAt', CASE WHEN $3 = 'sent' THEN NOW()::text ELSE data ->> 'sentAt' END,
            'providerId', CASE WHEN $3 = 'sent' THEN $4::text ELSE data ->> 'providerId' END,
            'lastError', $5::text,
            'retryAt', CASE WHEN $3 = 'retry' THEN (NOW() + ($6 * INTERVAL '1 second'))::text END,
            'deliveryUncertain', $7::boolean
          ),
          "updatedAt" = NOW()
      WHERE id = $1 AND state = 'sending' AND data ->> 'leaseToken' = $2
      RETURNING id, recipient, state, attempts, data, "createdAt", "updatedAt"
    `, [id, leaseToken, state, providerId, lastError, retryAfterSeconds, deliveryUncertain]);
    return result.rows[0] || null;
  });
}

export const OUTBOX_LEASE_SECONDS = leaseSeconds;
export const OUTBOX_PROVIDER_IDEMPOTENCY_WINDOW_HOURS = providerIdempotencyWindowHours;
