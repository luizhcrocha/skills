/**
 * Build the page into the coordinator's template, `skills/productivity/coordinator/assets/dashboard.html`:
 * src/template.html with the CSS, the rules (the `fleet-core` script, `var FleetCore`) and the Solid app
 * inlined, one self-contained file the renderers fill with the state (`/*__STATE__*\/`). The template is
 * committed, since an installed plugin has no build step; `--check` fails when it differs from a fresh build.
 *
 *     bun build.ts [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { transform } from "@solidjs/compiler";
import type { BunPlugin } from "bun";

const HERE = import.meta.dir;

const OUT = join(HERE, "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const PLACEHOLDER = "/*__STATE__*/";

/** Solid's JSX compiled by its own compiler; Bun strips the TypeScript after it. */
const solid: BunPlugin = {
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/u }, async ({ path }) => {
      const { code } = transform(await Bun.file(path).text(), { filename: path, dev: false });

      return { contents: code, loader: "ts" };
    });
  },
};

/** The app reads the rules from the `fleet-core` script instead of carrying a second copy. */
const coreFromScript: BunPlugin = {
  name: "fleet-core",
  setup(build) {
    build.onResolve({ filter: /\/core\.ts$/u }, () => ({ path: "fleet-core", namespace: "fleet-core" }));
    build.onLoad({ filter: /.*/u, namespace: "fleet-core" }, () => ({ contents: "export const Core = globalThis.FleetCore;", loader: "js" }));
  },
};

/** One entry bundled for the browser, minified, as one script's text. */
async function bundle(entry: string, plugins: BunPlugin[]): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(HERE, "src", entry)],
    target: "browser",
    format: "iife",
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins,
  });

  if (!out.success || out.outputs.length !== 1) {
    for (const log of out.logs) console.error(log);
    process.exit(1);
  }

  const text = (await out.outputs[0]?.text())?.trim() ?? "";

  /* Inside a <script> no "</script" may end it early (escaped below, the same string to JavaScript) and no
     "<!--" may start an escaped section. */
  if (text.includes("<!--")) throw new Error(`${entry}: the bundle holds "<!--", which would break its script element`);

  return text.replace(/<\/(script)/giu, "<\\/$1");
}

// SAFETY: solid-js's package.json carries its version as a string.
const version = JSON.parse(readFileSync(join(HERE, "node_modules", "solid-js", "package.json"), "utf8")).version as string;

const core = await bundle("core-global.ts", []);

const app = await bundle("main.tsx", [coreFromScript, solid]);

const css = readFileSync(join(HERE, "src", "page.css"), "utf8").trimEnd();

const page = readFileSync(join(HERE, "src", "template.html"), "utf8")
  .replace("/*CSS*/", () => css)
  .replace("/*SOLID*/", () => `solid-js ${version}`)
  .replace("/*CORE*/", () => core)
  .replace("/*APP*/", () => app);

if (page.split(PLACEHOLDER).length !== 2) throw new Error(`the page must hold ${PLACEHOLDER} exactly once`);

if (process.argv.includes("--check")) {
  const committed = readFileSync(OUT, "utf8");

  if (committed !== page) {
    console.error(`${OUT} differs from a fresh build of fleet/page: run \`just build-page\` and commit it`);
    process.exit(1);
  }

  console.log(`${OUT} matches a fresh build (${page.length} bytes)`);
} else {
  writeFileSync(OUT, page);
  console.log(`wrote ${OUT} (${page.length} bytes: app ${app.length}, core ${core.length}, css ${css.length})`);
}
