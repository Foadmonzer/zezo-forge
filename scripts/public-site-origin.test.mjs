import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_PUBLIC_SITE_ORIGIN, getPublicSiteOrigin, getRequestPublicSiteOrigin, normalizePublicSiteOrigin } from '../src/public-site-origin.js';

const netlifyConfig = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const publicHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('uses the configured verified HTTPS origin and strips the trailing slash', () => {
  assert.equal(getPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'https://zezoforge.com/', NODE_ENV: 'production' }), 'https://zezoforge.com');
});

test('falls back to the existing public site when production is not configured with HTTPS', () => {
  assert.equal(getPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'http://preview.example', NODE_ENV: 'production' }), DEFAULT_PUBLIC_SITE_ORIGIN);
  assert.equal(getPublicSiteOrigin({ ZEZO_PUBLIC_URL: '', NODE_ENV: 'production' }), DEFAULT_PUBLIC_SITE_ORIGIN);
  assert.equal(getPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'https://zezo-forge-fouad.netlify.app', NODE_ENV: 'production' }), DEFAULT_PUBLIC_SITE_ORIGIN);
});

test('rejects paths, query strings, fragments, credentials, and malformed origins', () => {
  for (const value of [
    'https://zezoforge.com/path',
    'https://zezoforge.com/?next=evil.example',
    'https://zezoforge.com/#fragment',
    'https://user:password@zezoforge.com',
    'not a url'
  ]) assert.equal(normalizePublicSiteOrigin(value), '');
});

test('allows local HTTP origins only outside production', () => {
  assert.equal(getPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'http://localhost:4173', NODE_ENV: 'development' }), 'http://localhost:4173');
  assert.equal(getPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'http://localhost:4173', NODE_ENV: 'production' }), DEFAULT_PUBLIC_SITE_ORIGIN);
});

test('uses Netlify preview origins for staging and ignores Host headers for production', () => {
  assert.equal(getPublicSiteOrigin({ ZEZO_STAGING: 'true', DEPLOY_PRIME_URL: 'https://deploy-preview-9--zezo.netlify.app', NODE_ENV: 'production' }), 'https://deploy-preview-9--zezo.netlify.app');
  assert.equal(getRequestPublicSiteOrigin({ ZEZO_STAGING: 'true', NODE_ENV: 'production' }, { isStaging: true, requestOrigin: 'https://attacker.example' }), '');
  assert.equal(getRequestPublicSiteOrigin({ NODE_ENV: 'production' }, { requestOrigin: 'https://attacker.example' }), DEFAULT_PUBLIC_SITE_ORIGIN);
  assert.equal(getRequestPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'https://zezoforge.com', NODE_ENV: 'production' }, { requestOrigin: 'https://attacker.example' }), 'https://zezoforge.com');
  assert.equal(getRequestPublicSiteOrigin({ NODE_ENV: 'development' }, { requestOrigin: 'http://localhost:4173' }), 'http://localhost:4173');
});

test('production request links always use the official domain even when Host or ZEZO_PUBLIC_URL is stale', () => {
  assert.equal(getRequestPublicSiteOrigin({ ZEZO_PUBLIC_URL: 'https://zezo-forge-fouad.netlify.app', NODE_ENV: 'production' }, { requestOrigin: 'https://attacker.example' }), 'https://zezoforge.com');
  assert.equal(getRequestPublicSiteOrigin({ ZEZO_PUBLIC_URL: '', NODE_ENV: 'production' }, { requestOrigin: 'https://zezo-forge-fouad.netlify.app' }), 'https://zezoforge.com');
});

test('redirects only the legacy production hostname to the official HTTPS origin and keeps preview hosts separate', () => {
  assert.match(netlifyConfig, /from\s*=\s*"http:\/\/zezo-forge-fouad\.netlify\.app\/\*"[\s\S]*?to\s*=\s*"https:\/\/zezoforge\.com\/:splat"[\s\S]*?status\s*=\s*301[\s\S]*?force\s*=\s*true/);
  assert.match(netlifyConfig, /from\s*=\s*"https:\/\/zezo-forge-fouad\.netlify\.app\/\*"[\s\S]*?to\s*=\s*"https:\/\/zezoforge\.com\/:splat"[\s\S]*?status\s*=\s*301[\s\S]*?force\s*=\s*true/);
  assert.doesNotMatch(netlifyConfig, /from\s*=\s*"https:\/\/deploy-preview-/);
});

test('public metadata and organization links use the official domain', () => {
  assert.match(publicHtml, /<link rel="canonical" href="https:\/\/zezoforge\.com\/">/);
  assert.match(publicHtml, /<meta property="og:url" content="https:\/\/zezoforge\.com\/">/);
  assert.match(publicHtml, /"url":"https:\/\/zezoforge\.com\/"/);
  assert.doesNotMatch(publicHtml, /zezo-forge-fouad\.netlify\.app/);
});
