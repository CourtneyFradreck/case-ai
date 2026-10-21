import { beforeEach, describe, expect, it, vi } from "vitest";
const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool }));
import { storeBrief, storeBriefMessageId } from "../src/store.js";

describe("brief metadata storage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    pool.query.mockResolvedValue({ rows: [{ id: "70" }] });
  });
  it("leaves model columns at their null defaults on the rule-only path", async () => {
    expect(await storeBrief(1, "rules", undefined, "rules")).toBe(70);
    expect(pool.query).toHaveBeenCalledWith("INSERT INTO briefs(run_id, text, rule_text) VALUES ($1,$2,$3) RETURNING id", [1, "rules", "rules"]);
  });
  it("stores model usage and audit JSON in existing columns", async () => {
    const meta = { model: "test-model", inputTokens: 12, outputTokens: 5, json: { attempts: 2, raw: "{}", brief: null, dropped: [], addedBack: [], fallbackReason: "empty_brief", aliases: {} } };
    expect(await storeBrief(1, "fallback", meta, "rules")).toBe(70);
    expect(pool.query.mock.calls[0][0]).toContain("model, input_tokens, output_tokens, json, rule_text");
    expect(pool.query.mock.calls[0][1]).toEqual([1, "fallback", "test-model", 12, 5, JSON.stringify(meta.json), "rules"]);
  });
  it("records the Telegram message id on the brief", async () => {
    await storeBriefMessageId(70, 555);
    expect(pool.query).toHaveBeenCalledWith("UPDATE briefs SET telegram_message_id=$2 WHERE id=$1", [70, 555]);
  });
});
