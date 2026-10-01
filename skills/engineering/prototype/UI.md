# UI Prototype

Generate **several radically different UI variations** on a single route, switchable from a floating picker. The user flips between variants in the browser, picks one (or steals bits from each), then throws the rest away.

Each variant must be a direction you could defend shipping on its own. Three tints of one idea teach the user nothing.

If the question is about logic/state rather than what something looks like, this is the wrong branch. Use [LOGIC.md](LOGIC.md).

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Sub-shapes: strongly prefer sub-shape A

A UI prototype is much easier to judge when it's **butting up against the rest of the app**: real header, real sidebar, real data, real density. A throwaway route on its own is a vacuum: every variant looks fine in isolation. Default to sub-shape A whenever there's a plausible existing page to host the variants. Only reach for sub-shape B if the prototype genuinely has no nearby home.

### Sub-shape A: adjustment to an existing page (preferred)

The route already exists. Variants are rendered **on the same route**, gated by the picker's `?v=` URL search param. The existing data fetching, params, and auth all stay. Only the rendering swaps. This is the default; pick it unless there's a specific reason not to.

If the prototype is for something that doesn't yet have a page but *would naturally live inside one* (a new section of the dashboard, a new card on the settings screen, a new step in an existing flow), it's still sub-shape A. Mount the variants inside the host page.

### Sub-shape B: a new page (last resort)

Only use this when the thing being prototyped genuinely has no existing page to live inside (e.g. an entirely new top-level surface, or a flow that can't be embedded anywhere sensible).

Create a **throwaway route** following whatever routing convention the project already uses. Don't invent a new top-level structure. Name it so it's obviously a prototype (e.g. include the word `prototype` in the path or filename). Same `?v=` pattern.

Before committing to sub-shape B, sanity-check: is there really no existing page this could be embedded in? An empty route hides design problems that a populated one would expose.

In every sub-shape the picker is identical.

### Sub-shape C: no project

With no project at all (an empty directory, or the user is only exploring), build a single self-contained HTML file with inline CSS and JS that the user opens in a browser. Give it a restrained look: neutral grays, one accent, the system font stack. PICKER.md's reference wiring is written for this case.

## Process

### 1. State the question and pick N

One piece of UI per run. If the description spans several ("the dashboard"), pick the one with the most leverage, say which and why, and offer the rest as later runs.

Default to **3 variants**. More than 5 stops being radically different and starts being noise, so cap there.

Write down the plan in one line, in the prototype's location or a top-of-file comment:

> "Three variants of the settings page, switchable via `?v=`, on the existing `/settings` route."

This works whether the user is here to push back or not.

### 2. Generate radically different variants

Before writing code, read the ground the variants stand on: the styling system, the tokens (colors, radii, spacing, fonts, easing and duration variables), the product's personality (a playful consumer app or a crisp dashboard), and where the piece renders. Then list the set: a name and an axis for each. The axis is what the variant changes: layout, density, personality, motion or interaction model. Names describe the direction ("Quiet", "Editorial", "Dense"), never "Option A". No two variants share a position on an axis.

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The project's component library / styling system (TailwindCSS, shadcn, MUI, plain CSS, whatever).
- A clear exported component name from its direction, e.g. `QuietVariant`, `EditorialVariant`, `DenseVariant`.
- Real interactions, real motion and realistic, product-shaped content: no lorem ipsum, no dead buttons.
- The craft bar, which divergence does not lower: the rules in `design-engineering` (ease-out entrances, UI motion under 300 ms, `transform-origin` at the trigger, `transform` and `opacity` only, reduced motion handled).

Variants must be **structurally different**: different layout, different information hierarchy, different primary affordance, not just different colours. Three slightly-tweaked card grids isn't a UI prototype, it's wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together

Create a single switcher component on the route:

```tsx
// pseudo-code, adapt to the project's framework
const variant = Number(searchParams.get('v') ?? 1);
return (
  <>
    {variant === 1 && <QuietVariant {...data} />}
    {variant === 2 && <EditorialVariant {...data} />}
    {variant === 3 && <DenseVariant {...data} />}
    <PrototypePicker variants={['Quiet', 'Editorial', 'Dense']} current={variant} />
  </>
);
```

For sub-shape A (existing page): keep all the existing data fetching above the switcher; only the rendered subtree changes per variant.

For sub-shape B (new page): the throwaway route under `/prototype/<name>` mounts the same switcher.

### 4. Build the picker

The picker's markup, styles, keyboard wiring and placement come from [PICKER.md](PICKER.md), verbatim: load it now and build exactly that. It is harness chrome, not a design decision, so it never takes the project's tokens. In a framework, keep its class names and behavior and express the wiring idiomatically.

- Render **one variant at a time, full size, in realistic surrounding context**: a toast needs a page behind it, a card needs its siblings. Side-by-side thumbnails distort spacing and scale.
- Switching is instant. The user flips a hundred times a session, so the variant swap gets no animation.
- Hidden in production builds: gate on `process.env.NODE_ENV !== 'production'` or an equivalent check, so a stray prototype merge can't ship the picker to users.

Put the picker in a single shared component so both sub-shapes can reuse it. Locate it wherever shared UI lives in the project.

### 5. Verify and hand it over

Run it and flip through every variant yourself before the user does: each renders, each interaction responds, the console is clean. Take a screenshot of each when browser tooling is available.

Then present the set as a table and stop, because the choice is the user's:

| # | Variant | Axis | When it's the right choice | Its cost |
| --- | --- | --- | --- | --- |
| 1 | Quiet | Minimal motion, borders over shadows | The product is a daily-use tool | Least memorable |

Don't pre-pick a favorite. If asked, answer from the product's personality and how often the piece is used. If two variants converged while you built them, cut one and say so.

Surface the URL (and the `?v=` keys). The user will flip through whenever they get to it. The interesting feedback is usually **"I want the header from B with the sidebar from C"**, which is the actual design they want. For another round, keep the harness and diverge around the direction they leaned towards.

### 6. Capture the answer and clean up

Once a variant has won, capture the answer (which variant and why), then capture the prototype the way the [SKILL](SKILL.md) describes. Fold the winner into the real code and move the rest onto the throwaway branch, not into main:

- **Sub-shape A**: fold the winner into the existing page; drop the losing variants and the switcher from main.
- **Sub-shape B**: promote the winning variant to a real route; drop the throwaway route and the switcher from main.
- **Sub-shape C**: the winner moves into the real code once there is a project; the HTML file goes to the throwaway branch whole.

The full set of variants is the primary source, so it lands on the throwaway branch, not the bin, since variant components and the switcher left in the main branch rot fast and confuse the next reader.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree about structure.
- **Sharing too much code between variants.** A shared `<Header>` is fine; a shared `<Layout>` defeats the point. Each variant should be free to throw out the layout.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a stub: the question is "what should this look like", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was written under prototype constraints (no tests, minimal error handling). Rewrite it properly when you fold it in.
