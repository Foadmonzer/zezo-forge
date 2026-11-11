import { Readable, Writable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { handle, init } from '../../../server.js';
import { consumeRateLimitBucket, postgresConfigured } from '../../../src/server/postgres-runtime.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type LegacyRequest = Readable & {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  socket: { remoteAddress: string; encrypted: boolean };
};

class CapturedResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  responseHeaders: Record<string, string | string[]> = {};
  readonly chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, string | string[]> = {}) {
    this.statusCode = status;
    this.responseHeaders = headers;
    this.headersSent = true;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}

const globals = globalThis as typeof globalThis & { __zezoNextInit?: Promise<boolean> };

function hostedServerless() {
  return process.env.VERCEL === '1' || process.env.NETLIFY === 'true' || process.env.ZEZO_SERVERLESS_RUNTIME === 'true';
}

function initLocalRuntime() {
  return globals.__zezoNextInit ??= init();
}

async function dispatch(request: NextRequest) {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === '/api/staging/rate-limit') {
    const noStore = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
    const configuredSecret = String(process.env.ZEZO_STAGING_INTERNAL_SECRET || '');
    const suppliedSecret = request.headers.get('x-zezo-staging-internal') || '';
    const configuredBytes = Buffer.from(configuredSecret);
    const suppliedBytes = Buffer.from(suppliedSecret);
    if (process.env.ZEZO_STAGING !== 'true' || configuredBytes.length < 32 || configuredBytes.length !== suppliedBytes.length || !timingSafeEqual(configuredBytes, suppliedBytes)) {
      return new Response(null, { status: 404, headers: noStore });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...noStore, Allow: 'POST' } });
    if (!postgresConfigured()) return Response.json({ error: 'Staging rate limiter unavailable' }, { status: 503, headers: noStore });
    try {
      const body = await request.json() as { address?: unknown };
      const address = typeof body.address === 'string' ? body.address.slice(0, 128) : '';
      if (!address) return Response.json({ error: 'Invalid limiter key' }, { status: 400, headers: noStore });
      const allowed = await consumeRateLimitBucket('staging-login', address, 12, 15 * 60_000);
      return Response.json({ allowed }, { status: 200, headers: noStore });
    } catch {
      return Response.json({ error: 'Staging rate limiter unavailable' }, { status: 503, headers: noStore });
    }
  }

  // Never let a serverless deployment fall back to ephemeral JSON or local files.
  if (hostedServerless() && !postgresConfigured()) {
    return Response.json(
      { error: 'ZEZO API is not ready for serverless storage yet. Configure the PostgreSQL migration before enabling hosted requests.' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } }
    );
  }

  await initLocalRuntime();

  const legacyRequest = (request.body
    ? Readable.fromWeb(request.body as unknown as import('node:stream/web').ReadableStream)
    : Readable.from([])) as LegacyRequest;
  legacyRequest.method = request.method;
  legacyRequest.url = `${requestUrl.pathname}${requestUrl.search}`;
  legacyRequest.headers = Object.fromEntries(request.headers.entries()) as IncomingHttpHeaders;
  const forwardedFor = process.env.VERCEL === '1'
    ? request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for')
    : process.env.NETLIFY === 'true' || process.env.ZEZO_SERVERLESS_RUNTIME === 'true'
      ? request.headers.get('x-nf-client-connection-ip')
      : process.env.ZEZO_TRUST_PROXY === '1' ? request.headers.get('x-forwarded-for') : null;
  legacyRequest.socket = {
    remoteAddress: forwardedFor?.split(',')[0]?.trim() || '127.0.0.1',
    encrypted: requestUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
  };

  const response = new CapturedResponse();
  const finished = new Promise<void>((resolve, reject) => {
    response.once('finish', resolve);
    response.once('error', reject);
  });
  await handle(legacyRequest, response);
  if (!response.writableEnded) await finished;

  const headers = new Headers();
  for (const [key, value] of Object.entries(response.responseHeaders)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  const body = Buffer.concat(response.chunks);
  const noBody = request.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304;
  return new Response(noBody ? null : new Uint8Array(body), { status: response.statusCode, headers });
}

export const GET = dispatch;
export const HEAD = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;

