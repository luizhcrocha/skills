/* PROTOTYPE: side chats. Question: how should the user navigate side chats (see all of them, find one used
   minutes ago, archive and unarchive, and come back to the main thread where they left it, not at the top)?
   Three variants: Tabs (a strip of side chats, browser-tab model), Inbox (a list view, Slack's Threads),
   Split (the main thread never leaves; a side chat opens in a pane under it). */
(() => {
  const { esc, line, short, ago, clock, at, PEOPLE, I, renderLog, composer, wireComposer, mountShell, mkMsg, decisionById } = P;

  /* ---------- shared by the three variants ---------- */
  const fresh = () => structuredClone(P.STATE);
  const lastOf = (s) => Math.min(...s.msgs.map((m) => m.min));
  const byRecent = (a, b) => lastOf(a) - lastOf(b);
  const source = (s) => {
    if (s.from.kind === "decision") { const d = decisionById(s.from.ref); return `<a href="#" class="sc-src" data-open-decision="${d ? d.id : ""}">${I.up}From ${esc(s.from.label)}</a>`; }
    return `<a href="#" class="sc-src" data-jump-msg="${s.from.msg}">${I.up}From ${esc(s.from.label)}, ${clock(at(P.STATE.main.find((m) => m.id === s.from.msg)?.min ?? 0))}</a>`;
  };
  const lastLine = (s) => { const m = s.msgs[s.msgs.length - 1]; return `${m.from === "user" ? "You" : PEOPLE[m.from]?.name || m.from}: ${line(m.text, 70)}`; };
  const REPLIES = [
    ["infra-coordinator", "Noted. I'll answer here and keep the main thread clear."],
    ["b155", "Checked: the guard skips them, and the next pass at 17:00 will show it."],
    ["ui-coordinator", "Boa pergunta. b196 confirms: the list keeps its order by last message."],
  ];
  const replyFor = (s) => { const who = s ? [...s.msgs].reverse().find((m) => m.from !== "user")?.from : null; const r = REPLIES[Math.floor(Math.random() * REPLIES.length)]; return [who || r[0], r[1]]; };

  /** Where a side chat shows in the main thread: after the message it quotes, else where it started. */
  const anchorOf = (st, s) => {
    if (s.from.kind === "chat") return s.from.msg;
    const first = Math.max(...s.msgs.map((m) => m.min));
    const before = st.main.filter((m) => m.min >= first);
    return before.length ? before[before.length - 1].id : st.main[0].id;
  };

  /** The selection toolbar the real page shows on chat text: Copy, Reply, Side chat. */
  function selTool(stage, signal, onSide) {
    const tool = document.createElement("div");
    tool.className = "seltool"; tool.hidden = true; tool.setAttribute("role", "toolbar");
    tool.innerHTML = `<button type="button" data-sel="copy">Copy</button><button type="button" data-sel="side">Side chat</button>`;
    stage.appendChild(tool);
    let picked = null;
    document.addEventListener("selectionchange", () => {
      const sel = getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      const node = sel?.anchorNode?.parentElement;
      const msg = node?.closest?.("[data-msg]");
      if (!text || !msg || !node.closest(".chat-log")) { tool.hidden = true; picked = null; return; }
      picked = { text, msg: Number(msg.dataset.msg) };
      const r = sel.getRangeAt(0).getBoundingClientRect();
      tool.hidden = false;
      tool.style.top = Math.max(8, r.top - 50) + "px";
      tool.style.left = Math.min(innerWidth - 190, Math.max(8, r.left + r.width / 2 - 80)) + "px";
    }, { signal });
    tool.addEventListener("pointerdown", (e) => e.preventDefault(), { signal });
    tool.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sel]");
      if (!b || !picked) return;
      if (b.dataset.sel === "copy") { navigator.clipboard?.writeText(picked.text).catch(() => {}); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 900); return; }
      const p = picked; tool.hidden = true; getSelection().removeAllRanges(); onSide(p);
    }, { signal });
  }
  const newSide = (st, p) => {
    const src = st.main.find((m) => m.id === p.msg);
    const s = { id: Math.max(...st.sides.map((x) => x.id)) + 1, title: line(p.text, 80), from: { kind: "chat", msg: p.msg, label: `${src.from === "user" ? "you" : src.from} in the chat` }, archived: false, unread: 0, msgs: [] };
    st.sides.push(s);
    return s;
  };
  const sideLog = (s) => s.msgs.length ? renderLog(s.msgs, { noDays: true }) : `<li class="chat-empty">A side chat, apart from the main one. Ask about the quote, and the coordinator answers here.</li>`;
  const quoteHead = (s) => `<div class="sc-quote"><span class="sc-quote-k">${s.archived ? "Archived side chat" : "Side chat"} on</span><q>${esc(line(s.title, 140))}</q>${source(s)}</div>`;

  /** The main thread's position, kept when it is left and given back with a marker when it returns. */
  function keeper() {
    let top = null, anchor = null;
    return {
      save(log) {
        if (!log) return;
        top = log.scrollTop;
        const lr = log.getBoundingClientRect();
        anchor = [...log.querySelectorAll("[data-msg]")].find((li) => li.getBoundingClientRect().bottom > lr.top + 8)?.dataset.msg ?? null;
      },
      restore(log) {
        if (!log) return;
        if (top === null) { log.scrollTop = log.scrollHeight; return; }
        log.scrollTop = top;
        const li = anchor && log.querySelector(`[data-msg="${anchor}"]`);
        if (li) { const mark = document.createElement("li"); mark.className = "sc-left"; mark.innerHTML = "<span>You left here</span>"; li.before(mark); log.scrollTop = top; log.scrollTop += mark.getBoundingClientRect().top - log.getBoundingClientRect().top - 12; setTimeout(() => mark.classList.add("gone"), 2600); }
      },
      where: () => anchor,
    };
  }
  const reply = (st, s, rerender, delay = 900) => setTimeout(() => {
    const [from, text] = replyFor(s);
    const m = mkMsg([0, from, text], s ? { side: s.id } : {});
    (s ? s.msgs : st.main).push(m);
    rerender(s, true);
  }, delay);

  /* ---------- 1. Tabs: a strip of side chats under the head, the main thread its first tab ---------- */
  function Tabs(stage, signal) {
    const st = fresh();
    let on = null; // null: the main thread
    let filter = "";
    const keep = keeper();
    const ui = mountShell(stage, { chatBody: `<div class="sc-strip" role="tablist" aria-label="Chats"></div><div class="sc-pop" hidden></div><div class="sc-ctx"></div><ol class="chat-log"></ol><div class="sc-undo" hidden></div>${composer()}` }, signal);
    const $ = (s) => stage.querySelector(s);
    const log = () => $(".chat-log");
    const active = () => st.sides.filter((s) => !s.archived).sort(byRecent);
    const archived = () => st.sides.filter((s) => s.archived).sort(byRecent);

    const strip = () => {
      const unreadMain = 0;
      $(".sc-strip").innerHTML = `<button type="button" role="tab" class="sc-tab sc-main" aria-selected="${on === null}" data-tab="main">Main${unreadMain ? `<span class="sc-n">${unreadMain}</span>` : ""}</button>
        <div class="sc-scroll">${active().map((s) => `<span class="sc-tabwrap"><button type="button" role="tab" class="sc-tab" aria-selected="${on === s.id}" data-tab="${s.id}" title="${esc(s.title)} · ${ago(lastOf(s))}"><span class="sc-t">${esc(line(s.title, 28))}</span><span class="sc-time">${short(lastOf(s))}</span>${s.unread ? `<span class="sc-n">${s.unread}</span>` : ""}</button><button type="button" class="sc-x" data-archive="${s.id}" aria-label="Archive ${esc(line(s.title, 30))}" title="Archive">${I.closeS}</button></span>`).join("")}</div>
        <button type="button" class="sc-all" aria-expanded="${!$(".sc-pop").hidden}" title="Every side chat, archived too (Alt+← → switch tabs)">All <span class="num">${st.sides.length}</span> <span aria-hidden="true">▾</span></button>`;
      $(`.sc-tab[aria-selected="true"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const pop = () => {
      const f = P.fold(filter);
      const hit = (s) => !f || P.fold(s.title + " " + s.msgs.map((m) => m.text).join(" ")).includes(f);
      const row = (s) => `<li><button type="button" class="sc-row" data-open="${s.id}"><span class="sc-row-t">${esc(line(s.title, 60))}</span><span class="sc-row-s">${esc(lastLine(s))}</span><span class="sc-row-k">${esc(s.from.label)} · ${ago(lastOf(s))}${s.unread ? ` · <b>${s.unread} new</b>` : ""}</span></button><button type="button" class="icon-btn" data-${s.archived ? "unarchive" : "archive"}="${s.id}" aria-label="${s.archived ? "Unarchive" : "Archive"}" title="${s.archived ? "Unarchive" : "Archive"}">${s.archived ? I.unarchive : I.archive}</button></li>`;
      const a = active().filter(hit), z = archived().filter(hit);
      $(".sc-pop").innerHTML = `<input type="search" class="sc-find" placeholder="Find a side chat" value="${esc(filter)}" aria-label="Find a side chat">
        <ul class="sc-list">${a.map(row).join("") || `<li class="sc-none">No open side chat matches.</li>`}</ul>
        <h3 class="sc-h">Archived <span class="num">${z.length}</span></h3><ul class="sc-list">${z.map(row).join("") || `<li class="sc-none">${filter ? "None matches." : "None."}</li>`}</ul>`;
    };
    const body = (scrollEnd) => {
      const s = on === null ? null : st.sides.find((x) => x.id === on);
      $(".sc-ctx").innerHTML = s ? quoteHead(s) : "";
      $(".sc-ctx").hidden = !s;
      log().innerHTML = s ? sideLog(s) : renderLog(st.main, { after: (m) => active().concat(archived()).filter((x) => anchorOf(st, x) === m.id).map((x) => `<li class="side-link"><button type="button" data-tab="${x.id}"><span class="side-kicker">${x.archived ? "Archived side chat" : "Side chat"} · ${x.msgs.length} message${x.msgs.length === 1 ? "" : "s"}</span><span class="side-text">${esc(line(x.title, 120))}</span></button></li>`).join("") });
      $(".composer textarea").placeholder = s ? "Ask in this side chat, or type @ or /" : "Message the fleet, or type @ or /";
      if (s) log().scrollTop = scrollEnd === false ? 0 : log().scrollHeight;
    };
    const go = (id) => {
      if (on === null) keep.save(log());
      on = id;
      const s = st.sides.find((x) => x.id === id);
      if (s) { s.unread = 0; if (s.archived) s.archived = false; }
      strip(); body();
      if (id === null) keep.restore(log());
    };
    const archive = (id, undo = true) => {
      const s = st.sides.find((x) => x.id === id);
      s.archived = true;
      if (on === id) go(null); else { strip(); if (on === null) { const t = log().scrollTop; body(); log().scrollTop = t; } }
      if (!$(".sc-pop").hidden) pop();
      if (undo) {
        const u = $(".sc-undo");
        u.innerHTML = `Archived “${esc(line(s.title, 40))}”. <button type="button" data-unarchive="${id}">Undo</button>`;
        u.hidden = false; clearTimeout(archive.t); archive.t = setTimeout(() => (u.hidden = true), 4000);
      }
    };
    const unarchive = (id) => { st.sides.find((x) => x.id === id).archived = false; $(".sc-undo").hidden = true; strip(); if (!$(".sc-pop").hidden) pop(); };

    strip(); body(); keep.restore(log());
    const rer = (s) => { if ((s && on === s.id) || (!s && on === null)) { body(); log().scrollTop = log().scrollHeight; } else if (s) { s.unread++; strip(); } };
    wireComposer($(".composer"), { signal, onSend: (text) => {
      const s = on === null ? null : st.sides.find((x) => x.id === on);
      (s ? s.msgs : st.main).push(mkMsg([0, "user", text], s ? { side: s.id } : {}));
      body(); log().scrollTop = log().scrollHeight; strip();
      reply(st, s, rer);
    } });
    selTool(stage, signal, (p) => { const s = newSide(st, p); go(s.id); $(".composer textarea").focus(); });

    stage.querySelector("#chat").addEventListener("click", (e) => {
      const t = e.target;
      const ar = t.closest("[data-archive]"); if (ar) { e.stopPropagation(); archive(Number(ar.dataset.archive)); return; }
      const un = t.closest("[data-unarchive]"); if (un) { unarchive(Number(un.dataset.unarchive)); return; }
      const tab = t.closest("[data-tab]"); if (tab) { go(tab.dataset.tab === "main" ? null : Number(tab.dataset.tab)); return; }
      const op = t.closest("[data-open]"); if (op) { $(".sc-pop").hidden = true; go(Number(op.dataset.open)); return; }
      if (t.closest(".sc-all")) { const p = $(".sc-pop"); p.hidden = !p.hidden; if (!p.hidden) { pop(); p.querySelector("input").focus(); } strip(); return; }
      const j = t.closest("[data-jump-msg]"); if (j) { e.preventDefault(); const id = j.dataset.jumpMsg; go(null); ui.flash(log().querySelector(`[data-msg="${id}"] .msg`)); }
    }, { signal });
    stage.querySelector("#chat").addEventListener("input", (e) => { if (e.target.matches(".sc-find")) { filter = e.target.value; const pos = e.target.selectionStart; pop(); const f = $(".sc-find"); f.focus(); f.setSelectionRange(pos, pos); } }, { signal });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$(".sc-pop").hidden) { e.preventDefault(); $(".sc-pop").hidden = true; strip(); return; }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const order = [null, ...active().map((s) => s.id)];
        const i = order.indexOf(on);
        go(order[(i + (e.key === "ArrowRight" ? 1 : -1) + order.length) % order.length]);
      }
    }, { signal });
    document.addEventListener("pointerdown", (e) => { const p = $(".sc-pop"); if (p && !p.hidden && !e.target.closest(".sc-pop, .sc-all")) { p.hidden = true; strip(); } }, { signal });
  }

  /* ---------- 2. Inbox: one list of every side chat; the main thread is its top row ---------- */
  function Inbox(stage, signal) {
    const st = fresh();
    let on = "main"; // "main" | "list" | side id
    let tab = "active", filter = "";
    const keep = keeper();
    const head = `<header class="chat-head"><nav class="sc-crumbs" aria-label="Chat"></nav><span class="conn" data-conn="live" role="status">Live</span><button type="button" class="icon-btn" id="chat-close" aria-label="Hide chat" title="Hide chat">${I.close}</button></header>
      <div class="chat-tools"><button type="button" class="sc-inbox-btn" data-go="list"></button><button type="button" class="switch" id="chat-decisions" role="switch" aria-checked="true"><span class="switch-track" aria-hidden="true"></span>Decision activity</button></div>`;
    const ui = mountShell(stage, { chatHead: head, chatBody: `<div class="sc-inbox" hidden></div><div class="sc-ctx" hidden></div><ol class="chat-log"></ol>${composer()}` }, signal);
    const $ = (s) => stage.querySelector(s);
    const log = () => $(".chat-log");
    const unread = () => st.sides.filter((s) => !s.archived).reduce((n, s) => n + s.unread, 0);

    const crumbs = () => {
      const s = typeof on === "number" ? st.sides.find((x) => x.id === on) : null;
      $(".sc-crumbs").innerHTML = on === "main" ? `<h2 id="chat-title">Chat</h2>`
        : on === "list" ? `<button type="button" class="sc-crumb" data-go="main">Chat</button><span class="sc-sep">/</span><h2>Side chats</h2>`
        : `<button type="button" class="sc-crumb" data-go="main">Chat</button><span class="sc-sep">/</span><button type="button" class="sc-crumb" data-go="list">Side chats</button><span class="sc-sep">/</span><h2 class="sc-crumb-t">${esc(line(s.title, 26))}</h2>`;
      const n = unread();
      const b = $(".sc-inbox-btn");
      b.innerHTML = on === "list" ? `${I.back}Back to the chat` : `${I.side}Side chats <span class="num">${st.sides.filter((x) => !x.archived).length}</span>${n ? `<span class="badge">${n}</span>` : ""}`;
      b.dataset.go = on === "list" ? "main" : "list";
    };
    const list = () => {
      const f = P.fold(filter);
      const pool = st.sides.filter((s) => (tab === "archived") === s.archived).filter((s) => !f || P.fold(s.title + " " + s.msgs.map((m) => m.text).join(" ")).includes(f)).sort(byRecent);
      const groups = [["Last hour", (s) => lastOf(s) < 60], ["Today", (s) => lastOf(s) >= 60 && lastOf(s) < 1000], ["Earlier", (s) => lastOf(s) >= 1000]];
      const mainAt = st.main.find((m) => String(m.id) === keep.where()) || st.main[st.main.length - 1];
      const row = (s) => `<li class="sc-irow${s.unread ? " unread" : ""}"><button type="button" class="sc-ibtn" data-go="${s.id}">
          <span class="sc-ik">${esc(s.from.label)}</span><time class="sc-it">${short(lastOf(s))}</time>
          <span class="sc-ititle">${esc(line(s.title, 90))}</span>
          <span class="sc-ilast">${esc(lastLine(s))}</span>${s.unread ? `<span class="badge sc-ibadge">${s.unread}</span>` : ""}</button>
          <button type="button" class="icon-btn sc-iarch" data-${s.archived ? "unarchive" : "archive"}="${s.id}" aria-label="${s.archived ? "Unarchive" : "Archive"}" title="${s.archived ? "Unarchive" : "Archive"}">${s.archived ? I.unarchive : I.archive}</button></li>`;
      const counts = { active: st.sides.filter((s) => !s.archived).length, archived: st.sides.filter((s) => s.archived).length };
      $(".sc-inbox").innerHTML = `<div class="sc-ihead"><input type="search" class="sc-find" placeholder="Find a side chat by its quote or words" value="${esc(filter)}" aria-label="Find a side chat">
          <div class="seg small" role="tablist"><button type="button" aria-pressed="${tab === "active"}" data-tab="active">Open <span class="n">${counts.active}</span></button><button type="button" aria-pressed="${tab === "archived"}" data-tab="archived">Archived <span class="n">${counts.archived}</span></button></div></div>
        <ul class="sc-ilist"><li class="sc-irow sc-imain"><button type="button" class="sc-ibtn" data-go="main"><span class="sc-ik">Main chat</span><time class="sc-it">${short(st.main[st.main.length - 1].min)}</time><span class="sc-ititle">Back where you left it</span><span class="sc-ilast">${esc((mainAt.from === "user" ? "You" : mainAt.from) + ": " + line(mainAt.text, 70))}</span></button></li></ul>
        ${groups.map(([h, fn]) => { const rows = pool.filter(fn); return rows.length ? `<h3 class="sc-h">${h}</h3><ul class="sc-ilist">${rows.map(row).join("")}</ul>` : ""; }).join("") || `<p class="sc-none">${filter ? "No side chat matches." : tab === "archived" ? "Nothing archived." : "No open side chats."}</p>`}`;
    };
    const show = (to, { focusFind = false } = {}) => {
      if (on === "main" && to !== "main") keep.save(log());
      on = to;
      const s = typeof on === "number" ? st.sides.find((x) => x.id === on) : null;
      if (s) s.unread = 0;
      $(".sc-inbox").hidden = on !== "list";
      log().hidden = on === "list";
      $(".composer").hidden = on === "list";
      $(".sc-ctx").hidden = !s;
      $(".sc-ctx").innerHTML = s ? quoteHead(s) + `<button type="button" class="btn small" data-${s.archived ? "unarchive" : "archive"}="${s.id}">${s.archived ? I.unarchive + "Unarchive" : I.archive + "Archive"}</button>` : "";
      if (on === "list") { list(); if (focusFind) $(".sc-find").focus(); }
      else if (s) { log().innerHTML = sideLog(s); log().scrollTop = log().scrollHeight; $(".composer textarea").placeholder = "Ask in this side chat, or type @ or /"; }
      else { log().innerHTML = renderLog(st.main, { after: (m) => st.sides.filter((x) => anchorOf(st, x) === m.id).map((x) => `<li class="side-link"><button type="button" data-go="${x.id}"><span class="side-kicker">${x.archived ? "Archived side chat" : "Side chat"} · ${x.msgs.length} message${x.msgs.length === 1 ? "" : "s"}</span><span class="side-text">${esc(line(x.title, 120))}</span></button></li>`).join("") }); $(".composer textarea").placeholder = "Message the fleet, or type @ or /"; keep.restore(log()); }
      crumbs();
    };
    show("main");
    const rer = (s) => { if (typeof on === "number" && s && on === s.id) { log().innerHTML = sideLog(s); log().scrollTop = log().scrollHeight; } else if (!s && on === "main") { log().innerHTML = renderLog(st.main); log().scrollTop = log().scrollHeight; } else if (s) { s.unread++; crumbs(); if (on === "list") list(); } };
    wireComposer($(".composer"), { signal, onSend: (text) => {
      const s = typeof on === "number" ? st.sides.find((x) => x.id === on) : null;
      (s ? s.msgs : st.main).push(mkMsg([0, "user", text], s ? { side: s.id } : {}));
      if (s) { s.archived = false; log().innerHTML = sideLog(s); } else log().innerHTML = renderLog(st.main);
      log().scrollTop = log().scrollHeight;
      reply(st, s, rer);
    } });
    selTool(stage, signal, (p) => { const s = newSide(st, p); show(s.id); $(".composer textarea").focus(); });
    stage.querySelector("#chat").addEventListener("click", (e) => {
      const t = e.target;
      const ar = t.closest("[data-archive]"); if (ar) { const s = st.sides.find((x) => x.id === Number(ar.dataset.archive)); s.archived = true; if (on === s.id) show("list"); else { list(); crumbs(); } return; }
      const un = t.closest("[data-unarchive]"); if (un) { const s = st.sides.find((x) => x.id === Number(un.dataset.unarchive)); s.archived = false; if (on === s.id) show(s.id); else { list(); crumbs(); } return; }
      const tb = t.closest(".seg [data-tab]"); if (tb) { tab = tb.dataset.tab; list(); return; }
      const g = t.closest("[data-go]"); if (g) { const v = g.dataset.go; show(v === "main" || v === "list" ? v : Number(v), { focusFind: v === "list" && e.detail === 0 }); return; }
      const j = t.closest("[data-jump-msg]"); if (j) { e.preventDefault(); const id = j.dataset.jumpMsg; show("main"); ui.flash(log().querySelector(`[data-msg="${id}"] .msg`)); }
    }, { signal });
    stage.querySelector("#chat").addEventListener("input", (e) => { if (e.target.matches(".sc-find")) { filter = e.target.value; const pos = e.target.selectionStart; list(); const f = $(".sc-find"); f.focus(); f.setSelectionRange(pos, pos); } }, { signal });
    stage.querySelector("#chat").addEventListener("keydown", (e) => {
      if (on !== "list") return;
      const rows = [...stage.querySelectorAll(".sc-ibtn")];
      const i = rows.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length; rows[n]?.focus(); }
      else if (e.key === "Enter" && e.target.matches(".sc-find")) { e.preventDefault(); rows[1]?.click(); }
    }, { signal });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && on !== "main" && stage.querySelector("#chat").contains(document.activeElement)) { e.preventDefault(); show(on === "list" ? "main" : "list"); }
    }, { signal });
  }

  /* ---------- 3. Split: the main thread stays; a side chat opens in a pane under it ---------- */
  function Split(stage, signal) {
    const st = fresh();
    let on = null, onlySides = false, paneH = 56;
    const tools = `<div class="chat-tools sc-tools"><div class="sc-recent" aria-label="Recent side chats"></div><button type="button" class="switch" id="sc-only" role="switch" aria-checked="false" title="Show only where side chats start"><span class="switch-track" aria-hidden="true"></span>Side chats only</button></div>`;
    const head = P.defaultChatHead().replace(/<div class="chat-tools">[\s\S]*<\/div>\s*$/, tools);
    const ui = mountShell(stage, { chatHead: head, chatBody: `<div class="sc-mainwrap"><ol class="chat-log sc-mainlog"></ol><div class="sc-rail" aria-label="Where side chats start"></div></div>${composer({ cls: "sc-maincomp" })}<section class="sc-pane" hidden><div class="sc-grip" role="separator" aria-orientation="horizontal" aria-label="Resize" tabindex="0"></div><header class="sc-phead"></header><ol class="chat-log sc-plog"></ol>${composer({ cls: "sc-pcomp", placeholder: "Ask in this side chat, or type @ or /" })}</section>` }, signal);
    const $ = (s) => stage.querySelector(s);
    const main = () => $(".sc-mainlog");
    const pane = () => $(".sc-pane");

    const anchors = (m) => st.sides.filter((x) => anchorOf(st, x) === m.id).map((x) => x.archived
      ? `<li class="sc-anchor archived"><button type="button" data-open="${x.id}">${I.archive}<span>Archived side chat · ${x.msgs.length}</span><span class="sc-a-t">${esc(line(x.title, 50))}</span></button></li>`
      : `<li class="sc-anchor${on === x.id ? " on" : ""}" data-anchor="${x.id}"><button type="button" data-open="${x.id}">${I.side}<span><b>Side chat</b> · ${x.msgs.length} · ${short(lastOf(x))}</span>${x.unread ? `<span class="badge">${x.unread}</span>` : ""}<span class="sc-a-t">${esc(line(x.title, 50))}</span></button></li>`).join("");
    const drawMain = (keepPos = true) => {
      const t = main().scrollTop;
      const msgs = onlySides ? st.main.filter((m) => st.sides.some((x) => anchorOf(st, x) === m.id)) : st.main;
      main().innerHTML = (onlySides ? `<li class="sc-onlynote">Only the messages side chats start from. Turn the switch off to see the whole thread.</li>` : "") + renderLog(msgs, { after: anchors });
      main().scrollTop = keepPos ? t : main().scrollHeight;
      requestAnimationFrame(rail);
    };
    const rail = () => {
      const log = main(), r = $(".sc-rail");
      if (!log || !r) return;
      const H = log.scrollHeight || 1;
      r.innerHTML = [...log.querySelectorAll(".sc-anchor")].map((a) => { const id = a.dataset.anchor; return `<button type="button" class="sc-tick${a.classList.contains("on") ? " on" : ""}" data-tick="${id}" style="top:${((a.offsetTop / H) * 100).toFixed(2)}%" aria-label="Go to where the side chat starts" title="${esc(line(st.sides.find((x) => String(x.id) === id)?.title || "", 60))}"></button>`; }).join("");
    };
    const recent = () => {
      const r = st.sides.filter((s) => !s.archived).sort(byRecent).slice(0, 3);
      $(".sc-recent").innerHTML = `<span class="sc-recent-k">Recent</span>` + r.map((s) => `<button type="button" class="sc-chip${on === s.id ? " on" : ""}" data-open="${s.id}" title="${esc(s.title)}">${esc(line(s.title, 18))}<span class="sc-time">${short(lastOf(s))}</span>${s.unread ? `<span class="sc-dot"></span>` : ""}</button>`).join("");
    };
    const drawPane = () => {
      const s = st.sides.find((x) => x.id === on);
      pane().hidden = !s;
      $(".sc-maincomp").hidden = !!s;
      stage.querySelector("#chat-body").classList.toggle("split", !!s);
      if (!s) return;
      pane().style.setProperty("--pane-h", paneH + "%");
      $(".sc-phead").innerHTML = `<div class="sc-ptitle">${quoteHead(s)}</div><button type="button" class="icon-btn" data-${s.archived ? "unarchive" : "archive"}="${s.id}" aria-label="${s.archived ? "Unarchive" : "Archive"}" title="${s.archived ? "Unarchive" : "Archive"}">${s.archived ? I.unarchive : I.archive}</button><button type="button" class="icon-btn" data-close aria-label="Close the side chat (Esc)" title="Close the side chat (Esc)">${I.close}</button>`;
      $(".sc-plog").innerHTML = sideLog(s);
      $(".sc-plog").scrollTop = $(".sc-plog").scrollHeight;
    };
    let leftAt = null;
    const open = (id, { reveal = true } = {}) => {
      if (on === null) leftAt = main().scrollTop;
      on = id;
      const s = st.sides.find((x) => x.id === id);
      if (s) s.unread = 0;
      drawPane(); drawMain(); recent();
      if (s && reveal) requestAnimationFrame(() => { const a = main().querySelector(`[data-anchor="${id}"]`); if (a) { const lr = main().getBoundingClientRect(), ar = a.getBoundingClientRect(); if (ar.top < lr.top || ar.bottom > lr.bottom) a.scrollIntoView({ block: "nearest" }); } });
    };
    const close = () => { on = null; drawPane(); drawMain(); if (leftAt !== null) main().scrollTop = leftAt; leftAt = null; requestAnimationFrame(rail); recent(); $(".sc-maincomp textarea").focus({ preventScroll: true }); };

    drawMain(false); recent();
    const rerMain = (s) => { if (s) { if (on === s.id) drawPane(); else s.unread++; drawMain(); recent(); } else drawMain(false); };
    wireComposer($(".sc-maincomp"), { signal, onSend: (text) => { st.main.push(mkMsg([0, "user", text])); drawMain(false); reply(st, null, rerMain); } });
    wireComposer($(".sc-pcomp"), { signal, onSend: (text) => { const s = st.sides.find((x) => x.id === on); s.msgs.push(mkMsg([0, "user", text], { side: s.id })); s.archived = false; drawPane(); drawMain(); recent(); reply(st, s, rerMain); } });
    selTool(stage, signal, (p) => { const s = newSide(st, p); open(s.id); $(".sc-pcomp textarea").focus(); });
    addEventListener("resize", rail, { signal });

    stage.querySelector("#chat").addEventListener("click", (e) => {
      const t = e.target;
      const o = t.closest("[data-open]"); if (o) { const id = Number(o.dataset.open); on === id ? close() : open(id); return; }
      if (t.closest("[data-close]")) { close(); return; }
      const ar = t.closest("[data-archive]"); if (ar) { st.sides.find((x) => x.id === Number(ar.dataset.archive)).archived = true; close(); return; }
      const un = t.closest("[data-unarchive]"); if (un) { st.sides.find((x) => x.id === Number(un.dataset.unarchive)).archived = false; drawPane(); drawMain(); recent(); return; }
      const tk = t.closest("[data-tick]"); if (tk) { ui.flash(main().querySelector(`[data-anchor="${tk.dataset.tick}"] button`)); return; }
      const sw = t.closest("#sc-only"); if (sw) { onlySides = !onlySides; sw.setAttribute("aria-checked", String(onlySides)); drawMain(!onlySides ? false : false); return; }
      const j = t.closest("[data-jump-msg]"); if (j) { e.preventDefault(); if (onlySides) { onlySides = false; $("#sc-only").setAttribute("aria-checked", "false"); drawMain(); } ui.flash(main().querySelector(`[data-msg="${j.dataset.jumpMsg}"] .msg`)); }
    }, { signal });
    /* The pane's top edge drags to share the height between the two threads. */
    const grip = $(".sc-grip");
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      const body = stage.querySelector("#chat-body").getBoundingClientRect();
      const move = (ev) => { paneH = Math.min(85, Math.max(25, ((body.bottom - ev.clientY) / body.height) * 100)); pane().style.setProperty("--pane-h", paneH + "%"); };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", () => { grip.removeEventListener("pointermove", move); rail(); }, { once: true });
    }, { signal });
    grip.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); paneH = Math.min(85, Math.max(25, paneH + (e.key === "ArrowUp" ? 5 : -5))); pane().style.setProperty("--pane-h", paneH + "%"); } }, { signal });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && on !== null && !e.defaultPrevented && !stage.querySelector(".mentions:not([hidden])")) { e.preventDefault(); close(); } }, { capture: true, signal });
  }

  window.variants = [Tabs, Inbox, Split];
})();
