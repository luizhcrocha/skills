/**
 * The decision's page, a view of this page at #decision/<id>: what the user needs to decide, the evidence
 * (a frame without this page's origin, reloaded only when the item is revised), and the control to answer.
 * The answer's form is built once per decision and shape, so a half-written answer survives every update
 * of the state; it is also kept in this browser per decision and revision, and put back when the form is
 * built again.
 */
import { createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { For, Match, Show, Switch, type JSX } from "@solidjs/web";

import { PillAs, RefTag, usePage, Who } from "./bits.tsx";
import { CaretList } from "./CaretList.tsx";
import { Core, type Decision, type GrillEntry, type JsonRecord } from "./core.ts";
import { DecisionThread } from "./DecisionThread.tsx";
import { clock } from "./format.ts";
import { KIND_WORDS, StatePill } from "./Overview.tsx";
import { CodeBlock, ManualText, Rich } from "./Rich.tsx";

const TOKENS = ["bg", "card", "card-2", "text", "muted", "faint", "line", "accent", "accent-soft", "you", "run", "good", "warning", "serious", "critical", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

const esc = (s: string): string => s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The evidence's document: the fragment with the page's base styles and theme, reporting its height and selection. */
function frameDoc(html: string): string {
  const cs = getComputedStyle(document.documentElement);
  const vars = TOKENS.map((t) => `--${t}:${cs.getPropertyValue("--" + t).trim()}`).join(";");

  return `<!doctype html><html><head><meta charset="utf-8"><base href="${esc(new URL("decisions/", location.href).href)}" target="_blank">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>:root{${vars};color-scheme:${cs.colorScheme === "dark" ? "dark" : "light"}}
html{font:15px/1.5 "Archivo","Helvetica Neue",Arial,system-ui,sans-serif;color:var(--text);background:var(--card)}
body{margin:0;padding:14px 16px;overflow-x:auto;overflow-wrap:anywhere}
body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}
h1,h2,h3,h4{margin:1.2em 0 .4em;line-height:1.2;font-weight:700;font-stretch:84%}h1{font-size:1.3rem}h2{font-size:1.15rem}h3,h4{font-size:1rem}
p,ul,ol,table,pre,figure,dl{margin:0 0 .9em}a{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.85rem;color:var(--muted);font-weight:600;font-stretch:84%}
code,pre{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:.86em}
pre{background:var(--card-2);padding:10px 12px;border-radius:6px;overflow-x:auto}
img,svg,video,canvas{max-width:100%;height:auto}
.num{font-variant-numeric:tabular-nums;font-stretch:84%;text-align:right}
.muted{color:var(--muted)}.good{color:var(--good)}.warning{color:var(--warning)}.critical{color:var(--critical)}
</style></head><body>${html}
<scr` + `ipt>(function(){var post=function(){parent.postMessage({fleetEvidence:true,height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*")};if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post();var t=0;document.addEventListener("selectionchange",function(){clearTimeout(t);t=setTimeout(function(){var s=getSelection(),r=s&&s.rangeCount&&!s.isCollapsed?s.getRangeAt(0).getBoundingClientRect():null;parent.postMessage({fleetSelect:true,text:r?String(s):"",rect:r?{top:r.top,bottom:r.bottom,left:r.left,width:r.width}:null},"*")},180)})})()</scr` + `ipt></body></html>`;
}

/** What the server answers when it refuses a message. */
interface ServerError extends JsonRecord {
  readonly error?: string;
}

/** Where the evidence frame is kept. */
export interface EvidenceFrame {
  frame: HTMLIFrameElement | null;
}

/** The frame the evidence is in, for the page's message listeners. */
export const evidence: EvidenceFrame = { frame: null };

/** The evidence: the fragment a worker or the coordinator wrote for this decision. */
function Evidence(props: { readonly d: Decision | undefined }): JSX.Element {
  const { ui } = usePage();
  const key = createMemo(() => (props.d && props.d.body ? props.d.id + "|" + ui.revisionOf(props.d) : ""));
  const [holder, setHolder] = createSignal<HTMLDivElement>();

  createEffect(
    () => [key(), holder()] as const,
    ([k, el]) => {
      const d = props.d;
      evidence.frame = null;

      if (!el) return;
      el.replaceChildren();

      if (!k || !d) return;
      const url = `decisions/${encodeURIComponent(d.id)}.html?v=${encodeURIComponent(ui.revisionOf(d))}`;
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
      frame.title = "What the decision rests on";
      evidence.frame = frame;
      el.appendChild(frame);
      void fetch(url, { cache: "no-store" })
        .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
        .then((html) => {
          if (key() === k) frame.srcdoc = frameDoc(html);
        })
        .catch(() => {
          if (key() === k) {
            frame.classList.add("fixed");
            frame.src = url;
          }
        });
    },
  );

  const onMessage = (e: MessageEvent<{ readonly fleetEvidence?: boolean; readonly height?: number } | null>): void => {
    const frame = evidence.frame;

    if (!frame || e.source !== frame.contentWindow || !e.data || e.data.fleetEvidence !== true) return;
    const height = Number(e.data.height);

    if (height > 0) frame.style.height = String(Math.min(Math.ceil(height) + 2, 20000)) + "px";
  };

  addEventListener("message", onMessage);
  onCleanup(() => removeEventListener("message", onMessage));

  return (
    <section class="dv-body" id="dv-body" aria-labelledby="h-evidence" hidden={!key()}>
      <h2 id="h-evidence">What it rests on</h2>
      <div id="dv-frame" ref={setHolder} />
    </section>
  );
}

/** An option of a decision: to pick in the form, or to show once decided. */
function Options(props: { readonly d: Decision; readonly pick: boolean }): JSX.Element {
  return (
    <For each={props.d.options} keyed={(o) => o.id}>
      {(o) => {
        const chosen = (): boolean => !props.pick && props.d.status === "decided" && String(props.d.answer || "").startsWith(o().id + ":");

        const inner = (): JSX.Element => (
          <>
            <span class="label">
              {props.pick ? o().id + ": " : ""}
              {o().label}
              <Show when={o().id === props.d.recommend}>
                <PillAs cls="recommended plain" text="recommended" />
              </Show>
            </span>
            <Show when={o().consequence}>{(c) => <Rich class="consequence" text={c()} />}</Show>
          </>
        );

        return (
          <Show
            when={props.pick}
            fallback={
              <div class={"option" + (chosen() ? " chosen" : "")}>
                <span class="key">{o().id}</span>
                {inner()}
              </div>
            }
          >
            <label class="option">
              <input type="radio" name="choice" value={o().id} />
              {inner()}
            </label>
          </Show>
        );
      }}
    </For>
  );
}

/** What to do by hand, when the decision says. */
function Manual(props: { readonly d: Decision; readonly title: string }): JSX.Element {
  return (
    <Show when={props.d.manual}>
      <div class="dv-block">
        <h3>{props.title}</h3>
        <ManualText text={props.d.manual ?? ""} />
      </div>
    </Show>
  );
}

/**
 * A field whose words go to the session, with the list of skills a leading "/" opens under it; picking
 * one puts "/<skill> " in the field. The field takes `caret` as its ref.
 */
function SlashField(props: { readonly id: string; readonly children: (caret: (el: HTMLTextAreaElement) => void) => JSX.Element }): JSX.Element {
  const { ui } = usePage();
  const caret = ui.carets.make({ id: props.id });

  return (
    <div class="caret-wrap">
      {props.children((el) => caret.attach(el))}
      <CaretList caret={caret} under />
    </div>
  );
}

/** "Ask in the chat". */
function Discuss(): JSX.Element {
  const { ui } = usePage();

  return (
    <button type="button" class="btn" data-discuss onClick={() => ui.openChat()}>
      Ask in the chat
    </button>
  );
}

/** The answer's form, sent to the chat tagged with the decision; its draft kept in this browser. */
function AnswerForm(props: { readonly d: Decision; readonly class?: string; readonly children: JSX.Element }): JSX.Element {
  const { m, ui } = usePage();
  const [error, setError] = createSignal("");
  let form: HTMLFormElement | undefined;
  const draftKey = (): string => "dv-draft:" + props.d.id + ":" + ui.revisionOf(props.d);

  const fields = (): (HTMLInputElement | HTMLTextAreaElement)[] =>
    form ? [...form.elements].filter((el): el is HTMLInputElement | HTMLTextAreaElement => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.name !== "" && el.type !== "submit" && el.type !== "button") : [];

  function save(): void {
    const values: { [name: string]: string } = {};

    for (const el of fields()) {
      if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
        if (el.checked) values[el.name] = el.value;
      } else values[el.name] = el.value;
    }

    m.prefs.set(draftKey(), values);
  }

  /* Put back what was given before: a refresh, a state update that rebuilt the form, another revision's start. */
  onSettled(() => {
    const values = m.prefs.get<{ [name: string]: string } | null>(draftKey(), null);

    if (!values || Object(values) !== values) return;

    for (const el of fields()) {
      const v = values[el.name];

      if (v === undefined) continue;

      if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) el.checked = el.value === v;
      else el.value = String(v);
    }
  });

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const d = props.d;

    if (!form) return;
    const data = new FormData(form);
    const text = (name: string): string => String(data.get(name) ?? "");

    const out =
      d.kind === "grill"
        ? Core.grillAnswerText(
            d,
            [...form.querySelectorAll<HTMLFieldSetElement>("fieldset.gq")].map((f) => ({ id: f.dataset["q"] ?? "", pick: text(f.dataset["q"] ?? "") || "later", text: text((f.dataset["q"] ?? "") + "-text") })),
          )
        : Core.answerText(d, {
            choice: text("choice"),
            note: text("note"),
            value: text("value"),
            done: d.kind === "action" || (e.submitter instanceof HTMLButtonElement && e.submitter.name === "done"),
          });

    if ("error" in out) {
      setError(out.error);

      return;
    }

    setError("");
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((b) => {
      b.disabled = true;
    });

    try {
      const res = await fetch("chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...out, decision: d.id }) });
      let body: ServerError | null = null;

      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (res.status !== 201) {
        setError(body?.error || `The server refused the answer (${res.status}). It is kept here.`);

        return;
      }

      m.prefs.remove(draftKey());
      ui.addMessage(body, true);
    } catch {
      setError("Could not reach the dashboard's server. Your answer is kept here; send it again when the server is back.");
    } finally {
      buttons.forEach((b) => {
        b.disabled = false;
      });
    }
  }

  return (
    <form
      class={"dv-form" + (props.class ? " " + props.class : "")}
      novalidate
      ref={(el) => (form = el)}
      onInput={(e) => {
        const box = e.target instanceof HTMLTextAreaElement ? e.target.closest("fieldset.gq") : null;
        const own = box?.querySelector<HTMLInputElement>('input[value="own"]');

        if (own && e.target instanceof HTMLTextAreaElement && e.target.value.trim()) own.checked = true;
        save();
      }}
      onChange={save}
      onSubmit={(e) => void submit(e)}
    >
      {props.children}
      <p class="chat-error" id="dv-error" role="alert" hidden={!error()}>
        {error()}
      </p>
    </form>
  );
}

/** A grilling's answers: each open question with its recommendation and a choice, what was sent, what is settled. */
function Grill(props: { readonly d: Decision }): JSX.Element {
  const { m, ui } = usePage();
  const g = createMemo(() => Core.grillState(props.d, m.messages()));
  const writable = (): boolean => m.chatWritable() && props.d.status === "open";
  const open = () => g().questions.filter((e) => e.q.status === "open");
  const asking = createMemo(() => open().filter((e) => !e.sent || e.sent.replied || ui.answeringAgain() === props.d.id + "/" + e.q.id));
  const sent = () => open().filter((e) => !asking().includes(e));
  const settled = () => g().questions.filter((e) => e.q.status !== "open");

  const head = (e: GrillEntry): JSX.Element => (
    <>
      <span class="gq-id">{e.q.id.toUpperCase()}</span> {e.q.title}
      <Show when={e.q.of}>
        {" "}
        <span class="gq-of">follows up {String(e.q.of).toUpperCase()}</span>
      </Show>
    </>
  );

  const ask = (e: () => GrillEntry): JSX.Element => (
    <fieldset class="gq" data-q={e().q.id} style={`--depth:${e().depth}`}>
      <legend>{head(e())}</legend>
      <Rich class="gq-body" text={e().q.body ?? ""} />
      <div class="gq-rec">
        <p>
          <b>Recommended:</b> {e().q.recommend}
        </p>
        <Show
          when={e().q.reason}
          fallback={<p class="gq-why muted">No reason given. Ask for one in a side chat, or with a note.</p>}
        >
          <p class="gq-why">
            <b>Why:</b> {e().q.reason}
          </p>
        </Show>
      </div>
      <Show when={e().sent}>
        <p class="gq-sent">
          You sent: {e().sent?.text}. The {m.host()} replied in the chat.
        </p>
      </Show>
      <Show when={writable()}>
        <label class="option">
          <input type="radio" name={e().q.id} value="rec" />
          <span class="label">Take the recommendation</span>
        </label>
        <label class="option">
          <input type="radio" name={e().q.id} value="own" />
          <span class="label">My answer</span>
        </label>
        <SlashField id={"dv-skills-" + e().q.id}>
          {(caret) => <textarea name={e().q.id + "-text"} rows="2" aria-label={`Your answer to ${e().q.id.toUpperCase()}`} ref={caret} />}
        </SlashField>
        <label class="option later">
          <input type="radio" name={e().q.id} value="later" checked />
          <span class="label">Later</span>
        </label>
      </Show>
    </fieldset>
  );

  return (
    <>
      <Show when={asking().length}>
        <Show when={writable()} fallback={<For each={asking()} keyed={(e) => e.q.id}>{(e) => ask(e)}</For>}>
          <AnswerForm d={props.d} class="grill">
            <For each={asking()} keyed={(e) => e.q.id}>
              {(e) => ask(e)}
            </For>
            <div class="sheet-actions">
              <button type="submit" class="btn primary">
                Send my answers
              </button>
              <Discuss />
            </div>
          </AnswerForm>
        </Show>
      </Show>
      <Show when={sent().length}>
        <div class="dv-block">
          <h3>Sent, waiting on the {m.host()}</h3>
          <For each={sent()} keyed={(e) => e.q.id}>
            {(e) => (
              <div class="gq sent" style={`--depth:${e().depth}`}>
                <p class="gq-title">{head(e())}</p>
                <p>
                  You sent: <b>{e().sent?.text}</b>
                </p>
                <span class="dv-meta">
                  {clock(e().sent?.at)}. The {m.host()} records it next.
                </span>
                <Show when={writable()}>
                  {" "}
                  <button type="button" class="btn small" data-again-q={e().q.id} onClick={() => ui.setAnsweringAgain(props.d.id + "/" + e().q.id)}>
                    Answer again
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={settled().length}>
        <details class="dv-block gq-done">
          <summary>Settled ({settled().length})</summary>
          <ul>
            <For each={settled()} keyed={(e) => e.q.id}>
              {(e) => (
                <li class={String(e().q.status)}>
                  <b>{e().q.id.toUpperCase()}</b> {e().q.title}: {e().q.status === "dropped" ? "dropped, " + (e().q.dropped || "no longer needed") : e().q.answer}
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={!m.chatWritable() && props.d.status === "open"}>
        <p class="readonly" role="status">
          This copy of the page cannot send answers. Give them in the session with the {m.host()}.
        </p>
      </Show>
    </>
  );
}

/** The form for an open decision, by its kind; built once while the kind stays. */
function Form(props: { readonly d: Decision }): JSX.Element {
  const kind = createMemo(() => props.d.kind);

  const note = (label: string): JSX.Element => (
    <div class="field">
      <label for="dv-note">{label}</label>
      <SlashField id="dv-note-skills">
        {(caret) => <textarea id="dv-note" name="note" rows="2" autocomplete="off" ref={caret} />}
      </SlashField>
    </div>
  );

  return (
    <Switch
      fallback={
        <AnswerForm d={props.d}>
          <label class="field">
            Your answer
            <textarea name="value" rows="3" autocomplete="off" />
          </label>
          <div class="sheet-actions">
            <button type="submit" class="btn primary">
              Send my answer
            </button>
            <Discuss />
          </div>
        </AnswerForm>
      }
    >
      <Match when={kind() === "decision"}>
        <AnswerForm d={props.d}>
          <fieldset>
            <legend>Your decision</legend>
            <Options d={props.d} pick />
            <label class="option">
              <input type="radio" name="choice" value="none" />
              <span class="label">None of these</span>
              <span class="consequence">Say what you want instead, in the note.</span>
            </label>
          </fieldset>
          {note("Note, if you want to add one")}
          <div class="sheet-actions">
            <button type="submit" class="btn primary">
              Send my decision
            </button>
            <Discuss />
          </div>
        </AnswerForm>
      </Match>
      <Match when={kind() === "permission"}>
        <AnswerForm d={props.d}>
          <Show when={props.d.refusal}>
            {(r) => (
              <div class="dv-block refused">
                <h3>The call auto mode refused</h3>
                <CodeBlock lang="sh" text={r().call} />
                <dl>
                  <dt>Refused because</dt>
                  <dd>{r().cause}</dd>
                  <dt>Rule</dt>
                  <dd>
                    <code>{r().rule}</code>
                  </dd>
                  <dt>Goes into</dt>
                  <dd>
                    <code>{r().root.replace(/\/+$/u, "") + "/.claude/settings.local.json"}</code>
                  </dd>
                </dl>
              </div>
            )}
          </Show>
          <fieldset>
            <legend>Your answer</legend>
            <Options d={props.d} pick />
          </fieldset>
          {note("Note for the worker, if you want to add one")}
          <div class="sheet-actions">
            <button type="submit" class="btn primary">
              Send my answer
            </button>
            <Discuss />
          </div>
        </AnswerForm>
      </Match>
      <Match when={kind() === "secret"}>
        <AnswerForm d={props.d}>
          <p>
            The fleet needs <code>{props.d.secret}</code>. Say where it lives; the value itself never goes through this page.
          </p>
          <label class="field">
            1Password reference, or the item's name
            <input type="text" name="value" placeholder="op://vault/item/field" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck={false} data-1p-ignore data-lpignore="true" />
          </label>
          <div class="sheet-actions">
            <button type="submit" class="btn primary">
              Send the reference
            </button>
            <Discuss />
          </div>
          <Manual d={props.d} title="Or set it by hand" />
          <div class="sheet-actions">
            <button type="submit" name="done" value="1" class="btn">
              I have set it
            </button>
          </div>
        </AnswerForm>
      </Match>
      <Match when={kind() === "action"}>
        <AnswerForm d={props.d}>
          <Manual d={props.d} title="What to do" />
          {note("Note, if something went differently")}
          <div class="sheet-actions">
            <button type="submit" name="done" value="1" class="btn primary">
              Done
            </button>
            <Discuss />
          </div>
        </AnswerForm>
      </Match>
    </Switch>
  );
}

/** The way to answer: the form, the answer sent and waiting, or why this copy cannot send one. */
function Answer(props: { readonly d: Decision }): JSX.Element {
  const { m, ui } = usePage();
  const pending = createMemo(() => Core.pendingAnswer(props.d, m.messages()));

  /* What the answer area shows, as a few words: the form is rebuilt only when this changes. */
  const mode = createMemo((): string => {
    const d = props.d;

    if (d.kind === "grill") return "grill";

    if (d.status !== "open") return "closed";
    const p = pending();

    if (p) return (p.replies.length > 0 || ui.answeringAgain() === d.id) && m.chatWritable() ? "pending+form" : "pending";

    return m.chatWritable() ? "form" : "readonly";
  });

  const shown = (): JSX.Element => (
    <Show when={(props.d.kind === "decision" || props.d.kind === "permission") && props.d.options.length}>
      <div class="dv-block">
        <h3>Options</h3>
        <div class="options">
          <Options d={props.d} pick={false} />
        </div>
      </div>
    </Show>
  );

  return (
    <>
      <Show when={mode() === "grill"}>
        <Grill d={props.d} />
      </Show>
      <Show when={mode() === "closed" && !(props.d.page === false && !(props.d.kind === "decision" && props.d.options.length))}>
        {shown()}
        <Show when={m.chatWritable()}>
          <div class="sheet-actions">
            <button type="button" class="btn" data-change onClick={() => ui.changeAnswer(props.d)}>
              Change my answer
            </button>
          </div>
        </Show>
      </Show>
      <Show when={mode().startsWith("pending") ? pending() : null}>
        {(p) => (
          <>
            <div class="note pending" role="status">
              {/* The answer and the replies are in the thread above ("In the chat"); this says only where the answer stands. */}
              <h3>Your answer</h3>
              <span class="dv-meta">
                Sent {clock(p().answer.at)}.{" "}
                {Core.isHeld(props.d) && Core.stamp(p().answer.at) <= Core.stamp(props.d.held_at)
                  ? `The ${m.host()} has it and works on it first.`
                  : p().replies.length
                    ? `The ${m.host()} replied above; answer again if it asks you something.`
                    : Core.unreadBy(m.state.hearing, p().answer)
                      ? `The ${m.host()} has not read it yet${m.state.hearing?.on ? "" : ": it is not reading the chat right now"}. Your answer is kept.`
                      : `The ${m.host()} has read it and has yet to record it; the fleet acts on it once it is recorded.`}
              </span>
            </div>
            <Show
              when={mode() === "pending+form"}
              fallback={
                <div class="sheet-actions">
                  <Show when={m.chatWritable()}>
                    <button type="button" class="btn" data-again onClick={() => ui.setAnsweringAgain(props.d.id)}>
                      Answer again
                    </button>
                  </Show>
                  <Discuss />
                </div>
              }
            >
              <Form d={props.d} />
            </Show>
          </>
        )}
      </Show>
      <Show when={mode() === "readonly"}>
        {shown()}
        <Manual d={props.d} title="What to do" />
        <p class="readonly" role="status">
          {m.chatAvailable() && m.write().reason
            ? m.write().reason + ` Give your answer in the session with the ${m.host()}.`
            : `This copy of the page cannot send an answer. Give it in the session with the ${m.host()}.`}
        </p>
      </Show>
      <Show when={mode() === "form"}>
        <Form d={props.d} />
      </Show>
    </>
  );
}

/** Where a decision came from in the fleet's work: its milestone, its step, the worker it is for. */
function Origin(props: { readonly d: Decision }): JSX.Element {
  const { m } = usePage();
  const ms = () => (props.d.milestone ? m.state.roadmap.find((x) => x.id === props.d.milestone) : undefined);
  const st = () => (props.d.step ? ms()?.steps.find((x) => x.id === props.d.step) : undefined);

  const parts = (): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const milestone = ms();
    const step = st();

    if (milestone) out.push(<a href="#plan">{milestone.title}</a>);

    if (step) {
      out.push(
        <>
          step{" "}
          <a href="#plan">
            {step.id} {step.title}
          </a>
        </>,
      );
    }

    if (props.d.agent && m.person(props.d.agent)) {
      out.push(
        <>
          for <Who id={props.d.agent} />
        </>,
      );
    }

    return out.flatMap((p, i) => (i ? [", ", p] : [p]));
  };

  return (
    <Show when={ms() || (props.d.agent && m.person(props.d.agent))}>
      <p class="dv-meta dv-origin">From {parts()}</p>
    </Show>
  );
}

/** The decision's facts. */
function Info(props: { readonly d: Decision }): JSX.Element {
  const { m, ui } = usePage();
  const d = (): Decision => props.d;
  const open = (): boolean => d().status === "open";
  const pending = createMemo(() => Core.pendingAnswer(d(), m.messages()));
  const recommended = () => d().options.find((o) => o.id === d().recommend);
  const successor = () => m.state.decisions.find((x) => x.supersedes === d().id);
  const before = () => (d().supersedes ? m.decisionById(d().supersedes) : undefined);

  return (
    <>
      <header class="dv-head">
        <div class="dv-pills">
          <StatePill d={d()} pending={pending()} />
          <PillAs cls="plain" text={KIND_WORDS[d().kind] || d().kind} />
        </div>
        <h1>
          <RefTag of={d()} />
          {d().title}
        </h1>
        <Origin d={d()} />
        <p class="dv-meta">
          <Show when={d().agent && m.person(d().agent)} fallback="Asked">
            For <Who id={d().agent} />, asked
          </Show>{" "}
          {m.ago(d().opened)}
          {d().revised ? ", changed " + m.ago(d().revised) : ""}
          <Show when={before()}>
            {(b) => (
              <>
                . Replaces <a href={"#decision/" + b().id}>{b().title}</a>
              </>
            )}
          </Show>
        </p>
      </header>
      <Show when={!open()}>
        <div class={"note " + d().status}>
          <h3>{d().status === "decided" ? "Decided" : "Withdrawn, no answer needed"}</h3>
          <Show when={d().status === "decided"}>
            <p>
              <b>{d().answer}</b>
            </p>
          </Show>
          <p>{d().resolution}</p>
          <span class="dv-meta">
            {clock(d().closed)}, {m.ago(d().closed)}
          </span>
        </div>
      </Show>
      <Show when={successor()}>
        {(s) => (
          <div class="note changed">
            <h3>Replaced</h3>
            <p>
              A newer decision takes its place: <a href={"#decision/" + s().id}>{s().title}</a>
            </p>
          </div>
        )}
      </Show>
      <Show when={Core.isHeld(d())}>
        <div class="note held" role="status">
          <h3>With the fleet</h3>
          <p>{d().held}</p>
          <span class="dv-meta">
            Held {clock(d().held_at)}, {m.ago(d().held_at)}. It comes back to you when the {m.host()} asks again.
          </span>
        </div>
      </Show>
      <Show when={open() && d().asks === "manager"}>
        <div class="note">
          <h3>With the manager</h3>
          <p>The manager looks at this first, and passes it to you when it is yours to decide. You can answer it now.</p>
        </div>
      </Show>
      <Show when={open() && ui.changedNote()?.id === d().id ? ui.changedNote() : null}>
        {(c) => (
          <div class="note changed" role="status">
            <h3>Changed since you last looked</h3>
            <p>{c().text || `The ${m.host()} revised this decision.`}</p>
            <span class="dv-meta">{clock(c().at)}</span>
          </div>
        )}
      </Show>
      <Rich class="dv-question" text={d().question} />
      <Show when={d().why}>
        <div class="dv-block">
          <h3>{d().blocking ? "What it blocks" : "Meanwhile"}</h3>
          <Rich text={d().why ?? ""} />
        </div>
      </Show>
      <Show when={d().recommend}>
        <div class="dv-block">
          <h3>Recommended</h3>
          <p>
            <b>{recommended() ? `${recommended()?.id ?? ""}: ${recommended()?.label ?? ""}` : d().recommend}</b>
          </p>
          <Show when={d().reason}>{(r) => <Rich text={r()} />}</Show>
        </div>
      </Show>
    </>
  );
}

/** The answer area of one decision, rebuilt only when another decision is shown. */
function AnswerFor(props: { readonly id: string }): JSX.Element {
  const { m } = usePage();
  const d = createMemo(() => m.decisionById(props.id));
  const pagesFor = createMemo(() => m.state.links.filter((l) => l.decision === props.id));

  return (
    <Show when={d()}>
      {(found) => (
        <>
          <Show when={pagesFor().length}>
            <div class="dv-block">
              <h3>Open to decide</h3>
              <For each={pagesFor()} keyed={(l) => l.id}>
                {(l) => (
                  <>
                    <p>
                      <a class="btn" href={l().url} target="_blank" rel="noopener">
                        {l().title}
                      </a>
                      <Show when={!l().up}>
                        {" "}
                        <span class="muted">(not answering now)</span>
                      </Show>
                    </p>
                    <Show when={l().note}>
                      <p class="muted">{l().note}</p>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </Show>
          <Answer d={found()} />
        </>
      )}
    </Show>
  );
}

/** The decision's page. */
export function DecisionPage(): JSX.Element {
  const { m, ui } = usePage();
  const d = createMemo(() => m.decisionById(m.viewing()));

  return (
    <main class="wrap dv" id="decision" tabindex="-1" hidden={!m.viewing()} ref={(el) => (ui.refs.decision = el)}>
      <a class="dv-back" href="#decisions">
        <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        All decisions
      </a>
      <div class="dv-info" id="dv-info">
        <Show
          when={d()}
          fallback={
            <Show when={m.viewing()}>
              <div class="note">
                <h3>Not in this ledger</h3>
                <p>No decision "{m.viewing()}" is recorded for this fleet.</p>
              </div>
            </Show>
          }
        >
          {(found) => <Info d={found()} />}
        </Show>
      </div>
      <Evidence d={d()} />
      <DecisionThread id={m.viewing()} />
      <div class="dv-answer" id="dv-answer">
        <Show when={d()?.id} keyed>
          {(id) => <AnswerFor id={id} />}
        </Show>
      </div>
    </main>
  );
}
