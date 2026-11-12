import assert from 'node:assert/strict';

process.env.ZEZO_STAGING_ACCESS_PASSWORD = 'Synthetic-Staging-Only-Phase4-Password';
const {
  createStagingSession,
  isStagingSessionValid,
  stagingPasswordMatches,
  STAGING_SESSION_TTL_SECONDS
} = await import('./src/server/staging-auth.js');
const edgeAuth = await import('./src/server/staging-edge-auth.js');
const { createPostgresPoolOptions } = await import('./src/server/postgres-runtime.js');

const now = Date.now();
const session = await createStagingSession(now);
assert.equal(await stagingPasswordMatches('Synthetic-Staging-Only-Phase4-Password'), true);
assert.equal(await stagingPasswordMatches('incorrect'), false);
assert.equal(await isStagingSessionValid(session, now), true);
assert.equal(await isStagingSessionValid(session, now + STAGING_SESSION_TTL_SECONDS * 1000), false);
const [expiry, nonce, signature] = session.split('.');
const tamperedSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
const tamperedSession = `${expiry}.${nonce}.${tamperedSignature}`;
assert.equal(await isStagingSessionValid(tamperedSession, now), false);
assert.equal(await isStagingSessionValid('malformed', now), false);

const edgeSession = await edgeAuth.createStagingSession(now);
assert.equal(await edgeAuth.stagingPasswordMatches('Synthetic-Staging-Only-Phase4-Password'), true);
assert.equal(await edgeAuth.stagingPasswordMatches('incorrect'), false);
assert.equal(await edgeAuth.isStagingSessionValid(edgeSession, now), true);
assert.equal(await edgeAuth.isStagingSessionValid(edgeSession, now + edgeAuth.STAGING_SESSION_TTL_SECONDS * 1000), false);

const supabaseOptions = createPostgresPoolOptions(
  'postgresql://synthetic:synthetic@aws-0-test.pooler.supabase.com:6543/postgres?sslmode=require&application_name=zezo-staging',
  '',
  6
);
const supabaseConnection = new URL(supabaseOptions.connectionString);
assert.match(supabaseOptions.ssl.ca, /BEGIN CERTIFICATE/);
assert.equal(supabaseOptions.ssl.rejectUnauthorized, true);
assert.equal(supabaseConnection.searchParams.has('sslmode'), false);
assert.equal(supabaseConnection.searchParams.get('application_name'), 'zezo-staging');
assert.equal(supabaseOptions.max, 6);

const customCa = '-----BEGIN CERTIFICATE-----\\nsynthetic\\n-----END CERTIFICATE-----';
const customOptions = createPostgresPoolOptions(
  'postgresql://synthetic:synthetic@db.example.test:5432/postgres?sslmode=require&sslrootcert=ignored',
  customCa,
  4
);
assert.equal(customOptions.ssl.ca, customCa);
assert.equal(customOptions.ssl.rejectUnauthorized, true);
assert.equal(new URL(customOptions.connectionString).searchParams.has('sslrootcert'), false);

const externalOptions = createPostgresPoolOptions(
  'postgresql://synthetic:synthetic@db.example.test:5432/postgres?sslmode=require',
  '',
  8
);
assert.equal('ssl' in externalOptions, false);
assert.equal(externalOptions.connectionString, 'postgresql://synthetic:synthetic@db.example.test:5432/postgres?sslmode=require');

console.log('PASS — Node and Web Crypto staging password checks, signed cookie integrity, expiry, and malformed-cookie rejection.');

