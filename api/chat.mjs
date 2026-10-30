const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_BASE_URL = 'https://litellm.tunnel.kiwiai.org/v1';

function problem(status, message, headers = {}) {
  return Response.json({ error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

class RequestProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readMessages(request, signal) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new RequestProblem(413, 'The request is too large.');
  }
  if (!request.body) throw new RequestProblem(400, 'Messages are required.');

  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancel();
        throw new RequestProblem(413, 'The request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestProblem(400, 'The request must contain valid JSON.');
  }
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some((key) => key !== 'messages') ||
      !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 16) {
    throw new RequestProblem(400, 'Provide between 1 and 16 messages only.');
  }
  for (const message of body.messages) {
    if (!message || Array.isArray(message) || typeof message !== 'object' ||
        Object.keys(message).some((key) => !['role', 'content'].includes(key)) ||
        !['system', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || !message.content.trim()) {
      throw new RequestProblem(400, 'Each message needs a valid role and non-empty text.');
    }
  }
  return body.messages.map(({ role, content }) => ({ role, content }));
}

// The concurrency guard is per warm function instance, not a distributed quota
// or authentication. Set usage/spend limits at the upstream provider for a demo.
export function createChatHandler({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model,
  timeoutMs = 115_000,
  maxConcurrent = 6,
  fetchImpl = globalThis.fetch,
} = {}) {
  let upstreamUrl;
  try {
    const url = new URL(baseUrl);
    const localHttp = url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    upstreamUrl = `${url.href.replace(/\/$/, '')}/chat/completions`;
  } catch {
    throw new Error('Invalid server AI endpoint configuration.');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey) ||
      typeof model !== 'string' || !model.trim() || model.length > 128 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || typeof fetchImpl !== 'function') {
    throw new Error('Missing or invalid server AI configuration.');
  }

  let active = 0;
  return async function chat(request) {
    if (request.method !== 'POST') return problem(405, 'Use POST.', { Allow: 'POST' });
    const origin = request.headers.get('origin');
    // This blocks unintended browser cross-origin calls; it is not authentication.
    if (origin && origin !== new URL(request.url).origin) {
      return problem(403, 'Cross-origin requests are not allowed.');
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return problem(415, 'Use application/json.');
    }
    if (active >= maxConcurrent) return problem(429, 'The app is busy. Try again shortly.', { 'Retry-After': '5' });

    active++;
    const controller = new AbortController();
    let timedOut = false;
    let cleaned = false;
    let upstreamReader;
    let streamController;
    const interruptMessage = () => timedOut ? 'The model request timed out.' : 'The model response was interrupted.';
    const onDisconnect = () => controller.abort();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onDisconnect);
      controller.signal.removeEventListener('abort', stopStream);
      active--;
    };
    const stopStream = () => {
      void upstreamReader?.cancel().catch(() => {});
      streamController?.error(new Error(interruptMessage()));
      cleanup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    request.signal.addEventListener('abort', onDisconnect, { once: true });
    controller.signal.addEventListener('abort', stopStream, { once: true });
    if (request.signal.aborted) controller.abort();

    try {
      const messages = await readMessages(request, controller.signal);
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: true }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body ||
          !upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        void upstream.body?.cancel().catch(() => {});
        cleanup();
        return problem(502, 'The model service could not complete the request.');
      }
      controller.signal.throwIfAborted();
      upstreamReader = upstream.body.getReader();
      const stream = new ReadableStream({
        start(value) { streamController = value; },
        async pull(target) {
          try {
            const { value, done } = await upstreamReader.read();
            if (controller.signal.aborted) return;
            if (done) {
              cleanup();
              target.close();
            } else {
              target.enqueue(value);
            }
          } catch {
            if (!cleaned) {
              cleanup();
              target.error(new Error(interruptMessage()));
            }
          }
        },
        cancel() {
          // The downstream is already cancelled; don't error its controller.
          streamController = undefined;
          controller.abort();
          cleanup();
          return upstreamReader.cancel().catch(() => {});
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (error) {
      cleanup();
      if (error instanceof RequestProblem) return problem(error.status, error.message);
      if (timedOut) return problem(504, 'The model request timed out.');
      if (request.signal.aborted) return problem(408, 'The request was cancelled.');
      return problem(502, 'The model service could not complete the request.');
    }
  };
}

let handler;
export async function POST(request) {
  try {
    handler ??= createChatHandler({
      apiKey: process.env.AI_API_KEY,
      baseUrl: process.env.AI_BASE_URL || DEFAULT_BASE_URL,
      model: process.env.AI_MODEL,
    });
  } catch {
    return problem(503, 'AI generation is not configured on the server.');
  }
  return handler(request);
}
