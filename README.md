# sitegen-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/derekgufoundry-hub/sitegen-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/derekgufoundry-hub/sitegen-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free reimplementation of makefun-site 1.0.0: it builds the same static sites, byte for byte, at a fraction of the CPU time. No dependencies and no imports at all — just Node 22.

Speed comes from the hot paths only: a fused Markdown lexer+renderer, a single-pass inline scanner that escapes literal runs in bulk, an ASCII fast path plus a cache for slugs, index-based front-matter scanning, and a template renderer that appends to an array instead of concatenating strings. The pipeline, the report lines and every error message follow the reference exactly.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts
```

`main.ts` reads `<input-dir>/cases.json` (a JSON array of `{id, input}`), answers each case with `run()` from `solve.js`, and writes `<output-dir>/answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gqbre2d4&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
