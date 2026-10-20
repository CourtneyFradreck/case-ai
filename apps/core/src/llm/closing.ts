import type { Finding } from "../types.js";

// Closing lines need the same source discipline as the rest of the model brief.
export function closingLine(note?: string, sources: Finding[] = []): string | undefined {
  if (!note?.trim() || !sources.length || note.length > 160 || /[!\r\n]/.test(note)) return;
  if (/(?:have a (?:productive|great|good|nice|wonderful) day|keep (?:it up|up the (?:good|great) work)|happy coding|you(?:'ve| have) got this|great (?:job|work)|good luck|well done)/i.test(note)) return;
  return note.trim();
}
