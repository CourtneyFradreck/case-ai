import type { Activity, Finding } from "./types.js";

export const stripCommitPrefix = (text: string) => text.trim().replace(
  /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n)]*\))?!?:\s*/i, "");
// Text the validator shortened already ends in "…".
const sentence = (text: string) => text.trim().endsWith("…") ? text.trim() : `${text.trim().replace(/[.!?]+$/, "")}.`;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function bulletText(text: string): string {
  const clean = text.trim().replace(/^you(?:['’](?:ve|re|ll|d)| have| are)?\s+(?:(?:can|could|should|might|may|will|need to)\s+)?/i, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 || /^\d+$/.test(w));

// Never the same fact twice in one line: drops a trailing bracketed aside that only repeats words
// from earlier in the line, or that follows another aside.
// "Merge feat/x: untouched for 8 days (Untouched for 8 days)" → "Merge feat/x: untouched for 8 days".
export function withoutRepeatedAside(text: string): string {
  let out = text.trim();
  for (let m = /\s*\(([^()]*)\)[.]?$/.exec(out); m; m = /\s*\(([^()]*)\)[.]?$/.exec(out)) {
    const before = out.slice(0, m.index);
    const earlier = new Set(words(before));
    if (!/\([^()]*\)/.test(before) && !words(m[1]).every((w) => earlier.has(w))) break;
    out = before.trimEnd();
  }
  return out;
}

function withoutRepo(text: string, repo: string): string {
  const names = [repo, repo.split("/").pop()!].map(escaped).join("|");
  return text.replace(new RegExp(`^(?:${names}):\\s*`, "i"), "")
    .replace(new RegExp(`\\s+(?:in|on|for|from|to|across) (?:${names})(?=[,.:;\\s]|$)`, "gi"), "")
    .trim();
}

const gerunds: Record<string, string> = {
  add: "adding", fix: "fixing", update: "updating", improve: "improving", include: "including",
  personalize: "personalizing", fall: "falling", restore: "restoring", refactor: "refactoring",
  remove: "removing", support: "supporting", document: "documenting", implement: "implementing",
  handle: "handling", enable: "enabling", simplify: "simplifying", clean: "cleaning", refresh: "refreshing",
};
const highlight = (text: string) => stripCommitPrefix(text).replace(/[.!?]+$/, "")
  .replace(/^([A-Za-z]+)\b/, (word) => gerunds[word.toLowerCase()] ?? word)
  .replace(/\band ([A-Za-z]+)\b/g, (_, word: string) => `and ${gerunds[word.toLowerCase()] ?? word}`);
const join = (items: string[]) => items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

export function commitText(activity: Extract<Activity, { kind: "commits" }>): string {
  const { count, branch, messages } = activity;
  if (count === 1) {
    const message = stripCommitPrefix(messages[0] ?? "");
    if (/^(?:(?:update|edit|revise|refresh|fix|add)\s+(?:the\s+)?)?readme(?:\.md)?(?:\s+update)?[.!]?$/i.test(message)) {
      return `A README update on ${branch}.`;
    }
    if (/^docs(?:\([^)]*\))?!?:/i.test(messages[0] ?? "")) return sentence(`A documentation update on ${branch}${message ? `: ${message}` : ""}`);
    return sentence(`A commit on ${branch}${message ? `: ${message}` : ""}`);
  }
  const highlights = [...new Set(messages.map(highlight).filter(Boolean))].slice(-3);
  return sentence(`${count} commits on ${branch}${highlights.length ? `, including ${join(highlights)}` : ""}`);
}

export function recapKind(f: Finding): number {
  if (f.activity?.kind === "commits" || f.rule === "commits") return 0;
  if (f.activity?.kind === "pr" || ["opened_pr", "merged_pr"].includes(f.rule)) return 1;
  return 2;
}

export const activityAmount = (f: Finding) => f.activity?.kind === "commits" ? f.activity.count
  : f.rule === "commits" ? Number(f.summary.match(/(?:^|: )(\d+) commits? on /)?.[1] ?? 1) : 1;

export function recapText(f: Finding, modelText?: string): string {
  const activity = f.activity;
  if (activity?.kind === "commits") {
    // Single commits and docs updates have a fixed shape. A model may phrase
    // highlights for multi-commit branches, while code keeps the sourced count.
    const text = withoutRepo(modelText ?? "", f.repo);
    const prefix = `${activity.count} commits on ${activity.branch}, including `;
    return activity.count > 1 && text.startsWith(prefix) ? sentence(text) : commitText(activity);
  }
  if (activity) return `${activity.action} ${activity.kind === "pr" ? "PR" : "issue"} #${activity.number} "${stripCommitPrefix(activity.title)}".`;
  let text = withoutRepo(modelText ?? f.summary, f.repo);
  if (f.rule === "issue_comments") text = text.replace(/^(.+) commented on (.+), you replied$/, "Replied to comments on $2 (from $1)");
  // Legacy or restored findings may lack structured activity metadata.
  text = text.replace(/\b1 commit on /, "A commit on ")
    .replace(/"([^"\r\n]*)"/g, (_, title: string) => `"${stripCommitPrefix(title)}"`);
  if (!modelText && f.details?.length) text += `, including ${join(f.details.map(highlight).slice(0, 3))}`;
  return sentence(bulletText(text));
}
