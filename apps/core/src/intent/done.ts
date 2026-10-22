import type { Pr, RepoSnapshot } from "../types.js";

// Words that say nothing about which piece of work an item or PR is.
const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "after", "before", "when", "once", "until", "then", "that", "this",
  "its", "all", "any", "out", "off", "via", "per", "one", "two", "three", "days", "day", "week", "weeks", "ends", "end",
  "feat", "fix", "docs", "chore", "test", "tests", "refactor", "merge", "merged", "pull", "request", "branch", "add", "update",
  "make", "set", "run", "use", "get", "new", "check", "turn", "stop", "start", "keep",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
]);

export const keywords = (text: string) => new Set(text.toLowerCase()
  .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/, "")
  .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)));

// The first milestone an item names ("Merge M2 after M1 trial ends" → "m2"): the one it is about.
const milestone = (text: string) => /\bM(\d{1,2})\b/i.exec(text)?.[1];
const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

// Whether some other text (a PR title, branch name or commit message) is about the same work as a NEXT.md item:
// it names the item's milestone, or shares at least two keywords that make up half the item's keywords.
export function relatesTo(item: string, other: string): boolean {
  const m = milestone(item);
  if (m && tokens(other).has(`m${m}`)) return true;
  const wanted = keywords(item);
  const shared = [...keywords(other)].filter((w) => wanted.has(w)).length;
  return shared >= 2 && shared * 2 >= wanted.size;
}

// A merged PR that likely finished an open item, matched on its title or head branch.
export function mergedMatch(item: string, s: RepoSnapshot): Pr | undefined {
  const merged = new Map([...(s.recentlyMerged ?? []), ...s.mergedPrs].map((p) => [p.number, p]));
  return [...merged.values()]
    .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))
    .find((p) => relatesTo(item, p.title) || relatesTo(item, p.headRef.replace(/[/_-]+/g, " ")));
}
