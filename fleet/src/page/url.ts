/**
 * An address split as Python's `urllib.parse.urlsplit` reads the parts the page needs: the scheme, the
 * host name (lower case) and the port. The page shows a link up or down by its port, and a served port
 * no link names as found.
 */

/** The parts of an address. */
export interface Split {
  readonly scheme: string;
  readonly hostname: string | undefined;
  /** The explicit port; undefined when there is none or it does not read as one. */
  readonly port: number | undefined;
}

/** `url` split. */
export function splitUrl(url: string): Split {
  const head = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  const scheme = head?.[1]?.toLowerCase() ?? "";
  const rest = head === null ? url : url.slice(head[0].length);

  if (!rest.startsWith("//")) return { scheme, hostname: undefined, port: undefined };
  const netloc = rest.slice(2).split(/[/?#]/, 1)[0] ?? "";
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  let host: string;
  let port: string;

  if (hostinfo.startsWith("[")) {
    const close = hostinfo.indexOf("]");
    host = close < 0 ? hostinfo.slice(1) : hostinfo.slice(1, close);
    const after = close < 0 ? "" : hostinfo.slice(close + 1);
    port = after.startsWith(":") ? after.slice(1) : "";
  } else {
    const colon = hostinfo.indexOf(":");
    host = colon < 0 ? hostinfo : hostinfo.slice(0, colon);
    port = colon < 0 ? "" : hostinfo.slice(colon + 1);
  }

  const number = /^\d+$/.test(port) ? Number(port) : undefined;

  return {
    scheme,
    hostname: host === "" ? undefined : host.toLowerCase(),
    port: number !== undefined && number <= 65535 ? number : undefined,
  };
}

/** Where a probe connects. */
export interface Target {
  readonly host: string;
  readonly port: number;
}

/** Where on this machine `url` is answered: its host (127.0.0.1 for this machine's names) and port. */
export function probeTarget(url: string): Target {
  const parts = splitUrl(url);
  const port = parts.port ?? (parts.scheme === "https" ? 443 : 80);
  const name = parts.hostname;
  const local = name === undefined || name === "localhost" || name.endsWith(".ts.net");

  return { host: local ? "127.0.0.1" : name, port };
}
