/**
 * The tests' browser: happy-dom's globals, and Solid's JSX compiled for the page's components (dev
 * build, so Solid's diagnostics run too). Run with `bun test --conditions browser`, so Solid resolves
 * its client build.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { transform } from "@solidjs/compiler";
import { plugin } from "bun";

/* The server side of a test (the harness, puppeteer) keeps Bun's own network and streams. */
const own = { fetch, Response, Request, Headers, ReadableStream, WritableStream, TransformStream, AbortController, AbortSignal, TextEncoder, TextDecoder, URL, URLSearchParams, WebSocket };

GlobalRegistrator.register({ url: "http://127.0.0.1:9/f/billing/", width: 1280, height: 900 });

Object.assign(globalThis, own);

/* happy-dom 20 writes a number set as textContent as nothing; a browser writes its digits. */
const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");

if (text?.set && text.get) {
  const set = text.set;
  Object.defineProperty(Node.prototype, "textContent", { ...text, set(this: Node, v: string | number | null) { set.call(this, v === null ? v : String(v)); } });
}

plugin({
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/u }, async ({ path }) => ({ contents: transform(await Bun.file(path).text(), { filename: path, dev: true }).code, loader: "ts" }));
  },
});
