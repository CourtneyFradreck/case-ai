import { z } from "zod";
import type { Finding } from "../types.js";

const Item = z.object({ text: z.string().min(1).max(200), sources: z.array(z.string()).min(1).max(5) });
const Focus = Item.extend({ reason: z.string().min(1).max(160) });
export const BriefJson = z.object({
  yesterday: z.array(Item).max(8),
  attention: z.array(Item).max(8),
  focus: z.array(Focus).max(3),
  note: z.string().max(160).optional(),
});

export const briefJsonSchema = z.toJSONSchema(BriefJson);
delete briefJsonSchema.$schema;
export type AliasBrief = z.infer<typeof BriefJson>;
export interface ValidItem { text: string; sources: Finding[] }
export interface ValidFocus extends ValidItem { reason: string }
export interface ValidBrief { yesterday: ValidItem[]; attention: ValidItem[]; focus: ValidFocus[]; note?: string }
