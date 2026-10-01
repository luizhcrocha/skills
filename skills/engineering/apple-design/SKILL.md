---
name: apple-design
description: "Apple's fluid-interface principles for the web: springs, velocity handoff, momentum, rubber-banding, materials, type. Use for gesture-driven UI, sheets, drag or swipe, or an Apple-style feel."
---

# Apple design

Apple's WWDC design talks, chiefly *Designing Fluid Interfaces* (WWDC 2018), translated to the web: CSS, Pointer Events, `requestAnimationFrame` and spring libraries such as Motion.

An interface feels alive when motion starts from the value on screen, takes over the user's velocity, projects momentum forward, and can be grabbed and reversed at any moment. Springs make this natural because they are interruptible and carry velocity.

## Defaults

- Respond on pointer-down, not on release, and update 1:1 with the pointer during a drag. Keep the offset from where the user grabbed.
- Never lock out input during a transition. On an interruption, start the new animation from the live on-screen value, never from the target.
- Use springs for anything a user can touch. Start at damping 1.0 (no overshoot); use about 0.8 only when the gesture carried momentum, such as a flick.
- When a gesture ends, hand its release velocity to the spring. Choose the snap target from the projected resting point, not from the release point.
- Enter and exit along the same path, and anchor menus and sheets to their trigger.
- At a boundary, resist progressively (rubber-band) instead of stopping hard.
- Decide reverse or commit from the sign of the velocity at release, not from the position.
- Reduced motion means a short cross-fade instead of a slide or a spring, not no feedback.

## The reference

Read the matching sections of [references/fluid-interfaces.md](references/fluid-interfaces.md) before writing the code. They hold the formulas and values:

| Need | Sections |
| --- | --- |
| Press, drag and tap feel | 1 Response, 2 Direct manipulation, 10 Gesture design details |
| Interruptions and springs | 3 Interruptibility, 4 Behavior over animation (Apple's damping and response values) |
| Ending a gesture | 5 Velocity handoff, 6 Momentum projection (Apple's projection function), 9 Rubber-banding |
| Paths and origins | 7 Spatial consistency, 8 Hint in the direction of the gesture |
| Frames, materials, sound and haptics | 11 Frame-level smoothness, 12 Materials and depth, 13 Multimodal feedback |
| Accessibility and type | 14 Reduced motion and accessibility, 15 Typography |
| Principles and process | 16 Design foundations (Apple's eight principles), 17 Process |
| One-line answers | Quick Reference table at the end |

For the web craft rules (easing curves, durations, press states, the review table), use `design-engineering`; for the animation itself, `animate`.
