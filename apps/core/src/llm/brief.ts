import type { ActivityLog } from "../logs.js";
import type { Finding, RepoSnapshot } from "../types.js";
import type { Window } from "../time.js";
import { DateTime } from "luxon";
import { renderModelBrief, type NewRepo } from "../render.js";
import { buildInput, type InputConfig } from "./input.js";
import type { BriefModel } from "./provider.js";
import { briefJsonSchema, type AliasBrief, type ValidBrief, type ValidFocus } from "./schema.js";
import { validate, type DropReason, type Shortened } from "./validate.js";
import { withMissingNext, withPickedRepo } from "../focus.js";
import { selfReported, withPartlyNote } from "../self-reports.js";

// previousFocus is rendered at the top of the recap and never sent to the model.
// collapsed and days (features.streaks) are rendered in code; collapsed findings are never sent.
// done (likely finished NEXT.md items) and leftOpen (branches and PRs left open) are rendered in code and never sent.
// parked: findings behind a snoozed focus; the model's suggestions built only on them are dropped.
// missing: active repos with no NEXT.md; one takes the last suggestion, added in code and never sent.
// picked: the repo of yesterday's focus; one of its open NEXT.md items is added in code when the model left it out.
export interface ModelBriefConfig extends InputConfig {
  logs?: ActivityLog[];
  partly?: Set<string>;
  modelTimeoutMs: number; maxBriefChars: number; previousFocus?: Finding[];
  collapsed?: Finding[]; days?: Map<string, number>; done?: Finding[]; leftOpen?: Finding[]; parked?: Set<string>; missing?: Finding[];
  newRepos?: NewRepo[];
  picked?: { repo: string; findingId: string | null };
}
export interface BriefAudit {
  brief: AliasBrief | null;
  aliases: Record<string, string>;
  raw: string | null;
  responses?: string[];
  dropped: DropReason[];
  shortened?: Shortened[];   // overlong text and reasons cut to the schema limits
  addedBack: string[];
  attempts: number;
  fallbackReason: string | null;
  fallbackDetail?: string | null;
}
export interface BriefMeta { model: string | null; inputTokens?: number; outputTokens?: number; json: BriefAudit }
// focus is empty unless features.focusButtons (cfg.focus) is on.
export type ModelBriefResult = BriefMeta & ({ text: string; focus: ValidFocus[] } | { fallbackReason: string });

export function fallbackMeta(model: string | null, reason: string, detail = reason): BriefMeta & { fallbackReason: string } {
  return { model, fallbackReason: reason, json: { brief: null, aliases: {}, raw: null, dropped: [], addedBack: [], attempts: 0, fallbackReason: reason, fallbackDetail: detail.slice(0, 200) } };
}

class ModelTimeoutError extends Error {}
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ModelTimeoutError()), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function serialize(brief: ValidBrief, aliasToFinding: Map<string, Finding>, findings: Finding[]) {
  const byId = new Map([...aliasToFinding].map(([alias, f]) => [f.id, alias]));
  // Private findings get local audit aliases only; they were never sent to the model.
  for (const f of findings) if (!byId.has(f.id)) byId.set(f.id, `F${byId.size + 1}`);
  const items = <T extends { sources: Finding[] }>(list: T[]) => list.map((i) => ({ ...i, sources: i.sources.map((f) => byId.get(f.id)!) }));
  return {
    brief: { ...brief, yesterday: items(brief.yesterday), attention: items(brief.attention), focus: items(brief.focus),
      ...(brief.noteSources ? { noteSources: brief.noteSources.map((f) => byId.get(f.id)!) } : {}) },
    aliases: Object.fromEntries([...byId].map(([id, alias]) => [alias, id])),
  };
}

export async function generateModelBrief(findings: Finding[], snaps: RepoSnapshot[], w: Window, cfg: ModelBriefConfig, provider: BriefModel, now: DateTime = DateTime.now()): Promise<ModelBriefResult> {
  findings = findings.filter((f) => !selfReported(f));
  const input = buildInput(findings, snaps, w.label, cfg);
  const meta: BriefMeta = { model: provider.name, json: { brief: null, aliases: Object.fromEntries([...input.aliasToFinding].map(([alias, f]) => [alias, f.id])), raw: null, responses: [], dropped: [], addedBack: [], attempts: 0, fallbackReason: null, fallbackDetail: null } };
  const complete = (result: Extract<ReturnType<typeof validate>, { ok: true }>) => {
    meta.json.dropped = result.dropped;
    meta.json.shortened = result.shortened;
    meta.json.addedBack = result.addedBack;
    if (cfg.focus && cfg.picked) result.brief.focus = withPickedRepo(result.brief.focus, findings, cfg.picked.repo, cfg.picked.findingId);
    if (cfg.focus && cfg.missing?.length) result.brief.focus = withMissingNext(result.brief.focus, cfg.missing);
    result.brief.focus = withPartlyNote(result.brief.focus, cfg.partly);
    Object.assign(meta.json, serialize(result.brief, input.aliasToFinding, [...findings, ...(cfg.missing ?? [])]));
    return { ...meta, text: renderModelBrief(result.brief, snaps, w, cfg.maxBriefChars, { logs: cfg.logs, userName: cfg.userName, now, focus: cfg.focus, previousFocus: cfg.previousFocus, collapsed: cfg.collapsed, days: cfg.days, done: cfg.done, leftOpen: cfg.leftOpen, newRepos: cfg.newRepos }), focus: result.brief.focus };
  };
  if (!input.aliasToFinding.size) {
    const result = validate('{"yesterday":[],"attention":[],"focus":[]}', input.aliasToFinding, findings, cfg.focus, cfg.parked);
    if (result.ok) { meta.model = null; return complete(result); }
    return fallbackMeta(null, result.reason, result.detail);
  }
  let fallbackReason = "model_error";
  let fallbackDetail = "Model generation failed";
  for (let attempt = 1; attempt <= 2; attempt++) {
    meta.json.attempts = attempt;
    try {
      const response = await withTimeout(provider.generate(input.system, input.user, briefJsonSchema), cfg.modelTimeoutMs);
      meta.model = response.model;
      if (response.inputTokens !== undefined) meta.inputTokens = (meta.inputTokens ?? 0) + response.inputTokens;
      if (response.outputTokens !== undefined) meta.outputTokens = (meta.outputTokens ?? 0) + response.outputTokens;
      meta.json.raw = response.raw;
      meta.json.responses!.push(response.raw);
      const result = validate(response.raw, input.aliasToFinding, findings, cfg.focus, cfg.parked);
      if (result.ok) return complete(result);
      fallbackReason = result.reason;
      fallbackDetail = result.detail ?? result.reason;
    } catch (error) {
      fallbackReason = error instanceof ModelTimeoutError ? "model_timeout" : "provider_error";
      fallbackDetail = error instanceof ModelTimeoutError ? `Model timed out after ${cfg.modelTimeoutMs} ms`
        : error instanceof Error ? error.message : String(error);
    }
  }
  meta.json.brief = null;
  meta.json.fallbackReason = fallbackReason;
  meta.json.fallbackDetail = fallbackDetail.slice(0, 200);
  return { ...meta, fallbackReason };
}
