import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createChatHandler } from '../api/chat.mjs';

const API_KEY = 'test-only-upstream-credential';
const MODEL = 'test-server-model';
const BASE_URL = 'https://model.example.test/v1';
const APP_URL = 'https://explorable.example.test/api/chat';
const messages = [{ role: 'user', content: 'Explain a stack.' }];
const encoder = new TextEncoder();
const FIRST_EVENT = 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n';
const LAST_EVENT = 'data: [DONE]\n\n';

function request(body = { messages }, options = {}) {
  return new Request(APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(APP_URL).origin },
    body: JSON.stringify(body),
    ...options,
  });
}

function handler(fetchImpl, options = {}) {
  return createChatHandler({
    apiKey: API_KEY,
    model: MODEL,
    baseUrl: BASE_URL,
    timeoutMs: 5000,
    fetchImpl,
    ...options,
  });
}

function sse(body = FIRST_EVENT + LAST_EVENT) {
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function within(promise, milliseconds = 1000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('operation did not complete in time')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('only the server supplies upstream credentials, endpoint and model', async () => {
  let outgoing;
  const chat = handler(async (url, init) => {
    outgoing = { url: String(url), init };
    return sse();
  });
  const response = await chat(request({ messages }, {
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(APP_URL).origin,
      Authorization: 'Bearer unrelated-browser-credential',
      'X-Upstream-Url': 'https://attacker.example.test',
    },
  }));
  assert.equal(response.status, 200);
  assert.equal(outgoing.url, `${BASE_URL}/chat/completions`);
  assert.equal(new Headers(outgoing.init.headers).get('authorization'), `Bearer ${API_KEY}`);
  assert.equal(new Headers(outgoing.init.headers).get('x-upstream-url'), null);
  assert.equal(outgoing.init.redirect, 'error');
  assert.deepEqual(JSON.parse(outgoing.init.body), { model: MODEL, messages, stream: true });
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('authorization'), null);
  const body = await response.text();
  assert.equal(body, FIRST_EVENT + LAST_EVENT);
  assert.ok(!body.includes(API_KEY));
});

test('SSE reaches the browser before upstream finishes', async () => {
  let upstream;
  const chat = handler(async () => sse(new ReadableStream({
    start(controller) {
      upstream = controller;
      controller.enqueue(encoder.encode(FIRST_EVENT));
    },
  })));
  const response = await chat(request());
  const reader = response.body.getReader();
  try {
    const first = await within(reader.read());
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), FIRST_EVENT);
    upstream.enqueue(encoder.encode(LAST_EVENT));
    upstream.close();
    let rest = '';
    for (;;) {
      const chunk = await within(reader.read());
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    assert.equal(rest, LAST_EVENT);
  } finally {
    await reader.cancel().catch(() => {});
  }
});

test('browser cancellation cancels the upstream stream and request', async () => {
  let upstreamSignal;
  let canceled = false;
  const chat = handler(async (_url, init) => {
    upstreamSignal = init.signal;
    return sse(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(FIRST_EVENT)); },
      cancel() { canceled = true; },
    }));
  });
  const response = await chat(request());
  const reader = response.body.getReader();
  await within(reader.read());
  await within(reader.cancel());
  assert.equal(canceled, true);
  assert.equal(upstreamSignal.aborted, true);
});

test('upstream errors and unexpected response types do not disclose upstream details', async (t) => {
  const sensitive = `${API_KEY} internal-upstream-diagnostic`;
  for (const [name, fetchImpl] of [
    ['HTTP failure', async () => new Response(sensitive, { status: 401 })],
    ['network failure', async () => { throw new Error(sensitive); }],
    ['non-SSE body', async () => new Response(sensitive, { headers: { 'Content-Type': 'text/html' } })],
  ]) {
    await t.test(name, async () => {
      const response = await handler(fetchImpl)(request());
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.ok(!body.includes(API_KEY));
      assert.ok(!body.includes('internal-upstream-diagnostic'));
      assert.ok(!body.includes(BASE_URL));
    });
  }
});

test('configuration fails without credentials or model and rejects unsafe upstream URLs', () => {
  assert.throws(() => createChatHandler({ model: MODEL }));
  assert.throws(() => createChatHandler({ apiKey: API_KEY }));
  assert.throws(() => createChatHandler({ apiKey: ' ', model: MODEL }));
  assert.throws(() => createChatHandler({ apiKey: API_KEY, model: MODEL, baseUrl: 'http://model.example.test/v1' }));
  assert.throws(() => createChatHandler({ apiKey: API_KEY, model: MODEL, baseUrl: 'https://user:password@model.example.test/v1' }));
});

test('invalid messages and client-selected model or endpoint never reach upstream', async (t) => {
  let calls = 0;
  const chat = handler(async () => { calls += 1; return sse(); });
  const cases = [
    ['missing messages', {}],
    ['empty messages', { messages: [] }],
    ['too many messages', { messages: Array.from({ length: 17 }, () => messages[0]) }],
    ['non-string prompt', { messages: [{ role: 'user', content: { text: 'hello' } }] }],
    ['empty prompt', { messages: [{ role: 'user', content: '' }] }],
    ['unknown role', { messages: [{ role: 'tool', content: 'hello' }] }],
    ['message extensions', { messages: [{ role: 'user', content: 'hello', tool_calls: [] }] }],
    ['client model', { messages, model: 'expensive-client-choice' }],
    ['client endpoint', { messages, baseUrl: 'https://attacker.example.test' }],
    ['client key', { messages, apiKey: 'client-choice' }],
    ['client streaming option', { messages, stream: false }],
    ['array body', []],
    ['null body', null],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const response = await chat(request(body));
      assert.equal(response.status, 400);
      await response.text();
    });
  }
  assert.equal(calls, 0);
});

test('request limits apply even without a Content-Length header', async () => {
  let calls = 0;
  const chat = handler(async () => { calls += 1; return sse(); });
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(128 * 1024) }] });
  const incoming = request(undefined, {
    body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < body.length; offset += 4096) {
          controller.enqueue(encoder.encode(body.slice(offset, offset + 4096)));
        }
        controller.close();
      },
    }),
    duplex: 'half',
  });
  assert.equal(incoming.headers.get('content-length'), null);
  const response = await chat(incoming);
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test('method, JSON and origin checks reject requests before spending upstream quota', async (t) => {
  let calls = 0;
  const chat = handler(async () => { calls += 1; return sse(); });
  const cases = [
    ['GET', new Request(APP_URL), 405],
    ['malformed JSON', request(undefined, { body: '{' }), 400],
    ['wrong content type', request(undefined, { headers: { 'Content-Type': 'text/plain' } }), 415],
    ['foreign origin', request(undefined, { headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example.test' } }), 403],
    ['null origin', request(undefined, { headers: { 'Content-Type': 'application/json', Origin: 'null' } }), 403],
  ];
  for (const [name, incoming, status] of cases) {
    await t.test(name, async () => {
      const response = await chat(incoming);
      assert.equal(response.status, status);
      if (status === 405) assert.equal(response.headers.get('allow'), 'POST');
      await response.text();
    });
  }
  assert.equal(calls, 0);
});

test('upstream timeout aborts the request and returns a generic gateway timeout', async () => {
  let upstreamSignal;
  const chat = handler((_url, init) => {
    upstreamSignal = init.signal;
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }, { timeoutMs: 25 });
  const response = await within(chat(request()));
  assert.equal(response.status, 504);
  assert.equal(upstreamSignal.aborted, true);
  assert.ok(!(await response.text()).includes(API_KEY));
});

test('concurrency capacity is released when the browser cancels a stream', async () => {
  const chat = handler(async () => sse(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(FIRST_EVENT)); },
  })), { maxConcurrent: 1 });
  const first = await chat(request());
  const rejected = await chat(request());
  assert.equal(rejected.status, 429);
  await first.body.cancel();
  const next = await chat(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
});

test('request disconnect interrupts the response and releases concurrency capacity', async () => {
  const client = new AbortController();
  let upstreamSignal;
  let canceled = false;
  const chat = handler(async (_url, init) => {
    upstreamSignal = init.signal;
    return sse(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(FIRST_EVENT)); },
      cancel() { canceled = true; },
    }));
  }, { maxConcurrent: 1 });
  const response = await chat(request(undefined, { signal: client.signal }));
  const reader = response.body.getReader();
  await within(reader.read());
  client.abort();
  await assert.rejects(within(reader.read()), /interrupted/i);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(canceled, true);
  const next = await chat(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
});

test('a timeout during streaming interrupts the reader and releases concurrency capacity', async () => {
  let upstreamSignal;
  let canceled = false;
  const chat = handler(async (_url, init) => {
    upstreamSignal = init.signal;
    return sse(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(FIRST_EVENT)); },
      cancel() { canceled = true; },
    }));
  }, { timeoutMs: 25, maxConcurrent: 1 });
  const response = await chat(request());
  const reader = response.body.getReader();
  await within(reader.read());
  await assert.rejects(within(reader.read()), /timed out/i);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(canceled, true);
  const next = await chat(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
});

test('a mid-stream upstream failure exposes no error details and releases capacity', async () => {
  let upstream;
  const chat = handler(async () => sse(new ReadableStream({
    start(controller) {
      upstream = controller;
      controller.enqueue(encoder.encode(FIRST_EVENT));
    },
  })), { maxConcurrent: 1 });
  const response = await chat(request());
  const reader = response.body.getReader();
  await within(reader.read());
  upstream.error(new Error(`${API_KEY}: internal-upstream-diagnostic`));
  await assert.rejects(within(reader.read()), (error) => {
    assert.match(error.message, /interrupted/i);
    assert.ok(!error.message.includes(API_KEY));
    assert.ok(!error.message.includes('internal-upstream-diagnostic'));
    return true;
  });
  const next = await chat(request());
  assert.equal(next.status, 200);
  await next.body.cancel();
});

test('the deployed POST entry point fails closed when server environment is absent', () => {
  // Use an empty child environment; never inspect or change the developer's keys.
  const moduleUrl = new URL('../api/chat.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { POST } from ${JSON.stringify(moduleUrl)};
    const response = await POST(new Request(${JSON.stringify(APP_URL)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }));
    console.log(JSON.stringify({ status: response.status, body: await response.text() }));
  `], { env: {}, encoding: 'utf8', timeout: 3000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, 503);
  assert.match(response.body, /not configured/i);
});
