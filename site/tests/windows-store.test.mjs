import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/windows-store.js';

function requestWith(url) {
  return { url };
}

function captureResponse() {
  const state = { statusCode: 0, body: null, headers: {} };
  return {
    state,
    setHeader(name, value) {
      state.headers[name] = value;
    },
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(value) {
      state.statusCode = value;
    },
    end(payload) {
      state.body = JSON.parse(payload);
    },
  };
}

async function run(url, fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const request = requestWith(url);
    const response = captureResponse();
    await handler(request, response);
    return response.state;
  } finally {
    globalThis.fetch = original;
  }
}

test('rejects a malformed or missing product id', async () => {
  const state = await run('/api/windows-store', async () => {
    throw new Error('should not fetch');
  });
  assert.equal(state.statusCode, 400);
  assert.equal(state.body.available, false);
});

test('reports unpublished listings as unavailable (NotFound payload)', async () => {
  const state = await run('/api/windows-store?productId=9NFJ07JPNL9Q', async (url) => ({
    ok: false,
    status: 404,
    json: async () => ({ code: 'NotFound', innererror: { code: 'ResourceNotFound' } }),
  }));
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.available, false);
  assert.match(state.body.reason, /not published/i);
});

test('reports a published listing as available', async () => {
  const state = await run('/api/windows-store?productId=9NFJ07JPNL9Q', async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({
      Product: {
        ProductId: '9NFJ07JPNL9Q',
        LocalizedProperties: [{ ProductTitle: 'Ensync' }],
      },
    }),
  }));
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.available, true);
  assert.equal(state.body.productId, '9NFJ07JPNL9Q');
});

test('fails closed when the Store returns a non-success status', async () => {
  const state = await run('/api/windows-store?productId=9NFJ07JPNL9Q', async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  }));
  assert.equal(state.statusCode, 502);
  assert.equal(state.body.available, false);
});

test('fails closed when the Store lookup throws', async () => {
  const state = await run('/api/windows-store?productId=9NFJ07JPNL9Q', async () => {
    throw new Error('network down');
  });
  assert.equal(state.statusCode, 502);
  assert.equal(state.body.available, false);
});
