import { SourceHttpError } from './http.js';
import type { GemScanDiagnostics, NormalizedInput } from './types.js';

export function createRunReport(input: NormalizedInput, diagnostics: GemScanDiagnostics, savedTenders: number, stoppedByChargeLimit: boolean, error?: unknown) {
    let cause = error;
    let sourceHttpStatus: number | null = null;
    for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
        if (cause instanceof SourceHttpError) { sourceHttpStatus = cause.status; break; }
        cause = cause.cause;
    }
    const expectedCoverageEntries = input.keywords.length * (input.status === 'all' ? 2 : 1);
    const complete = error === undefined && input.source !== 'cppp' && diagnostics.complete
        && diagnostics.keywords.length === expectedCoverageEntries
        && diagnostics.keywords.every(item => item.coverage !== 'incomplete');
    const status = error !== undefined ? 'failed' : stoppedByChargeLimit ? 'spending_limit'
        : input.source === 'cppp' ? 'unsupported_source' : complete ? 'complete' : 'partial';
    return {
        schemaVersion: 1,
        status,
        complete,
        mode: input.includePdfDetails ? 'listing_and_pdf_details' : 'listings_only',
        savedTenders,
        maxResultsPerKeyword: input.maxResults,
        requestedKeywords: input.keywords.length,
        sourceHttpStatus,
        cpppSupported: false,
        scan: structuredClone(diagnostics),
        guidance: diagnostics.issues.some(item => item.reason === 'time_limit')
            ? 'Increase Run options > Timeout for PDF detail searches, reduce maxResults, or use includePdfDetails: false without detail filters/watchlists. Partial output is not a complete result window.'
            : sourceHttpStatus === 404
                ? 'GeM rejected the search endpoint request with HTTP 404. No readable empty search was confirmed; no placeholder tender was saved.'
                : diagnostics.issues.some(item => item.reason === 'pdf_unavailable')
                    ? 'Some evaluated reverse auctions expose an HTML schedule index. This version preserves the canonical listing link but does not extract schedule attachments; PDF detail coverage is incomplete.'
                    : null,
    };
}
