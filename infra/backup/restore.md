# Restoring a backup

Backups are `case-YYYY-MM-DD.dump.age` files on the backup remote (`BACKUP_REMOTE`, e.g. `r2:case-backups`). Each one is a `pg_dump --format=custom` of the whole `case` database (the `public`, `core` and `n8n` schemas), encrypted with age to `BACKUP_AGE_RECIPIENT`. Restoring one takes the private key (`case-backup.key`), which stays on your laptop.

You'll need [age](https://github.com/FiloSottile/age) (`winget install FiloSottile.age`), Docker, and optionally [rclone](https://rclone.org) (`winget install Rclone.Rclone`).

> **Windows:** these commands work in PowerShell, Git Bash or cmd. Don't pipe a dump between programs in Windows PowerShell 5.1 or save one with `>`, because both corrupt binary data. The steps below use `age -o` and `docker cp` to avoid that.

## 1. Download a backup

Either download the file from the Cloudflare dashboard (R2 → bucket → object → Download), or use rclone with the same R2 token the server uses:

```sh
rclone config create r2 s3 provider=Cloudflare endpoint=https://<account_id>.r2.cloudflarestorage.com access_key_id=<key> secret_access_key=<secret> no_check_bucket=true
rclone lsf r2:case-backups
rclone copy r2:case-backups/case-2026-10-22.dump.age .
```

## 2. Decrypt it

```sh
age -d -i case-backup.key -o case.dump case-2026-10-22.dump.age
```

`case.dump` is unencrypted. Delete it when you're done.

## 3. Restore into a fresh Postgres

Use Postgres 16 (the same major version as the server). To restore on your laptop, for inspection or a restore drill:

```sh
docker run -d --name case-restore -e POSTGRES_USER=case -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=case postgres:16-alpine
docker exec case-restore pg_isready -U case        # repeat until it says "accepting connections"
docker cp case.dump case-restore:/tmp/case.dump
docker exec case-restore pg_restore -U case -d case --clean --if-exists --single-transaction --exit-on-error /tmp/case.dump
docker exec case-restore rm /tmp/case.dump
```

`--single-transaction --exit-on-error` means you get either the whole backup or nothing. `--clean --if-exists` drops the empty `n8n` schema that `infra/init.sql` creates on a new server before restoring it.

### Check it

```sh
docker exec case-restore psql -U case -d case -c "SELECT name FROM schema_migrations ORDER BY name"
docker exec case-restore psql -U case -d case -c "SELECT schemaname || '.' || relname AS table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint AS rows FROM pg_stat_user_tables ORDER BY 1"
```

The latest run is in `SELECT id, source, status, started_at FROM runs ORDER BY id DESC LIMIT 1`. When you're done: `docker rm -f case-restore`.

## Restoring on the server

Do this only to replace the live database, e.g. after losing the volume or a bad migration. Everything written since the backup is lost.

1. In Dokploy, stop `core`, `n8n` and `backup`. Leave `postgres` running.
2. Copy the decrypted dump to the server: `scp case.dump <server>:/tmp/case.dump`.
3. On the server, find the Postgres container (`docker ps --filter name=postgres`) and run:
   ```sh
   docker exec <postgres-container> psql -U case -d postgres -c "DROP DATABASE IF EXISTS \"case\" WITH (FORCE)"
   docker exec <postgres-container> createdb -U case case
   docker cp /tmp/case.dump <postgres-container>:/tmp/case.dump
   docker exec <postgres-container> pg_restore -U case -d case --clean --if-exists --single-transaction --exit-on-error /tmp/case.dump
   docker exec <postgres-container> rm /tmp/case.dump
   rm /tmp/case.dump
   ```
   Dropping the database first means tables added by migrations newer than the backup don't linger. On startup, core re-applies any migrations that are missing from the restored `schema_migrations`.
4. Start `core`, `n8n` and `backup` again.

n8n credentials in the dump are encrypted with `N8N_ENCRYPTION_KEY`. A restored n8n can only read them with the same key, so keep that key somewhere other than the server too.
