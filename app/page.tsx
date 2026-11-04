import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import LegacyApplication from './legacy-application';

export const dynamic = 'force-dynamic';

async function readLegacyBody() {
  const source = await readFile(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const body = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!body) throw new Error('Could not find the ZEZO application body in public/index.html');
  return body.replace(/<script\b[^>]*>\s*<\/script>/gi, '').replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');
}

export default async function HomePage() {
  return <LegacyApplication markup={await readLegacyBody()} />;
}
