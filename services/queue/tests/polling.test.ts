import { describe, expect, it } from "vitest";
import { pollingFor } from "../src/queue/polling.js";

const lowest = () => 0;
const highest = () => 1;

describe("pollingFor", () => {
  it("estimates the wait from the rank and the admit rate, rounded up", () => {
    expect(pollingFor(0, 500, false).estWaitSec).toBe(0);
    expect(pollingFor(1, 500, false).estWaitSec).toBe(1);
    expect(pollingFor(500, 500, false).estWaitSec).toBe(1);
    expect(pollingFor(501, 500, false).estWaitSec).toBe(2);
    expect(pollingFor(30_000, 500, false).estWaitSec).toBe(60);
  });

  it("polls a quarter of the way through the wait, held between 2s and 15s, +/-20%", () => {
    // Front of the line: the 2s floor.
    expect(pollingFor(0, 500, false, lowest).retryAfterMs).toBe(1_600);
    expect(pollingFor(0, 500, false, highest).retryAfterMs).toBe(2_400);
    // A 20s wait: a quarter of it is 5s.
    expect(pollingFor(10_000, 500, false, lowest).retryAfterMs).toBe(4_000);
    expect(pollingFor(10_000, 500, false, highest).retryAfterMs).toBe(6_000);
    // A very long wait: the 15s ceiling.
    expect(pollingFor(1_000_000, 500, false, lowest).retryAfterMs).toBe(12_000);
    expect(pollingFor(1_000_000, 500, false, highest).retryAfterMs).toBe(18_000);
  });

  it("gives no estimate in the lobby and polls every 5s +/-20%", () => {
    expect(pollingFor(123, 500, true, lowest)).toEqual({ estWaitSec: null, retryAfterMs: 4_000 });
    expect(pollingFor(123, 500, true, highest)).toEqual({ estWaitSec: null, retryAfterMs: 6_000 });
  });
});
