import { DateTime } from "luxon";
import { env } from "./env.js";
import { features } from "./features.js";
import { ZONE } from "./time.js";
import { esc } from "./render.js";
import { editMessageReplyMarkup, sendMessage } from "./telegram.js";
import { chosenKeyboard, cleanFocusText, nextItemsText, parseCommand, parseFocusCallback } from "./focus.js";
import { getBriefFocus, getFocus, insertFocus, openNextItems, setPendingFocus, takePendingFocus } from "./store.js";
import type { TelegramCallbackQuery, TelegramMessage } from "./telegram-update.js";

// Everything here is behind features.focusButtons; with it off, updates are routed and ignored as before.

const today = (now: DateTime) => now.setZone(ZONE).toISODate()!;
const midnight = (now: DateTime) => now.setZone(ZONE).startOf("day").plus({ days: 1 }).toJSDate();
// answerCallbackQuery text is limited to 200 characters.
const notice = (text: string) => text.length > 200 ? `${text.slice(0, 199)}…` : text;

// Returning answerText shows it as a small notice on the tapped button.
export async function onCallbackQuery(query: TelegramCallbackQuery, now: DateTime = DateTime.now()): Promise<{ answerText?: string } | void> {
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
  await insertFocus({ date: today(now), text: item.text, findingId: item.findingId, repo: item.repo, via: "button", briefId: callback.briefId });
  // A tap after "Something else" means the typed reply is no longer wanted.
  if (query.message) await takePendingFocus(String(query.message.chat.id));
  const messageId = query.message?.message_id ?? (brief.telegram_message_id === null ? undefined : Number(brief.telegram_message_id));
  if (messageId !== undefined) {
    // The focus is stored; a failed edit only leaves the old buttons in place.
    await editMessageReplyMarkup(messageId, chosenKeyboard(callback.briefId, item.text)).catch((e) => console.error("editMessageReplyMarkup failed", e));
  }
  return { answerText: notice(`Focus set: ${item.text}`) };
}

export async function onTextMessage(message: TelegramMessage, now: DateTime = DateTime.now()): Promise<void> {
  if (!features.focusButtons || typeof message.text !== "string") return;
  const chatId = String(message.chat.id);
  const command = parseCommand(message.text);
  if (command?.name === "focus") {
    const text = cleanFocusText(command.arg);
    if (!text) {
      const current = await getFocus(today(now));
      await sendMessage(current ? `Today's focus: ${esc(current.item_text)}` : "No focus set for today. Send /focus followed by what you'll work on.");
      return;
    }
    await insertFocus({ date: today(now), text, findingId: null, repo: null, via: "command", briefId: null });
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
  await insertFocus({ date: today(now), text, findingId: null, repo: null, via: "text", briefId: pending.briefId });
  await sendMessage(`Focus for today: ${esc(text)}`);
}
