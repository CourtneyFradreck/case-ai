import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("model environment", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN", "CASE_REPOS"]) vi.stubEnv(key, "test");
    for (const key of ["CASE_BRIEF_MODE", "GEMINI_API_KEY", "GEMINI_MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) vi.stubEnv(key, undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("defaults to rules without needing a Gemini key", async () => {
    const { env } = await import("../src/env.js");
    expect(env).toMatchObject({ briefMode: "rules", geminiModel: "gemini-3.5-flash-lite" });
    expect(console.warn).not.toHaveBeenCalled();
  });
  it.each(["command", "all"])("falls back to rules with one warning when %s has no key", async (mode) => {
    vi.stubEnv("CASE_BRIEF_MODE", mode);
    expect((await import("../src/env.js")).env.briefMode).toBe("rules");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/GEMINI_API_KEY.*rules/));
  });
  it.each(["invalid", "", "   "])("falls back to rules with one warning for unsupported mode %s", async (mode) => {
    vi.stubEnv("CASE_BRIEF_MODE", mode);
    expect((await import("../src/env.js")).env.briefMode).toBe("rules");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/CASE_BRIEF_MODE.*rules/));
  });
  it("trims a supported mode before checking it", async () => {
    vi.stubEnv("CASE_BRIEF_MODE", " command ");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    expect((await import("../src/env.js")).env.briefMode).toBe("command");
    expect(console.warn).not.toHaveBeenCalled();
  });
  it.each(["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN", "CASE_REPOS"])("still requires %s", async (key) => {
    vi.stubEnv(key, undefined);
    await expect(import("../src/env.js")).rejects.toThrow(`Missing env var ${key}`);
  });
  it("starts without Telegram settings", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", " ");
    expect((await import("../src/env.js")).env).toMatchObject({ telegramBotToken: undefined, telegramChatId: undefined });
  });
  it("reads trimmed Telegram settings", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", " 123:abc ");
    vi.stubEnv("TELEGRAM_CHAT_ID", "42");
    expect((await import("../src/env.js")).env).toMatchObject({ telegramBotToken: "123:abc", telegramChatId: "42" });
  });
  it("accepts a key and custom model", async () => {
    vi.stubEnv("CASE_BRIEF_MODE", "command");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "custom");
    expect((await import("../src/env.js")).env).toMatchObject({ briefMode: "command", geminiApiKey: "test-key", geminiModel: "custom" });
    expect(console.warn).not.toHaveBeenCalled();
  });
});
