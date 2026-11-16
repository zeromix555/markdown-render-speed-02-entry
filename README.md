# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch Markdown renderer with no dependencies. `parse.js` exports
a single function, `parse(markdown)`, whose output matches marked 18.1.3
under its default options (GFM on, breaks off, pedantic off, async off)
byte for byte on all 720 cases of the practice set — and runs about 1.2×
faster than marked on the same machine. `main.ts` is the harness driver:
it reads the cases from `/input/cases.json` and writes the rendered HTML
to `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## How it works

Everything lives in one ES module. A fresh plain context object is built
for every `parse()` call and threaded through module-level functions:

- grammar rules are assigned one by one into the `BLK` / `INL` tables,
  so a rule composed from earlier rules names them through the table;
- the block lexer dispatches through a route table of first characters
  to tokenizer functions, tried in the reference order, and merges
  paragraph, text, indented-code and definition tokens the way the
  reference does;
- tokens are positional arrays (`['heading', raw, depth, text]`), not
  objects, and rendering is an if/else chain that pushes HTML strings
  into an output array;
- the inline driver looks its handler up by character, renders straight
  to HTML with no token tree, and consumes plain-text runs with two
  while-loop passes — a cheap stop and an email-local stop — taking the
  smaller of the two;
- emphasis and strikethrough walk their right-delimiter regex directly
  with an exec loop, sharing one masked-source closer scan per run;
  link references live in a `Map` and are gathered in a single pass.

Tables, fenced code, blockquotes, lists (task lists included) and setext
headings all follow the reference behaviour, checked against marked
18.1.3 with the 720-case practice set and a differential fuzzer.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwef5djp&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
