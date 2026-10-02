/**
 * The certificate the hub serves the root-mode previews' public ports with: this machine's own, from
 * Tailscale (`tailscale cert` for its MagicDNS name, the certificate `tailscale serve` uses too), read on
 * stdout and held in memory, never written to disk or logged. The hub asks for it at start and asks again
 * once it is within 14 days of its end (or the machine's name changes); a renewal that fails keeps the one
 * held while it is valid. When there is none (Tailscale down, HTTPS certificates off in the tailnet, no
 * MagicDNS name), `current` says why, and the hub serves no public port at all: never plain http.
 */
import { X509Certificate } from "node:crypto";

/** A certificate: its chain and key in PEM, and when the leaf ends. */
export interface Certificate {
  readonly cert: string;
  readonly key: string;
  readonly notAfter: Date;
}

/** A certificate held for this machine's MagicDNS name. */
export interface Named extends Certificate {
  readonly name: string;
}

/** Why the hub holds no certificate. */
export class NoCertificate {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

/** Where certificates come from: the one for a MagicDNS name, or why none. */
export type CertificateSource = (name: string) => Promise<Certificate | Error>;

/** How long before its end a certificate is renewed. */
const RENEW_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

/** How often the hub asks again while it holds no certificate. */
const RETRY_MS = 60_000;

/** How often it asks again while a renewal fails and the held certificate is still valid. */
const RETRY_RENEW_MS = 60 * 60 * 1000;

/** The PEM blocks of `text`, whole. */
function blocks(text: string): string[] {
  return text.match(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g) ?? [];
}

/** `tailscale cert`'s stdout (the chain and the key, in either order) as a certificate, or why it is not one. */
export function certificateOf(pem: string): Certificate | Error {
  const found = blocks(pem);
  const certs = found.filter((b) => b.startsWith("-----BEGIN CERTIFICATE-----"));
  const keys = found.filter((b) => /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(b));
  const [leaf] = certs;
  const [key] = keys;

  if (leaf === undefined) return new Error("no certificate in what tailscale cert gave");

  if (key === undefined || keys.length > 1) return new Error("not one private key in what tailscale cert gave");

  try {
    return { cert: `${certs.join("\n")}\n`, key: `${key}\n`, notAfter: new X509Certificate(leaf).validToDate };
  } catch (cause: unknown) {
    return new Error(`the certificate tailscale cert gave cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The certificates `tailscale cert` gives (`bin`), on stdout, valid 14 days at least. */
export function tailscaleCertificate(bin: string): CertificateSource {
  return async (name) => {
    try {
      const proc = Bun.spawn([bin, "cert", "--cert-file", "-", "--key-file", "-", "--min-validity", "336h", name], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), 120_000);
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);

      if (code !== 0) return new Error(err.trim().split("\n").at(-1)?.trim() || `exited ${String(code)}`);

      return certificateOf(out);
    } catch (cause: unknown) {
      return new Error(cause instanceof Error ? cause.message : String(cause));
    }
  };
}

/** What the certificate is made from. */
export interface PreviewCertificateOptions {
  readonly source: CertificateSource;
  /** This machine's MagicDNS name, while Tailscale says. */
  readonly name: () => string | undefined;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** The certificate the hub holds for the public ports, renewed as it nears its end. */
export class PreviewCertificate {
  private held: Named | undefined;
  /** Why none is held: the last refusal, or what stands in for one. */
  private reason = "the hub has not asked for this machine's certificate yet";
  /** When the one held last expired unrenewed, while none has replaced it. */
  private expired: Date | undefined;
  private lastTry = Number.NEGATIVE_INFINITY;
  /** Whether the last ask was refused. */
  private failed = false;
  private lastName: string | undefined;
  private running: Promise<void> | undefined;
  private readonly options: PreviewCertificateOptions;

  constructor(options: PreviewCertificateOptions) {
    this.options = options;
  }

  /** The certificate to serve with now, or why there is none. */
  current(): Named | NoCertificate {
    this.expire();

    if (this.held !== undefined) return this.held;

    return new NoCertificate(this.expired === undefined ? this.reason : `the certificate expired on ${this.expired.toISOString()} and could not be renewed: ${this.reason}`);
  }

  /** Let go of the certificate held once it has ended. */
  private expire(): void {
    if (this.held !== undefined && this.held.notAfter.getTime() <= this.options.now()) {
      this.expired = this.held.notAfter;
      this.held = undefined;
    }
  }

  /** Ask for the certificate when it is due: none held, a new name, or within 14 days of its end. */
  check(): Promise<void> {
    this.running ??= this.renew().finally(() => {
      this.running = undefined;
    });

    return this.running;
  }

  private due(name: string, now: number): boolean {
    this.expire();
    const held = this.held;

    if (held === undefined) return name !== this.lastName || now - this.lastTry >= RETRY_MS;

    if (held.name !== name) return true;

    return held.notAfter.getTime() - now <= RENEW_WITHIN_MS && (!this.failed || now - this.lastTry >= RETRY_RENEW_MS);
  }

  private async renew(): Promise<void> {
    const name = this.options.name();
    const now = this.options.now();

    if (name === undefined) {
      this.expire();

      if (this.held === undefined) {
        this.reason = "this machine has no MagicDNS name (is Tailscale running?)";
        this.expired = undefined;
      }

      return;
    }

    if (!this.due(name, now)) return;
    this.lastTry = now;
    this.lastName = name;
    const got = await this.options.source(name);

    this.failed = got instanceof Error;

    if (got instanceof Error) {
      const reason = `tailscale cert ${name}: ${got.message}`;

      if (reason !== this.reason) this.options.log(`no certificate for the preview ports: ${reason}`);
      this.reason = reason;

      if (this.held !== undefined && this.held.name !== name) {
        this.held = undefined;
        this.expired = undefined;
      }

      return;
    }

    this.held = { ...got, name };
    this.expired = undefined;
    this.options.log(`the preview ports' certificate for ${name} runs until ${got.notAfter.toISOString()}`);
  }
}
