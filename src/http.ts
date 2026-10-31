import { fetch as undiciFetch } from 'undici';

/** Bound both connection time and body download time; never retry a rejected request. */
export class SourceHttpError extends Error {
    constructor(readonly status: number, url: string) {
        const endpoint = new URL(url);
        super(`HTTP ${status} from ${endpoint.origin}${endpoint.pathname}`);
        this.name = 'SourceHttpError';
    }
}

export class SourceBodyLimitError extends Error {
    constructor() { super('Source response exceeded the download size limit.'); this.name = 'SourceBodyLimitError'; }
}

export function canRetrySource(error: unknown): boolean {
    return !(error instanceof SourceBodyLimitError)
        && !(error instanceof SourceHttpError && error.status < 500 && error.status !== 408);
}

export async function waitForSourceDelay(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() { signal?.removeEventListener('abort', aborted); resolve(); }
        function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason); }
        signal?.addEventListener('abort', aborted, { once: true });
    });
}

type ResourceOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    attempts?: number;
    maxBytes?: number;
    fetcher?: typeof fetch;
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export async function fetchBoundedResource(url: string, init: RequestInit, options: ResourceOptions = {}): Promise<{ body: Buffer; headers: Headers }> {
    const { signal, timeoutMs = 35_000, attempts = 3, maxBytes = 4 * 1024 * 1024, fetcher = undiciFetch as unknown as typeof fetch, delay = waitForSourceDelay } = options;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const abortParent = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abortParent, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('Source request exceeded its connection/body deadline.')), timeoutMs);
        let removeAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            const rejectAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
        });
        const consume = async () => {
            const response = await fetcher(url, { ...init, signal: controller.signal });
            if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
            controller.signal.throwIfAborted();
            if (!response.ok) {
                // Do not download an error page, retain cookies, or try to evade a denial.
                void response.body?.cancel().catch(() => {});
                throw new SourceHttpError(response.status, url);
            }
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > maxBytes) {
                void response.body?.cancel().catch(() => {});
                throw new SourceBodyLimitError();
            }
            if (!response.body) return { body: Buffer.alloc(0), headers: response.headers };
            reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let received = 0;
            while (true) {
                const { value, done } = await reader.read();
                controller.signal.throwIfAborted();
                if (done) break;
                received += value.byteLength;
                if (received > maxBytes) throw new SourceBodyLimitError();
                chunks.push(Buffer.from(value));
            }
            return { body: Buffer.concat(chunks, received), headers: response.headers };
        };
        try {
            return await Promise.race([consume(), aborted]);
        } catch (error) {
            lastError = error;
            if (signal?.aborted) throw signal.reason;
            if (!canRetrySource(error) || attempt === attempts) throw error;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortParent);
            removeAbort?.();
            controller.abort();
            // Cancellation is best effort. A broken stream must not block the deadline.
            if (reader) void reader.cancel().catch(() => {});
        }
        await delay(1000 * attempt, signal);
    }
    throw lastError;
}

export function isPdfBody(bytes: Uint8Array): boolean {
    return bytes.byteLength > 5 && Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'));
}
