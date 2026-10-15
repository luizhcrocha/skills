/** The headers of a chat post: JSON, and the page token the hub put in this page at its top-level load, which an
 * answer that grants (allow-once, allow-kind) or adds a rule (add-rule) needs (the hub's `grantRefusal`). */
export function chatHeaders(): Record<string, string> {
  const token = document.querySelector<HTMLMetaElement>('meta[name="fleet-page-token"]')?.content ?? "";

  return token === "" ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "X-Fleet-Page-Token": token };
}
