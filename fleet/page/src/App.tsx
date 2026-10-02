/**
 * The page: the masthead, one view at a time (or a decision's page), the chat beside or over it, and what
 * opens over everything. Here too are the page-wide listeners: the address, a name that opens its worker,
 * Ctrl/⌘K, a click outside the notifications panel, the visual viewport the chat overlay sits in. Inside
 * the manager's page (`?embed=1`) it is the decision's page alone.
 */
import { createEffect, onCleanup, onSettled } from "solid-js";
import { type JSX } from "@solidjs/web";

import { listen, PageContext, usePage } from "./bits.tsx";
import { Chat } from "./Chat.tsx";
import { Core, type State } from "./core.ts";
import { DecisionPage } from "./DecisionPage.tsx";
import { postFinder, postHeight, postOpen } from "./embed.ts";
import { goLive } from "./live.ts";
import { Masthead, Toasts } from "./Masthead.tsx";
import { createModel, type Model } from "./model.ts";
import { Overview } from "./Overview.tsx";
import { Finder, forwardSelections, SelTool, WorkerSheet } from "./Overlays.tsx";
import { createUi, type Ui } from "./ui.ts";
import { FleetView, LinksView, LogView, PlanView, useVisibleAgents } from "./Views.tsx";

/**
 * The decision's page alone, in a frame of the manager's page: its height told to the manager, which sizes
 * the frame by it, and text selected in it, which the manager's toolbar shows over the frame. Another of the
 * fleet's decisions, and the finder (Ctrl/⌘K), open on the manager's page; whatever leads elsewhere in this
 * fleet (a worker, another view) opens its own page beside.
 */
function Embedded(props: { readonly live: boolean }): JSX.Element {
  const { m, ui } = usePage();

  document.documentElement.classList.add("embed");
  forwardSelections();
  listen(window, "hashchange", () => ui.route());
  listen(document, "click", (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-agent], a[href^='#']") : null;
    const hash = t?.dataset["agent"] ? "#agent-" + t.dataset["agent"] : (t?.getAttribute("href") ?? "");

    if (!t || !hash.startsWith("#")) return;
    const id = Core.decisionRoute(hash);

    if (id === m.viewing()) return;
    e.preventDefault();

    if (id) postOpen(id);
    else open(location.pathname + hash, "_blank", "noopener");
  });
  listen(document, "keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      postFinder();
    }
  });

  if ("ResizeObserver" in globalThis) {
    const watch = new ResizeObserver(postHeight);
    watch.observe(document.documentElement);
    onCleanup(() => watch.disconnect());
  }

  onSettled(() => {
    ui.route();
    postHeight();

    if (props.live) goLive(m, ui);
  });

  return <DecisionPage />;
}

/** The page's parts, under the context. */
function Body(props: { readonly live: boolean }): JSX.Element {
  const { m, ui } = usePage();
  const rows = useVisibleAgents();
  const modal = (): boolean => !m.docked() && m.chatOpen();

  /* The overlay is modal: the page behind it is inert. The docked panel is not. */
  createEffect(modal, (on) => {
    document.documentElement.classList.toggle("chat-open", on);

    for (const id of ["masthead", "app", "decision", "toasts"]) {
      const el = document.getElementById(id);

      if (el) el.inert = on;
    }
  });

  /* Any control naming a worker opens it (the worker sheet listens for its own). */
  listen(document, "click", (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-agent]") : null;

    if (t && !ui.refs.worker?.contains(t)) {
      e.preventDefault();
      ui.openWorker(t.dataset["agent"] ?? "");
    }

    if (ui.panelOpen() && e.target instanceof Node && !ui.refs.panel?.contains(e.target) && !ui.refs.bell?.contains(e.target) && !document.getElementById("toasts")?.contains(e.target)) ui.setPanelOpen(false);
  });
  listen(document, "keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      ui.openFinder();
    }

    if (e.key === "Escape" && ui.panelOpen()) ui.setPanelOpen(false);
  });
  listen(window, "hashchange", () => ui.route());

  /* The visual viewport, for the overlay view: it sits over the on-screen keyboard, never under it. */
  const vv = globalThis.visualViewport;

  if (vv) {
    const sync = (): void => {
      const stick = ui.nearBottom();
      document.documentElement.style.setProperty("--vv-h", String(Math.round(vv.height)) + "px");
      document.documentElement.style.setProperty("--vv-top", String(Math.round(vv.offsetTop)) + "px");

      if (stick) ui.toBottom();
    };

    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    sync();
    onCleanup(() => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    });
  }

  m.onState(() => ui.notify.sync());
  onSettled(() => {
    ui.notify.sync();
    ui.route();
    ui.toBottom();

    if (props.live) goLive(m, ui);
  });

  return (
    <>
      <Toasts />
      <div class={"shell" + (m.docked() && m.chatCollapsed() ? " chat-collapsed" : "")} id="shell">
        <div class="main" id="main">
          <Masthead />
          <div class="wrap" id="app" hidden={Boolean(m.viewing())}>
            <Overview />
            <PlanView />
            <FleetView rows={rows} />
            <LinksView />
            <LogView rows={rows} />
            <footer class="foot">
              <span id="foot-updated">State updated {new Date(m.state.updated).toLocaleString()}</span>
              <span class="pill running" id="live" hidden={!location.protocol.startsWith("http")}>
                live
              </span>
            </footer>
          </div>
          <DecisionPage />
        </div>
        <Chat />
      </div>
      <SelTool />
      <Finder />
      <WorkerSheet />
    </>
  );
}

/** The page for the state it opened with; `live` connects it to its server. */
export function App(props: { readonly state: State; readonly live?: boolean; readonly expose?: (page: { m: Model; ui: Ui }) => void }): JSX.Element {
  const m = createModel(props.state);
  const ui = createUi(m);
  props.expose?.({ m, ui });

  return (
    <PageContext value={{ m, ui }}>
      {m.embed ? <Embedded live={props.live !== false} /> : <Body live={props.live !== false} />}
    </PageContext>
  );
}
