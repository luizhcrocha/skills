/**
 * What a decision's body may do, row by row, in headless Chromium: each way a body could run a script or
 * navigate (a `<script>`, an inline handler, a `javascript:` link, a frame, an object, an embed, an SVG's script
 * or `onload`, a `<meta>` refresh, a form, a link to the top, a `<base>`) is placed in D30's body and must neither
 * run nor navigate, wherever the body shows: in a fleet's page (`bodyDoc`), by itself on the hub's route
 * (`/f/<fleet>/decisions/<id>.html`, `servedBody`: plain text), and on the manager's page inside the fleet's frame
 * (content-policy-manager-browser.test.ts).
 * In a frame, the body as shown holds none of the elements, handlers or links the sanitiser forbids. Each row
 * also proves the fleet's own scripts still work there: the frame's height, the selection bar (`fleetSelect`)
 * and the kinds of mark (the marks' script ready). The mutation-XSS table is mxss-browser.test.ts; the rows and
 * helpers are content-policy-kit.ts. Then the page's side: messages from a frame that is no longer the
 * decision's (navigated away, or replaced) are ignored, even with the frame's token. Skipped when no Chromium is
 * found (FLEET_CHROMIUM, or chromium on the PATH).
 */
import { expect, test } from "bun:test";

import type { Frame } from "puppeteer-core";

import { bodyFrame, eachRow, found, freshPage, hubFor, NOW, selectIdea, sleep, usePolicyBrowser } from "./content-policy-kit.ts";
import { D30_BODY, marksView } from "./marks-fixtures.ts";

usePolicyBrowser();

test.skipIf(!found)("in a fleet's page (frameDoc): no row runs or navigates, and the fleet's scripts work", async () => {
  const failed = await eachRow(async (page, hub) => {
    const url = `${hub.origin}/f/perf/#decision/d30`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
    const frame = await bodyFrame(page);

    return { url, frame, height: () => page.$eval("#dv-frame iframe", (e) => e.getBoundingClientRect().height) };
  });

  expect(failed).toEqual([]);
}, 120_000);

test.skipIf(!found)("by itself on the hub's route: every row is plain text, and none runs or navigates", async () => {
  const failed = await eachRow(async (page, hub) => {
    const url = `${hub.origin}/f/perf/decisions/d30.html`;
    await page.goto(url, { waitUntil: "load" });

    return { url, frame: null, height: null };
  });

  expect(failed).toEqual([]);
}, 120_000);

/**
 * A page that, once in the decision's frame, claims a selection and answers every `annotNow`, and records what the
 * page sends it. It knows the frame's token (given in its address's hash, as a body that read it before taking the
 * frame there would), so only the page's leaving the frame (`leave`) can refuse it.
 */
const FORGER = `<!doctype html><p>The idea</p><script>
var tok = decodeURIComponent(location.hash.slice(1));
var heard = [], count = 0;
function say(m) { m.fleetFrame = tok; count += 1; parent.postMessage(m, "*"); }
addEventListener("message", function (e) { heard.push(e.data); if (e.data && e.data.annotNow) say({ annotNowSel: true, kind: e.data.annotNow, anchor: { blocks: [{ exact: "The idea", prefix: "", suffix: "" }] } }); });
window.forge = function () {
  say({ annotReady: true });
  say({ fleetEvidence: true, height: 9 });
  say({ fleetSelect: true, text: "The idea", rect: { top: 10, bottom: 30, left: 10, width: 80 }, touch: false, anchor: { blocks: [{ exact: "The idea", prefix: "", suffix: "" }] } });
};
window.said = function () { return JSON.stringify(heard); };
window.sent = function () { return count; };
window.token = function () { return tok; };
</script>`;

test.skipIf(!found)("the page ignores fleetSelect and annot* from a frame that navigated away, and sends it nothing", async () => {
  const hub = hubFor(D30_BODY, { "/f/perf/x/forger.html": FORGER });
  const page = await freshPage();
  await page.goto(`${hub.origin}/f/perf/#decision/d30`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
  const frame = await bodyFrame(page);
  await page.waitForSelector("#mk-rail");
  await page.waitForFunction(() => (document.querySelector("#dv-frame iframe")?.getBoundingClientRect().height ?? 0) > 300);
  await sleep(600);
  const tall = await page.$eval("#dv-frame iframe", (e) => e.getBoundingClientRect().height);

  /* The frame's token, as a script in it could read it; then the frame goes elsewhere, the token with it (as a body's link or refresh would take it, were one let through). */
  const token = String(JSON.parse(await frame.evaluate(() => [...document.scripts].map((x) => /fleetFrame:("[^"]*")/u.exec(x.textContent)?.[1]).find((m) => m !== undefined) ?? '""')));
  expect(token).not.toBe("");
  await frame.evaluate((to: string) => void (location.href = to), `${hub.origin}/f/perf/x/forger.html#${encodeURIComponent(token)}`);
  let forger: Frame | null = null;

  for (let i = 0; i < 50 && !forger; i += 1) {
    forger = page.frames().find((f) => new URL(f.url(), "http://x").pathname.endsWith("/x/forger.html")) ?? null;
    await sleep(100);
  }

  if (!forger) throw new Error("the frame did not navigate");
  await forger.waitForFunction("typeof window.forge === 'function'");
  await forger.evaluate("forge()");
  await sleep(800);
  expect(String(await forger.evaluate("token()"))).toBe(token);
  expect(Number(await forger.evaluate("sent()"))).toBeGreaterThanOrEqual(3);

  expect(await page.$eval("#seltool", (e) => (e instanceof HTMLElement ? e.hidden : true))).toBe(true);
  expect(await page.$eval("#dv-frame iframe", (e) => e.getBoundingClientRect().height)).toBe(tall);
  /* A comment sent from elsewhere now is painted nowhere: the page tells the frame that left nothing, its marks' words least of all. */
  hub.fleet.say({ id: 90, at: new Date(NOW).toISOString(), from: "user", to: ["coordinator"], text: "**Marks on D30**", marks: { decision: { id: "d30", ref: "D30", title: "Benchmark architecture", revision: "r" }, at: { hash: "#decision/d30" }, items: [{ n: 1, kind: "comment", quote: { text: "The idea", prefix: "", suffix: "", hint: "", blocks: [{ exact: "The idea", prefix: "", suffix: "" }] }, comment: "a note" }] } });
  await sleep(800);
  expect(String(await forger.evaluate("said()"))).toBe("[]");
}, 60_000);

test.skipIf(!found)("the page ignores fleetSelect and annot* from a frame that was replaced", async () => {
  const hub = hubFor(D30_BODY);
  const page = await freshPage();
  await page.goto(`${hub.origin}/f/perf/#decision/d30`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#conn")?.textContent === "Live");
  const old = await bodyFrame(page);
  await page.waitForSelector("#mk-rail");
  await sleep(400);

  /* A copy of the decision's frame as it was (its document and all), kept on the page; then a revision puts a new frame in the old one's place. */
  await page.evaluate(() => {
    const fr = document.querySelector<HTMLIFrameElement>("#dv-frame iframe");
    const holder = document.createElement("div");
    holder.id = "kept";
    document.body.appendChild(holder);

    if (fr) holder.appendChild(fr.cloneNode());
  });
  hub.setBody(D30_BODY.replace("The idea", "The idea, revised"));
  hub.fleet.setView(marksView(NOW, "2026-10-10T11:40:00Z"));
  await page.waitForFunction(() => document.querySelector("#mk-rail") !== null);

  for (let i = 0; i < 50 && !old.detached; i += 1) await sleep(100);
  expect(old.detached).toBe(true);

  const kept = await (await page.$("#kept iframe"))?.contentFrame();

  if (!kept) throw new Error("no kept frame");
  await kept.waitForFunction(() => document.body?.textContent?.includes("The idea") === true, { timeout: 5000 });
  await sleep(300);
  await selectIdea(kept);
  await sleep(700);
  expect(await page.$eval("#seltool", (e) => (e instanceof HTMLElement ? e.hidden : true))).toBe(true);

  /* The decision's own new frame still reaches the page. */
  const current = await (await page.$("#dv-frame iframe"))?.contentFrame();

  if (!current) throw new Error("no decision frame");
  await selectIdea(current);
  await page.waitForSelector("#seltool:not([hidden]) .seltool-marks", { timeout: 3000 });
}, 60_000);
