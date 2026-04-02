import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuthHeaders,
  createJsonLineParser,
  verifyRemoteHeaders,
} from '../remote-common.mjs';

test('buildAuthHeaders and verifyRemoteHeaders round-trip', () => {
  const headers = buildAuthHeaders({
    serverId: 'server-a',
    sharedSecret: 'secret-123',
  });

  const result = verifyRemoteHeaders({
    headers,
    expectedSharedSecret: 'secret-123',
  });

  assert.equal(result.ok, true);
  assert.equal(result.serverId, 'server-a');
});

test('verifyRemoteHeaders rejects wrong secret', () => {
  const headers = buildAuthHeaders({
    serverId: 'server-a',
    sharedSecret: 'secret-123',
  });

  const result = verifyRemoteHeaders({
    headers,
    expectedSharedSecret: 'different-secret',
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid signature/i);
});

test('createJsonLineParser ignores blank and malformed lines', () => {
  const messages = [];
  const parse = createJsonLineParser(message => {
    messages.push(message);
  });

  parse('{"type":"one"}\n\nnot-json\n{"type":"two"');
  parse('}\n');

  assert.deepEqual(messages, [{ type: 'one' }, { type: 'two' }]);
});
