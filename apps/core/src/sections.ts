import type { Finding } from "./types.js";
import type { ValidBrief, ValidItem } from "./llm/schema.js";

// Comments and issue/PR events can cite different URLs for the same item.
const sourceKeys = (f: Finding) => f.sources.map((s) =>
  s.url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+)(?:[?#/]|$)/)?.[1] ?? s.url);
const generic = (f: Finding) => ["open_issues", "open_pr"].includes(f.rule);

// Open NEXT.md items are plans, not activity or problems: they may back a focus suggestion only.
export const focusOnly = (f: Finding) => f.rule === "next_item";

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const concrete = new Set(findings.filter((f) => f.severity !== "info" && !generic(f)).flatMap(sourceKeys));
  const recap = findings.filter((f) => f.severity === "info" && !sourceKeys(f).some((key) => concrete.has(key)));
  const recapIds = new Set(recap.map((f) => f.id));
  const recapKeys = new Set(recap.flatMap(sourceKeys));
  return findings.filter((f) => f.severity === "info" ? recapIds.has(f.id)
    : !generic(f) || !sourceKeys(f).some((key) => recapKeys.has(key)));
}

// Enforce section ownership in code as well as in the prompt. If a model mixes
// sections in one sentence, use sourced template lines for its surviving facts.
// keepFocus (features.focusButtons) keeps focus suggestions as their own section.
export function organizeBrief(brief: ValidBrief, findings: Finding[], keepFocus = false): ValidBrief {
  const allowed = new Map(deduplicateFindings(findings).filter((f) => !focusOnly(f)).map((f) => [f.id, f]));
  const seen = new Set<string>();
  const result: ValidBrief = { yesterday: [], attention: [], focus: [], ...(brief.note ? { note: brief.note, noteSources: brief.noteSources } : {}) };
  const add = (item: ValidItem, section: "attention" | "yesterday") => {
    const sources = item.sources.filter((f) => allowed.has(f.id) && !seen.has(f.id));
    if (!sources.length) return;
    const matches = (f: Finding) => (f.severity === "info" ? "yesterday" : "attention") === section;
    if (sources.length === item.sources.length && sources.every(matches) &&
      !(section === "yesterday" && sources.length > 1) &&
      !(sources.length > 1 && sources.some((f) => f.rule === "old_branches"))) {
      result[section].push(item);
      sources.forEach((f) => seen.add(f.id));
    } else {
      for (const f of sources) {
        result[f.severity === "info" ? "yesterday" : "attention"].push({ text: f.summary, sources: [f] });
        seen.add(f.id);
      }
    }
  };
  brief.attention.forEach((i) => add(i, "attention"));
  if (keepFocus) {
    // A suggestion points at work listed elsewhere, so it may cite attention findings too.
    const known = new Set(findings.map((f) => f.id));
    result.focus = brief.focus.flatMap((i) => {
      const sources = i.sources.filter((f) => known.has(f.id));
      return sources.length ? [{ ...i, sources }] : [];
    });
    // A finding a suggestion is built on appears there only: attention items that cite nothing else go.
    const cited = new Set(result.focus.flatMap((i) => i.sources.map((f) => f.id)));
    result.attention = result.attention.filter((i) => !i.sources.every((f) => cited.has(f.id)));
  } else {
    // Older model responses may still contain focus suggestions. Fold them into
    // attention so a finding never appears in a third section as well. Reasons stay out of the text.
    brief.focus.forEach((i) => add({ text: i.text, sources: i.sources }, "attention"));
  }
  brief.yesterday.forEach((i) => add(i, "yesterday"));
  // Most severe cited finding first, as in the rule-only brief; the sort is stable, so the model's order holds within a severity.
  result.attention.sort((a, b) => topRank(a) - topRank(b));
  return result;
}

const rank: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const topRank = (item: ValidItem) => Math.min(...item.sources.map((f) => rank[f.severity] ?? 3));
