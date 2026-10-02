/**
 * The certificate the hub serves the root-mode previews' ports with: read from `tailscale cert` on stdout
 * (never a file), parsed into its chain and key, held in memory, and renewed when it nears its end; when
 * none can be had, the reason, so the hub serves no port in plain http instead.
 */
import { X509Certificate } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";

import { certificateOf, NoCertificate, PreviewCertificate, tailscaleCertificate, type Certificate, type CertificateSource } from "../src/hub/preview-tls.ts";
import { selfSigned, tmp, type Pem } from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;

let leaf: Pem;

let issuer: Pem;

beforeAll(() => {
  leaf = selfSigned(["box.example.ts.net"], "leaf");
  issuer = selfSigned(["ca.example"], "issuer");
});

describe("certificateOf", () => {
  test("splits `tailscale cert`'s stdout into the chain and the key, and reads the leaf's end", () => {
    const got = certificateOf(`${leaf.cert}${issuer.cert}${leaf.key}`);

    if (got instanceof Error) throw got;
    expect(got.cert).toBe(`${leaf.cert.trim()}\n${issuer.cert.trim()}\n`);
    expect(got.key).toBe(`${leaf.key.trim()}\n`);
    expect(got.notAfter.getTime()).toBe(new X509Certificate(leaf.cert).validToDate.getTime());
  });

  test("the key first works as well", () => {
    const got = certificateOf(`${leaf.key}${leaf.cert}`);
    expect(got instanceof Error ? got.message : got.cert).toBe(`${leaf.cert.trim()}\n`);
  });

  test("no certificate, or no key, is an error that never shows the key", () => {
    const noCert = certificateOf(leaf.key);
    expect(noCert).toBeInstanceOf(Error);
    expect(String(noCert)).not.toContain("PRIVATE KEY");
    expect(certificateOf(leaf.cert)).toBeInstanceOf(Error);
    expect(certificateOf("")).toBeInstanceOf(Error);
  });
});

describe("tailscaleCertificate", () => {
  test("asks `tailscale cert` for the name on stdout, valid 14 days at least, and parses it", async () => {
    const dir = tmp("fleet-tls-");
    const pem = join(dir, "out.pem");
    writeFileSync(pem, `${leaf.cert}${leaf.key}`);
    const bin = join(dir, "tailscale");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > ${join(dir, "args")}\ncat ${pem}\n`);
    chmodSync(bin, 0o755);
    const got = await tailscaleCertificate(bin)("box.example.ts.net");

    if (got instanceof Error) throw got;
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe("cert --cert-file - --key-file - --min-validity 336h box.example.ts.net");
    expect([got.cert, got.key]).toEqual([`${leaf.cert.trim()}\n`, `${leaf.key.trim()}\n`]);
  });

  test("a refusal is an error with what tailscale said", async () => {
    const dir = tmp("fleet-tls-");
    const bin = join(dir, "tailscale");
    writeFileSync(bin, `#!/bin/sh\necho 'your Tailscale account does not support getting TLS certs' >&2\nexit 1\n`);
    chmodSync(bin, 0o755);
    const got = await tailscaleCertificate(bin)("box.example.ts.net");
    expect(got).toBeInstanceOf(Error);
    expect(String(got)).toContain("does not support getting TLS certs");
    expect(await tailscaleCertificate(join(dir, "absent"))("box.example.ts.net")).toBeInstanceOf(Error);
  });
});

describe("PreviewCertificate", () => {
  /** A holder on a clock the test moves, fed by `answers` in turn; the names it was asked for. */
  function holder(answers: (Certificate | Error)[], name: () => string | undefined = () => "box.example.ts.net") {
    const clock = { at: Date.parse("2026-10-01T00:00:00Z") };
    const asked: string[] = [];

    const source: CertificateSource = (n) => {
      asked.push(n);
      const next = answers.shift();

      return Promise.resolve(next ?? new Error("no more answers"));
    };

    const held = new PreviewCertificate({ source, name, now: () => clock.at, log: () => {} });

    return { held, clock, asked };
  }

  const cert = (tag: string, days: number, from = Date.parse("2026-10-01T00:00:00Z")): Certificate => ({ cert: `${tag}-cert`, key: `${tag}-key`, notAfter: new Date(from + days * DAY) });

  test("holds what the source gave, with its name, and asks again only when it nears its end", async () => {
    const { held, clock, asked } = holder([cert("first", 60), cert("second", 90)]);
    expect(held.current()).toEqual(new NoCertificate("the hub has not asked for this machine's certificate yet"));
    await held.check();
    expect(held.current()).toMatchObject({ cert: "first-cert", key: "first-key", name: "box.example.ts.net" });
    clock.at += 45 * DAY;
    await held.check();
    expect(asked).toHaveLength(1);
    clock.at += 2 * DAY;
    await held.check();
    expect(asked).toHaveLength(2);
    expect(held.current()).toMatchObject({ cert: "second-cert" });
  });

  test("no MagicDNS name, or the source's refusal, is the reason; it asks again after a minute", async () => {
    let name: string | undefined;
    const { held, clock, asked } = holder([new Error("HTTPS is disabled in this tailnet"), cert("first", 60)], () => name);
    await held.check();
    expect(held.current()).toEqual(new NoCertificate("this machine has no MagicDNS name (is Tailscale running?)"));
    expect(asked).toHaveLength(0);
    name = "box.example.ts.net";
    await held.check();
    expect(held.current()).toEqual(new NoCertificate("tailscale cert box.example.ts.net: HTTPS is disabled in this tailnet"));
    clock.at += 30_000;
    await held.check();
    expect(asked).toHaveLength(1);
    clock.at += 31_000;
    await held.check();
    expect(held.current()).toMatchObject({ cert: "first-cert" });
  });

  test("a failed renewal keeps the certificate while it is valid, retries hourly, and gives it up once expired", async () => {
    const { held, clock, asked } = holder([cert("first", 20), new Error("down"), new Error("down"), new Error("still down")]);
    await held.check();
    clock.at += 10 * DAY;
    await held.check();
    expect(held.current()).toMatchObject({ cert: "first-cert" });
    clock.at += 30 * 60_000;
    await held.check();
    expect(asked).toHaveLength(2);
    clock.at += 31 * 60_000;
    await held.check();
    expect(asked).toHaveLength(3);
    clock.at += 10 * DAY;
    await held.check();
    expect(held.current()).toEqual(new NoCertificate("the certificate expired on 2026-10-21T00:00:00.000Z and could not be renewed: tailscale cert box.example.ts.net: still down"));
  });

  test("a new MagicDNS name asks for its certificate at once", async () => {
    let name = "box.example.ts.net";
    const { held, asked } = holder([cert("first", 60), cert("renamed", 60)], () => name);
    await held.check();
    name = "box2.example.ts.net";
    await held.check();
    expect(asked).toEqual(["box.example.ts.net", "box2.example.ts.net"]);
    expect(held.current()).toMatchObject({ cert: "renamed-cert", name: "box2.example.ts.net" });
  });
});
