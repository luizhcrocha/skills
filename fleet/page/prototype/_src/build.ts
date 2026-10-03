// PROTOTYPE build: inlines the real page.css, the ground and each prototype into one self-contained HTML.
// Run from fleet/page/prototype: `bun _src/build.ts`.
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const r = (p: string) => readFileSync(here + p, "utf8");
const pageCss = readFileSync(here + "../../src/page.css", "utf8");
type Proto = { file: string; title: string; question: string; variants: string[] };
const PROTOS: Proto[] = JSON.parse(r("protos.json"));
for (const p of PROTOS.filter((x) => !process.argv[2] || x.file.startsWith(process.argv[2]))) {
  const name = p.file.replace(/\.html$/, "");
  const nav = `<nav class="proto-picker" aria-label="Prototype variants">
  <span class="proto-picker-highlight" aria-hidden="true"></span>
${p.variants.map((v, i) => `  <button class="proto-picker-item"${i === 0 ? ' data-active aria-current="true"' : ""}>${v}</button>`).join("\n")}
  <span class="proto-picker-divider" aria-hidden="true"></span>
  <button class="proto-picker-item proto-picker-replay" aria-label="Replay animation (R)">↻</button>
</nav>`;
  const html = `<!doctype html>
<!--
  PROTOTYPE, throwaway: fleet/page/prototype/${p.file}. Not production code; nothing here is wired to the hub.
  Question: ${p.question}
  ${p.variants.length} variants (${p.variants.join(", ")}), switched with ?v=1..${p.variants.length}, keys 1-${p.variants.length} and the arrows; ?theme=dark|light forces a theme.
  Built by \`bun _src/build.ts\` from _src/ (ground.js, ${name}.js) and the real fleet/page/src/page.css.
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${p.title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231e1b4b'/%3E%3Ccircle cx='32' cy='33' r='10' fill='%23eef2ff'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
${pageCss}
${r("ground.css")}
${r(name + ".css")}
${r("picker.css")}
</style>
</head>
<body>
<div id="stage"></div>
${nav}
<script>
${r("ground.js")}
</script>
<script>
${r(name + ".js")}
</script>
<script>
${r("picker.js")}
</script>
</body>
</html>
`;
  writeFileSync(here + "../" + p.file, html);
  console.log("built", p.file, html.length);
}
