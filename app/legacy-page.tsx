import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import LegacyApplication from './legacy-application';

export default async function LegacyPage() {
  const source = await readFile(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const markup = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!markup) throw new Error('Could not find the ZEZO application body in public/index.html');
  const safeMarkup = markup.replace(/<script\b[^>]*>\s*<\/script>/gi, '').replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '');
  return <>
    {['styles', 'templates', 'live-demos', 'demo-web', 'demo-apps', 'demo-ai', 'demo-ideas'].map(file => (
      <link key={file} rel="stylesheet" href={`/${file}.css`} precedence="legacy" />
    ))}
    <LegacyApplication markup={safeMarkup} />
  </>;
}
