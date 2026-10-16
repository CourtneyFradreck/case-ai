import type { Finding } from "./types.js";
import type { ValidBrief, ValidItem } from "./llm/schema.js";

// Comments and issue/PR events can cite different URLs for the same item.
const sourceKeys = (f: Finding) => f.sources.map((s) =>
  s.url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+)(?:[?#/]|$)/)?.[1] ?? s.url);
const generic = (f: Finding) => ["open_issues", "open_pr"].includes(f.rule);

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
export function organizeBrief(brief: ValidBrief, findings: Finding[]): ValidBrief {
  const allowed = new Map(deduplicateFindings(findings).map((f) => [f.id, f]));
  const seen = new Set<string>();
  const result: ValidBrief = { yesterday: [], attention: [], focus: [], ...(brief.note ? { note: brief.note } : {}) };
  const add = (item: ValidItem, section: "attention" | "yesterday") => {
    const sources = item.sources.filter((f) => allowed.has(f.id) && !seen.has(f.id));
    if (!sources.length) return;
    const matches = (f: Finding) => (f.severity === "info" ? "yesterday" : "attention") === section;
    if (sources.length === item.sources.length && sources.every(matches) &&
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
  // Older model responses may still contain focus suggestions. Fold them into
  // attention so a finding never appears in a third section as well.
  brief.focus.forEach((i) => add({ text: `${i.text} (${i.reason})`, sources: i.sources }, "attention"));
  brief.yesterday.forEach((i) => add(i, "yesterday"));
  return result;
}
