import { Readable, Writable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextRequest } from 'next/server';
import { handle, init } from '../../../server.js';

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

function initLocalRuntime() {
  return globals.__zezoNextInit ??= init();
}

async function dispatch(request: NextRequest) {
  // The current domain runtime persists its store and uploads to local disk.
  // Block serverless writes until the PostgreSQL/object-storage adapter lands.
  if (process.env.VERCEL === '1') {
    return Response.json(
      { error: 'ZEZO API is not ready for serverless storage yet. Configure the PostgreSQL migration before enabling Vercel requests.' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } }
    );
  }

  await initLocalRuntime();

  const requestUrl = new URL(request.url);
  const legacyRequest = (request.body
    ? Readable.fromWeb(request.body as unknown as import('node:stream/web').ReadableStream)
    : Readable.from([])) as LegacyRequest;
  legacyRequest.method = request.method;
  legacyRequest.url = `${requestUrl.pathname}${requestUrl.search}`;
  legacyRequest.headers = Object.fromEntries(request.headers.entries()) as IncomingHttpHeaders;
  legacyRequest.socket = {
    remoteAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
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
