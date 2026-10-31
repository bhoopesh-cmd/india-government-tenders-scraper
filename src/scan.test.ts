import assert from 'node:assert/strict';
import test from 'node:test';
import { createGemScanDiagnostics, gemListingEvidence, normalizeInput, scrapeTenders, validateGemSearchResponse, type GemScanRuntime, type GemSearchResponse } from './routes.js';
import type { GemObservation, TenderRecord } from './types.js';
import { SourceHttpError } from './http.js';

test('saved watchlists are opt-in, validate names, and reject unsupported CPPP-only monitoring', () => {
    assert.equal(normalizeInput({ watchlistName: ' laptop-watch ' }).watchlistName, 'laptop-watch');
    assert.equal(normalizeInput({ watchlistName: '  ' }).watchlistName, null);
    for (const name of ['../state', '-invalid', 'a'.repeat(51), 'buyer watch']) {
        assert.throws(() => normalizeInput({ watchlistName: name }), /watchlistName must contain/);
    }
    assert.throws(() => normalizeInput({ watchlistName: 'watch', source: 'cppp' }), /GeM only/);
});

function doc(id = 1, overrides: Record<string, unknown> = {}) {
    return { b_id: id, b_bid_number: `GEM/2026/B/${id}`, bd_category_name: 'Laptop Computers', b_status: 1, ...overrides };
}

function page(docs: Record<string, unknown>[] = [doc()], total = docs.length, start = 0): GemSearchResponse {
    return { code: 200, response: { response: { docs, numFound: total, start } } };
}

function mockRuntime(overrides: Partial<GemScanRuntime> = {}) {
    const calls: string[] = [];
    const runtime: GemScanRuntime = {
        async openSession(reason) { calls.push(`open:${reason}`); return { csrfToken: 'synthetic-token', cookie: '' }; },
        async closeSession() { calls.push('close'); },
        async fetchPage(_session, _status, keyword, number) { calls.push(`page:${keyword}:${number}`); return page(); },
        async enrich(record) { calls.push(`pdf:${record.tenderId}`); return { record, evidence: gemListingEvidence(record), pdfStatus: 'read' }; },
        async delay() {},
        ...overrides,
    };
    return { runtime, calls };
}

test('overlapping keywords emit a bid once and reuse its successful PDF observation', async () => {
    const { runtime, calls } = mockRuntime();
    const diagnostics = createGemScanDiagnostics();
    const saved: GemObservation[] = [];
    const records = await scrapeTenders({ keywords: ['laptop', 'computer'] }, async (_record, observation) => {
        saved.push(observation!); return true;
    }, { diagnostics, gemRuntime: runtime });
    assert.equal(records.length, 1);
    assert.equal(saved.length, 1);
    assert.equal(calls.filter((call) => call.startsWith('pdf:')).length, 1);
    assert.equal(diagnostics.complete, true);
    assert.equal(diagnostics.keywords.length, 2);
    assert.ok(diagnostics.keywords.every((item) => item.coverage === 'result_limit'));
});

test('fresh-session recovery completes a scan; persistent late-page failure preserves records and marks partial', async () => {
    let failedOnce = false;
    const recovered = mockRuntime({
        async fetchPage() {
            if (!failedOnce) { failedOnce = true; throw new Error('synthetic session failure'); }
            return page();
        },
    });
    const complete = createGemScanDiagnostics();
    assert.equal((await scrapeTenders({}, undefined, { diagnostics: complete, gemRuntime: recovered.runtime })).length, 1);
    assert.equal(complete.complete, true);
    assert.equal(recovered.calls.filter((call) => call.startsWith('open:')).length, 2);
    assert.equal(recovered.calls.filter((call) => call === 'close').length, 2);

    const partial = mockRuntime({
        async fetchPage(_session, _status, _keyword, number) {
            if (number === 1) return page([doc()], 2);
            throw new Error('synthetic failed later page');
        },
    });
    const diagnostics = createGemScanDiagnostics();
    assert.equal((await scrapeTenders({ maxResults: 2 }, undefined, { diagnostics, gemRuntime: partial.runtime })).length, 1);
    assert.equal(diagnostics.complete, false);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'search_failed' }]);
    assert.equal(diagnostics.keywords[0].coverage, 'incomplete');
});

test('one failed keyword cannot poison a scan with another successful keyword; zero readable pages still fail', async () => {
    const partial = mockRuntime({
        async fetchPage(_session, _status, keyword) {
            if (keyword === 'printer') throw new Error('synthetic unavailable keyword');
            return page();
        },
    });
    const diagnostics = createGemScanDiagnostics();
    const result = await scrapeTenders({ keywords: ['laptop', 'printer'] }, undefined, { diagnostics, gemRuntime: partial.runtime });
    assert.equal(result.length, 1);
    assert.equal(diagnostics.complete, false);
    assert.equal(diagnostics.keywords[1].coverage, 'incomplete');
    const failed = mockRuntime({ async openSession() { throw new Error('synthetic proxy failure'); } });
    const noPages = createGemScanDiagnostics();
    await assert.rejects(scrapeTenders({}, undefined, { diagnostics: noPages, gemRuntime: failed.runtime }), /did not return a readable search page/);
    assert.equal(noPages.complete, false);
    assert.equal(noPages.successfulPages, 0);
});

test('failed PDF enrichment can save a useful listing but makes monitoring incomplete', async () => {
    const { runtime } = mockRuntime({
        async enrich(record) { return { record, evidence: gemListingEvidence(record), pdfStatus: 'failed' }; },
    });
    const diagnostics = createGemScanDiagnostics();
    assert.equal((await scrapeTenders({}, undefined, { diagnostics, gemRuntime: runtime })).length, 1);
    assert.equal(diagnostics.complete, false);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'pdf_failed' }]);
});

test('an unavailable schedule PDF preserves its listing without a false complete scan', async () => {
    const { runtime } = mockRuntime({ async enrich(record) { return { record, evidence: gemListingEvidence(record), pdfStatus: 'unavailable' }; } });
    const diagnostics = createGemScanDiagnostics();
    assert.equal((await scrapeTenders({}, undefined, { diagnostics, gemRuntime: runtime })).length, 1);
    assert.equal(diagnostics.complete, false);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'pdf_unavailable' }]);
});

test('spending-limit callback stops before more pages, keywords, or PDF work and marks the saved final row partial', async () => {
    const { runtime, calls } = mockRuntime({ async fetchPage() { return page([doc(1), doc(2)], 2); } });
    const diagnostics = createGemScanDiagnostics();
    const confirmedSaved: TenderRecord[] = [];
    await scrapeTenders({ keywords: ['laptop', 'printer'], maxResults: 2 }, async (record) => {
        confirmedSaved.push(record); return false;
    }, { diagnostics, gemRuntime: runtime });
    assert.equal(confirmedSaved.length, 1);
    assert.equal(calls.filter((call) => call.startsWith('pdf:')).length, 1);
    assert.equal(diagnostics.keywords.length, 1);
    assert.equal(diagnostics.complete, false);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'spending_limit' }]);
});

test('page ceiling under restrictive filters is partial, while complete empty search is safe', async () => {
    let pages = 0;
    const { runtime } = mockRuntime({
        async fetchPage(_session, _status, _keyword, number) { pages += 1; return page([doc(number)], 20, number - 1); },
    });
    const diagnostics = createGemScanDiagnostics();
    assert.deepEqual(await scrapeTenders({ department: 'non-matching department' }, undefined, { diagnostics, gemRuntime: runtime }), []);
    assert.equal(pages, 10);
    assert.equal(diagnostics.complete, false);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'page_limit' }]);
    const empty = mockRuntime({ async fetchPage() { return page([]); } });
    const safe = createGemScanDiagnostics();
    assert.deepEqual(await scrapeTenders({}, undefined, { diagnostics: safe, gemRuntime: empty.runtime }), []);
    assert.equal(safe.complete, true);
    assert.equal(safe.keywords[0].coverage, 'exhausted');
});

test('invalid listing shape or bid identity cannot initialize a misleading baseline', async () => {
    for (const response of [{ code: 200 }, { response: { response: { docs: [], numFound: 10 } } }, { response: { response: { docs: [null], numFound: 1 } } }, page([doc()], 0)]) {
        assert.throws(() => validateGemSearchResponse(response as GemSearchResponse), /invalid search-result shape/);
    }
    const malformed = mockRuntime({ async fetchPage() { return { code: 200 }; } });
    const failed = createGemScanDiagnostics();
    await assert.rejects(scrapeTenders({}, undefined, { diagnostics: failed, gemRuntime: malformed.runtime }), /did not return a readable search page/);
    assert.equal(failed.complete, false);
    const invalid = mockRuntime({ async fetchPage() { return page([{ bd_category_name: 'Laptop Computers' }]); } });
    const diagnostics = createGemScanDiagnostics();
    assert.deepEqual(await scrapeTenders({}, undefined, { diagnostics, gemRuntime: invalid.runtime }), []);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'invalid_record' }]);
});

test('listing-only collection is opt-in and incompatible detail options fail before any request', () => {
    assert.equal(normalizeInput({}).includePdfDetails, true);
    assert.equal(normalizeInput({ includePdfDetails: false }).includePdfDetails, false);
    assert.equal(normalizeInput({ includePdfDetails: false, state: '  ', department: '  ' }).includePdfDetails, false);
    for (const option of [{ watchlistName: 'watch' }, { state: 'Karnataka' }, { department: 'Education' }, { dateFrom: '2026-10-01' }, { dateTo: '2026-10-31' }, { minValue: 0 }, { maxValue: 10 }]) {
        assert.throws(() => normalizeInput({ ...option, includePdfDetails: false }), /PDF details must be enabled/);
    }
    assert.throws(() => normalizeInput({ includePdfDetails: 'false' as never }), /must be true or false/);
});

for (const limit of [1, 40, 50]) test(`${limit} unique listing-only tenders use no PDF work and respect the result limit`, async () => {
    const { runtime, calls } = mockRuntime({
        async fetchPage(_session, _status, keyword, number) {
            calls.push(`page:${keyword}:${number}`);
            return page(Array.from({ length: 10 }, (_v, i) => doc((number - 1) * 10 + i + 1)), 100, (number - 1) * 10);
        },
    });
    const diagnostics = createGemScanDiagnostics();
    const observations: GemObservation[] = [];
    const rows = await scrapeTenders({ includePdfDetails: false, maxResults: limit }, async (_record, observation) => {
        observations.push(observation!); return true;
    }, { diagnostics, gemRuntime: runtime });
    assert.equal(rows.length, limit);
    assert.equal(new Set(rows.map(row => row.tenderId)).size, limit);
    assert.equal(calls.filter(call => call.startsWith('pdf:')).length, 0);
    assert.equal(calls.filter(call => call.startsWith('page:')).length, Math.ceil(limit / 10));
    assert.ok(observations.every(item => item.pdfStatus === 'skipped' && !item.evidence.publishedDate));
    assert.equal(diagnostics.complete, true);
});

test('default 40-tender collection retains PDF enrichment for every unique saved bid', async () => {
    const { runtime, calls } = mockRuntime({
        async fetchPage(_session, _status, _keyword, number) {
            return page(Array.from({ length: 10 }, (_v, i) => doc((number - 1) * 10 + i + 1)), 40, (number - 1) * 10);
        },
    });
    const rows = await scrapeTenders({ maxResults: 40 }, undefined, { gemRuntime: runtime });
    assert.equal(rows.length, 40);
    assert.equal(calls.filter(call => call.startsWith('pdf:')).length, 40);
});

test('a 404 search rejection is not retried through another session or treated as an empty result', async () => {
    let pages = 0;
    const { runtime, calls } = mockRuntime({
        async fetchPage() { pages += 1; throw new SourceHttpError(404, 'https://example.invalid/search'); },
    });
    const diagnostics = createGemScanDiagnostics();
    await assert.rejects(scrapeTenders({}, undefined, { diagnostics, gemRuntime: runtime }), /HTTP 404/);
    assert.equal(pages, 1);
    assert.equal(calls.filter(call => call.startsWith('open:')).length, 1);
    assert.equal(diagnostics.complete, false);
    assert.equal(diagnostics.successfulPages, 0);
});

test('one rejected keyword preserves a separate successful keyword without a false complete scan', async () => {
    const { runtime } = mockRuntime({
        async fetchPage(_session, _status, keyword) {
            if (keyword === 'unavailable') throw new SourceHttpError(404, 'https://example.invalid/search');
            return page();
        },
    });
    const diagnostics = createGemScanDiagnostics();
    const rows = await scrapeTenders({ keywords: ['unavailable', 'synthetic'] }, undefined, { diagnostics, gemRuntime: runtime });
    assert.equal(rows.length, 1);
    assert.equal(diagnostics.complete, false);
    assert.equal(diagnostics.keywords[0].coverage, 'incomplete');
    assert.equal(diagnostics.keywords[1].coverage, 'result_limit');
});

test('deadline during enrichment preserves only already saved rows and stops all subsequent work', async () => {
    const controller = new AbortController();
    const { runtime, calls } = mockRuntime({
        async fetchPage() { return page([doc(1), doc(2), doc(3), doc(4)], 40); },
        async enrich(record) {
            calls.push(`pdf:${record.tenderId}`);
            if (record.tenderId.endsWith('/3')) { controller.abort(new Error('synthetic deadline')); throw controller.signal.reason; }
            return { record, evidence: gemListingEvidence(record), pdfStatus: 'read' };
        },
    });
    const diagnostics = createGemScanDiagnostics();
    const rows = await scrapeTenders({ maxResults: 40, keywords: ['synthetic', 'unvisited'] }, undefined, { diagnostics, gemRuntime: runtime, signal: controller.signal });
    assert.equal(rows.length, 2);
    assert.equal(calls.filter(call => call.startsWith('pdf:')).length, 3);
    assert.equal(calls.filter(call => call.startsWith('open:')).length, 1);
    assert.equal(calls.filter(call => call === 'close').length, 1);
    assert.equal(diagnostics.keywords.length, 1);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'synthetic', reason: 'time_limit' }]);
    assert.equal(diagnostics.keywords[0].coverage, 'incomplete');
});

test('an expired deadline prevents session creation and a deadline in page fetching prevents session recovery', async () => {
    const already = mockRuntime();
    const initialDiagnostics = createGemScanDiagnostics();
    assert.deepEqual(await scrapeTenders({}, undefined, { diagnostics: initialDiagnostics, gemRuntime: already.runtime, signal: AbortSignal.abort() }), []);
    assert.deepEqual(already.calls, []);
    assert.equal(initialDiagnostics.complete, false);

    const controller = new AbortController();
    const fetching = mockRuntime({ async fetchPage() { controller.abort(new Error('expired')); throw controller.signal.reason; } });
    const diagnostics = createGemScanDiagnostics();
    assert.deepEqual(await scrapeTenders({}, undefined, { diagnostics, gemRuntime: fetching.runtime, signal: controller.signal }), []);
    assert.equal(fetching.calls.filter(call => call.startsWith('open:')).length, 1);
    assert.equal(diagnostics.issues[0].reason, 'time_limit');
});

test('overlapping page identities do not consume the per-keyword result limit twice', async () => {
    const { runtime, calls } = mockRuntime({
        async fetchPage(_session, _status, _keyword, number) {
            const first = number === 1 ? 1 : 6;
            return page(Array.from({ length: 10 }, (_v, i) => doc(first + i)), 20, (number - 1) * 10);
        },
    });
    const diagnostics = createGemScanDiagnostics();
    const rows = await scrapeTenders({ maxResults: 15 }, undefined, { diagnostics, gemRuntime: runtime });
    assert.equal(rows.length, 15);
    assert.equal(calls.filter(call => call.startsWith('pdf:')).length, 15);
    assert.equal(diagnostics.complete, true);
});

test('a repeated source page stops with explicit partial coverage and no duplicate result fee', async () => {
    const { runtime, calls } = mockRuntime({ async fetchPage() { return page([doc(1), doc(2)], 40); } });
    const diagnostics = createGemScanDiagnostics();
    const rows = await scrapeTenders({ maxResults: 40 }, undefined, { diagnostics, gemRuntime: runtime });
    assert.equal(rows.length, 2);
    assert.equal(calls.filter(call => call.startsWith('pdf:')).length, 2);
    assert.deepEqual(diagnostics.issues, [{ keyword: 'laptop', reason: 'repeated_page' }]);
    assert.equal(diagnostics.complete, false);
});
