"use client";

import { useEffect, useRef, useState } from "react";
import { serverNow } from "@/lib/api";
import { clockParts, formatClock, formatDuration } from "@/lib/format";

interface CountdownProps {
  /** The instant counted down to: epoch ms or an ISO string, always one the server gave. */
  to: number | string;
  /** Called once, when the instant is reached. */
  onDone?: () => void;
  /** Shown instead of the time once it is reached. */
  done?: string;
}

/**
 * The time left until a server-provided instant, re-read four times a second. Both ends are the
 * server's: the instant came from it, and "now" is its clock (serverNow), so a browser whose own
 * clock is off still counts down to the right moment.
 */
function useTimeLeft(to: number | string, onDone?: () => void): number {
  const target = typeof to === "number" ? to : Date.parse(to);
  const [now, setNow] = useState(() => serverNow());
  const fired = useRef(false);
  const callback = useRef(onDone);
  callback.current = onDone;

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const current = serverNow();
      setNow(current);
      if (current >= target && !fired.current) {
        fired.current = true;
        callback.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [target]);

  return target - now;
}

/** "~2m 05s", in a sentence. */
export function Countdown({ to, onDone, done = "now" }: CountdownProps) {
  const msLeft = useTimeLeft(to, onDone);
  return <span className="countdown">{msLeft > 0 ? formatDuration(msLeft / 1000) : done}</span>;
}

/** "09:58": the time left on a turn or a hold. */
export function CountdownTimer({ to, onDone, done = "00:00" }: CountdownProps) {
  const msLeft = useTimeLeft(to, onDone);
  return (
    <span className="countdown" role="timer">
      {msLeft > 0 ? formatClock(msLeft) : done}
    </span>
  );
}

/** Days, hours, minutes and seconds in four boxes: the clock on an event that has not opened. */
export function CountdownClock({ to, onDone }: Pick<CountdownProps, "to" | "onDone">) {
  const msLeft = useTimeLeft(to, onDone);
  const { days, hours, minutes, seconds } = clockParts(msLeft);
  const cells: [number, string][] = [
    [days, "days"],
    [hours, "hrs"],
    [minutes, "min"],
    [seconds, "sec"],
  ];
  return (
    <div className="clock" role="timer">
      {cells
        // No "00 days" on an event that opens today.
        .filter(([, unit]) => unit !== "days" || days > 0)
        .map(([value, unit]) => (
          <div className="clock__cell" key={unit}>
            <span className="clock__value">{String(value).padStart(2, "0")}</span>
            <span className="clock__unit">{unit}</span>
          </div>
        ))}
    </div>
  );
}
