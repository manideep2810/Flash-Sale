"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/format";

interface CountdownProps {
  /** The instant counted down to: epoch ms or an ISO string, always one the server gave. */
  to: number | string;
  /** Called once, when the instant is reached. */
  onDone?: () => void;
  /** Shown instead of the time once it is reached. */
  done?: string;
}

/** Time left until a server-provided instant. The instant is the server's; only the ticking is local. */
export function Countdown({ to, onDone, done = "now" }: CountdownProps) {
  const target = typeof to === "number" ? to : Date.parse(to);
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  const callback = useRef(onDone);
  callback.current = onDone;

  useEffect(() => {
    fired.current = false;
    const tick = () => {
      const current = Date.now();
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

  const secondsLeft = (target - now) / 1000;
  return <span className="countdown">{secondsLeft > 0 ? formatDuration(secondsLeft) : done}</span>;
}
