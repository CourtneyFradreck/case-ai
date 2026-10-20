import { beforeEach, describe, expect, it, vi } from "vitest";
const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ pool }));
import { storeBrief } from "../src/store.js";

describe("brief metadata storage", () => {
  beforeEach(() => vi.resetAllMocks());
  it("leaves model columns at their null defaults on the rule-only path", async () => {
    await storeBrief(1, "rules");
    expect(pool.query).toHaveBeenCalledWith("INSERT INTO briefs(run_id, text) VALUES ($1,$2)", [1, "rules"]);
  });
  it("stores model usage and audit JSON in existing columns", async () => {
    const meta = { model: "test-model", inputTokens: 12, outputTokens: 5, json: { attempts: 2, raw: "{}", brief: null, dropped: [], addedBack: [], fallbackReason: "empty_brief", aliases: {} } };
    await storeBrief(1, "fallback", meta);
    expect(pool.query.mock.calls[0][0]).toContain("model, input_tokens, output_tokens, json");
    expect(pool.query.mock.calls[0][1]).toEqual([1, "fallback", "test-model", 12, 5, JSON.stringify(meta.json)]);
  });
});
