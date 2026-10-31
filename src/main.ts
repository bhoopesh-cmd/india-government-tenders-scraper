import { Actor, log } from 'apify';
import { createGemScanDiagnostics, scrapeTenders, isChargeableTender, normalizeInput } from './routes.js';
import { ActorInput, GemObservation, TenderRecord } from './types.js';
import { wasPushedRecordSaved } from './billing.js';
import { finalizeWatchlist } from './monitoring.js';
import { openWatchlistStorage } from './monitoring-storage.js';
import { randomUUID } from 'node:crypto';
import { createSourceBudget } from './run-budget.js';
import { createRunReport } from './run-report.js';

await Actor.init();

try {
    const input = ((await Actor.getInput()) ?? {}) as ActorInput;
    const normalizedInput = normalizeInput(input);
    const scanStartedAt = new Date().toISOString();
    const runId = Actor.getEnv().actorRunId ?? randomUUID();
    const budget = createSourceBudget(Actor.getEnv().timeoutAt, normalizedInput.watchlistName ? 60_000 : 20_000);
    const diagnostics = createGemScanDiagnostics();
    const observations: GemObservation[] = [];
    let watchlistStorage: Awaited<ReturnType<typeof openWatchlistStorage>> | null = null;

    log.info(
        `Starting tender scrape: source=${normalizedInput.source}, keywords=${normalizedInput.keywords.join(', ')}, maxResults=${normalizedInput.maxResults}, PDF details=${normalizedInput.includePdfDetails}`,
    );

    let pushed = 0;
    let stoppedByChargeLimit = false;
    let sourceError: unknown;

    try {
        watchlistStorage = normalizedInput.watchlistName ? await openWatchlistStorage(normalizedInput.watchlistName) : null;
        await scrapeTenders(input, async (record, observation) => {
            if (!isChargeableTender(record)) return true;

            const result = await pushAndCharge(record);
            if (result.saved) {
                pushed += 1;
                if (watchlistStorage && observation) observations.push(observation);
            }
            if (result.stopped) {
                stoppedByChargeLimit = true;
                await Actor.setStatusMessage(`Stopped at the user's spending limit after ${pushed} tenders`);
                log.warning('User spending limit reached. Stopping before any more tender requests or enrichment work.');
                return false;
            }
            return true;
        }, { diagnostics, signal: budget.signal });
    } catch (error) {
        diagnostics.complete = false;
        if (budget.signal.aborted && error === budget.signal.reason) {
            const keyword = diagnostics.keywords.at(-1)?.keyword ?? normalizedInput.keywords[0];
            if (!diagnostics.issues.some(item => item.keyword === keyword && item.reason === 'time_limit')) {
                diagnostics.issues.push({ keyword, reason: 'time_limit' });
            }
        } else sourceError = error ?? new Error('Source collection failed without an error message.');
    } finally {
        budget.dispose();
    }
    const report = createRunReport(normalizedInput, diagnostics, pushed, stoppedByChargeLimit, sourceError);
    await Actor.setValue('OUTPUT', report);
    if (watchlistStorage && normalizedInput.watchlistName) {
        const summary = await finalizeWatchlist(watchlistStorage, {
            watchlistName: normalizedInput.watchlistName, input: normalizedInput, observations, diagnostics,
            runId, scanStartedAt, now: new Date().toISOString(),
        });
        log.info(`GeM watchlist ${summary.status}: ${summary.changes.length} changes; baseline committed=${summary.baselineCommitted}. Summary: GEM-CHANGES.`);
    }
    if (sourceError !== undefined) throw sourceError;

    if (!report.complete && !stoppedByChargeLimit) {
        await Actor.setStatusMessage(`Incomplete scrape: ${pushed} tenders saved. See OUTPUT for coverage and the stopping reason.`);
        log.warning(`Incomplete scrape: ${pushed} tender records preserved. No complete result window is claimed. See OUTPUT.`);
    }

    if (pushed === 0 && !stoppedByChargeLimit) {
        log.warning('No clean tender records were pushed. No tender-scraped events were charged.');
    } else {
        if (!stoppedByChargeLimit && report.complete) {
            await Actor.setStatusMessage(`Finished with ${pushed} tender records`);
        }
        log.info(`Saved ${pushed} tender records${stoppedByChargeLimit ? ' before reaching the user spending limit' : ''}.`);
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Actor failed: ${message}`);
    await Actor.fail(`Actor failed: ${message}`);
}

await Actor.exit();

async function pushAndCharge(record: TenderRecord): Promise<{ saved: boolean; stopped: boolean }> {
    const chargeResult = await Actor.pushData(record, 'tender-scraped');
    return {
        saved: wasPushedRecordSaved(chargeResult),
        stopped: chargeResult.eventChargeLimitReached === true,
    };
}
