import assert from 'node:assert/strict';

process.env.ZEZO_STAGING_ACCESS_PASSWORD = 'Synthetic-Staging-Only-Phase4-Password';
const {
  createStagingSession,
  isStagingSessionValid,
  stagingPasswordMatches,
  STAGING_SESSION_TTL_SECONDS
} = await import('./src/server/staging-auth.js');

const now = Date.now();
const session = createStagingSession(now);
assert.equal(stagingPasswordMatches('Synthetic-Staging-Only-Phase4-Password'), true);
assert.equal(stagingPasswordMatches('incorrect'), false);
assert.equal(isStagingSessionValid(session, now), true);
assert.equal(isStagingSessionValid(session, now + STAGING_SESSION_TTL_SECONDS * 1000), false);
const [expiry, nonce, signature] = session.split('.');
const tamperedSignature = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
const tamperedSession = `${expiry}.${nonce}.${tamperedSignature}`;
assert.equal(isStagingSessionValid(tamperedSession, now), false);
assert.equal(isStagingSessionValid('malformed', now), false);

console.log('PASS — staging password comparison, signed cookie integrity, expiry, and malformed-cookie rejection.');
