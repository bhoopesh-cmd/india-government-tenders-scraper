import assert from 'node:assert/strict';
import test from 'node:test';
import { createGemScanDiagnostics, normalizeInput } from './routes.js';
import { createRunReport } from './run-report.js';
import { SourceHttpError } from './http.js';

function completeScan() {
    return { ...createGemScanDiagnostics(), successfulPages: 4, keywords: [{ keyword: 'synthetic', coverage: 'result_limit' as const, pages: 4 }] };
}

test('a listing-only result is explicitly labeled and claims only the configured listing window', () => {
    const report = createRunReport(normalizeInput({ includePdfDetails: false, maxResults: 40, keywords: ['synthetic'] }), completeScan(), 40, false);
    assert.equal(report.status, 'complete');
    assert.equal(report.mode, 'listings_only');
    assert.equal(report.savedTenders, 40);
});

test('deadline interruption and PDF failures remain partial even when useful rows were saved', () => {
    for (const reason of ['time_limit', 'pdf_failed'] as const) {
        const diagnostics = completeScan(); diagnostics.complete = false; diagnostics.issues.push({ keyword: 'synthetic', reason });
        const report = createRunReport(normalizeInput({ maxResults: 40 }), diagnostics, 20, false);
        assert.equal(report.complete, false);
        assert.equal(report.status, 'partial');
        assert.equal(report.savedTenders, 20);
        if (reason === 'time_limit') assert.match(report.guidance!, /Timeout/);
    }
});

test('unvisited keywords prevent a false complete report', () => {
    const report = createRunReport(normalizeInput({ keywords: ['synthetic', 'second'] }), completeScan(), 1, false);
    assert.equal(report.status, 'partial');
});

test('a 404 failure cannot become an empty success and does not publish the raw error or query', () => {
    const error = new Error('private error text', { cause: new SourceHttpError(404, 'https://example.invalid/search?token=private') });
    const report = createRunReport(normalizeInput({}), createGemScanDiagnostics(), 0, false, error);
    assert.equal(report.status, 'failed');
    assert.equal(report.sourceHttpStatus, 404);
    assert.equal(report.savedTenders, 0);
    assert.ok(!JSON.stringify(report).includes('private'));
});

test('spending stops and unsupported CPPP are explicit', () => {
    assert.equal(createRunReport(normalizeInput({}), createGemScanDiagnostics(), 1, true).status, 'spending_limit');
    assert.equal(createRunReport(normalizeInput({ source: 'cppp' }), createGemScanDiagnostics(), 0, false).status, 'unsupported_source');
});
