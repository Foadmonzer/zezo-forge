import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiFailure } from '../src/server/api-error-response.js';

test('uncaught API failures return no-store JSON with a request id', async () => {
  const failure = buildApiFailure(new Error('database password must never be returned'), 'POST', 'test-request-id');
  assert.equal(failure.response.status, 500);
  assert.match(failure.response.headers.get('content-type') || '', /application\/json/i);
  assert.equal(failure.response.headers.get('cache-control'), 'no-store');
  assert.equal(failure.response.headers.get('x-request-id'), 'test-request-id');

  const body = await failure.response.json();
  assert.equal(body.requestId, 'test-request-id');
  assert.match(body.error, /request could not be completed/i);
  assert.doesNotMatch(JSON.stringify(body), /database password/i);
  assert.doesNotMatch(JSON.stringify(failure.log), /database password/i);
});

test('only sanitized error metadata is returned for server logs', () => {
  const error = new Error('sensitive customer text and token');
  error.code = '08006';
  error.name = 'PostgresClient';
  const failure = buildApiFailure(error, 'POST', 'safe-id');

  assert.deepEqual(failure.log, {
    requestId: 'safe-id',
    method: 'POST',
    errorName: 'PostgresClient',
    errorCode: '08006'
  });
  assert.doesNotMatch(JSON.stringify(failure.log), /sensitive|token/i);
});

test('malformed error metadata is reduced to safe defaults', () => {
  const error = new Error('secret');
  error.code = 'secret=credential';
  error.name = '<script>secret</script>';
  const failure = buildApiFailure(error, 'INVALID METHOD', 'safe-id');

  assert.deepEqual(failure.log, {
    requestId: 'safe-id',
    method: 'UNKNOWN',
    errorName: 'unknown',
    errorCode: 'unknown'
  });
});
