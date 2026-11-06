# Programs for cards

The calls of [PROGRAMS.md](PROGRAMS.md) for a card after it opens, and how the owner's answer reaches it. Read the section for the card in hand.

## Cards after they open

The calls below go on from PROGRAMS.md's worked calls, on the same team.

**A grilling** takes an id of your own, and its questions with their options. Each question's `body` is the
question itself:

```ts
grill.open("g1", { title: "How users sign in", question: "Two questions settle how the login form signs users in.",
  why: "The form ships this week, and both answers change what the session store keeps.", blocking: true }, [
  { id: "q1", title: "Which ways to sign in the form offers", body: "Should the form offer passkeys, passwords, or both?",
    options: [{ id: "a", label: "Passkeys only", consequence: "no password to leak; a phone without passkeys cannot sign in" },
              { id: "b", label: "Both", consequence: "every device signs in; passwords need a reset flow" }],
    recommend: "b", reason: "Some users still have phones without passkeys." },
  { id: "q2", title: "How long a user stays signed in", body: "How long should a session last before the user signs in again?",
    options: [{ id: "a", label: "30 days", consequence: "users rarely sign in again; a lost laptop stays signed in" },
              { id: "b", label: "1 day", consequence: "a sign-in every morning" }],
    recommend: "a", reason: "The app holds no payment data." }]);
return records.apply(ops);
```

The owner answers each question on the card's page: their write marks it `answered`, with the words after its
`Qn: `, and the card stays open. A chat line tagged with the card tells you, a `Qn:` line per question answered
(`Q1: b: Both (as recommended)`); no program records those answers. Read them off the card:

```ts
return records.read({ kind: "decision", key: "g1" });
```

Once no question is open (each answered, or dropped), close the grilling with what was agreed:
`grill.close("g1", "Passkeys and passwords; a session lasts 30 days.")`. It is decided with no answer of its own, and
the cloud refuses the close while a question is open. `grill.ask`, `grill.revise` and `grill.drop` read the card, so
`await` each before `records.apply(ops)`.

A follow-up is a new round, `await grill.ask("g1", { id: "q3", of: "q1", title: "…", body: "…", options: […] }, "why it follows")`,
and a question nobody needs goes with `await grill.drop("g1", "q3", "why")`.

**An action** is a step only the owner can take: `hand` says why only they can, and `manual` is the steps they run
(DASHBOARD.md, "An action by hand", has the manual's rules): every step is in `manual`, never deferred to the body
(Luiz #614, #804); the `fleet state` CLI refuses a manual that does, and the cloud's `decision.open` is the fleet
repo's to hold to the same rule. **A secret** names in `secret` the secret to set, never
its value, and says in `manual` how to set it by hand:

```ts
decision.open({ kind: "action", title: "Add the login domain",
  question: "Add login.acme.test to the login Worker?",
  hand: "The production Cloudflare account needs your security key.",
  manual: "1. Open dash.cloudflare.com, then Workers, then acme-login, then Settings.\n2. Under Domains, click Add and type `login.acme.test`.",
  agent: "w2", blocking: true });
decision.open({ kind: "secret", title: "The session store's signing key",
  question: "Set SESSION_SIGNING_KEY for the login Worker?",
  why: "The session store signs each cookie with it.", secret: "SESSION_SIGNING_KEY",
  manual: "1. In a terminal, run `cd ~/repos/acme; secretspec set SESSION_SIGNING_KEY`.\n2. Paste the key when it asks.",
  agent: "w2" });
return records.apply(ops);
```

**A roadblock that needs the owner** names the open card it waits on, so it comes after the card, in a later
program, once the card's `applied` result gave its id (`A219` here). The fleet refuses a `needs: "user"` roadblock
with no open card. The cloud marks the worker blocked, and resolves the roadblock when the card closes:

```ts
roadblock({ title: "The session store waits on its domain", detail: "w2 cannot route the store until A219 is done.",
  agent: "w2", severity: "serious", needs: "user", decision: "A219" });
return records.apply(ops);
```

**A failed action.** The owner answers `Failed: <what happened>`, which leaves the card open with their line in the
chat. Fix the cause, then re-present it with new steps and a one-line log:

```ts
decision.revise("A219", { manual: "1. Open dash.cloudflare.com, then Workers, then acme-login, then Settings.\n2. Under Domains and Routes, click Add, then Custom domain, and type `login.acme.test`." },
  "the Add button moved under Domains and Routes");
return records.apply(ops);
```

When the owner answers Done on the page, their write decides the card; no program records it. The close resolves the
roadblock and sets w2 running.

**Hold, unhold, withdraw.** `decision.hold` keeps a card open and takes it off the owner's list while the fleet works
on it; `decision.unhold("S219")` puts it back, and so does a revise with new words (question, options, manual):

```ts
decision.hold("S219", "w2 tries the key the Worker's binding derives first");
return records.apply(ops);
```

`decision.withdraw` closes a card nobody needs any more:

```ts
decision.withdraw("S219", "the Worker derives the key from its binding");
return records.apply(ops);
```

**Change my answer.** On a closed card the page's Change my answer sends a chat line, not an answer: it quotes the
card and starts "I want to change my answer. ". To change a closed card's answer, open a new card that asks again,
with `supersedes` naming the card it replaces; the fleet refuses a `supersedes` that names a card it does not hold.
`--types` does not declare `supersedes` on `Card` yet (a fix logged on the fleet's side), and `decision.open` passes it
through all the same:

```ts
decision.open({ kind: "decision", title: "Where sessions live, asked again", supersedes: "D219",
  question: "Which store keeps the login sessions, now that a slower logout is acceptable?",
  why: "You changed your answer in #61.",
  options: [{ id: "kv", label: "Workers KV", consequence: "cheap; a logout takes up to 60 s to reach every edge" },
            { id: "do", label: "A Durable Object", consequence: "one writer per session; logout is immediate" }],
  recommend: "kv", reason: "your #61: the cost matters more than a 60 s logout" });
return records.apply(ops);
```

Then answer #61 in the next program, naming the new card: `say("D220 asks it again, with KV recommended.", { re: 61, decision: "D220" })`.

**A marks batch.** Marks the owner put on a card's words reach you as one chat line of their own, the batch. It comes
alone, or just before the answer it rides with (the batch is #63, the answer #64). Read the batch first and handle
every mark before you act on the answer: a mark can change what the answer means. A mark that asks for a change
(delete, replace, comment, a general note) is settled by revising the card (`decision.revise`, `decision.body`,
`grill.revise`), a question by an answer. Answer the batch with `say` and `re`. `say` takes no mark numbers, so one
line answers the whole batch: name each mark's number in its text.

```ts
decision.revise("D220", { why: "You changed your answer in #61. With KV, a signed-out user stays signed in for up to 60 s on other edges." },
  "the why says what a slower logout means, for mark 1 of #63");
say("Mark 1: the why now says what a 60 s logout means.", { re: 63, decision: "D220" });
return records.apply(ops);
```

**A standing approval** is asked on a card of its own: the question names the act in plain words, and
`approval_question` and `approval_rule` go on the card when you open it (it lands as D221 here):

```ts
decision.open({ kind: "decision", title: "Deploy previews without asking",
  question: "May the fleet deploy a preview of any branch without asking each time?",
  options: [{ id: "yes", label: "Yes", consequence: "previews deploy after a green test-changed; you see each one as a notice" },
            { id: "no", label: "No", consequence: "each preview deploy waits on a permission card" }],
  approval_question: true, approval_rule: "deploy a preview of any branch after a green test-changed",
  why: "Six preview deploys this week each waited on a permission card." });
return records.apply(ops);
```

## Evidence

`decision.body(id, text, { markdown: true })` attaches the evidence the card's page shows, as `--body FILE` did; an
HTML fragment needs no option. `await` it before `records.apply(ops)`. A program cannot read the file, so the shell
puts its text in as a JSON string literal ahead of the program:

```sh
{ printf 'const page = %s;\n' "$(jq -Rs . evidence.md)"; cat <<'EOF'
await decision.body("D220", page, { markdown: true });
return records.apply(ops);
EOF
} | FLEET_DIR=<dir> fleet-run
```

For a short `evidence.md`, the program it sends reads:

```ts
const page = "## Logout on each store\n\n| Store | A logout reaches every edge |\n| :-- | :-- |\n| Workers KV | within 60 s |\n| A Durable Object | at once |\n";
await decision.body("D220", page, { markdown: true });
return records.apply(ops);
```

A program takes at most 32 KiB (32,768 bytes of UTF-8), its literal included. A longer one exits 2. Up to about 64 KiB, stderr says "a program takes
at most 32768 bytes"; past that, the host cuts the request short and stderr names a parse error. The literal adds a byte for each newline, quote and backslash of the file, so
keep `evidence.md` under about 30 KiB. A body may take 2 MB (`--types`), but no program carries that much: it reads no
file, it reaches no network, and each `decision.body` replaces the card's last body, so a body does not split across
calls. Publish bigger evidence whole as a page of its own (an Artifact), and attach a body that sums it up and links
that page.

## The owner answers on the card

The cloud's owner-answer gate (its `OWNER_ANSWERS_FROM`) is on since 2026-10-28 20:35 UTC; this text ships with it.

- **The owner's write is the record.** The page sends the owner's answer with its form (the option they picked, an
  input's words, their note, or a grilling's picks), and the cloud records it on the card at once: `status:
  "decided"`, `answer` (the option's id, an input's or a secret's words, or `done`), and `answer_line`, the id of
  their line in the chat. A grilling's question is marked `answered`, with the words after its `Qn: `, and the card
  stays open. Read the answer off the card (`records.read({ kind: "decision", key })`, or the watch's line) and act
  on it. Only `answer_line` says the owner answered: `resolution` is a program's prose, whatever it says, and the
  cloud refuses one that reads as the page's own "answered on the page (#N)".
- **No program records an answer.** The cloud refuses `decision.decide`, `grill.answer`, and any op that sets a
  card's `status: "decided"` or its `answer`, or marks a question answered: "the owner answers on the card's page; a
  program can't record it". Two ops still close a card: a notice opened under an active approval (`under`), and
  `grill.close(id, resolution)` on a grilling with no question open. `decision.withdraw` stays. A decided card keeps
  its answer, resolution and closed time, so a program sets none of them: on a card that holds the owner's answer
  the cloud refuses with "a program cannot set the resolution of decision D219 while it holds the owner's answer
  (#41)". To change them, reopen the card (`decision.revise` with `status: "open"`) or withdraw it.
  `decision.decide` and `grill.answer` stay in the prelude until the rollout is done, and the cloud refuses both. A
  team that has not moved records with the state CLI, as before.
- **An answer typed in the chat counts for nothing**, and so does one given in the terminal. Do not record it, and
  do not act on it as the card's answer. Answer the line at once: `say("Answer on the card, please: D219.", { re: 41,
  decision: "D219" })`. The page turns the card's number into its link.
- **None of these, and an action's Failed:**, leave the card open with the owner's line in the chat. Revise the card
  from their note, or withdraw it.
- **A change the owner reads asks again.** A revise of a field the page shows (the question, options, why, recommend,
  reason, approval_rule and the rest) bumps the card's `rev`, and the page refuses an answer begun on the words
  before. On a grilling, a question re-worded is asked again, and so is a follow-up (`of`) of it.
- **A card for the Manager** (`asks: "manager"`): once the Manager answers, withdraw it with `decision.withdraw(id,
  "answered by the Manager outside the chat: <gist>")`. When the answer is the user's to give, open a new card for
  the user.
- **A standing approval comes from the card, not from you.** Two answers back one: the user's plain yes (Yes,
  Approve, OK, Sim) on a card opened with `approval_question` and `approval_rule`, picked with no note while the page
  showed the rule; or allow-kind (only on a card from before Allow for 24 hours) with no note on a permission, when its rule covers every call it asked for. An
  allow-once never backs one, and neither does a yes on a card opened without `approval_question`. Then push the
  approval op under your next K, naming the card: `ops.push({ record: { kind: "approval", key: "K7" }, set: { ref:
  "D221", by: "luiz", status: "active" } })` (on a grilling, `question` names the question too). The cloud fills
  its rule (the one the owner's form showed), message (their line) and author from the card, and stamps `added`; a
  value of yours that differs is refused. One line backs one approval, and an approval that is there may only be
  revoked.
- **Another fleet's approval does not reach a moved team**: the cloud refuses an approval whose `ref` names another
  fleet's card (`manager/G5:Q1`). Ask on this team's own page with an approval question.
- **Ask once, link the rest** works as [SESSIONS.md](SESSIONS.md#with-a-manager) says: the user answers on the asking card, and you
  withdraw yours after they answered. An answer they give on your own card is recorded there as any other.
