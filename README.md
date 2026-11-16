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

Everything lives in one ES module, built around a `Parser` class that is
created fresh for every `parse()` call:

- grammar rules are assembled by a small factory loop from
  `[name, factory]` pairs, so a rule composed from earlier rules names
  them through the partially built set;
- the block lexer dispatches through a `Map` from first character to a
  list of tokenizer methods, tried in the reference order, and merges
  paragraph, text, indented-code and definition tokens the way the
  reference does;
- the inline driver dispatches on the current character, renders straight
  to HTML with no token tree, and consumes plain-text runs with a single
  character-code loop that tracks the cheap stop and the email stop
  together;
- emphasis and strikethrough collect their right delimiters into an
  array and walk it, sharing one masked-source closer scan per run;
  link references live in a `Map` and are gathered in a single pass.

Tables, fenced code, blockquotes, lists (task lists included) and setext
headings all follow the reference behaviour, checked against marked
18.1.3 with the 720-case practice set and a differential fuzzer.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwef5djp&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
