import { DateTime } from "luxon";
import { fid } from "./id.js";
import { today, ZONE } from "./time.js";
import type { ActivityLog } from "./logs.js";
import type { Finding } from "./types.js";
import type { ValidFocus } from "./llm/schema.js";

export const selfReported = (finding: Finding) => finding.rule === "self_log" || finding.rule === "self_checkin";

export function logFindings(logs: ActivityLog[]): Finding[] {
  return logs.map((log) => ({ id: fid("log", String(log.id)), rule: "self_log", severity: "info",
    repo: log.tag ?? "", summary: log.text, sources: [{ label: "you", kind: "self_reported" }] }));
}

export function partlyForNextBrief(focus: { finding_id: string | null; checkin?: string | null } | undefined,
  date: string, now: DateTime, previousBrief?: Date): Set<string> {
  const yesterday = today(now.minus({ days: 1 }));
  const alreadyBriefed = previousBrief && previousBrief >= now.setZone(ZONE).startOf("day").toJSDate();
  return focus?.checkin === "partly" && focus.finding_id && date === yesterday && !alreadyBriefed
    ? new Set([focus.finding_id]) : new Set();
}

export function withPartlyNote(focus: ValidFocus[], partly: Set<string> = new Set()): ValidFocus[] {
  return focus.map((item) => item.sources.some((f) => partly.has(f.id))
    ? { ...item, text: `${item.text} (partly done yesterday)` } : item);
}
