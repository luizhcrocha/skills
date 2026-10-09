/**
 * Under the decisions: what the fleet did without asking, under a standing approval the viewer gave once (a
 * notice each, newest first, with how to undo it), and the approvals themselves, each with a Revoke that asks
 * the coordinator in the chat to take it back. Neither waits on the viewer.
 */
import { createMemo, createSignal, flush } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { RefTag, usePage, When } from "./bits.tsx";
import { Core, type Approval, type Decision, type Json, type JsonRecord } from "./core.ts";
import { DecisionRef } from "./DecisionRef.tsx";
import { Rich, UndoText } from "./Rich.tsx";

/** Whether a parsed value is an object rather than null, a list or a scalar. */
const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** The notices shown before "Show all". */
export const NOTICES_SHOWN = 10;

/** The approval's place on the Decisions view, which the finder and a notice's "under A1" lead to. */
export const approvalHref = (id: string): string => "#approval-" + id;

/** The notices, newest first: each its number and title (to its page), what was done, how to undo it, and under what. */
function Notices(props: { readonly list: readonly Decision[] }): JSX.Element {
  const [all, setAll] = createSignal(false);
  const shown = createMemo(() => (all() ? props.list : props.list.slice(0, NOTICES_SHOWN)));

  return (
    <div class="part" id="notices">
      <h2>Done under your approvals</h2>
      <div class="card" id="notice-list">
        <For each={shown()} keyed={(d) => d.id} fallback={<p class="empty">Nothing done under them yet.</p>}>
          {(d) => (
            <article class="notice" data-notice={d().id}>
              <a class="notice-head" href={Core.decisionHref(d().id)}>
                <b>
                  <RefTag of={d()} />
                  {d().title}
                </b>
              </a>
              <Rich class="notice-what" text={d().question} refs />
              <Show when={d().undo}>
                {(u) => (
                  <div class="notice-undo">
                    <b>Undo:</b>
                    <UndoText text={u()} />
                  </div>
                )}
              </Show>
              <span class="meta">
                under{" "}
                <Show when={d().under} fallback="an approval">
                  {(id) => <a href={approvalHref(id())}>{id()}</a>}
                </Show>{" "}
                · <When at={d().closed || d().opened} relative />
              </span>
            </article>
          )}
        </For>
      </div>
      <Show when={props.list.length > NOTICES_SHOWN}>
        <button type="button" class="btn small fold-more" id="notices-all" aria-expanded={all() ? "true" : "false"} aria-controls="notice-list" onClick={() => setAll(!all())}>
          {all() ? `Show the ${String(NOTICES_SHOWN)} newest` : `Show all ${String(props.list.length)}`}
        </button>
      </Show>
    </div>
  );
}

/** Where an approval was given: its decision's number, linked as numbers are, and the chat message. */
function From(props: { readonly a: Approval }): JSX.Element {
  const { m } = usePage();
  const d = createMemo(() => m.decisionById(props.a.ref));

  return (
    <>
      from{" "}
      <Show when={d()?.ref} fallback={props.a.ref || "the chat"}>
        {(num) => <DecisionRef num={num()} fleet={null} question={null} text={num()} />}
      </Show>
      {props.a.message === null ? "" : ` (#${String(props.a.message)})`}
    </>
  );
}

/** The standing approvals: the active ones with Revoke, then the revoked ones folded, each with when and why. */
function Standing(props: { readonly list: readonly Approval[]; readonly notices: readonly Decision[] }): JSX.Element {
  const { m, ui } = usePage();
  const active = createMemo(() => props.list.filter((a) => a.status === "active"));
  const revoked = createMemo(() => props.list.filter((a) => a.status === "revoked"));
  const doneUnder = (id: string): number => props.notices.filter((d) => d.under === id).length;
  /* The status each approval had when its Revoke was sent: the button stays "Revoke sent" until it changes. */
  const [sent, setSent] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<{ readonly id: string; readonly text: string } | null>(null);
  const isSent = (a: Approval): boolean => sent().get(a.id) === a.status;
  const denied = (): string => (m.chatWritable() ? "" : m.chatAvailable() ? m.write().reason || "Read-only here." : "This copy of the page cannot send a message.");

  async function revoke(a: Approval): Promise<void> {
    if (!m.chatWritable() || busy() !== null || isSent(a)) return;
    /* A plain message to the coordinator: no `decision`, which would make it an answer. */
    const json = JSON.stringify({ text: Core.revokeText(a) });
    const over = Core.tooBig(json, m.maxBytes());

    if (over) {
      setError({ id: a.id, text: over });

      return;
    }

    setBusy(a.id);
    setError(null);
    flush();

    try {
      const res = await fetch("chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
      let body: Json = null;

      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.status !== 201) {
        const said = isRecord(body) ? body["error"] : undefined;
        setError({ id: a.id, text: said === String(said) && said ? said : `The server refused the message (${String(res.status)}).` });

        return;
      }

      ui.addMessage(body, true);
      setSent(new Map(sent()).set(a.id, a.status));
    } catch {
      setError({ id: a.id, text: "Could not reach the dashboard's server; revoke again when it is back." });
    } finally {
      setBusy(null);
      flush();
    }
  }

  const facts = (a: Approval): JSX.Element => (
    <>
      <From a={a} />, <When at={a.added} />, by <span title={a.author || undefined}>{a.by}</span>
    </>
  );

  return (
    <div class="part" id="approvals">
      <h2>Your standing approvals</h2>
      <Show when={active().length}>
        <div class="card" id="approval-list">
          <For each={active()} keyed={(a) => a.id}>
            {(a) => (
              <div class="approval" id={"approval-" + a().id}>
                <p class="approval-rule">
                  <span class="ref">{a().id}</span> {a().rule}
                </p>
                <span class="meta">
                  {facts(a())} · {String(doneUnder(a().id))} done under it
                </span>
                <button
                  type="button"
                  class="btn small"
                  data-revoke={a().id}
                  disabled={!m.chatWritable() || isSent(a()) || busy() === a().id}
                  title={denied() || undefined}
                  aria-describedby={denied() ? "approvals-why" : error()?.id === a().id ? "approval-error" : undefined}
                  onClick={() => void revoke(a())}
                >
                  {isSent(a()) ? "Revoke sent" : busy() === a().id ? "Sending…" : "Revoke"}
                </button>
                <Show when={error()?.id === a().id ? error() : null}>
                  {(e) => (
                    <p class="chat-error approval-error" id="approval-error" role="alert">
                      {e().text}
                    </p>
                  )}
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={denied() && active().length}>
        <p class="muted part-note" id="approvals-why">
          {denied()}
        </p>
      </Show>
      <Show when={revoked().length}>
        <details class="approvals-revoked" id="approvals-revoked" open={revoked().some((a) => "approval-" + a.id === m.place().anchor)}>
          <summary>Revoked ({String(revoked().length)})</summary>
          <div class="card">
            <For each={revoked()} keyed={(a) => a.id}>
              {(a) => (
                <div class="approval revoked" id={"approval-" + a().id}>
                  <p class="approval-rule">
                    <span class="ref">{a().id}</span> {a().rule}
                  </p>
                  <span class="meta">
                    Revoked <When at={a().revoked} />
                    {a().revoked_why ? ": " + a().revoked_why : ""}. Given {facts(a())}.
                  </span>
                </div>
              )}
            </For>
          </div>
        </details>
      </Show>
    </div>
  );
}

/** What was done under the viewer's standing approvals, and the approvals; nothing when there are neither. */
export function Approvals(): JSX.Element {
  const { m } = usePage();
  const notices = createMemo(() => Core.noticesOf(m.state.decisions));

  return (
    <Show when={notices().length || m.state.approvals.length}>
      <Notices list={notices()} />
      <Show when={m.state.approvals.length}>
        <Standing list={m.state.approvals} notices={notices()} />
      </Show>
    </Show>
  );
}
