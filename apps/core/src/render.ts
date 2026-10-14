import type { Finding, RepoSnapshot, Source } from "./types.js";
import type { Window } from "./time.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const link = (s: Source) =>
  `<a href="${esc(s.url).replace(/"/g, "&quot;")}">${esc(s.label)}</a>`;

const icon = { high: "🔴", medium: "🟡", low: "⚪", info: "•" } as const;
const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;

function line(f: Finding): string[] {
  const out = [`${icon[f.severity]} ${esc(f.summary)} [${f.sources.map(link).join(", ")}]`];
  for (const d of f.details ?? []) out.push(`   – ${esc(d)}`);
  return out;
}

export function render(findings: Finding[], snaps: RepoSnapshot[], w: Window, maxChars = 3800): string {
  // Stable sort: keeps the caller's order within a severity (e.g. oldest first from rules)
  const attention = findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const yesterday = findings.filter((f) => f.severity === "info");
  const failed = snaps.filter((s) => s.error);

  const parts: string[] = [`<b>Good morning. Here's ${esc(w.label)}.</b>`];

  if (!attention.length && !yesterday.length) {
    parts.push("", "Quiet day: no commits, PRs or issues in your tracked repos, and nothing needs attention.");
  } else {
    if (attention.length) parts.push("", "<b>Needs attention</b>", ...attention.flatMap(line));
    if (yesterday.length) parts.push("", "<b>Yesterday</b>", ...yesterday.flatMap(line));
  }

  if (failed.length) {
    parts.push("", `<i>Couldn't read: ${failed.map((s) => `${esc(s.repo)} (${esc(s.error!)})`).join(", ")}</i>`);
  }

  // Telegram's limit is 4096 characters; keep a margin and say what was cut
  let text = parts.join("\n");
  if (text.length > maxChars) {
    const kept: string[] = [];
    let len = 0;
    for (const p of parts) {
      if (len + p.length + 1 > maxChars - 40) break;
      kept.push(p);
      len += p.length + 1;
    }
    const cut = parts.length - kept.length;
    text = kept.join("\n") + `\n\n<i>+${cut} more line(s) not shown</i>`;
  }
  return text;
}