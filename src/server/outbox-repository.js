import { randomBytes } from 'node:crypto';
import { withPostgresTransaction } from './postgres-runtime.js';

const leaseSeconds = 120;
const providerIdempotencyWindowHours = 24;

/** Atomically lease one message, with a stable provider idempotency key (the row id). */
export async function claimNextOutboxMessage({ allowAdmin = false, messageIds = null } = {}) {
  const leaseToken = randomBytes(24).toString('hex');
  return withPostgresTransaction(async client => {
    // A request that died while waiting for its provider is ambiguous. Retry it only
    // inside the provider's documented idempotency window; older rows need review.
    await client.query(`
      UPDATE outbox_messages
      SET state = 'uncertain',
          data = data || jsonb_build_object(
            'workerLeaseUntil', NULL,
            'leaseToken', NULL,
            'lastError', CASE
              WHEN attempts >= 5 THEN 'Delivery outcome is uncertain after the retry limit; review before retry.'
              ELSE 'Delivery outcome is uncertain after the provider idempotency window; review before retry.'
            END
          ),
          "updatedAt" = NOW()
      WHERE state = 'sending'
        AND COALESCE(NULLIF(data ->> 'workerLeaseUntil', '')::timestamptz, '-infinity'::timestamptz) <= NOW()
        AND (
          attempts >= 5
          OR COALESCE(NULLIF(data ->> 'lastAttemptAt', '')::timestamptz, '-infinity'::timestamptz) < NOW() - ($1 * INTERVAL '1 hour')
        )
        AND ($2::text[] IS NULL OR id = ANY($2::text[]))
    `, [providerIdempotencyWindowHours, messageIds]);

    const result = await client.query(`
      WITH candidate AS (
        SELECT id
        FROM outbox_messages
        WHERE attempts < 5
          AND ($2::text[] IS NULL OR id = ANY($2::text[]))
          AND (
            state IN ('pending', 'retry')
            OR (
              state = 'sending'
              AND COALESCE(NULLIF(data ->> 'workerLeaseUntil', '')::timestamptz, '-infinity'::timestamptz) <= NOW()
              AND COALESCE(NULLIF(data ->> 'lastAttemptAt', '')::timestamptz, '-infinity'::timestamptz) >= NOW() - ($1 * INTERVAL '1 hour')
            )
          )
          AND ((data ->> 'recipientType') IS DISTINCT FROM 'admin' OR $3::boolean)
          AND (COALESCE(recipient, data ->> 'to', '') <> '' OR (data ->> 'recipientType' = 'admin' AND $3::boolean))
        ORDER BY "createdAt", id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_messages AS message
      SET state = 'sending',
          attempts = message.attempts + 1,
          data = message.data || jsonb_build_object(
            'lastAttemptAt', NOW()::text,
            'workerLeaseUntil', (NOW() + ($4 * INTERVAL '1 second'))::text,
            'leaseToken', $5::text,
            'lastError', ''
          ),
          "updatedAt" = NOW()
      FROM candidate
      WHERE message.id = candidate.id
      RETURNING message.id, message.recipient, message.state, message.attempts, message.data, message."createdAt", message."updatedAt"
    `, [providerIdempotencyWindowHours, messageIds, allowAdmin, leaseSeconds, leaseToken]);

    const row = result.rows[0];
    return row ? { ...row, leaseToken } : null;
  });
}

/** Complete only the worker that owns the current lease. */
export async function completeOutboxMessage(id, leaseToken, { state, providerId = '', lastError = '' } = {}) {
  if (!['sent', 'retry', 'failed'].includes(state)) throw new Error('Invalid outbox completion state.');
  return withPostgresTransaction(async client => {
    const result = await client.query(`
      UPDATE outbox_messages
      SET state = $3,
          data = data || jsonb_build_object(
            'workerLeaseUntil', NULL,
            'leaseToken', NULL,
            'sentAt', CASE WHEN $3 = 'sent' THEN NOW()::text ELSE data ->> 'sentAt' END,
            'providerId', CASE WHEN $3 = 'sent' THEN $4::text ELSE data ->> 'providerId' END,
            'lastError', $5::text
          ),
          "updatedAt" = NOW()
      WHERE id = $1 AND state = 'sending' AND data ->> 'leaseToken' = $2
      RETURNING id, recipient, state, attempts, data, "createdAt", "updatedAt"
    `, [id, leaseToken, state, providerId, lastError]);
    return result.rows[0] || null;
  });
}

export const OUTBOX_LEASE_SECONDS = leaseSeconds;
export const OUTBOX_PROVIDER_IDEMPOTENCY_WINDOW_HOURS = providerIdempotencyWindowHours;
