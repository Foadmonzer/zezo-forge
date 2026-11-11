import assert from 'node:assert/strict';

process.env.ZEZO_STAGING_ACCESS_PASSWORD = 'Synthetic-Staging-Only-Phase4-Password';
const {
  createStagingSession,
  isStagingSessionValid,
  stagingPasswordMatches,
  STAGING_SESSION_TTL_SECONDS
} = await import('./src/server/staging-auth.js');
const edgeAuth = await import('./src/server/staging-edge-auth.js');

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

console.log('PASS — Node and Web Crypto staging password checks, signed cookie integrity, expiry, and malformed-cookie rejection.');

