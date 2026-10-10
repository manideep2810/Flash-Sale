import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { loadAdmitterEnv, loadServerEnv } from "../src/config/env.js";
import { createTokenMinter } from "../src/queue/token.js";

const SECRET = "test-only-admission-secret-0123456789abcdef";
const key = (secret: string) => new TextEncoder().encode(secret);

describe("admission token", () => {
  const admittedAt = Date.now() - 1_500;
  const admission = { userId: "u1", eventId: "evt-1", admittedAt, admitTtlSec: 120 };

  it("carries the caller, the event and a lifetime fixed by admittedAt", async () => {
    const { token, expiresAt } = await createTokenMinter(SECRET)(admission);

    const { payload, protectedHeader } = await jwtVerify(token, key(SECRET), {
      audience: "reserve",
      issuer: "queue-svc",
    });
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("u1");
    expect(payload.eid).toBe("evt-1");
    expect(payload.iat).toBe(Math.floor(admittedAt / 1000));
    expect(payload.exp).toBe(Math.floor((admittedAt + 120_000) / 1000));
    expect(expiresAt).toBe(new Date(admittedAt + 120_000).toISOString());
  });

  it("is the same token every time it is minted for the same admission", async () => {
    const mint = createTokenMinter(SECRET);
    expect((await mint(admission)).token).toBe((await mint(admission)).token);
  });

  it("does not verify under another secret", async () => {
    const { token } = await createTokenMinter(SECRET)(admission);
    await expect(jwtVerify(token, key(`${SECRET}-other`))).rejects.toThrow();
  });
});

describe("env", () => {
  const base = {
    NODE_ENV: "test",
    PORT: "4100",
    LOG_LEVEL: "error",
    REDIS_URL: "redis://localhost:6380",
  };

  it("refuses to boot queue-svc with a missing or short ADMISSION_SECRET", () => {
    expect(() => loadServerEnv(base)).toThrow(/ADMISSION_SECRET/);
    expect(() => loadServerEnv({ ...base, ADMISSION_SECRET: "too-short" })).toThrow(
      /at least 32 bytes/,
    );
    expect(loadServerEnv({ ...base, ADMISSION_SECRET: SECRET }).ADMISSION_SECRET).toBe(SECRET);
  });

  it("boots the admitter without the secret, on its own port", () => {
    expect(loadAdmitterEnv(base).ADMITTER_PORT).toBe(3011);
    expect(() => loadAdmitterEnv({ ...base, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
  });
});
