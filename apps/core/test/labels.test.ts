import { describe, expect, it } from "vitest";
import { clip, findingLabel, focusLabel, MAX_LABEL } from "../src/labels.js";
import { finding } from "./fixtures.js";

describe("short labels", () => {
  it.each([
    [{ rule: "stale_branch", repo: "me/taga-technologies", target: "feat/update-product-section" }, "taga product section branch"],
    [{ rule: "idle_pr", repo: "me/attachcv", target: "PR #14" }, "attachcv PR #14"],
    [{ rule: "failing_ci", repo: "me/case-ai", target: "build" }, "case-ai build CI"],
    [{ rule: "issue_comments", repo: "me/case-ai", target: "issue #8" }, "case-ai issue #8 comments"],
    [{ rule: "open_issues", repo: "me/case-ai" }, "case-ai open issues"],
    [{ rule: "old_branches", repo: "me/attachcv, me/crc-app" }, "old branches"],
    [{ rule: "next_item", repo: "me/case-ai", summary: "Next in me/case-ai: Merge M2 after M1 trial ends (Mon 19 Oct)" }, "Merge M2"],
  ])("labels %j as %j", (over, label) => expect(findingLabel(finding(over))).toBe(label));
  it("never exceeds 40 characters, whatever the input", () => {
    const long = "x".repeat(30);
    const findings = [
      finding({ rule: "stale_branch", repo: `me/${long}`, target: `feat/${long}-${long}` }),
      finding({ rule: "idle_pr", repo: `me/${long}`, target: "PR #12345" }),
      finding({ rule: "next_item", repo: "me/demo", summary: `Next in me/demo: ${"word ".repeat(30)}` }),
      finding({ rule: "something_new", summary: "A summary that goes on and on well past any button's width" }),
    ];
    for (const f of findings) expect(findingLabel(f).length).toBeLessThanOrEqual(MAX_LABEL);
    expect(clip("a ".repeat(50)).length).toBeLessThanOrEqual(MAX_LABEL);
  });
  it("uses the model's label only when code had to cut its own", () => {
    const short = finding({ rule: "idle_pr", repo: "me/attachcv", target: "PR #14" });
    const long = finding({ rule: "something_new", summary: "A summary that goes on and on well past any button's width" });
    expect(focusLabel([short], "Review PR #14", "attachcv review")).toBe("attachcv PR #14");
    expect(focusLabel([long], "Do it", "the long one")).toBe("the long one");
    expect(focusLabel([long], "Do it", "x".repeat(41))).toBe(findingLabel(long));
  });
});
