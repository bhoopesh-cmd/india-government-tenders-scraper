import { Actor, log } from 'apify';
import { ProxyAgent } from 'undici';
import { ActorInput, FieldEvidence, GemObservation, GemScanDiagnostics, NormalizedInput, TenderRecord, TenderStatus } from './types.js';
import { canRetrySource, fetchBoundedResource, isPdfBody, waitForSourceDelay } from './http.js';
import { parseGemPdfText } from './pdf.js';

type JsonObject = Record<string, unknown>;

const GEM_BASE_URL = 'https://bidplus.gem.gov.in';
const CPPP_ACTIVE_URL = 'https://eprocure.gov.in/eprocure/app?page=FrontEndLatestActiveTenders&service=page';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const MAX_GEM_SESSION_ATTEMPTS = 4;
const MAX_GEM_SESSION_REFRESHES = 2;
const MAX_GEM_PAGES_PER_KEYWORD = 10;
const DEFAULT_MAX_RESULTS_PER_KEYWORD = 1;
const MAX_RESULTS_PER_KEYWORD = 50;
const MAX_KEYWORDS_PER_RUN = 5;
const DEFAULT_KEYWORDS = ['laptop'];
const VALID_SOURCES = new Set(['gem', 'cppp', 'both']);
const VALID_STATUSES = new Set(['active', 'closed', 'all']);

export interface GemSession {
    csrfToken: string;
    cookie: string;
    dispatcher?: ProxyAgent;
    signal?: AbortSignal;
}

export interface GemSearchResponse {
    status?: number;
    code?: number;
    message?: string;
    response?: {
        response?: {
            numFound?: number;
            start?: number;
            docs?: JsonObject[];
        };
    };
}

type TenderRecordHandler = (record: TenderRecord, observation?: GemObservation) => Promise<boolean>;

export interface GemScanRuntime {
    openSession(reason: string): Promise<GemSession>;
    closeSession(session: GemSession): Promise<void>;
    fetchPage(session: GemSession, status: TenderStatus, keyword: string, page: number): Promise<GemSearchResponse>;
    enrich(record: TenderRecord, session: GemSession): Promise<GemObservation>;
    delay(): Promise<void>;
}

export function createGemScanDiagnostics(): GemScanDiagnostics {
    return { complete: true, successfulPages: 0, issues: [], keywords: [] };
}

export function normalizeInput(input: ActorInput | null): NormalizedInput {
    const requestedKeywords = Array.isArray(input?.keywords) ? input.keywords : DEFAULT_KEYWORDS;
    const allKeywords = [...new Set(requestedKeywords.map((keyword) => cleanString(keyword)).filter((keyword): keyword is string => Boolean(keyword)))];
    const keywords = allKeywords.slice(0, MAX_KEYWORDS_PER_RUN);
    if (allKeywords.length > MAX_KEYWORDS_PER_RUN) {
        log.warning(
            `Input contained ${allKeywords.length} keywords. Processing first ${MAX_KEYWORDS_PER_RUN} to keep public runs cost-safe.`,
        );
    }

    const source = VALID_SOURCES.has(String(input?.source)) ? input?.source as NormalizedInput['source'] : 'gem';
    const status = VALID_STATUSES.has(String(input?.status)) ? input?.status as TenderStatus : 'active';
    const watchlistName = cleanString(input?.watchlistName);
    if (watchlistName && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(watchlistName)) {
        throw new Error('watchlistName must contain 1–50 letters, numbers, underscores or hyphens, starting with a letter or number.');
    }
    if (watchlistName && source === 'cppp') throw new Error('Saved watchlists support GeM only. Use source: gem.');
    const minValue = nonNegativeNumberOrNull(input?.minValue);
    const maxValue = nonNegativeNumberOrNull(input?.maxValue);
    if (minValue !== null && maxValue !== null && minValue > maxValue) {
        throw new Error('minValue cannot be greater than maxValue.');
    }

    const dateFrom = normalizedDate(input?.dateFrom, 'dateFrom');
    const dateTo = normalizedDate(input?.dateTo, 'dateTo');
    if (dateFrom && dateTo && Date.parse(dateFrom) > Date.parse(dateTo)) {
        throw new Error('dateFrom cannot be after dateTo.');
    }
    if (input?.includePdfDetails !== undefined && typeof input.includePdfDetails !== 'boolean') {
        throw new Error('includePdfDetails must be true or false.');
    }
    const includePdfDetails = input?.includePdfDetails !== false;
    if (!includePdfDetails && (watchlistName || cleanString(input?.department) || cleanString(input?.state) || dateFrom || dateTo || minValue !== null || maxValue !== null)) {
        throw new Error('PDF details must be enabled for saved watchlists and detail filters. Remove those options or use includePdfDetails: true.');
    }

    return {
        source,
        keywords: keywords.length > 0 ? keywords : DEFAULT_KEYWORDS,
        department: cleanString(input?.department),
        state: cleanString(input?.state),
        minValue,
        maxValue,
        dateFrom,
        dateTo,
        status,
        maxResults: normalizeMaxResults(input?.maxResults),
        includePdfDetails,
        watchlistName,
        proxyConfiguration: input?.proxyConfiguration,
    };
}

export async function scrapeTenders(
    rawInput: ActorInput | null,
    onRecord?: TenderRecordHandler,
    options: { diagnostics?: GemScanDiagnostics; gemRuntime?: GemScanRuntime; signal?: AbortSignal } = {},
): Promise<TenderRecord[]> {
    const input = normalizeInput(rawInput);
    const records: TenderRecord[] = [];
    const seen = new Set<string>();
    const consume = async (record: TenderRecord, observation?: GemObservation): Promise<boolean> => {
        if (!isChargeableTender(record)) return true;
        const key = `${record.source}:${record.tenderId}`;
        if (seen.has(key)) return true;

        if (onRecord && !(await onRecord(record, observation))) return false;
        seen.add(key);
        records.push(record);
        return true;
    };

    if (input.source === 'gem' || input.source === 'both') {
        const diagnostics = options.diagnostics ?? createGemScanDiagnostics();
        const stopped = options.gemRuntime
            ? await scanGemKeywords(input, consume, options.gemRuntime, diagnostics, options.signal)
            : await scrapeGem(input, consume, diagnostics, options.signal);
        if (stopped) return records;
    }

    if (input.source === 'cppp' || input.source === 'both') {
        for (const record of await scrapeCpppGuarded(input)) {
            if (!(await consume(record))) break;
        }
    }

    return records;
}

export function isChargeableTender(record: TenderRecord): boolean {
    return Boolean(record.tenderId && record.tenderId !== 'unknown' && record.tenderTitle);
}

async function scrapeGem(input: NormalizedInput, consume: TenderRecordHandler, diagnostics: GemScanDiagnostics, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const proxyConfiguration = await createGemProxyConfiguration();

    log.info('GeM network mode: Apify Residential Proxy, country=IN');
    const openFreshSession = async (reason: string): Promise<GemSession> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_GEM_SESSION_ATTEMPTS; attempt += 1) {
            signal?.throwIfAborted();
            const sessionId = `gem${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${attempt}`;
            try {
                const proxyUrl = await proxyConfiguration.newUrl(sessionId);
                if (!proxyUrl) throw new Error('Residential proxy URL was not created.');
                return await createGemSession(proxyUrl, signal);
            } catch (error) {
                if (signal?.aborted || !canRetrySource(error)) throw error;
                lastError = error;
                log.warning(
                    `GeM ${reason} session attempt ${attempt}/${MAX_GEM_SESSION_ATTEMPTS} failed: ${errorMessage(error)}`,
                );
                // Each attempt uses a new proxy session ID, so a blocked or dead exit IP is
                // replaced on retry. Back off so GeM is not hit again immediately.
                if (attempt < MAX_GEM_SESSION_ATTEMPTS) await randomDelay(2000 * attempt, 4000 * attempt, signal);
            }
        }
        throw new Error(`GeM Residential India proxy session failed: ${errorMessage(lastError)}`);
    };

    return scanGemKeywords(input, consume, {
        openSession: openFreshSession,
        closeSession: closeGemSession,
        fetchPage: fetchGemPage,
        enrich: enrichGemRecord,
        delay: () => randomDelay(1000, 3000, signal),
    }, diagnostics, signal);
}

export async function scanGemKeywords(
    input: NormalizedInput,
    consume: TenderRecordHandler,
    runtime: GemScanRuntime,
    diagnostics: GemScanDiagnostics,
    signal?: AbortSignal,
): Promise<boolean> {
    const issue = (keyword: string, reason: GemScanDiagnostics['issues'][number]['reason']) => {
        diagnostics.complete = false;
        if (!diagnostics.issues.some((item) => item.keyword === keyword && item.reason === reason)) diagnostics.issues.push({ keyword, reason });
    };
    // The session is opened lazily per keyword. A bad first exit IP then costs one keyword's
    // attempts instead of killing the whole run before a single page is read.
    let session: GemSession | null = null;
    let successfulGemPages = 0;
    let lastGemPageError: unknown;
    const observationsById = new Map<string, GemObservation>();
    const readPage = async (session: GemSession, keyword: string, page: number) => {
        const data = await runtime.fetchPage(session, input.status, keyword, page);
        validateGemSearchResponse(data);
        return data;
    };
    const deadlineReached = (keyword: string) => {
        if (!signal?.aborted) return false;
        issue(keyword, 'time_limit');
        return true;
    };

    try {
        for (const keyword of input.keywords) {
            if (deadlineReached(keyword)) return true;
            let page = 1;
            let scrapedForKeyword = 0;
            let sessionRefreshes = 0;
            const savedIds = new Set<string>();
            const pageIds = new Set<string>();
            const coverage: GemScanDiagnostics['keywords'][number] = { keyword, coverage: 'incomplete', pages: 0 };
            diagnostics.keywords.push(coverage);

            if (!session) {
                try {
                    session = await runtime.openSession(`keyword-${keyword}-initial`);
                } catch (error) {
                    if (deadlineReached(keyword)) return true;
                    lastGemPageError = error;
                    log.warning(`Could not open a GeM India Residential session for keyword="${keyword}": ${errorMessage(error)}`);
                    issue(keyword, 'search_failed');
                    continue;
                }
            }

            while (scrapedForKeyword < input.maxResults) {
                if (deadlineReached(keyword)) return true;
                try { await runtime.delay(); } catch (error) { if (deadlineReached(keyword)) return true; throw error; }
                if (deadlineReached(keyword)) return true;
                let pageSession = session;
                if (!pageSession) break;

                let data: GemSearchResponse;
                try {
                    data = await readPage(pageSession, keyword, page);
                } catch (error) {
                    if (deadlineReached(keyword)) return true;
                    lastGemPageError = error;
                    if (!canRetrySource(error) || sessionRefreshes >= MAX_GEM_SESSION_REFRESHES) {
                        log.warning(
                            `Skipping the remaining GeM pages for keyword="${keyword}" after repeated page failures: ${errorMessage(error)}`,
                        );
                        issue(keyword, 'search_failed');
                        break;
                    }
                    sessionRefreshes += 1;
                    log.warning(
                        `GeM search session failed for keyword="${keyword}" page=${page}; opening one fresh India Residential session: ${errorMessage(error)}`,
                    );
                    await runtime.closeSession(pageSession);
                    session = null;
                    try {
                        session = await runtime.openSession(`keyword-${keyword}-refresh-${sessionRefreshes}`);
                        pageSession = session;
                        data = await readPage(pageSession, keyword, page);
                    } catch (refreshError) {
                        if (deadlineReached(keyword)) return true;
                        lastGemPageError = refreshError;
                        log.warning(
                            `Skipping the remaining GeM pages for keyword="${keyword}" because its fresh session also failed: ${errorMessage(refreshError)}`,
                        );
                        issue(keyword, 'search_failed');
                        break;
                    }
                }
                successfulGemPages += 1;
                diagnostics.successfulPages += 1;
                coverage.pages += 1;

                const docs = data.response?.response?.docs ?? [];
                const total = data.response?.response?.numFound ?? docs.length;

                log.info(`GeM keyword="${keyword}" page=${page}: ${docs.length} docs, total=${total}`);
                if (docs.length === 0) {
                    coverage.coverage = 'exhausted';
                    break;
                }
                const validIds = docs.map(doc => mapGemDoc(doc, keyword)).filter(isChargeableTender).map(record => record.tenderId);
                if (validIds.length > 0 && validIds.every(id => pageIds.has(id))) {
                    issue(keyword, 'repeated_page');
                    break;
                }
                for (const id of validIds) pageIds.add(id);

                for (const doc of docs) {
                    if (deadlineReached(keyword)) return true;
                    if (scrapedForKeyword >= input.maxResults) break;
                    const mapped = mapGemDoc(doc, keyword);
                    if (!isChargeableTender(mapped)) {
                        issue(keyword, 'invalid_record');
                        continue;
                    }
                    if (savedIds.has(mapped.tenderId)) continue;
                    const cached = observationsById.get(mapped.tenderId);
                    let observation: GemObservation;
                    try {
                        observation = cached
                            ? { ...cached, record: { ...cached.record, keyword } }
                            : input.includePdfDetails
                                ? await runtime.enrich(mapped, pageSession)
                                : { record: mapped, evidence: gemListingEvidence(mapped), pdfStatus: 'skipped' };
                    } catch (error) { if (deadlineReached(keyword)) return true; throw error; }
                    if (deadlineReached(keyword)) return true;
                    if (observation.pdfStatus === 'read') observationsById.set(mapped.tenderId, observation);
                    if (input.includePdfDetails && observation.pdfStatus !== 'read') issue(keyword, observation.pdfStatus === 'unavailable' ? 'pdf_unavailable' : 'pdf_failed');
                    const record = observation.record;
                    if (!passesClientFilters(record, input)) continue;
                    if (!(await consume(record, observation))) {
                        issue(keyword, 'spending_limit');
                        return true;
                    }
                    scrapedForKeyword += 1;
                    savedIds.add(record.tenderId);
                }

                const start = data.response?.response?.start ?? (page - 1) * docs.length;
                if (scrapedForKeyword >= input.maxResults) {
                    coverage.coverage = 'result_limit';
                    break;
                }
                if (start + docs.length >= total) {
                    coverage.coverage = 'exhausted';
                    break;
                }
                if (page >= MAX_GEM_PAGES_PER_KEYWORD) {
                    log.warning(
                        `Reached the ${MAX_GEM_PAGES_PER_KEYWORD}-page safety cap for keyword="${keyword}" after saving ${scrapedForKeyword} records. Narrow the filters or use another keyword for more results.`,
                    );
                    issue(keyword, 'page_limit');
                    break;
                }
                page += 1;
            }
        }

        if (successfulGemPages === 0 && lastGemPageError) {
            throw new Error(`GeM did not return a readable search page: ${errorMessage(lastGemPageError)}`, { cause: lastGemPageError });
        }
    } finally {
        if (session) await runtime.closeSession(session);
    }

    return false;
}

async function createGemProxyConfiguration(): Promise<NonNullable<Awaited<ReturnType<typeof Actor.createProxyConfiguration>>>> {
    // GeM (bidplus.gem.gov.in) refuses datacenter proxy exit IPs, so Residential India is the
    // only working route. Surface an actionable message instead of a raw SDK error when the
    // account running the Actor cannot use the Residential group.
    try {
        const proxyConfiguration = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'IN',
        });
        if (!proxyConfiguration) {
            throw new Error('proxy configuration was not created');
        }
        return proxyConfiguration;
    } catch (error) {
        throw new Error(
            'GeM only accepts Apify Residential Proxy traffic from India, and this run could not open a Residential proxy configuration. '
            + 'Enable Residential proxy access for the account running this Actor, then try again. '
            + `Original error: ${errorMessage(error)}`,
        );
    }
}

async function enrichGemRecord(record: TenderRecord, session: GemSession): Promise<GemObservation> {
    const evidence = gemListingEvidence(record);
    if (!record.tenderUrl) return { record, evidence, pdfStatus: 'unavailable' };
    // The official listing points evaluated RAs to an HTML schedule index.
    // Preserve that canonical source link; never pretend the index is a PDF or
    // substitute the parent bid's unrelated document as auction evidence.
    if (new URL(record.tenderUrl).pathname.startsWith('/list-ra-schedules/')) {
        log.info(`GeM ${record.tenderId} exposes a schedule index; PDF details are unavailable in this version.`);
        return { record, evidence, pdfStatus: 'unavailable' };
    }

    try {
        await randomDelay(600, 1600, session.signal);
        const response = await fetchWithRetries(record.tenderUrl, {
            headers: {
                ...baseGemHeaders(),
                accept: 'application/pdf,*/*;q=0.8',
                referer: `${GEM_BASE_URL}/all-bids`,
                ...(session.cookie ? { cookie: session.cookie } : {}),
            },
            dispatcher: session.dispatcher,
        }, { signal: session.signal, timeoutMs: 35_000, attempts: 1, maxBytes: 8 * 1024 * 1024 });
        const bytes = response.body;
        if (!isPdfBody(bytes)) throw new Error('The public bid document is empty or is not a PDF.');
        const text = await parseGemPdfText(bytes);
        return { record: mergeGemPdfDetails(record, text, evidence), evidence, pdfStatus: 'read' };
    } catch (error) {
        if (session.signal?.aborted) throw session.signal.reason;
        log.warning(`Could not enrich GeM PDF for ${record.tenderId}: ${errorMessage(error)}`);
        return { record, evidence, pdfStatus: 'failed' };
    }
}

async function createGemSession(proxyUrl: string | undefined, signal?: AbortSignal): Promise<GemSession> {
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    try {
        const response = await fetchWithRetries(`${GEM_BASE_URL}/all-bids`, {
            headers: baseGemHeaders(),
            dispatcher,
        }, { signal, maxBytes: 2 * 1024 * 1024 });
        const text = response.body.toString('utf8');
        const csrfToken = extractCsrfToken(text);
        if (!csrfToken) {
            throw new Error('GeM CSRF token was not found on all-bids page.');
        }

        return {
            csrfToken,
            cookie: response.headers.getSetCookie?.().map((cookie) => cookie.split(';')[0]).join('; ') ?? '',
            dispatcher,
            signal,
        };
    } catch (error) {
        await dispatcher?.destroy();
        throw error;
    }
}

async function closeGemSession(session: GemSession): Promise<void> {
    try {
        if (session.signal?.aborted) await session.dispatcher?.destroy();
        else await session.dispatcher?.close();
    } catch (error) {
        log.warning(`Could not close the GeM proxy session cleanly: ${errorMessage(error)}`);
    }
}

async function fetchGemPage(session: GemSession, status: TenderStatus, keyword: string, page: number): Promise<GemSearchResponse> {
    const payload = {
        page,
        param: {
            searchBid: keyword,
            searchType: 'fullText',
        },
        filter: buildGemFilter(status),
    };

    const body = new URLSearchParams({
        payload: JSON.stringify(payload),
        csrf_bd_gem_nk: session.csrfToken,
    });

    const response = await fetchWithRetries(`${GEM_BASE_URL}/all-bids-data`, {
        method: 'POST',
        headers: {
            ...baseGemHeaders(),
            accept: 'application/json,text/javascript,*/*;q=0.01',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
            origin: GEM_BASE_URL,
            referer: `${GEM_BASE_URL}/all-bids`,
            ...(session.cookie ? { cookie: session.cookie } : {}),
        },
        body,
        dispatcher: session.dispatcher,
    }, { signal: session.signal });

    const text = response.body.toString('utf8');
    if (text.trim().startsWith('<')) {
        throw new Error(`GeM returned HTML instead of JSON: ${text.slice(0, 160)}`);
    }

    const data = JSON.parse(text) as GemSearchResponse;
    const responseCode = Number(data.code ?? data.status);
    if (responseCode !== 200) {
        const displayedCode = Number.isFinite(responseCode) ? responseCode : 'unknown';
        throw new Error(`GeM returned code ${displayedCode}: ${data.message ?? text.slice(0, 160)}`);
    }
    validateGemSearchResponse(data);
    return data;
}

export function validateGemSearchResponse(data: GemSearchResponse): void {
    const page = data.response?.response;
    if (!page || !Array.isArray(page.docs) || !page.docs.every((doc) => doc !== null && typeof doc === 'object' && !Array.isArray(doc))
        || !Number.isInteger(page.numFound) || Number(page.numFound) < 0
        || (page.start !== undefined && (!Number.isInteger(page.start) || page.start < 0))
        || page.docs.length > Number(page.numFound) - Number(page.start ?? 0)
        || (page.docs.length === 0 && Number(page.numFound) > Number(page.start ?? 0))) {
        throw new Error('GeM returned an incomplete or invalid search-result shape.');
    }
}

function buildGemFilter(status: TenderStatus): JsonObject {
    const filter: JsonObject = {
        bidStatusType: status === 'closed' ? 'bidrastatus' : 'ongoing_bids',
        byType: 'all',
        highBidValue: '',
        byEndDate: {
            from: '',
            to: '',
        },
        sort: status === 'closed' ? 'Bid-End-Date-Latest' : 'Bid-End-Date-Oldest',
    };

    if (status === 'closed') {
        filter.byStatus = 'bid_awarded';
    }

    return filter;
}

export function mapGemDoc(doc: JsonObject, keyword: string): TenderRecord {
    const bidId = firstNumber(doc, ['b_id'])?.toFixed(0) ?? firstString(doc, ['id']);
    const bidNumber = firstString(doc, ['b_bid_number']) ?? bidId ?? 'unknown';
    const category = firstString(doc, ['bd_category_name', 'b_category_name']);
    const ministry = firstString(doc, ['ba_official_details_minName']);
    const department = firstString(doc, ['ba_official_details_deptName']);
    const bidTypeCode = firstNumber(doc, ['b_bid_type']);
    // Match the document routing used by GeM's public all-bids page.
    const documentRoute = bidTypeCode === 5 ? 'showdirectradocumentPdf'
        : bidTypeCode === 2 ? ((firstNumber(doc, ['b_eval_type']) ?? 0) > 0 ? 'list-ra-schedules' : 'showradocumentPdf')
            : 'showbidDocument';

    return {
        source: 'gem',
        keyword,
        tenderId: bidNumber,
        tenderReferenceNumber: bidNumber,
        tenderTitle: category,
        organization: department,
        department,
        ministry,
        category,
        tenderType: gemBidType(bidTypeCode, doc),
        tenderValue: null,
        bidSubmissionStartDate: firstDate(doc, ['final_start_date_sort']),
        bidSubmissionEndDate: firstDate(doc, ['final_end_date_sort']),
        tenderOpenDate: null,
        publishedDate: null,
        closingDate: firstDate(doc, ['final_end_date_sort']),
        bidValidity: null,
        tenderStatus: gemStatus(firstNumber(doc, ['b_buyer_status']), firstNumber(doc, ['b_status'])),
        city: null,
        state: null,
        location: null,
        eligibilityCriteriaSummary: null,
        emdAmount: null,
        tenderDocumentFee: null,
        tenderUrl: bidId ? `${GEM_BASE_URL}/${documentRoute}/${bidId}` : `${GEM_BASE_URL}/all-bids`,
        corrigendumCount: null,
        scrapedAt: new Date().toISOString(),
    };
}

export function gemListingEvidence(record: TenderRecord): GemObservation['evidence'] {
    const evidence: GemObservation['evidence'] = {};
    // The Dataset's listing organization is a department fallback, not independently
    // observed organization evidence. Only a parsed PDF can monitor that field.
    const fields: Array<keyof TenderRecord> = ['tenderTitle', 'tenderReferenceNumber', 'department', 'ministry', 'category', 'tenderType', 'bidSubmissionStartDate', 'bidSubmissionEndDate', 'closingDate', 'tenderStatus', 'tenderUrl'];
    for (const field of fields) if (record[field] !== null) evidence[field] = { source: 'gem_listing', url: `${GEM_BASE_URL}/all-bids` };
    return evidence;
}

export function mergeGemPdfDetails(record: TenderRecord, text: string, evidence?: GemObservation['evidence']): TenderRecord {
    const normalizedText = normalizePdfText(text);
    const openingDate = parseGemDateTime(extractByRegex(normalizedText, /Bid Opening\s+Date\/Time\s+([0-9-]{10}\s+[0-9:]{5,8})/i));
    const publishedDate = parseGemDateTime(extractByRegex(normalizedText, /Dated:\s*([0-9-]{10})/i));
    const bidValidity = extractByRegex(normalizedText, /Bid Offer\s+Validity \(From End Date\)\s+([0-9]+\s*\(Days\))/i);
    const ministryOrState = extractPdfValue(normalizedText, 'Ministry/State Name', ['Department Name'], 1);
    const department = extractPdfValue(normalizedText, 'Department Name', ['Organisation Name'], 1);
    const organization = extractPdfValue(normalizedText, 'Organisation Name', ['Office Name'], 1);
    const pdfCategory = cleanGemCategory(
        extractPdfValue(normalizedText, 'Item Category', [
            'Contract Period',
            'Minimum Average Annual Turnover',
            'Years of Past Experience',
            'MSE Relaxation',
            'Startup Relaxation',
            'Document required',
        ], 2),
    );
    const category = record.category ?? pdfCategory;
    const emdAmount = parseAmount(extractByRegex(normalizedText, /EMD Amount\s*([0-9,]+(?:\.\d+)?)/i));
    const eligibilityCriteriaSummary = buildEligibilitySummary(normalizedText);
    const state = inferIndianState(normalizedText);
    const pdfEndDate = parseGemDateTime(extractByRegex(normalizedText, /Bid End Date\/Time\s+([0-9-]{10}\s+[0-9:]{5,8})/i));
    // Only explicit count labels are count evidence. Generic corrigendum mentions or
    // "Corrigendum No. 2" do not establish the total number of amendments.
    const corrigendumMatch = normalizedText.match(/^(?:Corrigendum Count|Number of Corrigenda)\s*[:=-]?\s*(\d{1,5})\s*$/im);
    const corrigendumCount = corrigendumMatch ? Number(corrigendumMatch[1]) : null;
    if (evidence && record.tenderUrl) {
        const pdfValues: Partial<TenderRecord> = {
            organization, department,
            ministry: ministryOrState && !isIndianState(ministryOrState) ? ministryOrState : null,
            tenderOpenDate: openingDate, publishedDate, bidValidity, state,
            location: state, eligibilityCriteriaSummary, emdAmount, corrigendumCount,
            ...(!record.bidSubmissionEndDate ? { bidSubmissionEndDate: pdfEndDate } : {}),
            ...(!record.category ? { category: pdfCategory, tenderTitle: pdfCategory } : {}),
        };
        for (const [field, value] of Object.entries(pdfValues)) {
            if (value !== null) evidence[field as keyof TenderRecord] = {
                source: 'gem_bid_pdf', url: record.tenderUrl,
                ...(field === 'corrigendumCount' ? { excerpt: corrigendumMatch![0].trim() } : {}),
            } satisfies FieldEvidence;
        }
    }

    return {
        ...record,
        organization: organization ?? record.organization,
        department: department ?? record.department,
        ministry: ministryOrState && !isIndianState(ministryOrState) ? ministryOrState : record.ministry,
        category,
        tenderTitle: record.tenderTitle ?? category,
        bidSubmissionEndDate: record.bidSubmissionEndDate ?? pdfEndDate,
        tenderOpenDate: openingDate ?? record.tenderOpenDate,
        publishedDate: publishedDate ?? record.publishedDate,
        bidValidity: bidValidity ?? record.bidValidity,
        state: state ?? (ministryOrState && isIndianState(ministryOrState) ? titleCase(ministryOrState) : record.state),
        location: state ?? record.location,
        eligibilityCriteriaSummary: eligibilityCriteriaSummary ?? record.eligibilityCriteriaSummary,
        emdAmount: emdAmount ?? record.emdAmount,
        corrigendumCount: corrigendumCount ?? record.corrigendumCount,
    };
}

async function scrapeCpppGuarded(input: NormalizedInput): Promise<TenderRecord[]> {
    log.warning('CPPP extraction is not implemented in this version, even without CAPTCHA. This legacy source selection cannot return CPPP records. Use source: gem for supported extraction. Run-start and applicable platform usage charges can still apply.');

    let html: string;
    try {
        const response = await fetchWithRetries(CPPP_ACTIVE_URL, {
            headers: {
                'user-agent': USER_AGENT,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                referer: 'https://eprocure.gov.in/eprocure/app',
            },
        });
        html = response.body.toString('utf8');
    } catch (error) {
        // CPPP cannot return records in this version anyway, so an unreachable eprocure.gov.in
        // must never fail a run that already collected GeM tenders.
        log.warning(`CPPP listing page was unreachable and was skipped without failing the run: ${errorMessage(error)}`);
        return [];
    }

    if (/captcha/i.test(html)) {
        log.warning(
            'CPPP public tender listing is CAPTCHA-gated. Skipping CPPP without pushing placeholder rows or charging tender-scraped events.',
        );
        return [];
    }

    log.warning(`CPPP page did not expose a supported non-CAPTCHA data table for keywords: ${input.keywords.join(', ')}`);
    return [];
}

async function fetchWithRetries(url: string, init: FetchInitWithDispatcher = {}, options: Parameters<typeof fetchBoundedResource>[2] = {}) {
    return fetchBoundedResource(url, init, options);
}

function baseGemHeaders(): Record<string, string> {
    return {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        referer: `${GEM_BASE_URL}/`,
    };
}

export function extractCsrfToken(html: string): string | null {
    return (
        html.match(/'csrf_bd_gem_nk'\s*:\s*'([^']+)'/)?.[1]
        ?? html.match(/name=["']csrf_bd_gem_nk["'][^>]*value=["']([^"']+)["']/i)?.[1]
        ?? html.match(/value=["']([^"']+)["'][^>]*name=["']csrf_bd_gem_nk["']/i)?.[1]
        ?? html.match(/csrf_bd_gem_nk=([a-f0-9]{32})/i)?.[1]
        ?? html.match(/csrf_bd_gem_nk["']?\s*[:=]\s*["']([a-f0-9]{32})/i)?.[1]
        ?? null
    );
}

function passesClientFilters(record: TenderRecord, input: NormalizedInput): boolean {
    if (input.department) {
        const haystack = `${record.department ?? ''} ${record.ministry ?? ''} ${record.organization ?? ''}`.toLowerCase();
        if (!haystack.includes(input.department.toLowerCase())) return false;
    }

    if (input.state && (!record.state || !record.state.toLowerCase().includes(input.state.toLowerCase()))) return false;
    if (input.minValue !== null && (record.tenderValue === null || record.tenderValue < input.minValue)) return false;
    if (input.maxValue !== null && (record.tenderValue === null || record.tenderValue > input.maxValue)) return false;
    if ((input.dateFrom || input.dateTo) && !isDateInRange(record.publishedDate, input.dateFrom, input.dateTo)) return false;

    return true;
}

function firstString(object: JsonObject, keys: string[]): string | null {
    for (const key of keys) {
        const value = unwrapSolrValue(object[key]);
        if (value === null || value === undefined) continue;
        const stringValue = String(value).replace(/\s+/g, ' ').trim();
        if (stringValue) return stringValue;
    }
    return null;
}

function firstNumber(object: JsonObject, keys: string[]): number | null {
    for (const key of keys) {
        const value = unwrapSolrValue(object[key]);
        if (value === null || value === undefined) continue;
        const cleaned = String(value).replace(/[^\d.+-]/g, '').replace(/^\+/, '');
        const parsed = Number.parseFloat(cleaned.replace(/[^\d.+-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function firstDate(object: JsonObject, keys: string[]): string | null {
    const value = firstString(object, keys);
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unwrapSolrValue(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : value;
}

function gemBidType(code: number | null, doc: JsonObject): string | null {
    if (firstNumber(doc, ['is_rc_bid']) === 1) return 'rate_contract';
    if (firstNumber(doc, ['ba_is_global_tendering']) === 1) return 'global_tender';
    if (code === 2 || code === 5) return 'reverse_auction';
    if (code === 1) return 'bid';
    return code === null ? null : `type_${code}`;
}

function gemStatus(buyerStatus: number | null, rawStatus: number | null): string | null {
    if (buyerStatus === 1) return 'technical_evaluation';
    if (buyerStatus === 2) return 'financial_evaluation';
    if (buyerStatus === 3) return 'bid_awarded';
    if (rawStatus === 1) return 'active';
    return rawStatus === null ? null : `status_${rawStatus}`;
}

function normalizePdfText(text: string): string {
    return text
        .replace(/\u0001/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\r/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractByRegex(text: string, regex: RegExp): string | null {
    const match = text.match(regex);
    return cleanString(match?.[1]?.replace(/\s+/g, ' '));
}

function parseGemDateTime(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseAmount(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseFloat(value.replace(/[^\d.+-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function buildEligibilitySummary(text: string): string | null {
    const turnover = extractEligibilityValue(
        extractByRegex(
            text,
            /Minimum Average Annual Turnover(?:\s+of\s+the\s+bidder)?(?:\s+\(For\s+3\s+Years\))?\s+([0-9][0-9,.\s]*(?:Lakh|Lakhs|Crore|Crores|Thousand|Hundred|Million|Billion|INR|Rs\.?)?(?:\s*\([^)]+\))?)/i,
        ),
    );
    const experience = extractEligibilityValue(
        extractByRegex(
            text,
            /Years of Past Experience Required(?:\s+for\s+same\/similar\s+service)?\s+([0-9][0-9,.\s]*(?:Year|Years|Month|Months|Day|Days)?(?:\s*\([^)]+\))?)/i,
        ),
    );
    const mseRelaxation = extractEligibilityValue(
        extractByRegex(text, /MSE Relaxation for Years Of\s+Experience(?:\s+and\s+Turnover)?\s+(Yes\s*\|\s*Complete|No\s*\|\s*Complete|Yes|No)/i),
    );
    const startupRelaxation = extractEligibilityValue(
        extractByRegex(
            text,
            /Startup Relaxation for Years Of\s+Experience(?:\s+and\s+Turnover)?\s+(Yes\s*\|\s*Complete|No\s*\|\s*Complete|Yes|No)/i,
        ),
    );
    const documents = extractPdfValue(text, 'Document required', ['*In case', 'Bid Number'], 3, ['from seller']);
    const parts = [
        turnover ? `Minimum average annual turnover: ${turnover}` : null,
        experience ? `Past experience required: ${experience}` : null,
        mseRelaxation ? `MSE relaxation: ${mseRelaxation}` : null,
        startupRelaxation ? `Startup relaxation: ${startupRelaxation}` : null,
        documents ? `Documents required: ${documents}` : null,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? parts.join('; ') : null;
}

function extractEligibilityValue(value: string | null): string | null {
    if (!value) return null;
    const cleaned = toReadableEnglish(value)
        .replace(/\s+\|\s+/g, ' | ')
        .replace(/\s+/g, ' ')
        .trim();

    return /[A-Za-z0-9]/.test(cleaned) ? cleaned : null;
}

function cleanGemCategory(value: string | null): string | null {
    if (!value) return null;
    const cleaned = toReadableEnglish(value)
        .replace(/\s+\/?\s*(?:Minimum Average Annual Turnover|Years of Past Experience Required|MSE Relaxation|Startup Relaxation|Document required)\b.*$/i, '')
        .replace(/\s+[*%.&](?:\s+[*%.&/\d])+.*$/u, '')
        .replace(/\s+[\d*.%&/]+\s*$/u, '')
        .replace(/\s+/g, ' ')
        .trim();

    return cleanString(cleaned);
}

function extractPdfValue(
    text: string,
    label: string,
    stopLabels: string[],
    maxLines: number,
    skipFragments: string[] = [],
): string | null {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const labelLower = label.toLowerCase();
    const stopLower = stopLabels.map((item) => item.toLowerCase());
    const skipLower = skipFragments.map((item) => item.toLowerCase());

    for (let index = 0; index < lines.length; index += 1) {
        const line = toReadableEnglish(lines[index]);
        const labelIndex = line.toLowerCase().indexOf(labelLower);
        if (labelIndex === -1) continue;

        const values: string[] = [];
        const trailing = line.slice(labelIndex + label.length).trim();
        if (trailing && !shouldSkipPdfValue(trailing, stopLower, skipLower)) values.push(trailing);

        for (let next = index + 1; next < lines.length && values.length < maxLines; next += 1) {
            const value = toReadableEnglish(lines[next]);
            if (!value) continue;
            if (stopLower.some((stop) => value.toLowerCase().includes(stop))) break;
            if (shouldSkipPdfValue(value, stopLower, skipLower)) continue;
            values.push(value);
        }

        return values.length > 0 ? values.join(' ').replace(/\s+/g, ' ').trim() : null;
    }

    return null;
}

function shouldSkipPdfValue(value: string, stopLabels: string[], skipFragments: string[]): boolean {
    const lower = value.toLowerCase();
    if (/^[-\d\s/]+$/.test(value)) return true;
    if (stopLabels.some((stop) => lower.includes(stop))) return true;
    return skipFragments.some((skip) => lower.includes(skip));
}

function toReadableEnglish(value: string): string {
    return value
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function inferIndianState(text: string): string | null {
    const normalized = text.toLowerCase();
    const matched = INDIAN_STATES.find((state) => normalized.includes(state.toLowerCase()));
    return matched ?? null;
}

function isIndianState(value: string): boolean {
    return INDIAN_STATES.some((state) => state.toLowerCase() === value.trim().toLowerCase());
}

function titleCase(value: string): string {
    return value
        .toLowerCase()
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function cleanString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const cleaned = String(value).trim();
    return cleaned ? cleaned : null;
}

function finiteNumber(value: unknown): number | null {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
    const numberValue = finiteNumber(value);
    return numberValue !== null && numberValue >= 0 ? numberValue : null;
}

function normalizeMaxResults(value: unknown): number {
    const numberValue = Number(value ?? DEFAULT_MAX_RESULTS_PER_KEYWORD);
    if (!Number.isFinite(numberValue)) return 1;
    return Math.max(1, Math.min(MAX_RESULTS_PER_KEYWORD, Math.trunc(numberValue)));
}

function normalizedDate(value: unknown, fieldName: string): string | null {
    const cleaned = cleanString(value);
    if (!cleaned) return null;
    const timestamp = Date.parse(cleaned);
    if (Number.isNaN(timestamp)) {
        throw new Error(`${fieldName} must be a valid date.`);
    }
    return cleaned;
}

function isDateInRange(value: string | null, from: string | null, to: string | null): boolean {
    if (!value) return false;

    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return false;

    if (from) {
        const fromTimestamp = Date.parse(from);
        if (!Number.isNaN(fromTimestamp) && timestamp < fromTimestamp) return false;
    }

    if (to) {
        const toTimestamp = Date.parse(to);
        if (!Number.isNaN(toTimestamp)) {
            const toDate = new Date(toTimestamp);
            toDate.setUTCHours(23, 59, 59, 999);
            if (timestamp > toDate.getTime()) return false;
        }
    }

    return true;
}

async function randomDelay(min = 1000, max = 3000, signal?: AbortSignal): Promise<void> {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await waitForSourceDelay(ms, signal);
}

function errorMessage(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return `${error.message}; cause=${cause.message}`;
    if (cause) return `${error.message}; cause=${String(cause)}`;
    return error.message;
}

type FetchInitWithDispatcher = RequestInit & {
    dispatcher?: ProxyAgent;
};

const INDIAN_STATES = [
    'Andhra Pradesh',
    'Arunachal Pradesh',
    'Assam',
    'Bihar',
    'Chhattisgarh',
    'Goa',
    'Gujarat',
    'Haryana',
    'Himachal Pradesh',
    'Jharkhand',
    'Karnataka',
    'Kerala',
    'Madhya Pradesh',
    'Maharashtra',
    'Manipur',
    'Meghalaya',
    'Mizoram',
    'Nagaland',
    'Odisha',
    'Punjab',
    'Rajasthan',
    'Sikkim',
    'Tamil Nadu',
    'Telangana',
    'Tripura',
    'Uttar Pradesh',
    'Uttarakhand',
    'West Bengal',
    'Andaman and Nicobar Islands',
    'Chandigarh',
    'Dadra and Nagar Haveli and Daman and Diu',
    'Delhi',
    'Jammu and Kashmir',
    'Ladakh',
    'Lakshadweep',
    'Puducherry',
];
