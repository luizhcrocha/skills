/**
 * Whether something accepts connections where an address points (Python's `served.up`): a TCP connect
 * with a short timeout. The hub probes asynchronously; a CLI command, which runs synchronously, probes
 * every address at once in a child process (this file run as a script), so a page with ten links waits
 * one timeout, not ten.
 */
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import * as Option from "effect/Option";

import { asArray, asBoolean, parseJson } from "../json.ts";
import { probeTarget } from "./url.ts";

/** How long a probe waits for a connection. */
export const PROBE_TIMEOUT_MS = 300;

/** Whether `host:port` accepts a connection within the timeout. */
export function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });

    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether each of `urls` is answered on this machine, probed together. */
export async function upAll(urls: readonly string[]): Promise<boolean[]> {
  return Promise.all(
    urls.map((url) => {
      const { host, port } = probeTarget(url);

      return accepts(host, port);
    }),
  );
}

const SELF = fileURLToPath(import.meta.url);

/** {@link upAll} for synchronous code: one child process probes them all; down when it cannot run. */
export function upAllSync(urls: readonly string[]): boolean[] {
  if (urls.length === 0) return [];
  const done = spawnSync(process.execPath, [SELF, ...urls], { encoding: "utf8", timeout: 5000 });
  const answers = asArray(Option.getOrUndefined(parseJson(done.stdout ?? ""))) ?? [];

  return urls.map((_, i) => asBoolean(answers[i]) ?? false);
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await upAll(process.argv.slice(2)))}\n`);
}
