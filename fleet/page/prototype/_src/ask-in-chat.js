/* PROTOTYPE: ask in chat. Question: asking about a decision, action or grill from its page should feel the
   same as Reply / Side chat on selected text (a chip naming the item with a link back, main thread or side
   chat, @mentions and /skills). How do the entry point and the composer look and behave from a decision page?
   Three variants: Dock (the page hands the question to the chat's one composer), Inline (the composer
   lives on the decision's page), Margin (ask about one block: a question, an option, a grill's q). */
(() => {
  const { esc, line, I, renderLog, composer, wireComposer, mountShell, mkMsg, decisionById } = P;

  const ANSWERS = {
    d44: [["b155", "With A the guard is one line; tomorrow's pass picks the fresh pieces up. B needs the bounds stored per piece first."], ["infra-coordinator", "Se quiser, eu peço ao b155 os números da última semana antes de você decidir."]],
    a22: [["a113", "38 recordings, about 3h10 of audio. The reprocess takes about 25 minutes; nothing else waits on it."]],
    g4: [["b196", "In the alpha a reload keeps the path; with ids a renamed node keeps its selection too. I'd go with ids."]],
    d45: [["ui-coordinator", "Links is 4 rows on both fleets; Plan has room for them as a last section."]],
  };
  const ctxLabel = (c) => c.part ? `${c.d.ref} · ${c.part}` : `${c.d.ref} ${c.d.title}`;
  /** The chip that names what the question is about, with its way back to it. */
  const chip = (c, removable = true) => `<span class="ak-chip">${c.quote ? `<span class="ak-q">“${esc(line(c.quote, 70))}”</span>` : ""}<span class="ak-about"><span class="ref">${esc(c.d.ref)}</span><a href="#" class="ak-link" data-open-decision="${c.d.id}" title="Open ${esc(c.d.ref)}">${esc(line(c.part || c.d.title, 48))}</a>${I.up}</span></span>${removable ? `<button type="button" class="icon-btn ak-x" aria-label="Remove what it is about" title="Remove">${I.closeS}</button>` : ""}`;
  const dest = (name, value) => `<div class="seg small ak-dest" role="radiogroup" aria-label="Where it goes"><button type="button" role="radio" aria-pressed="${value === "main"}" aria-checked="${value === "main"}" data-dest="main">${I.chat}Main chat</button><button type="button" role="radio" aria-pressed="${value === "side"}" aria-checked="${value === "side"}" data-dest="side">${I.side}Side chat</button></div>`;

  /** The chat as the real page has it (main thread, side chats behind "Back to the chat"), plus what a page posts. */
  function chatCtl(stage, ui, signal, opts = {}) {
    const st = structuredClone(P.STATE);
    st.sides.forEach((s) => (s.mine = false));
    let focus = null;
    const body = stage.querySelector("#chat-body");
    body.innerHTML = `<div class="side-head" hidden><button type="button" class="btn small" data-side-back>${I.back}Back to the chat</button><span class="side-title">Side chat</span></div><div class="ak-sidectx" hidden></div><ol class="chat-log"></ol>${composer({ above: opts.above || "" })}`;
    const $ = (s) => body.querySelector(s);
    const draw = (end = true) => {
      const s = st.sides.find((x) => x.id === focus);
      $(".side-head").hidden = !s;
      $(".ak-sidectx").hidden = !s;
      if (s) $(".ak-sidectx").innerHTML = `<span class="sc-kick">Side chat on</span> ${s.about ? chip({ d: s.about.d, part: s.about.part, quote: s.about.quote }, false) : `<q>${esc(line(s.title, 90))}</q>`}`;
      $(".chat-log").innerHTML = s ? renderLog(s.msgs, { noDays: true }) : renderLog(st.main, { after: (m) => st.sides.filter((x) => x.mine && x.anchor === m.id).map((x) => `<li class="side-link"><button type="button" data-side="${x.id}"><span class="side-kicker">Side chat · ${x.msgs.length} message${x.msgs.length === 1 ? "" : "s"} · about ${esc(x.about.d.ref)}</span><span class="side-text">${esc(line(x.title, 120))}</span></button></li>`).join("") });
      $(".composer textarea").placeholder = s ? "Ask in this side chat, or type @ or /" : "Message the fleet, or type @ or /";
      if (end) $(".chat-log").scrollTop = $(".chat-log").scrollHeight;
      opts.onDraw?.();
    };
    const answer = (d, side) => {
      const list = ANSWERS[d.id] || [[d.fleet, "Noted."]];
      list.forEach(([from, text], i) => setTimeout(() => { (side ? side.msgs : st.main).push(mkMsg([0, from, text], side ? { side: side.id } : {})); draw(); opts.onAnswer?.(d, side); }, 900 + i * 900));
    };
    const ctl = {
      st,
      focus: () => focus,
      show(id) { focus = id; draw(); },
      /** Posts a question about `c` to the main thread or a new side chat; the chat follows it. */
      post(text, c, where) {
        const about = c ? { id: c.d.id, ref: c.d.ref, title: c.d.title, part: c.part } : null;
        const quote = c?.quote ? { from: `${c.d.ref} on its page`, text: c.quote } : null;
        if (where === "side" && c) {
          const s = { id: Math.max(...st.sides.map((x) => x.id)) + 1, title: c.quote || c.part || c.d.title, about: c, mine: true, anchor: st.main[st.main.length - 1].id, archived: false, unread: 0, msgs: [] };
          s.msgs.push(mkMsg([0, "user", text], { side: s.id }));
          st.sides.push(s);
          focus = s.id;
          draw(); answer(c.d, s);
          return s;
        }
        if (where === "side" && focus !== null) { const s = st.sides.find((x) => x.id === focus); s.msgs.push(mkMsg([0, "user", text], { side: s.id })); draw(); answer(s.about?.d || decisionById("d44"), s); return s; }
        st.main.push(mkMsg([0, "user", text], { about, quote }));
        focus = null; draw(); if (c) answer(c.d, null); else setTimeout(() => { st.main.push(mkMsg([0, "infra-coordinator", "Noted."])); draw(); }, 900);
        return null;
      },
      thread(d) { return { main: st.main.filter((m) => m.about?.id === d.id || (m.from !== "user" && st.main[st.main.indexOf(m) - 1]?.about?.id === d.id)), sides: st.sides.filter((s) => s.mine && s.about.d.id === d.id) }; },
    };
    body.addEventListener("click", (e) => {
      if (e.target.closest("[data-side-back]")) { focus = null; draw(); return; }
      const sl = e.target.closest("[data-side]"); if (sl) { focus = Number(sl.dataset.side); draw(); }
    }, { signal });
    draw();
    return ctl;
  }

  /** The bar a text selection on the decision's page offers, as the real page's: Copy, Reply, Side chat. */
  function pageSelTool(stage, signal, onPick) {
    const tool = document.createElement("div");
    tool.className = "seltool"; tool.hidden = true; tool.setAttribute("role", "toolbar");
    tool.innerHTML = `<button type="button" data-sel="copy">Copy</button><button type="button" data-sel="main">Reply</button><button type="button" data-sel="side">Side chat</button>`;
    stage.appendChild(tool);
    let picked = null;
    document.addEventListener("selectionchange", () => {
      const sel = getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      const node = sel?.anchorNode?.parentElement;
      const page = node?.closest?.(".dv");
      if (!text || !page || node.closest("textarea, .ak-pop, .ak-onpage")) { tool.hidden = true; picked = null; return; }
      const blk = node.closest("[data-blk]");
      picked = { text, part: blk?.dataset.part || null };
      const r = sel.getRangeAt(0).getBoundingClientRect();
      tool.hidden = false;
      tool.style.top = Math.max(8, r.top - 50) + "px";
      tool.style.left = Math.min(innerWidth - 240, Math.max(8, r.left + r.width / 2 - 110)) + "px";
    }, { signal });
    tool.addEventListener("pointerdown", (e) => e.preventDefault(), { signal });
    tool.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sel]");
      if (!b || !picked) return;
      if (b.dataset.sel === "copy") { navigator.clipboard?.writeText(picked.text).catch(() => {}); return; }
      const p = picked; tool.hidden = true; getSelection().removeAllRanges(); onPick(p, b.dataset.sel);
    }, { signal });
  }
  const PARTS = (d) => ({ question: "The question", why: d.blocking ? "What it blocks" : "Meanwhile", recommended: "Recommended" });
  const partName = (d, key) => key.startsWith("option:") ? (() => { const o = d.options.find((x) => x.id === key.slice(7)); return `Option ${o.id}: ${o.label}`; })() : key.startsWith("q:") ? `${key.slice(2)}: ${d.grill.find((q) => q.id === key.slice(2)).text}` : PARTS(d)[key];
  const tagBlocks = (d) => (key, html) => `<div class="ak-blk" data-blk="${key}" data-part="${esc(partName(d, key))}">${html}</div>`;
  const pickDecision = `<div class="ak-pick proto-own">Try it on <button type="button" data-ak-d="d44" class="ak-pickb">D44</button><button type="button" data-ak-d="a22" class="ak-pickb">A22</button><button type="button" data-ak-d="g4" class="ak-pickb">G4</button></div>`;

  /* ---------- 1. Dock: the page hands the question to the chat's one composer ---------- */
  function Dock(stage, signal) {
    let ctx = null, where = "main", cw = null, ctl;
    const ui = mountShell(stage, {
      view: "decisions", decision: "d44",
      decisionOpts: (d) => ({ block: tagBlocks(d), headExtra: `<button type="button" class="btn small ak-ask" data-ask>${I.chat}Ask in chat</button>`, actions: `<button type="button" class="btn" data-ask>${I.chat}Ask in chat</button>`, afterInfo: pickDecision }),
    }, signal);
    ctl = chatCtl(stage, ui, signal, { above: `<div class="ak-row" hidden>${dest("dock", "main")}<span class="ak-hint">Enter sends · Shift+Enter a new line</span></div>` });
    const comp = stage.querySelector("#chat-body .composer");
    const setCtx = (c, w = where) => {
      ctx = c; where = w;
      const chips = comp.querySelector(".chips");
      chips.hidden = !c; chips.innerHTML = c ? chip(c) : "";
      comp.querySelector(".ak-row").hidden = !c;
      comp.querySelectorAll("[data-dest]").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.dest === where)); b.setAttribute("aria-checked", String(b.dataset.dest === where)); });
      comp.querySelector("textarea").placeholder = c ? (where === "side" ? `Start a side chat about ${c.d.ref}, or type @ or /` : `Ask about ${c.d.ref} in the chat, or type @ or /`) : "Message the fleet, or type @ or /";
    };
    cw = wireComposer(comp, { signal, onSend: (text) => {
      if (ctx) { ctl.post(text, ctx, where); setCtx(null, "main"); }
      else ctl.post(text, null, ctl.focus() !== null ? "side" : "main");
    } });
    const ask = (c, w) => { setCtx(c, w); ui.openChat(); requestAnimationFrame(() => cw.focus()); };
    stage.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-ask]")) { ask({ d: decisionById(ui.decision) }, where); return; }
      const dd = t.closest("[data-ak-d]"); if (dd) { ui.keepScroll = true; ui.show("decisions", dd.dataset.akD); ui.keepScroll = false; return; }
      if (t.closest(".ak-x")) { setCtx(null); cw.focus(); return; }
      const ds = t.closest("[data-dest]"); if (ds && ctx) { setCtx(ctx, ds.dataset.dest); cw.focus(); }
    }, { signal });
    pageSelTool(stage, signal, (p, w) => ask({ d: decisionById(ui.decision), part: p.part, quote: p.text }, w));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ctx && document.activeElement === comp.querySelector("textarea") && stage.querySelector("#chat-body .mentions").hidden) { e.preventDefault(); setCtx(null); } }, { capture: true, signal });
  }

  /* ---------- 2. On the page: the composer lives under the decision, its answers with it ---------- */
  function OnPage(stage, signal) {
    let where = "main", ctl, quote = null, pageAbort = null;
    const onPageBox = (d) => `<section class="ak-onpage" aria-label="Ask about ${esc(d.ref)}">
        <h3 class="ak-h">Ask about ${esc(d.ref)}</h3>
        ${composer({ cls: "ak-pcomp", chip: chip({ d }, false), placeholder: `A question for ${d.fleet} or @${d.agent || "a worker"}, or type /`, below: `<div class="ak-row">${dest("page", where)}<span class="ak-hint">Answers show here and in the chat</span></div>` })}
        <div class="ak-here"></div></section>`;
    const ui = mountShell(stage, {
      view: "decisions", decision: "d44",
      decisionOpts: (d) => ({ block: tagBlocks(d), afterInfo: pickDecision + onPageBox(d), actions: `<button type="button" class="btn" data-ask-jump>${I.chat}Ask about ${esc(d.ref)}</button>` }),
      onView: (u) => wirePage(u),
    }, signal);
    function drawHere() {
      const box = stage.querySelector(".ak-here");
      if (!box || !ctl) return;
      const d = decisionById(ui.decision);
      const t = ctl.thread(d);
      box.innerHTML = (t.main.length ? `<div class="ak-thread"><div class="ak-th"><span>In the main chat</span><button type="button" class="ak-open" data-open-main>Open in chat</button></div><ol class="thread-list">${renderLog(t.main, { noDays: true })}</ol></div>` : "")
        + t.sides.map((s) => `<div class="ak-thread"><div class="ak-th"><span>Side chat · ${esc(line(s.title, 50))}</span><button type="button" class="ak-open" data-open-side="${s.id}">Open in chat</button></div><ol class="thread-list">${renderLog(s.msgs, { noDays: true })}</ol></div>`).join("");
    }
    function wirePage(u) {
      pageAbort?.abort(); pageAbort = new AbortController();
      const comp = stage.querySelector(".ak-pcomp");
      if (!comp) return;
      const d = decisionById(u.decision);
      const sync = () => {
        comp.querySelectorAll("[data-dest]").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.dest === where)); b.setAttribute("aria-checked", String(b.dataset.dest === where)); });
        comp.querySelector(".chips").innerHTML = chip({ d, quote: quote?.text, part: quote?.part }, !!quote);
      };
      sync();
      const cw = wireComposer(comp, { signal: AbortSignal.any([signal, pageAbort.signal]), under: true, onSend: (text) => { ctl.post(text, { d, quote: quote?.text, part: quote?.part }, where); quote = null; sync(); drawHere(); } });
      comp.addEventListener("click", (e) => {
        const ds = e.target.closest("[data-dest]"); if (ds) { where = ds.dataset.dest; sync(); cw.focus(); }
        if (e.target.closest(".ak-x")) { quote = null; sync(); cw.focus(); }
      }, { signal: pageAbort.signal });
      u._focusAsk = (q, w) => { quote = q; if (w) where = w; sync(); comp.scrollIntoView({ block: "center", behavior: "smooth" }); cw.focus(); };
      drawHere();
    }
    ctl = chatCtl(stage, ui, signal, { onDraw: drawHere, onAnswer: drawHere });
    wirePage(ui);
    const chatComp = stage.querySelector("#chat-body .composer");
    wireComposer(chatComp, { signal, onSend: (text) => ctl.post(text, null, ctl.focus() !== null ? "side" : "main") });
    stage.addEventListener("click", (e) => {
      const t = e.target;
      const dd = t.closest("[data-ak-d]"); if (dd) { ui.keepScroll = true; ui.show("decisions", dd.dataset.akD); ui.keepScroll = false; return; }
      if (t.closest("[data-ask-jump]")) { ui._focusAsk?.(null); return; }
      if (t.closest("[data-open-main]")) { ctl.show(null); ui.openChat(); return; }
      const os = t.closest("[data-open-side]"); if (os) { ctl.show(Number(os.dataset.openSide)); ui.openChat(); }
    }, { signal });
    pageSelTool(stage, signal, (p, w) => ui._focusAsk?.(p, w));
  }

  /* ---------- 3. Margin: every block of the page has its own Ask, a small composer under it ---------- */
  function Margin(stage, signal) {
    let ctl, pop = null, popAbort = null;
    const marks = {}; // block key -> side id or "main"
    const ui = mountShell(stage, {
      view: "decisions", decision: "d44",
      decisionOpts: (d) => ({ afterInfo: pickDecision, block: (key, html) => `<div class="ak-blk ak-m" data-blk="${key}" data-part="${esc(partName(d, key))}">${html}<div class="ak-mside"><button type="button" class="ak-mbtn" data-mask="${key}" aria-label="Ask about ${esc(partName(d, key))}" title="Ask about this">${I.chat}<span>Ask</span></button><span class="ak-marks" data-marks="${key}"></span></div></div>` }),
      onView: (u) => { closePop(); drawMarks(u); },
    }, signal);
    ctl = chatCtl(stage, ui, signal, { onAnswer: () => drawMarks(ui) });
    wireComposer(stage.querySelector("#chat-body .composer"), { signal, onSend: (text) => ctl.post(text, null, ctl.focus() !== null ? "side" : "main") });
    function drawMarks(u = ui) {
      const d = decisionById(u.decision);
      stage.querySelectorAll("[data-marks]").forEach((el) => {
        const m = marks[d.id + ":" + el.dataset.marks];
        if (!m) { el.innerHTML = ""; return; }
        const s = m === "main" ? null : ctl.st.sides.find((x) => x.id === m);
        el.innerHTML = `<button type="button" class="ak-mark" data-goto="${m}">${s ? I.side : I.chat}${s ? `Side chat · ${s.msgs.length}` : "In the chat"}</button>`;
      });
    }
    function closePop() { popAbort?.abort(); pop?.remove(); pop = null; stage.querySelectorAll(".ak-blk.asking").forEach((b) => b.classList.remove("asking")); }
    function openPop(blk, quote = null, preset = null) {
      closePop();
      const d = decisionById(ui.decision);
      const key = blk.dataset.blk, part = blk.dataset.part;
      const c = { d, part, quote };
      blk.classList.add("asking");
      pop = document.createElement("div");
      pop.className = "ak-pop";
      pop.innerHTML = composer({ cls: "ak-popcomp", chip: chip(c, false), placeholder: `About ${part.split(":")[0]}… type @ or /`, below: `<div class="ak-popact"><span class="ak-hint"><kbd>↵</kbd> side chat · <kbd>${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd>+<kbd>↵</kbd> main chat · <kbd>Esc</kbd></span><button type="button" class="btn small" data-pop-main>${I.chat}Main chat</button><button type="button" class="btn small primary" data-pop-side>${I.side}Side chat</button></div>` });
      blk.after(pop);
      popAbort = new AbortController();
      const sig = AbortSignal.any([signal, popAbort.signal]);
      const comp = pop.querySelector(".composer");
      comp.querySelector(".send").hidden = true;
      const go = (where) => {
        const text = comp.querySelector("textarea").value.trim();
        if (!text) { comp.querySelector("textarea").focus(); return; }
        const s = ctl.post(text, c, where);
        marks[d.id + ":" + key] = s ? s.id : "main";
        closePop(); drawMarks(); ui.openChat();
      };
      const cw = wireComposer(comp, { signal: sig, under: true, onSend: (_t, e) => go(e.metaKey || e.ctrlKey ? "main" : "side") });
      pop.addEventListener("click", (e) => { if (e.target.closest("[data-pop-main]")) go("main"); if (e.target.closest("[data-pop-side]")) go("side"); }, { signal: sig });
      pop.addEventListener("keydown", (e) => { if (e.key === "Escape" && comp.querySelector(".mentions").hidden) { e.preventDefault(); closePop(); blk.querySelector(".ak-mbtn")?.focus(); } }, { signal: sig });
      if (preset) cw.set(preset);
      cw.focus();
    }
    stage.addEventListener("click", (e) => {
      const t = e.target;
      const dd = t.closest("[data-ak-d]"); if (dd) { ui.keepScroll = true; ui.show("decisions", dd.dataset.akD); ui.keepScroll = false; return; }
      const mb = t.closest("[data-mask]"); if (mb) { const blk = mb.closest(".ak-blk"); blk.classList.contains("asking") ? closePop() : openPop(blk); return; }
      const g = t.closest("[data-goto]"); if (g) { ctl.show(g.dataset.goto === "main" ? null : Number(g.dataset.goto)); ui.openChat(); }
    }, { signal });
    pageSelTool(stage, signal, (p) => { const blk = stage.querySelector(`.ak-blk[data-part="${CSS.escape(p.part || "The question")}"]`) || stage.querySelector(".ak-blk"); openPop(blk, p.text); });
  }

  window.variants = [Dock, OnPage, Margin];
})();
