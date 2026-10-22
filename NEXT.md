## M2 rollout

- [ ] Merge M2 after M1 trial ends (Mon 19 Oct)
- [ ] Run CASE_BRIEF_MODE=command for 3 days; check logged dropped / fallbackReason
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

- [ ] Set CASE_DELIVERY=core with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, so briefs carry buttons
- [ ] Turn on features.focusButtons and redeploy; check the first brief's suggestions, buttons and /next
- [ ] Compare model suggestions with the rule-picked ones in rule_text for a week

## Less repetition

- [x] Streak counting per finding across scheduled runs (one query per run)
- [x] streaks: collapse medium/low repeats into one "Still open, unchanged" line; "day N" on high findings
- [x] snooze: snoozes table, Snooze… button with 3/7-day choices, /snoozed and /unsnooze
- [x] quietMornings: short "Nothing has moved" message when attention and activity are unchanged
- [ ] Turn on streaks (set "streaks": true in apps/core/config.json, redeploy) and watch a week of briefs
- [ ] Turn on snooze (needs CASE_DELIVERY=core for the buttons; /snoozed works either way)
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
- [ ] Redeploy (migrations 011 and 012 run on start) and check tomorrow's brief: tick-off line for M2, yesterday's count, labels on the chosen button
- [ ] Try Done, Snooze and Change on the chosen button
