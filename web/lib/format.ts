/** "~2m 05s", "~40s". For waits and countdowns. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `~${minutes}m ${String(rest).padStart(2, "0")}s` : `~${rest}s`;
}

/** A clock time in the reader's locale, from epoch ms or an ISO string. */
export function formatTime(when: number | string): string {
  return new Date(when).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A price held in the smallest currency unit, as a decimal amount. */
export function formatPrice(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

/**
 * The event an order belongs to. An order's id is the hold's: `<eventId>:<userId>:<timestamp>`, and
 * the order API returns nothing else that names the event.
 */
export function eventOfOrder(orderId: string): string | null {
  const last = orderId.lastIndexOf(":");
  const middle = orderId.lastIndexOf(":", last - 1);
  return last > 0 && middle > 0 ? orderId.slice(0, middle) : null;
}

/** A dynamic route segment as the user meant it: Next hands some of them over still URL-encoded. */
export function segment(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
