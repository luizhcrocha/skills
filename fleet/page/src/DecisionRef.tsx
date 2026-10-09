/**
 * A decision's number in an item's words, as a link to that decision: on hover or focus a tip says its title and
 * its answer, and a tap on a phone opens it. A number this page cannot find stays plain text. Another fleet's
 * ("pipeline's D40") is found on a manager's page among the fleets' open items.
 */
import { createMemo, createSignal } from "solid-js";
import { Show, type JSX } from "@solidjs/web";

import { usePage } from "./bits.tsx";
import { Core, type Decision } from "./core.ts";

/** A decision a number names: where it opens, and what the tip says. */
interface Found {
  readonly href: string;
  readonly tip: string;
}

let tips = 0;

/** What a decision came to, in a few words. */
function outcome(d: Decision): string {
  if (d.status === "decided") return "decided: " + String(d.answer ?? d.resolution ?? "");

  return d.status === "withdrawn" ? "withdrawn" : "still open";
}

/** Decision number `num` (of `fleet`, when named) as a link, its words `text`. */
export function DecisionRef(props: { readonly num: string; readonly fleet: string | null; readonly text: string }): JSX.Element {
  const { m } = usePage();
  const [shown, setShown] = createSignal(false);
  const id = "dref-" + String((tips += 1));

  const found = createMemo((): Found | null => {
    const fleet = props.fleet;

    if (fleet === null) {
      const d = m.state.decisions.find((x) => x.ref === props.num);

      return d ? { href: Core.decisionHref(d.id), tip: `${props.num} ${d.title}: ${outcome(d)}` } : null;
    }

    const d = m.state.coordinators.find((c) => c.id === fleet)?.decisions.find((x) => x.ref === props.num);

    if (!d) return null;

    return { href: m.managed() ? Core.decisionHref(fleet + "/" + d.id) : m.fleetPage(fleet) + Core.decisionHref(d.id), tip: `${props.num} ${d.title}, in ${fleet}: ${outcome(d)}` };
  });

  return (
    <Show when={found()} fallback={props.text}>
      {(f) => (
        <span class="dref-wrap" onMouseEnter={() => setShown(true)} onMouseLeave={() => setShown(false)} onFocusIn={() => setShown(true)} onFocusOut={() => setShown(false)}>
          <a class="dref" href={f().href} aria-describedby={shown() ? id : undefined} data-ref={props.num}>
            {props.text}
          </a>
          <Show when={shown()}>
            <span class="dref-tip" id={id} role="tooltip">
              {f().tip}
            </span>
          </Show>
        </span>
      )}
    </Show>
  );
}
