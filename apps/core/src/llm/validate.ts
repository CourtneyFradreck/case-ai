import type { Finding } from "../types.js";
import { BriefJson, REASON_MAX, TEXT_MAX, type ValidBrief, type ValidItem, type AliasBrief, type ValidFocus } from "./schema.js";
import { focusOnly, organizeBrief } from "../sections.js";
import { closingLine } from "./closing.js";

export interface DropReason { section: "yesterday" | "attention" | "focus"; index: number; reason: string; aliases?: string[] }
// An overlong text or reason the validator cut to its limit; length is before shortening.
export interface Shortened { section: DropReason["section"]; index: number; field: "text" | "reason"; length: number }
export type ValidationResult = { ok: true; brief: ValidBrief; dropped: DropReason[]; addedBack: string[]; shortened: Shortened[] } | { ok: false; reason: string; detail?: string };
const stripUrls = (text: string) => text.replace(/https?:\/\/\S+|www\.\S+/gi, "").trim();

// Cuts at the last word boundary that leaves room for "…", so the result is at most max characters.
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// With keepFocus, focus is its own section, and a finding a suggestion cites is shown there instead of in attention.
export function validate(raw: string, aliasToFinding: Map<string, Finding>, allFindings: Finding[], keepFocus = false): ValidationResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    return { ok: false, reason: "invalid_json", detail: error instanceof Error ? error.message : "Invalid JSON response" };
  }
  const result = BriefJson.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "invalid_schema", detail: result.error.message };
  const dropped: DropReason[] = [];
  const addedBack: string[] = [];
  const shortened: Shortened[] = [];
  const fit = (value: string, max: number, section: DropReason["section"], index: number, field: Shortened["field"]) => {
    if (value.length > max) shortened.push({ section, index, field, length: value.length });
    return shorten(value, max);
  };
  const brief: ValidBrief = { yesterday: [], attention: [], focus: [] };
  const focusCited = new Set<string>();
  const resolve = (items: AliasBrief["yesterday"], section: DropReason["section"]): ValidItem[] => items.flatMap((item, index) => {
    const unknown = item.sources.filter((alias) => !aliasToFinding.has(alias));
    const sources = [...new Set(item.sources)].flatMap((alias) => aliasToFinding.has(alias) ? [aliasToFinding.get(alias)!] : []);
    if (!sources.length) {
      dropped.push({ section, index, reason: "no_sources", aliases: unknown });
      return [];
    }
    if (unknown.length) dropped.push({ section, index, reason: "unknown_aliases", aliases: unknown });
    const text = stripUrls(item.text);
    if (!text) {
      dropped.push({ section, index, reason: "empty_text" });
      return [];
    }
    if (keepFocus && section === "focus") {
      // A suggestion is shown with its reason, so it needs one; and each finding backs one suggestion at most.
      if (!stripUrls(String((item as AliasBrief["focus"][number]).reason))) {
        dropped.push({ section, index, reason: "empty_reason" });
        return [];
      }
      if (sources.every((f) => focusCited.has(f.id))) {
        dropped.push({ section, index, reason: "duplicate_focus" });
        return [];
      }
      sources.forEach((f) => focusCited.add(f.id));
    }
    return [{ text: fit(text, TEXT_MAX, section, index, "text"), sources,
      ...("reason" in item ? { reason: fit(stripUrls(String(item.reason)), REASON_MAX, section, index, "reason") } : {}) }];
  });
  brief.yesterday = resolve(result.data.yesterday, "yesterday");
  brief.attention = resolve(result.data.attention, "attention");
  brief.focus = resolve(result.data.focus, "focus") as ValidFocus[];
  if (result.data.note !== undefined) {
    const aliases = [...new Set(result.data.noteSources ?? [])];
    const sources = aliases.flatMap((alias) => aliasToFinding.has(alias) ? [aliasToFinding.get(alias)!] : []);
    const note = sources.length === aliases.length ? closingLine(stripUrls(result.data.note), sources) : undefined;
    if (note) { brief.note = note; brief.noteSources = sources; }
  }
  const cited = new Set([...brief.yesterday, ...brief.attention, ...brief.focus].flatMap((i) => i.sources.map((f) => f.id)));
  const sent = new Set([...aliasToFinding.values()].map((f) => f.id));
  for (const f of allFindings) {
    if (focusOnly(f)) continue;
    if (!sent.has(f.id)) {
      brief[f.severity === "info" ? "yesterday" : "attention"].push({ text: f.summary, sources: [f] });
    } else if ((f.severity === "high" || f.severity === "medium") && !cited.has(f.id)) {
      brief.attention.push({ text: f.summary, sources: [f] });
      addedBack.push(f.id);
    }
  }
  // Items citing only NEXT.md items are dropped from attention and recap later, so they don't count here.
  const kept = (i: ValidItem) => i.sources.some((f) => !focusOnly(f));
  if (!brief.yesterday.some(kept) && !brief.attention.some(kept) && !brief.focus.length && allFindings.some((f) => !focusOnly(f))) return { ok: false, reason: "empty_brief" };
  return { ok: true, brief: organizeBrief(brief, allFindings, keepFocus), dropped, addedBack, shortened };
}
