import { describe, expect, it } from "vitest";
import {
  checkAdmissionOrder,
  checkConservation,
  type LoggedCycle,
  type LoggedUser,
  type RunFacts,
} from "./order-check.js";

// Runs made up by hand, to show that the checker passes what is in order and, above all, that it
// FAILS what is not: a checker that cannot fail proves nothing about a real run.

const SALE_OPENS = 1_000_000;
/** Ticks of the admitter, 100 ms apart, starting when the sale opens. */
const tick = (n: number) => SALE_OPENS + n * 100;

function stay(over: Partial<LoggedCycle> & { score: number | null }): LoggedCycle {
  // By default the join was answered long before anyone was admitted.
  return { joinSentAt: 500_000, joinedAt: 500_010, admittedAt: null, expiredAt: null, ...over };
}

const user = (userId: string, finalState: string, ...cycles: LoggedCycle[]): LoggedUser => ({
  userId,
  finalState,
  cycles,
});

function facts(users: LoggedUser[], over: Partial<RunFacts> = {}): RunFacts {
  return {
    users,
    queued: new Map(),
    admitted: new Map(),
    clockOffsetMs: 0,
    clockUncertaintyMs: 1,
    ...over,
  };
}

describe("checkAdmissionOrder", () => {
  it("passes a line served lowest score first, lobby before everyone who came after", () => {
    const verdict = checkAdmissionOrder(
      facts([
        user("lobby-a", "PAID", stay({ score: 0.1, admittedAt: tick(0) })),
        user("lobby-b", "PAID", stay({ score: 0.7, admittedAt: tick(0) })),
        user("lobby-c", "NO_SHOW", stay({ score: 0.9, admittedAt: tick(1) })),
        user("open-a", "PAID", stay({ score: SALE_OPENS + 5, admittedAt: tick(2) })),
        user("open-b", "PAID", stay({ score: SALE_OPENS + 40, admittedAt: tick(2) })),
        user("open-c", "PAID", stay({ score: SALE_OPENS + 90, admittedAt: tick(3) })),
      ]),
    );
    expect(verdict.inversions).toEqual([]);
    expect(verdict).toMatchObject({ compared: 6, ticks: 4, concurrent: 0, unknownScore: 0 });
    expect(verdict.lobby).toMatchObject({ stays: 3, admitted: 3, postOpenAdmitted: 3 });
  });

  it("does not care about the order inside one tick", () => {
    const verdict = checkAdmissionOrder(
      facts([
        user("high", "PAID", stay({ score: SALE_OPENS + 90, admittedAt: tick(4) })),
        user("low", "PAID", stay({ score: SALE_OPENS + 10, admittedAt: tick(4) })),
      ]),
    );
    expect(verdict.inversions).toEqual([]);
    expect(verdict.ticks).toBe(1);
  });

  it("FAILS when someone who joined later is admitted in an earlier tick", () => {
    const verdict = checkAdmissionOrder(
      facts([
        user("first", "PAID", stay({ score: SALE_OPENS + 10, admittedAt: tick(5) })),
        user("jumper", "PAID", stay({ score: SALE_OPENS + 300, admittedAt: tick(4) })),
        user("fine", "PAID", stay({ score: SALE_OPENS + 400, admittedAt: tick(6) })),
      ]),
    );
    expect(verdict.inversions).toEqual([
      {
        userId: "first",
        score: SALE_OPENS + 10,
        admittedAt: tick(5),
        aheadUserId: "jumper",
        aheadScore: SALE_OPENS + 300,
        aheadAdmittedAt: tick(4),
      },
    ]);
  });

  it("FAILS when a post-open user gets in before a lobby user who was already waiting", () => {
    const verdict = checkAdmissionOrder(
      facts([
        user("lobby", "PAID", stay({ score: 0.4, admittedAt: tick(9) })),
        user("open", "PAID", stay({ score: SALE_OPENS + 20, admittedAt: tick(3) })),
      ]),
    );
    expect(verdict.inversions).toHaveLength(1);
    expect(verdict.lobby.servedAfterPostOpen.map((found) => found.userId)).toEqual(["lobby"]);
  });

  it("FAILS when someone still in the queue was passed over", () => {
    const verdict = checkAdmissionOrder(
      facts(
        [
          user("waiting", "QUEUED_AT_STOP", stay({ score: SALE_OPENS + 10 })),
          user("passed", "PAID", stay({ score: SALE_OPENS + 50, admittedAt: tick(2) })),
        ],
        { queued: new Map([["waiting", SALE_OPENS + 10]]) },
      ),
    );
    expect(verdict.inversions).toMatchObject([
      { userId: "waiting", admittedAt: null, aheadUserId: "passed" },
    ]);
  });

  it("passes a queue that simply had not drained when the run stopped", () => {
    const verdict = checkAdmissionOrder(
      facts(
        [
          user("served", "PAID", stay({ score: SALE_OPENS + 10, admittedAt: tick(2) })),
          user("waiting", "QUEUED_AT_STOP", stay({ score: SALE_OPENS + 50 })),
        ],
        { queued: new Map([["waiting", SALE_OPENS + 50]]) },
      ),
    );
    expect(verdict.inversions).toEqual([]);
    expect(verdict.compared).toBe(2);
  });

  it("sets aside a lottery user who was not in the line yet, and one whose join was in flight", () => {
    const admittedEarlier = user("early", "PAID", stay({ score: 0.9, admittedAt: tick(1) }));
    // Drew a lower number, but the join was only sent after "early" had been admitted.
    const cameLater = user(
      "late",
      "PAID",
      stay({ score: 0.2, joinSentAt: tick(1) + 50, joinedAt: tick(1) + 60, admittedAt: tick(2) }),
    );
    expect(checkAdmissionOrder(facts([admittedEarlier, cameLater]))).toMatchObject({
      inversions: [],
      concurrent: 0,
    });

    // Sent before that tick, answered after it: the entry may or may not have been there.
    const inFlight = user(
      "flying",
      "PAID",
      stay({ score: 0.2, joinSentAt: tick(1) - 20, joinedAt: tick(1) + 20, admittedAt: tick(2) }),
    );
    expect(checkAdmissionOrder(facts([admittedEarlier, inFlight]))).toMatchObject({
      inversions: [],
      concurrent: 1,
    });

    // Answered well before the tick: it was in the line, and was passed over.
    const wasThere = user(
      "there",
      "PAID",
      stay({ score: 0.2, joinSentAt: tick(1) - 500, joinedAt: tick(1) - 400, admittedAt: tick(2) }),
    );
    expect(checkAdmissionOrder(facts([admittedEarlier, wasThere])).inversions).toHaveLength(1);
  });

  it("puts the simulator's times on Redis's clock before comparing them", () => {
    // The simulator's clock is 10 s behind Redis's. By its own clock the join looks long done
    // before the tick; on Redis's clock it was sent after it.
    const early = user("early", "PAID", stay({ score: 0.9, admittedAt: tick(1) }));
    const late = user(
      "late",
      "PAID",
      stay({
        score: 0.2,
        joinSentAt: tick(1) + 50 - 10_000,
        joinedAt: tick(1) + 60 - 10_000,
        admittedAt: tick(2),
      }),
    );
    expect(checkAdmissionOrder(facts([early, late])).inversions).toHaveLength(1);
    expect(checkAdmissionOrder(facts([early, late], { clockOffsetMs: 10_000 })).inversions).toEqual(
      [],
    );
  });

  it("treats a second stay after an expired turn as a new place in line", () => {
    const verdict = checkAdmissionOrder(
      facts([
        user(
          "came-back",
          "PAID",
          stay({ score: 0.3, admittedAt: tick(0), expiredAt: tick(0) + 10_000 }),
          stay({ score: SALE_OPENS + 11_000, admittedAt: tick(200) }),
        ),
        user("lobby-late", "PAID", stay({ score: 0.8, admittedAt: tick(50) })),
        user("open", "PAID", stay({ score: SALE_OPENS + 2_000, admittedAt: tick(120) })),
      ]),
    );
    expect(verdict.inversions).toEqual([]);
    expect(verdict.compared).toBe(4);
  });

  it("counts, and does not judge, a stay whose score was never read", () => {
    const verdict = checkAdmissionOrder(
      facts([
        user("instant", "PAID", stay({ score: null, admittedAt: tick(1) })),
        user("normal", "PAID", stay({ score: SALE_OPENS + 10, admittedAt: tick(2) })),
      ]),
    );
    expect(verdict).toMatchObject({ compared: 1, unknownScore: 1, inversions: [] });
  });

  it("uses Redis's stamp for a user admitted after the simulator stopped watching", () => {
    const verdict = checkAdmissionOrder(
      facts(
        [
          user("unwatched", "QUEUED_AT_STOP", stay({ score: SALE_OPENS + 500 })),
          user("first", "PAID", stay({ score: SALE_OPENS + 10, admittedAt: tick(8) })),
        ],
        // Admitted in tick 3, ahead of "first", who had the lower score.
        { admitted: new Map([["unwatched", tick(3)]]) },
      ),
    );
    expect(verdict.inversions.map((found) => found.userId)).toEqual(["first"]);
  });

  it("holds up on a large run", () => {
    const users = Array.from({ length: 50_000 }, (_, i) =>
      user(`u${i}`, "PAID", stay({ score: SALE_OPENS + i, admittedAt: tick(Math.floor(i / 50)) })),
    );
    expect(checkAdmissionOrder(facts(users)).inversions).toEqual([]);
    // One user moved a thousand ticks early.
    const moved = users[40_000];
    if (moved?.cycles[0]) {
      moved.cycles[0].admittedAt = tick(1);
    }
    const verdict = checkAdmissionOrder(facts(users));
    // Everyone admitted in ticks 2 to 799 had a lower score than the one who jumped.
    expect(verdict.inversions.length).toBe(40_000 - 100);
    expect(verdict.inversions[0]?.aheadUserId).toBe("u40000");
  });
});

describe("checkConservation", () => {
  it("accounts for everyone: still queued, admitted, or admitted after the run stopped", () => {
    const verdict = checkConservation(
      facts(
        [
          user("paid", "PAID", stay({ score: 0.1, admittedAt: tick(0) })),
          user("no-show", "NO_SHOW", stay({ score: 0.2, admittedAt: tick(0) })),
          user(
            "expired",
            "EXPIRED",
            stay({ score: 0.3, admittedAt: tick(0), expiredAt: tick(200) }),
          ),
          user("queued", "QUEUED_AT_STOP", stay({ score: SALE_OPENS + 9 })),
          user("sold-out-in-line", "SOLD_OUT", stay({ score: SALE_OPENS + 12 })),
          user("unwatched", "QUEUED_AT_STOP", stay({ score: SALE_OPENS + 15 })),
          // Refused at the door: never in the line, so not part of the count.
          user("sold-out-at-join", "SOLD_OUT"),
        ],
        {
          queued: new Map([
            ["queued", SALE_OPENS + 9],
            ["sold-out-in-line", SALE_OPENS + 12],
            ["somebody-else", SALE_OPENS + 20],
          ]),
          admitted: new Map([
            ["no-show", tick(0)],
            ["unwatched", tick(30)],
          ]),
        },
      ),
    );
    expect(verdict).toEqual({
      joined: 6,
      stillQueued: 2,
      admitted: 3,
      leftAfterExpiry: 1,
      admittedAfterRunStopped: 1,
      missing: [],
      inBoth: [],
      stampMismatch: [],
      unknownInQueue: 1,
    });
  });

  it("FAILS on a user who joined and is nowhere", () => {
    const verdict = checkConservation(
      facts([
        user("fine", "PAID", stay({ score: 0.1, admittedAt: tick(0) })),
        user("lost", "QUEUED_AT_STOP", stay({ score: SALE_OPENS + 9 })),
      ]),
    );
    expect(verdict.missing).toEqual(["lost"]);
    expect(verdict.joined).toBe(2);
  });

  it("FAILS on a user who was admitted and is still in the queue, or was told another stamp", () => {
    const verdict = checkConservation(
      facts(
        [
          user("twice", "PAID", stay({ score: 0.1, admittedAt: tick(0) })),
          user("restamped", "PAID", stay({ score: 0.2, admittedAt: tick(0) })),
        ],
        {
          queued: new Map([["twice", 0.1]]),
          admitted: new Map([["restamped", tick(7)]]),
        },
      ),
    );
    expect(verdict.inBoth).toEqual(["twice"]);
    expect(verdict.stampMismatch).toEqual(["restamped"]);
  });

  it("counts as admitted a user who was told EXPIRED without ever seeing ADMITTED", () => {
    const verdict = checkConservation(
      facts([user("slow-poller", "EXPIRED", stay({ score: 0.5, expiredAt: tick(150) }))]),
    );
    expect(verdict).toMatchObject({ joined: 1, admitted: 1, leftAfterExpiry: 1, missing: [] });
  });
});
