/**
 * Where the selection toolbar goes. With a mouse (`toolPlace`), above the selection's first line, below
 * its last when there is no room above. On a touch screen (`toolDock`), always docked at the bottom of the
 * visual viewport, clear of the page's own bottom bars, and the page scrolled (`clearScroll`) so the
 * selection sits over it, checked against a model of the phone's own selection menu: the iOS edit menu and
 * Android's floating text toolbar hug the selection, above it when there is room, else below it past the
 * handles, else (a selection taller than the screen) in the middle. The OS draws them over every web page,
 * so the bar must keep out of where they can be, not just off the selection.
 */
import { expect, test } from "bun:test";

import { clearScroll, toolDock, toolPlace } from "../src/Overlays.tsx";

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

type Box = Parameters<typeof clearScroll>[0];

interface Band {
  readonly top: number;
  readonly bottom: number;
}

/** A selection from `top` to `bottom`, lines across the screen. */
const sel = (top: number, bottom: number): Box => ({ first: { top, bottom: top + 20 }, last: { top: bottom - 20, bottom }, left: 20, width: 350 });

/** The phone's visual viewport, unzoomed, its tab bar showing (`floor`) or not. */
const phone = (floor = Infinity): Parameters<typeof toolDock>[2] => ({ left: 0, top: 0, width: VW, height: VH, scale: 1, floor, safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM });

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
  expect(toolDock(W, H, phone())).toEqual({ top: VH - SAFE_BOTTOM - 8 - H, left: 70, scale: 1 });
});

test("on a phone with the page's tab bar, the bar docks over the tab bar", () => {
  expect(toolDock(W, H, phone(TABS))).toEqual({ top: TABS - 8 - H, left: 70, scale: 1 });
});

test("pinch-zoomed, the bar docks at the bottom of what is on screen, drawn at the screen's scale", () => {
  const at = toolDock(W, H, { left: 100, top: 200, width: 195, height: 422, scale: 2, floor: Infinity, safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM });

  /* 2x: the bar is 125 by 25 page px, the gap 4, the home bar 17. */
  expect(at).toEqual({ top: 200 + 422 - 17 - 4 - 25, left: 100 + (195 - 125) / 2, scale: 0.5 });
});

test("with the keyboard up, the bar docks over the keyboard, inside the visual viewport", () => {
  const at = toolDock(W, H, { left: 0, top: 0, width: VW, height: 500, scale: 1, floor: Infinity, safeTop: SAFE_TOP, safeBottom: 0 });

  expect(at.top).toBe(500 - 8 - H);
});

/** `box` moved up the screen by `d`, as a scroll of the page by `d` moves it. */
const up = (box: Box, d: number): Box => ({ ...box, first: { top: box.first.top - d, bottom: box.first.bottom - d }, last: { top: box.last.top - d, bottom: box.last.bottom - d } });

const BAR = TABS - 8 - H;

test("a selection clear of the bar and of the native menu's place scrolls nothing", () => {
  expect(clearScroll(sel(400, 420), BAR, phone(TABS))).toBe(0);
});

test("a word under the bar, the menu above it, scrolls just enough to sit 8 px over the bar", () => {
  /* The bar's top is 690: the word's end goes to 682. */
  expect(clearScroll(sel(700, 720), BAR, phone(TABS))).toBe(38);
});

test("a selection whose menu goes below it scrolls its end clear of the bar with room for the handles and the menu", () => {
  /* From 60, no room above for the menu: it goes below, past the handles, 90 px under the end. */
  expect(clearScroll(sel(60, 640), BAR, phone(TABS))).toBe(640 + 90 - (BAR - 8));
});

test("a selection taller than the room above the bar scrolls its end clear, its start going off the top", () => {
  const d = clearScroll(sel(200, 1000), BAR, phone(TABS));

  /* Scrolled, it starts above the screen: the menu goes below its end, and both sit over the bar. */
  expect(d).toBe(1000 + 90 - (BAR - 8));
});

test("on a phone, for every selection, after the scroll the bar meets neither the selection's end nor the native menu", () => {
  for (let top = -100; top < VH; top += 10) {
    for (let height = 20; top + height < VH + 400; height += 30) {
      const box = sel(top, top + height);

      for (const floor of [Infinity, TABS]) {
        const at = toolDock(W, H, phone(floor));
        const d = clearScroll(box, at.top, phone(floor));
        const moved = up(box, d);
        const bar = { top: at.top, bottom: at.top + H };
        const why = `selection ${top}..${top + height}, floor ${floor}, scrolled ${d}`;

        expect(d, why).toBeGreaterThanOrEqual(0);
        expect(meets(bar, nativeMenu(moved)), why).toBe(false);
        expect(meets(bar, { top: moved.first.top, bottom: moved.last.bottom }), why).toBe(false);

        if (top + height + HANDLE + MENU_GAP + MENU <= at.top - 8 && top - MENU_GAP - MENU >= SAFE_TOP) expect(d, why).toBe(0);
      }
    }
  }
});
