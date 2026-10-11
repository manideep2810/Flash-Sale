/** "~40s", "~2m 05s", "~3h 20m", "~2d 4h". For waits and countdowns. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const two = (value: number) => String(value).padStart(2, "0");
  if (seconds >= 86_400) {
    return `~${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  }
  if (seconds >= 3_600) {
    return `~${Math.floor(seconds / 3_600)}h ${two(Math.floor((seconds % 3_600) / 60))}m`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `~${minutes}m ${two(seconds % 60)}s` : `~${seconds}s`;
}

/** A clock time in the reader's locale, from epoch ms or an ISO string. */
export function formatTime(when: number | string): string {
  return new Date(when).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "Sat 11 Oct, 7:30 pm": the day and the time, in the reader's locale and time zone. */
export function formatDateTime(when: number | string): string {
  return new Date(when).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The currency every price is in: an ISO 4217 code. The backend stores amounts in the smallest unit
 * and names no currency, so this is the one place that does. NEXT_PUBLIC_CURRENCY overrides it at
 * build time.
 */
export const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY || "INR";

// A fixed locale, so that the server-rendered page and the browser print the same text.
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: CURRENCY });
const wholeNumber = new Intl.NumberFormat("en-IN");

/** A price held in the smallest currency unit, with its currency: "₹3,499.00". */
export function formatPrice(minorUnits: number): string {
  return money.format(minorUnits / 100);
}

/** "12,480". */
export function formatCount(value: number): string {
  return wholeNumber.format(value);
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

/** The split of a time left into the four numbers a countdown clock shows. */
export function clockParts(msLeft: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

/** "09:58", or "1:04:09" from an hour up. For the time left on a turn or a hold. */
export function formatClock(msLeft: number): string {
  const { days, hours, minutes, seconds } = clockParts(msLeft);
  const two = (value: number) => String(value).padStart(2, "0");
  const allHours = days * 24 + hours;
  return allHours > 0
    ? `${allHours}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}
