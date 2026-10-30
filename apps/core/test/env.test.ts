import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("model environment", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN"]) vi.stubEnv(key, "test");
    vi.stubEnv("CASE_REPOS", "me/demo");
    for (const key of ["CASE_BRANCH_EXCLUDE", "CASE_BRIEF_MODE", "GEMINI_API_KEY", "GEMINI_MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "CASE_DELIVERY"]) vi.stubEnv(key, undefined);
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
  it.each(["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN"])("still requires %s", async (key) => {
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
  it("delivers through n8n by default", async () => {
    expect((await import("../src/env.js")).env.delivery).toBe("n8n");
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("delivers through core when Telegram is configured", async () => {
    vi.stubEnv("CASE_DELIVERY", " core ");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("TELEGRAM_CHAT_ID", "42");
    expect((await import("../src/env.js")).env.delivery).toBe("core");
    expect(console.warn).not.toHaveBeenCalled();
  });
  it.each([["123:abc", undefined], [undefined, "42"]])("falls back to n8n with one warning when core lacks Telegram settings", async (token, chat) => {
    vi.stubEnv("CASE_DELIVERY", "core");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
    vi.stubEnv("TELEGRAM_CHAT_ID", chat);
    expect((await import("../src/env.js")).env.delivery).toBe("n8n");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/TELEGRAM_BOT_TOKEN.*n8n/));
  });
  it("falls back to n8n with one warning for an unsupported delivery", async () => {
    vi.stubEnv("CASE_DELIVERY", "telegram");
    expect((await import("../src/env.js")).env.delivery).toBe("n8n");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/CASE_DELIVERY.*n8n/));
  });
  it("accepts a key and custom model", async () => {
    vi.stubEnv("CASE_BRIEF_MODE", "command");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "custom");
    expect((await import("../src/env.js")).env).toMatchObject({ briefMode: "command", geminiApiKey: "test-key", geminiModel: "custom" });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("repo and branch lists", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ["DATABASE_URL", "CASE_API_KEY", "GITHUB_TOKEN"]) vi.stubEnv(key, "test");
    for (const key of ["CASE_BRANCH_EXCLUDE", "CASE_REPO_EXCLUDE", "CASE_REPO_ACTIVE_DAYS"]) vi.stubEnv(key, undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("trims spaces and quotes after commas and drops empty entries", async () => {
    vi.stubEnv("CASE_REPOS", ` CourtneyFradreck/case-ai, "CourtneyFradreck/1710" ,, 'me/demo',`);
    expect((await import("../src/env.js")).env.repos).toEqual(["CourtneyFradreck/case-ai", "CourtneyFradreck/1710", "me/demo"]);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("skips entries that aren't owner/repo with one warning each", async () => {
    vi.stubEnv("CASE_REPOS", "me/demo, 1710, https://github.com/me/x, me/a/b");
    expect((await import("../src/env.js")).env.repos).toEqual(["me/demo"]);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/CASE_REPOS entry "1710".*owner\/repo/));
  });
  it("starts without CASE_REPOS, leaving discovery to pick the repos", async () => {
    vi.stubEnv("CASE_REPOS", undefined);
    expect((await import("../src/env.js")).env).toMatchObject({ repos: [], repoExclude: [], repoActiveDays: 14 });
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("reads trimmed repo exclude globs and the active days", async () => {
    vi.stubEnv("CASE_REPOS", "");
    vi.stubEnv("CASE_REPO_EXCLUDE", " old-* , me/scratch ,");
    vi.stubEnv("CASE_REPO_ACTIVE_DAYS", " 30 ");
    expect((await import("../src/env.js")).env).toMatchObject({ repoExclude: ["old-*", "me/scratch"], repoActiveDays: 30 });
  });
  it.each(["0", "-3", "two weeks", "1.5"])("uses 14 active days with one warning for %s", async (days) => {
    vi.stubEnv("CASE_REPOS", "");
    vi.stubEnv("CASE_REPO_ACTIVE_DAYS", days);
    expect((await import("../src/env.js")).env.repoActiveDays).toBe(14);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/CASE_REPO_ACTIVE_DAYS.*14/));
  });
  it("excludes pr-assets branches by default", async () => {
    vi.stubEnv("CASE_REPOS", "me/demo");
    expect((await import("../src/env.js")).env.branchExclude).toEqual(["pr-assets/*"]);
  });
  it("reads trimmed branch globs, and none when set empty", async () => {
    vi.stubEnv("CASE_REPOS", "me/demo");
    vi.stubEnv("CASE_BRANCH_EXCLUDE", " pr-assets/* , gh-pages ,, assets/** ");
    expect((await import("../src/env.js")).env.branchExclude).toEqual(["pr-assets/*", "gh-pages", "assets/**"]);
    vi.resetModules();
    vi.stubEnv("CASE_BRANCH_EXCLUDE", "");
    expect((await import("../src/env.js")).env.branchExclude).toEqual([]);
  });
});
