import { createRequire } from 'node:module';
import type pdfParseType from 'pdf-parse';

const require = createRequire(import.meta.url);
// The bundled PDF reader accepts Uint8Array. Its older byte operations can
// misread Node Buffer slices, so give it an independent plain typed array.
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (bytes: Uint8Array) => ReturnType<typeof pdfParseType>;

export async function parseGemPdfText(bytes: Uint8Array): Promise<string> {
    return (await pdfParse(Uint8Array.from(bytes))).text;
}
