# The call site

For an interface that callers write code against: an SDK, a client, a handler API, a CLI, a tool set. Write the caller's code first, then hold it to these cases. Each shows a call site its designers got right, what they refused, what it costs, and the check to run on your own.

## 1. Keep the program shape

```ts
restate.workflow({
  name: "user-signup",
  handlers: {
    run: async (ctx, user) => {
      const userId = ctx.key;
      const success = await ctx.run("create", () => createUser(userId, user));
      if (!success) return { success };
      await ctx.run("activate", () => activateUser(userId));
      await ctx.run("welcome", () => sendWelcomeEmail(user));
      return { success: true };
    },
  },
});
```

A workflow that survives crashes and resumes mid-way is still one `async` function with `if`, `await` and `return`. Restate refused a workflow DSL and a state-machine config. The whole guarantee enters through one named construct, `ctx.run(name, fn)`, so a search for it lists every side effect. The cost sits in the same place: a side effect written outside `ctx.run` breaks recovery with no error.

**Check:** strike the module's own words from the call site. What remains is the plain program the caller would have written without the module. One search term lists every place the guarantee costs the caller something.

## 2. Start returns a handle

```ts
const handle = await client.workflow.start(example, {
  args: [input],
  taskQueue: "your-queue",
  workflowId: "business-meaningful-id",
});
const result = await handle.result();
```

Starting and waiting are two calls. `start` returns once the work is accepted. The handle is a value built from the caller's own key, so another process rebuilds it from the key and waits, reads or cancels. Temporal refused block-until-done as the only mode, and an id the caller cannot recompute. The cost: the caller chooses a meaningful key (identity, in [DATA.md](DATA.md)).

**Check:** the caller crashes right after `start`. A new process holding only the key gets the result. Wait, read and cancel are separate verbs on the handle.

## 3. Kinds by promise

Temporal has three ways to reach a running workflow: a signal (changes state, returns nothing), a query (reads, changes nothing, works after the workflow ends), an update (changes state and returns, behind a validator). Restate marks a handler exclusive (one writer per key at a time) or shared (read-only, concurrent). Both refused one generic "send message". The cost is more verbs.

**Check:** for each operation, answer three questions: does it change state, does it return a value, may it run beside another call on the same key? The answers show in its kind or name, and the type forbids the rest.

## 4. One required operation, a contract at its edges

```go
type Reader interface {
	Read(p []byte) (n int, err error)
}
```

One method. `bufio`, `gzip` and an HTTP body each take a `Reader` and return a `Reader`, so wrappers stack. Rust's `Iterator` requires only `next`; its other methods are derived from it. The contract is in the edge cases: `Read` may return `n > 0` together with an error, the caller handles the `n` bytes first, and end of input is a value (`io.EOF`). The cost: every implementer honours that contract, and every caller reads `n` before `err`.

**Check:** name the one operation an implementer must write; the rest is derived from it. A wrapper takes the interface and returns it. End, partial result and failure are values in the signature, stated so that two implementers behave the same.

## 5. Built-ins use the public calls

SQLite's core is two objects and a short lifecycle: prepare, bind, step, column, finalize. `sqlite3_exec` is written from those calls and adds no power. Every built-in SQL function is registered through the extension call a user gets. `prepare` compiles once and `step` runs many times, so the costly part is a value the caller reuses.

**Check:** the built-ins are written with the extension call a user gets. The costly, reusable step (parse, compile, connect) is a separate value from the cheap repeated one, and each object has one stated owner that ends it.
