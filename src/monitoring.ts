import { createHash } from 'node:crypto';
import type { FieldEvidence, GemObservation, GemScanDiagnostics, NormalizedInput, TenderRecord } from './types.js';

export const WATCHLIST_STATE_KEY = 'GEM-WATCHLIST-STATE';
export const CHANGE_SUMMARY_KEY = 'GEM-CHANGES';
export const MAX_WATCHLIST_SCOPES = 10;
export const MAX_BIDS_PER_SCOPE = 500;
export const RETENTION_DAYS = 90;
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_FIELD_LENGTH = 1000;

export const MATERIAL_FIELDS = [
    'tenderReferenceNumber', 'tenderTitle', 'organization', 'department', 'ministry', 'category',
    'tenderType', 'tenderValue', 'bidSubmissionStartDate', 'bidSubmissionEndDate', 'tenderOpenDate',
    'publishedDate', 'closingDate', 'bidValidity', 'tenderStatus', 'city', 'state', 'location',
    'eligibilityCriteriaSummary', 'emdAmount', 'tenderDocumentFee', 'tenderUrl', 'corrigendumCount',
] as const satisfies ReadonlyArray<keyof TenderRecord>;
type MaterialField = typeof MATERIAL_FIELDS[number];
type MaterialValue = string | number;

function isAuctionLinkCorrection(before: MaterialValue, after: MaterialValue, tenderType: MaterialValue | undefined): boolean {
    if (tenderType !== 'reverse_auction' || typeof before !== 'string' || typeof after !== 'string') return false;
    try {
        const a = new URL(before), b = new URL(after);
        if ([a, b].some(url => url.origin !== 'https://bidplus.gem.gov.in' || url.username || url.password || url.search || url.hash)) return false;
        const oldId = a.pathname.match(/^\/showbidDocument\/(\d+)$/)?.[1];
        const newId = b.pathname.match(/^\/(?:showradocumentPdf|showdirectradocumentPdf|list-ra-schedules)\/(\d+)$/)?.[1];
        return oldId !== undefined && oldId === newId;
    } catch { return false; }
}

export interface WatchlistScope {
    source: 'gem';
    keywords: string[];
    department: string | null;
    state: string | null;
    minValue: number | null;
    maxValue: number | null;
    dateFrom: string | null;
    dateTo: string | null;
    status: string;
    maxResults: number;
}

interface BidSnapshot {
    tenderId: string;
    values: Partial<Record<MaterialField, MaterialValue>>;
    evidence: Partial<Record<MaterialField, FieldEvidence>>;
    lastSeenAt: string;
}

interface ScopeState {
    scopeId: string;
    scope: WatchlistScope;
    initializedAt: string;
    lastScanStartedAt: string;
    lastRunId: string;
    revision: number;
    bids: BidSnapshot[];
    lastSummary: ChangeSummary;
}

export interface WatchlistState {
    schemaVersion: 1;
    scopes: ScopeState[];
}

export interface BidChange {
    eventId: string;
    type: 'newly_observed_bid' | 'updated_bid';
    tenderId: string;
    tenderUrl: string | null;
    observedAt: string;
    corrigendumCountChanged: boolean;
    fields: Array<{
        field: MaterialField;
        previous: MaterialValue;
        current: MaterialValue;
        previousEvidence: FieldEvidence;
        evidence: FieldEvidence;
    }>;
}

export interface ChangeSummary {
    schemaVersion: 1;
    watchlistName: string;
    scopeId: string;
    scope: WatchlistScope;
    runId: string;
    scanStartedAt: string;
    generatedAt: string;
    status: 'initialized' | 'compared' | 'incomplete' | 'stale_scan' | 'concurrent_run';
    replayed: boolean;
    baselineCommitted: boolean;
    observedBids: number;
    retainedBids: number;
    unchangedBids: number;
    scan: GemScanDiagnostics;
    changes: BidChange[];
    retention: { days: number; maxBidsPerScope: number; maxScopes: number; evictedBids: number; evictedScopes: number };
}

export interface MonitorScan {
    watchlistName: string;
    input: NormalizedInput;
    observations: GemObservation[];
    diagnostics: GemScanDiagnostics;
    runId: string;
    scanStartedAt: string;
    now: string;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedText = (value: string | null): string | null => value?.replace(/\s+/g, ' ').trim().toLowerCase() || null;

export function buildWatchlistScope(input: NormalizedInput): { scope: WatchlistScope; scopeId: string } {
    const scope: WatchlistScope = {
        source: 'gem',
        keywords: [...new Set(input.keywords.map((keyword) => normalizedText(keyword)!))].sort(),
        department: normalizedText(input.department), state: normalizedText(input.state),
        minValue: input.minValue, maxValue: input.maxValue,
        dateFrom: input.dateFrom ? new Date(input.dateFrom).toISOString() : null,
        dateTo: input.dateTo ? new Date(input.dateTo).toISOString().slice(0, 10) : null,
        status: input.status, maxResults: input.maxResults,
    };
    return { scope, scopeId: hash(scope) };
}

export function createChangeSummary(scan: MonitorScan, status: ChangeSummary['status']): ChangeSummary {
    const { scope, scopeId } = buildWatchlistScope(scan.input);
    return {
        schemaVersion: 1, watchlistName: scan.watchlistName, scopeId, scope,
        runId: scan.runId, scanStartedAt: scan.scanStartedAt, generatedAt: scan.now,
        status, replayed: false, baselineCommitted: false,
        observedBids: new Set(scan.observations.filter((item) => item.record.source === 'gem').map((item) => item.record.tenderId)).size,
        retainedBids: 0, unchangedBids: 0, scan: structuredClone(scan.diagnostics), changes: [],
        retention: { days: RETENTION_DAYS, maxBidsPerScope: MAX_BIDS_PER_SCOPE, maxScopes: MAX_WATCHLIST_SCOPES, evictedBids: 0, evictedScopes: 0 },
    };
}

function materialValue(field: MaterialField, value: unknown): MaterialValue | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    if (field.endsWith('Date')) {
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
    }
    return value.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LENGTH);
}

function validEvidence(value: unknown): value is FieldEvidence {
    if (!value || typeof value !== 'object') return false;
    const evidence = value as FieldEvidence;
    return (evidence.source === 'gem_listing' || evidence.source === 'gem_bid_pdf')
        && typeof evidence.url === 'string' && /^https:\/\/bidplus\.gem\.gov\.in\//.test(evidence.url)
        && evidence.url.length <= 1000
        && (evidence.excerpt === undefined || (typeof evidence.excerpt === 'string' && evidence.excerpt.length <= 200));
}

function snapshot(observation: GemObservation): BidSnapshot {
    const values: BidSnapshot['values'] = {};
    const evidence: BidSnapshot['evidence'] = {};
    for (const field of MATERIAL_FIELDS) {
        const value = materialValue(field, observation.record[field]);
        const source = observation.evidence[field];
        // Unknown or unproven fields are never monitored. A count also needs the exact
        // explicit count label; deadline/status changes alone are not corrigenda.
        if (value === undefined || !validEvidence(source)) continue;
        if (field === 'corrigendumCount' && (!source.excerpt || !/^(?:Corrigendum Count|Number of Corrigenda)\s*[:=-]?\s*\d+$/i.test(source.excerpt))) continue;
        values[field] = value;
        evidence[field] = structuredClone(source);
    }
    return { tenderId: observation.record.tenderId, values, evidence, lastSeenAt: observation.record.scrapedAt };
}

function equalValues(left: MaterialValue, right: MaterialValue): boolean {
    return typeof left === 'string' && typeof right === 'string'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

/** Throws instead of silently replacing corrupt or incompatible saved state. */
export function readWatchlistState(value: unknown): WatchlistState {
    if (value === null || value === undefined) return { schemaVersion: 1, scopes: [] };
    const state = value as WatchlistState;
    const invalid = () => { throw new Error('Saved GeM watchlist state is invalid or has an unsupported schema. Use a new watchlistName or restore its state.'); };
    if (state.schemaVersion !== 1 || !Array.isArray(state.scopes) || state.scopes.length > MAX_WATCHLIST_SCOPES
        || Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) invalid();
    const ids = new Set<string>();
    for (const scope of state.scopes) {
        if (!scope || !/^[a-f0-9]{64}$/.test(scope.scopeId) || ids.has(scope.scopeId)
            || !scope.scope || hash(scope.scope) !== scope.scopeId
            || !Number.isInteger(scope.revision) || scope.revision < 1
            || !validDate(scope.initializedAt) || !validDate(scope.lastScanStartedAt)
            || typeof scope.lastRunId !== 'string' || !scope.lastRunId
            || !Array.isArray(scope.bids) || scope.bids.length > MAX_BIDS_PER_SCOPE
            || !scope.lastSummary || scope.lastSummary.schemaVersion !== 1
            || scope.lastSummary.scopeId !== scope.scopeId || scope.lastSummary.runId !== scope.lastRunId
            || !Array.isArray(scope.lastSummary.changes) || scope.lastSummary.changes.length > 250) invalid();
        ids.add(scope.scopeId);
        const bidIds = new Set<string>();
        for (const bid of scope.bids) {
            if (!bid || typeof bid.tenderId !== 'string' || !bid.tenderId || bid.tenderId.length > 200
                || bidIds.has(bid.tenderId) || !validDate(bid.lastSeenAt) || !bid.values || !bid.evidence) invalid();
            bidIds.add(bid.tenderId);
            for (const [key, fieldValue] of Object.entries(bid.values)) {
                const field = key as MaterialField;
                if (!MATERIAL_FIELDS.includes(field) || materialValue(field, fieldValue) === undefined
                    || (typeof fieldValue === 'string' && fieldValue.length > MAX_FIELD_LENGTH)
                    || !validEvidence(bid.evidence[field])) invalid();
            }
        }
    }
    return structuredClone(state);
}

function validDate(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Pure comparison: callers serialize this read/compute/write with a distributed lock. */
export function compareWatchlist(rawState: unknown, scan: MonitorScan): { state: WatchlistState; summary: ChangeSummary; commit: boolean } {
    const state = readWatchlistState(rawState);
    const summary = createChangeSummary(scan, scan.diagnostics.complete ? 'compared' : 'incomplete');
    const previousScope = state.scopes.find((item) => item.scopeId === summary.scopeId);
    if (previousScope?.lastRunId === scan.runId) {
        return { state, summary: { ...structuredClone(previousScope.lastSummary), replayed: true }, commit: false };
    }
    summary.retainedBids = previousScope?.bids.length ?? 0;
    // A complete scan is the configured result window, not an exhaustive source census.
    if (!scan.diagnostics.complete || scan.diagnostics.keywords.length !== scan.input.keywords.length
        || scan.diagnostics.keywords.some((item) => item.coverage === 'incomplete')
        || scan.observations.some((item) => item.pdfStatus !== 'read')) {
        summary.status = 'incomplete';
        return { state, summary, commit: false };
    }
    if (previousScope && Date.parse(scan.scanStartedAt) <= Date.parse(previousScope.lastScanStartedAt)) {
        summary.status = 'stale_scan';
        return { state, summary, commit: false };
    }

    const previousBids = new Map(previousScope?.bids.map((bid) => [bid.tenderId, bid]) ?? []);
    const observed = new Map<string, BidSnapshot>();
    for (const observation of scan.observations) {
        if (observation.record.source !== 'gem' || !observation.record.tenderId || observation.record.tenderId === 'unknown'
            || observation.record.tenderId.length > 200 || !observation.record.tenderTitle || !validDate(observation.record.scrapedAt)) continue;
        // Duplicated keywords share one identity; take the first observation consistently.
        if (!observed.has(observation.record.tenderId)) observed.set(observation.record.tenderId, snapshot(observation));
    }
    const revision = (previousScope?.revision ?? 0) + 1;
    for (const [id, current] of observed) {
        const previous = previousBids.get(id);
        const fields: BidChange['fields'] = [];
        if (previous) {
            for (const field of MATERIAL_FIELDS) {
                const before = previous.values[field];
                const after = current.values[field];
                if (field === 'tenderUrl' && before !== undefined && after !== undefined
                    && isAuctionLinkCorrection(before, after, current.values.tenderType)) continue;
                if (before !== undefined && after !== undefined && !equalValues(before, after)) fields.push({
                    field, previous: before, current: after,
                    previousEvidence: previous.evidence[field]!, evidence: current.evidence[field]!,
                });
            }
            // Missing/newly available evidence is not proof of a material change.
            current.values = { ...previous.values, ...current.values };
            current.evidence = { ...previous.evidence, ...current.evidence };
        }
        if (previousScope && (!previous || fields.length > 0)) {
            summary.changes.push({
                eventId: hash([summary.scopeId, id, revision, previous ? 'updated_bid' : 'newly_observed_bid', fields]),
                type: previous ? 'updated_bid' : 'newly_observed_bid', tenderId: id,
                tenderUrl: typeof current.values.tenderUrl === 'string' ? current.values.tenderUrl : null,
                observedAt: current.lastSeenAt, fields,
                corrigendumCountChanged: fields.some((field) => field.field === 'corrigendumCount'),
            });
        } else if (previous) summary.unchangedBids += 1;
        previousBids.set(id, current);
    }
    summary.status = previousScope ? 'compared' : 'initialized';
    summary.baselineCommitted = true;
    const cutoff = Date.parse(scan.now) - RETENTION_DAYS * 86400_000;
    const bids = [...previousBids.values()].filter((bid) => Date.parse(bid.lastSeenAt) >= cutoff)
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.tenderId.localeCompare(b.tenderId))
        .slice(0, MAX_BIDS_PER_SCOPE);
    summary.retention.evictedBids = previousBids.size - bids.length;
    summary.retainedBids = bids.length;
    const nextScope: ScopeState = {
        scopeId: summary.scopeId, scope: summary.scope, initializedAt: previousScope?.initializedAt ?? scan.now,
        lastScanStartedAt: scan.scanStartedAt, lastRunId: scan.runId, revision, bids, lastSummary: summary,
    };
    const otherScopes = state.scopes.filter((item) => item.scopeId !== summary.scopeId)
        .sort((a, b) => Date.parse(b.lastScanStartedAt) - Date.parse(a.lastScanStartedAt));
    summary.retention.evictedScopes = Math.max(0, otherScopes.length + 1 - MAX_WATCHLIST_SCOPES);
    state.scopes = [nextScope, ...otherScopes.slice(0, MAX_WATCHLIST_SCOPES - 1)];
    // Keep serialization bounded as well as row counts. Evict least recent scopes first,
    // then least recent bids; never accumulate per-run history or raw PDF text.
    while (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES && state.scopes.length > 1) {
        state.scopes.pop();
        summary.retention.evictedScopes += 1;
    }
    while (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES && nextScope.bids.length > 0) {
        nextScope.bids.pop();
        summary.retention.evictedBids += 1;
    }
    summary.retainedBids = nextScope.bids.length;
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw new Error('GeM change summary exceeds the saved watchlist size limit.');
    return { state, summary, commit: true };
}

export interface WatchlistStorage {
    acquireLock(): Promise<string | null>;
    assertLock(lockId: string): Promise<void>;
    releaseLock(lockId: string): Promise<void>;
    read(): Promise<unknown>;
    write(state: WatchlistState): Promise<void>;
    publish(summary: ChangeSummary): Promise<void>;
}

export async function finalizeWatchlist(storage: WatchlistStorage, scan: MonitorScan): Promise<ChangeSummary> {
    const lockId = await storage.acquireLock();
    if (!lockId) {
        const summary = createChangeSummary(scan, scan.diagnostics.complete ? 'concurrent_run' : 'incomplete');
        await storage.publish(summary);
        return summary;
    }
    try {
        const result = compareWatchlist(await storage.read(), scan);
        if (result.commit) {
            await storage.assertLock(lockId);
            // Publish evidence before advancing its baseline. A state-write failure
            // may repeat an event, but its deterministic ID stays the same. Publishing
            // only after advancing state could otherwise lose an alert permanently.
            await storage.publish({ ...result.summary, baselineCommitted: false });
            await storage.assertLock(lockId);
            // The durable state also includes this run's exact final summary. If its
            // final publication fails, the same run ID recovers that summary.
            await storage.write(result.state);
        }
        await storage.publish(result.summary);
        return result.summary;
    } finally {
        await storage.releaseLock(lockId);
    }
}
