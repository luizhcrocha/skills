/**
 * Free text in the page's text format (`text.ts`): paragraphs, inline code, and code blocks with their
 * language, highlighting, a wrap switch and a copy button. Everything is rendered as text nodes and spans,
 * never as HTML. Blocks are keyed by their content, so a state update that leaves the text as it was, or
 * changes another block, keeps each block's node, its wrap switch and its "Copied".
 */
import { createMemo, createSignal, onCleanup } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { tf } from "./bits.tsx";
import { copyText, selectAndCopy, type Copied } from "./clip.ts";
import type { Part } from "./core.ts";
import { tokensOf } from "./highlight.ts";
import { isFormatted, manualBlocks, parseText, spansOf, type Block } from "./text.ts";

/** How long "Copied" shows. */
const COPIED_MS = 2000;

/** A mention in a message's text: a private-use mark around the part's index, so the format never reads it. */
const MARK = /(\d+)/gu;

/** A mention, as its owner renders it. */
type MentionView = (part: Part) => JSX.Element;

/** A code block: its language, highlighted, a wrap switch (off), and a copy button that copies exactly its text. */
export function CodeBlock(props: { readonly lang: string; readonly text: string }): JSX.Element {
  const [wrap, setWrap] = createSignal(false);
  const [copied, setCopied] = createSignal<Copied | "">("");
  let code: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tokens = createMemo(() => tokensOf(props.text, props.lang));

  onCleanup(() => clearTimeout(timer));

  const copy = (): void => {
    copyText(
      props.text,
      () => selectAndCopy(code ?? null),
      (how) => {
        setCopied(how);
        clearTimeout(timer);
        timer = setTimeout(() => setCopied(""), COPIED_MS);
      },
    );
  };

  return (
    <figure class="code" data-lang={props.lang}>
      <div class="code-head">
        <span class="code-lang">{props.lang}</span>
        <button type="button" class="code-wrap" aria-pressed={tf(wrap())} title="Wrap long lines" onClick={() => setWrap(!wrap())}>
          Wrap
        </button>
        <button type="button" class="code-copy" aria-label={copied() === "copied" ? "Copied" : copied() === "selected" ? "Selected; copy it with your keyboard or menu" : "Copy the code"} onClick={copy}>
          <span aria-hidden="true">{copied() === "copied" ? "Copied" : copied() === "selected" ? "Selected" : "Copy"}</span>
        </button>
      </div>
      <pre class={wrap() ? "code-pre wrap" : "code-pre"} tabindex="0">
        <code ref={(el) => (code = el)}>
          <For each={tokens()} keyed={false}>
            {(t) => (
              <Show when={t().className} fallback={t().value}>
                {(cls) => <span class={"t-" + cls()}>{t().value}</span>}
              </Show>
            )}
          </For>
        </code>
      </pre>
    </figure>
  );
}

/** A piece of a paragraph's words: plain text, or a mention's part. */
interface Piece {
  readonly text: string;
  readonly part?: Part;
}

/** Words of a paragraph, with the mentions marked in them shown by `mention`. */
function Words(props: { readonly text: string; readonly parts: readonly Part[]; readonly mention: MentionView | undefined }): JSX.Element {
  const pieces = (): Piece[] => {
    if (!props.mention) return [{ text: props.text }];
    const out: Piece[] = [];
    let at = 0;

    for (const m of props.text.matchAll(MARK)) {
      const part = props.parts[Number(m[1])];

      if ((m.index ?? 0) > at) out.push({ text: props.text.slice(at, m.index) });

      if (part) out.push({ text: part.text, part });
      at = (m.index ?? 0) + m[0].length;
    }

    if (at < props.text.length) out.push({ text: props.text.slice(at) });

    return out;
  };

  return (
    <For each={pieces()} keyed={false}>
      {(p) => {
        const v = p();

        return v.part && props.mention ? props.mention(v.part) : v.text;
      }}
    </For>
  );
}

/** The text of a run of blocks back in plain words: each mention mark as the part's own text. */
const unmark = (text: string, parts: readonly Part[]): string => text.replace(MARK, (_, i: string) => parts[Number(i)]?.text ?? "");

/** A block's key: its kind, language and text, and where it is, so a block keeps its node while it stays the same. */
const keyOf = (b: Block, i: number): string => (b.kind === "code" ? `c${String(i)}|${b.lang}|${b.text}` : `p${String(i)}|${b.spans.map((s) => s.kind + s.text).join("\u0000")}`);

/** Blocks, rendered. */
function Blocks(props: { readonly blocks: readonly Block[]; readonly parts: readonly Part[]; readonly mention: MentionView | undefined }): JSX.Element {
  const keyed = createMemo(() => props.blocks.map((b, i) => ({ key: keyOf(b, i), b })));

  return (
    <For each={keyed()} keyed={(k) => k.key}>
      {(k) => {
        const b = k().b;

        return b.kind === "code" ? (
          <CodeBlock lang={b.lang} text={unmark(b.text, props.parts)} />
        ) : (
          <p>
            <For each={b.spans} keyed={false}>
              {(s) => (s().kind === "code" ? <code class="ic">{unmark(s().text, props.parts)}</code> : <Words text={s().text} parts={props.parts} mention={props.mention} />)}
            </For>
          </p>
        );
      }}
    </For>
  );
}

/**
 * Free text in the page's format, in a `<div class={cls}>`. Text that uses no backtick is one paragraph,
 * exactly as before. A message's `parts` put its mentions back where they were, shown by `mention`.
 */
export function Rich(props: { readonly text: string; readonly class?: string; readonly parts?: readonly Part[]; readonly mention?: MentionView }): JSX.Element {
  const parts = (): readonly Part[] => props.parts ?? [];

  /* A message's words with each mention as a mark the format reads as plain text. */
  const source = createMemo((): string => (props.parts && props.mention ? props.parts.map((p, i) => (p.mention ? `${String(i)}` : p.text.replace(/[]/gu, ""))).join("") : props.text));

  const blocks = createMemo((): Block[] => {
    const s = source();

    return isFormatted(s) ? parseText(s) : [{ kind: "para", spans: spansOf(s) }];
  });

  return (
    <div class={"rich" + (props.class ? " " + props.class : "")}>
      <Blocks blocks={blocks()} parts={parts()} mention={props.mention} />
    </div>
  );
}

/** A `--manual`: in the format when it uses it, one `sh` block when it is a lone command, else as it always was. */
export function ManualText(props: { readonly text: string }): JSX.Element {
  const blocks = createMemo(() => manualBlocks(props.text));

  return (
    <Show when={blocks()} fallback={<pre class="manual">{props.text}</pre>}>
      {(b) => (
        <div class="rich manual-rich">
          <Blocks blocks={b()} parts={[]} mention={undefined} />
        </div>
      )}
    </Show>
  );
}
