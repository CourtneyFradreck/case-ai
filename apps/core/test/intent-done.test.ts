import { describe, expect, it } from "vitest";
import { mergedMatch, relatesTo } from "../src/intent/done.js";
import { nextItems } from "../src/intent/rules.js";
import { parseNext } from "../src/intent/parse.js";
import { itemLabel } from "../src/labels.js";
import { snap } from "./fixtures.js";
import type { Pr } from "../src/types.js";

const repo = "CourtneyFradreck/case-ai";
const pr = (number: number, title: string, headRef: string, mergedAt = "2026-10-20T08:15:31Z"): Pr => ({
  number, title, headRef, mergedAt, url: `https://github.com/${repo}/pull/${number}`, draft: false, updatedAt: mergedAt,
});
const m2 = pr(3, "feat: M2 model brief with validated citations", "feat/m2-model-brief");
const m1 = pr(2, "feat: GitHub morning brief pipeline and activity rules", "feat/m1-ruleonly-brief", "2026-10-15T11:28:31Z");
const md = [
  "## M2 rollout", "",
  "- [ ] Merge M2 after M1 trial ends (Mon 19 Oct)",
  "- [ ] Run CASE_BRIEF_MODE=command for 3 days; check logged dropped / fallbackReason",
  "- [ ] Switch to CASE_BRIEF_MODE=all",
  "## M3 rollout",
  "- [ ] Compare model suggestions with the rule-picked ones in rule_text for a week",
].join("\n");
const next = { status: "ok" as const, sha: "n", url: `https://github.com/${repo}/blob/main/NEXT.md`, lastChangedAt: null, items: parseNext(repo, md) };

describe("done detection", () => {
  it("matches an item to a merged PR by the milestone it names first", () => {
    expect(relatesTo("Merge M2 after M1 trial ends (Mon 19 Oct)", m2.title)).toBe(true);
    expect(relatesTo("Merge M2 after M1 trial ends (Mon 19 Oct)", m1.headRef)).toBe(false);
  });
  it("matches on shared keywords from the title or branch", () => {
    expect(relatesTo("Rework the product section on the site", "feat/update-product-section".replace(/[/_-]+/g, " "))).toBe(true);
    // One shared keyword ("model") isn't enough.
    expect(relatesTo("Compare model suggestions with the rule-picked ones", m2.title)).toBe(false);
  });
  it("looks at recently merged PRs as well as those merged in the collected week", () => {
    const s = snap({ repo, recentlyMerged: [m2, m1] });
    expect(mergedMatch("Merge M2 after M1 trial ends", s)).toEqual(m2);
    expect(mergedMatch("Merge M2 after M1 trial ends", snap({ repo, mergedPrs: [m2] }))).toEqual(m2);
    expect(mergedMatch("Merge M4", s)).toBeUndefined();
  });
  it("replaces a likely finished item's suggestion with one tick-off line", () => {
    const findings = nextItems(snap({ repo, recentlyMerged: [m2, m1] }), next);
    expect(findings.map((f) => f.rule)).toEqual(["next_likely_done", "next_item", "next_item", "next_item"]);
    expect(findings[0]).toMatchObject({
      severity: "low",
      summary: 'Looks like "Merge M2" is done (PR #3 merged). Tick it off in NEXT.md?',
      sources: [{ label: "PR", url: m2.url }, { label: "NEXT.md", url: `${next.url}#L3` }],
    });
    expect(findings.filter((f) => f.rule === "next_item").map((f) => f.summary)).not.toContainEqual(expect.stringContaining("Merge M2"));
  });
  it("keeps every item open without a matching merge", () => {
    expect(nextItems(snap({ repo }), next).every((f) => f.rule === "next_item")).toBe(true);
  });
});

describe("item labels", () => {
  it.each([
    ["Merge M2 after M1 trial ends (Mon 19 Oct)", "Merge M2"],
    ["Run CASE_BRIEF_MODE=command for 3 days; check logged dropped / fallbackReason", "Run CASE_BRIEF_MODE=command"],
    ["Turn on features.focusButtons and redeploy; check the first brief", "Turn on features.focusButtons"],
    ["Set CASE_DELIVERY=core with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID", "Set CASE_DELIVERY=core"],
  ])("labels %j as %j", (text, label) => expect(itemLabel(text)).toBe(label));
  it("stays within 40 characters", () => {
    const label = itemLabel("Write a very long migration guide covering every single deployment target we support");
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.endsWith("…")).toBe(true);
  });
});
