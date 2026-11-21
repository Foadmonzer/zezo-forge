CREATE INDEX IF NOT EXISTS "project_requests_tracking_hash_idx"
  ON "project_requests" ((data ->> 'trackingHash'));
