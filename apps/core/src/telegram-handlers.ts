import { DateTime } from "luxon";
import { env } from "./env.js";
import { features, type Feature } from "./features.js";
import { ZONE } from "./time.js";
import { esc } from "./render.js";
import { editMessageReplyMarkup, editMessageText, sendMessage } from "./telegram.js";
import { chosenKeyboard, cleanFocusText, nextItemsText, parseCommand, parseFocusCallback, storedLabel } from "./focus.js";
import { clip } from "./labels.js";
import type { FocusRow } from "./store.js";
import { parseSnoozeCallback, snoozedText, snoozeList, snoozeUntil, untilText } from "./snooze.js";
import {
  deleteSnooze, getBriefFocus, getBriefSnoozable, getFocus, insertFocus, listSnoozes, openNextItems, setPendingFocus,
  takePendingFocus, upsertSnooze,
} from "./store.js";
import type { TelegramCallbackQuery, TelegramMessage } from "./telegram-update.js";

// Focus taps and commands are behind features.focusButtons, snooze taps and commands behind features.snooze.
// With a flag off, its taps and plain text are ignored, and its commands reply that they're off.

const COMMAND_FLAGS = { focus: "focusButtons", next: "focusButtons", snoozed: "snooze", unsnooze: "snooze" } as const satisfies Record<string, Feature>;

const today = (now: DateTime) => now.setZone(ZONE).toISODate()!;
const midnight = (now: DateTime) => now.setZone(ZONE).startOf("day").plus({ days: 1 }).toJSDate();
// answerCallbackQuery text is limited to 200 characters.
const notice = (text: string) => text.length > 200 ? `${text.slice(0, 199)}…` : text;

// "Today's focus: <label>", with the full text on a second line when the label shortens it.
const focusText = (row: FocusRow) => {
  const label = row.short_label || row.item_text;
  return `Today's focus: <b>${esc(label)}</b>${label !== row.item_text ? `\n${esc(row.item_text)}` : ""}`;
};

// Returning answerText shows it as a small notice on the tapped button.
export async function onCallbackQuery(query: TelegramCallbackQuery, now: DateTime = DateTime.now()): Promise<{ answerText?: string } | void> {
  if (query.data?.startsWith("s:")) return features.snooze ? onSnoozeCallback(query, now) : undefined;
  if (!features.focusButtons) return;
  const callback = parseFocusCallback(query.data);
  if (!callback) return;
  const brief = await getBriefFocus(callback.briefId);
  if (!brief?.focus?.length) return { answerText: "That brief has no suggestions." };
  if (today(DateTime.fromJSDate(brief.created_at)) !== today(now)) return { answerText: "That brief is from an earlier day. Use /focus to set today's focus." };

  if (callback.choice === "chosen") {
    const current = await getFocus(today(now));
    return current ? { answerText: notice(`Focus: ${current.item_text}`) } : undefined;
  }
  if (callback.choice === "other") {
    await setPendingFocus(String(query.message?.chat.id ?? env.telegramChatId), callback.briefId, midnight(now));
    await sendMessage("What's your focus today? Reply with a short message.");
    return;
  }
  const item = brief.focus[callback.choice - 1];
  if (!item) return { answerText: "That suggestion isn't on this brief." };
  const label = storedLabel(item);
  await insertFocus({ date: today(now), text: item.text, label, findingId: item.findingId, repo: item.repo, via: "button", briefId: callback.briefId });
  // A tap after "Something else" means the typed reply is no longer wanted.
  if (query.message) await takePendingFocus(String(query.message.chat.id));
  const messageId = query.message?.message_id ?? (brief.telegram_message_id === null ? undefined : Number(brief.telegram_message_id));
  if (messageId !== undefined) {
    // The focus is stored; a failed edit only leaves the old buttons in place.
    await editMessageReplyMarkup(messageId, chosenKeyboard(callback.briefId, label)).catch((e) => console.error("editMessageReplyMarkup failed", e));
  }
  return { answerText: notice(`Focus set: ${item.text}`) };
}

async function onSnoozeCallback(query: TelegramCallbackQuery, now: DateTime): Promise<{ answerText?: string } | void> {
  const callback = parseSnoozeCallback(query.data);
  if (!callback) return;
  const items = await getBriefSnoozable(callback.briefId);
  if (!items?.length) return { answerText: "That brief has nothing to snooze." };
  if (!("item" in callback)) {
    const { text, markup } = snoozeList(callback.briefId, items);
    await sendMessage(text, markup);
    return;
  }
  const item = items[callback.item - 1];
  if (!item) return { answerText: "That item isn't on this list." };
  const until = snoozeUntil(now, callback.days);
  await upsertSnooze(item.findingId, item.repo, until);
  if (query.message) {
    // The snooze is stored; a failed edit only leaves the list in place.
    await editMessageText(query.message.message_id, `Snoozed until ${untilText(until)}: ${esc(item.text)}`)
      .catch((e) => console.error("editMessageText failed", e));
  }
  return { answerText: `Snoozed until ${untilText(until)}` };
}

async function onSnoozeCommand(command: { name: string; arg: string }, now: DateTime) {
  const rows = await listSnoozes(now.toJSDate());
  if (command.name === "snoozed") {
    await sendMessage(snoozedText(rows));
    return;
  }
  const row = /^\d+$/.test(command.arg) ? rows[Number(command.arg) - 1] : undefined;
  if (!row) {
    await sendMessage("No snooze with that number. Send /snoozed to see them.");
    return;
  }
  await deleteSnooze(row.finding_id);
  await sendMessage(`Back on the brief: ${esc(row.summary ?? row.finding_id)}`);
}

export async function onTextMessage(message: TelegramMessage, now: DateTime = DateTime.now()): Promise<void> {
  if (typeof message.text !== "string") return;
  const command = parseCommand(message.text);
  const flag = command && Object.hasOwn(COMMAND_FLAGS, command.name) ? COMMAND_FLAGS[command.name as keyof typeof COMMAND_FLAGS] : undefined;
  if (flag && !features[flag]) {
    await sendMessage(`/${command!.name} isn't switched on yet. Turn on features.${flag} in config.json.`);
    return;
  }
  if (command?.name === "snoozed" || command?.name === "unsnooze") {
    await onSnoozeCommand(command, now);
    return;
  }
  if (!features.focusButtons) return;
  const chatId = String(message.chat.id);
  if (command?.name === "focus") {
    const text = cleanFocusText(command.arg);
    if (!text) {
      const current = await getFocus(today(now));
      await sendMessage(current ? focusText(current) : "No focus set for today. Send /focus followed by what you'll work on.");
      return;
    }
    await insertFocus({ date: today(now), text, label: clip(text), findingId: null, repo: null, via: "command", briefId: null });
    await takePendingFocus(chatId);
    await sendMessage(`Focus for today: ${esc(text)}`);
    return;
  }
  if (command?.name === "next") {
    await sendMessage(nextItemsText(await openNextItems(), env.repos, command.arg || undefined));
    return;
  }
  // Other commands, such as /brief, are n8n's, and leave a pending focus waiting.
  if (command || message.text.trim().startsWith("/")) return;
  const text = cleanFocusText(message.text);
  if (!text) return;
  const pending = await takePendingFocus(chatId, now.toJSDate());
  if (!pending) return;
  await insertFocus({ date: today(now), text, label: clip(text), findingId: null, repo: null, via: "text", briefId: pending.briefId });
  await sendMessage(`Focus for today: ${esc(text)}`);
}
