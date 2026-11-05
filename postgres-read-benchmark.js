import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { closePostgresPool } from './src/server/postgres-runtime.js';
import { createStagingSession, STAGING_ACCESS_COOKIE } from './src/server/staging-auth.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to an isolated synthetic PostgreSQL database.');
process.env.ZEZO_STAGING = 'true';
process.env.ZEZO_STAGING_ACCESS_PASSWORD ||= `Benchmark-${randomBytes(24).toString('base64url')}`;
process.env.NODE_ENV = 'test';

const { init, handle } = await import('./server.js');
await init();
const cookie = `${STAGING_ACCESS_COOKIE}=${encodeURIComponent(createStagingSession())}`;
const concurrency = Math.max(1, Number(process.env.BENCH_CONCURRENCY) || 20);
const waves = Math.max(1, Number(process.env.BENCH_WAVES) || 5);

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.statusCode = 0; this.chunks = []; }
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function request() {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = '/api/public';
  req.headers = { cookie };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const response = new Response();
  const done = new Promise((resolve, reject) => { response.once('finish', resolve); response.once('error', reject); });
  const started = performance.now();
  await handle(req, response);
  await done;
  assert.equal(response.statusCode, 200, `Public read failed: ${response.statusCode}`);
  const body = JSON.parse(response.body);
  assert.equal(body.stagingMode, true);
  assert.equal(typeof body.templatePrices, 'object');
  return performance.now() - started;
}

try {
  await request(); // warm the pool and module before each measured run
  const samples = [];
  const started = performance.now();
  for (let wave = 0; wave < waves; wave++) {
    samples.push(...await Promise.all(Array.from({ length: concurrency }, () => request())));
  }
  const elapsedMs = performance.now() - started;
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = value => Number(sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)].toFixed(1));
  console.log(JSON.stringify({
    route: 'GET /api/public',
    concurrency,
    waves,
    requests: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: Number(Math.max(...samples).toFixed(1)),
    totalMs: Number(elapsedMs.toFixed(1)),
    errors: 0
  }));
} finally {
  await closePostgresPool();
}
