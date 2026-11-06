import { spawnSync } from 'node:child_process';

const host = process.env.PGHOST;
const port = process.env.PGPORT || '5432';
const user = process.env.PGUSER;
const database = process.env.PGDATABASE;
if (![host, user, database].every(Boolean)) throw new Error('PGHOST, PGUSER, and PGDATABASE must identify the ephemeral CI PostgreSQL service.');

const connection = `postgresql://${encodeURIComponent(user)}@${host}:${port}/${encodeURIComponent(database)}`;
const env = { ...process.env, DATABASE_URL: connection, NODE_ENV: 'test' };
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const commands = [
  { executable, args: ['exec', 'prisma', 'migrate', 'deploy'] },
  { executable, args: ['test:postgres'] },
  { executable: process.execPath, args: ['postgres-core-read-benchmark.js'] }
];

for (const command of commands) {
  const result = spawnSync(command.executable, command.args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
