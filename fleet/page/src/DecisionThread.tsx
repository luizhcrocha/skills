/**
 * A decision's thread, on its page: the viewer's answers and notes on it and the fleet's replies, in the
 * chat's bubbles (the viewer's on the right, the fleet's on the left). The chat leaves this activity out
 * unless asked, so this is where it is read; also what was asked about the item (Ask in the chat, a quote
 * of its page) and the replies. Nothing when there is none yet.
 */
import { createMemo } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { usePage } from "./bits.tsx";
import { showMessage, Turn } from "./ChatLog.tsx";
import { decisionThread } from "./chatlog.ts";

/** Decision `id`'s thread. */
export function DecisionThread(props: { readonly id: string | null }): JSX.Element {
  const { m } = usePage();
  const items = createMemo(() => (props.id ? decisionThread(m.messages(), props.id) : []));

  let list: HTMLOListElement | undefined;

  return (
    <Show when={items().length}>
      <section class="dv-block dv-thread" id="dv-thread" aria-labelledby="dv-thread-title">
        <h3 id="dv-thread-title">In the chat</h3>
        <ol
          class="thread-list"
          ref={(el) => (list = el)}
          onClick={(e) => {
            const goto = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-goto]") : null;

            if (goto) showMessage(list, goto.dataset["goto"]);
          }}
        >
          <For each={items()} keyed={(it) => it.message.id}>
            {(it) => <Turn item={it()} replyable={false} dated />}
          </For>
        </ol>
      </section>
    </Show>
  );
}
