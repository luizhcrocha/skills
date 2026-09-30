import { RuleTester } from "oxlint/plugins-dev";

import { noSpyOnRule } from "./no-spy-on.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "spyOn" };

// The invalid cases are the calls found in custom-mcp-servers'
// servers/case-analysis tests (2026-09-30): twelve spies silencing console,
// one patching JSON.stringify.
tester.run("tstack/no-spy-on", noSpyOnRule, {
  valid: [
    // The fixes: a recording fake through a seam, Vitest's own quiet mode.
    "const logger = recordingLogger(); runRecord({ logger }); expect(logger.warnings).toHaveLength(1);",
    "export default defineConfig({ test: { silent: 'passed-only' } });",
    "const handler = vi.fn();",
    "vi.mock('./user-store');",
    "const vi = { spyOn() {} }; vi.spyOn(console, 'warn');",
    "function test(jest: { spyOn(): void }) { jest.spyOn(); }",
    "import { vi as localVi } from './helpers'; localVi.spyOn(console, 'warn');",
    "sinon.spyOn(console, 'warn');",
  ],
  invalid: [
    {
      code: 'const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);',
      errors: [error],
    },
    {
      code: [
        'const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);',
        'const error = vi.spyOn(console, "error").mockImplementation(() => undefined);',
        'const log = vi.spyOn(console, "log").mockImplementation(() => undefined);',
      ].join("\n"),
      errors: [error, error, error],
    },
    {
      code: 'vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => { throw new Error("boom"); });',
      errors: [error],
    },
    { code: "import { vi } from 'vitest'; vi.spyOn(console, 'warn');", errors: [error] },
    { code: "import { vi as testApi } from 'vitest'; testApi.spyOn(store, 'save');", errors: [error] },
    { code: "jest.spyOn(store, 'save');", errors: [error] },
    { code: "import { jest } from '@jest/globals'; jest.spyOn(store, 'save');", errors: [error] },
    { code: "vi['spyOn'](console, 'warn');", errors: [error] },
  ],
});
