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

// One line per branch. Several commits get the themes of their subjects, never the subjects themselves.
export function commitText(activity: Extract<Activity, { kind: "commits" }>, repo?: string): string {
  const { count, branch, messages } = activity;
  if (count === 1) {
    const message = stripCommitPrefix(messages[0] ?? "");
    if (/^(?:(?:update|edit|revise|refresh|fix|add)\s+(?:the\s+)?)?readme(?:\.md)?(?:\s+update)?[.!]?$/i.test(message)) {
      return `A README update on ${branch}.`;
    }
    if (/^docs(?:\([^)]*\))?!?:/i.test(messages[0] ?? "")) return sentence(`A documentation update on ${branch}${message ? `: ${message}` : ""}`);
    return sentence(`A commit on ${branch}${message ? `: ${message}` : ""}`);
  }
  const found = themes(messages, [repo ?? "", branch]);
  return sentence(`${count} commits on ${branch}${soFar(activity)}${found.length ? `, covering ${join(found).replace(", and ", " and ")}` : ""}`);
}

// "(46 on the branch so far)" when the branch holds more commits than the recap counted.
const soFar = ({ count, branchTotal }: Extract<Activity, { kind: "commits" }>) =>
  branchTotal && branchTotal > count ? ` (${branchTotal} on the branch so far)` : "";

// Words that name no theme: grammar, everyday commit verbs, and generic code nouns.
const NOT_THEMES = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "when", "then", "than", "that", "this", "its", "it's", "their", "them",
  "only", "every", "each", "all", "any", "some", "more", "less", "one", "two", "not", "now", "yet", "also", "too", "own",
  "after", "before", "until", "since", "through", "instead", "without", "about", "per", "via", "off", "out", "again",
  "add", "fix", "update", "stop", "make", "use", "show", "say", "keep", "turn", "send", "store", "read", "count", "ask",
  "let", "get", "set", "run", "move", "remove", "handle", "support", "allow", "describe", "document", "tick", "plan",
  "rename", "clean", "improve", "refactor", "change", "test", "tests", "docs", "new", "old", "first", "last", "next",
  "file", "files", "code", "line", "lines", "item", "items", "value", "values", "case", "cases", "way", "time", "day", "days",
]);

// The 2-3 things most commits were about, named by the words that recur across their subjects
// (in at least two commits), most frequent first. Words from the repo and branch names don't count.
export function themes(messages: string[], exclude: string[] = []): string[] {
  const skip = new Set(exclude.flatMap((n) => n.toLowerCase().split(/[^a-z0-9]+/)));
  const seen = new Map<string, { n: number; first: number; forms: Map<string, number> }>();
  messages.forEach((message, i) => {
    const words = stripCommitPrefix(message).match(/[A-Za-z][\w.-]*[A-Za-z0-9]/g) ?? [];
    const inThis = new Set<string>();
    // A subject's first word is nearly always its verb ("personalize brief greetings").
    for (const word of words.slice(1)) {
      const lower = word.toLowerCase();
      // Singular and plural count as one word; identifiers such as NEXT.md or CASE_BRIEF_MODE are left out.
      const key = lower.replace(/(?<=[a-z]{3})(?:es|s)$/, "");
      if (lower.length < 4 || /[._]/.test(word) || NOT_THEMES.has(lower) || NOT_THEMES.has(key) || inThis.has(key) ||
        lower.split("-").some((part) => skip.has(part) || skip.has(part.replace(/(?<=[a-z]{3})(?:es|s)$/, "")))) continue;
      inThis.add(key);
      const entry = seen.get(key) ?? { n: 0, first: i, forms: new Map() };
      entry.n++;
      entry.forms.set(word, (entry.forms.get(word) ?? 0) + 1);
      seen.set(key, entry);
    }
  });
  return [...seen.values()].filter((e) => e.n >= 2)
    .sort((a, b) => b.n - a.n || a.first - b.first).slice(0, 3)
    // The most used spelling; lower case unless it is an acronym or a name that is never written lower case.
    .map((e) => {
      const word = [...e.forms].sort((a, b) => b[1] - a[1])[0][0];
      const name = /^[A-Z]/.test(word) && midSentence(word, messages);
      return /^[A-Z0-9]+$/.test(word) || name ? word : word.toLowerCase();
    });
}

// Capitalised at least once where a sentence doesn't start, so the capital isn't just the subject's first letter.
const midSentence = (word: string, messages: string[]) =>
  messages.some((m) => new RegExp(`\\S\\s+${word}\\b`).test(stripCommitPrefix(m)));

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
    // The model's wording is kept only if it names themes rather than pasting commit subjects.
    const text = withoutRepo(modelText ?? "", f.repo);
    const prefix = `${activity.count} commits on ${activity.branch}`;
    const pasted = activity.messages.some((m) => stripCommitPrefix(m).length >= 15 && text.toLowerCase().includes(stripCommitPrefix(m).toLowerCase()));
    return activity.count > 1 && /^[,:]/.test(text.slice(prefix.length)) && text.startsWith(prefix) && !pasted
      ? sentence(`${prefix}${soFar(activity)}${text.slice(prefix.length)}`) : commitText(activity, f.repo);
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
