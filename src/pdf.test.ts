import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGemPdfText } from './pdf.js';

test('a real small bid PDF parses from a pooled Buffer without corrupting source bytes', async () => {
    const fixture = readFileSync(new URL('../test/fixtures/synthetic-tender.pdf', import.meta.url));
    const pooled = Buffer.allocUnsafe(fixture.length + 73);
    fixture.copy(pooled, 73);
    const bytes = pooled.subarray(73);
    const original = Buffer.from(bytes);
    for (let repeat = 0; repeat < 2; repeat += 1) {
        const text = await parseGemPdfText(bytes);
        assert.match(text, /Synthetic procurement fixture/);
        assert.match(text, /Bid Opening Date\/Time 31-10-2026 10:00:00/);
        assert.deepEqual(bytes, original);
    }
});

test('invalid PDF bytes cannot become successful parsed bid details', async () => {
    await assert.rejects(parseGemPdfText(Buffer.from('%PDF-1.7\ninvalid fixture')));
});
