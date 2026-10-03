/* PROTOTYPE ground, shared by every prototype in fleet/page/prototype (inlined into each HTML by build.ts).
   It reproduces the dashboard around the piece under test: the masthead with its tabs, the views, the chat
   docked at 920px and up (a sheet over the page below), the composer with @people and /skills. Content is
   this machine's fleets, held in memory; nothing persists and nothing is sent anywhere. */
(() => {
  const qs = new URLSearchParams(location.search);
  const theme = qs.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

  const NOW = new Date("2026-10-03T16:40:00");
  const at = (minAgo) => new Date(NOW.getTime() - minAgo * 60000);
  const clock = (d) => d.toTimeString().slice(0, 5);
  const ago = (min) => (min < 1 ? "just now" : min < 60 ? `${Math.round(min)} min ago` : min < 60 * 24 ? `${Math.round(min / 60)} h ago` : min < 60 * 48 ? "yesterday" : `${Math.round(min / 1440)} days ago`);
  const short = (min) => (min < 1 ? "now" : min < 60 ? `${Math.round(min)}m` : min < 60 * 24 ? `${Math.round(min / 60)}h` : min < 60 * 48 ? "1d" : `${Math.round(min / 1440)}d`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const line = (s, n = 90) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

  /* ---------- the fleets ---------- */
  const PEOPLE = {
    user: { name: "Luiz", c: "var(--accent)" },
    manager: { name: "manager", c: "var(--s6)", role: "manager" },
    "infra-coordinator": { name: "infra-coordinator", c: "var(--s1)", role: "coordinator", task: "CA1116 pipeline: cuts, classifier, media", status: "running" },
    "ui-coordinator": { name: "ui-coordinator", c: "var(--s7)", role: "coordinator", task: "Fleet page: chat, finder, decision pages", status: "running" },
    b155: { name: "b155", c: "var(--s3)", fleet: "infra-coordinator", task: "Skip fresh cuts in the classifier pass (waits on D44)", status: "blocked", model: "Opus", skill: "tdd" },
    b196: { name: "b196", c: "var(--s2)", fleet: "ui-coordinator", task: "Side chat list in the chat panel", status: "running", model: "Opus", skill: "prototype" },
    a113: { name: "a113", c: "var(--s4)", fleet: "infra-coordinator", task: "CA1116 media reprocess, dry run before A22", status: "running", model: "Sonnet", skill: "research" },
    b201: { name: "b201", c: "var(--s5)", fleet: "ui-coordinator", task: "Finder: recents first and kind tabs", status: "done", model: "Opus", skill: "architect" },
    a117: { name: "a117", c: "var(--s8)", fleet: "infra-coordinator", task: "Rotate the Box uploader's token", status: "done", model: "Sonnet", skill: "wizard" },
  };
  const WORKERS = ["b155", "b196", "a113", "b201", "a117"];
  const COORDS = ["infra-coordinator", "ui-coordinator"];

  const SKILLS = [
    ["grilling", "<topic>", "Grill the user relentlessly about a plan, decision, or idea."],
    ["recall", "<question>", "Answer from the record what we know or did before."],
    ["why", "<code or choice>", "Find why code is the way it is, from every record, as a cited answer."],
    ["explain", "<change>", "Explain a piece of work plainly: what, how, why."],
    ["interrogate", "<change>", "Three fresh reviewers try to break a change; the lead gives a verdict."],
    ["review", "[since]", "Review changes since a fixed point on two axes, Standards and Spec."],
    ["research", "<question>", "Investigate a question against primary sources and save the findings."],
    ["blast-radius", "<change>", "Find what a change could break beyond the diff."],
    ["prototype", "<question>", "Build a throwaway prototype to answer a design question."],
  ];

  const DECISIONS = [
    {
      id: "d44", ref: "D44", kind: "decision", fleet: "infra-coordinator", agent: "b155", status: "open", blocking: true, opened: 26,
      title: "Stop re-classifying pieces that were just cut",
      question: "Should the classifier pass skip pieces that were cut in the last 24 hours, instead of classifying them again on every pass?",
      why: "b155's patch waits on it. Today every pass re-classifies all 212 pieces of CA1116 cut at 14:02: about 40 minutes of the classifier per pass, and not one label changed in the last three passes.",
      recommend: "A",
      reason: "A is one guard in the pass's query, and the labels a cut gives are the classifier's own from minutes before. B buys little over A and costs half a day.",
      options: [
        { id: "A", label: "Skip pieces cut in the last 24 hours", consequence: "Fresh cuts keep the label the cut gave them until tomorrow's pass." },
        { id: "B", label: "Re-classify only when a cut changes", consequence: "Needs a hash of each piece's bounds; b155 estimates half a day more." },
        { id: "C", label: "Keep re-classifying everything", consequence: "No change: the 40 minutes stay on every pass." },
      ],
    },
    {
      id: "a22", ref: "A22", kind: "action", fleet: "infra-coordinator", agent: "a113", status: "open", blocking: false, opened: 61,
      title: "Run CA1116's owed media reprocess",
      question: "Run the media reprocess CA1116 is owed: 38 recordings were transcribed before the speaker fix (D39). It needs your 1Password approval, so it runs from your terminal: `casos reprocess CA1116 --media --since 2026-09-12`.",
      why: "a113's dry run lists the 38 recordings and finds nothing else owed. The hearing clips of 12/09 still name the judge as \"Speaker 2\" until this runs.",
      options: [],
    },
    {
      id: "g4", ref: "G4", kind: "grill", fleet: "ui-coordinator", agent: "b196", status: "open", blocking: false, opened: 140,
      title: "The tree as the alpha's: two calls",
      question: "Two calls on the case tree before b196 ports it from the alpha.",
      why: "q1 decides the tree's endpoint; q2 decides where b196 keeps the selection.",
      grill: [
        { id: "q1", text: "Does the tree load one level per call, as the alpha does, or the whole case at once?" },
        { id: "q2", text: "When the tree reloads, does the selection stay on the node's id or on its path?" },
      ],
      options: [],
    },
    {
      id: "d45", ref: "D45", kind: "decision", fleet: "ui-coordinator", agent: "b201", status: "open", blocking: false, opened: 190,
      title: "Fold the Links tab into Plan",
      question: "Links holds four rows on most fleets. Fold it into Plan as a section, and drop the tab?",
      options: [
        { id: "A", label: "Fold Links into Plan", consequence: "Five tabs on a phone's dock instead of six." },
        { id: "B", label: "Keep the Links tab", consequence: "No change." },
      ],
    },
    { id: "d43", ref: "D43", kind: "decision", fleet: "ui-coordinator", status: "decided", opened: 1500, title: "Keep the docked chat at 920px and up", answer: "A: dock at 920px", question: "Where does the chat stop docking beside the page?", options: [] },
    { id: "a21", ref: "A21", kind: "action", fleet: "infra-coordinator", status: "decided", opened: 1700, title: "Rotate the Box uploader's token", answer: "Done", question: "Rotate the token the uploader uses for Box.", options: [] },
    { id: "d42", ref: "D42", kind: "decision", fleet: "ui-coordinator", status: "decided", opened: 2900, title: "Side chats keep their own unread count", answer: "A: their own count", question: "Does a side chat count toward the chat's unread badge?", options: [] },
  ];

  /* The main thread, oldest first; `min` is minutes before now. */
  const MAIN = [
    [1490, "user", "Bom dia. O que ficou pendente de ontem no CA1116?"],
    [1488, "infra-coordinator", "Two things: the cut of the hearing PDFs (b155 is on it) and the media reprocess a113 is checking with a dry run. Nothing blocks yet."],
    [1460, "ui-coordinator", "b196 started the side chat list. G4 comes to you once it has the two questions written."],
    [1300, "user", "Ok. Prioriza o corte; a mídia pode esperar o dry run."],
    [1298, "infra-coordinator", "Done: b155 first, a113 keeps the dry run going at low priority."],
    [220, "user", "Status rápido?"],
    [218, "infra-coordinator", "b155 cut 212 pieces of CA1116 at 14:02. The classifier pass after the cut took 41 minutes."],
    [217, "infra-coordinator", "That pass re-classified every piece, including the 212 just cut. Not one label changed."],
    [205, "ui-coordinator", "b201 finished the finder's recents. Two choices left for you on G4, and D45 on the Links tab."],
    [190, "ui-coordinator", "D45 is up: fold Links into Plan? Four rows on most fleets."],
    [150, "user", "@b196 a lista de side chats vai ter busca?"],
    [148, "b196", "Yes: by the quoted text and the first message. Archived ones are searched too, under their own heading."],
    [140, "ui-coordinator", "G4 is up: the tree as the alpha's, two calls."],
    [95, "a113", "Dry run done: 38 recordings transcribed before the speaker fix (D39). Nothing else owed. A22 is up for the real run."],
    [61, "infra-coordinator", "A22 is up: run CA1116's owed media reprocess. It needs your 1Password approval, so it runs from your terminal."],
    [40, "user", "Por que o classificador roda de novo sobre peças recém-cortadas?"],
    [38, "infra-coordinator", "Because the pass selects by case, not by piece age. Every pass takes every piece. D44 asks whether to skip the fresh ones."],
    [26, "infra-coordinator", "D44 is up, blocking: stop re-classifying pieces that were just cut. b155 waits on it."],
    [24, "b155", "The guard for A is ready on my side: `where cut_at < now() - interval '24 hours'`. I'll push the moment D44 is answered."],
    [12, "user", "Vou olhar o D44 agora."],
    [9, "infra-coordinator", "Thanks. While you look: the next pass starts at 17:00, so an answer before then saves one 40-minute run."],
    [4, "ui-coordinator", "b196 pushed the side chat list behind a flag; it shows on the ui fleet's page only."],
    [2, "b155", "Tests for the guard pass: 212 fresh pieces skipped, 1,804 older ones classified."],
  ];

  /* Side chats: started from a quote (in the chat or on a decision page), most recent activity first. */
  const SIDES = [
    { id: 1, title: "every pass re-classifies all 212 pieces", from: { kind: "chat", msg: 8, label: "infra-coordinator in the chat" }, archived: false, unread: 1,
      msgs: [[30, "user", "Quanto custa isso por dia, em horas de classificador?"], [29, "infra-coordinator", "Six passes a day at about 40 minutes: four hours, all on pieces whose labels don't change."], [8, "user", "E se o corte mudar depois?"], [7, "infra-coordinator", "Then the piece's bounds change, and option B would catch it. A waits for the next day's pass."], [3, "b155", "Today no cut was redone within a day. Over the last month: twice."]] },
    { id: 2, title: "Option B: Re-classify only when a cut changes", from: { kind: "decision", ref: "D44", label: "D44, option B" }, archived: false, unread: 0,
      msgs: [[22, "user", "Por que meio dia a mais para o B?"], [21, "b155", "The hash needs the bounds stored per piece; today only the page range is. A migration plus a backfill over 2,016 pieces."], [18, "user", "Ok, faz sentido."]] },
    { id: 3, title: "38 recordings were transcribed before the speaker fix", from: { kind: "decision", ref: "A22", label: "A22" }, archived: false, unread: 0,
      msgs: [[58, "user", "Esses 38 incluem a audiência de 12/09?"], [57, "a113", "Yes, all six clips of the 12/09 hearing. They name the judge as \"Speaker 2\"."], [53, "user", "Então roda hoje ainda."], [52, "a113", "Ready when you approve; the command is on A22."]] },
    { id: 4, title: "does the selection stay on the node's id or on its path?", from: { kind: "decision", ref: "G4", label: "G4, q2" }, archived: false, unread: 2,
      msgs: [[135, "user", "No alpha, o que acontece quando o nó some?"], [133, "b196", "The alpha keeps the path and falls back to the parent. With ids, a moved node keeps its selection; a deleted one falls back the same way."], [128, "user", "E se o nó for renomeado?"], [127, "b196", "Ids survive a rename; paths don't."], [125, "ui-coordinator", "That argues for ids. I'll put it in q2's recommendation."], [120, "b196", "Recommendation written on G4 q2."]] },
    { id: 5, title: "por que o b196 está usando o mesmo store?", from: { kind: "chat", msg: 2, label: "you in the chat" }, archived: true, unread: 0,
      msgs: [[1450, "user", "por que o b196 está usando o mesmo store que o chat principal?"], [1448, "ui-coordinator", "So a side chat's messages come in on the same stream; the list only filters by side."], [1440, "user", "Ok."]] },
    { id: 6, title: "Rotate the Box uploader's token", from: { kind: "decision", ref: "A21", label: "A21" }, archived: true, unread: 0,
      msgs: [[1690, "user", "Precisa reiniciar o uploader depois?"], [1688, "a117", "No: it reads the token per upload."]] },
    { id: 7, title: "the dock at 919px leaves the page 480px wide", from: { kind: "decision", ref: "D43", label: "D43" }, archived: true, unread: 0,
      msgs: [[2880, "user", "480px is enough for the decisions list?"], [2878, "ui-coordinator", "Yes: the list's rows wrap at 420px."], [2870, "user", "Then 920."]] },
  ];
  SIDES.forEach((s) => (s.last = Math.min(...s.msgs.map((m) => m[0]))));

  const PLAN = [
    { title: "CA1116 pipeline", steps: [["P1", "Cut the hearing PDFs into pieces", "done", "b155"], ["P2", "Skip fresh cuts in the classifier pass", "blocked", "b155"], ["P3", "Reprocess media transcribed before D39", "current", "a113"], ["P4", "Rotate the Box uploader's token", "done", "a117"]] },
    { title: "Fleet page", steps: [["P5", "Finder: recents first, kind tabs", "done", "b201"], ["P6", "Side chat list in the chat panel", "current", "b196"], ["P7", "The case tree, ported from the alpha", "todo", "b196"]] },
  ];
  const LINKS = [
    ["L1", "infra-coordinator's page", "https://cr-sede-pc.dusky-tritone.ts.net:7443/f/infra-coordinator", true],
    ["L2", "ui-coordinator's page", "https://cr-sede-pc.dusky-tritone.ts.net:7443/f/ui-coordinator", true],
    ["L3", "Side chat list (b196's dev server)", "http://127.0.0.1:7541/", true],
    ["L4", "Casos, CA1116", "https://casos.coelhorocha.com/c/CA1116", true],
  ];
  const LOG = [
    [2, "message", "b155", "Tests for the guard pass: 212 fresh pieces skipped."],
    [4, "integrated", "b196", "Side chat list behind a flag (ui fleet only)."],
    [26, "asked", "infra-coordinator", "D44 Stop re-classifying pieces that were just cut (blocking)."],
    [61, "asked", "infra-coordinator", "A22 Run CA1116's owed media reprocess."],
    [95, "resolved", "a113", "Dry run: 38 recordings owed, nothing else."],
    [140, "asked", "ui-coordinator", "G4 The tree as the alpha's: two calls."],
    [190, "asked", "ui-coordinator", "D45 Fold the Links tab into Plan."],
    [205, "integrated", "b201", "Finder recents and kind tabs."],
    [218, "resolved", "b155", "Cut 212 pieces of CA1116."],
    [300, "blocked", "b155", "Classifier pass re-classifies fresh cuts; asked the coordinator."],
    [1700, "decision", "a117", "A21 Rotate the Box uploader's token: done."],
  ];

  let nextId = 1000;
  const mkMsg = ([min, from, text], extra = {}) => ({ id: extra.id ?? nextId++, min, from, text, ...extra });
  const STATE = {
    main: MAIN.map((m, i) => mkMsg(m, { id: i + 1 })),
    sides: SIDES.map((s) => ({ ...s, msgs: s.msgs.map((m) => mkMsg(m, { side: s.id })) })),
  };

  /* ---------- icons ---------- */
  const I = {
    mark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1e1b4b"/><path d="M32 33L15 19M32 33l17-14M32 33v18" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round"/><circle cx="15" cy="19" r="7" fill="#818cf8"/><circle cx="49" cy="19" r="7" fill="#818cf8"/><circle cx="32" cy="51" r="7" fill="#818cf8"/><circle cx="32" cy="33" r="10" fill="#eef2ff"/></svg>`,
    search: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>`,
    bell: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/></svg>`,
    chat: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/></svg>`,
    close: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    closeS: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    send: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>`,
    reply: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`,
    back: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
    up: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>`,
    archive: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10M10 12.5h4"/></svg>`,
    unarchive: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10M12 17v-5M9.5 14.5 12 12l2.5 2.5"/></svg>`,
    side: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4z"/><path d="M17 9h3v8h-1v3l-3-3h-4"/></svg>`,
    tabs: {
      decisions: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/></svg>`,
      plan: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>`,
      fleet: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12.5" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="20.5" r="1.8"/><path d="m9.8 10.5-3.3-3M14.2 10.5l3.3-3M12 15.5v3.2"/></svg>`,
      links: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>`,
      log: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>`,
    },
  };

  /* ---------- small renderers ---------- */
  const who = (id) => { const p = PEOPLE[id] || { name: id }; return `<button type="button" class="who" data-who="${esc(id)}" style="--c:${p.c || "var(--faint)"}"><span class="swatch"></span>${esc(p.name)}</button>`; };
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
  const inline = (text) => esc(text).replace(/`([^`]+)`/g, '<code class="ic">$1</code>').replace(/@([a-z0-9-]+)/g, (m, id) => PEOPLE[id] ? `<span class="mention" style="--c:${PEOPLE[id].c}">@${id}</span>` : m).replace(/(^|\s)\/([a-z-]+)/g, (m, sp, s) => SKILLS.some(([k]) => k === s) ? `${sp}<span class="mention">/${s}</span>` : m);
  const kindWord = { decision: "Decision", action: "Action", grill: "Grilling" };
  const decisionById = (id) => DECISIONS.find((d) => d.id === id || d.ref === id);
  const sideById = (id) => STATE.sides.find((s) => s.id === id);

  /** A run of messages as the real chat draws it: name and time at the head of a run, bubbles stacked. */
  function renderLog(msgs, opts = {}) {
    let out = "";
    let lastDay = null;
    msgs.forEach((m, i) => {
      const day = m.min >= 60 * 16.67 ? "Yesterday" : "Today";
      if (day !== lastDay && !opts.noDays) { out += `<li class="day">${day}</li>`; lastDay = day; }
      const prev = msgs[i - 1], next = msgs[i + 1];
      const sameAsPrev = prev && prev.from === m.from && (opts.noDays || (prev.min >= 1000) === (m.min >= 1000)) && prev.min - m.min < 30 && !m.about && !m.quote;
      const sameAsNext = next && next.from === m.from && next.min >= 0 && m.min - next.min < 30 && !next.about && !next.quote;
      const mine = m.from === "user";
      const p = PEOPLE[m.from] || { name: m.from };
      const cls = `turn ${mine ? "from-user" : "from-fleet"}${sameAsPrev ? "" : " head"}${sameAsNext ? "" : " tail"}`;
      const head = sameAsPrev ? "" : `<div class="turn-head">${mine ? `<span class="name">You</span>` : `<span class="name">${esc(p.name)}</span>`}<time>${clock(at(m.min))}</time></div>`;
      const about = m.about ? `<a class="re-line about-line" href="#" data-open-decision="${esc(m.about.id)}" style="--c:var(--you)"><b>${esc(m.about.ref)}</b><span>${esc(m.about.title)}${m.about.part ? " · " + esc(m.about.part) : ""}</span></a>` : "";
      const quote = m.quote ? `<blockquote class="msg-quote"><span class="from">${esc(m.quote.from)}</span>${esc(line(m.quote.text, 160))}</blockquote>` : "";
      out += `<li class="${cls}" data-msg="${m.id}" style="--c:${p.c || "var(--faint)"}">${head}<div class="turn-row"><div class="msg">${about}${quote}<p class="msg-text">${inline(m.text)}</p></div>${mine ? "" : `<button type="button" class="reply-btn" aria-label="Reply" title="Reply">${I.reply}</button>`}</div></li>`;
      if (opts.after) out += opts.after(m) || "";
    });
    return out;
  }

  /* ---------- the composer: chip row, field, send; @people and /skills under the caret ---------- */
  function composer(opts = {}) {
    return `<div class="composer ${opts.cls || ""}">
      <ul class="mentions" role="listbox" hidden></ul>
      ${opts.above || ""}
      <div class="box">
        <div class="reply chips" ${opts.chip ? "" : "hidden"}>${opts.chip || ""}</div>
        <label class="vh">Message</label>
        <textarea rows="1" placeholder="${esc(opts.placeholder || "Message the fleet, or type @ or /")}" autocomplete="off" spellcheck="true"></textarea>
        <button type="button" class="send" aria-label="Send" title="Send" disabled>${I.send}</button>
      </div>
      ${opts.below || ""}
    </div>`;
  }

  /** Wires a composer: the caret list, Enter to send (Shift+Enter a new line), the send button. */
  function wireComposer(root, { onSend, signal, under = false, people = true }) {
    const ta = root.querySelector("textarea");
    const send = root.querySelector(".send");
    const list = root.querySelector(".mentions");
    if (under) list.classList.add("under");
    let items = [], at = 0, tok = null;
    const close = () => { list.hidden = true; items = []; tok = null; };
    const token = () => {
      const v = ta.value.slice(0, ta.selectionStart);
      const m = /(^|\s)([@/])([\w-]*)$/.exec(v);
      if (!m || (m[2] === "@" && !people)) return null;
      return { kind: m[2], q: m[3].toLowerCase(), start: v.length - m[3].length - 1 };
    };
    const draw = () => {
      tok = token();
      if (!tok) return close();
      if (tok.kind === "@") items = ["manager", ...COORDS, ...WORKERS].filter((id) => id.startsWith(tok.q) || fold(PEOPLE[id].task || "").includes(tok.q)).map((id) => ({ id, html: `<span class="swatch" style="--c:${PEOPLE[id].c}"></span><span class="m-main"><span class="m-name">${esc(id)}</span>${PEOPLE[id].status ? pill(PEOPLE[id].status, PEOPLE[id].status) : ""}</span><span class="m-task">${esc(PEOPLE[id].task || "the fleets' manager")}</span>` }));
      else items = SKILLS.filter(([k]) => k.includes(tok.q)).map(([k, arg, d]) => ({ id: k, html: `<span class="slash">/</span><span class="m-main"><span class="m-name">${k}</span><span class="faint">${esc(arg)}</span></span><span class="m-task">${esc(d)}</span>` }));
      list.classList.toggle("skills", tok.kind === "/");
      if (!items.length) return close();
      at = Math.min(at, items.length - 1);
      list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === at}">${it.html}</li>`).join("");
      list.hidden = false;
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const pick = (i) => {
      const it = items[i];
      if (!it || !tok) return;
      const before = ta.value.slice(0, tok.start), after = ta.value.slice(ta.selectionStart);
      const ins = tok.kind + it.id + " ";
      ta.value = before + ins + after;
      ta.selectionStart = ta.selectionEnd = before.length + ins.length;
      close(); sync(); ta.focus();
    };
    const sync = () => { send.disabled = !ta.value.trim(); };
    const doSend = (e) => {
      const text = ta.value.trim();
      if (!text) return;
      onSend(text, e || {});
      ta.value = ""; sync(); close();
    };
    ta.addEventListener("input", () => { at = 0; sync(); draw(); }, { signal });
    ta.addEventListener("click", draw, { signal });
    ta.addEventListener("blur", () => setTimeout(close, 120), { signal });
    ta.addEventListener("keydown", (e) => {
      if (!list.hidden && items.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); at = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; draw(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(at); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(e); }
    }, { signal });
    list.addEventListener("pointerdown", (e) => { e.preventDefault(); const li = e.target.closest("li"); if (li) pick(Number(li.dataset.i)); }, { signal });
    send.addEventListener("click", () => doSend(), { signal });
    return { ta, focus: () => ta.focus(), set: (v) => { ta.value = v; sync(); } };
  }

  /* ---------- the views ---------- */
  function decisionsView() {
    const open = DECISIONS.filter((d) => d.status === "open");
    const row = (d) => `<a class="ask ${d.status === "open" ? "open" : "closed"}${d.blocking ? " blocking" : ""}" href="#" data-open-decision="${d.id}">
      <span class="ask-head"><b><span class="ref">${d.ref}</span> ${esc(d.title)}</b>${d.status === "open" ? pill(d.blocking ? "blocking" : "open", d.blocking ? "blocking" : "open") : pill("decided", d.kind === "action" ? "done" : "decided")}${pill("", kindWord[d.kind])}</span>
      <span class="detail">${esc(line(d.question, 150))}</span>
      <span class="meta">${esc(d.fleet)}${d.agent ? ", for " + d.agent : ""}, ${ago(d.opened)}</span></a>`;
    return `<section class="view">
      <div class="lead blocking"><h2 class="lead-line">4 wait on you: 2 decisions, an action and a grilling.</h2><p class="lead-detail">D44 blocks b155.</p>
      <p class="goal">Get CA1116's hearing through the pipeline this week, and the side chat list into the fleet page.</p>
      <p class="now"><b>Now</b>b155 waits on D44; a113 waits on A22; b196 builds the side chat list. <span class="said">said 4 min ago</span></p></div>
      <dl class="totals"><div><dt>Workers</dt><dd class="num">5</dd></div><div><dt>Running</dt><dd class="num">2</dd></div><div class="alert"><dt>Blocked</dt><dd class="num">1</dd></div><div><dt>Done today</dt><dd class="num">2</dd></div><div><dt>Tokens</dt><dd class="num">4.1M</dd></div></dl>
      <div class="part"><h2>On you</h2><div class="card">${open.map(row).join("")}</div></div>
      <div class="part"><h2>Closed</h2><div class="card">${DECISIONS.filter((d) => d.status !== "open").map(row).join("")}</div></div>
    </section>`;
  }
  function planView() {
    return `<section class="view"><div class="part"><h2>Plan</h2><div class="card">${PLAN.map((ms) => `<div class="milestone"><div class="milestone-head"><h3>${esc(ms.title)}</h3><span class="muted num">${ms.steps.filter((s) => s[2] === "done").length}/${ms.steps.length}</span></div><ul class="steps">${ms.steps.map(([id, t, st, by]) => `<li><button type="button" class="step ${st}" data-step="${id}" data-who="${by}"><span class="dot"></span><span class="title"><span class="ref">${id}</span> ${esc(t)}</span><span class="by">${by}</span></button></li>`).join("")}</ul></div>`).join("")}</div></div></section>`;
  }
  function fleetView() {
    return `<section class="view"><div class="part"><h2>Fleets</h2><div class="card">${COORDS.map((c) => `<div class="strip" style="--c:${PEOPLE[c].c}"><div class="strip-head">${who(c)}${pill(PEOPLE[c].status, PEOPLE[c].status)}</div><p class="detail">${esc(PEOPLE[c].task)}</p><p class="meta">${WORKERS.filter((w) => PEOPLE[w].fleet === c).map((w) => `${w} ${PEOPLE[w].status}`).join(" · ")}</p></div>`).join("")}</div></div>
      <div class="part"><h2>Workers</h2><div class="card">${WORKERS.map((w) => `<div class="strip" data-worker="${w}" style="--c:${PEOPLE[w].c}"><div class="strip-head">${who(w)}${pill(PEOPLE[w].status, PEOPLE[w].status)}<span class="muted" style="font-size:var(--fs-s)">${PEOPLE[w].fleet} · ${PEOPLE[w].model} · /${PEOPLE[w].skill}</span></div><p class="detail">${esc(PEOPLE[w].task)}</p></div>`).join("")}</div></div></section>`;
  }
  function linksView() {
    return `<section class="view"><div class="part"><h2>Links</h2><div class="card">${LINKS.map(([ref, t, url]) => `<div class="strip link-row" data-link="${ref}"><div class="strip-head"><span class="ref">${ref}</span> <a class="link-title" href="#" data-fake-url="${esc(url)}">${esc(t)}</a></div><p class="meta"><code>${esc(url)}</code></p></div>`).join("")}</div></div></section>`;
  }
  function logView() {
    return `<section class="view"><div class="part"><h2>Log</h2><div class="card"><ul class="log">${LOG.map(([min, kind, by, text], i) => `<li data-log="${i}"><time>${clock(at(min))}</time><span><span class="log-meta"><span class="kind ${kind}">${kind}</span><span class="by">${by}</span></span>${esc(text)}</span></li>`).join("")}</ul></div></div></section>`;
  }

  /** A decision's page, as DecisionPage.tsx draws it; `o` lets a prototype add its entry points. */
  function decisionView(d, o = {}) {
    const wrap = o.block || ((key, html) => html);
    const opts = d.options.length ? `<fieldset class="dv-options"><legend>Your answer</legend><ul class="options">${d.options.map((op) => wrap("option:" + op.id, `<li><label class="option"><input type="radio" name="opt" value="${op.id}"${op.id === d.recommend ? " checked" : ""}><span class="label"><span class="key">${op.id}</span>${esc(op.label)}${op.id === d.recommend ? pill("recommended", "recommended") : ""}</span><span class="consequence">${esc(op.consequence)}</span></label></li>`)).join("")}</ul></fieldset>` : "";
    const grill = d.grill ? d.grill.map((q) => wrap("q:" + q.id, `<fieldset class="gq"><legend class="gq-title"><span class="gq-id">${q.id}</span> <span class="gq-of">of ${d.grill.length}</span></legend><p class="gq-body">${esc(q.text)}</p><textarea rows="2" placeholder="Your answer to ${q.id}"></textarea><button type="button" class="btn small" data-proto-toast="Answer to ${d.ref} ${q.id} sent to ${d.fleet}">Send ${q.id}</button></fieldset>`)).join("") : "";
    const thread = STATE.main.filter((m) => m.about?.id === d.id || (m.text.includes(d.ref) && m.from !== "user"));
    return `<section class="view dv" data-decision="${d.id}">
      <a class="dv-back" href="#" data-view="decisions">${I.back}Decisions</a>
      <div class="dv-info">
        <header class="dv-head">
          <div class="dv-pills">${d.status === "open" ? pill(d.blocking ? "blocking" : "open", d.blocking ? "Open, blocking" : "Open") : pill("decided", "Decided")}${pill("plain", kindWord[d.kind])}${o.headExtra || ""}</div>
          <h1><span class="ref">${d.ref}</span> ${esc(d.title)}</h1>
          <p class="dv-meta dv-origin">From ${who(d.fleet)}${d.agent ? `, for ${who(d.agent)}` : ""}</p>
          <p class="dv-meta">Asked ${ago(d.opened)}</p>
        </header>
        ${wrap("question", `<div class="rich dv-question"><p>${inline(d.question)}</p></div>`)}
        ${d.why ? wrap("why", `<div class="dv-block"><h3>${d.blocking ? "What it blocks" : "Meanwhile"}</h3><div class="rich"><p>${inline(d.why)}</p></div></div>`) : ""}
        ${d.recommend ? wrap("recommended", `<div class="dv-block"><h3>Recommended</h3><p><b>${d.recommend}: ${esc(d.options.find((x) => x.id === d.recommend)?.label)}</b></p><div class="rich"><p>${inline(d.reason || "")}</p></div></div>`) : ""}
      </div>
      ${o.afterInfo || ""}
      <form class="dv-form" onsubmit="return false">
        ${opts}${grill}
        ${d.kind !== "grill" ? `<label class="field">A note with the answer (optional)<textarea rows="2"></textarea></label>` : ""}
        <div class="sheet-actions">${d.kind === "grill" ? "" : `<button type="button" class="btn primary" data-proto-toast="Answer to ${d.ref} sent to ${d.fleet}">${d.kind === "action" ? "Mark done" : "Send answer"}</button>`}${o.actions || ""}</div>
      </form>
      ${o.afterForm || ""}
      ${thread.length ? `<div class="dv-block"><h3>In the chat</h3><ol class="thread-list">${renderLog(thread, { noDays: true })}</ol></div>` : ""}
    </section>`;
  }

  /* ---------- the shell ---------- */
  function shell({ chatHead = "", chatBody = "", view }) {
    const badgeOn = DECISIONS.filter((d) => d.status === "open").length;
    return `<div class="shell" id="shell">
      <div class="main" id="app">
        <div class="masthead" id="masthead">
          <header class="top">
            <div class="top-name"><a class="mark" href="#" aria-label="Home: every fleet" title="Home: every fleet">${I.mark}</a><h1>manager</h1><span>${pill("running", "running")}</span></div>
            <label class="switch" id="switch"><span class="vh">Go to</span><select aria-label="Go to the manager or a fleet"><option selected>Manager</option><option>infra-coordinator</option><option>ui-coordinator</option></select></label>
            <a class="up" hidden></a>
            <button class="bell" id="find-open" type="button" aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)">${I.search}</button>
            <button class="bell" id="bell" type="button" aria-label="Notifications" title="Notifications">${I.bell}<span class="badge">3</span></button>
          </header>
          <nav class="tabs" id="dock" aria-label="Views">
            <a href="#" data-view="decisions">${I.tabs.decisions}<span class="lbl">Decisions</span><span class="badge alert">${badgeOn}</span></a>
            <a href="#" data-view="plan">${I.tabs.plan}<span class="lbl">Plan</span><span class="badge alert">1</span></a>
            <a href="#" data-view="fleet">${I.tabs.fleet}<span class="lbl">Fleets</span></a>
            <a href="#" data-view="links">${I.tabs.links}<span class="lbl">Links</span></a>
            <a href="#" data-view="log">${I.tabs.log}<span class="lbl">Log</span></a>
            <button type="button" class="to-chat" id="chat-toggle" aria-controls="chat">${I.chat}<span class="lbl">Chat</span><span class="badge" id="chat-badge" hidden></span></button>
          </nav>
        </div>
        <main class="wrap" id="view">${view}</main>
      </div>
      <div class="chat-scrim" id="chat-scrim" hidden></div>
      <aside class="chat available" id="chat" aria-labelledby="chat-title">
        ${chatHead || defaultChatHead()}
        <div class="chat-body" id="chat-body">${chatBody}</div>
      </aside>
      <div class="toasts" id="toasts" aria-live="polite"></div>
    </div>`;
  }
  function defaultChatHead(extra = "") {
    return `<header class="chat-head"><h2 id="chat-title" tabindex="-1">Chat</h2><span class="you">as Luiz</span><span class="conn" data-conn="live" role="status">Live</span>${extra}<button type="button" class="icon-btn" id="chat-close" aria-label="Hide chat" title="Hide chat">${I.close}</button></header>
      <div class="chat-tools"><button type="button" class="switch" id="chat-decisions" role="switch" aria-checked="true"><span class="switch-track" aria-hidden="true"></span>Decision activity</button></div>`;
  }

  /** Mounts the shell and wires what every prototype shares. Returns the page's handle. */
  function mountShell(stage, cfg, signal) {
    const ui = { view: cfg.view || "decisions", decision: cfg.decision || null };
    const render = () => (ui.decision ? decisionView(decisionById(ui.decision), cfg.decisionOpts ? cfg.decisionOpts(decisionById(ui.decision)) : {}) : { decisions: decisionsView, plan: planView, fleet: fleetView, links: linksView, log: logView }[ui.view]());
    stage.innerHTML = shell({ chatHead: cfg.chatHead, chatBody: cfg.chatBody || "", view: render() });
    const $ = (s) => stage.querySelector(s);
    const shellEl = $("#shell"), chat = $("#chat"), scrim = $("#chat-scrim"), toggle = $("#chat-toggle");
    const docked = () => matchMedia("(min-width: 920px)").matches;
    let open = cfg.chatOpen ?? docked();
    const syncChat = () => {
      shellEl.classList.toggle("chat-collapsed", docked() && !open);
      chat.classList.toggle("open", !docked() && open);
      scrim.hidden = docked() || !open;
      toggle.setAttribute("aria-expanded", String(open));
      document.documentElement.classList.toggle("chat-open", !docked() && open);
    };
    ui.openChat = () => { open = true; syncChat(); requestAnimationFrame(() => chat.querySelectorAll(".chat-log").forEach((l) => { if (l.scrollTop === 0 && !l.dataset.seen) { l.dataset.seen = "1"; l.scrollTop = l.scrollHeight; } })); };
    ui.closeChat = () => { open = false; syncChat(); };
    ui.isOpen = () => open;
    const syncTabs = () => stage.querySelectorAll(".tabs [data-view]").forEach((a) => a.setAttribute("aria-current", String(!ui.decision && a.dataset.view === ui.view)));
    ui.show = (view, decision = null) => {
      ui.view = view; ui.decision = decision;
      $("#view").innerHTML = render();
      syncTabs();
      if (!ui.keepScroll) scrollTo({ top: 0 });
      cfg.onView?.(ui);
    };
    ui.refresh = () => { $("#view").innerHTML = render(); cfg.onView?.(ui); };
    ui.toast = (text, kind = "message") => {
      const box = $("#toasts");
      box.innerHTML = `<div class="toast"><div><div class="meta"><span class="kind">${esc(kind)}</span> prototype</div><div class="text">${esc(text)}</div></div><button type="button" aria-label="Dismiss">×</button></div>`;
      clearTimeout(ui._tt); ui._tt = setTimeout(() => (box.innerHTML = ""), 3200);
    };
    ui.flash = (el) => { if (!el) return; el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); el.classList.remove("proto-flash"); void el.offsetWidth; el.classList.add("proto-flash"); };
    syncChat(); syncTabs();
    addEventListener("resize", syncChat, { signal });
    toggle.addEventListener("click", () => (open ? ui.closeChat() : ui.openChat()), { signal });
    scrim.addEventListener("click", () => ui.closeChat(), { signal });
    stage.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (t.closest("#chat-close")) { ui.closeChat(); return; }
      const v = t.closest("[data-view]");
      if (v && !t.closest(".proto-own")) { e.preventDefault(); ui.show(v.dataset.view); return; }
      const d = t.closest("[data-open-decision]");
      if (d && !t.closest(".proto-own")) { e.preventDefault(); ui.show("decisions", d.dataset.openDecision); if (!docked()) ui.closeChat(); return; }
      const tst = t.closest("[data-proto-toast]");
      if (tst) { ui.toast(tst.dataset.protoToast); return; }
      const sw = t.closest("#chat-decisions");
      if (sw) { sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true")); return; }
      const u = t.closest("[data-fake-url]");
      if (u) { e.preventDefault(); ui.toast("Would open " + u.dataset.fakeUrl + " in a new tab"); return; }
      if (t.closest(".mark")) { e.preventDefault(); ui.show("decisions"); return; }
      if (t.closest("#bell")) { ui.toast("D44 is up, blocking. A22 is up. b196 pushed the side chat list.", "notifications"); return; }
      if (t.closest(".toast button")) { $("#toasts").innerHTML = ""; return; }
      const w = t.closest(".who");
      if (w) { ui.show("fleet"); ui.flash(stage.querySelector(`[data-worker="${w.dataset.who}"]`)); return; }
      const step = t.closest("[data-step]");
      if (step) { ui.toast(`${step.dataset.step} is ${step.dataset.who}'s`); return; }
    }, { signal });
    stage.querySelector("#switch select").addEventListener("change", (e) => { ui.toast(`Would go to ${e.target.value}'s page`); e.target.value = "Manager"; }, { signal });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && open && !docked() && !e.defaultPrevented && !e.target.closest?.("dialog")) ui.closeChat();
    }, { signal });
    cfg.onView?.(ui);
    return ui;
  }

  window.P = { NOW, at, clock, ago, short, esc, fold, line, PEOPLE, WORKERS, COORDS, SKILLS, DECISIONS, PLAN, LINKS, LOG, STATE, I, who, pill, inline, kindWord, decisionById, sideById, renderLog, composer, wireComposer, decisionView, shell, defaultChatHead, mountShell, mkMsg };
})();
