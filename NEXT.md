## M2 rollout

- [x] Merge M2 after M1 trial ends (Mon 19 Oct)
- [x] Run CASE_BRIEF_MODE=command for 3 days; check logged dropped / fallbackReason
- [ ] Switch to CASE_BRIEF_MODE=all

## M3 Intent

- [x] Parse NEXT.md in each tracked repo (open "- [ ]" items, section headings)
- [x] M3 part 2: store next_items (re-linking edited items) and the core.focus table; once-only next_missing; feed history to next_done
- [x] Feature flags in config.json; store the rule-only brief as a baseline every run
- [x] NEXT.md items become findings with stable IDs the validator can cite
- [x] Model fills "focus" with 2-3 suggestions, each with a sourced reason
- [x] Telegram focus buttons; store the chosen focus per day
- [x] /focus and /next commands; yesterday's focus at the top of the recap

## M3 rollout

- [x] Set CASE_DELIVERY=core with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, so briefs carry buttons
- [x] Turn on features.focusButtons and redeploy; check the first brief's suggestions, buttons and /next
- [x] Compare model suggestions with the rule-picked ones in rule_text for a week

## Less repetition

- [x] Streak counting per finding across scheduled runs (one query per run)
- [x] streaks: collapse medium/low repeats into one "Still open, unchanged" line; "day N" on high findings
- [x] snooze: snoozes table, Snooze… button with 3/7-day choices, /snoozed and /unsnooze
- [x] quietMornings: short "Nothing has moved" message when attention and activity are unchanged
- [x] Turn on streaks (set "streaks": true in apps/core/config.json, redeploy) and watch a week of briefs
- [x] Turn on snooze (needs CASE_DELIVERY=core for the buttons; /snoozed works either way)
- [ ] Turn on quietMornings once streaks look right; check briefs.sent_text against text on quiet days

## 22 Oct brief fixes

- [x] Yesterday's focus counts commits on every branch since the last brief, widened to the recap, so it never contradicts it
- [x] Ask to tick off NEXT.md items a merged PR likely finished, instead of suggesting them
- [x] Suggest NEXT.md items whose date has passed last, unless there is recent activity on them
- [x] Suggestions are actions; a suggested finding leaves attention; reasons are logged, not shown
- [x] Name each branch's commit themes, with "(N on the branch so far)"
- [x] short_label (≤40 chars) on findings, NEXT.md items and focus rows (migration 011)
- [x] Focus taps: "Focus set for today" notice and a one-line reply; Done / Snooze / Change on the chosen button (migration 012)
- [x] Old unmerged branches line weekly (oldBranchesShow, oldBranchesWeekday)
- [x] Redeploy (migrations 011 and 012 run on start) and check tomorrow's brief: tick-off line for M2, yesterday's count, labels on the chosen button
- [x] Check the 07:00 brief on Fri 23 Oct: tick-off line gone once M2 is ticked, yesterday's count, labels on the chosen button, old-branches line absent
- [ ] Try Done, Snooze and Change on the chosen button

## Follow-ups from the 22 Oct deploy check

- [ ] Rewrite NEXT.md-derived suggestions as plain actions instead of quoting the raw item text
- [ ] Within one NEXT.md section, suggest only the first open item (sections are ordered steps)
- [ ] Yesterday's focus line: say when the focused item is done (e.g. "Done, PR #3"), instead of only counting commits
- [ ] Yesterday-line [commit] link should be a compare link (or dropped) when it covers many commits
- [ ] Check why the open-issue line disappeared after #1 closed and #4 opened
- [ ] Confirm a manual /brief doesn't become the anchor for the next scheduled brief's yesterday window
- [ ] Done detection: keyword-only matches show the tick-off line but don't suppress the suggestion; add per-repo stopwords (repo name, words common to that repo's PRs) for matching and commit themes

## 23 Oct brief fixes (#4, trial day 1)

- [x] Never suggest merging or closing stale branches or idle PRs; one low "Left open" line at the end instead
- [x] Suggestions rank active NEXT.md work first, then high and medium findings
- [x] Yesterday's focus says "You picked: X" and where the commits went when none landed there; no stale day counts
- [x] One daysSince helper (Harare calendar days) for every "N days"
- [x] Suggest only the first open step of a sequence (same setting or milestone, or "after:")
- [x] Redeploy and check the next 07:00 brief: no taga suggestion, one CASE_BRIEF_MODE step, "You picked" line
- [x] Tick "Merge M2" and the CASE_BRIEF_MODE=command step in NEXT.md on main, so the tick-off line and stale suggestions stop

## M4 Non-code

- [x] /log and /undo commands writing to activity_logs
- [x] Evening check-in asking how today's focus went: Done / Partly / Didn't touch it
- [x] Show logged non-code work in the morning recap without sending logs to the model
- [x] Count logs and merged PRs in the activity sentence; include check-in completion in suggestions
- [x] Migrations 013 and 014 deployed; keep both unchanged
- [x] Latest focus answer wins; yesterday check-in line ends with one full stop
- [x] Migration 015: daily check-in records, pauses, focus-linked logs; replace checkin_pending
- [x] Idempotent sends and retries; eveningCheckIn.cutoff defaults to 22:00 Harare
- [x] /pause and /pause <n> (1–30 days), /unpause; evening check-ins only
- [x] Late buttons until next-day noon; optional why reply before midnight, then logs
- [x] Stable self_log / self_checkin findings kept out of model input; Partly note on next day's first brief
- [ ] Redeploy core/config for migration 015; confirm features.eveningCheckIn and eveningCheckIn.cutoff
- [ ] Re-import evening-checkin.json with Header Auth and errors workflow; activate its 15:45, 16:15 and 16:45 Africa/Harare triggers, keeping retryOnFail
- [ ] Verify duplicate sends stay silent, pause/unpause, why then log, midnight text expiry, late buttons and the following morning's recap in production
