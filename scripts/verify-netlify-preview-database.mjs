import pg from 'pg';
import { createPostgresPoolOptions } from '../src/server/postgres-runtime.js';

async function verifyPreviewDatabase() {
  const project = process.env.ZEZO_PREVIEW_DB_PROJECT || '';
  const pooler = process.env.ZEZO_PREVIEW_DB_POOLER || '';
  const role = process.env.ZEZO_PREVIEW_DB_ROLE || '';
  const databaseUrl = new URL(process.env.DATABASE_URL || '');
  if (!/^[a-z]{20}$/.test(project) || !/^aws-\d+-[a-z\d-]+\.pooler\.supabase\.com$/.test(pooler) ||
      !/^zezo_netlify_preview_[a-z\d_]+$/.test(role) || databaseUrl.protocol !== 'postgresql:' ||
      databaseUrl.hostname !== pooler || databaseUrl.port !== '5432' || databaseUrl.pathname !== '/postgres' ||
      databaseUrl.username !== `${role}.${project}` || !databaseUrl.password || databaseUrl.search || databaseUrl.hash) {
    throw new Error('Unexpected preview database configuration');
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
      throw new Error('Unexpected preview database identity');
    }
    console.log(`Deploy Preview verified staging database ${project} over TLS with a read-only query.`);
  } finally {
    await client.end();
  }
}

try {
  await verifyPreviewDatabase();
} catch {
  // Driver errors may include connection metadata. Keep build output generic.
  console.error('Deploy Preview database verification failed. Check the staging connection and preview-only settings.');
  process.exitCode = 1;
}
