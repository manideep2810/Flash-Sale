import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const SECRET = "test-only-admission-secret-0123456789abcdef";

const base = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "error",
  SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
  ADMISSION_SECRET: SECRET,
};

describe("ticket config", () => {
  it("12. rejects a missing ADMISSION_SECRET, and one under 32 bytes", () => {
    const { ADMISSION_SECRET: _omitted, ...withoutSecret } = base;
    expect(() => parseConfig(withoutSecret)).toThrow(/ADMISSION_SECRET/);
    expect(() => parseConfig({ ...base, ADMISSION_SECRET: "" })).toThrow(/at least 32 bytes/);
    expect(() => parseConfig({ ...base, ADMISSION_SECRET: "x".repeat(31) })).toThrow(
      /at least 32 bytes/,
    );
    expect(
      parseConfig({ ...base, ADMISSION_SECRET: "x".repeat(32) }).ADMISSION_SECRET,
    ).toHaveLength(32);
    // Bytes, not characters: 16 two-byte characters are enough.
    expect(() => parseConfig({ ...base, ADMISSION_SECRET: "é".repeat(16) })).not.toThrow();
  });

  it("rejects a missing SESSION_SECRET, and one under 32 bytes", () => {
    const { SESSION_SECRET: _omitted, ...withoutSecret } = base;
    expect(() => parseConfig(withoutSecret)).toThrow(/SESSION_SECRET/);
    expect(() => parseConfig({ ...base, SESSION_SECRET: "x".repeat(31) })).toThrow(
      /at least 32 bytes/,
    );
    // Needed with the admission check off as well: that flag does not turn off the login.
    expect(() => parseConfig({ ...withoutSecret, REQUIRE_ADMISSION: "false" })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it("requires admission unless REQUIRE_ADMISSION says otherwise", () => {
    expect(parseConfig(base).REQUIRE_ADMISSION).toBe(true);
    expect(parseConfig({ ...base, REQUIRE_ADMISSION: "true" }).REQUIRE_ADMISSION).toBe(true);
    expect(parseConfig({ ...base, REQUIRE_ADMISSION: "false" }).REQUIRE_ADMISSION).toBe(false);
    expect(() => parseConfig({ ...base, REQUIRE_ADMISSION: "sometimes" })).toThrow(
      /REQUIRE_ADMISSION/,
    );
  });

  it("11. refuses REQUIRE_ADMISSION=false in production", () => {
    const production = { ...base, NODE_ENV: "production" };
    expect(() => parseConfig({ ...production, REQUIRE_ADMISSION: "false" })).toThrow(
      /REQUIRE_ADMISSION=false is not allowed with NODE_ENV=production/,
    );
    expect(parseConfig(production).REQUIRE_ADMISSION).toBe(true);
    // Still required with the check off: the secret is validated whatever the flag says.
    const { ADMISSION_SECRET: _omitted, ...noSecret } = base;
    expect(() => parseConfig({ ...noSecret, REQUIRE_ADMISSION: "false" })).toThrow(
      /ADMISSION_SECRET/,
    );
  });
});

// The real thing: the service's entrypoint, as a process. It must exit on its own, before it listens.
describe("ticket startup", () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));

  async function boot(overrides: Record<string, string | undefined>) {
    // Ports nothing else uses: a process that wrongly starts must not collide with a running stack.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...base,
      PORT: "39001",
      METRICS_PORT: "39464",
      WORKERS: "1",
      ...overrides,
    };
    // No Redis or Postgres: with a valid config the service would come up serving probes only.
    for (const name of ["REDIS_URL", "DATABASE_URL"]) {
      delete env[name];
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete env[name];
      }
    }

    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const [code] = (await once(child, "exit")) as [number | null];
    clearTimeout(timer);
    return { code, output };
  }

  it("12. exits at once when ADMISSION_SECRET is missing or too short", async () => {
    const missing = await boot({ ADMISSION_SECRET: undefined });
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("Missing required environment variables: ADMISSION_SECRET");
    expect(missing.output).not.toContain("primary started");

    const short = await boot({ ADMISSION_SECRET: "too-short" });
    expect(short.code).toBe(1);
    expect(short.output).toContain("must be at least 32 bytes");
    expect(short.output).not.toContain("primary started");
  }, 60_000);

  it("11. exits at once with REQUIRE_ADMISSION=false in production", async () => {
    const refused = await boot({ NODE_ENV: "production", REQUIRE_ADMISSION: "false" });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("REQUIRE_ADMISSION=false is not allowed");
    expect(refused.output).not.toContain("primary started");
  }, 60_000);
});
