import { queryPostgres } from './postgres-runtime.js';

const emptyObject = `'{}'::jsonb`;

export async function loadPublicRuntimeSnapshot(month) {
  const result = await queryPostgres(`
    SELECT
      COALESCE((SELECT value FROM app_settings WHERE key = 'zezo-runtime'), ${emptyObject}) AS settings,
      COALESCE((SELECT jsonb_object_agg("templateId", price) FROM template_prices), ${emptyObject}) AS template_prices,
      COALESCE((SELECT jsonb_object_agg("templateId", active) FROM template_prices), ${emptyObject}) AS template_active,
      COALESCE((
        SELECT jsonb_object_agg("templateId", data -> 'inclusion')
        FROM template_prices
        WHERE data ? 'inclusion' AND data -> 'inclusion' IS NOT NULL
      ), ${emptyObject}) AS template_inclusions,
      EXISTS (
        SELECT 1 FROM user_accounts
        WHERE role = 'admin' AND active = true
      ) AS has_active_owner,
      EXISTS (
        SELECT 1
        FROM user_accounts u
        WHERE u.active = true
          AND u.role IN ('marketer', 'developer')
          AND (
            NULLIF(u.data ->> 'referralCode', '') IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM referral_links legacy
              WHERE legacy."userId" = u.id
                AND legacy.code = u.data ->> 'referralCode'
            )
            OR NOT EXISTS (
              SELECT 1 FROM referral_links monthly
              WHERE monthly."userId" = u.id
                AND monthly.month = $1
                AND monthly.data ->> 'kind' = 'monthly'
            )
            OR COALESCE(u.data ->> 'currentReferralCode', '') <> COALESCE((
              SELECT current.code FROM referral_links current
              WHERE current."userId" = u.id
                AND current.month = $1
                AND current.data ->> 'kind' = 'monthly'
              LIMIT 1
            ), '')
            OR COALESCE(u.data ->> 'currentReferralLinkId', '') <> COALESCE((
              SELECT current.id FROM referral_links current
              WHERE current."userId" = u.id
                AND current.month = $1
                AND current.data ->> 'kind' = 'monthly'
              LIMIT 1
            ), '')
          )
      ) AS referral_rollover_required
  `, [month]);

  return result.rows[0] || {
    settings: {}, template_prices: {}, template_active: {}, template_inclusions: {},
    has_active_owner: false, referral_rollover_required: false
  };
}

export async function loadPublicTrackRecord(trackingHash, nowMs = Date.now()) {
  const result = await queryPostgres(`
    SELECT id, status, "createdAt", data
    FROM project_requests
    WHERE data ->> 'trackingHash' = $1
      AND CASE
        WHEN data ->> 'trackingExpires' ~ '^[0-9]+$' THEN (data ->> 'trackingExpires')::bigint
        ELSE 0
      END > $2
    LIMIT 1
  `, [trackingHash, nowMs]);
  const row = result.rows[0];
  return row ? { ...(row.data || {}), id: row.id, status: row.status || row.data?.status || 'new', createdAt: row.data?.createdAt || row.createdAt } : null;
}
