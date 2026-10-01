/**
 * The fleet mark: one hub, three workers. The masthead shows it, and the favicon is it with the unread
 * count on it.
 */

/** The mark as SVG markup, with a count badge when `badge` is not 0 (red when `critical`). */
export function fleetMark(badge: number | string, critical: boolean): string {
  const text = String(badge);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#1e1b4b"/>
    <path d="M32 33L15 19M32 33l17-14M32 33v18" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round"/>
    <circle cx="15" cy="19" r="7" fill="#818cf8"/><circle cx="49" cy="19" r="7" fill="#818cf8"/><circle cx="32" cy="51" r="7" fill="#818cf8"/>
    <circle cx="32" cy="33" r="10" fill="#eef2ff"/>
    ${badge ? `<circle cx="48" cy="48" r="15" fill="${critical ? "#dc2626" : "#4f46e5"}" stroke="#1e1b4b" stroke-width="3"/><text x="48" y="54" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${text.length > 1 ? 16 : 19}" font-weight="700" fill="#fff">${text}</text>` : ""}
  </svg>`;
}

/** The favicon's address for `unread` notifications. */
export function faviconOf(unread: number, critical: boolean): string {
  return "data:image/svg+xml," + encodeURIComponent(fleetMark(unread > 99 ? "99" : unread, critical).replace(/\s+/gu, " "));
}
