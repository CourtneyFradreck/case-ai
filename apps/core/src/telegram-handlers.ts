import type { TelegramCallbackQuery, TelegramMessage } from "./telegram-update.js";

// Stubs: focus buttons and text commands fill these in later.

// Returning answerText shows it as a small notice on the tapped button.
export async function onCallbackQuery(_query: TelegramCallbackQuery): Promise<{ answerText?: string } | void> {}

export async function onTextMessage(_message: TelegramMessage): Promise<void> {}
