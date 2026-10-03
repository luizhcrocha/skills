/* PROTOTYPE: the Cmd+K finder. Question: recents first on an empty query; kinds as sections (5 rows and
   "more") with Tab-cycled kind tabs and one-character prefixes that do the same; folded word-start matching
   with highlights; a key legend; a Mod+Enter second action; rows that never move. What shape should it take?
   Ported from the Casos palette (apps/casos/src/kit/Palette.tsx, search/groups.ts, search/prefix.ts).
   Three variants: Palette (Casos's, one list in sections), Preview (list beside the highlighted row's
   record and its actions), Board (the kinds side by side as columns, under the masthead). */
(() => {
  const { esc, line, fold, clock, at, short, ago, PEOPLE, WORKERS, COORDS, DECISIONS, PLAN, LINKS, LOG, STATE, I, pill, kindWord, renderLog, composer, wireComposer, mountShell } = P;
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

  /* ---------- what can be found ---------- */
  const KINDS = [
    { id: "decisions", label: "Decisions", heading: "Decisions and actions", prefix: "d" },
    { id: "workers", label: "Workers", heading: "Workers", prefix: "w" },
    { id: "plan", label: "Plan", heading: "Plan", prefix: "p" },
    { id: "links", label: "Links", heading: "Links", prefix: "l" },
    { id: "fleets", label: "Fleets", heading: "Fleets", prefix: "f" },
    { id: "chat", label: "Chat", heading: "Chat", prefix: "c", remote: true },
    { id: "log", label: "Log", heading: "Log", prefix: "g", remote: true },
  ];
  const TABS = [{ id: "all", label: "All" }, ...KINDS];
  const kindOf = (id) => KINDS.find((k) => k.id === id);

  function rows() {
    const out = [];
    for (const d of DECISIONS) {
      out.push({ id: "dec:" + d.id, kind: "decisions", ref: d.ref, title: d.title, sub: line(d.question, 110), hint: d.status === "open" ? (d.blocking ? "blocking" : "open") : d.kind === "action" ? "done" : "decided", go: { decision: d.id }, second: "Ask in chat", d, min: d.opened });
      for (const q of d.grill || []) out.push({ id: `dec:${d.id}:${q.id}`, kind: "decisions", ref: `${d.ref} ${q.id}`, title: q.text, sub: d.title, hint: "open", go: { decision: d.id }, second: "Ask in chat", d, min: d.opened });
    }
    for (const w of WORKERS) out.push({ id: "w:" + w, kind: "workers", ref: w, title: PEOPLE[w].task, sub: `${PEOPLE[w].fleet} · ${PEOPLE[w].model} · /${PEOPLE[w].skill}`, hint: PEOPLE[w].status, go: { worker: w }, second: `Message @${w}`, min: 5 });
    for (const ms of PLAN) for (const [id, t, st, by] of ms.steps) out.push({ id: "p:" + id, kind: "plan", ref: id, title: t, sub: `${ms.title} · ${by}`, hint: st === "current" ? "running" : st, go: { step: id }, second: `Open ${by}`, by, min: 60 });
    for (const [ref, t, url] of LINKS) out.push({ id: "l:" + ref, kind: "links", ref, title: t, sub: url, hint: "up", go: { url }, second: "Copy the address", min: 600 });
    for (const c of ["manager", ...COORDS]) out.push({ id: "f:" + c, kind: "fleets", ref: "", title: c, sub: PEOPLE[c].task || "The fleets' manager", hint: "running", go: { fleet: c }, second: `Message @${c}`, min: 1 });
    for (const m of STATE.main) out.push({ id: "c:" + m.id, kind: "chat", ref: "", title: m.text, sub: `${m.from === "user" ? "You" : m.from}, ${clock(at(m.min))}`, hint: short(m.min), go: { msg: m.id }, second: "Side chat on it", m, min: m.min });
    for (const s of STATE.sides) for (const m of s.msgs) out.push({ id: "c:" + m.id, kind: "chat", ref: "", title: m.text, sub: `Side chat “${line(s.title, 40)}” · ${m.from === "user" ? "You" : m.from}`, hint: short(m.min), go: { side: s.id }, second: "Open in the main chat", m, min: m.min });
    LOG.forEach(([min, kind, by, text], i) => out.push({ id: "g:" + i, kind: "log", ref: "", title: text, sub: `${kind}, ${by}, ${clock(at(min))}`, hint: short(min), go: { log: i }, second: `Open ${by}`, by, min }));
    return out;
  }
  const ALL = rows();

  /* ---------- the search: prefix, folded word-start matching, ranges ---------- */
  const readAsked = (raw) => {
    const m = /^([a-z])\s(.*)$/i.exec(raw.trimStart());
    const k = m && KINDS.find((x) => x.prefix === m[1].toLowerCase());
    return k ? { kind: k.id, words: m[2].trim() } : { kind: null, words: raw.trim() };
  };
  /** Where each word starts a word of `text`, folded ("reclassificação" ~ "reclass"); null when one does not. */
  function wordStarts(text, words) {
    /* Folded, with a hyphen inside a word dropped ("re-classifying" is found by "reclass"); `map` takes a
       compact index back to the text's own, so the highlight lands on the text as written. */
    const raw = fold(text);
    let f = "";
    const map = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "-" && /[\p{L}\p{N}]/u.test(raw[i - 1] || "") && /[\p{L}\p{N}]/u.test(raw[i + 1] || "")) continue;
      f += raw[i]; map.push(i);
    }
    const ranges = [];
    for (const w of words) {
      let i = -1, from = 0;
      while ((i = f.indexOf(w, from)) !== -1) { if (i === 0 || (!/[\p{L}\p{N}]/u.test(f[i - 1]) || map[i] - map[i - 1] > 1)) break; from = i + 1; }
      if (i === -1) return null;
      ranges.push([map[i], map[i + w.length - 1] + 1]);
    }
    return ranges.sort((a, b) => a[0] - b[0]);
  }
  const marked = (text, ranges) => {
    if (!ranges?.length) return esc(text);
    let out = "", pos = 0;
    for (const [a, b] of ranges) { if (a < pos) continue; out += esc(text.slice(pos, a)) + "<mark>" + esc(text.slice(a, b)) + "</mark>"; pos = b; }
    return out + esc(text.slice(pos));
  };
  function match(r, words) {
    if (!words.length) return { r, score: -r.min, tr: [], rr: [], sr: [] };
    const fw = words.map(fold);
    let tr = [], rr = [], sr = [], score = 0;
    for (const w of fw) {
      const inRef = r.ref && wordStarts(r.ref, [w]);
      const inTitle = wordStarts(r.title, [w]);
      const inSub = wordStarts(r.sub, [w]);
      if (!inRef && !inTitle && !inSub) return null;
      if (inRef) { rr.push(...inRef); score += 30; }
      if (inTitle) { tr.push(...inTitle); score += 10; }
      else if (inSub) { sr.push(...inSub); score += 3; }
    }
    if (r.ref && fold(r.ref) === fw.join(" ")) score += 200;
    return { r, score: score - r.min / 10000, tr, rr, sr };
  }

  /** One finder session: recents, the asked kinds, and the remote groups that arrive late into held rows. */
  function session(onChange) {
    const recent = ["dec:d44", "w:b155", "c:" + STATE.sides[0].msgs[4].id, "dec:a22", "dec:g4:q2", "p:P6"];
    let q = "", tab = "all", more = new Set(), arrived = new Set(), timer = null, seq = 0;
    const CAP = 5, NARROW = 50;
    function groups() {
      const asked = readAsked(q);
      const kinds = asked.kind ? [asked.kind] : tab === "all" ? KINDS.map((k) => k.id) : [tab];
      const words = asked.words.split(/\s+/).filter(Boolean);
      if (!words.length && !asked.kind && tab === "all") {
        const rec = recent.map((id) => ALL.find((r) => r.id === id)).filter(Boolean).map((r) => ({ r, tr: [], rr: [], sr: [] }));
        const onYou = DECISIONS.filter((d) => d.status === "open" && !recent.includes("dec:" + d.id)).map((d) => ({ r: ALL.find((r) => r.id === "dec:" + d.id), tr: [], rr: [], sr: [] }));
        return [
          { id: "recent", heading: "Recent", rows: rec, more: 0 },
          { id: "onyou", heading: "On you", rows: onYou, more: 0 },
          { id: "prefixes", heading: "Search by", rows: KINDS.map((k) => ({ r: { id: "pre:" + k.prefix, kind: "prefix", ref: k.prefix, title: k.heading, sub: `start with “${k.prefix} ”`, hint: "", fill: k.prefix + " " }, tr: [], rr: [], sr: [] })), more: 0 },
        ];
      }
      return kinds.map((kid) => {
        const k = kindOf(kid);
        const found = ALL.filter((r) => r.kind === kid).map((r) => match(r, words)).filter(Boolean).sort((a, b) => b.score - a.score);
        const cap = kinds.length === 1 || more.has(kid) ? NARROW : CAP;
        const loading = k.remote && !arrived.has(kid);
        return { id: kid, heading: k.heading, rows: loading ? [] : found.slice(0, cap), more: loading ? 0 : Math.max(0, found.length - cap), loading, held: loading ? 2 : 0, kind: k };
      }).filter((g) => g.rows.length || g.loading);
    }
    const s = {
      get q() { return q; }, get tab() { return tab; },
      tabShown: () => readAsked(q).kind || tab,
      set(nq, ntab = tab) {
        const changed = nq !== q || ntab !== tab;
        q = nq; tab = ntab;
        if (changed) { more = new Set(); arrived = new Set(); clearTimeout(timer); const my = ++seq; if (readAsked(q).words) timer = setTimeout(() => { if (my !== seq) return; arrived = new Set(["chat", "log"]); onChange(); }, 380); else arrived = new Set(["chat", "log"]); }
      },
      more(id) { more.add(id); },
      opened(id) { const i = recent.indexOf(id); if (i >= 0) recent.splice(i, 1); recent.unshift(id); recent.length = Math.min(recent.length, 6); },
      groups,
      cancel() { clearTimeout(timer); },
    };
    return s;
  }

  /* ---------- shared bits of the three ---------- */
  /** Opens a dialog without the top layer, so the prototype's picker stays above it; a scrim and Esc close it. */
  function showNM(d) {
    let scrim = d.previousElementSibling?.classList.contains("fd-scrim") ? d.previousElementSibling : null;
    if (!scrim) {
      scrim = document.createElement("div"); scrim.className = "fd-scrim"; d.before(scrim);
      scrim.addEventListener("click", () => d.close());
      d.addEventListener("close", () => (scrim.hidden = true));
      d.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); d.close(); } });
    }
    scrim.hidden = false; d.show();
  }
  const flat = (gs) => gs.flatMap((g) => [...g.rows.map((x) => ({ type: "row", x, g })), ...(g.more ? [{ type: "more", g }] : [])]);
  const keyOf = (it) => (it.type === "row" ? it.g.id + "|" + it.x.r.id : "more:" + it.g.id);
  const rowHtml = (it, active, opts = {}) => {
    if (it.type === "more") return `<li class="fd-row fd-more" role="option" data-key="${keyOf(it)}" aria-selected="${active}"><span class="t">Show ${it.g.more} more ${esc(it.g.heading.toLowerCase())}</span></li>`;
    const { r, tr, rr, sr } = it.x;
    const ref = r.ref ? `<span class="ref">${marked(r.ref, rr)}</span> ` : "";
    return `<li class="fd-row${r.kind === "prefix" ? " fd-prefix" : ""}" role="option" id="fd-${esc(keyOf(it))}" data-key="${esc(keyOf(it))}" aria-selected="${active}"><span class="t">${ref}${marked(r.title, tr)}</span><span class="h">${r.kind === "prefix" ? `<kbd>${esc(r.ref)}</kbd>` : r.hint ? (["blocking", "open", "running", "blocked", "done", "decided", "current"].includes(r.hint) ? pill(r.hint, r.hint) : esc(r.hint)) : ""}</span><span class="s">${marked(r.sub, sr)}</span>${opts.second && active && r.second ? `<span class="fd-2">${MOD}+↵ ${esc(r.second)}</span>` : ""}</li>`;
  };
  const placeholders = (n) => Array.from({ length: n }, () => `<li class="fd-row fd-ph" aria-hidden="true"><span class="t"><i></i></span><span class="s"><i></i></span></li>`).join("");
  const legend = (second) => `<kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>${MOD}</kbd>+<kbd>↵</kbd> <span class="fd-second">${esc(second || "second action")}</span> <kbd>Tab</kbd> kinds <kbd>Esc</kbd> close`;
  const tabsHtml = (shown, cls = "fd-tabs") => `<div class="${cls}" role="tablist" aria-label="Kinds">${TABS.map((t) => `<button type="button" role="tab" tabindex="-1" data-tab="${t.id}" aria-selected="${t.id === shown}">${esc(t.label)}${t.prefix ? `<kbd>${t.prefix}</kbd>` : ""}</button>`).join("")}</div>`;

  /** What a row does, in this ground: opens it (Enter) or its second action (Mod+Enter). */
  function act(ui, r, second, chatSay) {
    const g = r.go || {};
    if (!second) {
      if (g.decision) return ui.show("decisions", g.decision);
      if (g.worker) { ui.show("fleet"); return ui.flash(document.querySelector(`[data-worker="${g.worker}"]`)); }
      if (g.step) { ui.show("plan"); return ui.flash(document.querySelector(`[data-step="${g.step}"]`)); }
      if (g.url) return ui.toast("Would open " + g.url + " in a new tab");
      if (g.fleet) return ui.toast(`Would go to ${g.fleet}'s page`);
      if (g.log !== undefined) { ui.show("log"); return ui.flash(document.querySelector(`[data-log="${g.log}"]`)); }
      if (g.msg) { ui.openChat(); return ui.flash(document.querySelector(`#chat [data-msg="${g.msg}"] .msg`)); }
      if (g.side) return ui.toast(`Would open the side chat “${line(STATE.sides.find((s) => s.id === g.side).title, 50)}”`);
      return;
    }
    if (r.kind === "decisions") return chatSay(`Sobre ${r.ref}: `);
    if (r.kind === "workers") return chatSay(`@${r.ref} `);
    if (r.kind === "fleets") return chatSay(`@${r.title} `);
    if (r.kind === "chat") return g.side ? (ui.openChat(), ui.flash(document.querySelector(`#chat [data-msg]`))) : ui.toast(`Would start a side chat on “${line(r.title, 50)}”`);
    if (r.kind === "links") { navigator.clipboard?.writeText(g.url).catch(() => {}); return ui.toast("Copied " + g.url); }
    if (r.by) { ui.show("fleet"); return ui.flash(document.querySelector(`[data-worker="${r.by}"]`)); }
  }

  /** The ground with the chat's composer wired, and Ctrl/⌘K bound to `open`. */
  function ground(stage, signal, open) {
    const ui = mountShell(stage, { chatBody: `<ol class="chat-log">${renderLog(STATE.main)}</ol>${composer()}` }, signal);
    const log = stage.querySelector("#chat .chat-log");
    log.scrollTop = log.scrollHeight;
    const cw = wireComposer(stage.querySelector("#chat .composer"), { signal, onSend: (text) => { STATE.main.push(P.mkMsg([0, "user", text])); log.innerHTML = renderLog(STATE.main); log.scrollTop = log.scrollHeight; } });
    const chatSay = (text) => { ui.openChat(); cw.set(text); cw.focus(); };
    stage.querySelector("#find-open").addEventListener("click", () => open(), { signal });
    document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); } }, { signal });
    return { ui, chatSay };
  }

  /** Keyboard and list behaviour shared by Palette and Preview: the highlight held by its row's id. */
  function listCtl({ input, s, draw, choose }) {
    let key = null;
    const items = () => flat(s.groups());
    const idx = () => { const it = items(); const i = it.findIndex((x) => keyOf(x) === key); return i < 0 ? 0 : i; };
    return {
      key: () => key,
      sync() { const it = items(); if (!it.some((x) => keyOf(x) === key)) key = it[0] ? keyOf(it[0]) : null; },
      move(d) { const it = items(); if (!it.length) return; key = keyOf(it[(idx() + d + it.length) % it.length]); draw(); },
      set(k) { key = k; },
      onKey(e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.move(e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Tab") { e.preventDefault(); const shown = s.tabShown(); const i = TABS.findIndex((t) => t.id === shown); const next = TABS[(i + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length]; const a = /^([a-z])\s(.*)$/i.exec(input.value); const words = a && KINDS.some((k) => k.prefix === a[1].toLowerCase()) ? a[2] : input.value; input.value = words; s.set(words, next.id); key = null; this.sync(); draw(); }
        else if (e.key === "Enter") { e.preventDefault(); const it = items()[idx()]; if (it) choose(it, e.metaKey || e.ctrlKey); }
      },
    };
  }

  /* ---------- 1. Palette: Casos's navigator, one list in sections ---------- */
  function Palette(stage, signal) {
    let dlg, s, ctl, ui, chatSay;
    ({ ui, chatSay } = ground(stage, signal, () => openIt()));
    dlg = document.createElement("dialog");
    dlg.className = "sheet finder fd-palette";
    dlg.setAttribute("aria-label", "Search");
    dlg.innerHTML = `<div class="finder-in"><div class="fd-field"><span class="fd-glass">${I.search}</span><input type="search" role="combobox" aria-expanded="true" aria-controls="fd-list" autocomplete="off" spellcheck="false" placeholder="Search D44, a worker, words… or start with d w c p l g f"><button type="button" class="icon-btn fd-close" aria-label="Close">${I.close}</button></div>${tabsHtml("all")}<ul class="find-list" id="fd-list" role="listbox"></ul><p class="find-foot muted"></p></div>`;
    stage.appendChild(dlg);
    const input = dlg.querySelector("input"), list = dlg.querySelector(".find-list");
    s = session(() => { ctl.sync(); draw(); });
    const draw = () => {
      ctl.sync();
      const gs = s.groups();
      const k = ctl.key();
      const prevTop = list.scrollTop;
      list.innerHTML = gs.map((g) => `<li class="find-group" role="presentation">${esc(g.heading)}${g.loading ? ` <span class="fd-spin" aria-label="searching"></span>` : ""}</li>` + g.rows.map((x) => rowHtml({ type: "row", x, g }, keyOf({ type: "row", x, g }) === k)).join("") + (g.loading ? placeholders(g.held) : "") + (g.more ? rowHtml({ type: "more", g }, "more:" + g.id === k) : "")).join("") || `<li class="find-empty">Nothing matches “${esc(readAsked(s.q).words)}”.</li>`;
      list.scrollTop = prevTop;
      dlg.querySelector(".fd-tabs").outerHTML = tabsHtml(s.tabShown());
      const cur = flat(gs).find((it) => keyOf(it) === k);
      dlg.querySelector(".find-foot").innerHTML = legend(cur?.type === "row" ? cur.x.r.second : null);
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", k ? "fd-" + k : "");
    };
    const choose = (it, second) => {
      if (it.type === "more") { s.more(it.g.id); draw(); return; }
      const r = it.x.r;
      if (r.fill) { input.value = r.fill; s.set(r.fill); ctl.set(null); draw(); input.focus(); return; }
      s.opened(r.id); dlg.close(); act(ui, r, second, chatSay);
    };
    ctl = listCtl({ input, s, draw, choose });
    function openIt() { if (dlg.open) { input.select(); return; } input.value = ""; s.set(""); ctl.set(null); draw(); showNM(dlg); input.focus(); }
    input.addEventListener("input", () => { s.set(input.value); ctl.set(null); draw(); }, { signal });
    input.addEventListener("keydown", (e) => ctl.onKey(e), { signal });
    list.addEventListener("click", (e) => { const li = e.target.closest("[data-key]"); if (!li) return; const it = flat(s.groups()).find((x) => keyOf(x) === li.dataset.key); if (it) choose(it, e.metaKey || e.ctrlKey); }, { signal });
    list.addEventListener("pointermove", (e) => { const li = e.target.closest("[data-key]"); if (li && li.dataset.key !== ctl.key()) { ctl.set(li.dataset.key); list.querySelectorAll("[aria-selected]").forEach((x) => x.setAttribute("aria-selected", String(x === li))); const it = flat(s.groups()).find((x) => keyOf(x) === li.dataset.key); dlg.querySelector(".find-foot").innerHTML = legend(it?.type === "row" ? it.x.r.second : null); } }, { signal });
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest(".fd-close")) dlg.close(); const t = e.target.closest("[data-tab]"); if (t) { input.value = readAsked(input.value).kind ? readAsked(input.value).words : input.value; s.set(input.value, t.dataset.tab); ctl.set(null); draw(); input.focus(); } }, { signal });
    signal.addEventListener("abort", () => { s.cancel(); dlg.previousElementSibling?.remove(); dlg.remove(); });
    if (new URLSearchParams(location.search).get("open") !== "0") openIt();
  }

  /* ---------- 2. Preview: kinds as a rail, the list, and the highlighted row's record beside it ---------- */
  function preview(r) {
    if (!r) return `<p class="fd-pv-empty">Nothing highlighted.</p>`;
    if (r.kind === "prefix") return `<div class="fd-pv-k">Search by</div><h3>${esc(r.title)}</h3><p class="muted">Start the query with <kbd>${esc(r.ref)}</kbd> and a space, or press Tab until the rail shows ${esc(r.title)}.</p>`;
    const k = kindOf(r.kind);
    let body = "";
    if (r.d) body = `<div class="dv-pills">${pill(r.d.status === "open" ? (r.d.blocking ? "blocking" : "open") : "decided", r.d.status === "open" ? (r.d.blocking ? "Open, blocking" : "Open") : "Decided")}${pill("", kindWord[r.d.kind])}</div><p class="fd-pv-q">${P.inline(r.d.question)}</p>${r.d.why ? `<h4>${r.d.blocking ? "What it blocks" : "Meanwhile"}</h4><p>${P.inline(r.d.why)}</p>` : ""}${r.d.options.length ? `<h4>Options</h4><ul class="fd-pv-opts">${r.d.options.map((o) => `<li><b>${o.id}</b> ${esc(o.label)}${o.id === r.d.recommend ? " " + pill("recommended", "recommended") : ""}</li>`).join("")}</ul>` : ""}<p class="muted">${esc(r.d.fleet)}${r.d.agent ? ", for " + r.d.agent : ""}, ${ago(r.d.opened)}</p>`;
    else if (r.kind === "workers") { const p = PEOPLE[r.ref]; body = `<div class="dv-pills">${pill(p.status, p.status)}</div><p>${esc(p.task)}</p><dl class="facts"><div><dt>Fleet</dt><dd>${esc(p.fleet)}</dd></div><div><dt>Model</dt><dd>${esc(p.model)}</dd></div><div><dt>Skill</dt><dd>/${esc(p.skill)}</dd></div></dl>`; }
    else if (r.kind === "chat") { const i = STATE.main.findIndex((m) => m.id === r.m.id); const ctx = i >= 0 ? STATE.main.slice(Math.max(0, i - 1), i + 2) : [r.m]; body = `<ol class="thread-list fd-pv-chat">${renderLog(ctx, { noDays: true })}</ol>`; }
    else body = `<p>${esc(r.title)}</p><p class="muted">${esc(r.sub)}</p>`;
    return `<div class="fd-pv-k">${esc(k.heading)}</div><h3>${r.ref ? `<span class="ref">${esc(r.ref)}</span> ` : ""}${esc(line(r.title, 120))}</h3>${body}
      <div class="fd-pv-act"><button type="button" class="btn primary" data-pv="open">Open <kbd>↵</kbd></button>${r.second ? `<button type="button" class="btn" data-pv="second">${esc(r.second)} <kbd>${MOD}+↵</kbd></button>` : ""}</div>`;
  }
  function Preview(stage, signal) {
    let s, ctl, ui, chatSay;
    ({ ui, chatSay } = ground(stage, signal, () => openIt()));
    const dlg = document.createElement("dialog");
    dlg.className = "sheet finder fd-preview";
    dlg.setAttribute("aria-label", "Search");
    dlg.innerHTML = `<div class="fd-pv-grid"><div class="fd-field"><span class="fd-glass">${I.search}</span><input type="search" role="combobox" aria-expanded="true" autocomplete="off" spellcheck="false" placeholder="Search everything, or start with d w c p l g f"><button type="button" class="icon-btn fd-close" aria-label="Close">${I.close}</button></div>${tabsHtml("all", "fd-rail")}<ul class="find-list" role="listbox"></ul><aside class="fd-pv" aria-live="polite"></aside><p class="find-foot muted"></p></div>`;
    stage.appendChild(dlg);
    const input = dlg.querySelector("input"), list = dlg.querySelector(".find-list"), pv = dlg.querySelector(".fd-pv");
    s = session(() => draw());
    const current = () => flat(s.groups()).find((it) => keyOf(it) === ctl.key());
    const drawPv = () => { const it = current(); pv.innerHTML = it?.type === "row" ? preview(it.x.r) : it ? `<div class="fd-pv-k">${esc(it.g.heading)}</div><h3>${it.g.more} more</h3><p class="muted">Enter draws them under the five shown; nothing above moves.</p>` : preview(null); dlg.querySelector(".find-foot").innerHTML = legend(it?.type === "row" ? it.x.r.second : null); };
    const draw = () => {
      ctl.sync();
      const gs = s.groups(), k = ctl.key(), top = list.scrollTop;
      list.innerHTML = gs.map((g) => `<li class="find-group" role="presentation">${esc(g.heading)}${g.loading ? ` <span class="fd-spin"></span>` : g.more ? ` <span class="faint">${g.rows.length + g.more}</span>` : ""}</li>` + g.rows.map((x) => rowHtml({ type: "row", x, g }, keyOf({ type: "row", x, g }) === k)).join("") + (g.loading ? placeholders(g.held) : "") + (g.more ? rowHtml({ type: "more", g }, "more:" + g.id === k) : "")).join("") || `<li class="find-empty">Nothing matches.</li>`;
      list.scrollTop = top;
      dlg.querySelector(".fd-rail").outerHTML = tabsHtml(s.tabShown(), "fd-rail");
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      drawPv();
    };
    const choose = (it, second) => {
      if (it.type === "more") { s.more(it.g.id); draw(); return; }
      const r = it.x.r;
      if (r.fill) { input.value = r.fill; s.set(r.fill); ctl.set(null); draw(); input.focus(); return; }
      s.opened(r.id); dlg.close(); act(ui, r, second, chatSay);
    };
    ctl = listCtl({ input, s, draw, choose });
    function openIt() { if (dlg.open) return input.select(); input.value = ""; s.set(""); ctl.set(null); draw(); showNM(dlg); input.focus(); }
    input.addEventListener("input", () => { s.set(input.value); ctl.set(null); draw(); }, { signal });
    input.addEventListener("keydown", (e) => ctl.onKey(e), { signal });
    list.addEventListener("click", (e) => { const li = e.target.closest("[data-key]"); if (!li) return; const it = flat(s.groups()).find((x) => keyOf(x) === li.dataset.key); if (it) choose(it, e.metaKey || e.ctrlKey); }, { signal });
    list.addEventListener("pointermove", (e) => { const li = e.target.closest("[data-key]"); if (li && li.dataset.key !== ctl.key()) { ctl.set(li.dataset.key); list.querySelectorAll("[aria-selected]").forEach((x) => x.setAttribute("aria-selected", String(x === li))); drawPv(); } }, { signal });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest(".fd-close")) return dlg.close();
      const t = e.target.closest("[data-tab]"); if (t) { input.value = readAsked(input.value).kind ? readAsked(input.value).words : input.value; s.set(input.value, t.dataset.tab); ctl.set(null); draw(); input.focus(); return; }
      const b = e.target.closest("[data-pv]"); if (b) { const it = current(); if (it) choose(it, b.dataset.pv === "second"); }
    }, { signal });
    signal.addEventListener("abort", () => { s.cancel(); dlg.previousElementSibling?.remove(); dlg.remove(); });
    if (new URLSearchParams(location.search).get("open") !== "0") openIt();
  }

  /* ---------- 3. Board: every kind a column, side by side under the masthead ---------- */
  function Board(stage, signal) {
    let ui, chatSay;
    ({ ui, chatSay } = ground(stage, signal, () => openIt()));
    const panel = document.createElement("dialog");
    panel.className = "fd-board";
    panel.setAttribute("aria-label", "Search");
    panel.innerHTML = `<div class="fd-b-top"><div class="fd-field"><span class="fd-glass">${I.search}</span><input type="search" role="combobox" aria-expanded="true" autocomplete="off" spellcheck="false" placeholder="Search everything, or start with d w c p l g f"><button type="button" class="icon-btn fd-close" aria-label="Close">${I.close}</button></div><p class="find-foot muted"></p></div><div class="fd-cols"></div>`;
    stage.appendChild(panel);
    const input = panel.querySelector("input"), cols = panel.querySelector(".fd-cols");
    const s = session(() => draw());
    let col = 0, key = null;
    const visible = () => s.groups();
    const sync = () => {
      const gs = visible();
      col = Math.min(col, Math.max(0, gs.length - 1));
      const items = gs[col] ? flat([gs[col]]) : [];
      if (!items.some((x) => keyOf(x) === key)) key = items[0] ? keyOf(items[0]) : null;
    };
    const draw = () => {
      sync();
      const gs = visible();
      const asked = readAsked(s.q).kind || (s.tab !== "all" ? s.tab : null);
      cols.classList.toggle("one", gs.length === 1);
      cols.innerHTML = gs.map((g, i) => `<section class="fd-col${i === col ? " on" : ""}" data-col="${i}"><button type="button" class="fd-col-h" data-colh="${g.id}" tabindex="-1">${esc(g.heading)}${g.kind ? `<kbd>${g.kind.prefix}</kbd>` : ""}${g.loading ? `<span class="fd-spin"></span>` : `<span class="faint num">${g.rows.length + g.more}</span>`}</button><ul class="find-list" role="listbox">${g.rows.map((x) => rowHtml({ type: "row", x, g }, i === col && keyOf({ type: "row", x, g }) === key, { second: true })).join("")}${g.loading ? placeholders(g.held) : ""}${g.more ? rowHtml({ type: "more", g }, i === col && "more:" + g.id === key) : ""}</ul></section>`).join("") || `<p class="find-empty">Nothing matches “${esc(readAsked(s.q).words)}”.</p>`;
      if (asked) cols.insertAdjacentHTML("afterbegin", `<button type="button" class="fd-back" data-all>${I.back}All kinds</button>`);
      const cur = gs[col] ? flat([gs[col]]).find((x) => keyOf(x) === key) : null;
      panel.querySelector(".find-foot").innerHTML = `<kbd>↑</kbd><kbd>↓</kbd> move <kbd>Tab</kbd> next column <kbd>↵</kbd> open <kbd>${MOD}</kbd>+<kbd>↵</kbd> <span class="fd-second">${esc(cur?.type === "row" ? cur.x.r.second || "second action" : "second action")}</span> <kbd>Esc</kbd> close`;
      cols.querySelector(".fd-col.on [aria-selected='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const choose = (it, second) => {
      if (it.type === "more") { s.more(it.g.id); draw(); return; }
      const r = it.x.r;
      if (r.fill) { input.value = r.fill; s.set(r.fill); key = null; col = 0; draw(); input.focus(); return; }
      s.opened(r.id); panel.close(); act(ui, r, second, chatSay);
    };
    function openIt() { if (panel.open) return input.select(); input.value = ""; s.set(""); col = 0; key = null; draw(); showNM(panel); input.focus(); }
    input.addEventListener("input", () => { s.set(input.value); key = null; col = 0; draw(); }, { signal });
    input.addEventListener("keydown", (e) => {
      const gs = visible();
      const items = gs[col] ? flat([gs[col]]) : [];
      const i = Math.max(0, items.findIndex((x) => keyOf(x) === key));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (items.length) key = keyOf(items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]); draw(); }
      else if (e.key === "Tab") { e.preventDefault(); if (gs.length > 1) { col = (col + (e.shiftKey ? -1 : 1) + gs.length) % gs.length; const its = flat([gs[col]]); key = its[Math.min(i, its.length - 1)] ? keyOf(its[Math.min(i, its.length - 1)]) : null; draw(); } }
      else if (e.key === "Enter") { e.preventDefault(); const it = items.find((x) => keyOf(x) === key); if (it) choose(it, e.metaKey || e.ctrlKey); }
    }, { signal });
    panel.addEventListener("click", (e) => {
      if (e.target === panel || e.target.closest(".fd-close")) return panel.close();
      if (e.target.closest("[data-all]")) { input.value = readAsked(input.value).words; s.set(input.value, "all"); col = 0; key = null; draw(); input.focus(); return; }
      const h = e.target.closest("[data-colh]"); if (h && kindOf(h.dataset.colh)) { input.value = readAsked(input.value).words; s.set(input.value, h.dataset.colh); col = 0; key = null; draw(); input.focus(); return; }
      const li = e.target.closest("[data-key]"); if (!li) return;
      const c = Number(li.closest("[data-col]").dataset.col); const gs = visible();
      const it = flat([gs[c]]).find((x) => keyOf(x) === li.dataset.key); if (it) choose(it, e.metaKey || e.ctrlKey);
    }, { signal });
    cols.addEventListener("pointermove", (e) => { const li = e.target.closest("[data-key]"); if (!li) return; const c = Number(li.closest("[data-col]").dataset.col); if (c !== col || li.dataset.key !== key) { col = c; key = li.dataset.key; draw(); } }, { signal });
    signal.addEventListener("abort", () => { s.cancel(); panel.previousElementSibling?.remove(); panel.remove(); });
    if (new URLSearchParams(location.search).get("open") !== "0") openIt();
  }

  /* The finder covers the top of a phone; the picker stays at the bottom there. */
  window.PICKER_TOP_ON_PHONE = false;
  window.variants = [Palette, Preview, Board];
})();
