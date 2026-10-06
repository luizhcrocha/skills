/**
 * The roadmap in a real browser (the built template in headless Chromium, fed by the harness), with the chat
 * docked beside it: a milestone with a long title and fifteen decision chips, and steps with long titles,
 * workers and chips, the way a long-running fleet's ledger reads. Every milestone, step, worker and chip
 * stays inside the Roadmap card, and a milestone's title keeps at least 12ch. Skipped when no Chromium is
 * found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser } from "puppeteer-core";

import { coordinatorView, type View } from "./fixtures.ts";
import { serveHarness, type Harness } from "./harness.ts";

const TEMPLATE = process.env["FLEET_PAGE_TEMPLATE"] ?? join(import.meta.dir, "..", "..", "..", "skills", "productivity", "coordinator", "assets", "dashboard.html");

const chromium = process.env["FLEET_CHROMIUM"] ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? "";

const found = chromium !== "" && existsSync(chromium);

const NOW = Date.parse("2026-10-01T12:00:00Z");

/** A decision tied to milestone `m1`, to step `step` when given. */
function decision(n: number, step?: string): View {
  const d: View = { id: `x${n}`, ref: `D${n}`, kind: "decision", title: `Decision ${n}`, question: "?", status: n % 3 ? "decided" : "open", blocking: false, asks: "user", opened: new Date(NOW - 60_000).toISOString(), milestone: "m1", options: [] };

  return step === undefined ? d : { ...d, step };
}

/** The coordinator's view with the roadmap of a fleet two weeks in. */
function longView(): View {
  const base = coordinatorView(NOW);

  const steps = [
    { id: "t1", title: "the_switch.sql into db/migrations as 0021; atlas migrate set 0021 on prod", status: "done", agent: "a1" },
    { id: "t2", title: "Recreate the pipeline role (Luiz runs the cut)", status: "done", agent: "a2" },
    { id: "t3", title: "find: scoped search (lawsuit, files, folder, date, kind, within a previous result); Code Mode passes scope; Casos scope picker (ui)", status: "current", agent: "a4" },
    { id: "t4", title: "Contextual embeddings: pplx-embed-v2-context vs Nemotron on the gold sets", status: "current", agent: "a3" },
    { id: "t5", title: "Build after Luiz approves the access change", status: "pending" },
  ];

  const decisions = [
    ...Array.from({ length: 15 }, (_, i) => decision(40 + i)),
    ...[1, 3, 4, 14, 17].map((n) => decision(n, "t2")),
    decision(70, "t3"),
    ...[9, 10, 11, 12, 13].map((n) => decision(n, "t5")),
  ];

  return {
    ...base,
    roadmap: [
      { id: "m1", title: "Search at full potential: turbopuffer and Neo4j, Postgres in support", steps },
      { id: "m2", title: "Firm-wide Code Mode", steps: [{ id: "u1", title: "Design ADR 0037", status: "done", agent: "a5" }] },
    ],
    decisions,
  };
}

let browser: Browser;

let harness: Harness;

beforeAll(async () => {
  if (!found) return;
  harness = serveHarness({ template: readFileSync(TEMPLATE, "utf8"), view: longView(), messages: [] });
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  if (!found) return;
  await browser.close();
  harness.stop();
});

for (const width of [1444, 1280, 1024]) {
  test.skipIf(!found)(`at ${width} px with the chat docked, the roadmap stays inside its card`, async () => {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    await page.evaluateOnNewDocument((t: number) => {
      Date.now = () => t;
    }, NOW);
    await page.goto(harness.url + "#plan", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live" && document.querySelectorAll("#roadmap-list .milestone").length === 2);

    const seen = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#roadmap-list")?.getBoundingClientRect();
      const chat = document.querySelector<HTMLElement>("#chat");
      const right = card?.right ?? 0;

      const outside = [...document.querySelectorAll<HTMLElement>("#roadmap-list :is(.milestone, .milestone-head, h3, .dchip, .num, .steps li, .step, .title, .by)")].flatMap((el) =>
        el.getBoundingClientRect().right > right + 0.5 ? [`${el.className || el.tagName}: ${(el.textContent ?? "").slice(0, 24)}`] : [],
      );

      const ctx = document.createElement("canvas").getContext("2d");

      const narrow = [...document.querySelectorAll<HTMLElement>("#roadmap-list h3")].flatMap((h) => {
        if (ctx === null) return [];
        ctx.font = getComputedStyle(h).font;

        const ch = ctx.measureText("0").width;

        return h.getBoundingClientRect().width < 12 * ch ? [`${h.textContent ?? ""}: ${String(Math.round(h.getBoundingClientRect().width))} px`] : [];
      });

      return { docked: chat !== null && chat.getBoundingClientRect().width > 0, outside, narrow };
    });

    expect(seen.docked).toBe(true);
    expect(seen.outside).toEqual([]);
    expect(seen.narrow).toEqual([]);
    await page.close();
  });
}
