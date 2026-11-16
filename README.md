# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A Markdown renderer written from scratch, with zero dependencies. The
single export of `parse.js`, `parse(markdown)`, produces byte-identical
HTML to marked 18.1.3 under its defaults (GFM on, breaks off, pedantic
off, async off) on every one of the 720 practice-set cases — while
running roughly 1.2× faster than marked on the same machine. The
`main.ts` driver reads `/input/cases.json` and writes the rendered HTML
to `/output/html.json`.

## Running it

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## Inside the renderer

One ES module holds the whole thing. Each `parse()` call builds a fresh
plain context object and threads it through module-level functions:

- grammar rules go into the `BLK` / `INL` tables one assignment at a
  time, so a rule built from earlier rules refers to them via the table;
- block lexing dispatches through a route table from first character to
  tokenizer functions, in reference order, merging paragraph, text,
  indented-code and definition tokens the way the reference does;
- tokens are positional arrays such as `['heading', raw, depth, text]`,
  and block rendering is an if/else chain pushing HTML into an array;
- inline handling is looked up by character, renders directly to HTML
  without a token tree, and eats plain-text runs with two while-loop
  passes — a cheap stop and an email-local stop — taking the smaller;
- emphasis and strikethrough drive their right-delimiter regex with a
  plain exec loop, sharing one masked-source closer scan per run, and
  link references sit in a `Map` collected in a single pass.

Tables, fenced code, blockquotes, lists with task items, and setext
headings all match the reference, verified against marked 18.1.3 on the
720-case practice set plus a differential fuzzer.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwef5djp&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
