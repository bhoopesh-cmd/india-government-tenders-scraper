import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCsrfToken, isChargeableTender, mapGemDoc, normalizeInput } from './routes.js';
import type { TenderRecord } from './types.js';

test('normalizes to the low-cost GeM default', () => {
    const input = normalizeInput({});

    assert.equal(input.source, 'gem');
    assert.deepEqual(input.keywords, ['laptop']);
    assert.equal(input.status, 'active');
    assert.equal(input.maxResults, 1);
    assert.equal(input.watchlistName, null);
});

test('trims, deduplicates, and caps keywords', () => {
    const input = normalizeInput({
        keywords: [' laptop ', 'laptop', 'printer', 'router', 'scanner', 'server', ''],
        maxResults: 500,
    });

    assert.deepEqual(input.keywords, ['laptop', 'printer', 'router', 'scanner', 'server']);
    assert.equal(input.maxResults, 50);
});

test('falls back from invalid enum and numeric API values', () => {
    const input = normalizeInput({
        source: 'bad-source' as never,
        status: 'bad-status' as never,
        maxResults: 'not-a-number' as never,
        minValue: -10,
    });

    assert.equal(input.source, 'gem');
    assert.equal(input.status, 'active');
    assert.equal(input.maxResults, 1);
    assert.equal(input.minValue, null);
});

test('rejects impossible value and date ranges before requests', () => {
    assert.throws(() => normalizeInput({ minValue: 100, maxValue: 10 }), /minValue cannot be greater than maxValue/);
    assert.throws(() => normalizeInput({ dateFrom: '2026-07-10', dateTo: '2026-07-01' }), /dateFrom cannot be after dateTo/);
});

test('identifies chargeable tender records only when title and id exist', () => {
    const record = {
        tenderId: 'GEM/2026/B/7605079',
        tenderTitle: 'Laptop procurement',
    } as TenderRecord;

    assert.equal(isChargeableTender(record), true);
    assert.equal(isChargeableTender({ ...record, tenderTitle: null }), false);
    assert.equal(isChargeableTender({ ...record, tenderId: '' }), false);
    assert.equal(isChargeableTender({ ...record, tenderId: 'unknown' }), false);
});

test('extracts the GeM CSRF token from script and hidden-input page shapes', () => {
    const token = '0123456789abcdef0123456789abcdef';

    assert.equal(extractCsrfToken(`<script>'csrf_bd_gem_nk': '${token}'</script>`), token);
    assert.equal(extractCsrfToken(`<input type="hidden" name="csrf_bd_gem_nk" value="${token}">`), token);
    assert.equal(extractCsrfToken(`<input value="${token}" name="csrf_bd_gem_nk" type="hidden">`), token);
    assert.equal(extractCsrfToken('<html>No token</html>'), null);
});

test('maps wrapped GeM listing values into a chargeable tender record', () => {
    const record = mapGemDoc({
        b_id: [7605079],
        b_bid_number: ['GEM/2026/B/7605079'],
        bd_category_name: ['Laptop Computers'],
        ba_official_details_minName: ['Ministry of Education'],
        ba_official_details_deptName: ['Department of Higher Education'],
        final_end_date_sort: ['2026-07-31T12:00:00Z'],
        b_bid_type: [1],
        b_buyer_status: [1],
    }, 'laptop');

    assert.equal(record.tenderId, 'GEM/2026/B/7605079');
    assert.equal(record.tenderTitle, 'Laptop Computers');
    assert.equal(record.department, 'Department of Higher Education');
    assert.equal(record.closingDate, '2026-07-31T12:00:00.000Z');
    assert.equal(record.tenderUrl, 'https://bidplus.gem.gov.in/showbidDocument/7605079');
    assert.equal(isChargeableTender(record), true);
});

for (const [type, evaluation, route] of [
    [1, 0, 'showbidDocument'],
    [2, 0, 'showradocumentPdf'],
    [2, 1, 'list-ra-schedules'],
    [2, 2, 'list-ra-schedules'],
    [5, 0, 'showdirectradocumentPdf'],
    [5, 1, 'showdirectradocumentPdf'],
] as const) test(`official document route for bid type ${type}, evaluation ${evaluation}`, () => {
    const record = mapGemDoc({ b_id: [91], b_bid_number: [`GEM/2099/${type === 1 ? 'B' : 'R'}/91`], bd_category_name: ['Synthetic fixture'], b_bid_type: [type], b_eval_type: [evaluation] }, 'fixture');
    assert.equal(record.tenderUrl, `https://bidplus.gem.gov.in/${route}/91`);
    assert.equal(record.tenderType, type === 1 ? 'bid' : 'reverse_auction');
});
