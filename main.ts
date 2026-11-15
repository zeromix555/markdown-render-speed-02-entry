// Driver the harness executes: read every case from the input directory,
// render each markdown string with parse() from parse.js, and write the
// resulting HTML array to the output directory as html.json.
// Invoked as `node /bot/main.ts` under Node 22 (type-stripping only).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);
const html = cases.map((entry) => parse(entry.markdown));

// Create the output directory first: the harness may hand us a fresh path.
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
