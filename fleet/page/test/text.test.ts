/**
 * The page's text format (`src/text.ts`) and its highlighting (`src/highlight.ts`, `src/langs.ts`):
 * paragraphs, inline code, fences with and without a language, the rule for an old `--manual`, text that
 * looks like HTML staying text, and nushell's tokens.
 */
import { expect, test } from "bun:test";

import { tokensOf } from "../src/highlight.ts";
import { looksLikeCommand, manualBlocks, parseText, spansOf } from "../src/text.ts";
import { A22_MANUAL, LEGACY_MANUAL, MODAL_MANUAL } from "./fixtures.ts";

test("paragraphs split on a blank line; a single line break stays in its paragraph", () => {
  expect(parseText("one\ntwo\n\n\nthree")).toEqual([
    { kind: "para", spans: [{ kind: "text", text: "one\ntwo" }] },
    { kind: "para", spans: [{ kind: "text", text: "three" }] },
  ]);
});

test("inline code is a run of backticks closed by a run as long; an unclosed run is text", () => {
  expect(spansOf("run `ls -la` now")).toEqual([
    { kind: "text", text: "run " },
    { kind: "code", text: "ls -la" },
    { kind: "text", text: " now" },
  ]);
  expect(spansOf("``a ` b`` c")).toEqual([
    { kind: "code", text: "a ` b" },
    { kind: "text", text: " c" },
  ]);
  expect(spansOf("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
});

test("a fence with a language, and one without; an unclosed fence runs to the end", () => {
  expect(parseText("Run:\n\n```NU\nls | length\n```\nthen\n```\nplain <b>\n```")).toEqual([
    { kind: "para", spans: [{ kind: "text", text: "Run:" }] },
    { kind: "code", lang: "nu", text: "ls | length" },
    { kind: "para", spans: [{ kind: "text", text: "then" }] },
    { kind: "code", lang: "", text: "plain <b>" },
  ]);
  expect(parseText("````sh\necho ```\n````")).toEqual([{ kind: "code", lang: "sh", text: "echo ```" }]);
  expect(parseText("```py\nprint(1)")).toEqual([{ kind: "code", lang: "py", text: "print(1)" }]);
});

test("Luiz's Modal example: prose, the command alone in a nu block, prose with inline code", () => {
  expect(manualBlocks(MODAL_MANUAL)).toEqual([
    { kind: "para", spans: [{ kind: "text", text: "From the repo's devenv shell (modal is on its PATH), in nushell:" }] },
    { kind: "code", lang: "nu", text: "with-env {…} { modal volume delete -y cr-lab-hf-cache; modal volume list }" },
    {
      kind: "para",
      spans: [
        { kind: "text", text: "The list afterwards should not show " },
        { kind: "code", text: "cr-lab-hf-cache" },
        { kind: "text", text: "." },
      ],
    },
  ]);
});

test("an old --manual: one line and no sentence is one nu block; anything else stays as it was", () => {
  expect(manualBlocks(LEGACY_MANUAL)).toEqual([{ kind: "code", lang: "nu", text: LEGACY_MANUAL }]);
  expect(manualBlocks("  op item create --vault Employee ...  ")).toEqual([{ kind: "code", lang: "nu", text: "op item create --vault Employee ..." }]);
  expect(manualBlocks("Open the Stripe dashboard and roll the secret.")).toBeNull();
  expect(manualBlocks("Restart the server")).toBeNull();
  expect(manualBlocks("Then run this:")).toBeNull();
  expect(looksLikeCommand("")).toBe(false);
});

test("an unfenced --manual of command lines only (A22) is one nu block; prose among them keeps it as it was", () => {
  expect(manualBlocks(A22_MANUAL)).toEqual([{ kind: "code", lang: "nu", text: A22_MANUAL }]);
  expect(manualBlocks("\n  cd x\n\nmake  \n")).toEqual([{ kind: "code", lang: "nu", text: "cd x\n\nmake" }]);
  expect(manualBlocks("Run these from the repo:\ncd x\nmake")).toBeNull();
  expect(manualBlocks("cd x\nThen check the log.")).toBeNull();
});

test("text that looks like HTML stays text: the parser returns strings, never markup", () => {
  const html = "<script>alert(1)</script> <img src=x onerror=alert(1)> `<b>`";
  expect(parseText(html)).toEqual([
    {
      kind: "para",
      spans: [
        { kind: "text", text: "<script>alert(1)</script> <img src=x onerror=alert(1)> " },
        { kind: "code", text: "<b>" },
      ],
    },
  ]);
  expect(tokensOf("<b>x</b>", "nu").map((t) => t.value).join("")).toBe("<b>x</b>");
});

/** The tokens of `code` in `lang` that carry a class, as "class:text". */
const classed = (code: string, lang: string): string[] => tokensOf(code, lang).flatMap((t) => (t.className ? [`${t.className}:${t.value}`] : []));

test("nu: a variable, a flag, a string, interpolation, a closure, a record, a comment", () => {
  const got = classed(`let who = $"hi (whoami | str trim)" # greet\nls --all | each {|f| {name: $f.name, size: 1kb} }`, "nu");

  expect(got).toContain("keyword:let");
  expect(got).toContain('string:$"hi ');
  expect(got).toContain("command:whoami");
  expect(got).toContain('string:"');
  expect(got).toContain("comment:# greet");
  expect(got).toContain("command:ls");
  expect(got).toContain("attr:--all");
  expect(got).toContain("variable:f");
  expect(got).toContain("property:name");
  expect(got).toContain("variable:$f");
  expect(got).toContain("property:.name");
  expect(got).toContain("number:1kb");
  expect(classed("'raw' \"esc\\\"aped\"", "nu")).toEqual(["string:'raw'", 'string:"esc\\"aped"']);
});

test("nu: the Modal command reads as two commands with a flag, in a closure-like block", () => {
  expect(classed("with-env {…} { modal volume delete -y cr-lab-hf-cache; modal volume list }", "nushell")).toEqual([
    "command:with-env",
    "operator:{",
    "operator:}",
    "operator:{",
    "command:modal",
    "attr:-y",
    "operator:;",
    "command:modal",
    "operator:}",
  ]);
});

test("the fleet's other languages are highlighted, and an unknown one is plain", () => {
  expect(classed("echo $HOME # c", "bash")).toEqual(["command:echo", "variable:$HOME", "comment:# c"]);
  expect(classed('{"a": 1}', "json").length).toBeGreaterThan(0);
  expect(classed("let x: number = 1;", "typescript")).toContain("keyword:let");
  expect(classed('a = "b"', "toml")).toContain('string:"b"');
  expect(classed("def f(): pass", "python")).toContain("keyword:def");
  expect(classed("SELECT 1 FROM t", "sql").length).toBeGreaterThan(0);
  expect(classed("+add\n-del", "diff")).toEqual(["inserted:+add", "deleted:-del"]);
  expect(classed("k: v # c", "yaml")).toContain("comment:# c");
  expect(classed('fn main() { println!("x"); } // c', "rust")).toEqual(["keyword:fn", "function:main", "function:println!", 'string:"x"', "comment:// c"]);
  expect(classed('{ x = "a${b}c"; } # c', "nix")).toEqual(["property:x", "operator:=", 'string:"a${', "string:}c\"", "operator:;", "comment:# c"]);
  expect(tokensOf("anything", "cobol")).toEqual([{ value: "anything" }]);
  expect(tokensOf("anything", "")).toEqual([{ value: "anything" }]);
});
