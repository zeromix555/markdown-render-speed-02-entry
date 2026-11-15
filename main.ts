// Harness driver for the markdown-render-speed entry: loads every case
// from /input/cases.json, renders each with parse() from parse.js, and
// writes the HTML array to /output/html.json. Runs as `node /bot/main.ts`
// on Node 22.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawCases = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(rawCases);
const rendered = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
