/**
 * A decision's history, at the end of its page: every moment of it (asked, changed, passed on, held, the
 * answers given, decided) newest first, one line each. The latest shows; the earlier ones fold under one
 * line until opened. An entry too long for its line opens to its whole text.
 */
import { createMemo } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { usePage } from "./bits.tsx";
import type { Decision } from "./core.ts";
import { clock, fullTime } from "./format.ts";
import { fitsOneLine, historyOf, type HistoryEntry } from "./history.ts";
import { Rich } from "./Rich.tsx";

/** One moment: when, what happened, and what it said, on one line; opened to its whole text when cut. */
function Entry(props: { readonly e: HistoryEntry }): JSX.Element {
  const line = (): JSX.Element => (
    <>
      <time class="dv-h-at" datetime={props.e.at} title={fullTime(props.e.at)}>
        {clock(props.e.at)}
      </time>
      <b class="dv-h-what">{props.e.what}</b>
      <span class="dv-h-text">{props.e.text.replace(/\s+/gu, " ")}</span>
    </>
  );

  return (
    <li class={"dv-h " + props.e.source}>
      <Show
        when={fitsOneLine(props.e.text)}
        fallback={
          <details>
            <summary class="dv-h-line">{line()}</summary>
            <Rich class="dv-h-full" text={props.e.text} />
          </details>
        }
      >
        <div class="dv-h-line">{line()}</div>
      </Show>
    </li>
  );
}

/** Decision `d`'s history; nothing when it has none. */
export function DecisionHistory(props: { readonly d: Decision | undefined }): JSX.Element {
  const { m } = usePage();
  const entries = createMemo(() => (props.d ? historyOf(props.d, m.state.events, m.messages()) : []));
  const earlier = (): HistoryEntry[] => entries().slice(1);

  return (
    <Show when={entries().length}>
      <section class="dv-history" id="dv-history" aria-labelledby="dv-history-title">
        <h2 id="dv-history-title">History</h2>
        <ol class="dv-h-list">
          <Show when={entries()[0]}>{(e) => <Entry e={e()} />}</Show>
        </ol>
        <Show when={earlier().length}>
          <details class="dv-h-more">
            <summary>{earlier().length === 1 ? "1 earlier" : `${String(earlier().length)} earlier`}</summary>
            <ol class="dv-h-list">
              <For each={earlier()} keyed={(e) => e.key}>
                {(e) => <Entry e={e()} />}
              </For>
            </ol>
          </details>
        </Show>
      </section>
    </Show>
  );
}
