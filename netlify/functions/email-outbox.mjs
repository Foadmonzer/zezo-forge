import { closePostgresPool } from '../../src/server/postgres-runtime.js';
import { postgresOutboxSettings, processPostgresOutbox } from '../../src/server/outbox-worker.js';

export const config = { schedule: '* * * * *' };

const approvedKinds = [
  'client_email_verification', 'team_invitation', 'new_lead', 'customer_thanks',
  'customer_conversation_reply', 'customer_quote_ready', 'client_quote_accepted',
  'project_status', 'project_stage_changed', 'project_delivery_review'
];

export default async function deliverOutbox() {
  if (!postgresOutboxSettings()) return;
  try {
    const { processed, sent, retry, failed, uncertain } = await processPostgresOutbox({ allowedKinds: approvedKinds });
    if (processed) console.log('ZEZO email outbox', { processed, accepted: sent, retry, failed, uncertain });
  } catch {
    console.error('ZEZO email outbox could not finish this run. Its durable state was retained.');
    throw new Error('ZEZO email outbox run failed.');
  } finally {
    await closePostgresPool();
  }
}
