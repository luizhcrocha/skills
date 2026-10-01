---
name: mobile-native
description: "Make a web app feel native on a phone: sticky hover, tap flash, 100vh, input zoom, tap delay, overscroll, safe areas, theme-color. Use when a web UI feels wrong on mobile, or for a PWA or touch UI."
---

# Mobile native

Remove, one at a time, the signs that a web app is a website in a phone's browser. The fixes live at the platform layer (viewport, touch, scroll, safe areas, browser chrome), and most are one CSS declaration or one meta tag. Motion itself belongs to `animate`, and its review to `review-animations`. React Native is out of scope.

Most "it feels janky on mobile" reports are not animation problems. They are a 300 ms tap delay, a gray flash on tap, or a hover state that stays on.

## Rules

1. Apply each fix where its reason applies. `user-select: none` on a button is right; on body text it is a defect.
2. Use media queries (`(hover: hover)`, `(pointer: fine)`, `env()`, `dvh`), never user-agent sniffing or screen width, to detect touch.
3. Write for touch and mouse at once. iPads have trackpads and laptops have touchscreens.
4. Never disable zoom with `user-scalable=no` or `maximum-scale=1`. Fix the input font size, which caused the zoom.
5. Test on a real phone before you call it done. Device emulation reproduces none of these bugs. If you have no device, say which fixes you verified from code and which need one.

## Symptoms

Match what the user sees, then read the numbered section of [references/fixes.md](references/fixes.md) for the reason and the exact code.

| Problem | Solution | Section |
| --- | --- | --- |
| Hover state stuck after tap | Wrap in `@media (hover: hover) and (pointer: fine)` | 1 |
| Gray or blue flash on tap | `-webkit-tap-highlight-color: transparent` | 2 |
| Layout has the wrong height | `100dvh` (app) or `100svh` (hero) | 3 |
| Page zooms into an input | Input font size at least 16px | 4 |
| Tap feels laggy | Feedback on pointer-down, `touch-action: manipulation` | 5 |
| Pull-to-refresh hijacks scroll | `overscroll-behavior: none` on `html, body` | 6 |
| Content stops at the notch | `viewport-fit=cover` with `env(safe-area-inset-*)` | 7 |
| Long-press selects button text | `user-select: none` on controls | 8 |
| Carousel scrolls vertically | `touch-action: pan-y` on the gesture surface | 9 |
| Status bar color doesn't match | One `theme-color` per color scheme | 10 |
| Right in Chrome, wrong on the phone | Test on real hardware | 11 |

For a new mobile-facing app, ship the Baseline section of the reference before the first component. Check the result against its Never Ship table.

## Output

Apply the fixes. Then, in a few lines: the symptom you matched and its reason, the file and declaration you changed, and which fixes the user must confirm on a phone.
