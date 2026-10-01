/**
 * A field's list under the caret, as a listbox: people after "@" (in the chat's composer), skills after a
 * leading "/". It holds the field's focus while it is tapped, so it serves as the tap list on a phone; a
 * row picks on a click. The composer's opens above it; a field on the page opens it under itself.
 */
import { createEffect } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { Pill, tf, usePage } from "./bits.tsx";
import type { Caret, Field, Pick } from "./carets.ts";
import type { RosterRow, Skill } from "./core.ts";

/** The list of `caret`; `under` opens it below its field instead of above. */
export function CaretList(props: { readonly caret: Caret; readonly under?: boolean; readonly ref?: (el: HTMLUListElement) => void }): JSX.Element {
  const { m } = usePage();
  let list: HTMLUListElement | undefined;
  const open = (): Pick | null => props.caret.list();

  const mentionItems = (): readonly RosterRow[] | null => {
    const shown = open();

    return shown?.kind === "mention" ? shown.items : null;
  };

  const commandItems = (): readonly Skill[] | null => {
    const shown = open();

    return shown?.kind === "command" ? shown.items : null;
  };

  /* The highlighted row stays in view, and a list opened under its field is brought into view. */
  createEffect(
    () => [open() !== null, props.caret.index()] as const,
    ([shown, i], was) => {
      const opt = list?.children[i];

      if (!shown || !list || !(opt instanceof HTMLElement)) return;

      if (props.under && !was?.[0]) list.scrollIntoView?.({ block: "nearest" });

      if (opt.offsetTop < list.scrollTop) list.scrollTop = opt.offsetTop - 4;
      else if (opt.offsetTop + opt.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = opt.offsetTop + opt.offsetHeight - list.clientHeight + 4;
    },
  );

  const focusField = (): void => {
    const field: Field | undefined = props.caret.field();
    field?.focus();
  };

  return (
    <ul
      class={"mentions" + (open()?.kind === "command" ? " skills" : "") + (props.under ? " under" : "")}
      id={props.caret.id}
      role="listbox"
      aria-label={open()?.kind === "command" ? "Run a skill" : "Mention someone"}
      hidden={!open()}
      ref={(el) => {
        list = el;
        props.ref?.(el);
      }}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const li = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-i]") : null;

        if (li) {
          props.caret.pick(Number(li.dataset["i"]));
          focusField();
        }
      }}
    >
      <Show when={mentionItems()}>
        {(items) => (
          <For each={items()} keyed={(r) => r.id}>
            {(r, i) => (
              <li role="option" id={props.caret.optionId(i())} data-i={String(i())} aria-selected={tf(i() === props.caret.index())} style={`--c:${m.colourOfId(r().id)}`}>
                <span class="swatch" />
                <span class="m-main">
                  <span class="m-name">{r().name}</span>
                  <Show when={r().name !== r().id}>
                    <span class="faint">{r().id}</span>
                  </Show>
                  <Pill s={r().status} />
                </span>
                <Show when={r().task}>
                  <span class="m-task">{r().task}</span>
                </Show>
              </li>
            )}
          </For>
        )}
      </Show>
      <Show when={commandItems()}>
        {(items) => (
          <For each={items()} keyed={(s) => s.name}>
            {(s, i) => (
              <li role="option" id={props.caret.optionId(i())} data-i={String(i())} aria-selected={tf(i() === props.caret.index())} class="skill">
                <span class="slash" aria-hidden="true">
                  /
                </span>
                <span class="m-main">
                  <span class="m-name">{s().name}</span>
                  <Show when={s().hint}>
                    <span class="faint">{s().hint}</span>
                  </Show>
                </span>
                <Show when={s().description}>
                  <span class="m-task">{s().description}</span>
                </Show>
              </li>
            )}
          </For>
        )}
      </Show>
    </ul>
  );
}
