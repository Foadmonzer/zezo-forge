import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { SUPABASE_ROOT_CA_2021 } from './supabase-root-ca-2021.js';

const { Pool } = pg;
const transactionStorage = new AsyncLocalStorage();
let pool;
let transactionQueue = Promise.resolve();
const fallbackRateBuckets = new Map();

export function postgresConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function configuredRootCertificate() {
  if (process.env.DATABASE_CA_CERT_BASE64) {
    return Buffer.from(process.env.DATABASE_CA_CERT_BASE64, 'base64').toString('utf8');
  }
  return process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n') || '';
}

function isSupabaseDatabaseHost(hostname) {
  const host = hostname.toLowerCase();
  return host.endsWith('.supabase.co') || host.endsWith('.pooler.supabase.com');
}

function poolLimit(value) {
  return Math.min(20, Math.max(2, Number(value) || 8));
}

// node-postgres replaces the ssl object when sslmode/sslrootcert/sslcert/sslkey
// is present in connectionString. Remove those query options when supplying a
// CA explicitly so TLS verifies both the chain and the database hostname.
export function createPostgresPoolOptions(databaseUrl, rootCertificate = '', configuredPoolSize = 8) {
  const parsedUrl = new URL(databaseUrl);
  const ca = rootCertificate || (isSupabaseDatabaseHost(parsedUrl.hostname) ? SUPABASE_ROOT_CA_2021 : '');

  if (ca) {
    const tlsParameters = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey']);
    for (const key of [...parsedUrl.searchParams.keys()]) {
      if (tlsParameters.has(key.toLowerCase())) parsedUrl.searchParams.delete(key);
    }
  }

  return {
    connectionString: ca ? parsedUrl.toString() : databaseUrl,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    max: poolLimit(configuredPoolSize),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  };
}

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL persistence.');
    pool = new Pool(createPostgresPoolOptions(
      process.env.DATABASE_URL,
      configuredRootCertificate(),
      process.env.ZEZO_DATABASE_POOL_SIZE
    ));
  }
  return pool;
}

export function currentPostgresClient() {
  return transactionStorage.getStore() ?? null;
}

// Read-only repository queries can use the shared pool directly. Keep this
// separate from withPostgresTransaction so public reads do not join the legacy
// whole-store serialization queue.
export async function queryPostgres(sql, values = []) {
  const client = currentPostgresClient();
  return client ? client.query(sql, values) : getPool().query(sql, values);
}

// Short transactions for normalized, row-scoped repositories. Unlike the legacy
// compatibility transaction, these do not enter the process-wide queue or take
// the company-state advisory lock. Callers must keep their work bounded and rely
// on row locks/unique constraints for any conflicting business operation.
export async function withPostgresScopedTransaction(work) {
  const activeClient = currentPostgresClient();
  if (activeClient) return work(activeClient);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await transactionStorage.run(client, () => work(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Read-only snapshots for dashboards that still use the legacy serializer. They
// share a consistent MVCC view without taking the compatibility write lock.
// Keep mutations out of callbacks passed to this helper.
export async function withPostgresReadTransaction(work) {
  const activeClient = currentPostgresClient();
  if (activeClient) return work(activeClient);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await transactionStorage.run(client, () => work(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeRateLimitBucket(bucket, key, max, windowMs) {
  const digest = createHash('sha256').update(`zezo-rate:${bucket}:${key}`).digest('hex');
  if (postgresConfigured()) {
    const result = await getPool().query(
      'INSERT INTO rate_limit_buckets (key, count, "windowStartedAt", "expiresAt", "updatedAt") VALUES ($1, 1, NOW(), NOW() + ($2 * INTERVAL \'1 millisecond\'), NOW()) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limit_buckets."expiresAt" <= NOW() THEN 1 ELSE rate_limit_buckets.count + 1 END, "windowStartedAt" = CASE WHEN rate_limit_buckets."expiresAt" <= NOW() THEN NOW() ELSE rate_limit_buckets."windowStartedAt" END, "expiresAt" = CASE WHEN rate_limit_buckets."expiresAt" <= NOW() THEN NOW() + ($2 * INTERVAL \'1 millisecond\') ELSE rate_limit_buckets."expiresAt" END, "updatedAt" = NOW() RETURNING count',
      [digest, windowMs]
    );
    return Number(result.rows[0]?.count || 0) <= max;
  }

  const now = Date.now();
  const current = fallbackRateBuckets.get(digest);
  const next = !current || current.expiresAt <= now
    ? { count: 1, expiresAt: now + windowMs }
    : { count: current.count + 1, expiresAt: current.expiresAt };
  fallbackRateBuckets.set(digest, next);
  return next.count <= max;
}

export async function deleteRateLimitBucket(bucket, key) {
  const digest = createHash('sha256').update(`zezo-rate:${bucket}:${key}`).digest('hex');
  if (!postgresConfigured()) return false;
  const result = await getPool().query('DELETE FROM rate_limit_buckets WHERE key = $1', [digest]);
  return (result.rowCount || 0) > 0;
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
      // Coordinate whole-store snapshot upserts with row-scoped financial writes.
      // Scoped requests take compatible ROW EXCLUSIVE locks, allowing different
      // employees to progress concurrently while preventing stale snapshot writes.
      await client.query(`LOCK TABLE app_settings, user_accounts, project_requests, commissions,
        withdrawal_requests, finance_ledger_entries, system_notifications, audit_entries, outbox_messages
        IN SHARE ROW EXCLUSIVE MODE`);
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
