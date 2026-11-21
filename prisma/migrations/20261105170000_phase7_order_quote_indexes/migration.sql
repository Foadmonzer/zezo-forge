-- Phase 7 targeted lookups used by the Order Manager and transactional quote flow.
CREATE INDEX IF NOT EXISTS project_requests_order_manager_user_created_idx
  ON project_requests ((data ->> 'orderManagerUserId'), "createdAt" DESC);

CREATE INDEX IF NOT EXISTS project_requests_department_created_idx
  ON project_requests ((COALESCE(NULLIF(data ->> 'department', ''), 'orders')), "createdAt" DESC);

CREATE INDEX IF NOT EXISTS quotes_conversation_created_id_desc_idx
  ON quotes ("conversationId", "createdAt" DESC, id DESC);
