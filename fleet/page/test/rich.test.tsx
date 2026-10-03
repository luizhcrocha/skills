/**
 * Rich text changed in place, in happy-dom: a message whose words become inline code and back, and a mention
 * that becomes plain words and back, read from the DOM after each change. A part's place is reused as the text
 * changes, so what each part is drawn as (code, words, a mention) must follow the text, not the first one.
 */
import { afterEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";

import type { Part } from "../src/core.ts";
import { Rich } from "../src/Rich.tsx";

let dispose: (() => void) | undefined;

let root: HTMLElement;

afterEach(() => {
  dispose?.();
  root.remove();
});

/** The paragraph's children as the eye reads them: `code` for inline code, `@x` for a mention, the words as they are. */
const seen = (): string[] =>
  [...(root.querySelector(".rich p")?.childNodes ?? [])].flatMap((n) => {
    const t = n.textContent ?? "";

    return t === "" ? [] : [n.nodeName === "CODE" ? "`" + t + "`" : n.nodeName === "B" ? "@" + t : t];
  });

test("a part that becomes inline code, and back, is drawn as code, then as words", () => {
  const [text, setText] = createSignal("run the tests now");
  root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <Rich text={text()} />, root);
  flush();
  expect(seen()).toEqual(["run the tests now"]);

  setText("run `the tests` now");
  flush();
  expect(seen()).toEqual(["run ", "`the tests`", " now"]);

  setText("run the `tests` now");
  flush();
  expect(seen()).toEqual(["run the ", "`tests`", " now"]);

  setText("`run` the tests now");
  flush();
  expect(seen()).toEqual(["`run`", " the tests now"]);

  setText("run the tests now");
  flush();
  expect(seen()).toEqual(["run the tests now"]);
});

test("a mention that becomes plain words, and back, is drawn as its owner draws it, then as words", () => {
  const [parts, setParts] = createSignal<readonly Part[]>([{ text: "@invoice-gen", mention: "a2" }, { text: " keep the totals in cents" }]);
  root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <Rich text="" parts={parts()} mention={(p) => <b>{p.text.slice(1)}</b>} />, root);
  flush();
  expect(seen()).toEqual(["@invoice-gen", " keep the totals in cents"]);

  setParts([{ text: "invoice-gen" }, { text: " keep the totals in " }, { text: "@docs-pass", mention: "a5" }]);
  flush();
  expect(seen()).toEqual(["invoice-gen keep the totals in ", "@docs-pass"]);

  setParts([{ text: "@invoice-gen", mention: "a2" }, { text: " keep the totals in cents" }]);
  flush();
  expect(seen()).toEqual(["@invoice-gen", " keep the totals in cents"]);
});
