import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { finding, snap } from "./fixtures.js";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(), query: vi.fn(), release: vi.fn(), collectAll: vi.fn(), runRules: vi.fn(),
  startRun: vi.fn(), finishRun: vi.fn(), storeSnapshots: vi.fn(), storeNextItems: vi.fn(), markMissingReported: vi.fn(), storeFindings: vi.fn(), storeBrief: vi.fn(), previousBriefAt: vi.fn(), storeBriefMessageId: vi.fn(), storeBriefFocus: vi.fn(), getFocus: vi.fn(), sendMessage: vi.fn(),
  env: { briefMode: "rules", delivery: "n8n", geminiApiKey: "test", geminiModel: "test-model", repos: ["me/demo"] },
  features: { focusButtons: false, streaks: false, snooze: false, quietMornings: false, eveningCheckIn: false },
  answeredCheckinFocus: vi.fn(),
  previousRuns: vi.fn(), activeSnoozes: vi.fn(), storeBriefSnoozable: vi.fn(), storeBriefSentText: vi.fn(),
  parked: new Set<string>(),
  logs: [] as { id: string; text: string; tag: string | null; created_at: Date }[],
  // Plain functions over shared state, so vi.resetAllMocks leaves them working.
  repos: { list: ["me/demo"], error: undefined as string | undefined, unannounced: new Set<string>(), announced: [] as string[][] },
}));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
vi.mock("../src/repos.js", () => ({
  resolveRepos: async () => ({ repos: mocks.repos.list, error: mocks.repos.error }),
  withBranchCaches: async (repos: string[]) => repos,
  storeBranchCaches: async () => {},
  unannouncedRepos: async (repos: string[]) => repos.filter((r) => mocks.repos.unannounced.has(r)),
  markAnnounced: async (repos: string[]) => { mocks.repos.announced.push(repos); for (const r of repos) mocks.repos.unannounced.delete(r); },
}));
vi.mock("../src/features.js", () => ({ features: mocks.features }));
vi.mock("../src/logs.js", () => ({ logsInWindow: async () => mocks.logs }));
vi.mock("../src/checkin.js", () => ({ completedFocusIds: async () => new Set(), answeredCheckinFocus: mocks.answeredCheckinFocus }));
vi.mock("../src/db.js", () => ({ pool: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock("../src/github/collect.js", async (actual) => ({ collectAll: mocks.collectAll, failedSnapshot: (await actual<typeof import("../src/github/collect.js")>()).failedSnapshot }));
vi.mock("../src/rules/index.js", () => ({ runRules: mocks.runRules }));
vi.mock("../src/store.js", () => ({ startRun: mocks.startRun, finishRun: mocks.finishRun, storeSnapshots: mocks.storeSnapshots, storeNextItems: mocks.storeNextItems, markMissingReported: mocks.markMissingReported, storeFindings: mocks.storeFindings, storeBrief: mocks.storeBrief, previousBriefAt: mocks.previousBriefAt, snoozedFocusIds: async () => mocks.parked, storeBriefMessageId: mocks.storeBriefMessageId, storeBriefFocus: mocks.storeBriefFocus, getFocus: mocks.getFocus, previousRuns: mocks.previousRuns, activeSnoozes: mocks.activeSnoozes, storeBriefSnoozable: mocks.storeBriefSnoozable, storeBriefSentText: mocks.storeBriefSentText }));
vi.mock("../src/telegram.js", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("../src/llm/gemini.js", () => ({ GeminiBriefModel: class { name = "test-model"; generate = mocks.generate; } }));
import { runBrief } from "../src/pipeline.js";
import { render } from "../src/render.js";
import { yesterdayWindow } from "../src/time.js";

beforeEach(() => {
  mocks.logs = []; mocks.features.eveningCheckIn = false;
  mocks.repos = { list: ["me/demo"], error: undefined, unannounced: new Set(), announced: [] };
});

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
    expect(mocks.storeNextItems).toHaveBeenCalledWith(7, [snap({ next })], new Date("2026-10-14T05:00:00Z"));
    const done = mocks.storeFindings.mock.calls[0][1].filter((f: { rule: string }) => f.rule === "next_done");
    expect(done).toMatchObject([{ summary: "Finished in me/demo: an item from NEXT.md", intent: { itemId: gone } }]);
  });
  it("stores next_missing but neither shows it nor records it as shown with focusButtons off", async () => {
    mocks.env.briefMode = "rules";
    mocks.collectAll.mockResolvedValue([snap({ createdAt: "2026-10-12T10:00:00Z" })]);
    const result = await runBrief("command");
    expect(mocks.storeFindings.mock.calls[0][1].map((f: { rule: string }) => f.rule)).toContain("next_missing");
    expect(result.text).not.toContain("NEXT.md");
    expect(mocks.markMissingReported).toHaveBeenCalledWith([]);
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
    it.each(["rules", "all"])("stores self reports and adds Partly after validation in %s mode, on the next brief only", async (mode) => {
      active();
      mocks.env.briefMode = mode;
      mocks.features.eveningCheckIn = true;
      mocks.logs = [{ id: "12", text: "Private pitch edits", tag: "sales", created_at: new Date("2026-10-13T12:00:00Z") }];
      mocks.answeredCheckinFocus.mockResolvedValue({ item_text: "Secret focus label", repo: "me/demo", finding_id: "next_abcdef0123", checkin: "partly", created_at: new Date("2026-10-13T06:00:00Z") });
      mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }], attention: [], focus: [{ text: "Ship the parser", reason: "Next step", sources: ["F2"] }] }), model: "test-model" });
      const first = await runBrief("schedule");
      expect(first.text).toContain("Ship the parser (partly done yesterday)");
      expect(first.text).toContain("Secret focus label, partly done.");
      expect(mocks.storeFindings.mock.calls[0][1]).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "self_log", summary: "Private pitch edits", sources: [{ label: "you", kind: "self_reported" }] }),
        expect.objectContaining({ rule: "self_checkin", severity: "info" }),
      ]));
      expect(JSON.stringify(mocks.generate.mock.calls)).not.toMatch(/Private pitch|Secret focus|partly done yesterday/);
      mocks.previousBriefAt.mockResolvedValue(new Date("2026-10-14T05:00:00Z"));
      const second = await runBrief("command", DateTime.fromISO("2026-10-14T06:00:00Z"));
      expect(second.text).not.toContain("(partly done yesterday)");
    });
    it("adds rule-picked suggestions to the rule-only brief and stores them", async () => {
      active();
      mocks.storeBrief.mockResolvedValue(70);
      const result = await runBrief("command");
      expect(result.text).toContain("<b>Today, I'd suggest</b>\n1. Ship the parser [");
      expect(result.text).not.toContain("recent commits");
      expect(mocks.storeBriefFocus).toHaveBeenCalledWith(70, [{ text: "Ship the parser", label: "Ship the parser", reason: "Open in NEXT.md, and demo has recent commits", findingId: "next_abcdef0123", repo: "me/demo" }]);
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
      expect(result.text).toContain("1. Finish the parser [");
      expect(result.text).not.toContain("It is next");
      expect(mocks.storeBriefFocus).toHaveBeenCalledWith(70, [{ text: "Finish the parser", label: "Ship the parser", reason: "It is next in NEXT.md", findingId: "next_abcdef0123", repo: "me/demo" }]);
      expect(mocks.storeBrief.mock.calls[0][3]).toContain("1. Ship the parser");
    });
    it("falls back to rule-picked suggestions when the model fails", async () => {
      active();
      mocks.env.briefMode = "all";
      mocks.generate.mockResolvedValue({ raw: "invalid", model: "test-model" });
      const result = await runBrief("command");
      expect(result.text).toContain("1. Ship the parser [");
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
      expect(result.text).toContain('<b>Yesterday</b>\n• You picked: Ship the parser. 1 commit in demo yesterday. [<a href="https://github.com/me/demo/commit/abc">commit</a>]\n\n<b>demo</b>');
      expect(mocks.storeFindings.mock.calls[0][1].map((f: { rule: string }) => f.rule)).toContain("yesterday_focus");
    });
    it("never sends yesterday's focus to the model", async () => {
      mocks.env.briefMode = "all";
      mocks.getFocus.mockResolvedValue({ item_text: "Secret plan", repo: null, finding_id: null, created_at: new Date("2026-10-13T06:00:00Z") });
      const result = await runBrief("command");
      expect(JSON.stringify(mocks.generate.mock.calls[0])).not.toContain("Secret plan");
      expect(result.text).toContain("• You picked: Secret plan.");
    });
    it("doesn't read the focus table with focusButtons off", async () => {
      mocks.features.focusButtons = false;
      await runBrief("command");
      expect(mocks.getFocus).not.toHaveBeenCalled();
    });
    it("asks to tick off an item a merged PR finished instead of suggesting it, on both paths", async () => {
      const merged = { number: 3, title: "feat: ship the parser", url: "https://github.com/me/demo/pull/3", draft: false, headRef: "feat/parser", updatedAt: "2026-10-12T08:00:00Z", mergedAt: "2026-10-12T08:00:00Z" };
      mocks.collectAll.mockResolvedValue([snap({ next, recentlyMerged: [merged], branches: [{ name: "main", sha: "abc", lastCommitAt: "2026-10-13T10:00:00Z", aheadBy: 0, url: "https://github.com/me/demo/tree/main" }] })]);
      const line = '☑️ Looks like "Ship the parser" is done (PR #3 merged). Tick it off in <code>NEXT.md</code>? [<a href="https://github.com/me/demo/pull/3">PR</a>, <a href="https://github.com/me/demo/blob/main/NEXT.md#L2">NEXT.md</a>]';
      const rules = await runBrief("command");
      expect(rules.text).toContain(`<b>Needs attention</b>\n${line}`);
      expect(rules.text).not.toContain("Today, I'd suggest");
      mocks.env.briefMode = "all";
      const model = await runBrief("command");
      expect(model.text).toContain(line);
      expect(JSON.stringify(mocks.generate.mock.calls[0])).not.toContain("parser");
    });
    it("leaves a snoozed focus's finding out of the suggestions", async () => {
      active();
      mocks.parked = new Set(["next_abcdef0123"]);
      const result = await runBrief("command");
      mocks.parked = new Set();
      expect(result.text).not.toContain("Today, I'd suggest");
      expect(mocks.storeBriefFocus).not.toHaveBeenCalled();
    });
    // 24 Oct brief: event-hunters had 15 commits and no NEXT.md, and got no suggestion.
    describe("an active repo with no NEXT.md", () => {
      const hunters = snap({ repo: "me/event-hunters", branches: [{ name: "master", sha: "e1", lastCommitAt: "2026-10-13T18:00:00Z", aheadBy: 0, url: "https://github.com/me/event-hunters/tree/master" }] });
      const line = '2. Add a <code>NEXT.md</code> to event-hunters so I can track next steps [<a href="https://github.com/me/event-hunters">repo</a>]';
      beforeEach(() => {
        mocks.storeBrief.mockResolvedValue(70);
        mocks.collectAll.mockResolvedValue([snap({ next, branches: [{ name: "main", sha: "abc", lastCommitAt: "2026-10-13T10:00:00Z", aheadBy: 0, url: "https://github.com/me/demo/tree/main" }] }), hunters]);
      });
      it("suggests adding one, after the planned work, and records it as shown", async () => {
        const result = await runBrief("schedule");
        expect(result.text).toContain(`<b>Today, I'd suggest</b>\n1. Ship the parser [<a href="https://github.com/me/demo/blob/main/NEXT.md#L2">NEXT.md</a>]\n${line}`);
        expect(mocks.storeBriefFocus.mock.calls[0][1][1]).toMatchObject({ label: "event-hunters NEXT.md", repo: "me/event-hunters", reason: "event-hunters has recent commits and no NEXT.md" });
        expect(mocks.markMissingReported).toHaveBeenCalledWith(["me/event-hunters"]);
      });
      it("waits a week once shown", async () => {
        mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set(["me/event-hunters"]) });
        const result = await runBrief("schedule");
        expect(result.text).not.toContain("event-hunters so I");
        expect(mocks.markMissingReported).toHaveBeenCalledWith([]);
      });
      it("takes the last slot on the model path, which never sees it", async () => {
        mocks.env.briefMode = "all";
        mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }], attention: [], focus: [{ text: "Finish the parser", reason: "Next in NEXT.md", sources: ["F2"] }] }), model: "test-model" });
        const result = await runBrief("schedule");
        expect(JSON.stringify(mocks.generate.mock.calls[0])).not.toContain("event-hunters");
        expect(result.text).toContain(`1. Finish the parser [<a href="https://github.com/me/demo/blob/main/NEXT.md#L2">NEXT.md</a>]\n${line}`);
        expect(mocks.markMissingReported).toHaveBeenCalledWith(["me/event-hunters"]);
        expect(mocks.storeBrief.mock.calls[0][2].json.brief.focus).toHaveLength(2);
      });
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

describe("old unmerged branches in the pipeline", () => {
  const old = finding({ id: "old-2", rule: "old_branches", severity: "low", repo: "me/attachcv, me/crc-app", summary: "2 old unmerged branches across attachcv, crc-app (oldest 120 days)", sources: [{ label: "attachcv", url: "https://github.com/me/attachcv/branches/stale" }, { label: "crc-app", url: "https://github.com/me/crc-app/branches/stale" }] });
  const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium", summary: "PR #4 waiting", sources: [{ label: "PR", url: "https://github.com/me/demo/pull/4" }] });
  const ran = (findingIds: string[]) => [{ id: 6, source: "schedule", status: "ok", windowEnd: new Date(), findingIds, attentionIds: findingIds }];
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.env.briefMode = "rules";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeBrief.mockResolvedValue(70);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.collectAll.mockResolvedValue([snap()]);
    mocks.runRules.mockReturnValue([pr, old]);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("shows them on Mondays without reading previous runs", async () => {
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    expect((await runBrief("schedule")).text).toContain("old unmerged branches");
    expect(mocks.previousRuns).not.toHaveBeenCalled();
  });
  it("leaves them out on other days while they are unchanged, but still stores them", async () => {
    vi.setSystemTime(new Date("2026-10-22T05:00:00Z"));
    mocks.previousRuns.mockResolvedValue(ran(["pr", "old-2"]));
    const result = await runBrief("schedule");
    expect(result.text).not.toContain("old unmerged branches");
    expect(result.text).toContain("PR #4 waiting");
    expect(mocks.storeFindings.mock.calls[0][1].map((f: { id: string }) => f.id)).toContain("old-2");
  });
  it("shows them on other days when the branches changed", async () => {
    vi.setSystemTime(new Date("2026-10-22T05:00:00Z"));
    mocks.previousRuns.mockResolvedValue(ran(["pr", "old-1"]));
    expect((await runBrief("schedule")).text).toContain("old unmerged branches");
  });
});

describe("collapsing repeats in the pipeline (streaks)", () => {
  const thread = finding({ id: "thread", rule: "issue_comments", severity: "medium", repo: "me/demo", summary: '2 new comments on issue #9 "Retry" in me/demo (from tendai)', sources: [{ label: "comment", url: "https://github.com/me/demo/issues/9#c1" }], target: "issue #9" });
  const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium", repo: "me/demo", summary: 'PR #14 "Retry" in me/demo: no activity for 5 days', sources: [{ label: "PR", url: "https://github.com/me/demo/pull/14" }], target: "PR #14", ageDays: 5 });
  const branch = finding({ id: "branch", rule: "stale_branch", severity: "medium", repo: "me/demo", summary: "Branch feat/x in me/demo: 1 unmerged commit, untouched for 9 days", sources: [{ label: "branch", url: "https://github.com/me/demo/tree/feat/x" }], target: "feat/x", ageDays: 9 });
  const ci = finding({ id: "ci", rule: "failing_ci", severity: "high", summary: "CI failing on me/demo main (build), today", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
  const past = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 6 - i, source: "schedule", status: "ok", windowEnd: new Date(), findingIds: ["thread", "pr", "branch", "ci"], attentionIds: ["thread", "pr", "branch", "ci"] }));
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.features.streaks = true;
    mocks.env.briefMode = "rules";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.collectAll.mockResolvedValue([snap()]);
    mocks.runRules.mockReturnValue([ci, thread, finding()]);
    mocks.previousRuns.mockResolvedValue(past(3));
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F2"] }], attention: [{ text: "CI is failing", sources: ["F1"] }], focus: [] }), model: "test-model" });
  });
  afterEach(() => { mocks.features.streaks = false; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("collapses repeats in a scheduled rule-only brief", async () => {
    const result = await runBrief("schedule");
    expect(mocks.previousRuns).toHaveBeenCalledWith(7);
    expect(result.text).toContain("CI failing on me/demo main (build), today (day 4)");
    expect(result.text).toContain('⚪ Still open, unchanged: 1 item (<a href="https://github.com/me/demo/issues/9#c1">comments on issue #9 in demo</a>)');
    expect(mocks.storeFindings.mock.calls[0][1].map((f: { id: string }) => f.id)).toContain("thread");
  });
  it("keeps collapsed findings out of the model input and renders their line in code", async () => {
    mocks.env.briefMode = "all";
    const result = await runBrief("schedule");
    expect(mocks.generate.mock.calls[0][1]).not.toContain("issue #9");
    expect(result.text).toContain("🔴 CI is failing (day 4)");
    expect(result.text).toContain("Still open, unchanged: 1 item");
    expect(result.text.match(/issue #9/g)).toHaveLength(1);
  });
  it("shows everything below the threshold", async () => {
    mocks.previousRuns.mockResolvedValue(past(2));
    const result = await runBrief("schedule");
    expect(result.text).not.toContain("Still open");
    expect(result.text).not.toContain("(day");
  });
  it("leaves command briefs and the flag-off brief unchanged", async () => {
    const command = await runBrief("command");
    expect(mocks.previousRuns).not.toHaveBeenCalled();
    mocks.features.streaks = false;
    const off = await runBrief("schedule");
    expect(command.text).toBe(off.text);
  });
  // 24 Oct brief: a stale branch on a streak showed under Needs attention as "Still open, unchanged".
  it.each(["rules", "all"] as const)("keeps a stale branch or idle PR on a streak on the last line, never under attention (%s)", async (mode) => {
    mocks.env.briefMode = mode;
    mocks.runRules.mockReturnValue([ci, branch, pr, finding()]);
    const result = await runBrief("schedule");
    expect(result.text).not.toContain("Still open, unchanged");
    expect(result.text).toMatch(/\n\n⚪ Left open: <a [^>]+>feat\/x in demo<\/a> \(idle 9 days\); <a [^>]+>PR #14 in demo<\/a> \(quiet 5 days\)$/);
    expect(result.text.match(/feat\/x in demo|Branch feat\/x/g)).toHaveLength(1);
    if (mode === "all") expect(mocks.generate.mock.calls[0][1]).not.toContain("feat/x");
  });
});

describe("snoozes in the pipeline", () => {
  const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium", summary: 'PR #14 "Retry" in me/demo: no activity for 5 days', sources: [{ label: "PR", url: "https://github.com/me/demo/pull/14" }] });
  const oi = finding({ id: "oi", rule: "open_issues", severity: "low", summary: "3 open issues in me/demo", sources: [{ label: "issues", url: "https://github.com/me/demo/issues" }] });
  const ci = finding({ id: "ci", rule: "failing_ci", severity: "high", summary: "CI failing on me/demo main (build), today", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.features.snooze = true;
    mocks.env.briefMode = "rules";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeBrief.mockResolvedValue(70);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.collectAll.mockResolvedValue([snap()]);
    mocks.runRules.mockReturnValue([ci, pr, oi, finding()]);
    mocks.activeSnoozes.mockResolvedValue(new Set(["pr", "ci"]));
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F3"] }], attention: [{ text: "CI is failing", sources: ["F1"] }], focus: [] }), model: "test-model" });
  });
  afterEach(() => { mocks.features.snooze = false; mocks.env.delivery = "n8n"; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("leaves snoozed findings out of the brief, but never a high one, and still stores them", async () => {
    const result = await runBrief("schedule");
    expect(result.text).not.toContain("PR #14");
    expect(result.text).toContain("CI failing");
    expect(result.text).toContain("3 open issues");
    expect(mocks.storeFindings.mock.calls[0][1].map((f: { id: string }) => f.id)).toContain("pr");
    expect(mocks.storeBriefSnoozable).toHaveBeenCalledWith(70, [{ findingId: "oi", repo: "me/demo", text: "3 open issues in me/demo" }]);
  });
  it("keeps snoozed findings out of the model input", async () => {
    mocks.env.briefMode = "all";
    await runBrief("schedule");
    expect(mocks.generate.mock.calls[0][1]).not.toContain("PR #14");
    expect(mocks.generate.mock.calls[0][1]).toContain("CI failing");
  });
  it("adds a Snooze… button when case-core delivers and there is something to snooze", async () => {
    mocks.env.delivery = "core";
    mocks.sendMessage.mockResolvedValue({ message_id: 555, chat: { id: 42 } });
    const result = await runBrief("schedule");
    expect(mocks.sendMessage).toHaveBeenCalledWith(result.text, { inline_keyboard: [[{ text: "Snooze…", callback_data: "s:70" }]] });
    mocks.activeSnoozes.mockResolvedValue(new Set(["oi", "pr"]));
    mocks.sendMessage.mockClear();
    const quiet = await runBrief("schedule");
    expect(mocks.sendMessage).toHaveBeenCalledWith(quiet.text);
  });
  it("doesn't read snoozes with the flag off", async () => {
    mocks.features.snooze = false;
    const result = await runBrief("schedule");
    expect(mocks.activeSnoozes).not.toHaveBeenCalled();
    expect(mocks.storeBriefSnoozable).not.toHaveBeenCalled();
    expect(result.text).toContain("PR #14");
  });
});

describe("quiet mornings in the pipeline", () => {
  const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium", summary: 'PR #14 "Retry" in me/demo: no activity for 5 days', sources: [{ label: "PR", url: "https://github.com/me/demo/pull/14" }] });
  const ci = finding({ id: "ci", rule: "failing_ci", severity: "high", summary: "CI failing on me/demo main (build), 2 days ago", sources: [{ label: "run", url: "https://github.com/me/demo/actions/runs/1" }] });
  const commit = (date: string) => ({ sha: "abc", message: "Progress", url: "https://github.com/me/demo/commit/abc", author: "me", branch: "main", date });
  const ran = (windowEnd: string, attentionIds = ["ci", "pr"]) => [
    { id: 6, source: "command", status: "ok", windowEnd: new Date(), findingIds: [], attentionIds: [] },
    { id: 5, source: "schedule", status: "ok", windowEnd: new Date(windowEnd), findingIds: attentionIds, attentionIds },
  ];
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.features.quietMornings = true;
    mocks.env.briefMode = "rules";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeBrief.mockResolvedValue(70);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    // Wednesday: the last activity was Monday, and Tuesday's brief already had both findings.
    mocks.collectAll.mockResolvedValue([snap({ commits: [commit("2026-10-12T10:00:00Z")] })]);
    mocks.runRules.mockReturnValue([ci, pr, finding()]);
    mocks.previousRuns.mockResolvedValue(ran("2026-10-12T22:00:00Z"));
  });
  afterEach(() => { mocks.features.quietMornings = false; mocks.env.delivery = "n8n"; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("sends a short message when nothing changed, and still stores the full brief", async () => {
    const result = await runBrief("schedule");
    expect(result.text).toBe("Nothing has moved since Monday. Still on CI failing on me/demo main (build), 2 days ago?");
    const [, full, , ruleText] = mocks.storeBrief.mock.calls[0];
    expect(full).toContain("Needs attention");
    expect(ruleText).toBe(full);
    expect(mocks.storeBriefSentText).toHaveBeenCalledWith(70, result.text);
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toMatchObject({ quiet: true });
  });
  it("does not quiet a morning with logged activity since the previous scheduled brief", async () => {
    mocks.logs = [{ id: "1", text: "Pitch edits", tag: null, created_at: new Date("2026-10-13T14:00Z") }];
    const result = await runBrief("schedule");
    expect(result.text).toContain("Pitch edits");
    expect(mocks.storeBriefSentText).not.toHaveBeenCalled();
  });
  it("asks about yesterday's focus when there is one", async () => {
    mocks.getFocus.mockResolvedValue({ item_text: "Ship the parser", repo: null, finding_id: null, created_at: new Date("2026-10-13T06:00:00Z") });
    expect((await runBrief("schedule")).text).toBe("Nothing has moved since Monday. Still on Ship the parser?");
    expect(mocks.getFocus).toHaveBeenCalledWith("2026-10-13");
  });
  it("still stores the model brief on a quiet morning", async () => {
    mocks.env.briefMode = "all";
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F3"] }], attention: [{ text: "CI is failing", sources: ["F1"] }], focus: [] }), model: "test-model" });
    const result = await runBrief("schedule");
    expect(result.text).toMatch(/^Nothing has moved since Monday/);
    expect(mocks.storeBrief.mock.calls[0][1]).toContain("CI is failing");
    expect(mocks.storeBrief.mock.calls[0][2]).toMatchObject({ model: "test-model" });
  });
  it("sends the full brief when an attention finding changed", async () => {
    mocks.previousRuns.mockResolvedValue(ran("2026-10-12T22:00:00Z", ["ci"]));
    const result = await runBrief("schedule");
    expect(result.text).toContain("Needs attention");
    expect(mocks.storeBriefSentText).not.toHaveBeenCalled();
  });
  it("sends the full brief when there was activity since the previous brief", async () => {
    mocks.collectAll.mockResolvedValue([snap({ commits: [commit("2026-10-13T10:00:00Z")] })]);
    expect((await runBrief("schedule")).text).toContain("Yesterday");
  });
  it("sends a short message on Monday after an empty weekend", async () => {
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    mocks.collectAll.mockResolvedValue([snap({ commits: [commit("2026-10-16T10:00:00Z")] })]);
    // Sunday's brief, whose day began Sat 17 Oct 22:00 UTC, had the same findings.
    mocks.previousRuns.mockResolvedValue(ran("2026-10-17T22:00:00Z"));
    expect((await runBrief("schedule")).text).toBe("Nothing has moved since Friday. Still on CI failing on me/demo main (build), 2 days ago?");
  });
  it("sends the full brief on Monday when the last brief came before Friday's work", async () => {
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    mocks.collectAll.mockResolvedValue([snap({ commits: [commit("2026-10-16T10:00:00Z")] })]);
    mocks.previousRuns.mockResolvedValue(ran("2026-10-15T22:00:00Z"));
    expect((await runBrief("schedule")).text).toContain("On Friday");
  });
  it("attaches the brief's buttons to the short message", async () => {
    mocks.features.focusButtons = true;
    mocks.env.delivery = "core";
    mocks.sendMessage.mockResolvedValue({ message_id: 555, chat: { id: 42 } });
    const result = await runBrief("schedule");
    mocks.features.focusButtons = false;
    expect(result.text).toMatch(/^Nothing has moved/);
    expect(mocks.sendMessage).toHaveBeenCalledWith(result.text, { inline_keyboard: [
      [{ text: "1", callback_data: "f:70:1" }], [{ text: "Something else", callback_data: "f:70:x" }],
    ] });
  });
  it("never quiets a command brief, or any brief with the flag off", async () => {
    expect((await runBrief("command")).text).toContain("Needs attention");
    mocks.features.quietMornings = false;
    expect((await runBrief("schedule")).text).toContain("Needs attention");
    expect(mocks.previousRuns).not.toHaveBeenCalled();
    expect(mocks.storeBriefSentText).not.toHaveBeenCalled();
  });
});

describe("discovered repos", () => {
  const demo = snap({ commits: [{ sha: "abc", message: "Progress", url: "https://github.com/me/demo/commit/abc", author: "me", branch: "main", date: "2026-10-13T10:00:00Z" }] });
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
    mocks.runRules.mockReturnValue([finding()]);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("collects the resolved repos", async () => {
    mocks.repos.list = ["me/demo", "me/1710"];
    mocks.collectAll.mockResolvedValue([demo, snap({ repo: "me/1710" })]);
    await runBrief("schedule");
    expect(mocks.collectAll).toHaveBeenCalledWith(["me/demo", "me/1710"], expect.anything(), expect.anything());
  });
  it("says a first-seen repo was picked up exactly once, noting a missing NEXT.md", async () => {
    mocks.repos.list = ["me/demo", "me/1710"];
    mocks.repos.unannounced = new Set(["me/1710"]);
    mocks.collectAll.mockResolvedValue([demo, snap({ repo: "me/1710", next: { status: "missing" } })]);
    const first = await runBrief("schedule");
    expect(first.text).toContain("New repo picked up: 1710\n1710 has no <code>NEXT.md</code> yet");
    expect(first.text).not.toContain("New repo picked up: demo");
    expect(mocks.repos.announced).toEqual([["me/1710"]]);
    const second = await runBrief("schedule");
    expect(second.text).not.toContain("New repo picked up");
  });
  it("leaves out the NEXT.md line when the new repo has one", async () => {
    mocks.repos.unannounced = new Set(["me/demo"]);
    mocks.collectAll.mockResolvedValue([{ ...demo, next: { status: "ok", sha: "n", url: "https://github.com/me/demo/blob/main/NEXT.md", lastChangedAt: null, items: [] } }]);
    const { text } = await runBrief("schedule");
    expect(text).toContain("New repo picked up: demo");
    expect(text).not.toContain("has no");
  });
  it("doesn't announce a new repo that couldn't be read", async () => {
    mocks.repos.list = ["me/demo", "me/1710"];
    mocks.repos.unannounced = new Set(["me/1710"]);
    mocks.collectAll.mockResolvedValue([demo, snap({ repo: "me/1710", error: "Couldn't read branches in 1710 (500)" })]);
    const { text } = await runBrief("schedule");
    expect(text).not.toContain("New repo picked up");
    expect(mocks.repos.unannounced.has("me/1710")).toBe(true);
  });
  it("shows a failed repo listing as an error line and marks the run partial", async () => {
    mocks.repos.error = "Couldn't list your repos (401: check the token), so only CASE_REPOS and recently active repos were read";
    mocks.collectAll.mockResolvedValue([demo]);
    const { text } = await runBrief("schedule");
    expect(text).toContain("<i>Couldn't list your repos (401: check the token), so only CASE_REPOS and recently active repos were read</i>");
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "partial");
  });
});

// 29 Oct brief: 1710's open NEXT.md items were missing from "Today, I'd suggest" though it was yesterday's focus.
describe("NEXT.md items from a newly discovered repo", () => {
  const nextFile = (repo: string, items: [string, string][]) => ({
    status: "ok" as const, sha: `${repo}-n`, url: `https://github.com/${repo}/blob/main/NEXT.md`, lastChangedAt: "2026-10-12T10:00:00Z",
    items: items.map(([id, text], n) => ({ id, text, section: "Now", state: "open" as const, line: n + 2 })),
  });
  const main = (repo: string) => [{ name: "main", sha: "h", lastCommitAt: "2026-10-13T10:00:00Z", aheadBy: 0, url: `https://github.com/${repo}/tree/main` }];
  const caseAi = snap({ repo: "me/case-ai", branches: main("me/case-ai"), next: nextFile("me/case-ai", [["c1", "Ship the parser"], ["c2", "Write the docs"]]) });
  const notes = snap({ repo: "me/CourtNotes", branches: main("me/CourtNotes"), next: nextFile("me/CourtNotes", [["n1", "Tag notes"]]) });
  const s1710 = (priv: boolean) => snap({ repo: "me/1710", private: priv, branches: main("me/1710"), next: nextFile("me/1710", [["p1", "Finish phase 1"], ["p3", "Finish phase 3"]]) });
  const reasons = () => vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line))).find((l) => l.event === "brief")?.focusReasons;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.features.focusButtons = true;
    mocks.env.briefMode = "rules";
    mocks.env.delivery = "n8n";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeBrief.mockResolvedValue(70);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.runRules.mockReturnValue([finding()]);
    mocks.repos.list = ["me/case-ai", "me/CourtNotes", "me/1710"];
    mocks.repos.unannounced = new Set(["me/1710"]);
    mocks.getFocus.mockResolvedValue({ item_text: "finish 1710 phase 1 and 3", repo: null, finding_id: null, created_at: new Date("2026-10-13T06:00:00Z") });
  });
  afterEach(() => { mocks.features.focusButtons = false; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("makes every open item a candidate on the repo's first run", async () => {
    mocks.getFocus.mockResolvedValue(undefined);
    mocks.collectAll.mockResolvedValue([caseAi, notes, s1710(false)]);
    const { text } = await runBrief("schedule");
    const stored = mocks.storeFindings.mock.calls[0][1].filter((f: { rule: string }) => f.rule === "next_item").map((f: { id: string }) => f.id);
    expect(stored).toEqual(expect.arrayContaining(["next_c1", "next_c2", "next_n1", "next_p1", "next_p3"]));
    expect(text).toContain("New repo picked up: 1710");
  });
  it("sends a public new repo's items to the model on its first run", async () => {
    mocks.env.briefMode = "all";
    mocks.getFocus.mockResolvedValue(undefined);
    mocks.collectAll.mockResolvedValue([caseAi, notes, s1710(false)]);
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [], attention: [], focus: [] }), model: "test-model" });
    await runBrief("schedule");
    expect(mocks.generate.mock.calls[0][1]).toContain("next_item | me/1710 | Next in me/1710: Finish phase 1");
  });
  it("suggests a 1710 item first on the rule path when 1710 was yesterday's focus", async () => {
    mocks.collectAll.mockResolvedValue([caseAi, notes, s1710(true)]);
    const { text } = await runBrief("schedule");
    expect(text).toMatch(/Today, I'd suggest<\/b>\n1\. Finish phase 1 /);
    expect(reasons()?.[0]).toEqual({ findingId: "next_p1", reason: "Repo you picked yesterday" });
  });
  it("adds a 1710 item in code when the model never saw the private repo", async () => {
    mocks.env.briefMode = "all";
    mocks.collectAll.mockResolvedValue([caseAi, notes, s1710(true)]);
    mocks.generate.mockImplementation(async (_system: string, user: string) => {
      const alias = (text: string) => user.split("\n").find((l) => l.includes(text))!.split(" | ")[0];
      return { raw: JSON.stringify({ yesterday: [], attention: [], focus: [
        { text: "Ship the parser", reason: "Open in NEXT.md", sources: [alias("Ship the parser")] },
        { text: "Write the docs", reason: "Open in NEXT.md", sources: [alias("Write the docs")] },
        { text: "Tag notes", reason: "Open in NEXT.md", sources: [alias("Tag notes")] },
      ] }), model: "test-model" };
    });
    const { text } = await runBrief("schedule");
    expect(mocks.generate.mock.calls[0][1]).not.toContain("1710");
    expect(text).toMatch(/Today, I'd suggest<\/b>\n1\. Finish phase 1 [^\n]*\n2\. Ship the parser [^\n]*\n3\. Write the docs/);
    expect(reasons()?.[0]).toEqual({ findingId: "next_p1", reason: "Repo you picked yesterday" });
  });
});

describe("busy repos' merged PRs in the pipeline", () => {
  const merges = [2, 3, 4, 5].map((n) => finding({ id: `pr-${n}`, rule: "merged_pr", severity: "info", summary: `Merged PR #${n} "Phase ${n}" in me/demo`,
    activity: { kind: "pr", action: "Merged", number: n, title: `Phase ${n}` }, sources: [{ label: "PR", url: `https://github.com/me/demo/pull/${n}` }] }));
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.env.delivery = "n8n";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.storeBrief.mockResolvedValue(70);
    mocks.storeNextItems.mockResolvedValue({ history: new Map(), missingReported: new Set() });
    mocks.collectAll.mockResolvedValue([snap()]);
    mocks.runRules.mockReturnValue(merges);
    mocks.generate.mockRejectedValue(new Error("down"));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each(["rules", "command"])("collapses them in %s mode", async (mode) => {
    mocks.env.briefMode = mode;
    const { text } = await runBrief("schedule");
    expect(text).toContain("4 PRs merged (#2–#5), covering Phases 2–5.");
    expect(text).not.toContain("Merged PR #2");
  });
  it("lists them in all mode, even on the rule-only fallback", async () => {
    mocks.env.briefMode = "all";
    const { text } = await runBrief("schedule");
    expect(text).toContain("Rule-only brief: model unavailable");
    expect(text).toContain('Merged PR #2 "Phase 2"');
    expect(text).not.toContain("PRs merged (");
  });
});
