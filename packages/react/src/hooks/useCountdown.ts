import { useEffect, useState } from 'react';
import { formatRemaining } from '../util.js';

export interface Countdown {
  /** Milliseconds left, 0 when expired or when `iso` is undefined. */
  remainingMs: number;
  /** "12:34" / "1h 05m" / "2d 03h". Empty when nothing is counting. */
  label: string;
  /** True while a future instant is being counted down. */
  active: boolean;
}

/** Counts down to an ISO instant, ticking once a second only while the instant is in the future. */
export function useCountdown(iso: string | undefined, now: () => number = Date.now): Countdown {
  const target = iso ? new Date(iso).getTime() : NaN;
  const compute = () => (Number.isNaN(target) ? 0 : Math.max(0, target - now()));
  const [remaining, setRemaining] = useState<number>(compute);

  useEffect(() => {
    setRemaining(compute());
    if (Number.isNaN(target) || target <= now()) return;
    const id = setInterval(() => {
      const r = compute();
      setRemaining(r);
      if (r <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  return {
    remainingMs: remaining,
    label: remaining > 0 ? formatRemaining(remaining) : '',
    active: remaining > 0,
  };
}
