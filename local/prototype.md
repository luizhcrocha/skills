---
description: "Build a throwaway prototype to answer a design question. Use to sanity-check a state model or logic, or explore what a UI should look like."
---

- With no project at all, build one self-contained HTML file (inline CSS and JS; neutral grays, one accent, the system font stack).
- Name each UI variant and its axis (layout, density, personality, motion, interaction); give it real, product-shaped content and hold the `tstack:design-engineering` craft bar.
- The variant picker is emil's, built verbatim: [PICKER.md](../upstream/emilkowalski/skills/prototype/PICKER.md).
- Before handing over, screenshot every variant headless with [round-check.mjs](scripts/round-check.mjs) (`node <path> --out <dir> --page <url>`, one `--page` per variant; it writes `summary.txt`); never write a screenshot script of your own.
- Hand over a table (variant, axis, when it is right, its cost) and let the user pick.
