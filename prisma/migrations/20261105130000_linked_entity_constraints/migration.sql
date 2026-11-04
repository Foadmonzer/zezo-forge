-- Link the persisted ZEZO domain rows to their owners and parent records.
-- NOT VALID avoids blocking deploys on pre-existing orphaned legacy rows while still
-- enforcing the foreign key for every new or updated record. Fresh test databases
-- validate these constraints through the relation tests.

ALTER TABLE "project_requests"
  ADD CONSTRAINT "project_requests_developerId_fkey"
  FOREIGN KEY ("developerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "projects_developerId_fkey"
  FOREIGN KEY ("developerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "project_assignments"
  ADD CONSTRAINT "project_assignments_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "project_assignments_developerId_fkey"
  FOREIGN KEY ("developerId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "conversation_messages"
  ADD CONSTRAINT "conversation_messages_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "conversation_messages_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "stored_attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "commissions"
  ADD CONSTRAINT "commissions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "commissions_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "commissions_sourcePaymentId_fkey"
  FOREIGN KEY ("sourcePaymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "wallet_transactions_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "finance_ledger_entries"
  ADD CONSTRAINT "finance_ledger_entries_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "finance_ledger_entries_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "rank_requests"
  ADD CONSTRAINT "rank_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "rank_requests_reviewedBy_fkey"
  FOREIGN KEY ("reviewedBy") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "referral_links"
  ADD CONSTRAINT "referral_links_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "referral_events"
  ADD CONSTRAINT "referral_events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "referral_events_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "referral_attributions"
  ADD CONSTRAINT "referral_attributions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "referral_attributions_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "project_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "system_notifications"
  ADD CONSTRAINT "system_notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "audit_entries"
  ADD CONSTRAINT "audit_entries_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "stored_attachments"
  ADD CONSTRAINT "stored_attachments_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
