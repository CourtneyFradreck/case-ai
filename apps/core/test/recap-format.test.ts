import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { render, renderModelBrief } from "../src/render.js";
import { runRules } from "../src/rules/index.js";
import { validate } from "../src/llm/validate.js";
import { generateModelBrief } from "../src/llm/brief.js";
import type { Finding } from "../src/types.js";
import { snap } from "./fixtures.js";

const now = DateTime.fromISO("2026-10-16T05:00:00Z");
const date = "2026-10-15T10:00:00Z";
const w = { start: new Date("2026-10-14T22:00Z"), end: new Date("2026-10-15T22:00Z"), label: "yesterday" };
const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, activeRepoDays: 7, ignoreBranchPrefixes: [] };
const commit = (message: string, branch = "feature", i = 0) => ({ sha: `${branch}-${i}`, parentSha: `parent-${i}`, message, date, branch, author: "me", url: `https://github.com/me/case-ai/commit/${branch}-${i}` });
const issue = (number: number, title = "feat: Plan the next release") => ({ number, title, url: `https://github.com/me/case-ai/issues/${number}`, createdAt: date });
const pr = { number: 2, title: "feat(core)!: GitHub morning brief pipeline and activity rules", url: "https://github.com/me/case-ai/pull/2", draft: false, headRef: "feature", updatedAt: date, mergedAt: date };
const data = [snap({ repo: "me/case-ai", commits: Array.from({ length: 15 }, (_, i) => commit(i % 2 ? "fix: model settings fallbacks" : "feat: personalize brief greetings", "feat/m2-model-brief", i)).concat(commit("feat: update README.md", "main")), mergedPrs: [pr], newIssues: [issue(1, "fix: M1 verification: five-morning trial")] })];
const findings = () => runRules(data, now.toJSDate(), cfg);
const plain = (text: string) => text.replace(/<[^>]+>/g, "");
const model = (fs: Finding[]) => renderModelBrief({ yesterday: fs.filter((f) => f.severity === "info").map((f) => ({ text: `You worked on ${f.repo}.`, sources: [f] })), attention: [], focus: [] }, [], w, 3800, { now });
const renderers = [
  ["template", (fs: Finding[]) => render(fs, [], w, 3800, undefined, { now })],
  ["model", model],
  ["fallback", (fs: Finding[]) => render(fs, [], w, 3800, "Rule-only brief: model unavailable", { now })],
] as const;

describe.each(renderers)("%s recap", (_, renderBrief) => {
  it("groups a repo once, removes it from bullets, and orders commits before PRs and issues", () => {
    const text = renderBrief(findings().reverse());
    const visible = plain(text);
    expect(text.match(/<b>case-ai<\/b>/g)).toHaveLength(1);
    expect(visible.match(/case-ai/g)).toHaveLength(1);
    expect(visible).not.toContain("me/case-ai");
    expect(visible).not.toMatch(/^[•🔴🟡⚪]\s+You\b/im);
    expect(visible.indexOf("15 commits")).toBeLessThan(visible.indexOf("A README update"));
    expect(visible.indexOf("A README update")).toBeLessThan(visible.indexOf("Merged PR"));
    expect(visible.indexOf("Merged PR")).toBeLessThan(visible.indexOf("Opened issue"));
    expect(visible).toContain('Merged PR #2 "GitHub morning brief pipeline and activity rules". [PR]');
    expect(visible).toContain('Opened issue #1 "M1 verification: five-morning trial". [issue]');
    expect(visible).toContain("A README update on main. [commit]");
    expect(visible).not.toContain("1 commit");
    expect(visible).not.toContain("Have a productive day");
    expect(text.match(/<a href=/g)).toHaveLength(4);
  });
  it("orders repo groups by the total amount of activity, rather than bullet count", () => {
    const manyIssues = snap({ repo: "me/issues", newIssues: [1, 2, 3, 4].map((n) => ({ ...issue(n), url: `https://github.com/me/issues/issues/${n}` })) });
    const fs = runRules([manyIssues, ...data], now.toJSDate(), cfg);
    const text = renderBrief(fs);
    expect(text.indexOf("<b>case-ai</b>")).toBeLessThan(text.indexOf("<b>issues</b>"));
  });
  it.each([
    ["fix: Handle empty results", "A commit on main: Handle empty results."],
    ["docs: Clarify setup", "A documentation update on main: Clarify setup."],
    ["docs(readme): update README.md", "A README update on main."],
  ])("formats a single commit %s", (message, expected) => {
    const fs = runRules([snap({ commits: [commit(message, "main")] })], now.toJSDate(), cfg);
    expect(plain(renderBrief(fs))).toContain(`• ${expected} [commit]`);
    expect(plain(renderBrief(fs))).not.toContain("1 commit");
  });
});

describe("model recap and closing discipline", () => {
  it.each(["You added context", "You've added context", "You're adding context", "You should add context"])("removes second-person openings: %s", (text) => {
    const f: Finding = { id: "comment", rule: "issue_comments", severity: "info", repo: "me/demo", summary: "Commented on issue #1", sources: [{ label: "comment", url: "https://github.com/me/demo/issues/1#issuecomment-1" }] };
    const output = renderModelBrief({ yesterday: [{ text, sources: [f] }], attention: [], focus: [] }, [], w);
    expect(plain(output)).not.toMatch(/^• You\b/im);
  });
  it("does not leave an empty repo heading when its first bullet is truncated", () => {
    const f = findings()[0];
    const output = render([f], [], w, 230, undefined, { now });
    expect(output.length).toBeLessThanOrEqual(230);
    expect(output).toContain("more line(s) not shown");
    expect(output).not.toContain("<b>case-ai</b>");
    expect(output).not.toContain("Here's what you worked on");
  });
  it("keeps a model's branch highlights inside the same grouped structure", () => {
    const fs = findings();
    const text = renderModelBrief({ yesterday: fs.map((f) => ({ text: f.activity?.kind === "commits" && f.activity.count > 1 ? "15 commits on feat/m2-model-brief, including fixing model settings fallbacks and personalizing brief greetings." : f.summary, sources: [f] })), attention: [], focus: [] }, [], w);
    expect(plain(text)).toContain("15 commits on feat/m2-model-brief, including fixing model settings fallbacks and personalizing brief greetings. [diff]");
    expect(plain(text).match(/case-ai/g)).toHaveLength(1);
  });
  it("splits a model sentence that combines different repos into sourced groups", () => {
    const fs = runRules([...data, snap({ repo: "me/portfolio", newIssues: [{ ...issue(9), url: "https://github.com/me/portfolio/issues/9" }] })], now.toJSDate(), cfg);
    const text = renderModelBrief({ yesterday: [{ text: "You made progress across case-ai and portfolio.", sources: fs }], attention: [], focus: [] }, [], w);
    expect(text).toContain("<b>case-ai</b>");
    expect(text).toContain("<b>portfolio</b>");
    expect(text).not.toContain("You made progress across");
  });
  it.each([
    { note: "Have a productive day ahead!", noteSources: ["F1"] },
    { note: "Have a productive day ahead.", noteSources: ["F1"] },
    { note: "The branch has 15 commits!", noteSources: ["F1"] },
    { note: "The branch has 15 commits.\nA second closing line.", noteSources: ["F1"] },
    { note: "The branch has 15 commits.", noteSources: ["missing"] },
    { note: "The branch has 15 commits." },
  ])("omits invalid or generic closing text: $note", (closing) => {
    const f = findings()[0];
    const result = validate(JSON.stringify({ yesterday: [{ text: f.summary, sources: ["F1"] }], attention: [], focus: [], ...closing }), new Map([["F1", f]]), [f]);
    expect(result).toMatchObject({ ok: true, brief: { yesterday: expect.any(Array) } });
    if (result.ok) {
      expect(result.brief.note).toBeUndefined();
      expect(renderModelBrief(result.brief, [], w)).not.toContain("<i>");
    }
  });
  it("renders one cited closing line and serializes its evidence aliases", async () => {
    const f = findings()[0];
    const note = "The feat/m2-model-brief branch has 15 commits to review.";
    const raw = JSON.stringify({ yesterday: [{ text: f.summary, sources: ["F1"] }], attention: [], focus: [], note, noteSources: ["F1"] });
    const result = await generateModelBrief([f], data, w, { modelIncludePrivate: true, modelTimeoutMs: 1000, maxBriefChars: 3800 }, { name: "test", generate: async () => ({ model: "test", raw }) }, now);
    expect(result.json.brief).toMatchObject({ note, noteSources: ["F1"] });
    if ("text" in result) {
      expect(result.text.match(/<i>/g)).toHaveLength(1);
      expect(result.text).toContain(`<i>${note}</i>`);
      expect(result.text).not.toContain("!");
    }
    expect(render([f], [], w)).not.toContain("<i>");
  });
});
