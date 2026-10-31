export class SourceTimeLimitError extends Error {
    constructor() { super('The run is near its selected timeout; stopping source work to preserve partial results.'); this.name = 'SourceTimeLimitError'; }
}

export function createSourceBudget(timeoutAt: Date | null, reserveMs = 20_000) {
    const controller = new AbortController();
    const milliseconds = timeoutAt ? timeoutAt.getTime() - Date.now() - reserveMs : Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (Number.isFinite(milliseconds)) {
        if (milliseconds <= 0) controller.abort(new SourceTimeLimitError());
        else timer = setTimeout(() => controller.abort(new SourceTimeLimitError()), milliseconds);
    }
    return { signal: controller.signal, dispose() { if (timer) clearTimeout(timer); } };
}
