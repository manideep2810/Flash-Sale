import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiFailure, devLogin, getQueueStatus, reserve, toFailure } from "./api";

// The API client's one job besides calling fetch: turn whatever came back into a failure with a code
// and our own sentence for it. fetch is replaced, so nothing here needs a server.

function answer(status: number, body: string, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(body, { status, headers }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failureOf(call: Promise<unknown>): Promise<ApiFailure> {
  try {
    await call;
  } catch (error) {
    return toFailure(error);
  }
  throw new Error("the call did not fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the API client's failures", () => {
  it("reads {code, message} from the gateway and the auth checks, and uses its own sentence", async () => {
    answer(401, JSON.stringify({ code: "UNAUTHENTICATED", message: "Jwt is missing" }));
    const failure = await failureOf(getQueueStatus("demo"));
    expect(failure).toMatchObject({ status: 401, code: "UNAUTHENTICATED", unauthenticated: true });
    expect(failure.message).toBe("You are not logged in. Log in to continue.");
    expect(failure.message).not.toContain("Jwt");
  });

  it("reads {error} from the order and stock errors", async () => {
    answer(409, JSON.stringify({ error: "SOLD_OUT" }));
    const failure = await failureOf(reserve("demo", 1, "an-admission-token"));
    expect(failure).toMatchObject({ status: 409, code: "SOLD_OUT" });
    expect(failure.message).toBe("Sold out.");
  });

  it("reads Retry-After from a 429, in milliseconds", async () => {
    answer(429, JSON.stringify({ code: "RATE_LIMITED", message: "x" }), { "retry-after": "7" });
    const failure = await failureOf(getQueueStatus("demo"));
    expect(failure).toMatchObject({ rateLimited: true, retryAfterMs: 7_000 });
  });

  it("reports a dropped connection, and a gateway that cannot reach the service, as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await failureOf(getQueueStatus("demo"))).toMatchObject({
      status: 0,
      code: "NETWORK",
      unavailable: true,
    });

    answer(503, "upstream connect error");
    expect(await failureOf(getQueueStatus("demo"))).toMatchObject({
      status: 503,
      unavailable: true,
    });
  });

  it("says to use the gateway when the app was opened on its own port", async () => {
    // What `next dev` answers for /api/...: its own 404 page. The gateway's 404s are JSON.
    answer(404, "<!DOCTYPE html><html><body>404</body></html>", { "content-type": "text/html" });
    const failure = await failureOf(devLogin("manideep"));
    expect(failure.code).toBe("NOT_BEHIND_GATEWAY");
    expect(failure.message).toContain("http://localhost:8080");

    // A JSON 404 is an ordinary one.
    answer(404, JSON.stringify({ code: "EVENT_NOT_FOUND", message: "x" }));
    expect((await failureOf(getQueueStatus("nope"))).code).toBe("EVENT_NOT_FOUND");
  });

  it("gives an unknown code a plain sentence, never the server's text", async () => {
    answer(418, JSON.stringify({ code: "SOMETHING_NEW", message: "stack trace at line 42" }));
    const failure = await failureOf(getQueueStatus("demo"));
    expect(failure.code).toBe("SOMETHING_NEW");
    expect(failure.message).toBe("That did not work. Try again.");
  });
});

describe("reserve", () => {
  it("makes no request at all without an admission token", async () => {
    const fetchMock = answer(201, JSON.stringify({ holdId: "x" }));
    const failure = await failureOf(reserve("demo", 1, ""));
    expect(failure.code).toBe("ADMISSION_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the admission token as X-Admission-Token", async () => {
    const fetchMock = answer(201, JSON.stringify({ holdId: "demo:alice:1" }));
    expect(await reserve("demo", 2, "the-admission-token")).toEqual({ holdId: "demo:alice:1" });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/reserve");
    expect(init.headers).toMatchObject({ "x-admission-token": "the-admission-token" });
    expect(init.body).toBe(JSON.stringify({ eventId: "demo", qty: 2 }));
  });
});
