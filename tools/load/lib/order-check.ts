// The judgement of a waiting-room run, as pure functions: given what each simulated user saw and
// what Redis held at the end, was the line served in order, and is everybody accounted for?
// tools/check-queue-order.ts reads the files and Redis and prints the verdict; the rules are here so
// that they can be tested against runs made up by hand (order-check.test.ts).

/** One stay in the queue, as the simulator logged it (tools/load/waiting-room-sim.ts). */
export interface LoggedCycle {
  /** The simulator's clock, ms: when the join was sent, and when its answer arrived. */
  joinSentAt: number;
  joinedAt: number;
  /** The user's score in the queue. Null when the user was admitted before it could be read. */
  score: number | null;
  /** Redis's clock, ms, as admit.lua stamped it. Null when the user never saw ADMITTED. */
  admittedAt: number | null;
  expiredAt: number | null;
}

export interface LoggedUser {
  userId: string;
  finalState: string;
  cycles: LoggedCycle[];
}

export interface RunFacts {
  users: LoggedUser[];
  /** The queue zset at the end: userId -> score. */
  queued: Map<string, number>;
  /** The admitted hash at the end: userId -> admittedAt (Redis's clock, ms). */
  admitted: Map<string, number>;
  /** Redis's clock minus the simulator's, ms, and how far off that measurement may be. */
  clockOffsetMs: number;
  clockUncertaintyMs: number;
}

/** A lottery score is in [0, 1); anything from 1 up is the Redis time of a join after the sale opened. */
export const isLotteryScore = (score: number): boolean => score < 1;

/** One user served after another who should have come later. */
export interface Inversion {
  userId: string;
  score: number;
  /** Null: never admitted at all. */
  admittedAt: number | null;
  /** Who went first with a higher score, and when. */
  aheadUserId: string;
  aheadScore: number;
  aheadAdmittedAt: number;
}

export interface OrderVerdict {
  /** Stays in the queue that could be compared: those with a known score. */
  compared: number;
  /** Distinct admittedAt values, each one tick of the admitter. */
  ticks: number;
  /** Users served after (or never, while) someone with a HIGHER score was served. Must be empty. */
  inversions: Inversion[];
  /**
   * Lottery-score users whose join was still on its way when the higher-scored user was admitted
   * (or too close to tell, given the clocks). They were not in the line yet, so nobody jumped it;
   * they are counted and set aside.
   */
  concurrent: number;
  /** Stays whose score was never read, because the user was admitted within a tick of joining. */
  unknownScore: number;
  lobby: {
    /** Stays with a lottery score, and how many of those were admitted. */
    stays: number;
    admitted: number;
    /** Stays with a timestamp score that were admitted. */
    postOpenAdmitted: number;
    /** The inversions in which a lottery-score user lost out to a post-open one. Must be empty. */
    servedAfterPostOpen: Inversion[];
  };
}

interface Stay {
  userId: string;
  score: number;
  /** Infinity: still in the queue at the end, never admitted. */
  admittedAt: number;
  /** Redis's clock: the window in which the user's entry reached the queue. */
  joinSentAt: number;
  joinedAt: number;
}

/** Range maximum over an array that does not change: O(n log n) to build, O(1) to ask. */
class RangeMax {
  readonly #levels: Float64Array[] = [];
  readonly #argLevels: Int32Array[] = [];

  constructor(values: number[]) {
    let level = Float64Array.from(values);
    let args = Int32Array.from(values.keys());
    this.#levels.push(level);
    this.#argLevels.push(args);
    for (let width = 1; width * 2 <= values.length; width *= 2) {
      const size = level.length - width;
      const next = new Float64Array(size);
      const nextArgs = new Int32Array(size);
      for (let i = 0; i < size; i++) {
        const left = level[i] ?? Number.NEGATIVE_INFINITY;
        const right = level[i + width] ?? Number.NEGATIVE_INFINITY;
        next[i] = Math.max(left, right);
        nextArgs[i] = (left >= right ? args[i] : args[i + width]) ?? -1;
      }
      level = next;
      args = nextArgs;
      this.#levels.push(level);
      this.#argLevels.push(args);
    }
  }

  /** The index of the largest value in [from, to), or -1 when the range is empty. */
  argMax(from: number, to: number): number {
    if (to <= from) {
      return -1;
    }
    const k = Math.floor(Math.log2(to - from));
    const level = this.#levels[k];
    const args = this.#argLevels[k];
    if (!level || !args) {
      return -1;
    }
    const right = to - 2 ** k;
    return ((level[from] ?? 0) >= (level[right] ?? 0) ? args[from] : args[right]) ?? -1;
  }
}

/** The first index whose value is greater than `threshold`, in an ascending array. */
function firstAbove(sorted: number[], threshold: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? Number.POSITIVE_INFINITY) > threshold) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/**
 * Was the line served in order?
 *
 * The admitter takes the lowest scores first (ZPOPMIN), a batch each tick, and stamps the whole
 * batch with one admittedAt. So within a tick order means nothing, and across ticks a user must
 * never be served later than someone with a HIGHER score, provided they were in the line by then.
 *
 * "In the line by then" needs no clock for a post-open user: their score IS the Redis time their
 * entry was added, so a lower score was there first. A lottery-score user's entry time is not in
 * the score, so it comes from the simulator's log, moved onto Redis's clock: an inversion only when
 * the join's answer had arrived before the other user's tick, by more than the clocks' uncertainty.
 * A join still in flight at that tick is "concurrent": counted, set aside, not a failure.
 *
 * A user who was never admitted and is still in the queue counts as served "after everyone": if
 * somebody with a higher score got in while they were waiting, that is an inversion too.
 */
export function checkAdmissionOrder(facts: RunFacts): OrderVerdict {
  const toRedis = (clientMs: number) => clientMs + facts.clockOffsetMs;
  // A margin for the two clocks, and a few ms for the round trip the score read took.
  const margin = facts.clockUncertaintyMs + 5;

  const stays: Stay[] = [];
  let unknownScore = 0;
  for (const user of facts.users) {
    user.cycles.forEach((cycle, index) => {
      const last = index === user.cycles.length - 1;
      // An earlier stay ended when its turn expired. The last one may still be in the queue, or may
      // have been admitted after the simulator stopped watching; Redis knows either way.
      let admittedAt = cycle.admittedAt;
      let score = cycle.score;
      if (last && admittedAt === null) {
        const stamp = facts.admitted.get(user.userId);
        if (stamp !== undefined) {
          admittedAt = stamp;
        } else if (facts.queued.has(user.userId)) {
          admittedAt = Number.POSITIVE_INFINITY;
        }
      }
      if (last && score === null) {
        score = facts.queued.get(user.userId) ?? null;
      }
      if (admittedAt === null) {
        // Neither admitted nor in the queue: a conservation matter, not an ordering one.
        return;
      }
      if (score === null) {
        unknownScore++;
        return;
      }
      stays.push({
        userId: user.userId,
        score,
        admittedAt,
        joinSentAt: toRedis(cycle.joinSentAt),
        joinedAt: toRedis(cycle.joinedAt),
      });
    });
  }

  stays.sort((a, b) => a.admittedAt - b.admittedAt);
  const times = stays.map((stay) => stay.admittedAt);
  const scores = new RangeMax(stays.map((stay) => stay.score));
  const inversions: Inversion[] = [];
  let concurrent = 0;

  let tickStart = 0;
  stays.forEach((stay, index) => {
    if (stay.admittedAt !== stays[tickStart]?.admittedAt) {
      tickStart = index;
    }
    // Everyone admitted in an earlier tick is in [0, tickStart).
    const jumpedBy = (from: number): Stay | null => {
      const best = stays[scores.argMax(from, tickStart)];
      return best && best.score > stay.score ? best : null;
    };

    let ahead: Stay | null;
    if (isLotteryScore(stay.score)) {
      // Only those admitted after this user's entry was certainly in the queue...
      ahead = jumpedBy(firstAbove(times, stay.joinedAt + margin));
      // ...and, failing that, those admitted while the join may have been on its way.
      if (!ahead && jumpedBy(firstAbove(times, stay.joinSentAt - margin))) {
        concurrent++;
      }
    } else {
      ahead = jumpedBy(0);
    }
    if (ahead) {
      inversions.push({
        userId: stay.userId,
        score: stay.score,
        admittedAt: Number.isFinite(stay.admittedAt) ? stay.admittedAt : null,
        aheadUserId: ahead.userId,
        aheadScore: ahead.score,
        aheadAdmittedAt: ahead.admittedAt,
      });
    }
  });

  const lottery = stays.filter((stay) => isLotteryScore(stay.score));
  return {
    compared: stays.length,
    ticks: new Set(times.filter(Number.isFinite)).size,
    inversions,
    concurrent,
    unknownScore,
    lobby: {
      stays: lottery.length,
      admitted: lottery.filter((stay) => Number.isFinite(stay.admittedAt)).length,
      postOpenAdmitted: stays.filter(
        (stay) => !isLotteryScore(stay.score) && Number.isFinite(stay.admittedAt),
      ).length,
      servedAfterPostOpen: inversions.filter(
        (found) => isLotteryScore(found.score) && !isLotteryScore(found.aheadScore),
      ),
    },
  };
}

export interface ConservationVerdict {
  /** Users whose join was answered: each must be in exactly one of the next three. */
  joined: number;
  stillQueued: number;
  /** Saw ADMITTED. `leftAfterExpiry` of them let the turn run out and did not come back. */
  admitted: number;
  leftAfterExpiry: number;
  /** Not admitted by the log, but in Redis's admitted hash: let in after the simulator stopped. */
  admittedAfterRunStopped: number;
  /** Joined, and now neither in the queue nor ever admitted. Must be empty. */
  missing: string[];
  /** Admitted by the log and still in the queue. Must be empty. */
  inBoth: string[];
  /** In Redis's admitted hash with a different stamp than the user was told. Must be empty. */
  stampMismatch: string[];
  /** In the queue at the end but not in the log: somebody else's users, or joins cut off mid-way. */
  unknownInQueue: number;
}

/**
 * Is everybody accounted for? joined = still queued + admitted (whatever they did next) + admitted
 * after the run stopped watching. Anyone left over was lost by the waiting room.
 */
export function checkConservation(facts: RunFacts): ConservationVerdict {
  const verdict: ConservationVerdict = {
    joined: 0,
    stillQueued: 0,
    admitted: 0,
    leftAfterExpiry: 0,
    admittedAfterRunStopped: 0,
    missing: [],
    inBoth: [],
    stampMismatch: [],
    unknownInQueue: 0,
  };
  const known = new Set<string>();
  for (const user of facts.users) {
    const last = user.cycles.at(-1);
    if (!last) {
      // The join was never answered QUEUED or ADMITTED (sold out at the door, or an error).
      continue;
    }
    known.add(user.userId);
    verdict.joined++;
    const inQueue = facts.queued.has(user.userId);
    const stamp = facts.admitted.get(user.userId);
    // A user who polls every fifteen seconds can be admitted and run out of time between two
    // polls: the server then says EXPIRED to someone who never saw ADMITTED. They were admitted.
    const expired = last.expiredAt !== null || user.finalState === "EXPIRED";
    if (last.admittedAt !== null || expired) {
      verdict.admitted++;
      if (expired) {
        verdict.leftAfterExpiry++;
      }
      if (inQueue) {
        verdict.inBoth.push(user.userId);
      }
      if (stamp !== undefined && last.admittedAt !== null && stamp !== last.admittedAt) {
        verdict.stampMismatch.push(user.userId);
      }
    } else if (inQueue) {
      verdict.stillQueued++;
    } else if (stamp !== undefined) {
      verdict.admittedAfterRunStopped++;
    } else {
      verdict.missing.push(user.userId);
    }
  }
  for (const userId of facts.queued.keys()) {
    if (!known.has(userId)) {
      verdict.unknownInQueue++;
    }
  }
  return verdict;
}
