import { Readable, Writable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { handle, init } from '../../../server.js';
import { consumeRateLimitBucket, postgresConfigured } from '../../../src/server/postgres-runtime.js';
import { createStagingSession, stagingPasswordMatches, STAGING_ACCESS_COOKIE, STAGING_SESSION_TTL_SECONDS } from '../../../src/server/staging-edge-auth.js';

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

function stagingPublicOrigin(request: NextRequest) {
  try {
    const configured = new URL(String(process.env.ZEZO_PUBLIC_URL || ''));
    if ((configured.protocol === 'https:' || configured.protocol === 'http:') &&
        !configured.username && !configured.password &&
        configured.pathname === '/' && !configured.search && !configured.hash) {
      return configured.origin;
    }
  } catch {
    // Local development may omit ZEZO_PUBLIC_URL; fall back to the request origin.
  }
  return new URL(request.url).origin;
}

function stagingLoginRedirect(request: NextRequest, code: string) {
  const target = new URL('/', stagingPublicOrigin(request));
  target.searchParams.set('stagingError', code);
  const response = NextResponse.redirect(target, 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

function stagingRequestAddress(request: NextRequest) {
  const forwarded = process.env.NETLIFY === 'true' || process.env.ZEZO_SERVERLESS_RUNTIME === 'true'
    ? request.headers.get('x-nf-client-connection-ip')
    : request.headers.get('x-forwarded-for');
  return (forwarded?.split(',')[0]?.trim() || 'unknown').slice(0, 128);
}

async function handleStagingLogin(request: NextRequest) {
  if (process.env.ZEZO_STAGING !== 'true') return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (!process.env.ZEZO_STAGING_ACCESS_PASSWORD || process.env.ZEZO_STAGING_ACCESS_PASSWORD.length < 16) {
    return stagingLoginRedirect(request, 'configuration');
  }
  if (hostedServerless() && !postgresConfigured()) {
    return stagingLoginRedirect(request, 'database_unavailable');
  }

  try {
    const allowed = await consumeRateLimitBucket('staging-login', stagingRequestAddress(request), 12, 15 * 60_000);
    if (!allowed) return stagingLoginRedirect(request, 'rate_limited');

    const form = await request.formData();
    const value = form.get('password');
    const password = typeof value === 'string' ? value : '';
    if (!await stagingPasswordMatches(password)) return stagingLoginRedirect(request, 'invalid_password');

    const response = NextResponse.redirect(new URL('/', stagingPublicOrigin(request)), 303);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.cookies.set({
      name: STAGING_ACCESS_COOKIE,
      value: await createStagingSession(),
      path: '/',
      maxAge: STAGING_SESSION_TTL_SECONDS,
      httpOnly: true,
      sameSite: 'strict',
      secure: request.nextUrl.protocol === 'https:' || hostedServerless()
    });
    return response;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || 'unknown').slice(0, 32)
      : 'unknown';
    const name = error instanceof Error ? error.name : 'unknown';
    console.error('ZEZO staging login limiter failed', { name, code });
    return stagingLoginRedirect(request, 'limiter_unavailable');
  }
}

async function dispatch(request: NextRequest) {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === '/api/staging/login') return handleStagingLogin(request);

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

  // The application handler already owns PostgreSQL loading and transactions for
  // serverless requests. Running init() first adds a second whole-store read/write
  // transaction to every cold function instance, and can serialize unrelated API
  // requests behind the compatibility-store lock. Keep the legacy bootstrap for
  // the local JSON runtime only; hosted data migrations are run explicitly.
  if (!hostedServerless()) await initLocalRuntime();

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

