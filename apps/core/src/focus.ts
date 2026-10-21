import type { Finding, RepoSnapshot } from "./types.js";
import type { ValidFocus } from "./llm/schema.js";
import { byPriority } from "./rules/order.js";
import { plural } from "./plural.js";
import { lastCommitDays, type IntentConfig } from "./intent/rules.js";

export const MAX_FOCUS = 3;

// One fixed reason per rule, built only from the finding's own fields.
function reason(f: Finding): string {
  const days = f.ageDays === undefined ? "" : plural(f.ageDays, "day");
  switch (f.rule) {
    case "failing_ci": return "CI is failing on the default branch";
    case "idle_pr": return days ? `No activity for ${days}` : "No recent activity";
    case "stale_branch": return days ? `Unmerged and untouched for ${days}` : "Unmerged and untouched";
    case "issue_comments": return "New comments are waiting for a reply";
    case "next_item": return `Open in NEXT.md, and ${f.repo.split("/").pop()} has recent commits`;
    default: return f.severity === "high" ? "Marked high priority" : "Needs attention";
  }
}

const text = (f: Finding) => f.rule === "next_item" ? f.summary.replace(`Next in ${f.repo}: `, "") : f.summary;

// Focus suggestions without the model: high findings, then medium, then open NEXT.md
// items from repos with commits in the last activeRepoDays (most recently active first).
export function ruleFocus(findings: Finding[], next: Finding[], snaps: RepoSnapshot[], now: Date,
                          cfg: Pick<IntentConfig, "activeRepoDays" | "ignoreBranchPrefixes">): ValidFocus[] {
  const attention = findings.filter((f) => f.severity === "high" || f.severity === "medium").sort(byPriority);
  const active = new Map(snaps.filter((s) => !s.error).map((s) => [s.repo, lastCommitDays(s, now, cfg)] as const)
    .filter(([, days]) => days <= cfg.activeRepoDays));
  const planned = next.filter((f) => f.rule === "next_item" && active.has(f.repo))
    // Stable sort keeps NEXT.md order within a repo.
    .sort((a, b) => active.get(a.repo)! - active.get(b.repo)!);
  return [...attention, ...planned].slice(0, MAX_FOCUS).map((f) => ({ text: text(f), reason: reason(f), sources: [f] }));
}
