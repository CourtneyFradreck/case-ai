import { z } from "zod";
import type { Finding } from "../types.js";

export const TEXT_MAX = 200;
export const REASON_MAX = 160;

// The model is asked for the limits (strict), but the validator accepts longer text and reasons and shortens them.
function briefSchema(strict: boolean) {
  const limited = (max: number) => strict ? z.string().min(1).max(max) : z.string().min(1);
  const Item = z.object({ text: limited(TEXT_MAX), sources: z.array(z.string()).min(1).max(5) });
  const Focus = Item.extend({ reason: limited(REASON_MAX) });
  return z.object({
    yesterday: z.array(Item).max(8),
    attention: z.array(Item).max(8),
    focus: z.array(Focus).max(3),
    note: z.string().max(160).optional(),
    noteSources: z.array(z.string()).min(1).max(5).optional(),
  });
}

export const BriefJson = briefSchema(false);
export const briefJsonSchema = z.toJSONSchema(briefSchema(true));
delete briefJsonSchema.$schema;
export type AliasBrief = z.infer<typeof BriefJson>;
export interface ValidItem { text: string; sources: Finding[] }
export interface ValidFocus extends ValidItem { reason: string }
export interface ValidBrief { yesterday: ValidItem[]; attention: ValidItem[]; focus: ValidFocus[]; note?: string; noteSources?: Finding[] }
