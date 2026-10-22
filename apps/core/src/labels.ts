export const MAX_LABEL = 40;

// Cuts at a word boundary so the result, "…" included, is at most max characters.
export function clip(text: string, max = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// A NEXT.md item's main clause: dates in brackets and anything after a connecting word are dropped.
// "Merge M2 after M1 trial ends (Mon 19 Oct)" → "Merge M2".
const CONNECTOR = /\s+(?:after|before|once|when|until|unless|so that|so|then|and|with|for|by|via|because)\s+|\s*[;:,(–—]\s*/i;
export function itemLabel(text: string): string {
  const clause = text.replace(/\([^)]*\)/g, " ").split(CONNECTOR)[0].trim();
  return clip(clause || text);
}
