/**
 * Free text in the page's text format (`text.ts`): paragraphs, inline code, and code blocks with their
 * language, highlighting, a wrap switch and a copy button. Everything is rendered as text nodes and spans,
 * never as HTML. Blocks are keyed by their content, so a state update that leaves the text as it was, or
 * changes another block, keeps each block's node, its wrap switch and its "Copied". Inside a block the parts
 * are drawn by place (keyed={false}), the callback run once per place, so what a part is drawn as (code,
 * words, a mention) is read reactively, never decided once by a ternary.
 */
import { createMemo, createSignal, onCleanup } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { tf } from "./bits.tsx";
import { copyText, selectAndCopy, type Copied } from "./clip.ts";
import type { Part } from "./core.ts";
import { ItemRef, pieceOf, useRefs, type RefPiece } from "./DecisionRef.tsx";
import { tokensOf } from "./highlight.ts";
import { isFormatted, manualBlocks, parseText, spansOf, type Block } from "./text.ts";

/** How long "Copied" shows. */
const COPIED_MS = 2000;

/** A mention in a message's text: a private-use mark around the part's index, so the format never reads it. */
const MARK = /(\d+)/gu;

/** A mention, as its owner renders it. */
type MentionView = (part: Part) => JSX.Element;

/** A code block: its language, highlighted, a wrap switch (off), and a copy button that copies exactly its text. */
export function CodeBlock(props: { readonly lang: string; readonly text: string; readonly wrap?: boolean }): JSX.Element {
  const [wrap, setWrap] = createSignal(props.wrap === true);
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

/** A piece of a paragraph's words: plain text, a mention's part, or a reference to a row of a ledger. */
interface Piece {
  readonly text: string;
  readonly part?: Part;
  readonly ref?: RefPiece | undefined;
}

/** Whether words link the references in them (refs.ts), and how they are read: "every" in a decision's own words, where every number is a link (DecisionRef.tsx). */
export type RefsMode = boolean | "every";

/** Words of a paragraph, with the mentions marked in them shown by `mention`; with `refs`, each reference in them (refs.ts) a link, in the words of `fleet`. */
function Words(props: { readonly text: string; readonly parts: readonly Part[]; readonly mention: MentionView | undefined; readonly refs: RefsMode; readonly fleet: string | null | undefined }): JSX.Element {
  /* Words that link nothing need no page around them (a code block's caption, a test's). */
  const read = props.refs ? useRefs() : null;

  /* Plain words, with each reference split out when the words link them. */
  const plain = (text: string): Piece[] => {
    if (!read) return [{ text }];
    const drawn = read(text, props.fleet, props.refs === "every");

    return drawn.runs.map((r): Piece => ({ text: r.text, ref: pieceOf(r, drawn) }));
  };

  const pieces = (): Piece[] => {
    if (!props.mention) return plain(props.text);
    const out: Piece[] = [];
    let at = 0;

    for (const m of props.text.matchAll(MARK)) {
      const part = props.parts[Number(m[1])];

      if ((m.index ?? 0) > at) out.push(...plain(props.text.slice(at, m.index)));

      if (part) out.push({ text: part.text, part });
      at = (m.index ?? 0) + m[0].length;
    }

    if (at < props.text.length) out.push(...plain(props.text.slice(at)));

    return out;
  };

  return (
    <For each={pieces()} keyed={false}>
      {(p) => (
        <Show when={props.mention && p().part} fallback={<Show when={p().ref} fallback={p().text}>{(r) => <ItemRef num={r().num} fleet={r().fleet} scope={r().scope} question={r().question} text={p().text} every={r().every} />}</Show>}>
          {(part) => <>{props.mention?.(part())}</>}
        </Show>
      )}
    </For>
  );
}

/** The text of a run of blocks back in plain words: each mention mark as the part's own text. */
const unmark = (text: string, parts: readonly Part[]): string => text.replace(MARK, (_, i: string) => parts[Number(i)]?.text ?? "");

/** A block's key: its kind, language and text, and where it is, so a block keeps its node while it stays the same. */
const keyOf = (b: Block, i: number): string => (b.kind === "code" ? `c${String(i)}|${b.lang}|${b.text}` : `p${String(i)}|${b.spans.map((s) => s.kind + s.text).join("\u0000")}`);

/** Blocks, rendered. */
function Blocks(props: { readonly blocks: readonly Block[]; readonly parts: readonly Part[]; readonly mention: MentionView | undefined; readonly refs: RefsMode; readonly fleet?: string | null | undefined }): JSX.Element {
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
              {(s) => (
                <Show when={s().kind === "code"} fallback={<Words text={s().text} parts={props.parts} mention={props.mention} refs={props.refs} fleet={props.fleet} />}>
                  <code class="ic">{unmark(s().text, props.parts)}</code>
                </Show>
              )}
            </For>
          </p>
        );
      }}
    </For>
  );
}

/**
 * Free text in the page's format, in a `<div class={cls}>`. Text that uses no backtick is one paragraph,
 * exactly as before. A message's `parts` put its mentions back where they were, shown by `mention`. With
 * `refs`, the words link each reference in them (refs.ts) to the row it names, every number when it is
 * "every" ({@link RefsMode}); `fleet` says whose words they are on a manager's page (a fleet it serves; anyone
 * else's are the page's own). Code is never a reference.
 */
export function Rich(props: { readonly text: string; readonly class?: string; readonly parts?: readonly Part[]; readonly mention?: MentionView; readonly refs?: RefsMode; readonly fleet?: string | null | undefined }): JSX.Element {
  const parts = (): readonly Part[] => props.parts ?? [];

  /* A message's words with each mention as a mark the format reads as plain text. */
  const source = createMemo((): string => (props.parts && props.mention ? props.parts.map((p, i) => (p.mention ? `${String(i)}` : p.text.replace(/[]/gu, ""))).join("") : props.text));

  const blocks = createMemo((): Block[] => {
    const s = source();

    return isFormatted(s) ? parseText(s) : [{ kind: "para", spans: spansOf(s) }];
  });

  return (
    <div class={"rich" + (props.class ? " " + props.class : "")}>
      <Blocks blocks={blocks()} parts={parts()} mention={props.mention} refs={props.refs ?? false} fleet={props.fleet} />
    </div>
  );
}

/** A `--manual`: in the format when it uses it (its words' references linked, its code never), one `nu` block when its every line is a command, else as it always was. */
export function ManualText(props: { readonly text: string }): JSX.Element {
  const blocks = createMemo(() => manualBlocks(props.text));

  return (
    <Show when={blocks()} fallback={<pre class="manual">{props.text}</pre>}>
      {(b) => (
        <div class="rich manual-rich">
          <Blocks blocks={b()} parts={[]} mention={undefined} refs />
        </div>
      )}
    </Show>
  );
}

/**
 * How to undo what a notice did: in the format when it uses it (inline code, fenced blocks with their copy
 * button), one `nu` block when its every line is a command, else as words.
 */
export function UndoText(props: { readonly text: string }): JSX.Element {
  const blocks = createMemo(() => manualBlocks(props.text));

  return (
    <Show when={blocks()} fallback={<Rich text={props.text} refs="every" />}>
      {(b) => (
        <div class="rich">
          <Blocks blocks={b()} parts={[]} mention={undefined} refs="every" />
        </div>
      )}
    </Show>
  );
}
