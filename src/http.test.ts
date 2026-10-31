import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBoundedResource, isPdfBody, SourceBodyLimitError, SourceHttpError, waitForSourceDelay } from './http.js';

const endpoint = 'https://example.invalid/search';
const noDelay = async () => {};

test('downloads the bounded body and retains Set-Cookie headers for the same search session', async () => {
    const result = await fetchBoundedResource(endpoint, {}, {
        fetcher: async () => new Response('real-shaped fixture', { headers: { 'set-cookie': 'fixture=value; Path=/' } }),
    });
    assert.equal(result.body.toString(), 'real-shaped fixture');
    assert.deepEqual(result.headers.getSetCookie(), ['fixture=value; Path=/']);
});

for (const status of [401, 403, 404, 429]) test(`HTTP ${status} is surfaced after one request without downloading or retrying the rejection`, async () => {
    let calls = 0, canceled = false;
    await assert.rejects(fetchBoundedResource(endpoint + '?token=do-not-log', {}, {
        fetcher: async () => { calls += 1; return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status }); },
        delay: noDelay,
    }), error => error instanceof SourceHttpError && error.status === status && !error.message.includes('do-not-log'));
    assert.equal(calls, 1);
    assert.equal(canceled, true);
});

test('transient server failure can recover within the existing attempt cap', async () => {
    let calls = 0;
    const result = await fetchBoundedResource(endpoint, {}, {
        fetcher: async () => { calls += 1; return new Response(calls === 1 ? 'unavailable' : 'ok', { status: calls === 1 ? 503 : 200 }); },
        delay: noDelay,
    });
    assert.equal(calls, 2);
    assert.equal(result.body.toString(), 'ok');
});

test('persistent server failure stops at the configured attempt cap', async () => {
    let calls = 0;
    await assert.rejects(fetchBoundedResource(endpoint, {}, { fetcher: async () => { calls += 1; return new Response('', { status: 500 }); }, delay: noDelay }), /HTTP 500/);
    assert.equal(calls, 3);
});

test('deadline includes a stalled response body after successful headers', { timeout: 2000 }, async () => {
    let calls = 0, canceled = false;
    const started = performance.now();
    await assert.rejects(fetchBoundedResource(endpoint, {}, {
        timeoutMs: 25, attempts: 1,
        fetcher: async () => { calls += 1; return new Response(new ReadableStream({ cancel() { canceled = true; } })); },
    }), /connection\/body deadline/);
    assert.equal(calls, 1);
    assert.equal(canceled, true);
    assert.ok(performance.now() - started < 1500);
});

test('late response after a header deadline is canceled and cannot become a successful download', async () => {
    let canceled = false;
    await assert.rejects(fetchBoundedResource(endpoint, {}, {
        timeoutMs: 5, attempts: 1,
        fetcher: async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            return new Response(new ReadableStream({ cancel() { canceled = true; } }));
        },
    }), /deadline/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(canceled, true);
});

test('advertised and streamed oversize bodies are canceled without retrying', async () => {
    for (const advertised of [true, false]) {
        let calls = 0, canceled = false;
        await assert.rejects(fetchBoundedResource(endpoint, {}, {
            maxBytes: 3,
            fetcher: async () => {
                calls += 1;
                return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); }, cancel() { canceled = true; } }), { headers: advertised ? { 'content-length': '4' } : {} });
            },
            delay: noDelay,
        }), SourceBodyLimitError);
        assert.equal(calls, 1);
        assert.equal(canceled, true);
    }
});

test('a user-run deadline aborts a stalled body without another source attempt', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic run deadline');
    let calls = 0;
    const work = fetchBoundedResource(endpoint, {}, {
        signal: controller.signal,
        fetcher: async () => { calls += 1; return new Response(new ReadableStream()); },
    });
    controller.abort(reason);
    await assert.rejects(work, error => error === reason);
    assert.equal(calls, 1);
});

test('an already expired deadline prevents a request and cancels retry backoff', async () => {
    const signal = AbortSignal.abort(new Error('expired'));
    let calls = 0;
    await assert.rejects(fetchBoundedResource(endpoint, {}, { signal, fetcher: async () => { calls += 1; return new Response(); } }), /expired/);
    assert.equal(calls, 0);
    await assert.rejects(waitForSourceDelay(10000, signal), /expired/);
});

test('empty and HTML bid documents cannot reach the PDF parser', () => {
    assert.equal(isPdfBody(Buffer.alloc(0)), false);
    assert.equal(isPdfBody(Buffer.from('<html>not a PDF</html>')), false);
    assert.equal(isPdfBody(Buffer.from('%PDF-1.7\nfixture')), true);
});
