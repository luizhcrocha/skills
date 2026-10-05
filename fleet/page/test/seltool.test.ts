/**
 * Where the selection toolbar goes. With a mouse (`toolPlace`), above the selection's first line, below
 * its last when there is no room above. On a touch screen (`toolDock`), docked at the bottom of the visual
 * viewport, clear of the page's own bottom bars, against a model of the phone's own selection menu: the iOS
 * edit menu and Android's floating text toolbar hug the selection, above it when there is room, else below
 * it past the handles, else (a selection taller than the screen) in the middle. The OS draws them over
 * every web page, so the bar must keep out of where they can be, not just off the selection.
 */
import { expect, test } from "bun:test";

import { toolDock, toolPlace } from "../src/Overlays.tsx";

/** A phone's viewport, as an iPhone 14 gives it to the page: 390 by 844, its notch and home bar. */
const VW = 390;

const VH = 844;

const SAFE_TOP = 47;

const SAFE_BOTTOM = 34;

/** The page's tab bar on a phone: 62 px over the home bar. */
const TABS = VH - SAFE_BOTTOM - 62;

/** The bar's size at 390 px: Copy, Reply, Side chat, 44 px targets. */
const W = 250;

const H = 50;

/** The native menu's height and its distance from the selection, with room for the handles below it. */
const MENU = 48;

const MENU_GAP = 10;

const HANDLE = 26;

type Box = Parameters<typeof toolDock>[0];

interface Band {
  readonly top: number;
  readonly bottom: number;
}

/** A selection from `top` to `bottom`, lines across the screen. */
const sel = (top: number, bottom: number): Box => ({ first: { top, bottom: top + 20 }, last: { top: bottom - 20, bottom }, left: 20, width: 350 });

/** The phone's visual viewport, unzoomed, its tab bar showing (`floor`) or not. */
const phone = (floor = Infinity): Parameters<typeof toolDock>[3] => ({ left: 0, top: 0, width: VW, height: VH, scale: 1, floor, safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM });

/** The band the OS's menu takes for `box`: above if it fits under the notch, else below past the handles, else the middle. */
function nativeMenu(box: Box): Band {
  const above = box.first.top - MENU_GAP - MENU;

  if (above >= SAFE_TOP) return { top: above, bottom: box.first.top - MENU_GAP };
  const below = box.last.bottom + HANDLE + MENU_GAP;

  if (below + MENU <= VH - SAFE_BOTTOM) return { top: below, bottom: below + MENU };

  return { top: VH / 2 - MENU / 2, bottom: VH / 2 + MENU / 2 };
}

const meets = (a: Band, b: Band): boolean => a.top < b.bottom && b.top < a.bottom;

test("with a mouse the bar sits 8 px above the selection's first line, centred on it", () => {
  expect(toolPlace(sel(400, 460), W, H, 1280, 900)).toEqual({ top: 342, left: 70 });
});

test("with a mouse and no room above, the bar sits 8 px below the selection's last line", () => {
  expect(toolPlace(sel(30, 90), W, H, 1280, 900)).toEqual({ top: 98, left: 70 });
});

test("on a phone the bar docks at the bottom of the screen, centred, over the home bar", () => {
  expect(toolDock(sel(400, 420), W, H, phone())).toEqual({ top: VH - SAFE_BOTTOM - 8 - H, left: 70, scale: 1 });
});

test("on a phone with the page's tab bar, the bar docks over the tab bar", () => {
  expect(toolDock(sel(400, 420), W, H, phone(TABS))).toEqual({ top: TABS - 8 - H, left: 70, scale: 1 });
});

test("a selection down by the dock moves the bar to the top of the screen, under the notch", () => {
  expect(toolDock(sel(700, 740), W, H, phone(TABS))).toEqual({ top: SAFE_TOP + 8, left: 70, scale: 1 });
});

test("pinch-zoomed, the bar docks at the bottom of what is on screen, drawn at the screen's scale", () => {
  const at = toolDock(sel(300, 320), W, H, { left: 100, top: 200, width: 195, height: 422, scale: 2, floor: Infinity, safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM });

  /* 2x: the bar is 125 by 25 page px, the gap 4, the home bar 17. */
  expect(at).toEqual({ top: 200 + 422 - 17 - 4 - 25, left: 100 + (195 - 125) / 2, scale: 0.5 });
});

test("with the keyboard up, the bar docks over the keyboard, inside the visual viewport", () => {
  const at = toolDock(sel(100, 120), W, H, { left: 0, top: 0, width: VW, height: 500, scale: 1, floor: Infinity, safeTop: SAFE_TOP, safeBottom: 0 });

  expect(at.top).toBe(500 - 8 - H);
});

for (const [name, box] of [
  ["a word in the middle of the screen", sel(400, 420)],
  ["a word at the top of the screen, where the menu goes below", sel(60, 80)],
  ["a paragraph from the top to past the middle, where the menu goes below", sel(60, 600)],
  ["a paragraph from the top to near the dock, where the menu goes below onto the dock", sel(60, 700)],
  ["a long selection to near the bottom, where the menu goes above", sel(300, 800)],
  ["a selection taller than the screen", sel(-200, 1200)],
] as const) {
  test(`on a phone the bar keeps out of the native menu's place: ${name}`, () => {
    for (const floor of [Infinity, TABS]) {
      const at = toolDock(box, W, H, phone(floor));

      expect(meets({ top: at.top, bottom: at.top + H }, nativeMenu(box))).toBe(false);
    }
  });
}

test("on a phone, for every selection, the bar keeps out of the native menu, and off the selection when the screen leaves room for both", () => {
  for (let top = -100; top < VH; top += 10) {
    for (let height = 20; top + height < VH + 200; height += 30) {
      const box = sel(top, top + height);

      for (const floor of [Infinity, TABS]) {
        const at = toolDock(box, W, H, phone(floor));
        const bar = { top: at.top, bottom: at.top + H };
        const why = `selection ${top}..${top + height}, floor ${floor}, bar at ${at.top}`;

        expect(meets(bar, nativeMenu(box)), why).toBe(false);
        expect(bar.top >= SAFE_TOP && bar.bottom <= Math.min(floor, VH - SAFE_BOTTOM), why).toBe(true);

        /* Room for the bar and the native menu together, above the selection or below it, with 10 px to spare. */
        const roomy = top - MENU_GAP - MENU > SAFE_TOP + 8 + H + 10 || top + height + HANDLE + MENU_GAP + MENU < Math.min(floor, VH - SAFE_BOTTOM) - 8 - H - 10;

        if (roomy) expect(meets(bar, { top, bottom: top + height }), why).toBe(false);
      }
    }
  }
});
