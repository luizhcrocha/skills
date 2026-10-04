import { RuleTester } from "oxlint/plugins-dev";

import { noOncePerPositionReadRule } from "./no-once-per-position-read.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });
const error = { messageId: "oncePerPosition" };

// The invalid cases are the three incidents in luizhcrocha/skills fleet/page (Solid 2 rc): the finder's
// Marked (before kolqnopw, the match marks landed on the wrong letters as the user typed), and Rich.tsx's
// Words and inline spans (before kyptnlyl). The valid cases are their fixes and the near misses.
tester.run("tstack/no-once-per-position-read", noOncePerPositionReadRule, {
  valid: [
    // The fixes.
    `<For each={parts()} keyed={false}>
      {(part) => (
        <Show when={part().hit} fallback={part().text}>
          <mark>{part().text}</mark>
        </Show>
      )}
    </For>`,
    `<For each={pieces()} keyed={false}>
      {(p) => (
        <Show when={props.mention && p().part} fallback={p().text}>
          {(part) => <>{props.mention?.(part())}</>}
        </Show>
      )}
    </For>`,
    `<For each={b.spans} keyed={false}>
      {(s) => (
        <Show when={s().kind === "code"} fallback={<Words text={s().text} parts={props.parts} mention={props.mention} />}>
          <code class="ic">{unmark(s().text, props.parts)}</code>
        </Show>
      )}
    </For>`,
    // A choice inside a {…} in the returned JSX, an attribute, a value-only ternary there.
    `<For each={parts()} keyed={false}>{(part) => <>{part().hit ? <mark>{part().text}</mark> : part().text}</>}</For>`,
    `<For each={rows()} keyed={false}>{(row) => <li class={row().done ? "done" : "open"}>{row().done ? "yes" : "no"}</li>}</For>`,
    `<For each={rows()} keyed={false}>{(row, i) => <Row row={row()} index={i} {...row()} />}</For>`,
    `<For each={rows()} keyed={false}>{(row) => <Switch><Match when={row().kind === "a"}><A /></Match></Switch>}</For>`,
    // A read in a memo or a handler runs when it is needed, not once.
    `<For each={rows()} keyed={false}>{(row) => { const label = createMemo(() => row().title); return <b onClick={() => pick(row().id)}>{label()}</b>; }}</For>`,
    // Keyed lists hand the callback the item itself; a non-For callback is not a position.
    `<For each={rows()}>{(row) => (row.hit ? <mark>{row.text}</mark> : row.text)}</For>`,
    `<For each={rows()} keyed={(r) => r.id}>{(row) => <b>{row().text}</b>}</For>`,
    `<Show when={user()}>{(u) => (u().admin ? <Admin /> : <Guest />)}</Show>`,
    `items.map((item) => (item().hit ? <mark /> : <span />));`,
    // Another function's call, or a call with arguments, is not the accessor.
    `<For each={rows()} keyed={false}>{(row) => (flag() ? <A row={row()} /> : <B />)}</For>`,
  ],
  invalid: [
    {
      code: `<For each={highlight(props.title, rangesIn(props.title, props.query))} keyed={false}>
      {(part) => (part().hit ? <mark>{part().text}</mark> : <>{part().text}</>)}
    </For>`,
      errors: [error],
    },
    {
      code: `<For each={pieces()} keyed={false}>
      {(p) => {
        const v = p();

        return v.part && props.mention ? props.mention(v.part) : v.text;
      }}
    </For>`,
      errors: [error],
    },
    {
      code: `<For each={b.spans} keyed={false}>
      {(s) => (s().kind === "code" ? <code class="ic">{unmark(s().text, props.parts)}</code> : <Words text={s().text} parts={props.parts} mention={props.mention} />)}
    </For>`,
      errors: [error],
    },
    { code: `<For each={rows()} keyed={false}>{(row) => row().done && <Done />}</For>`, errors: [error] },
    { code: `<For each={rows()} keyed={false}>{function (row) { return row().text; }}</For>`, errors: [error] },
  ],
});
