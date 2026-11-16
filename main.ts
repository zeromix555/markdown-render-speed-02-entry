// Driver for the harness: read the cases, render each markdown string,
// and write the HTML array out. Node 22, type-stripping only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as renderMarkdown } from './parse.js';

const srcDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const dstDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(fs.readFileSync(path.join(srcDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => renderMarkdown(c.markdown));
fs.mkdirSync(dstDir, { recursive: true });
fs.writeFileSync(path.join(dstDir, 'html.json'), JSON.stringify(html));
