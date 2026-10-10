/**
 * A batch of comments on a decision as the chat shows it (SPEC "Marks on a decision", the page): a compact
 * card built from the message's structured `marks`, never its Markdown: "N comments on <ref>", then each
 * comment with its number, kind, the words it is on (one line), the comment and a replacement's new words.
 * Every string is the batch's, flattened to one line (`oneLine`) and set as text. A tap opens the decision's
 * inbox on that comment's thread (on the page the batch's place names).
 */
import { For, Show, type JSX } from "@solidjs/web";

import type { MarkBatch, MarkItem } from "./core.ts";
import { batchHead, KIND_WORDS, oneLine } from "./marks.ts";

/** Where a tap on a batch card leads: the decision's page at `hash`, its inbox open on thread `key` (or its list). */
export interface InboxRequest {
  current: { readonly hash: string; readonly key: string | null } | null;
}

/** The inbox to open once the decision's page is shown; the inbox (Marks.tsx) takes it when it is that page's. */
export const inboxRequest: InboxRequest = { current: null };

/** Where the inbox of the decision shown takes a card's tap. */
export interface InboxOpener {
  current: ((hash: string, key: string | null) => boolean) | null;
}

/** How a card asks for an inbox thread: opened at once when the page shows that decision (true), else not. */
export const inboxOpener: InboxOpener = { current: null };

/** Open the inbox of the decision at `hash` on thread `key`: at once on its page, else after going there. */
export function openInbox(hash: string, key: string | null): void {
  if (inboxOpener.current?.(hash, key) === true) return;
  inboxRequest.current = { hash, key };
  location.hash = hash;
}

/** One comment of a batch, on one line each part. */
function Item(props: { readonly item: MarkItem; readonly hash: string }): JSX.Element {
  const i = (): MarkItem => props.item;

  return (
    <li>
      <button type="button" class={"bc-item k-" + i().kind} onClick={() => openInbox(props.hash, i().kind === "general" ? (i().on === undefined ? "page" : "m:" + String(i().on)) : "m:" + String(i().n))}>
        <span class="bc-n">{i().kind === "general" ? (i().on === undefined ? "G" : "↩") : String(i().n)}</span>
        <span class="bc-kind">{i().kind === "general" && i().on !== undefined ? `Reply on #${String(i().on)}:` : KIND_WORDS[i().kind]}</span>
        <Show when={i().quote}>{(q) => <span class="bc-q">“{oneLine(q().text, 160)}”</span>}</Show>
        <Show when={i().kind === "replace" && i().replacement}>{(r) => <span class="bc-with">with “{oneLine(r(), 160)}”</span>}</Show>
        <Show when={i().comment}>{(c) => <span class="bc-c">{oneLine(c(), 240)}</span>}</Show>
      </button>
    </li>
  );
}

/** A batch of comments, as a card. */
export function BatchCard(props: { readonly marks: MarkBatch }): JSX.Element {
  return (
    <div class="batch-card">
      <button type="button" class="bc-head" onClick={() => openInbox(props.marks.at.hash, null)}>
        {batchHead(props.marks)}
      </button>
      <ol class="bc-items">
        <For each={props.marks.items} keyed={(i) => i.n}>
          {(i) => <Item item={i()} hash={props.marks.at.hash} />}
        </For>
      </ol>
      <For each={props.marks.withdrawn ?? []}>{(n) => <p class="bc-gone">Withdrew comment #{String(n)}</p>}</For>
    </div>
  );
}
