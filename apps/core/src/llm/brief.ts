import type { Finding, RepoSnapshot } from "../types.js";
import type { Window } from "../time.js";
import { DateTime } from "luxon";
import { renderModelBrief } from "../render.js";
import { buildInput, type InputConfig } from "./input.js";
import type { BriefModel } from "./provider.js";
import { briefJsonSchema, type AliasBrief, type ValidBrief } from "./schema.js";
import { validate, type DropReason } from "./validate.js";

export interface ModelBriefConfig extends InputConfig { modelTimeoutMs: number; maxBriefChars: number }
export interface BriefAudit {
  brief: AliasBrief | null;
  aliases: Record<string, string>;
  raw: string | null;
  responses?: string[];
  dropped: DropReason[];
  addedBack: string[];
  attempts: number;
  fallbackReason: string | null;
}
export interface BriefMeta { model: string | null; inputTokens?: number; outputTokens?: number; json: BriefAudit }
export type ModelBriefResult = BriefMeta & ({ text: string } | { fallbackReason: string });

export function fallbackMeta(model: string | null, reason: string): BriefMeta & { fallbackReason: string } {
  return { model, fallbackReason: reason, json: { brief: null, aliases: {}, raw: null, dropped: [], addedBack: [], attempts: 0, fallbackReason: reason } };
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
  const input = buildInput(findings, snaps, w.label, cfg);
  const meta: BriefMeta = { model: provider.name, json: { brief: null, aliases: Object.fromEntries([...input.aliasToFinding].map(([alias, f]) => [alias, f.id])), raw: null, responses: [], dropped: [], addedBack: [], attempts: 0, fallbackReason: null } };
  const complete = (result: Extract<ReturnType<typeof validate>, { ok: true }>) => {
    meta.json.dropped = result.dropped;
    meta.json.addedBack = result.addedBack;
    Object.assign(meta.json, serialize(result.brief, input.aliasToFinding, findings));
    return { ...meta, text: renderModelBrief(result.brief, snaps, w, cfg.maxBriefChars, { userName: cfg.userName, now }) };
  };
  if (!input.aliasToFinding.size) {
    const result = validate('{"yesterday":[],"attention":[],"focus":[]}', input.aliasToFinding, findings);
    if (result.ok) { meta.model = null; return complete(result); }
    return fallbackMeta(null, result.reason);
  }
  let fallbackReason = "model_error";
  for (let attempt = 1; attempt <= 2; attempt++) {
    meta.json.attempts = attempt;
    try {
      const response = await withTimeout(provider.generate(input.system, input.user, briefJsonSchema), cfg.modelTimeoutMs);
      meta.model = response.model;
      if (response.inputTokens !== undefined) meta.inputTokens = (meta.inputTokens ?? 0) + response.inputTokens;
      if (response.outputTokens !== undefined) meta.outputTokens = (meta.outputTokens ?? 0) + response.outputTokens;
      meta.json.raw = response.raw;
      meta.json.responses!.push(response.raw);
      const result = validate(response.raw, input.aliasToFinding, findings);
      if (result.ok) return complete(result);
      fallbackReason = result.reason;
    } catch (error) {
      fallbackReason = error instanceof ModelTimeoutError ? "model_timeout" : "provider_error";
    }
  }
  meta.json.brief = null;
  meta.json.fallbackReason = fallbackReason;
  return { ...meta, fallbackReason };
}
