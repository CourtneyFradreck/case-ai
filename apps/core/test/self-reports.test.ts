import { expect, it } from "vitest";
import { DateTime } from "luxon";
import { fid } from "../src/id.js";
import { logFindings, partlyForNextBrief, withPartlyNote } from "../src/self-reports.js";
import { yesterdayFocus } from "../src/focus.js";
import { yesterdayWindow } from "../src/time.js";
import { buildInput } from "../src/llm/input.js";
import { generateModelBrief } from "../src/llm/brief.js";
import { render } from "../src/render.js";
import { finding, snap } from "./fixtures.js";

const now = DateTime.fromISO("2026-10-28T05:00:00Z");
const w = yesterdayWindow(now);
const logs = [{ id: "12", text: "Private pitch edits", tag: "sales", created_at: w.start }];

it("gives logs stable ids and self-reported provenance", () => {
  expect(logFindings(logs)).toEqual([{ id: fid("log", "12"), rule: "self_log", severity: "info", repo: "sales",
    summary: "Private pitch edits", sources: [{ label: "you", kind: "self_reported" }] }]);
  expect(logFindings([{ ...logs[0], text: "Edited" }])[0].id).toBe(logFindings(logs)[0].id);
});

it("keys the check-in finding by its Harare date, not the answer or tap time", () => {
  const focus = { item_text: "Pitch", repo: null, created_at: new Date("2026-10-26T23:00Z") };
  for (const checkin of ["done", "partly", "none"] as const) {
    const result = yesterdayFocus({ ...focus, checkin }, [], { since: w.start, label: "yesterday" }, "2026-10-27");
    expect(result[0]).toMatchObject({ id: fid("checkin", "2026-10-27"), rule: "self_checkin", severity: "info",
      sources: [{ label: "you", kind: "self_reported" }] });
  }
});

it("keeps unanswered focus text unchanged and never infers none", () => {
  const focus = { item_text: "Pitch", repo: null, created_at: w.start, checkin: null };
  const previousFocus = yesterdayFocus(focus, [], { since: w.start, label: "yesterday" });
  const text = render([], [], w, 3800, undefined, { previousFocus, now });
  expect(text).toContain("You picked: Pitch.");
  expect(text).not.toContain("didn't get to it");
  expect(previousFocus[0].rule).toBe("yesterday_focus");
});

it("excludes self reports from model input even with private repos enabled", async () => {
  const checkins = yesterdayFocus({ item_text: "Secret focus", repo: null, created_at: w.start, checkin: "partly" }, [], { since: w.start, label: "yesterday" });
  const activity = finding({ activity: { kind: "commits", count: 1, branch: "main", messages: [] } });
  const findings = [activity, ...logFindings(logs), ...checkins];
  const input = buildInput(findings, [snap()], "yesterday", { modelIncludePrivate: true });
  expect([...input.aliasToFinding.values()]).toEqual([activity]);
  expect(input.user).not.toMatch(/Private pitch|Secret focus|self_log|self_checkin/);
  const result = await generateModelBrief(findings, [snap()], w,
    { modelIncludePrivate: true, modelTimeoutMs: 1000, maxBriefChars: 3800, logs, previousFocus: checkins },
    { name: "test", generate: async (_, user) => {
      expect(user).not.toMatch(/Private pitch|Secret focus/);
      return { model: "test", raw: JSON.stringify({ yesterday: [{ text: "Progress", sources: ["F1"] }], attention: [], focus: [] }) };
    } }, now);
  expect(result).toHaveProperty("text", expect.stringContaining("Private pitch edits"));
  expect(result).toHaveProperty("text", expect.stringContaining("Secret focus, partly done."));
  expect(result).toHaveProperty("text", expect.stringContaining("one commit in demo and 1 thing logged."));
});

it("annotates only the next day's first brief and only the partly finding", () => {
  const focus = { finding_id: "a", checkin: "partly" };
  const ids = partlyForNextBrief(focus, "2026-10-27", now, w.start);
  expect(ids).toEqual(new Set(["a"]));
  expect(partlyForNextBrief(focus, "2026-10-27", now.plus({ days: 1 }))).toEqual(new Set());
  expect(partlyForNextBrief(focus, "2026-10-27", now.plus({ hours: 1 }), now.toJSDate())).toEqual(new Set());
  for (const checkin of ["done", "none", null]) expect(partlyForNextBrief({ ...focus, checkin }, "2026-10-27", now)).toEqual(new Set());
  const suggestions = [{ text: "Fix CI (2 days)", reason: "Failing", sources: [finding({ id: "a" })] },
    { text: "Ship parser", reason: "Next", sources: [finding({ id: "b" })] }];
  const annotated = withPartlyNote(suggestions, ids);
  expect(annotated.map((f) => f.text)).toEqual(["Fix CI (2 days) (partly done yesterday)", "Ship parser"]);
  expect(render([], [], w, 3800, undefined, {}, annotated)).toContain("Fix CI (2 days) (partly done yesterday)");
});
