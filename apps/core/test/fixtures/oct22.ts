import type { RepoSnapshot } from "../../src/types.js";
import { parseNext } from "../../src/intent/parse.js";

// The inputs to the 22 Oct 2026 brief, which said "No commits in case-ai since" above "36 commits on
// feat/m3-intent", suggested the M2 merge two days after PR #3 merged, repeated the taga branch finding
// in its first suggestion, and showed the old attachcv and crc-app branches again.
export const OCT22_NOW = new Date("2026-10-22T05:00:00Z"); // Thu 07:00 Harare
const owner = "CourtneyFradreck";
const gh = (repo: string) => `https://github.com/${owner}/${repo}`;

// Yesterday's 36 commits on feat/m3-intent, oldest first, with their real subjects and times.
const m3 = [
  ["cbdc605", "2026-10-21T10:43:04+02:00", "feat: add feature flags to config with a typed reader"],
  ["58eae64", "2026-10-21T10:43:31+02:00", "feat: add core schema with focus table"],
  ["4060c91", "2026-10-21T10:44:31+02:00", "feat: persist NEXT.md items in next_items each run"],
  ["afa6341", "2026-10-21T10:46:34+02:00", "feat: re-link edited NEXT.md items to their previous history"],
  ["e788d50", "2026-10-21T10:49:42+02:00", "feat: feed NEXT.md history to next_done and report next_missing once"],
  ["10fc054", "2026-10-21T10:50:23+02:00", "feat: store the rule-only brief as a baseline on every run"],
  ["e69c21d", "2026-10-21T10:50:45+02:00", "docs: tick M3 groundwork and describe re-linking of edited NEXT.md items"],
  ["2069f03", "2026-10-21T11:43:42+02:00", "feat: add nightly encrypted Postgres backup container"],
  ["9636657", "2026-10-21T11:47:01+02:00", "feat: configure the R2 backup remote through environment variables"],
  ["d645aa0", "2026-10-21T11:49:44+02:00", "docs: add backup restore guide"],
  ["72badf5", "2026-10-21T11:51:32+02:00", "feat: alert a webhook when a backup run fails"],
  ["3b7e976", "2026-10-21T11:57:24+02:00", "feat: add a Telegram Bot API client to case-core"],
  ["cfd3e21", "2026-10-21T11:59:39+02:00", "feat: let case-core deliver the brief with CASE_DELIVERY=core"],
  ["43e6c66", "2026-10-21T12:01:13+02:00", "feat: add POST /telegram/update for forwarded Telegram updates"],
  ["5e63778", "2026-10-21T12:19:00+02:00", "feat: route Telegram updates through case-core in the n8n workflows"],
  ["2fe7549", "2026-10-21T12:19:29+02:00", "docs: describe case-core Telegram delivery and update forwarding"],
  ["e89898d", "2026-10-21T12:29:58+02:00", "feat: send open NEXT.md items to the model as focus citations"],
  ["3f67e20", "2026-10-21T12:31:08+02:00", "feat: ask the model for 2-3 sourced focus suggestions"],
  ["189eee7", "2026-10-21T12:32:00+02:00", "feat: pick rule-only focus suggestions in code"],
  ["bc31390", "2026-10-21T12:35:22+02:00", "feat: render focus suggestions with buttons when core delivers"],
  ["2a07a4b", "2026-10-21T12:37:46+02:00", "feat: handle focus taps, typed focus, /focus and /next"],
  ["69687d0", "2026-10-21T12:39:26+02:00", "feat: open the recap with yesterday's focus"],
  ["5387fb2", "2026-10-21T12:40:04+02:00", "docs: describe focus suggestions, buttons and commands"],
  ["5eae0f4", "2026-10-21T12:43:29+02:00", "feat: count finding streaks across scheduled runs"],
  ["f47d770", "2026-10-21T12:46:42+02:00", "feat: collapse findings repeated across scheduled briefs"],
  ["d2bd200", "2026-10-21T12:49:20+02:00", "feat: snooze medium and low findings from Telegram"],
  ["c961c4c", "2026-10-21T12:51:27+02:00", "feat: send a short message on quiet mornings"],
  ["cc0ffd3", "2026-10-21T12:51:58+02:00", "docs: describe streaks, snooze and quiet mornings, and how to turn each on"],
  ["4376f82", "2026-10-21T13:29:20+02:00", "feat: update .env.example with new Telegram and backup configurations"],
  ["f79dd4d", "2026-10-21T13:31:07+02:00", "fix: shorten overlong model text instead of failing the brief"],
  ["933a69f", "2026-10-21T13:31:40+02:00", "fix: answer commands whose feature is switched off"],
  ["b0ec0f5", "2026-10-21T13:38:17+02:00", "fix: order model attention items by severity"],
  ["366124b", "2026-10-21T13:39:26+02:00", "fix: stop Telegram auto-linking .md filenames"],
  ["11f8492", "2026-10-21T13:40:19+02:00", "fix: say \"Here's your brief\" from noon local time"],
  ["6a4b792", "2026-10-21T18:58:03+02:00", "test: stop flag-off tests depending on the shipped config"],
  ["cdb2a3e", "2026-10-21T18:58:03+02:00", "feat: turn on focus buttons"],
] as const;

const nextMd = [
  "## M2 rollout", "",
  "- [ ] Merge M2 after M1 trial ends (Mon 19 Oct)",
  "- [ ] Run CASE_BRIEF_MODE=command for 3 days; check logged dropped / fallbackReason",
  "- [ ] Switch to CASE_BRIEF_MODE=all", "",
  "## M3 Intent", "",
  "- [ ] Parse NEXT.md in each tracked repo (open \"- [ ]\" items, section headings)",
  "- [ ] NEXT.md items become findings with stable IDs the validator can cite",
  "- [ ] Model fills \"focus\" with 2-3 suggestions, each with a sourced reason",
  "- [ ] Telegram focus buttons; store the chosen focus per day",
].join("\n");

const pr = (number: number, title: string, headRef: string, mergedAt: string) =>
  ({ number, title, url: `${gh("case-ai")}/pull/${number}`, draft: false, headRef, updatedAt: mergedAt, mergedAt });
const m2 = pr(3, "feat: M2 model brief with validated citations", "feat/m2-model-brief", "2026-10-20T08:15:31Z");
const m1 = pr(2, "feat: GitHub morning brief pipeline and activity rules", "feat/m1-ruleonly-brief", "2026-10-15T11:28:31Z");
const branch = (repo: string, name: string, lastCommitAt: string, aheadBy: number) =>
  ({ name, sha: `${name}-head`, lastCommitAt, aheadBy, url: `${gh(repo)}/tree/${name}` });
const empty = (repo: string): RepoSnapshot => ({
  repo: `${owner}/${repo}`, private: false, defaultBranch: "main", createdAt: "2025-06-01T00:00:00Z",
  commits: [], openPrs: [], openedPrs: [], mergedPrs: [], recentlyMerged: [], newIssues: [], closedIssues: [], comments: [],
  openIssueCount: 0, branches: [], ciRuns: [], next: { status: "missing" },
});

export const oct22Snapshots = (): RepoSnapshot[] => [
  {
    ...empty("case-ai"),
    commits: m3.map(([sha, date, message], i) => ({
      sha, message, date: new Date(date).toISOString(), branch: "feat/m3-intent", author: owner,
      url: `${gh("case-ai")}/commit/${sha}`, parentSha: i ? m3[i - 1][0] : "53e6cff",
    })),
    mergedPrs: [m2], recentlyMerged: [m2, m1],
    branches: [
      branch("case-ai", "main", "2026-10-20T08:15:31Z", 0),
      branch("case-ai", "feat/m3-intent", "2026-10-21T16:58:03Z", 46),
      branch("case-ai", "feat/m2-model-brief", "2026-10-20T08:10:00Z", 0),
      branch("case-ai", "feat/m1-ruleonly-brief", "2026-10-15T11:20:00Z", 0),
    ],
    next: { status: "ok", sha: "n22", url: `${gh("case-ai")}/blob/main/NEXT.md`, lastChangedAt: "2026-10-20T08:15:31Z", items: parseNext(`${owner}/case-ai`, nextMd) },
  },
  {
    ...empty("taga-technologies"),
    branches: [
      branch("taga-technologies", "main", "2026-10-09T12:00:00Z", 0),
      branch("taga-technologies", "feat/update-product-section", "2026-10-14T05:00:00Z", 2),
    ],
  },
  { ...empty("attachcv"), branches: [branch("attachcv", "main", "2026-06-02T10:00:00Z", 0), branch("attachcv", "feat/cover-letters", "2026-06-01T10:00:00Z", 4)] },
  { ...empty("crc-app"), branches: [branch("crc-app", "main", "2026-07-20T10:00:00Z", 0), branch("crc-app", "redesign", "2026-07-18T10:00:00Z", 7)] },
];

// Yesterday's focus, picked from the 19:00 /brief after the day's commits, before short labels existed.
export const OCT22_FOCUS = {
  item_text: "Merge M2 after M1 trial ends (Mon 19 Oct)", short_label: null, repo: `${owner}/case-ai`,
  finding_id: `next_${parseNext(`${owner}/case-ai`, nextMd)[0].id}`, created_at: new Date("2026-10-21T17:05:00Z"), status: "active" as const,
};
export const OCT22_PREVIOUS_BRIEF_AT = new Date("2026-10-21T17:00:00Z");
