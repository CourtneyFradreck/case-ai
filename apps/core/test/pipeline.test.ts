import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finding, snap } from "./fixtures.js";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(), query: vi.fn(), release: vi.fn(), collectAll: vi.fn(), runRules: vi.fn(),
  startRun: vi.fn(), finishRun: vi.fn(), storeSnapshots: vi.fn(), storeNextItems: vi.fn(), markMissingReported: vi.fn(), storeFindings: vi.fn(), storeBrief: vi.fn(), storeBriefMessageId: vi.fn(), storeBriefFocus: vi.fn(), getFocus: vi.fn(), sendMessage: vi.fn(),
  env: { briefMode: "rules", delivery: "n8n", geminiApiKey: "test", geminiModel: "test-model", repos: ["me/demo"] },
  features: { focusButtons: false },
}));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
vi.mock("../src/features.js", () => ({ features: mocks.features }));
vi.mock("../src/db.js", () => ({ pool: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock("../src/github/collect.js", () => ({ collectAll: mocks.collectAll }));
vi.mock("../src/rules/index.js", () => ({ runRules: mocks.runRules }));
vi.mock("../src/store.js", () => ({ startRun: mocks.startRun, finishRun: mocks.finishRun, storeSnapshots: mocks.storeSnapshots, storeNextItems: mocks.storeNextItems, markMissingReported: mocks.markMissingReported, storeFindings: mocks.storeFindings, storeBrief: mocks.storeBrief, storeBriefMessageId: mocks.storeBriefMessageId, storeBriefFocus: mocks.storeBriefFocus, getFocus: mocks.getFocus }));
vi.mock("../src/telegram.js", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("../src/llm/gemini.js", () => ({ GeminiBriefModel: class { name = "test-model"; generate = mocks.generate; } }));
import { runBrief } from "../src/pipeline.js";
import { render } from "../src/render.js";
import { yesterdayWindow } from "../src/time.js";

describe("model pipeline", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.env.briefMode = "rules";
    mocks.env.delivery = "n8n";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeBrief.mockResolvedValue(70);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.collectAll.mockResolvedValue([snap({ commits: [{ sha: "abc", message: "Progress", url: "https://github.com/me/demo/commit/abc", author: "me", branch: "main", date: "2026-10-13T10:00:00Z" }] })]);
    mocks.runRules.mockReturnValue([finding()]);
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }], attention: [], focus: [] }), model: "test-model", inputTokens: 10, outputTokens: 4 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each([
    ["rules", "schedule", false], ["rules", "command", false],
    ["command", "schedule", false], ["command", "command", true],
    ["all", "schedule", true], ["all", "command", true],
  ] as const)("selects mode %s for %s", async (mode, source, usesModel) => {
    mocks.env.briefMode = mode;
    const result = await runBrief(source);
    expect(Object.keys(result).sort()).toEqual(["delivered", "runId", "text"]);
    expect(result.delivered).toBe(false);
    expect(mocks.generate).toHaveBeenCalledTimes(usesModel ? 1 : 0);
    if (usesModel) expect(result.text).toContain("Model progress");
    else {
      expect(result).toEqual({ runId: 7, text: render([finding()], [snap()], yesterdayWindow(), 3800, undefined, { userName: "Courtney" }), delivered: false });
      expect(mocks.storeBrief).toHaveBeenCalledWith(7, result.text, undefined, result.text);
    }
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ source, fallbackReason: null, fallbackDetail: null });
  });
  it("stores the rule-only render alongside a successful model brief", async () => {
    mocks.env.briefMode = "all";
    const result = await runBrief("command");
    const ruleText = render([finding()], [snap()], yesterdayWindow(), 3800, undefined, { userName: "Courtney" });
    expect(result.text).toContain("Model progress");
    expect(mocks.storeBrief).toHaveBeenCalledWith(7, result.text, expect.objectContaining({ model: "test-model" }), ruleText);
    expect(ruleText).not.toBe(result.text);
  });
  it("returns a model brief after a failed first attempt", async () => {
    mocks.env.briefMode = "all";
    const valid = mocks.generate.getMockImplementation()!;
    mocks.generate.mockResolvedValueOnce({ raw: "invalid", model: "test-model", inputTokens: 2, outputTokens: 1 }).mockImplementation(valid);
    const result = await runBrief("command");
    expect(result.text).toContain("Model progress");
    expect(mocks.storeBrief.mock.calls[0][2]).toMatchObject({ inputTokens: 12, outputTokens: 5, json: { attempts: 2 } });
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ source: "command", fallbackReason: null, fallbackDetail: null });
  });
  it.each(["invalid", "exception"])("sends and stores the fallback after two %s attempts", async (failure) => {
    mocks.env.briefMode = "all";
    if (failure === "exception") mocks.generate.mockRejectedValue(new Error("unavailable"));
    else mocks.generate.mockResolvedValue({ raw: "invalid", model: "test-model" });
    const result = await runBrief("command");
    expect(result.text).toBe(render([finding()], [snap()], yesterdayWindow(), 3800, "Rule-only brief: model unavailable", { userName: "Courtney" }));
    expect(mocks.storeBrief.mock.calls[0][3]).toBe(render([finding()], [snap()], yesterdayWindow(), 3800, undefined, { userName: "Courtney" }));
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.storeBrief.mock.calls[0][2]).toMatchObject({ json: { attempts: 2, fallbackReason: failure === "exception" ? "provider_error" : "invalid_json" } });
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "ok");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("skips the model on a quiet day", async () => {
    mocks.env.briefMode = "all";
    mocks.collectAll.mockResolvedValue([snap()]);
    mocks.runRules.mockReturnValue([]);
    expect((await runBrief("command")).text).toContain("Nothing new in the past week.");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.storeBrief.mock.calls[0][2]).toBeUndefined();
  });
  it("logs a bounded schema validation detail with the request source", async () => {
    mocks.env.briefMode = "command";
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: "invalid", attention: "invalid", focus: "invalid" }), model: "test-model" });
    await runBrief("command");
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0][0]);
    const audit = mocks.storeBrief.mock.calls[0][2].json;
    expect(event).toMatchObject({ source: "command", mode: "command", fallbackReason: "invalid_schema", attempts: 2 });
    expect(event.fallbackDetail).toHaveLength(200);
    expect(event.fallbackDetail).toContain("yesterday");
    expect(event.fallbackDetail).toBe(audit.fallbackDetail);
  });
  it("logs a bounded provider error detail", async () => {
    mocks.env.briefMode = "command";
    const message = `Unknown model: ${"x".repeat(250)}`;
    mocks.generate.mockRejectedValue(new Error(message));
    await runBrief("command");
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ source: "command", fallbackReason: "provider_error", fallbackDetail: message.slice(0, 200) });
  });
  it("still propagates database failures", async () => {
    mocks.storeFindings.mockRejectedValue(new Error("DB unavailable"));
    await expect(runBrief("command")).rejects.toThrow("DB unavailable");
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "failed", "Error: DB unavailable");
  });
  it("leaves sending to n8n by default", async () => {
    await runBrief("schedule");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ delivery: "n8n", delivered: false, deliveryError: null });
  });
  it("sends the brief itself with CASE_DELIVERY=core and stores the message id", async () => {
    mocks.env.delivery = "core";
    mocks.sendMessage.mockResolvedValue({ message_id: 555, chat: { id: 42 } });
    const result = await runBrief("schedule");
    expect(result).toEqual({ runId: 7, text: result.text, delivered: true });
    expect(mocks.sendMessage).toHaveBeenCalledWith(result.text);
    expect(mocks.storeBriefMessageId).toHaveBeenCalledWith(70, 555);
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "ok");
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ delivery: "core", delivered: true, deliveryError: null });
  });
  it("hands the brief back to n8n when the Telegram send fails", async () => {
    mocks.env.delivery = "core";
    mocks.sendMessage.mockRejectedValue(new Error("Telegram sendMessage failed (502): Bad Gateway"));
    const result = await runBrief("schedule");
    expect(result).toMatchObject({ runId: 7, delivered: false, deliveryError: "Telegram sendMessage failed (502): Bad Gateway" });
    expect(mocks.storeBriefMessageId).not.toHaveBeenCalled();
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "ok");
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ delivered: false, deliveryError: "Telegram sendMessage failed (502): Bad Gateway" });
  });
  it("still reports delivered when only storing the message id fails", async () => {
    mocks.env.delivery = "core";
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendMessage.mockResolvedValue({ message_id: 555, chat: { id: 42 } });
    mocks.storeBriefMessageId.mockRejectedValue(new Error("DB unavailable"));
    expect((await runBrief("schedule")).delivered).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe("intent findings in the pipeline", () => {
  const next = {
    status: "ok" as const, sha: "n1", url: "https://github.com/me/demo/blob/main/NEXT.md", lastChangedAt: "2026-10-12T10:00:00Z",
    items: [{ id: "abcdef0123", text: "Ship the parser", section: "Now", state: "open" as const, line: 2 }],
  };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.collectAll.mockResolvedValue([snap({ next })]);
    mocks.runRules.mockReturnValue([finding()]);
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }], attention: [], focus: [] }), model: "test-model" });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("stores intent findings alongside rule findings without changing the rule brief", async () => {
    mocks.env.briefMode = "rules";
    const result = await runBrief("command");
    const stored = mocks.storeFindings.mock.calls[0][1];
    expect(mocks.storeFindings).toHaveBeenCalledTimes(1);
    expect(stored.map((f: { rule: string }) => f.rule)).toEqual(["commits", "next_item"]);
    expect(stored[1]).toMatchObject({ id: "next_abcdef0123", summary: "Next in me/demo: Ship the parser" });
    expect(result.text).not.toContain("Ship the parser");
    mocks.collectAll.mockResolvedValue([snap()]);
    expect((await runBrief("command")).text).toBe(result.text);
  });
  it("passes the stored history to next_done and stores what it finds", async () => {
    mocks.env.briefMode = "rules";
    const gone = "0123456789";
    mocks.storeNextItems.mockResolvedValue({ history: new Map([["me/demo", { sha: "n0", openIds: new Set(["abcdef0123", gone]) }]]), missingReported: new Set() });
    await runBrief("command");
    expect(mocks.storeNextItems).toHaveBeenCalledWith(7, [snap({ next })]);
    const done = mocks.storeFindings.mock.calls[0][1].filter((f: { rule: string }) => f.rule === "next_done");
    expect(done).toMatchObject([{ summary: "Finished in me/demo: an item from NEXT.md", intent: { itemId: gone } }]);
  });
  it("records next_missing as reported, and skips it for a repo already reported", async () => {
    mocks.env.briefMode = "rules";
    mocks.collectAll.mockResolvedValue([snap({ createdAt: "2026-10-12T10:00:00Z" })]);
    await runBrief("command");
    expect(mocks.storeFindings.mock.calls[0][1].map((f: { rule: string }) => f.rule)).toContain("next_missing");
    expect(mocks.markMissingReported).toHaveBeenCalledWith(["me/demo"]);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set(["me/demo"]) });
    await runBrief("command");
    expect(mocks.storeFindings.mock.calls[1][1].map((f: { rule: string }) => f.rule)).not.toContain("next_missing");
    expect(mocks.markMissingReported).toHaveBeenLastCalledWith([]);
  });
  it("keeps intent findings out of the model input with focusButtons off", async () => {
    mocks.env.briefMode = "all";
    const withNext = await runBrief("command");
    mocks.collectAll.mockResolvedValue([snap()]);
    const without = await runBrief("command");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[0]).toEqual(mocks.generate.mock.calls[1]);
    expect(JSON.stringify(mocks.generate.mock.calls[0])).not.toContain("Ship the parser");
    expect(withNext.text).toBe(without.text);
  });
  describe("with focusButtons on", () => {
    beforeEach(() => { mocks.features.focusButtons = true; mocks.env.briefMode = "rules"; });
    afterEach(() => { mocks.features.focusButtons = false; });
    it("sends open NEXT.md items to the model after the rule findings", async () => {
      mocks.env.briefMode = "all";
      await runBrief("command");
      const [system, user] = mocks.generate.mock.calls[0];
      expect(system).toContain('"next_item" findings are open items');
      expect(user).toContain("F2 | info | next_item | me/demo | Next in me/demo: Ship the parser");
      expect(user).toContain("F1 | info | commits");
    });
    it("keeps NEXT.md items out of the recap even when the model cites them there", async () => {
      mocks.env.briefMode = "all";
      mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }, { text: "Ship the parser", sources: ["F2"] }], attention: [], focus: [] }), model: "test-model" });
      const result = await runBrief("command");
      expect(result.text).toContain("Model progress");
      expect(result.text).not.toContain("parser");
      expect(result.text).not.toContain("NEXT.md");
    });
    const active = () => mocks.collectAll.mockResolvedValue([snap({ next, branches: [{ name: "main", sha: "abc", lastCommitAt: "2026-10-13T10:00:00Z", aheadBy: 0, url: "https://github.com/me/demo/tree/main" }] })]);
    it("adds rule-picked suggestions to the rule-only brief and stores them", async () => {
      active();
      mocks.storeBrief.mockResolvedValue(70);
      const result = await runBrief("command");
      expect(result.text).toContain("<b>Today, I'd suggest</b>\n1. Ship the parser (Open in NEXT.md, and demo has recent commits)");
      expect(mocks.storeBriefFocus).toHaveBeenCalledWith(70, [{ text: "Ship the parser", reason: "Open in NEXT.md, and demo has recent commits", findingId: "next_abcdef0123", repo: "me/demo" }]);
      expect(mocks.storeBrief.mock.calls[0][3]).toBe(result.text);
    });
    it("leaves the brief unchanged and stores no focus when nothing qualifies", async () => {
      const result = await runBrief("command");
      expect(result.text).not.toContain("Today, I'd suggest");
      expect(mocks.storeBriefFocus).not.toHaveBeenCalled();
      mocks.features.focusButtons = false;
      expect((await runBrief("command")).text).toBe(result.text);
    });
    it("uses the model's suggestions when the model brief succeeds", async () => {
      active();
      mocks.env.briefMode = "all";
      mocks.storeBrief.mockResolvedValue(70);
      mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }], attention: [], focus: [{ text: "Finish the parser", reason: "It is next in NEXT.md", sources: ["F2"] }] }), model: "test-model" });
      const result = await runBrief("command");
      expect(result.text).toContain("1. Finish the parser (It is next in NEXT.md)");
      expect(mocks.storeBriefFocus).toHaveBeenCalledWith(70, [{ text: "Finish the parser", reason: "It is next in NEXT.md", findingId: "next_abcdef0123", repo: "me/demo" }]);
      expect(mocks.storeBrief.mock.calls[0][3]).toContain("1. Ship the parser");
    });
    it("falls back to rule-picked suggestions when the model fails", async () => {
      active();
      mocks.env.briefMode = "all";
      mocks.generate.mockResolvedValue({ raw: "invalid", model: "test-model" });
      const result = await runBrief("command");
      expect(result.text).toContain("1. Ship the parser (Open in NEXT.md");
      expect(result.text).toContain("Rule-only brief: model unavailable");
    });
    it("attaches focus buttons when case-core delivers the brief", async () => {
      active();
      mocks.env.delivery = "core";
      mocks.storeBrief.mockResolvedValue(70);
      mocks.sendMessage.mockResolvedValue({ message_id: 555, chat: { id: 42 } });
      const result = await runBrief("schedule");
      expect(mocks.sendMessage).toHaveBeenCalledWith(result.text, { inline_keyboard: [[{ text: "1", callback_data: "f:70:1" }], [{ text: "Something else", callback_data: "f:70:x" }]] });
      mocks.env.delivery = "n8n";
    });
    it("reads yesterday's focus in Harare time and leads the recap with it", async () => {
      mocks.getFocus.mockResolvedValue({ item_text: "Ship the parser", repo: "me/demo", finding_id: "next_abcdef0123", created_at: new Date("2026-10-13T06:00:00Z") });
      mocks.collectAll.mockResolvedValue([snap({ next, commits: [{ sha: "abc", message: "Progress", url: "https://github.com/me/demo/commit/abc", author: "me", branch: "main", date: "2026-10-13T10:00:00Z" }] })]);
      const result = await runBrief("command");
      expect(mocks.getFocus).toHaveBeenCalledWith("2026-10-13");
      expect(result.text).toContain('<b>Here\'s what you worked on yesterday</b>\n• Yesterday\'s focus: Ship the parser. 1 commit in me/demo since. [<a href="https://github.com/me/demo/commit/abc">commit</a>]\n\n<b>demo</b>');
      expect(mocks.storeFindings.mock.calls[0][1].map((f: { rule: string }) => f.rule)).toContain("yesterday_focus");
    });
    it("never sends yesterday's focus to the model", async () => {
      mocks.env.briefMode = "all";
      mocks.getFocus.mockResolvedValue({ item_text: "Secret plan", repo: null, finding_id: null, created_at: new Date("2026-10-13T06:00:00Z") });
      const result = await runBrief("command");
      expect(JSON.stringify(mocks.generate.mock.calls[0])).not.toContain("Secret plan");
      expect(result.text).toContain("• Yesterday's focus: Secret plan.");
    });
    it("doesn't read the focus table with focusButtons off", async () => {
      mocks.features.focusButtons = false;
      await runBrief("command");
      expect(mocks.getFocus).not.toHaveBeenCalled();
    });
    it("sends no buttons when there are no suggestions", async () => {
      mocks.env.delivery = "core";
      mocks.sendMessage.mockResolvedValue({ message_id: 555, chat: { id: 42 } });
      const result = await runBrief("schedule");
      expect(mocks.sendMessage).toHaveBeenCalledWith(result.text);
      mocks.env.delivery = "n8n";
    });
  });
});
