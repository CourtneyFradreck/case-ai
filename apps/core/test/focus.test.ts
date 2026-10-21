import { describe, expect, it } from "vitest";
import { focusCallbackData, focusKeyboard, parseFocusCallback, ruleFocus, storedFocus } from "../src/focus.js";
import { daysAgo, finding, NOW, snap } from "./fixtures.js";

const cfg = { activeRepoDays: 7, ignoreBranchPrefixes: ["dependabot/"] };
const branch = (name: string, days: number) => ({ name, sha: "s", lastCommitAt: daysAgo(days), aheadBy: 0, url: `https://github.com/x/tree/${name}` });
const nextItem = (repo: string, text: string, id = text) => finding({
  id: `next_${id}`, rule: "next_item", repo, summary: `Next in ${repo}: ${text}`,
  sources: [{ label: "NEXT.md", url: `https://github.com/${repo}/blob/main/NEXT.md#L1` }],
});
const ci = finding({ id: "ci", rule: "failing_ci", severity: "high", summary: "CI failing on me/demo main (build), today", ageDays: 0 });
const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium", summary: 'PR #4 "Retry" in me/demo: no activity for 5 days', ageDays: 5 });
const oldPr = finding({ id: "old-pr", rule: "idle_pr", severity: "medium", summary: 'PR #2 "Old" in me/demo: no activity for 9 days', ageDays: 9 });

describe("rule-only focus", () => {
  it("picks high findings, then medium, then NEXT.md items, at most three", () => {
    const snaps = [snap({ branches: [branch("main", 1)] })];
    const focus = ruleFocus([pr, finding(), ci, oldPr], [nextItem("me/demo", "Ship the parser")], snaps, NOW, cfg);
    expect(focus).toEqual([
      { text: ci.summary, reason: "CI is failing on the default branch", sources: [ci] },
      { text: oldPr.summary, reason: "No activity for 9 days", sources: [oldPr] },
      { text: pr.summary, reason: "No activity for 5 days", sources: [pr] },
    ]);
  });
  it("ignores low and info findings", () => {
    expect(ruleFocus([finding(), finding({ id: "low", severity: "low", rule: "open_issues" })], [], [snap()], NOW, cfg)).toEqual([]);
  });
  it("suggests NEXT.md items only from repos with commits in the last activeRepoDays, most recent first", () => {
    const snaps = [
      snap({ repo: "me/old", branches: [branch("main", 8)] }),
      snap({ repo: "me/bot", branches: [branch("main", 30), branch("dependabot/npm", 0)] }),
      snap({ repo: "me/demo", branches: [branch("main", 6)] }),
      snap({ repo: "me/fresh", branches: [branch("feat/x", 0), branch("main", 3)] }),
      snap({ repo: "me/broken", branches: [branch("main", 0)], error: "GitHub 404" }),
    ];
    const next = [
      nextItem("me/old", "Old plan"), nextItem("me/bot", "Bot plan"), nextItem("me/demo", "Demo plan"),
      nextItem("me/fresh", "First fresh plan"), nextItem("me/fresh", "Second fresh plan"), nextItem("me/broken", "Broken plan"),
    ];
    const focus = ruleFocus([], next, snaps, NOW, cfg);
    expect(focus.map((f) => f.text)).toEqual(["First fresh plan", "Second fresh plan", "Demo plan"]);
    expect(focus[0]).toEqual({ text: "First fresh plan", reason: "Open in NEXT.md, and fresh has recent commits", sources: [next[3]] });
  });
  it("fills remaining slots with NEXT.md items after attention findings", () => {
    const next = [nextItem("me/demo", "Ship the parser"), nextItem("me/demo", "Write docs")];
    const focus = ruleFocus([ci], next, [snap({ branches: [branch("main", 0)] })], NOW, cfg);
    expect(focus.map((f) => f.sources[0].id)).toEqual(["ci", "next_Ship the parser", "next_Write docs"]);
  });
  it("cites exactly the finding each suggestion comes from", () => {
    const focus = ruleFocus([ci, pr], [], [snap()], NOW, cfg);
    expect(focus.every((f) => f.sources.length === 1)).toBe(true);
    expect(focus.map((f) => f.sources[0])).toEqual([ci, pr]);
  });
  it("uses a template reason for other rules", () => {
    const comment = finding({ id: "c", rule: "issue_comments", severity: "medium" });
    const branchFinding = finding({ id: "b", rule: "stale_branch", severity: "medium", ageDays: 12 });
    const other = finding({ id: "o", rule: "something_new", severity: "medium" });
    expect(ruleFocus([comment, branchFinding, other], [], [], NOW, cfg).map((f) => f.reason)).toEqual([
      "Unmerged and untouched for 12 days", "New comments are waiting for a reply", "Needs attention",
    ]);
  });
});

describe("focus buttons", () => {
  it("numbers one button per suggestion and adds Something else", () => {
    expect(focusKeyboard(70, 3)).toEqual({ inline_keyboard: [
      [{ text: "1", callback_data: "f:70:1" }, { text: "2", callback_data: "f:70:2" }, { text: "3", callback_data: "f:70:3" }],
      [{ text: "Something else", callback_data: "f:70:x" }],
    ] });
    expect(focusKeyboard(70, 1).inline_keyboard[0]).toEqual([{ text: "1", callback_data: "f:70:1" }]);
  });
  it("keeps callback data inside Telegram's 64-byte limit for any brief ID", () => {
    const id = 999_999_999_999_999;
    for (const choice of [3, "other", "chosen"] as const) {
      const data = focusCallbackData(id, choice);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseFocusCallback(data)).toEqual({ briefId: id, choice });
    }
  });
  it.each([undefined, "", "focus:1", "f:70", "f:70:0", "f:70:12", "f:abc:1", "f:70:1:extra", "f:-1:1", "f:1234567890123456:1"])("rejects callback data %s", (data) => {
    expect(parseFocusCallback(data)).toBeUndefined();
  });
  it("stores each suggestion's text, reason, first finding and single repo", () => {
    const branches = finding({ id: "old", rule: "old_branches", repo: "me/demo, me/other" });
    expect(storedFocus([
      { text: "you should fix CI", reason: "CI is failing", sources: [ci, pr] },
      { text: "Prune branches", reason: "Old branches", sources: [branches] },
    ])).toEqual([
      { text: "Fix CI", reason: "CI is failing", findingId: "ci", repo: "me/demo" },
      { text: "Prune branches", reason: "Old branches", findingId: "old", repo: null },
    ]);
  });
});
