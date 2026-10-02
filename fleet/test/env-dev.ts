/**
 * A stand-in dev server for the preview's environment test: `bun env-dev.ts PORT NAME` answers every
 * request with the value of its environment variable NAME (empty when unset), as an app reads a secret.
 */
const [portText = "0", name = ""] = process.argv.slice(2);

Bun.serve({ hostname: "127.0.0.1", port: Number(portText), fetch: () => new Response(process.env[name] ?? "") });

export {};
