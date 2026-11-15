# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zeromix555/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer. `parse.js` exports
`parse(markdown)`, a drop-in for marked 18.1.3's `marked.parse` under the
default options (GFM on, breaks off, pedantic off, async off): it produces
byte-identical HTML, only faster. `main.ts` is the driver the harness runs —
it reads `/input/cases.json` and writes `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwef5djp&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
