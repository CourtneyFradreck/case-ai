-- Telegram message_id of the brief when case-core sent it itself, so its buttons can be edited later.
ALTER TABLE briefs ADD COLUMN telegram_message_id BIGINT;
