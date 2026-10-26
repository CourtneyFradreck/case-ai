import { normalize } from "./parse.js";

export const RELINK_MIN = 0.85;

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 1 for identical strings, 0 for nothing in common.
export function similarity(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  return len ? 1 - levenshtein(a, b) / len : 1;
}

interface Text { id: string; text: string }

// The single best candidate at or above the threshold; a tie for best is ambiguous and gives none.
function best(from: Text, candidates: Text[], score: (a: Text, b: Text) => number, min: number): Text | undefined {
  let top: Text | undefined;
  let topScore = -1;
  let tied = false;
  for (const c of candidates) {
    const s = score(from, c);
    if (s > topScore) { top = c; topScore = s; tied = false; }
    else if (s === topScore) tied = true;
  }
  return top && !tied && topScore >= min ? top : undefined;
}

// Maps item IDs to the current item that took them over through an edit. IDs still present, or never re-linked, stay as they are.
export function followRelinks(ids: Iterable<string>, current: { id: string; previousIds: string[] }[]): Set<string> {
  const present = new Set(current.map((i) => i.id));
  const heir = new Map(current.flatMap((i) => i.previousIds.map((p) => [p, i.id] as const)));
  return new Set([...ids].map((id) => present.has(id) ? id : heir.get(id) ?? id));
}

// Pairs items that left NEXT.md with items that appeared, when an edit is the likely story:
// similar normalised text, and each is the other's only best match.
export function relink(gone: Text[], added: Text[], min = RELINK_MIN): { from: string; to: string }[] {
  const scores = new Map<string, number>();
  const score = (a: Text, b: Text) => {
    const key = `${a.id}|${b.id}`;
    if (!scores.has(key)) scores.set(key, similarity(normalize(a.text), normalize(b.text)));
    return scores.get(key)!;
  };
  return gone.flatMap((g) => {
    const a = best(g, added, score, min);
    if (!a || best(a, gone, (x, y) => score(y, x), min) !== g) return [];
    return [{ from: g.id, to: a.id }];
  });
}
