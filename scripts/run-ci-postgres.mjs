import { spawnSync } from 'node:child_process';

const host = process.env.PGHOST;
const port = process.env.PGPORT || '5432';
const user = process.env.PGUSER;
const database = process.env.PGDATABASE;
if (![host, user, database].every(Boolean)) throw new Error('PGHOST, PGUSER, and PGDATABASE must identify the ephemeral CI PostgreSQL service.');

const connection = `postgresql://${encodeURIComponent(user)}@${host}:${port}/${encodeURIComponent(database)}`;
const env = { ...process.env, DATABASE_URL: connection, NODE_ENV: 'test' };
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

for (const args of [['exec', 'prisma', 'migrate', 'deploy'], ['test:postgres']]) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
