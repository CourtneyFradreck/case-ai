# CASE — Cognitive Assistant for Scheduling and Execution

> C.A.S.E inspired by one of the AI systems from Interstellar

**A daily Telegram brief that tells me where I left off.**

Every morning at 7am, CASE looks at my GitHub activity, the `NEXT.md` file in each repo and the notes I've logged, then sends me a short brief: what needs my attention, followed by what I worked on most recently. The recap uses the last active day within the past week, or both weekend days on Monday. It sums up each branch's commits by their themes rather than pasting subjects ("36 commits on feat/m3-intent (46 on the branch so far), covering focus, Telegram and backup"); the count is the recap period's, and "so far" is the branch's total unmerged commits. Dates follow Africa/Harare time. Every line links back to the commit, issue, PR or note it came from.

CASE is the first module of **ALFRED**, a personal AI assistant I'm building one piece at a time.

> **Status:** M2 and M3 done; M4 (`/log` and evening check-in) deployed through migration 014. Check-in hardening in migration 015 is ready for rollout.

---

## Why

I work across several projects at once. Commits record what changed, but not where I was heading. Coming back to a project after a day, a week or a few months means rebuilding that context from memory. CASE keeps the direction alive.

## What it does (v1 goals)

- Summarises the most recent active day's commits, issues and PRs across my personal repos
- Lists unfinished work: open PRs, unmerged branches, failing CI, open `NEXT.md` items
- **M3:** Suggests two or three things to focus on today, each with a reason
- Lets me reply to pick a focus, or log non-code work with `/log`
- Links every statement to its source, and drops anything it can't source

## What it doesn't do

- Write to repos. CASE is read-only.
- Support teams, Jira, Linear or GitLab.
- Score productivity.

## How it works

```
GitHub API ─┐
NEXT.md ────┼─> case-core: collect -> rule checks -> write brief -> validate -> Telegram
Telegram ───┘                              │
                                     Gemini API

n8n: 7am schedule ──> POST /brief
     Telegram webhook ──> POST /telegram/update (every update) ──> POST /brief (owner's /brief only)
```

- **n8n** only triggers runs and forwards Telegram updates. Its 7am schedule calls `POST /brief`. Every Telegram message and button tap is forwarded to `POST /telegram/update`, and core answers with `owner: true` only for the chat in `TELEGRAM_CHAT_ID`. n8n runs `/brief` only for those.
- **Delivery:** with `CASE_DELIVERY=core`, case-core sends the brief itself through the Telegram Bot API, so it can attach buttons and later edit them; the message ID is stored on the brief. `/brief` then returns `delivered: true` and n8n sends nothing. With `CASE_DELIVERY=n8n` (the default), or if core's send fails, `/brief` returns `delivered: false` and n8n's Telegram node sends the text.
- **case-core** holds all the logic, so it can be tested. It ignores and logs updates from any other chat, and always answers button taps so they stop spinning.
- **Rules decide the facts.** The model only phrases and prioritises what the rules found.
- **The model never writes links.** It cites finding IDs, and code turns those into real links. Claims without a valid source are dropped.
- If the model fails, a plain rule-based brief is sent instead.
- **Feature flags** live under `features` in `apps/core/config.json`: `focusButtons`, `streaks`, `snooze`, `quietMornings` and `eveningCheckIn`. A flag that is missing counts as `false`; only an explicit `true` turns one on. The shipped `config.json` sets `focusButtons`, `streaks` and `snooze` to `true` and `quietMornings` and `eveningCheckIn` to `false`. To change one, edit it, commit and redeploy (config is read at startup). With every flag off, none of these features appear; the recap's commit themes and the weekly old-branches line (below) don't depend on a flag. See [Focus](#focus) and [Less repetition](#less-repetition).

## Stack

| Part          | Choice                            |
| ------------- | --------------------------------- |
| Service       | Node 22, TypeScript, Hono         |
| Orchestration | n8n                               |
| Database      | PostgreSQL 16                     |
| Model         | Gemini Flash-Lite (configurable via `GEMINI_MODEL`) |
| Interface     | Telegram bot                      |
| Deployment    | Docker Compose on Dokploy         |

## Repo structure

```
case-ai/
├── apps/core/          # case-core service
├── infra/              # database init scripts, backup container
├── n8n/workflows/      # exported n8n workflows (no secrets)
├── docker-compose.yml
├── .env.example
└── NEXT.md             # what's next for CASE itself
```

## Running it yourself

You'll need Docker, a server with a public HTTPS domain (Telegram webhooks require one) and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/courtneyfradreck/case-ai.git
cd case-ai
cp .env.example .env    # fill in the values
docker compose up --build
```

Then open n8n at your domain and add two credentials: a Telegram credential with your bot token, and a Header Auth credential named `x-case-key` whose value is `CASE_API_KEY`. Import the workflows from `n8n/workflows/`: `errors.json` first, then `morning-brief.json` and `brief-command.json`. In `errors.json` and `morning-brief.json`, set the Telegram node's chat ID to your own. Link the credentials and activate all three.

### Environment variables

| Variable             | Purpose                                 |
| -------------------- | --------------------------------------- |
| `POSTGRES_PASSWORD`  | Database password                       |
| `CASE_API_KEY`       | Shared secret between n8n and case-core |
| `N8N_ENCRYPTION_KEY` | Encrypts n8n credentials. Back it up.   |
| `N8N_HOST`           | Public domain for n8n                   |
| `GITHUB_TOKEN`       | Read-only fine-grained GitHub token with access to **All repositories** and the **Contents** and **Metadata** permissions, so CASE can discover your repos |
| `CASE_REPOS`         | Optional. Comma-separated `owner/repo` names that are always read, even when quiet or not yours (e.g. repos you collaborate on). Leave it empty to rely on discovery alone. Spaces and quotes around entries are ignored; an entry that isn't `owner/repo` is skipped with a startup warning. |
| `CASE_REPO_EXCLUDE`  | Optional. Comma-separated globs for owned repos never read, matched against `owner/repo` and the bare repo name, e.g. `sandbox-*,me/old-site`. Empty by default. |
| `CASE_REPO_ACTIVE_DAYS` | Discovered repos are read only if pushed to within this many days. Defaults to `14`; an invalid value uses `14` with a startup warning. |
| `CASE_BRANCH_EXCLUDE` | Comma-separated branch globs never read, e.g. asset branches with no common history with the default branch. `*` matches within one path segment, `**` across segments. Defaults to `pr-assets/*`; set it empty to read every branch. |
| `CASE_BRIEF_MODE`    | `rules` (default): template briefs; `command`: model for manual `/brief` requests only; `all`: model for scheduled and manual briefs. Missing or invalid values use `rules`. |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather, used when case-core sends messages itself |
| `TELEGRAM_CHAT_ID`   | Your Telegram chat ID. The only chat case-core accepts updates from; the `/brief` command does nothing until it is set. |
| `CASE_DELIVERY`      | `n8n` (default): n8n sends the brief; `core`: case-core sends it and `/brief` returns `delivered: true`. `core` without both Telegram values, or any invalid value, uses `n8n`. |
| `GEMINI_API_KEY`     | Required for model briefs. A missing key uses `rules`; an invalid key or failed model request sends a rule-only fallback. |
| `GEMINI_MODEL`       | Model ID; defaults to `gemini-3.5-flash-lite`. An invalid model setting sends a rule-only fallback. |
| `BACKUP_REMOTE`      | rclone destination for nightly backups, e.g. `r2:case-backups`. Empty disables backups. |
| `BACKUP_AGE_RECIPIENT` | age public key the backups are encrypted to |
| `BACKUP_KEEP_DAYS`   | Days of backups to keep; defaults to `30` |
| `BACKUP_FAILURE_WEBHOOK` | Optional URL that a failed backup run POSTs a JSON message to |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 endpoint and API token for the `r2` remote |

Generate secrets with `openssl rand -hex 32`. Never commit `.env`.

`CASE_BRIEF_MODE` stays `rules` on merge. After the M1 trial ends on Mon 19 Oct, run `command` for three days and inspect the `brief` log events (`source`, `dropped`, `fallbackReason`, and `fallbackDetail`) before switching to `all`. No mode change is automatic.

### Previewing a model brief

From `apps/core`, run `npm install` and `npm run preview`. This calls the live model with synthetic fixtures and needs only `GEMINI_API_KEY` in your environment or `.env`; `GEMINI_MODEL` is optional. It prints raw JSON, the validation report, the rendered Telegram text and, separately, the NEXT.md intent findings without reading GitHub, accessing the database, or sending Telegram messages. With `features.focusButtons` on, open NEXT.md items are sent to the model and the brief includes focus suggestions, as in production; otherwise intent findings are only listed.

Use `npm run preview:oct15` to render the 15 Oct attribution regression fixture through both template and model paths. It also saves template, model, and rule-only fallback previews under `out/`.

## Backups

The `backup` container dumps the whole `case` database (core and n8n schemas) every night at 02:30 Africa/Harare. The dump is streamed through [age](https://age-encryption.org) and uploaded with [rclone](https://rclone.org) as `case-YYYY-MM-DD.dump.age`, so nothing unencrypted is written to disk. After each upload, backups dated more than `BACKUP_KEEP_DAYS` ago are deleted; other files on the remote are never touched. Each run logs one line such as `{"event":"backup","status":"ok","file":"case-2026-10-22.dump.age","bytes":81234,...}`.

Setup:

1. On your laptop, run `age-keygen -o case-backup.key`. Keep that file safe and off the server (a password manager works). The `Public key: age1...` it prints goes in `BACKUP_AGE_RECIPIENT`.
2. In Cloudflare, create an R2 bucket (e.g. `case-backups`) and an R2 API token with **Object Read & Write** on that bucket only. Set `R2_ENDPOINT` to `https://<account_id>.r2.cloudflarestorage.com`, plus `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
3. Set `BACKUP_REMOTE=r2:case-backups` and redeploy.

To take a backup straight away: `docker compose exec backup backup.sh once`. To restore one, see [infra/backup/restore.md](infra/backup/restore.md).

**Failure alerts.** If `BACKUP_FAILURE_WEBHOOK` is set, a failed run (bad config, dump, upload or pruning) POSTs a short JSON message to it:

```json
{"event":"backup_failed","at":"2026-10-22T02:30:04+0200","stage":"dump","file":"case-2026-10-22.dump.age","error":"pg_dump: error: ...","text":"CASE backup failed (dump): pg_dump: error: ..."}
```

To get it on Telegram, create an n8n workflow with a **Webhook** node (POST, an unguessable path such as `backup-failed-<random hex>`) connected to a **Telegram** node that sends `{{ $json.body.text }}` to your chat, then activate it. Set `BACKUP_FAILURE_WEBHOOK=http://n8n:5678/webhook/<that path>`. That's the internal compose address, so the alert doesn't depend on the public domain. If the webhook can't be reached, the backup log shows `"status":"alert_failed"`. A backup container that isn't running at all sends nothing, so check its logs now and then.

rclone has no config file here. The `r2` remote is defined by `RCLONE_CONFIG_R2_*` variables in `docker-compose.yml`, and any remote can be added the same way (`RCLONE_CONFIG_<NAME>_<OPTION>`).

**Google Drive instead of R2** (not set up by default):

1. On your laptop, run `rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"` (that argument is base64 for `{"scope":"drive.file"}`, which limits rclone to files it creates). Sign in and copy the JSON token it prints.
2. Add these to the `backup` service environment in `docker-compose.yml`, with the token passed in from `.env`:
   ```yaml
   RCLONE_CONFIG_GDRIVE_TYPE: drive
   RCLONE_CONFIG_GDRIVE_SCOPE: drive.file
   RCLONE_CONFIG_GDRIVE_TOKEN: ${GDRIVE_TOKEN}
   RCLONE_CONFIG_GDRIVE_USE_TRASH: "false"   # pruned backups free space right away
   ```
3. Set `BACKUP_REMOTE=gdrive:case-backups` (a folder in My Drive).

rclone refreshes the access token in memory but can't save it back without a config file. That's fine while the refresh token stays valid. If Drive uploads start failing with auth errors, run step 1 again and update `GDRIVE_TOKEN`.

## NEXT.md

**Which repos are read.** Each brief lists the repos the token's user owns (`GET /user/repos?affiliation=owner`), drops forks, archived repos and `CASE_REPO_EXCLUDE` matches, and reads those pushed to within `CASE_REPO_ACTIVE_DAYS`. Quiet repos get no API calls beyond that listing, so they add no findings. `CASE_REPOS` entries are always read. Every discovered repo is stored in the `repos` table with `first_seen_at`, `last_pushed_at` and `source` (`discovered` or `manual`). The first brief sent after a repo is first read says "New repo picked up: <name>", and "<name> has no NEXT.md yet" when it has none. A repo's branches are read again only when it has been pushed to since the last read. If the listing fails, CASE reads `CASE_REPOS` and the repos discovered earlier that were active, and the brief says so.

CASE reads a `NEXT.md` file at the root of each tracked repo to learn what you plan to do next. Only that exact path on the default branch is read.

```markdown
## Collector

- [ ] Parse NEXT.md in each tracked repo
  - [ ] Handle CRLF line endings
- [x] Store snapshots
```

- `#` to `######` headings start a section. Items before any heading have no section.
- `- [ ] text` or `* [ ] text` is an open item. `- [x]` or `- [X]` is a done item.
- Indented checkbox lines are items too (indentation is ignored).
- `- [ ] after: text` marks an item as the next step after the item just above it (see [Sequences](#sequences)). The `after:` marker is not part of the item's text or ID.
- Everything else is ignored, including any checkbox lines inside ```` ``` ```` code fences.

Each item's ID comes from its text alone: lowercased, with whitespace collapsed and trailing `.,;:` stripped. Reordering items or moving one to another section (such as a "Done" heading) keeps its ID. Editing the wording gives it a new ID. If the same text appears twice, only the first is kept.

CASE remembers every item it has seen, with when it first appeared and when it last changed section. When you edit an item's wording, CASE re-links the new item to the old one so it keeps that history and isn't reported as finished: an item that disappeared since the last run is paired with a new item when their normalised texts are at least 85% similar (Levenshtein ratio) and each is the other's single best match. Small edits such as typo fixes re-link; rewrites, or edits where two items are equally close, start fresh.

### Sequences

Items in a section are often steps in order. CASE suggests only the first open step of a sequence: an open item waits while the item just above it, in the same section, is still open and

- is marked `after:`, or
- names the same setting or milestone as it: an environment variable or config key (`CASE_BRIEF_MODE`, `features.streaks`) or a milestone (`M2`), or
- is about the same file: both name it among their first three words ("Parse NEXT.md in each tracked repo", then "NEXT.md items become findings…"). A file named later in an item ("Tick it off in NEXT.md") is a place, not the subject, and doesn't count.

```markdown
## M2 rollout

- [x] Merge M2 after M1 trial ends
- [ ] Run CASE_BRIEF_MODE=command for 3 days        ← suggested
- [ ] Switch to CASE_BRIEF_MODE=all                 ← waits (same setting)
- [ ] after: Remove the n8n fallback                ← waits (marked)
```

A done item, or one a merged PR likely finished, blocks nothing. Waiting items are still stored and listed by `/next`; they are only kept out of suggestions and the model's input. Without either signal, items are treated as independent, so add `after:` when the order matters and the wording doesn't show it.

## Focus

With `features.focusButtons` set to `true` in `apps/core/config.json`, the brief suggests two or three things to work on today, and remembers what you pick.

**Suggestions.** A numbered "Today, I'd suggest" section sits between attention and the recap. Each line is an action that starts with a verb, with at most one short fact in brackets, and links its source:

```
1. Run CASE_BRIEF_MODE=command for 3 days; check logged dropped / fallbackReason [NEXT.md]
```

A finding a suggestion is built on appears in the suggestion instead of in attention, so no fact is stated twice. Every suggestion also has a reason (such as "Open in NEXT.md, and case-ai has recent commits"); reasons are stored with the brief and logged as `focusReasons` on the `brief` event, never shown.

- **Yesterday's repo:** the repo you picked as yesterday's focus (stored with it, or named in its text, e.g. "finish 1710 phase 1 and 3") keeps one suggestion while it has an open `NEXT.md` item ready to start: yesterday's item if still open, else its first. It goes first, with the reason "Repo you picked yesterday", on both paths. It is added in code, so a private repo the model never sees still gets it.
- **Model brief:** open `NEXT.md` items are sent to the model alongside the other findings, but only as citations for suggestions. They never appear in attention or the recap. The model must cite at least one finding per suggestion, with a reason taken from it (failing CI, comments waiting for a reply, an open `NEXT.md` item), and prefers `NEXT.md` items in repos with commits, then high and medium findings. Suggestions with no valid source, an empty reason, only findings an earlier suggestion already cites, or only a snoozed focus's finding are dropped.
- **Rule-only brief and fallback:** code picks up to three: active work first, as open `NEXT.md` items from repos with commits in the last `activeRepoDays` (most recently active first), then high findings, then medium. Each gets an action built from the finding and a fixed reason per rule.

**Repos without a `NEXT.md`.** When a repo that is new (`newRepoDays`) or has commits in the last `activeRepoDays` has no `NEXT.md`, code adds one suggestion as the last item, on both paths: `Add a NEXT.md to event-hunters so I can track next steps`. It takes the third slot if there are already three; with several such repos, the most recently active one goes first. It is never sent to the model. Once shown, the repo isn't suggested again for 7 days (`next_files.missing_reported_at`); a quiet morning doesn't count as shown.

**Branches and PRs left open.** Stale branches, idle PRs and old branches are often kept open on purpose, so CASE never suggests merging or closing them, never sends them to the model, and never collapses them into the "Still open, unchanged" line under attention however long they stay. They share one low line at the very end of the brief (the first thing cut when it runs long), each linked, with its age:

```
⚪ Left open: feat/update-product-section in taga-technologies (idle 9 days)
```

All day counts ("idle 9 days", "untouched for 9 days") come from one helper, `daysSince` in `src/time.ts`: Harare calendar days since the last commit (or a PR's last update), so a commit at 23:50 is a day old at 00:10.

**Done and overdue items.** CASE never writes to `NEXT.md`. An open item that a merged PR likely finished is not suggested; one line in attention asks you to tick it off instead:

```
☑️ Looks like "Merge M2" is done (PR #3 merged). Tick it off in NEXT.md?
```

An item counts as likely done when a merged PR (one of the 50 most recently closed) names the milestone the item names first (`M2` against `feat/m2-model-brief`), or shares at least two keywords, half the item's, with the PR's title or head branch. An item with a date that has passed ("Mon 19 Oct", "Oct 19", "2026-10-19") is suggested after the others, unless a commit or recently touched branch in its repo relates to it, or it was yesterday's focus.

**Short labels.** Every finding and `NEXT.md` item has a `short_label` of at most 40 characters, built from its repo's short name and its branch or item keywords ("taga product section branch", "attachcv PR #14", "Merge M2"). The model may offer its own label, used only when code's had to be cut. Labels are stored in `findings.short_label`, `core.focus.short_label` and each suggestion in `briefs.focus`.

Suggestions are stored on the brief (`briefs.focus`: text, label, reason, finding and repo) in button order.

**Picking one.** With `CASE_DELIVERY=core`, the brief has a button per suggestion (`1`, `2`, `3`) and `Something else`. Buttons carry only `f:<briefId>:<n>`, and case-core looks the suggestion up from the stored brief. A tap stores the choice in `core.focus`, answers with a "Focus set for today" notice, replaces the buttons with `✅ Focus: <label>` and sends one line: "Got it, taga product section branch today. I'll check in tomorrow." Tapping `✅ Focus` opens three buttons:

| Button | What it does |
| ------ | ------------ |
| ✅ Done | Marks today's focus done (`core.focus.status`); tomorrow's recap says so |
| 💤 Snooze | Clears today's focus and keeps its finding out of suggestions for 3 days, then offers the suggestions again |
| 🔄 Change | Offers the suggestions again |

Buttons on an earlier day's brief no longer set a focus. `Something else` asks what your focus is, and your next plain message becomes it; that request expires at midnight Africa/Harare. With `CASE_DELIVERY=n8n` there are no buttons, but the commands below still work.

**Commands** (handled by case-core; `/brief` stays with n8n):

| Command | What it does |
| ------- | ------------ |
| `/focus <text>` | Sets today's focus, replacing any earlier choice for the day |
| `/focus` | Shows today's focus by its label, with the full text on a second line |
| `/next [repo]` | Lists open `NEXT.md` items, grouped by repo, for all tracked repos or one (`owner/repo` or just `repo`) |

`/snoozed` and `/unsnooze` are under [Less repetition](#less-repetition).

Every choice is kept in `core.focus`; the latest one for a date is that day's focus.

**Yesterday's focus.** The next brief opens its recap with the focus you picked yesterday (by button, typed or `/focus`; it is never inferred) and how many commits its repo had, on every branch, linking the newest: "You picked: Merge M2. 36 commits in case-ai yesterday". When none landed there, it says where they went instead, linking that repo's newest commit: "You picked: taga product section branch, but the commits went to case-ai (12 commits yesterday)". The count runs from the previous brief (or the last 24 hours without one), widened to the start of the recap, so it always includes every commit the recap shows. Day counts stored with the pick ("idle 8 days") are dropped, since they are a day old by then. A focus you typed has no repo, so the line only says what it was. This line is written by code and never sent to the model.

## Less repetition

**Old unmerged branches.** Branches older than `oldBranchDays` are often kept on purpose, so their one `⚪` line appears only on `oldBranchesWeekday` (ISO weekday, `1` = Monday, the default), or on another day when the set of old branches differs from the last scheduled brief's. Set `"oldBranchesShow": "daily"` in `apps/core/config.json` to show it every day. The finding is still stored every run.

Three flags stop the brief repeating itself. Each works on its own; turn one on by setting it to `true` under `features` in `apps/core/config.json` and redeploying. The shipped config has `streaks` and `snooze` on and `quietMornings` off.

**Streaks (`"streaks": true`).** For each finding in a scheduled brief, case-core counts how many consecutive previous scheduled briefs (status `ok` or `partial`) contained the same finding ID, with one query per brief. Command briefs, failed runs and unfinished runs are skipped: they neither count nor break a streak. Medium and low findings with a streak of at least `streakCollapseAfter` (in `config.json`, default `3`) move out of the attention list into one linked line at the end of it:

```
⚪ Still open, unchanged: 2 items (comments on issue #9 in attachcv, open issues in demo)
```

High findings are never collapsed; their line gains `(day N)` instead, where N counts today. Branches and PRs left open are never collapsed either: they stay on the last `⚪ Left open` line. Collapsed findings are not sent to the model or used for focus suggestions; code renders the line on both paths. `/brief` (a command brief) always shows everything.

**Snooze (`"snooze": true`).** With `CASE_DELIVERY=core`, the brief gets a `Snooze…` button when it has medium or low attention items. Tapping it sends a list of those items, each with `3 days` and `7 days` buttons; a choice is confirmed by editing that list. Snoozing for 3 days skips the next three briefs: the item is back on the brief from midnight Africa/Harare after them. Snoozed findings are left out of the brief, the model input and the focus suggestions, but are still stored, so their streak keeps counting. High findings can't be snoozed, and a snooze on a finding that has become high is ignored.

| Command | What it does |
| ------- | ------------ |
| `/snoozed` | Lists active snoozes, numbered, with the day each comes back |
| `/unsnooze <n>` | Brings item `n` from `/snoozed` back on the brief |

**Quiet mornings (`"quietMornings": true`).** Scheduled briefs only. If the brief's attention finding IDs are exactly those of the previous scheduled brief, and nothing has happened since that brief's day began (no logs, commits, PRs or issues opened, merged or closed), case-core sends a short message instead:

```
Nothing has moved since Friday. Still on <yesterday's focus, or the top attention item>?
```

It carries the brief's buttons. The full rule and model briefs are still stored in `briefs` (`text`, `rule_text`), and the short message in `briefs.sent_text`. On a Monday after an empty weekend, Sunday's brief is the one compared with. `/brief` always sends the full brief.

## Non-code activity and evening check-in

`/log pitch deck edits #dot` saves one entry for the current Africa/Harare day. `/log` and `/undo` are always available. A leading or trailing `#word` supplies one tag; a leading tag wins when both are present. Other hashtags stay in the text. Tags are lowercased, except a tracked repo match uses that repo's short name (case-insensitive matching). Empty or tag-only entries show usage. Keep the entry, including its tag, under 500 characters; longer entries are rejected. `/undo` removes the most recently created log today, including check-in replies, or says there is nothing to undo.

Migrations 013 and 014 are already deployed and unchanged. New migration `015_checkin_records.sql` runs on core startup: it creates `core.checkins` and `core.pauses`, adds `activity_logs.focus_id`, and drops `core.checkin_pending`. Each check-in has a unique Harare date, its original focus (or kind `open`), delivery status and attempts, message ID, answer, optional reason, and expiry. The answer and timestamp on `core.focus` remain in sync with the check-in record in the same transaction. Existing focus answers and logs are preserved; old reply windows close at deployment. Old buttons are rejected if their message does not match the new record.

Check-ins need `features.eveningCheckIn: true` in `apps/core/config.json`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. They send through core regardless of `CASE_DELIVERY`. Configure `eveningCheckIn.cutoff` as `HH:mm` in Harare time; the default is `"22:00"`. Runs after that time are recorded as `skipped`. A new day gets a new record; yesterday's failed check-in is never sent the next morning.

`POST /checkin` requires the same key as `/brief`. With the flag off it returns HTTP 200 with `{ "sent": false, "reason": "off" }`. With it on, it asks how today's selected active/done focus went, offering Done / Partly / Didn't touch it. Without a focus it asks for anything worth logging. A successful send returns `{ "sent": true }`; repeat calls return `{ "sent": false, "reason": "sent" }` without sending again. `skipped` and `paused` records also return their status without sending. Pending attempts are serialized; a send error preserves `pending`, increments attempts, and returns HTTP 500 so n8n records the failure and can retry. Telegram delivery and database storage cannot be atomic: a timeout after Telegram accepted a message, or a crash before recording success, can still cause a duplicate on retry.

Button payloads use `c:<checkinId>:<answer>`. Answers are accepted until **12:00 Harare the next day**, and apply to the record's date and focus even after midnight. Done marks that focus done; Partly or Didn't touch it reopens a done focus as active. Snoozed focuses are untouched. A later Done tap in the focus menu also updates an earlier check-in answer. The latest answer wins.

After Partly or Didn't touch it, the edited message asks **“What got in the way? (optional, just reply)”**. The first plain-text reply before that day's midnight becomes the check-in's `reason`; subsequent replies become logs linked to its focus. Done asks for anything else and logs replies directly. All free-text check-in handling closes at **Harare midnight**, earlier than the button expiry. `/log` entries made during that window also link to the focus. A pending focus reply from Something else takes priority, and commands do not consume the optional reason. Turning the flag off ignores check-in taps and replies. An unanswered record is derived from `answer IS NULL AND expires_at < now`, never stored or rendered as Didn't touch it; the existing unanswered You picked line remains unchanged.

| Command | Effect (requires `features.eveningCheckIn`) |
| ------- | ----------------------------------------- |
| `/pause` | Skip today's evening check-in; reply with the inclusive end date |
| `/pause <n>` | Pause for 1–30 Harare days, including today |
| `/unpause` | Clear active pauses and reopen today's paused record for the next trigger |

Pauses affect only evening check-ins. They do not suppress the morning brief or retract a check-in already sent.

Morning briefs render logs in the selected recap window under repo/tag headings, with untagged entries under Other. Log timestamps participate in window selection and prevent quiet mornings when there is new logged activity. Logs and answered check-ins are stored as info findings (`self_log` / `self_checkin`) with stable IDs (`fid("log", id)` / `fid("checkin", date)`) and `{ "label": "you", "kind": "self_reported" }` provenance instead of a URL. They are rendered by code, never sent to the model, and never treated as GitHub events. The activity sentence counts commits, merged PRs and logs for Steady (3+); Big still needs 10 commits in one repo.

The You picked line includes the recorded answer. Completed focus items are excluded from suggestions; completed NEXT.md steps get a tick-off line and release dependent steps, alongside existing GitHub completion detection. Partly leaves the finding eligible and appends ` (partly done yesterday)` to a matching suggestion in code after validation, on the next day's first brief only. Didn't touch it leaves suggestions unchanged.

Deploy this hardening:

1. Deploy the new code/config and run `docker compose up -d --build core`. Confirm the startup log says `migrated 015_checkin_records.sql`; do not rerun or edit 013/014.
2. **Re-import** `n8n/workflows/evening-checkin.json` to replace the existing evening workflow. Re-select Header Auth (`x-case-key`) and the errors workflow, then activate it. Keep only one evening workflow active.
3. Confirm all three Schedule Trigger nodes feed the same HTTP Request node: **15:45, 16:15, and 16:45 Africa/Harare** (testing times). Keep `retryOnFail` enabled. The later triggers retry pending delivery; a recorded success makes them no-ops.
4. Check a successful send followed by a silent duplicate call, `/pause` and `/unpause`, an optional reason followed by a log, and a late button answer before next-day noon. Confirm the following brief's answer and suggestion agree.

## Roadmap

- [x] **M0 Skeleton:** stack deployed, `/brief` replies hello
- [x] **M1 Rule-only brief:** GitHub collector and rule checks, plain brief at 7am
- [x] **M2 Model brief:** model writes the brief, validator checks every citation
- [x] **M3 Intent:** `NEXT.md` parsing, focus suggestions with reasons, focus buttons
- [x] **M4 Non-code:** `/log` and evening check-in; durable records, pause controls and retry hardening implemented (015 rollout pending)
- [ ] **M5 Evaluation:** golden test set, `/wrong` and `/missed` feedback

## Security notes

- GitHub access uses a fine-grained, read-only token (Contents and Metadata only).
- The bot only responds to one Telegram chat ID.
- case-core and Postgres are never exposed publicly.
- Issue and PR text is treated as untrusted data; the model has no tools and no write access.

## License

[MIT License](LICENSE)
