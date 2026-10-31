import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWatchlistScope, compareWatchlist, finalizeWatchlist, MAX_BIDS_PER_SCOPE, MAX_STATE_BYTES, MAX_WATCHLIST_SCOPES, readWatchlistState, type ChangeSummary, type MonitorScan, type WatchlistState, type WatchlistStorage } from './monitoring.js';
import { createGemScanDiagnostics, gemListingEvidence, mapGemDoc, mergeGemPdfDetails, normalizeInput } from './routes.js';
import type { GemObservation, TenderRecord } from './types.js';

function observation(id = 'GEM/2026/B/1', overrides: Partial<TenderRecord> = {}): GemObservation {
    const record = { ...mapGemDoc({
        b_id: 1, b_bid_number: id, bd_category_name: 'Laptop Computers', b_status: 1,
        final_end_date_sort: '2026-10-10T12:00:00Z',
    }, 'laptop'), scrapedAt: '2026-09-30T01:00:00.000Z', ...overrides };
    return { record, evidence: gemListingEvidence(record), pdfStatus: 'read' };
}

function scan(observations = [observation()], overrides: Partial<MonitorScan> = {}): MonitorScan {
    const diagnostics = createGemScanDiagnostics();
    diagnostics.successfulPages = 1;
    diagnostics.keywords = [{ keyword: 'laptop', coverage: 'result_limit', pages: 1 }];
    return {
        watchlistName: 'laptop-watch', input: normalizeInput({ watchlistName: 'laptop-watch' }), observations, diagnostics,
        runId: 'run-1', scanStartedAt: '2026-09-30T00:59:00.000Z', now: '2026-09-30T01:01:00.000Z', ...overrides,
    };
}

function nextScan(observations = [observation()], overrides: Partial<MonitorScan> = {}): MonitorScan {
    return scan(observations, { runId: 'run-2', scanStartedAt: '2026-09-30T02:00:00.000Z', now: '2026-09-30T02:01:00.000Z', ...overrides });
}

test('first safe bounded scan initializes silently and unchanged runs suppress duplicate events', () => {
    const first = compareWatchlist(null, scan());
    assert.equal(first.commit, true);
    assert.equal(first.summary.status, 'initialized');
    assert.equal(first.summary.observedBids, 1);
    assert.deepEqual(first.summary.changes, []);
    const second = compareWatchlist(first.state, nextScan([observation('GEM/2026/B/1', { keyword: ' LAPTOP ', scrapedAt: '2026-09-30T02:00:00Z', tenderTitle: ' laptop   computers ' })]));
    assert.equal(second.summary.unchangedBids, 1);
    assert.deepEqual(second.summary.changes, []);
});

for (const route of ['showradocumentPdf', 'showdirectradocumentPdf', 'list-ra-schedules']) test(`correcting an old auction URL to ${route} does not invent a bid change`, () => {
    const common = { tenderType: 'reverse_auction' };
    const before = observation('GEM/2099/R/41', { ...common, tenderUrl: 'https://bidplus.gem.gov.in/showbidDocument/41' });
    const first = compareWatchlist(null, scan([before]));
    const after = observation('GEM/2099/R/41', { ...common, tenderUrl: `https://bidplus.gem.gov.in/${route}/41` });
    const result = compareWatchlist(first.state, nextScan([after]));
    assert.equal(result.commit, true);
    assert.deepEqual(result.summary.changes, []);
    assert.equal(result.state.scopes[0].bids[0].values.tenderUrl, after.record.tenderUrl);
    after.record.closingDate = '2026-10-12T12:00:00Z';
    const changed = compareWatchlist(first.state, nextScan([after]));
    assert.deepEqual(changed.summary.changes[0].fields.map(item => item.field), ['closingDate']);
});

test('real document identity changes and ordinary bid URL changes are still reported', () => {
    for (const tenderType of ['reverse_auction', 'bid']) {
        const first = compareWatchlist(null, scan([observation('GEM/2099/R/41', { tenderType, tenderUrl: 'https://bidplus.gem.gov.in/showbidDocument/41' })]));
        const after = observation('GEM/2099/R/41', { tenderType, tenderUrl: `https://bidplus.gem.gov.in/showradocumentPdf/${tenderType === 'bid' ? 41 : 42}` });
        const result = compareWatchlist(first.state, nextScan([after]));
        assert.deepEqual(result.summary.changes[0].fields.map(item => item.field), ['tenderUrl']);
    }
});

test('newly observed and materially updated bids contain stable IDs and both source evidence values', () => {
    const first = compareWatchlist(null, scan());
    const secondScan = nextScan([
        observation('GEM/2026/B/1', { closingDate: '2026-10-12T12:00:00Z', tenderStatus: 'bid_awarded' }),
        observation('GEM/2026/B/2'),
        observation('GEM/2026/B/2'),
    ]);
    const second = compareWatchlist(first.state, secondScan);
    assert.equal(second.summary.observedBids, 2);
    assert.deepEqual(second.summary.changes.map((item) => item.type), ['updated_bid', 'newly_observed_bid']);
    const update = second.summary.changes[0];
    assert.deepEqual(update.fields.map((item) => item.field), ['closingDate', 'tenderStatus']);
    assert.equal(update.fields[0].previous, '2026-10-10T12:00:00.000Z');
    assert.equal(update.fields[0].current, '2026-10-12T12:00:00.000Z');
    assert.equal(update.fields[0].evidence.source, 'gem_listing');
    assert.equal(update.fields[0].previousEvidence.url, 'https://bidplus.gem.gov.in/all-bids');
    assert.equal(update.corrigendumCountChanged, false);
    assert.equal(compareWatchlist(first.state, secondScan).summary.changes[0].eventId, update.eventId);
});

test('scope is normalized, includes search filters and result limit, and excludes run metadata', () => {
    const a = buildWatchlistScope(normalizeInput({ keywords: [' laptop ', 'printer'], department: ' Defence  Ministry ', dateFrom: '2026-09-01', dateTo: '2026-09-30' }));
    const b = buildWatchlistScope(normalizeInput({ keywords: ['PRINTER', 'LAPTOP'], department: 'defence ministry', dateFrom: '2026-09-01T00:00:00Z', dateTo: '2026-09-30T09:00:00Z', watchlistName: 'different-name' }));
    assert.equal(a.scopeId, b.scopeId);
    for (const change of [
        { keywords: ['server'] }, { state: 'Karnataka' }, { department: 'Education' }, { minValue: 10 },
        { maxValue: 100 }, { dateFrom: '2026-08-01' }, { dateTo: '2026-10-01' }, { status: 'closed' as const }, { maxResults: 2 },
    ]) assert.notEqual(buildWatchlistScope(normalizeInput(change)).scopeId, buildWatchlistScope(normalizeInput({})).scopeId);
    const first = compareWatchlist(null, scan());
    const changedScope = compareWatchlist(first.state, nextScan([observation('GEM/2026/B/2')], { input: normalizeInput({ state: 'Karnataka' }) }));
    assert.equal(changedScope.summary.status, 'initialized');
    assert.deepEqual(changedScope.summary.changes, []);
});

test('partial or failed detail scans never commit, alert, or remove retained bids', () => {
    const first = compareWatchlist(null, scan());
    for (const reason of ['search_failed', 'pdf_failed', 'pdf_unavailable', 'page_limit', 'spending_limit', 'invalid_record', 'time_limit', 'repeated_page'] as const) {
        const partial = nextScan([observation('GEM/2026/B/2')]);
        partial.diagnostics.complete = false;
        partial.diagnostics.issues.push({ keyword: 'laptop', reason });
        const result = compareWatchlist(first.state, partial);
        assert.equal(result.commit, false);
        assert.equal(result.summary.status, 'incomplete');
        assert.deepEqual(result.summary.changes, []);
        assert.deepEqual(result.state, first.state);
    }
    const failedPdf = observation();
    failedPdf.pdfStatus = 'failed';
    assert.equal(compareWatchlist(first.state, nextScan([failedPdf])).commit, false);
    const incompleteKeyword = nextScan();
    incompleteKeyword.diagnostics.keywords[0].coverage = 'incomplete';
    assert.equal(compareWatchlist(first.state, incompleteKeyword).commit, false);
    assert.equal(compareWatchlist(first.state, nextScan([], { diagnostics: createGemScanDiagnostics() })).commit, false);
});

test('missing bids are retained and never inferred removed or closed, even after an empty complete scan', () => {
    const first = compareWatchlist(null, scan());
    const empty = nextScan([]);
    empty.diagnostics.keywords[0].coverage = 'exhausted';
    const result = compareWatchlist(first.state, empty);
    assert.equal(result.commit, true);
    assert.equal(result.summary.retainedBids, 1);
    assert.deepEqual(result.summary.changes, []);
    assert.equal(result.state.scopes[0].bids[0].values.tenderStatus, 'active');
    assert.deepEqual(compareWatchlist(result.state, nextScan([observation()], { runId: 'run-3', scanStartedAt: '2026-09-30T03:00:00Z' })).summary.changes, []);
});

test('known values survive null observations and newly available fields do not assert a change', () => {
    const pdf = observation();
    pdf.record = mergeGemPdfDetails(pdf.record, 'EMD Amount 25\nBid Opening Date/Time 12-10-2026 12:30:00', pdf.evidence);
    const first = compareWatchlist(null, scan([pdf]));
    const current = observation();
    current.record = mergeGemPdfDetails(current.record, 'Bid Offer Validity (From End Date) 180 (Days)', current.evidence);
    const second = compareWatchlist(first.state, nextScan([current]));
    assert.deepEqual(second.summary.changes, []);
    assert.equal(second.state.scopes[0].bids[0].values.emdAmount, 25);
    assert.equal(second.state.scopes[0].bids[0].values.bidValidity, '180 (Days)');
    const changed = observation();
    changed.record = mergeGemPdfDetails(changed.record, 'EMD Amount 50', changed.evidence);
    const third = compareWatchlist(second.state, nextScan([changed], { runId: 'run-3', scanStartedAt: '2026-09-30T03:00:00Z' }));
    assert.equal(third.summary.changes[0].fields[0].field, 'emdAmount');
    assert.equal(third.summary.changes[0].fields[0].evidence.source, 'gem_bid_pdf');
});

test('corrigenda are tracked only with explicit source count evidence, never from deadlines or generic mentions', () => {
    const a = observation();
    a.record = mergeGemPdfDetails(a.record, 'Corrigendum Count: 1', a.evidence);
    const b = observation();
    b.record = mergeGemPdfDetails(b.record, 'Number of Corrigenda: 2', b.evidence);
    const first = compareWatchlist(null, scan([a]));
    const second = compareWatchlist(first.state, nextScan([b]));
    assert.equal(second.summary.changes[0].corrigendumCountChanged, true);
    assert.equal(second.summary.changes[0].fields[0].evidence.excerpt, 'Number of Corrigenda: 2');
    for (const text of ['Corrigendum No. 2', 'Please check corrigenda on the portal.', 'The estimated Corrigendum Count: 2 is unavailable.']) {
        const item = observation();
        item.record = mergeGemPdfDetails(item.record, text, item.evidence);
        assert.equal(item.record.corrigendumCount, null);
        assert.deepEqual(compareWatchlist(first.state, nextScan([item])).summary.changes, []);
    }
    const unproven = observation('GEM/2026/B/1', { corrigendumCount: 10 });
    assert.deepEqual(compareWatchlist(first.state, nextScan([unproven])).summary.changes, []);
});

test('listing department fallback cannot create a false organization update when a PDF field disappears', () => {
    const a = observation('GEM/2026/B/1', { organization: 'Department of Education', department: 'Department of Education' });
    a.record = mergeGemPdfDetails(a.record, 'Organisation Name\nPublic University\nOffice Name\nProcurement Office', a.evidence);
    assert.equal(a.record.organization, 'Public University');
    const first = compareWatchlist(null, scan([a]));
    const b = observation('GEM/2026/B/1', { organization: 'Department of Education', department: 'Department of Education' });
    assert.equal(b.evidence.organization, undefined);
    const second = compareWatchlist(first.state, nextScan([b]));
    assert.deepEqual(second.summary.changes, []);
    assert.equal(second.state.scopes[0].bids[0].values.organization, 'Public University');
});

test('stale overlapping scans cannot overwrite newer baselines and same-run retries recover the exact report', () => {
    const first = compareWatchlist(null, scan());
    const newer = compareWatchlist(first.state, nextScan([observation('GEM/2026/B/1', { closingDate: '2026-11-01T00:00:00Z' })], { runId: 'newer', scanStartedAt: '2026-09-30T03:00:00Z' }));
    const stale = compareWatchlist(newer.state, nextScan());
    assert.equal(stale.commit, false);
    assert.equal(stale.summary.status, 'stale_scan');
    assert.deepEqual(stale.state, newer.state);
    const replay = compareWatchlist(newer.state, nextScan([], { runId: 'newer', scanStartedAt: '2026-09-30T03:00:00Z' }));
    assert.equal(replay.commit, false);
    assert.equal(replay.summary.replayed, true);
    assert.deepEqual(replay.summary.changes, newer.summary.changes);
});

test('retention bounds scope count, bid count, and source field length without removal events', () => {
    let state: unknown = null;
    let last: ReturnType<typeof compareWatchlist> | undefined;
    for (let batch = 0; batch < 3; batch += 1) {
        const items = Array.from({ length: 250 }, (_, i) => observation(`GEM/2026/B/${batch * 250 + i}`, { scrapedAt: `2026-09-30T0${batch + 1}:00:00Z` }));
        last = compareWatchlist(state, nextScan(items, { runId: `batch-${batch}`, scanStartedAt: `2026-09-30T0${batch + 1}:00:00Z` }));
        state = last.state;
    }
    assert.equal(last!.summary.retainedBids, MAX_BIDS_PER_SCOPE);
    assert.equal(last!.summary.retention.evictedBids, 250);
    for (let i = 0; i < MAX_WATCHLIST_SCOPES + 1; i += 1) {
        const item = observation('GEM/2026/B/1', { tenderTitle: 'A'.repeat(5000) });
        last = compareWatchlist(state, nextScan([item], { input: normalizeInput({ state: `state-${i}` }), runId: `scope-${i}` }));
        state = last.state;
    }
    assert.equal(last!.state.scopes.length, MAX_WATCHLIST_SCOPES);
    assert.equal(last!.state.scopes[0].bids[0].values.tenderTitle!.toString().length, 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE_BYTES);
    assert.doesNotThrow(() => readWatchlistState(state));
    const expired = compareWatchlist(compareWatchlist(null, scan()).state, nextScan([], { now: '2027-01-01T00:00:00Z', scanStartedAt: '2027-01-01T00:00:00Z' }));
    assert.equal(expired.summary.retainedBids, 0);
    assert.equal(expired.summary.retention.evictedBids, 1);
    assert.deepEqual(expired.summary.changes, []);
});

test('corrupt or unsupported saved state fails without a silent baseline reset', () => {
    for (const state of [{ schemaVersion: 2, scopes: [] }, { schemaVersion: 1, scopes: [{}] }, { schemaVersion: 1, scopes: 'bad' }]) {
        assert.throws(() => compareWatchlist(state, scan()), /Saved GeM watchlist state is invalid/);
    }
    const valid = compareWatchlist(null, scan()).state;
    const invalid = structuredClone(valid);
    invalid.scopes[0].bids[0].evidence.closingDate!.url = 'https://example.com/';
    assert.throws(() => readWatchlistState(invalid), /invalid/);
    assert.deepEqual(valid, compareWatchlist(null, scan()).state);
});

test('serialized size pressure evicts older scopes before exceeding the fixed state byte budget', () => {
    let state: unknown = null;
    let result: ReturnType<typeof compareWatchlist> | undefined;
    for (let i = 0; i < 4; i += 1) {
        const items = Array.from({ length: 250 }, (_, j) => observation(`GEM/2026/B/${j}`, {
            tenderReferenceNumber: 'R'.repeat(1000), tenderTitle: 'T'.repeat(1000), category: 'C'.repeat(1000),
            department: 'D'.repeat(1000), ministry: 'M'.repeat(1000), tenderType: 'B'.repeat(1000),
        }));
        result = compareWatchlist(state, nextScan(items, { input: normalizeInput({ state: `scope-${i}` }), runId: `size-${i}`, scanStartedAt: `2026-09-30T0${i + 1}:00:00Z` }));
        state = result.state;
        assert.ok(Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE_BYTES);
    }
    assert.ok(result!.summary.retention.evictedScopes > 0);
    assert.deepEqual(result!.summary.changes, []);
    assert.doesNotThrow(() => readWatchlistState(state));
});

function memoryStorage(initial: unknown = null) {
    let state: unknown = initial;
    let locked = false;
    const calls: string[] = [];
    const published: ChangeSummary[] = [];
    const storage: WatchlistStorage = {
        async acquireLock() { calls.push('lock'); if (locked) return null; locked = true; return 'lease'; },
        async assertLock() { calls.push('assert'); if (!locked) throw new Error('lost lease'); },
        async releaseLock() { calls.push('release'); locked = false; },
        async read() { calls.push('read'); return structuredClone(state); },
        async write(value: WatchlistState) { calls.push('write'); state = structuredClone(value); },
        async publish(value) { calls.push('publish'); published.push(structuredClone(value)); },
    };
    return { storage, calls, published, getState: () => state };
}

test('finalization serializes state writes, concurrent contention is explicit, and partial scans never write a baseline', async () => {
    const store = memoryStorage();
    await finalizeWatchlist(store.storage, scan());
    assert.deepEqual(store.calls, ['lock', 'read', 'assert', 'publish', 'assert', 'write', 'publish', 'release']);
    await store.storage.acquireLock();
    const contention = await finalizeWatchlist(store.storage, nextScan());
    assert.equal(contention.status, 'concurrent_run');
    assert.equal(contention.baselineCommitted, false);
    await store.storage.releaseLock('lease');
    store.calls.length = 0;
    const partial = nextScan();
    partial.diagnostics.complete = false;
    await finalizeWatchlist(store.storage, partial);
    assert.deepEqual(store.calls, ['lock', 'read', 'publish', 'release']);
    assert.equal(store.published.at(-1)!.retainedBids, 1);
});

test('a partial same-run restart replays its committed changes instead of overwriting the valid artifact', async () => {
    const first = compareWatchlist(null, scan());
    const store = memoryStorage(first.state);
    const changed = nextScan([observation('GEM/2026/B/1', { closingDate: '2026-11-01T00:00:00Z' })]);
    const committed = await finalizeWatchlist(store.storage, changed);
    const failedRestart = { ...changed, observations: [], diagnostics: createGemScanDiagnostics() };
    failedRestart.diagnostics.complete = false;
    const replayed = await finalizeWatchlist(store.storage, failedRestart);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.changes, committed.changes);
    assert.equal(replayed.status, 'compared');
    assert.equal(store.calls.filter((call) => call === 'write').length, 1);
});

test('initial publication failure never advances baseline; final publication retries recover the committed report', async () => {
    const store = memoryStorage();
    const originalPublish = store.storage.publish;
    store.storage.publish = async () => { throw new Error('artifact unavailable'); };
    await assert.rejects(finalizeWatchlist(store.storage, scan()), /artifact unavailable/);
    assert.equal(store.getState(), null);
    assert.equal(store.calls.at(-1), 'release');
    let publishes = 0;
    store.storage.publish = async (summary) => {
        publishes += 1;
        if (publishes === 2) throw new Error('final artifact unavailable');
        return originalPublish(summary);
    };
    await assert.rejects(finalizeWatchlist(store.storage, scan()), /final artifact unavailable/);
    assert.equal(store.published[0].baselineCommitted, false);
    assert.equal((store.getState() as WatchlistState).scopes.length, 1);
    store.storage.publish = originalPublish;
    const replay = await finalizeWatchlist(store.storage, scan());
    assert.equal(replay.replayed, true);
    assert.equal(store.calls.filter((call) => call === 'write').length, 1);
});

test('state-write failure keeps baseline and publishes prepared evidence; retries use the same event ID', async () => {
    const first = compareWatchlist(null, scan());
    const failed = memoryStorage(first.state);
    failed.storage.write = async () => { throw new Error('state unavailable'); };
    const changed = nextScan([observation('GEM/2026/B/1', { closingDate: '2026-11-01T00:00:00Z' })]);
    await assert.rejects(finalizeWatchlist(failed.storage, changed), /state unavailable/);
    assert.equal(failed.published.length, 1);
    assert.equal(failed.published[0].baselineCommitted, false);
    assert.deepEqual(failed.getState(), first.state);
    assert.equal(failed.calls.at(-1), 'release');
    const retry = compareWatchlist(failed.getState(), { ...changed, runId: 'run-3', scanStartedAt: '2026-09-30T03:00:00Z' });
    assert.equal(retry.summary.changes[0].eventId, failed.published[0].changes[0].eventId);
});

test('lost lock ownership never changes saved state and always releases the lease', async () => {
    for (const loseAt of [1, 2]) {
        const failed = memoryStorage();
        let renewals = 0;
        failed.storage.assertLock = async () => {
            renewals += 1;
            if (renewals === loseAt) throw new Error('lost lease');
        };
        await assert.rejects(finalizeWatchlist(failed.storage, scan()), /lost lease/);
        assert.equal(failed.getState(), null);
        assert.equal(failed.published.length, loseAt - 1);
        assert.equal(failed.calls.at(-1), 'release');
    }
});
