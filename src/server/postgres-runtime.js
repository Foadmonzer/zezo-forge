import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const { Pool } = pg;
const transactionStorage = new AsyncLocalStorage();
let pool;
let transactionQueue = Promise.resolve();

export function postgresConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL persistence.');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.min(20, Math.max(2, Number(process.env.ZEZO_DATABASE_POOL_SIZE) || 8)),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }
  return pool;
}

export function currentPostgresClient() {
  return transactionStorage.getStore() ?? null;
}

export async function closePostgresPool() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

export async function withPostgresTransaction(work) {
  const activeClient = currentPostgresClient();
  if (activeClient) return work(activeClient);

  const operation = transactionQueue.then(async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // Serialize the compatibility-state transaction across local and serverless instances.
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [741902, 1]);
      return await transactionStorage.run(client, async () => {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  transactionQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
