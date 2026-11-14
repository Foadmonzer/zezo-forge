import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('ZZPGCM01');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

function encryptionKey() {
  const value = String(process.env.ZEZO_BACKUP_ENCRYPTION_KEY || '').trim();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('ZEZO_BACKUP_ENCRYPTION_KEY must be a base64 encoded 32-byte key.');
  return key;
}

function postgresConfig() {
  const raw = String(process.env.DATABASE_URL || '');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL must name a database.');

  const env = { ...process.env };
  delete env.DATABASE_URL;
  for (const name of Object.keys(env)) if (name.startsWith('ZEZO_BACKUP_')) delete env[name];
  env.PGDATABASE = database;
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  if (url.searchParams.has('sslmode')) env.PGSSLMODE = url.searchParams.get('sslmode');
  return { database, env };
}

function prefixArgs(name) {
  const raw = String(process.env[name] || '[]');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== 'string')) {
    throw new Error(`${name} must be a JSON array of command-line arguments.`);
  }
  return parsed;
}

function runTool(command, args, env, { stdin = 'ignore', stdout = 'pipe' } = {}) {
  const child = spawn(command, args, {
    env,
    stdio: [stdin, stdout, 'inherit']
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`${command} exited with ${signal || `code ${code}`}.`));
    });
  });
  return { child, exit };
}

async function backup(outputFile) {
  if (!outputFile) throw new Error('Usage: node scripts/postgres-encrypted-backup.mjs backup <output-file>');
  const key = encryptionKey();
  const { database, env } = postgresConfig();
  const outputPath = resolve(outputFile);
  const iv = randomBytes(IV_BYTES);
  const command = process.env.ZEZO_PG_DUMP_BIN || 'pg_dump';
  const args = [
    ...prefixArgs('ZEZO_PG_DUMP_PREFIX_ARGS'),
    '--format=custom', '--no-owner', '--no-privileges', `--dbname=${database}`
  ];

  await mkdir(dirname(outputPath), { recursive: true });
  const handle = await open(outputPath, 'wx', 0o600);
  let created = true;
  try {
    await handle.write(Buffer.concat([MAGIC, iv]));
    const output = handle.createWriteStream();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const { child, exit } = runTool(command, args, env, { stdout: 'pipe' });
    await Promise.all([pipeline(child.stdout, cipher, output), exit]);
    await appendFile(outputPath, cipher.getAuthTag());
    created = false;
    console.log(`Encrypted PostgreSQL backup created: ${basename(outputPath)} (${(await stat(outputPath)).size} bytes).`);
  } finally {
    key.fill(0);
    await handle.close().catch(() => {});
    if (created) await rm(outputPath, { force: true });
  }
}

async function restore(inputFile) {
  if (!inputFile) throw new Error('Usage: node scripts/postgres-encrypted-backup.mjs restore <backup-file>');
  if (process.env.ZEZO_CONFIRM_TEST_RESTORE !== 'YES') {
    throw new Error('Set ZEZO_CONFIRM_TEST_RESTORE=YES only for a disposable synthetic restore test.');
  }
  const key = encryptionKey();
  const { database, env } = postgresConfig();
  if (!/^zezo_restore_test_[a-z0-9_-]{4,48}$/i.test(database)) {
    throw new Error('Restore is restricted to an empty disposable database named zezo_restore_test_<suffix>.');
  }

  const inputPath = resolve(inputFile);
  const fileSize = (await stat(inputPath)).size;
  if (fileSize < HEADER_BYTES + TAG_BYTES + 1) throw new Error('Encrypted backup file is too short.');
  const headerHandle = await open(inputPath, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await headerHandle.read(header, 0, HEADER_BYTES, 0);
    await headerHandle.read(tag, 0, TAG_BYTES, fileSize - TAG_BYTES);
  } finally {
    await headerHandle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unsupported encrypted backup format.');

  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const ciphertext = createReadStream(inputPath, { start: HEADER_BYTES, end: fileSize - TAG_BYTES - 1 });
  const command = process.env.ZEZO_PG_RESTORE_BIN || 'pg_restore';
  const args = [
    ...prefixArgs('ZEZO_PG_RESTORE_PREFIX_ARGS'),
    '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${database}`
  ];
  const { child, exit } = runTool(command, args, env, { stdin: 'pipe', stdout: 'ignore' });
  try {
    await Promise.all([pipeline(ciphertext, decipher, child.stdin), exit]);
    console.log(`Encrypted backup restored to disposable database ${database}.`);
  } finally {
    key.fill(0);
    if (child.exitCode === null) child.kill();
  }
}

const commandArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const [mode, file] = commandArgs;
try {
  if (mode === 'backup') await backup(file);
  else if (mode === 'restore') await restore(file);
  else throw new Error('Choose backup or restore.');
} catch (error) {
  console.error(`PostgreSQL backup operation failed: ${error.message}`);
  process.exitCode = 1;
}
