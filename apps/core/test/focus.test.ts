import { describe, expect, it } from "vitest";
import { chosenKeyboard, cleanFocusText, focusCallbackData, focusKeyboard, focusPeriod, nextItemsText, parseCommand, parseFocusCallback, rankNext, ruleFocus, storedFocus, yesterdayFocus } from "../src/focus.js";
import { render, renderModelBrief } from "../src/render.js";
import { datePassed, itemDate } from "../src/intent/dates.js";
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

describe("NEXT.md items with a date that has passed", () => {
  // NOW is Wed 14 Oct 2026.
  const snaps = [snap({ branches: [branch("main", 1)] })];
  const late = nextItem("me/demo", "Merge the parser after the trial ends (Mon 12 Oct)", "late");
  const plain = nextItem("me/demo", "Write docs", "plain");
  it("reads dates in items, choosing the nearest year", () => {
    expect(itemDate("Merge M2 (Mon 19 Oct)", NOW)?.toISODate()).toBe("2026-10-19");
    expect(itemDate("Ship by Oct 2", NOW)?.toISODate()).toBe("2026-10-02");
    expect(itemDate("Plan for 2027-01-05", NOW)?.toISODate()).toBe("2027-01-05");
    expect(itemDate("Wrap up 20 Dec", new Date("2027-01-03T05:00:00Z"))?.toISODate()).toBe("2026-12-20");
    expect(itemDate("Write docs", NOW)).toBeUndefined();
    expect(datePassed("Merge M2 (Mon 12 Oct)", NOW)).toBe(true);
    expect(datePassed("Demo on 14 Oct", NOW)).toBe(false);
  });
  it("suggests overdue items after the others", () => {
    expect(ruleFocus([], [late, plain], snaps, NOW, cfg).map((f) => f.sources[0].id)).toEqual(["next_plain", "next_late"]);
    expect(rankNext([late, plain], snaps, NOW, cfg).map((f) => f.id)).toEqual(["next_plain", "next_late"]);
  });
  it("keeps an overdue item's place when there's recent activity on it", () => {
    const work = snap({ branches: [branch("main", 1)], commits: [{ sha: "a", message: "fix: parser trial edge cases", url: "u", author: "me", branch: "main", date: daysAgo(1) }] });
    expect(ruleFocus([], [late, plain], [work], NOW, cfg).map((f) => f.sources[0].id)).toEqual(["next_late", "next_plain"]);
    const onBranch = snap({ branches: [branch("main", 1), branch("feat/parser-trial", 2)] });
    expect(ruleFocus([], [late, plain], [onBranch], NOW, cfg).map((f) => f.sources[0].id)).toEqual(["next_late", "next_plain"]);
    // Yesterday's focus counts as recent activity.
    expect(ruleFocus([], [late, plain], snaps, NOW, cfg, "next_late").map((f) => f.sources[0].id)).toEqual(["next_late", "next_plain"]);
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

describe("focus commands", () => {
  it.each([
    ["/focus Ship it", { name: "focus", arg: "Ship it" }],
    ["/focus@case_bot  Ship\nit ", { name: "focus", arg: "Ship\nit" }],
    ["/NEXT case-ai", { name: "next", arg: "case-ai" }],
    ["/next", { name: "next", arg: "" }],
    ["focus Ship it", undefined],
    ["/123", undefined],
  ])("parses %j", (text, expected) => expect(parseCommand(text)).toEqual(expected));
  it("bounds typed focus text to one line", () => {
    expect(cleanFocusText(" Ship\n\tthe   parser ")).toBe("Ship the parser");
    expect(cleanFocusText("x".repeat(300))).toHaveLength(200);
  });
  it("names the choice on the remaining button and keeps it short", () => {
    expect(chosenKeyboard(70, "Fix CI")).toEqual({ inline_keyboard: [[{ text: "Focus: Fix CI", callback_data: "f:70:ok" }]] });
    expect(chosenKeyboard(70, "x".repeat(100)).inline_keyboard[0][0].text).toHaveLength(60);
  });
});

describe("/next replies", () => {
  const rows = [
    { repo: "me/demo", text: "Ship <the> parser", section: "M3" },
    { repo: "me/demo", text: "Write docs", section: null },
    { repo: "me/other", text: "Plan", section: null },
    { repo: "me/untracked", text: "Hidden", section: null },
  ];
  const tracked = ["me/other", "me/demo", "me/empty"];
  it("groups open items by tracked repo, escaped", () => {
    expect(nextItemsText(rows, tracked)).toBe([
      "<b>Open NEXT.md items</b>", "", "<b>other</b>", "• Plan", "", "<b>demo</b>", "• Ship &lt;the&gt; parser <i>(M3)</i>", "• Write docs",
    ].join("\n"));
  });
  it.each(["me/demo", "demo", "DEMO"])("filters to one repo named %s", (repo) => {
    expect(nextItemsText(rows, tracked, repo)).toBe("<b>Open NEXT.md items</b>\n\n<b>demo</b>\n• Ship &lt;the&gt; parser <i>(M3)</i>\n• Write docs");
  });
  it("says when a repo has no items or isn't tracked", () => {
    expect(nextItemsText(rows, tracked, "empty")).toBe("No open NEXT.md items in me/empty.");
    expect(nextItemsText(rows, tracked, "<untracked>")).toBe("&lt;untracked&gt; isn't a tracked repo.");
    expect(nextItemsText([], tracked)).toBe("No open NEXT.md items.");
  });
  it("stays within the message limit", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ repo: "me/demo", text: `Item ${i} ${"x".repeat(20)}`, section: null }));
    const text = nextItemsText(many, tracked);
    expect(text.length).toBeLessThanOrEqual(3800);
    expect(text).toMatch(/\+\d+ more line\(s\) not shown<\/i>$/);
  });
});

describe("yesterday's focus", () => {
  const chosen = new Date("2026-10-13T06:00:00Z");
  const commit = (sha: string, date: string, branch = "main") => ({ sha, message: "Work", url: `https://github.com/me/demo/commit/${sha}`, author: "me", branch, date });
  const row = (repo: string | null) => ({ item_text: "Ship the parser", repo, created_at: chosen });
  // Previous brief at 07:00 Harare on 13 Oct; the recap is 13 Oct.
  const recap = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "yesterday" };
  const lastBrief = new Date("2026-10-13T05:00:00Z");
  const period = focusPeriod(lastBrief, recap, NOW);
  it("emits nothing without a focus", () => {
    expect(yesterdayFocus(undefined, [snap()], period)).toEqual([]);
  });
  it("counts the repo's commits over the recap period and links the newest", () => {
    const snaps = [snap({ commits: [commit("a", "2026-10-12T21:00:00Z"), commit("b", "2026-10-13T09:00:00Z"), commit("c", "2026-10-13T15:00:00Z")] }), snap({ repo: "me/other", commits: [commit("d", "2026-10-13T12:00:00Z")] })];
    expect(yesterdayFocus(row("me/demo"), snaps, period)).toEqual([expect.objectContaining({
      rule: "yesterday_focus", severity: "info", repo: "me/demo",
      summary: "Yesterday's focus: Ship the parser. 2 commits in demo yesterday",
      sources: [{ label: "commit", url: "https://github.com/me/demo/commit/c" }],
    })]);
  });
  it("counts commits on every branch, not only the default one", () => {
    const snaps = [snap({ commits: [commit("a", "2026-10-13T09:00:00Z", "feat/m3-intent"), commit("b", "2026-10-13T10:00:00Z", "feat/m3-intent"), commit("c", "2026-10-13T11:00:00Z")] })];
    expect(yesterdayFocus(row("me/demo"), snaps, period)[0].summary).toBe("Yesterday's focus: Ship the parser. 3 commits in demo yesterday");
  });
  it("still counts the recap's commits when the focus was picked after them", () => {
    // 22 Oct: the focus was picked from an evening /brief, after the day's 36 commits.
    const evening = { ...row("me/demo"), created_at: new Date("2026-10-13T17:00:00Z") };
    const snaps = [snap({ commits: [commit("a", "2026-10-13T09:00:00Z", "feat/m3-intent"), commit("b", "2026-10-13T16:58:00Z", "feat/m3-intent")] })];
    const [f] = yesterdayFocus(evening, snaps, focusPeriod(new Date("2026-10-13T17:00:00Z"), recap, NOW));
    expect(f.summary).toBe("Yesterday's focus: Ship the parser. 2 commits in demo yesterday");
  });
  it("says when the repo had no commits over the period", () => {
    const [f] = yesterdayFocus(row("me/demo"), [snap({ commits: [commit("a", "2026-10-12T05:00:00Z")] })], period);
    expect(f).toMatchObject({ summary: "Yesterday's focus: Ship the parser. No commits in demo yesterday", sources: [{ label: "repo", url: "https://github.com/me/demo" }] });
  });
  it("counts since the last brief when that is earlier than the recap, or the last day without one", () => {
    const quiet = { ...recap, label: "" };
    expect(focusPeriod(lastBrief, quiet, NOW)).toEqual({ since: lastBrief, label: "since the last brief" });
    expect(focusPeriod(new Date("2026-10-12T05:00:00Z"), recap, NOW)).toEqual({ since: new Date("2026-10-12T05:00:00Z"), label: "since the last brief" });
    expect(focusPeriod(undefined, quiet, NOW)).toEqual({ since: new Date(NOW.getTime() - 86_400_000), label: "in the last day" });
  });
  it("states only what the focus was when there is no readable repo to check", () => {
    for (const [repo, snaps] of [[null, [snap()]], ["me/demo", [snap({ error: "GitHub 404" })]], ["me/gone", [snap()]]] as const) {
      expect(yesterdayFocus(row(repo), [...snaps], period)).toMatchObject([{ summary: "Yesterday's focus: Ship the parser", sources: [] }]);
    }
  });
  it("leads the recap in both renderers, escaped", () => {
    const previousFocus = yesterdayFocus({ ...row("me/demo"), item_text: "Ship <it>" }, [snap({ commits: [commit("c", "2026-10-13T15:00:00Z")] })], period);
    const lead = `<b>Here's what you worked on yesterday</b>\n• Yesterday's focus: Ship &lt;it&gt;. 1 commit in demo yesterday. [<a href="https://github.com/me/demo/commit/c">commit</a>]\n\n<b>demo</b>`;
    expect(render([finding()], [], recap, 3800, undefined, { previousFocus })).toContain(lead);
    expect(renderModelBrief({ yesterday: [{ text: "Progress", sources: [finding()] }], attention: [], focus: [] }, [], recap, 3800, { previousFocus })).toContain(lead);
  });
  it("stands alone without a recap and adds no links without sources", () => {
    const w = { start: new Date("2026-10-07T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "" };
    const text = render([], [], w, 3800, undefined, { previousFocus: yesterdayFocus(row(null), [], period) });
    expect(text).toMatch(/\n\n• Yesterday's focus: Ship the parser\.\n\nNothing new in the past week\.$/);
    expect(text).not.toContain("worked on");
  });
});
