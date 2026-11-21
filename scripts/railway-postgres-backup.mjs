import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = [
  'DATABASE_URL', 'ZEZO_BACKUP_ENCRYPTION_KEY', 'ZEZO_BACKUP_S3_ENDPOINT',
  'ZEZO_BACKUP_S3_BUCKET', 'ZEZO_BACKUP_S3_ACCESS_KEY_ID',
  'ZEZO_BACKUP_S3_SECRET_ACCESS_KEY', 'ZEZO_BACKUP_S3_REGION'
];
for (const name of required) if (!String(process.env[name] || '').trim()) throw new Error(`${name} is required for a remote encrypted backup.`);

const endpoint = new URL(process.env.ZEZO_BACKUP_S3_ENDPOINT);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error('Backup object endpoint must be a clean HTTPS URL without embedded credentials, query, or fragment.');
}
const bucket = process.env.ZEZO_BACKUP_S3_BUCKET.trim();
if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new Error('Backup bucket name has an invalid format.');
const region = process.env.ZEZO_BACKUP_S3_REGION.trim();
const keyId = process.env.ZEZO_BACKUP_S3_ACCESS_KEY_ID.trim();
const secret = process.env.ZEZO_BACKUP_S3_SECRET_ACCESS_KEY;
const style = process.env.ZEZO_BACKUP_S3_URL_STYLE || 'virtual';
if (!['virtual', 'path'].includes(style)) throw new Error('ZEZO_BACKUP_S3_URL_STYLE must be virtual or path.');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const awsEncode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKeyPath = key => key.split('/').map(awsEncode).join('/');

function targetFor(key) {
  const basePath = endpoint.pathname.replace(/\/$/, '');
  if (style === 'virtual') {
    const url = new URL(endpoint.href);
    url.hostname = `${bucket}.${endpoint.hostname}`;
    url.pathname = `${basePath}/${encodeKeyPath(key)}`;
    return url;
  }
  const url = new URL(endpoint.href);
  url.pathname = `${basePath}/${awsEncode(bucket)}/${encodeKeyPath(key)}`;
  return url;
}

function signature(method, url, payloadHash, dateTime) {
  const date = dateTime.slice(0, 8);
  const host = url.host;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateTime}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `${method}\n${url.pathname}\n${url.searchParams.toString()}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signatureHex = hmac(signingKey, stringToSign, 'hex');
  return `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function uploadFile(path, key) {
  const url = targetFor(key);
  const payloadHash = await digestFile(path);
  const dateTime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const size = (await stat(path)).size;
  const authorization = signature('PUT', url, payloadHash, dateTime);
  await new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Length': String(size),
        'Content-Type': 'application/octet-stream',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': dateTime,
      },
    }, response => {
      response.resume();
      response.once('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Encrypted backup upload failed with HTTP ${response.statusCode}.`));
      });
    });
    request.once('error', reject);
    createReadStream(path).once('error', reject).pipe(request);
  });
}

function runEncryptedBackup(outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/postgres-encrypted-backup.mjs'), 'backup', outputPath], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Encrypted pg_dump exited with code ${code}.`)));
  });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'zezo-pg-backup-'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const backupFile = join(temporaryRoot, `zezo-${stamp}-${randomBytes(6).toString('hex')}.pgdump.aesgcm`);
const key = `zezo-db/${basename(backupFile)}`;
try {
  await runEncryptedBackup(backupFile);
  await uploadFile(backupFile, key);
  console.log(`Encrypted PostgreSQL backup uploaded to the private object bucket (${(await stat(backupFile)).size} bytes).`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
