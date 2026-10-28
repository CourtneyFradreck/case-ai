import { DateTime } from "luxon";
import { pool } from "./db.js";
import { env } from "./env.js";
import { features } from "./features.js";
import { today, midnight } from "./time.js";
import { esc } from "./render.js";
import { sendMessage, editMessageText } from "./telegram.js";
import type { TelegramCallbackQuery } from "./telegram-update.js";
import type { FocusRow } from "./store.js";
import { logText } from "./logs.js";

export type CheckinAnswer = "done" | "partly" | "none";
export const checkinAnswer = { done: "done", partly: "partly done", none: "didn't get to it" };

export async function completedFocusIds(): Promise<Set<string>> {
  const { rows } = await pool.query<{ finding_id: string }>(
    "SELECT DISTINCT finding_id FROM core.focus WHERE COALESCE(checkin, status) = 'done' AND finding_id IS NOT NULL");
  return new Set(rows.map((row) => row.finding_id));
}
export function parseCheckinCallback(data?: string) {
  const m = /^c:(\d{1,15}):(done|partly|none)$/.exec(data ?? "");
  return m ? { focusId: m[1], answer: m[2] as CheckinAnswer } : undefined;
}

async function setPending(chatId: string, now: DateTime) {
  await pool.query(`INSERT INTO core.checkin_pending(chat_id, expires_at) VALUES ($1,$2)
    ON CONFLICT (chat_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [chatId, midnight(now)]);
}

export async function runCheckin(now = DateTime.now()) {
  if (!features.eveningCheckIn) return { sent: false, reason: "off" };
  const { rows } = await pool.query<FocusRow & { id: string }>(
    "SELECT id, item_text, short_label FROM core.focus WHERE date=$1 AND status IN ('active','done') ORDER BY created_at DESC, id DESC LIMIT 1", [today(now)]);
  const focus = rows[0];
  if (focus) await sendMessage(`How did ${esc(focus.short_label || focus.item_text)} go?`, { inline_keyboard: [[
    ...([['Done', 'done'], ['Partly', 'partly'], ["Didn't touch it", 'none']] as const)
      .map(([text, answer]) => ({ text, callback_data: `c:${focus.id}:${answer}` })),
  ]] });
  else await sendMessage("Anything worth logging from today? Just reply.");
  await setPending(env.telegramChatId!, now);
  return { sent: true };
}

export async function onCheckinCallback(query: TelegramCallbackQuery, now: DateTime) {
  if (!features.eveningCheckIn) return;
  const cb = parseCheckinCallback(query.data);
  if (!cb || !query.message) return;
  const { rows } = await pool.query<FocusRow>(`UPDATE core.focus SET checkin=$2, checkin_at=$3,
    status=CASE WHEN $2='done' THEN 'done' WHEN status='done' THEN 'active' ELSE status END
    WHERE id=$1 AND date=$4 AND status IN ('active','done') RETURNING item_text, short_label`,
    [cb.focusId, cb.answer, now.toJSDate(), today(now)]);
  if (!rows[0]) return { answerText: "That check-in has expired." };
  await setPending(String(query.message.chat.id), now);
  await editMessageText(query.message.message_id,
    `${esc(rows[0].short_label || rows[0].item_text)}: ${checkinAnswer[cb.answer]}.\n\nAnything else from today? Just reply.`)
    .catch((e) => console.error("editMessageText failed", e));
  return { answerText: "Recorded" };
}

export async function onCheckinText(chatId: string, text: string, now: DateTime) {
  if (!features.eveningCheckIn) return;
  const { rows } = await pool.query("SELECT chat_id FROM core.checkin_pending WHERE chat_id=$1 AND expires_at > $2", [chatId, now.toJSDate()]);
  if (rows.length) await logText(text, "checkin", now);
}
