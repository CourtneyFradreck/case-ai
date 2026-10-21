# CASE — Cognitive Assistant for Scheduling and Execution

> C.A.S.E inspired by one of the AI systems from Interstellar

**A daily Telegram brief that tells me where I left off.**

Every morning at 7am, CASE looks at my GitHub activity, the `NEXT.md` file in each repo and the notes I've logged, then sends me a short brief: what needs my attention, followed by what I worked on most recently. The recap uses the last active day within the past week, or both weekend days on Monday. Dates follow Africa/Harare time. Every line links back to the commit, issue, PR or note it came from.

CASE is the first module of **ALFRED**, a personal AI assistant I'm building one piece at a time.

> **Status:** Milestone 1 (rule-only brief) in trial; M2 (model brief) built, not yet deployed; M3 focus suggestions built behind `features.focusButtons`, off by default.

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
- **Feature flags** live under `features` in `apps/core/config.json`: `focusButtons`, `streaks`, `snooze` and `quietMornings`. Each defaults to `false`; only an explicit `true` turns one on. To turn one on, set it to `true`, commit and redeploy (config is read at startup). With every flag off, the brief is the same as before the flags existed. See [Focus](#focus) and [Less repetition](#less-repetition).

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
| `GITHUB_TOKEN`       | Read-only GitHub token for the tracked repos |
| `CASE_REPOS`         | Comma-separated `owner/repo` names |
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
- Everything else is ignored, including any checkbox lines inside ```` ``` ```` code fences.

Each item's ID comes from its text alone: lowercased, with whitespace collapsed and trailing `.,;:` stripped. Reordering items or moving one to another section (such as a "Done" heading) keeps its ID. Editing the wording gives it a new ID. If the same text appears twice, only the first is kept.

CASE remembers every item it has seen, with when it first appeared and when it last changed section. When you edit an item's wording, CASE re-links the new item to the old one so it keeps that history and isn't reported as finished: an item that disappeared since the last run is paired with a new item when their normalised texts are at least 85% similar (Levenshtein ratio) and each is the other's single best match. Small edits such as typo fixes re-link; rewrites, or edits where two items are equally close, start fresh.

## Focus

With `features.focusButtons` set to `true` in `apps/core/config.json`, the brief suggests two or three things to work on today, and remembers what you pick.

**Suggestions.** A numbered "Today, I'd suggest" section sits between attention and the recap. Each line names the work, gives a short reason and links its source.

- **Model brief:** open `NEXT.md` items are sent to the model alongside the other findings, but only as citations for suggestions. They never appear in attention or the recap. The model must cite at least one finding per suggestion, with a reason taken from it (failing CI, a PR with no activity, an open `NEXT.md` item), and prefers high and medium findings, then `NEXT.md` items in repos with commits. Suggestions with no valid source, an empty reason, or only findings an earlier suggestion already cites are dropped.
- **Rule-only brief and fallback:** code picks up to three: high findings, then medium, then open `NEXT.md` items from repos with commits in the last `activeRepoDays` (most recently active first), each with a fixed reason per rule.

Suggestions are stored on the brief (`briefs.focus`) in button order.

**Picking one.** With `CASE_DELIVERY=core`, the brief has a button per suggestion (`1`, `2`, `3`) and `Something else`. Buttons carry only `f:<briefId>:<n>`, and case-core looks the suggestion up from the stored brief. A tap stores the choice in `core.focus` and replaces the buttons with `Focus: <text>`. Buttons on an earlier day's brief no longer set a focus. `Something else` asks what your focus is, and your next plain message becomes it; that request expires at midnight Africa/Harare. With `CASE_DELIVERY=n8n` there are no buttons, but the commands below still work.

**Commands** (handled by case-core; `/brief` stays with n8n):

| Command | What it does |
| ------- | ------------ |
| `/focus <text>` | Sets today's focus, replacing any earlier choice for the day |
| `/focus` | Shows today's focus |
| `/next [repo]` | Lists open `NEXT.md` items, grouped by repo, for all tracked repos or one (`owner/repo` or just `repo`) |

`/snoozed` and `/unsnooze` are under [Less repetition](#less-repetition).

Every choice is kept in `core.focus`; the latest one for a date is that day's focus.

**Yesterday's focus.** The next brief opens its recap with yesterday's focus and whether its repo had commits since you picked it, linking the newest commit. A focus you typed has no repo, so the line only says what it was. This line is written by code and never sent to the model.

## Less repetition

Three flags stop the brief repeating itself. Each works on its own; turn one on by setting it to `true` under `features` in `apps/core/config.json` and redeploying.

**Streaks (`"streaks": true`).** For each finding in a scheduled brief, case-core counts how many consecutive previous scheduled briefs (status `ok` or `partial`) contained the same finding ID, with one query per brief. Command briefs, failed runs and unfinished runs are skipped: they neither count nor break a streak. Medium and low findings with a streak of at least `streakCollapseAfter` (in `config.json`, default `3`) move out of the attention list into one linked line at the end of it:

```
⚪ Still open, unchanged: 3 items (idle PR #14 in attachcv, stale branch feat/x in demo, open issues in demo)
```

High findings are never collapsed; their line gains `(day N)` instead, where N counts today. Collapsed findings are not sent to the model or used for focus suggestions; code renders the line on both paths. `/brief` (a command brief) always shows everything.

**Snooze (`"snooze": true`).** With `CASE_DELIVERY=core`, the brief gets a `Snooze…` button when it has medium or low attention items. Tapping it sends a list of those items, each with `3 days` and `7 days` buttons; a choice is confirmed by editing that list. Snoozing for 3 days skips the next three briefs: the item is back on the brief from midnight Africa/Harare after them. Snoozed findings are left out of the brief, the model input and the focus suggestions, but are still stored, so their streak keeps counting. High findings can't be snoozed, and a snooze on a finding that has become high is ignored.

| Command | What it does |
| ------- | ------------ |
| `/snoozed` | Lists active snoozes, numbered, with the day each comes back |
| `/unsnooze <n>` | Brings item `n` from `/snoozed` back on the brief |

**Quiet mornings (`"quietMornings": true`).** Scheduled briefs only. If the brief's attention finding IDs are exactly those of the previous scheduled brief, and nothing has happened since that brief's day began (no commits, PRs or issues opened, merged or closed), case-core sends a short message instead:

```
Nothing has moved since Friday. Still on <yesterday's focus, or the top attention item>?
```

It carries the brief's buttons. The full rule and model briefs are still stored in `briefs` (`text`, `rule_text`), and the short message in `briefs.sent_text`. On a Monday after an empty weekend, Sunday's brief is the one compared with. `/brief` always sends the full brief.

## Roadmap

- [x] **M0 Skeleton:** stack deployed, `/brief` replies hello
- [x] **M1 Rule-only brief:** GitHub collector and rule checks, plain brief at 7am
- [ ] **M2 Model brief:** model writes the brief, validator checks every citation
- [ ] **M3 Intent:** `NEXT.md` parsing, focus suggestions with reasons, focus buttons
- [ ] **M4 Non-code:** `/log` and an evening check-in
- [ ] **M5 Evaluation:** golden test set, `/wrong` and `/missed` feedback

## Security notes

- GitHub access uses a fine-grained, read-only token limited to chosen repos.
- The bot only responds to one Telegram chat ID.
- case-core and Postgres are never exposed publicly.
- Issue and PR text is treated as untrusted data; the model has no tools and no write access.

## License

[MIT License](LICENSE)
