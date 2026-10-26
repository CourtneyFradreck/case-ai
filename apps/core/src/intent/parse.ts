import { fid } from "../id.js";
import type { NextItem } from "../types.js";

const HEADING = /^\s*#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const FENCE = /^\s*```/;
const MAX_TEXT = 200;
// "- [ ] after: Switch to CASE_BRIEF_MODE=all" waits for the open item above it. The marker is not part of the text or ID.
const AFTER = /^after:\s*/i;

// Wording changes give a new ID; case, spacing and trailing punctuation don't.
export const normalize = (text: string) =>
  text.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();

export function parseNext(repo: string, md: string): NextItem[] {
  const items: NextItem[] = [];
  const seen = new Set<string>();
  let section: string | null = null;
  let fenced = false;
  md.split(/\r?\n/).forEach((line, i) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const heading = HEADING.exec(line);
    if (heading) { section = heading[1] || null; return; }
    const item = ITEM.exec(line);
    if (!item) return;
    const after = AFTER.test(item[2]);
    const text = item[2].replace(AFTER, "");
    const key = normalize(text);
    if (!key) return;
    // The section is not part of the ID, so moving an item between sections keeps it.
    const id = fid("next", repo, key);
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, text: text.trim().slice(0, MAX_TEXT), section, state: item[1] === " " ? "open" : "done", line: i + 1, ...(after ? { after } : {}) });
  });
  return items;
}
