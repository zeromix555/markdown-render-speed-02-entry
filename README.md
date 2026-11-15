# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch.
`parse.js` exports `parse(markdown)`, which renders exactly the HTML that
marked 18.1.3 produces under its default options (GFM on, breaks off,
pedantic off, async off) — byte for byte on the 720-case practice set —
while running noticeably faster than marked itself. `main.ts` is the small
driver the harness runs: it reads `/input/cases.json` and writes the
rendered pages to `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## How it works

The renderer is organised as a block lexer, an inline scanner and a
renderer, all in one dependency-free ES module:

- the block lexer walks the input once, dispatching on the first
  non-space character of each line and trying only the rules that can
  match there, in the reference order;
- the inline scanner renders straight to HTML without building a token
  tree, consuming plain-text runs with a single character loop;
- emphasis and strikethrough share one closer scan per inline run, and
  link reference definitions are collected in a single pass.
- tables, fenced code, blockquotes, lists (including task lists) and
  setext headings all follow the same reference behaviour, verified
  against marked 18.1.3 with a differential fuzzer as well as the
  practice set.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwef5djp&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
