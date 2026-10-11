// Latencies for a load run, kept in a fixed number of buckets: a run makes millions of requests, and
// an array of every sample would be the memory leak the run is supposed not to have.

/** Smallest latency told apart, in ms. */
const MIN_MS = 0.05;
/** Each bucket is this much wider than the one before: percentiles are within 4% of the truth. */
const GROWTH = 1.04;
const LOG_GROWTH = Math.log(GROWTH);
/** Up to MIN_MS * GROWTH^BUCKETS, which is over ten minutes. */
const BUCKETS = 420;

export class LatencyHistogram {
  readonly #counts = new Uint32Array(BUCKETS);
  #total = 0;
  #maxMs = 0;

  record(ms: number): void {
    const index =
      ms <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms / MIN_MS) / LOG_GROWTH));
    this.#counts[index] = (this.#counts[index] ?? 0) + 1;
    this.#total++;
    if (ms > this.#maxMs) {
      this.#maxMs = ms;
    }
  }

  get count(): number {
    return this.#total;
  }

  /** The latency that `p` percent of the samples were at or under, in ms. 0 when there are none. */
  percentile(p: number): number {
    if (this.#total === 0) {
      return 0;
    }
    const rank = Math.ceil((p / 100) * this.#total);
    let seen = 0;
    for (let index = 0; index < BUCKETS; index++) {
      seen += this.#counts[index] ?? 0;
      if (seen >= rank) {
        // The bucket's upper edge, and never more than the largest sample actually seen.
        return Math.min(MIN_MS * GROWTH ** index, this.#maxMs);
      }
    }
    return this.#maxMs;
  }

  summary(): { count: number; p50: number; p99: number; max: number } {
    const round = (ms: number) => Math.round(ms * 100) / 100;
    return {
      count: this.#total,
      p50: round(this.percentile(50)),
      p99: round(this.percentile(99)),
      max: round(this.#maxMs),
    };
  }
}

/** A repeatable source of random numbers in [0, 1): the same seed plays the same crowd again. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Counts per whole second since a start instant, for the run's timeline. */
export class PerSecond {
  readonly #counts: number[] = [];

  constructor(private readonly startedAt: number) {}

  add(at: number = Date.now(), n = 1): void {
    const second = Math.max(0, Math.floor((at - this.startedAt) / 1000));
    this.#counts[second] = (this.#counts[second] ?? 0) + n;
  }

  /** One number per second, zeros filled in. */
  series(seconds: number): number[] {
    return Array.from({ length: seconds }, (_, second) => this.#counts[second] ?? 0);
  }

  get peak(): number {
    return this.#counts.reduce((most, n) => Math.max(most, n ?? 0), 0);
  }
}
