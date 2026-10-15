import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("model environment", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN", "CASE_REPOS"]) vi.stubEnv(key, "test");
    for (const key of ["CASE_BRIEF_MODE", "GEMINI_API_KEY", "GEMINI_MODEL"]) vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("defaults to rules without needing a Gemini key", async () => {
    const { env } = await import("../src/env.js");
    expect(env).toMatchObject({ briefMode: "rules", geminiModel: "gemini-3.5-flash-lite" });
  });
  it.each(["command", "all"])("requires a key in %s mode", async (mode) => {
    vi.stubEnv("CASE_BRIEF_MODE", mode);
    await expect(import("../src/env.js")).rejects.toThrow("Missing env var GEMINI_API_KEY");
  });
  it("rejects unsupported modes", async () => {
    vi.stubEnv("CASE_BRIEF_MODE", "invalid");
    await expect(import("../src/env.js")).rejects.toThrow("CASE_BRIEF_MODE");
  });
  it("accepts a key and custom model", async () => {
    vi.stubEnv("CASE_BRIEF_MODE", "command");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "custom");
    expect((await import("../src/env.js")).env).toMatchObject({ briefMode: "command", geminiApiKey: "test-key", geminiModel: "custom" });
  });
});
