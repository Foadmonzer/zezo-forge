import { closePostgresPool, postgresConfigured } from './src/server/postgres-runtime.js';
import { processPostgresOutbox } from './src/server/outbox-worker.js';

if (!postgresConfigured()) throw new Error('DATABASE_URL is required for the PostgreSQL Outbox worker.');

let stopping = false;
let running = false;
async function tick() {
  if (stopping || running) return;
  running = true;
  try {
    const { processed, sent, retry, failed, uncertain, deferred } = await processPostgresOutbox();
    if (processed) console.log('ZEZO email outbox', { processed, accepted: sent, retry, failed, uncertain });
    if (deferred) console.info('ZEZO email outbox deferred while database table was busy', { phase: deferred });
  } catch {
    console.error('Outbox worker failed; durable queue state was retained for retry.');
  } finally {
    running = false;
  }
}

await tick();
const timer = setInterval(() => void tick(), 15_000);
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  while (running) await new Promise(resolve => setTimeout(resolve, 25));
  await closePostgresPool();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
console.log('ZEZO PostgreSQL Outbox worker is running. Email remains disabled until valid provider settings are configured.');
