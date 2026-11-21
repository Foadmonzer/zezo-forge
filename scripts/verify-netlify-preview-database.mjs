import pg from 'pg';
import { createPostgresPoolOptions } from '../src/server/postgres-runtime.js';

async function verifyPreviewDatabase() {
  const project = process.env.ZEZO_PREVIEW_DB_PROJECT || '';
  const pooler = process.env.ZEZO_PREVIEW_DB_POOLER || '';
  const role = process.env.ZEZO_PREVIEW_DB_ROLE || '';
  if (!process.env.DATABASE_URL) throw new Error('preview credential unavailable');
  let databaseUrl;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('preview credential is not a connection URL');
  }
  if (!/^[a-z]{20}$/.test(project) || !/^aws-\d+-[a-z\d-]+\.pooler\.supabase\.com$/.test(pooler) ||
      !/^zezo_netlify_preview_[a-z\d_]+$/.test(role) || databaseUrl.protocol !== 'postgresql:' ||
      databaseUrl.hostname !== pooler || databaseUrl.port !== '5432' || databaseUrl.pathname !== '/postgres' ||
      databaseUrl.username !== `${role}.${project}` || !databaseUrl.password || databaseUrl.search || databaseUrl.hash) {
    throw new Error('preview credential does not match the configured Staging target');
  }

  const client = new pg.Client({
    ...createPostgresPoolOptions(databaseUrl.href),
    application_name: 'zezo-netlify-preview-build-verification',
    query_timeout: 10_000
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const { rows: [result] } = await client.query(`
      SELECT current_user AS role, current_database() AS database,
             current_setting('transaction_read_only') AS read_only,
             EXISTS (SELECT 1 FROM public.template_prices) AS has_templates
    `);
    await client.query('ROLLBACK');
    if (result.role !== role || result.database !== 'postgres' || result.read_only !== 'on' || !result.has_templates) {
      throw new Error('database did not return the expected Staging identity');
    }
    console.log(`Deploy Preview verified staging database ${project} over TLS with a read-only query.`);
  } finally {
    await client.end();
  }
}

try {
  await verifyPreviewDatabase();
} catch (error) {
  // Only print fixed messages and known error codes. Driver errors can contain connection details.
  const known = new Set([
    'preview credential unavailable',
    'preview credential is not a connection URL',
    'preview credential does not match the configured Staging target',
    'database did not return the expected Staging identity'
  ]);
  const codes = new Set(['28P01', '42501', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  const reason = known.has(error.message) ? error.message : codes.has(error.code) ? error.code : 'connection or read failed';
  console.error(`Deploy Preview database verification failed: ${reason}.`);
  process.exitCode = 1;
}
