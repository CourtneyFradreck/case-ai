import { expect, it } from "vitest";
import { DateTime } from "luxon";
import { finding, snap } from "./fixtures.js";
import { opening, render, renderModelBrief } from "../src/render.js";
import { yesterdayWindow } from "../src/time.js";
import { selectRecap } from "../src/recap.js";
import { yesterdayFocus } from "../src/focus.js";
import { nextItems } from "../src/intent/rules.js";
import { parseNext } from "../src/intent/parse.js";
import { generateModelBrief } from "../src/llm/brief.js";

const now = DateTime.fromISO("2026-10-27T05:00:00Z");
const w = yesterdayWindow(now);
const log = (text: string, tag: string | null = null) => ({ id: text, text, tag, created_at: new Date("2026-10-26T14:00Z") });
const commit = (count: number) => finding({ activity: { kind: "commits", branch: "main", count, messages: [] } });
const prs = Array.from({ length: 4 }, (_, n) => finding({ id: `p${n}`, rule: "merged_pr", activity: { kind: "pr", action: "Merged", number: n, title: "Work" } }));

it("counts commits, merges and logs for Steady, but only commits for Big", () => {
  expect(opening([commit(1), ...prs], w)).toBe("Steady day yesterday: one commit in demo, and 4 PRs merged.");
  expect(opening([commit(1)], w, 2)).toBe("Steady day yesterday: one commit in demo, and 2 things logged.");
  expect(opening(prs, w, 2)).toBe("No commits yesterday, but 4 PRs merged and 2 things logged.");
  expect(opening([], w, 1)).toBe("No commits yesterday, but 1 thing logged.");
  expect(opening([commit(1)], w, 20)).toMatch(/^Steady/);
  expect(opening([commit(10)], w, 2)).toMatch(/^Big demo/);
});

it.each([false, true])("groups and escapes logs identically with model=%s", (model) => {
  const f = commit(1);
  const options = { now, logs: [log("Pitch <edits> & review", "demo"), log("Called Sam", "sales"), log("Read\nnotes")] };
  const text = model ? renderModelBrief({ yesterday: [{ text: f.summary, sources: [f] }], attention: [], focus: [] }, [], w, 3800, options)
    : render([f], [], w, 3800, undefined, options);
  expect(text.match(/<b>demo<\/b>/g)).toHaveLength(1);
  expect(text).toContain("• Pitch &lt;edits&gt; &amp; review");
  expect(text).toContain("<b>sales</b>\n• Called Sam");
  expect(text).toContain("<b>Other</b>\n• Read\nnotes");
});

it("selects a log-only day, including the Harare boundary", () => {
  const selected = selectRecap([snap()], now, ["2026-10-25T22:00:00Z"]);
  expect(selected.window).toEqual(w);
  const text = render([], [], selected.window, 3800, undefined, { logs: [log("Called Sam")], now });
  expect(text).toContain("<b>Yesterday</b>");
  expect(text).not.toContain("Nothing new");
});

it.each([['done', 'done'], ['partly', 'partly done'], ['none', "didn't get to it"]] as const)("shows the %s check-in answer", (checkin, words) => {
  const result = yesterdayFocus({ item_text: "Pitch", repo: null, created_at: w.start, checkin }, [], { since: w.start, label: "yesterday" });
  expect(result[0].summary).toBe(`You picked: Pitch, ${words}`);
  const options = { previousFocus: result };
  const texts = [
    render([], [], w, 3800, undefined, options),
    renderModelBrief({ yesterday: [], attention: [], focus: [] }, [], w, 3800, options),
  ];
  for (const text of texts) {
    const line = text.split("\n").find((line) => line.includes("You picked:"));
    expect(line).toBe(`• You picked: Pitch, ${words}.`);
  }
});

it("replaces a completed NEXT step with a tick-off line and releases the next step", () => {
  const items = parseNext("me/demo", "## Work\n- [ ] Run CASE_BRIEF_MODE=command\n- [ ] Switch CASE_BRIEF_MODE=all");
  const next = { status: "ok" as const, sha: "a", url: "https://github.com/me/demo/NEXT.md", lastChangedAt: null, items };
  const result = nextItems(snap(), next, new Set([`next_${items[0].id}`]));
  expect(result[0].rule).toBe("next_likely_done");
  expect(result[0].summary).toContain("You marked");
  expect(result[1].rule).toBe("next_item");
  expect(result[1].intent?.waitsOn).toBeUndefined();
});

it("renders private log text without ever including it in the model prompt", async () => {
  const secret = "Private pitch budget 123";
  const result = await generateModelBrief([commit(1)], [snap()], w,
    { modelIncludePrivate: true, maxBriefChars: 3800, modelTimeoutMs: 1000, logs: [log(secret)] },
    { name: "test", generate: async (system, user) => {
      expect(system + user).not.toContain(secret);
      return { model: "test", raw: JSON.stringify({ yesterday: [{ text: "Progress", sources: ["F1"] }], attention: [], focus: [] }) };
    } }, now);
  expect(result).toHaveProperty("text", expect.stringContaining(secret));
});
