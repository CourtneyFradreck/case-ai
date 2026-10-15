import type { Finding } from "../types.js";
import { BriefJson, type ValidBrief, type ValidItem, type AliasBrief, type ValidFocus } from "./schema.js";

export interface DropReason { section: "yesterday" | "attention" | "focus"; index: number; reason: string; aliases?: string[] }
export type ValidationResult = { ok: true; brief: ValidBrief; dropped: DropReason[]; addedBack: string[] } | { ok: false; reason: string };
const stripUrls = (text: string) => text.replace(/https?:\/\/\S+|www\.\S+/gi, "").trim();

export function validate(raw: string, aliasToFinding: Map<string, Finding>, allFindings: Finding[]): ValidationResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: "invalid_json" }; }
  const result = BriefJson.safeParse(parsed);
  if (!result.success) return { ok: false, reason: result.error.message };
  const dropped: DropReason[] = [];
  const addedBack: string[] = [];
  const brief: ValidBrief = { yesterday: [], attention: [], focus: [] };
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
    return [{ text, sources, ...("reason" in item ? { reason: stripUrls(String(item.reason)) } : {}) }];
  });
  brief.yesterday = resolve(result.data.yesterday, "yesterday");
  brief.attention = resolve(result.data.attention, "attention");
  brief.focus = resolve(result.data.focus, "focus") as ValidFocus[];
  if (result.data.note !== undefined) {
    const note = stripUrls(result.data.note);
    if (note) brief.note = note;
  }
  const cited = new Set([...brief.yesterday, ...brief.attention, ...brief.focus].flatMap((i) => i.sources.map((f) => f.id)));
  const sent = new Set([...aliasToFinding.values()].map((f) => f.id));
  for (const f of allFindings) {
    if (!sent.has(f.id)) {
      brief[f.severity === "info" ? "yesterday" : "attention"].push({ text: f.summary, sources: [f] });
    } else if (f.severity === "high" && !cited.has(f.id)) {
      brief.attention.push({ text: f.summary, sources: [f] });
      addedBack.push(f.id);
    }
  }
  if (!brief.yesterday.length && !brief.attention.length && !brief.focus.length && allFindings.length) return { ok: false, reason: "empty_brief" };
  return { ok: true, brief, dropped, addedBack };
}
