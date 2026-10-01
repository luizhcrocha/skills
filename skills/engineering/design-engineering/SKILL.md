---
name: design-engineering
description: "Craft rules for web UI polish (press states, origins, transforms, clip-path, gestures, performance, accessibility) and a Before/After review table. Use to polish UI or review it for feel."
---

# Design engineering

Good interfaces are made of many small details that users never notice one by one. Each detail below has a reason. Apply it where the reason applies, and study why the interfaces you admire feel the way they do.

## Pick the skill for the job

- One animation to build: `animate`.
- A diff whose motion needs a verdict: `review-animations`.
- A codebase's motion to audit and plan: `improve-animations`. Places that should start moving: `find-animation-opportunities`.
- Gestures, springs, materials and type at Apple's level: `apple-design`.
- A web app that feels wrong on a phone: `mobile-native`.
- A component library to choose: `pick-ui-library`.
- Several directions for one piece of UI: `prototype`.

This skill covers the rest: component polish, and a UI review that looks at more than motion.

## Rules that catch most problems

1. Decide whether it should animate at all. An action seen 100 or more times a day, or started from the keyboard, gets no animation.
2. Name exact properties. Never `transition: all`.
3. Enter and exit with `ease-out` or a strong custom curve, such as `cubic-bezier(0.23, 1, 0.32, 1)`. Never `ease-in` on UI.
4. Keep UI animation under 300 ms. A dropdown takes 150 to 250 ms; press feedback takes 100 to 160 ms.
5. Give every pressable element an `:active` state, such as `transform: scale(0.97)`.
6. Never enter from `scale(0)`. Start from `scale(0.95)` with `opacity: 0`.
7. Popovers scale from their trigger (`transform-origin: var(--transform-origin)` in Base UI). Modals stay centered.
8. Use transitions, not keyframes, for anything a user can trigger again mid-flight. They retarget from the current value.
9. Animate `transform` and `opacity` only. In Motion, use the full `transform` string instead of the `x` and `y` shorthands.
10. Honor `prefers-reduced-motion` with gentler motion, not none, and put hover effects inside `@media (hover: hover) and (pointer: fine)`.

When feel cannot be judged from code, say so. Play the animation at 2 to 5 times its duration or frame by frame in DevTools, test gestures on a real device, and look again the next day.

## Review format

A UI review is one markdown table with the columns Before, After and Why, one row per issue. Never write "Before:" and "After:" on separate lines.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Name the properties; `all` animates what you did not mean to |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing in the real world appears from nothing |
| No `:active` state on a button | `transform: scale(0.97)` on `:active` | A press needs instant feedback |

## The reference

Read [references/craft.md](references/craft.md) for the reasons and the code behind each rule: the animation decision framework, springs, component principles (tooltips, blur over a crossfade, `@starting-style`), transforms, clip-path patterns (tabs, hold to delete, image reveals, comparison sliders), drag and gesture handling, performance, accessibility, principles for components people love, stagger, debugging, and the review checklist.
