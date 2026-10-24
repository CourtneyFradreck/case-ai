import type { Finding } from "./types.js";

// A short_label names a finding or NEXT.md item in at most 40 characters, so a Telegram button shows all of it.
export const MAX_LABEL = 40;

// Cuts at a word boundary so the result, "…" included, is at most max characters.
export function clip(text: string, max = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// A NEXT.md item's main clause: dates in brackets and anything after a connecting word are dropped.
// "Merge M2 after M1 trial ends (Mon 19 Oct)" → "Merge M2".
const CONNECTOR = /\s+(?:after|before|once|when|until|unless|so that|so|then|and|with|for|by|via|because)\s+|\s*[;:,(–—]\s*/i;
export function itemLabel(text: string): string {
  const clause = text.replace(/\([^)]*\)/g, " ").split(CONNECTOR)[0].trim();
  return clip(clause || text);
}

const GENERIC = new Set(["feat", "feature", "fix", "chore", "docs", "refactor", "update", "add", "wip", "new", "branch", "the"]);
const repoName = (repo: string) => repo.split("/").pop()!;
// "taga-technologies" → "taga": the first part of a hyphenated name is usually enough to tell repos apart.
const repoWord = (repo: string) => repoName(repo).split(/[-_.]/)[0] || repoName(repo);

// "feat/update-product-section" → "product section".
function branchWords(branch: string): string {
  const words = branch.split(/[/_-]+/).filter((w) => w && !GENERIC.has(w.toLowerCase()));
  return words.slice(0, 2).join(" ") || branch;
}

// Built from the finding's own fields; the last case clips the summary.
export function findingLabel(f: Finding): string {
  const repo = repoName(f.repo);
  switch (f.rule) {
    case "stale_branch": if (f.target) return clip(`${repoWord(f.repo)} ${branchWords(f.target)} branch`); break;
    case "idle_pr": if (f.target) return clip(`${repo} ${f.target}`); break;
    case "failing_ci": if (f.target) return clip(`${repo} ${f.target} CI`); break;
    case "issue_comments": if (f.target) return clip(`${repo} ${f.target} comments`); break;
    case "open_issues": return clip(`${repo} open issues`);
    case "old_branches": return "old branches";
    case "next_missing": return clip(`${repo} NEXT.md`);
    case "next_item": return itemLabel(f.summary.replace(`Next in ${f.repo}: `, ""));
    case "next_likely_done": return clip(/^Looks like "(.*)" is done/.exec(f.summary)?.[1] ?? f.summary);
  }
  return clip(f.summary);
}

// The label for a suggestion: its first finding's, or the model's own when that one had to be cut.
export function focusLabel(sources: Finding[], text: string, modelLabel?: string): string {
  const label = sources[0] ? findingLabel(sources[0]) : clip(text);
  const model = modelLabel?.replace(/\s+/g, " ").trim();
  return label.endsWith("…") && model && model.length <= MAX_LABEL ? model : label;
}
