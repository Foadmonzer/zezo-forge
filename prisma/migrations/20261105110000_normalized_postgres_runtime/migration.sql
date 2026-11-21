-- Normalized ZEZO runtime support. Existing compatibility rows are preserved untouched.
ALTER TABLE "conversation_messages"
  ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "referral_events"
  ADD COLUMN "idempotencyKey" TEXT;

UPDATE "referral_events"
SET "idempotencyKey" = "data" ->> 'idempotencyKey'
WHERE "idempotencyKey" IS NULL
  AND NULLIF("data" ->> 'idempotencyKey', '') IS NOT NULL;

CREATE UNIQUE INDEX "referral_events_idempotencyKey_key"
  ON "referral_events"("idempotencyKey");

ALTER TABLE "referral_attributions"
  ADD COLUMN "visitorHash" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "referral_attributions"
SET "visitorHash" = COALESCE(NULLIF("data" ->> 'visitorHash', ''), 'legacy:' || id),
    "expiresAt" = COALESCE(
      NULLIF("data" ->> 'expiresAt', '')::bigint / 1000 * INTERVAL '1 second' + TIMESTAMP 'epoch',
      "createdAt" + INTERVAL '30 days'
    );

ALTER TABLE "referral_attributions"
  ALTER COLUMN "visitorHash" SET NOT NULL,
  ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE UNIQUE INDEX "referral_attributions_visitorHash_key"
  ON "referral_attributions"("visitorHash");
CREATE INDEX "referral_attributions_expiresAt_idx"
  ON "referral_attributions"("expiresAt");

CREATE TABLE "rate_limit_buckets" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "rate_limit_buckets_expiresAt_idx" ON "rate_limit_buckets"("expiresAt");
