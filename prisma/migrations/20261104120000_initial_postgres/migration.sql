-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "user_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fullName" TEXT,
    "passwordHash" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_requests" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "referrerId" TEXT,
    "developerId" TEXT,
    "status" TEXT,
    "projectStage" TEXT,
    "templateId" TEXT,
    "agreedAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "developerId" TEXT,
    "stage" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_assignments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "commissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 25,
    "expectedCommission" DECIMAL(12,2),
    "data" JSONB NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "project_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "assignedToId" TEXT,
    "status" TEXT NOT NULL,
    "templateId" TEXT,
    "source" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT,
    "body" TEXT NOT NULL,
    "attachmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "state" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "status" TEXT NOT NULL,
    "sourcePaymentId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "idempotencyKey" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_ledger_entries" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestId" TEXT,
    "employeeId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "idempotencyKey" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_records" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "recordedBy" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rank_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromRank" TEXT NOT NULL,
    "requestedRank" TEXT NOT NULL,
    "salesCount" INTEGER NOT NULL,
    "commissionPercent" DECIMAL(5,2),
    "state" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "rank_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_links" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "referral_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "code" TEXT,
    "eventType" TEXT NOT NULL,
    "visitorHash" TEXT,
    "resourceId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "referral_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_attributions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "referral_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_records" (
    "id" TEXT NOT NULL,
    "status" TEXT,
    "source" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT,
    "readAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_prices" (
    "templateId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_prices_pkey" PRIMARY KEY ("templateId")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_attachments" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "recipient" TEXT,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaigns" (
    "id" TEXT NOT NULL,
    "state" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_state_compat" (
    "id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_state_compat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_email_key" ON "user_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_username_key" ON "user_accounts"("username");

-- CreateIndex
CREATE INDEX "user_accounts_role_active_idx" ON "user_accounts"("role", "active");

-- CreateIndex
CREATE INDEX "project_requests_customerId_createdAt_idx" ON "project_requests"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "project_requests_referrerId_status_idx" ON "project_requests"("referrerId", "status");

-- CreateIndex
CREATE INDEX "project_requests_developerId_projectStage_idx" ON "project_requests"("developerId", "projectStage");

-- CreateIndex
CREATE INDEX "project_requests_templateId_idx" ON "project_requests"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_requestId_key" ON "projects"("requestId");

-- CreateIndex
CREATE INDEX "projects_developerId_stage_idx" ON "projects"("developerId", "stage");

-- CreateIndex
CREATE INDEX "project_assignments_developerId_state_idx" ON "project_assignments"("developerId", "state");

-- CreateIndex
CREATE INDEX "project_assignments_projectId_state_idx" ON "project_assignments"("projectId", "state");

-- CreateIndex
CREATE INDEX "conversations_assignedToId_status_updatedAt_idx" ON "conversations"("assignedToId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "conversations_customerId_updatedAt_idx" ON "conversations"("customerId", "updatedAt");

-- CreateIndex
CREATE INDEX "conversation_messages_conversationId_createdAt_idx" ON "conversation_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "quotes_conversationId_state_idx" ON "quotes"("conversationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_requestId_status_idx" ON "payments"("requestId", "status");

-- CreateIndex
CREATE INDEX "commissions_userId_status_idx" ON "commissions"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commissions_userId_requestId_kind_key" ON "commissions"("userId", "requestId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotencyKey_key" ON "wallet_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "wallet_transactions_userId_status_createdAt_idx" ON "wallet_transactions"("userId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "finance_ledger_entries_idempotencyKey_key" ON "finance_ledger_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "finance_ledger_entries_type_status_createdAt_idx" ON "finance_ledger_entries"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "finance_ledger_entries_employeeId_createdAt_idx" ON "finance_ledger_entries"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "expense_records_category_createdAt_idx" ON "expense_records"("category", "createdAt");

-- CreateIndex
CREATE INDEX "expense_records_status_createdAt_idx" ON "expense_records"("status", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawal_requests_userId_status_idx" ON "withdrawal_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_createdAt_idx" ON "withdrawal_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "rank_requests_userId_state_idx" ON "rank_requests"("userId", "state");

-- CreateIndex
CREATE INDEX "rank_requests_state_createdAt_idx" ON "rank_requests"("state", "createdAt");

-- CreateIndex
CREATE INDEX "employee_invitations_email_status_idx" ON "employee_invitations"("email", "status");

-- CreateIndex
CREATE INDEX "employee_invitations_invitedById_createdAt_idx" ON "employee_invitations"("invitedById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_links_code_key" ON "referral_links"("code");

-- CreateIndex
CREATE INDEX "referral_links_userId_month_idx" ON "referral_links"("userId", "month");

-- CreateIndex
CREATE INDEX "referral_events_userId_eventType_createdAt_idx" ON "referral_events"("userId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "referral_events_requestId_eventType_idx" ON "referral_events"("requestId", "eventType");

-- CreateIndex
CREATE INDEX "referral_attributions_userId_createdAt_idx" ON "referral_attributions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_attributions_requestId_idx" ON "referral_attributions"("requestId");

-- CreateIndex
CREATE INDEX "crm_records_status_updatedAt_idx" ON "crm_records"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "system_notifications_userId_readAt_createdAt_idx" ON "system_notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "audit_entries_actorId_createdAt_idx" ON "audit_entries"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_entries_targetId_createdAt_idx" ON "audit_entries"("targetId", "createdAt");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_expiresAt_idx" ON "auth_sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "stored_attachments_ownerId_createdAt_idx" ON "stored_attachments"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_messages_state_createdAt_idx" ON "outbox_messages"("state", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_campaigns_state_updatedAt_idx" ON "marketing_campaigns"("state", "updatedAt");

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
