# Substitutes go through seams

Replace behavior only through an intentional production seam. Never through module-patching or method-spy APIs: `jest.mock`/`vi.mock`, `jest.spyOn`/`vi.spyOn`, Python's `mock.patch` of your own modules, monkeypatching your own functions, generated mocks of your own interfaces. They patch hidden dependencies, reward code without seams, and couple tests to structure.

## Where substitutes belong

At **system boundaries** only, and through the seam the production code already uses:

- External APIs (payment, email, a SaaS SDK): a fake or recording adapter.
- Time and randomness: an injected clock, an injected random source or ID generator.
- The file system and network, when the claim is not about them.
- The database, only when the claim is not about SQL (see below).

Never substitute your own modules, internal collaborators, or anything you control: test through them.

## Design for it

**Inject dependencies** rather than creating them inside:

```typescript
// A seam: the adapter comes in
function processPayment(order, payments) {
  return payments.charge(order.total);
}

// No seam: the only way in is module patching
function processPayment(order) {
  return new StripeClient(process.env.STRIPE_KEY).charge(order.total);
}
```

**SDK-style interfaces over one generic fetcher**, so each substitute returns one shape and needs no conditional logic:

```typescript
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  createOrder: (data) => fetch("/orders", { method: "POST", body: data }),
};
```

**Fakes record, tests assert on the record**, not on calls:

```typescript
const emails = new RecordingEmails();
const reset = new PasswordReset(users, emails, clock);

expect(await reset.requestReset(email)).toEqual(ok({ delivery: "queued" }));
expect(emails.sent).toContainEqual({ to: email, template: "reset" });
```

An interaction is asserted only when the interaction is the observable behavior, and then the recording fake owns the record.

## When a fake is not proof

- **SQL, schema constraints, transactions, migrations**: use a representative local database with the real migrations (e.g. in-memory SQLite). A hand-written fake proves the adapter's contract, not SQL semantics.
- **Runtime behavior** (a Worker's bindings, serialization, a platform API): run in that runtime or its local emulator. Tests in another runtime are not proof of it.
- When no representative environment exists, name the unproven claim instead of presenting a lower-level test as proof.
