#!/bin/sh
# Nightly encrypted Postgres backup.
#
#   backup.sh        wait for 02:30 local time (TZ), back up, repeat
#   backup.sh once   back up now and exit (non-zero on failure)
#
# The dump is streamed pg_dump -> age -> rclone and never touches disk.
# Connection settings come from the standard PG* variables.
# No set -e: each step checks its own result so every failure gets logged.
set -u
set -o pipefail

KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
RUN_AT="02:30"

# Escapes a string for use inside a JSON string literal.
json_str() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

now_iso() { date +%Y-%m-%dT%H:%M:%S%z; }

log() { printf '{"event":"backup","at":"%s",%s}\n' "$(now_iso)" "$1"; }

fail() {
  # $1 stage, $2 file, $3 error text
  err=$(json_str "$(printf '%s' "$3" | tail -c 500)")
  log "\"status\":\"failed\",\"stage\":\"$1\",\"file\":\"$2\",\"error\":\"$err\""
  return 1
}

# Deletes case-YYYY-MM-DD.dump.age files (and leftover .partial uploads) dated
# before the cutoff. Only names matching that pattern are ever touched.
prune() {
  cutoff=$(date -d "@$(( $(date +%s) - KEEP_DAYS * 86400 ))" +%Y-%m-%d)
  rclone lsf --files-only --max-depth 1 "$REMOTE" |
    awk -v cutoff="$cutoff" '
      /^case-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\.dump\.age(\.partial)?$/ {
        if (substr($0, 6, 10) < cutoff) print
      }' |
    while read -r old; do
      rclone deletefile "$REMOTE/$old" || exit 1
      echo "$old"
    done
}

run_backup() {
  REMOTE="${BACKUP_REMOTE%/}"
  name="case-$(date +%Y-%m-%d).dump.age"
  start=$(date +%s)

  if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
    fail config "$name" "BACKUP_AGE_RECIPIENT is not set"; return 1
  fi
  case "$KEEP_DAYS" in ''|*[!0-9]*) fail config "$name" "BACKUP_KEEP_DAYS must be a whole number, got '$KEEP_DAYS'"; return 1 ;; esac

  # Upload under a temporary name so a failed run never replaces a good backup.
  if ! err=$( { pg_dump --format=custom --no-password |
                age -r "$BACKUP_AGE_RECIPIENT" |
                rclone rcat "$REMOTE/$name.partial"; } 2>&1 >/dev/null ); then
    rclone deletefile "$REMOTE/$name.partial" >/dev/null 2>&1 || true
    fail dump "$name" "$err"; return 1
  fi
  if ! err=$(rclone moveto "$REMOTE/$name.partial" "$REMOTE/$name" 2>&1); then
    fail upload "$name" "$err"; return 1
  fi

  bytes=$(rclone size --json "$REMOTE/$name" 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
  if ! pruned=$(prune 2>&1); then
    fail prune "$name" "$pruned"; return 1
  fi
  pruned_count=$(printf '%s' "$pruned" | grep -c . || true)

  log "\"status\":\"ok\",\"file\":\"$name\",\"bytes\":${bytes:-null},\"seconds\":$(( $(date +%s) - start )),\"pruned\":$pruned_count"
}

seconds_until_next_run() {
  now=$(date +%s)
  target=$(date -d "$(date +%Y-%m-%d) $RUN_AT:00" +%s)
  # Africa/Harare has no DST, so adding a day is exact.
  [ "$target" -gt "$now" ] || target=$(( target + 86400 ))
  echo $(( target - now ))
}

if [ -z "${BACKUP_REMOTE:-}" ]; then
  log '"status":"disabled","reason":"BACKUP_REMOTE is not set"'
  [ "${1:-}" = once ] && exit 0
  while true; do sleep 86400; done
fi

if [ "${1:-}" = once ]; then
  run_backup
  exit $?
fi

log "\"status\":\"scheduled\",\"runAt\":\"$RUN_AT\",\"tz\":\"${TZ:-UTC}\",\"remote\":\"$(json_str "$BACKUP_REMOTE")\",\"keepDays\":\"$(json_str "$KEEP_DAYS")\""
while true; do
  sleep "$(seconds_until_next_run)"
  run_backup || true
done
