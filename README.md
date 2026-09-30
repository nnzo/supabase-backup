# supabase-backup

A zero-dependency Node.js tool that takes full logical backups of a Supabase
(Postgres) database, designed to run unattended from a cron job. Every backup
ships with its own restore instructions.

## What it does

Each run creates a timestamped directory under `backups/`:

```
backups/2026-09-30T21-27-32-000Z/
├── roles.sql.gz    # cluster roles & memberships  (pg_dumpall --roles-only)
├── schema.sql.gz   # tables, functions, policies… (pg_dump --schema-only)
├── data.sql.gz     # all rows, COPY format        (pg_dump --data-only)
├── restore.sh      # one-command restore helper
├── RESTORE.md      # restore instructions for this exact backup
└── manifest.json   # metadata (timestamp, source host, file sizes, …)
```

Old backups are pruned automatically (`BACKUP_KEEP`, default: keep 7). A lock
file prevents overlapping cron runs, and the exit code is non-zero on failure
so cron mailers / monitoring can alert you.

## Why not the 2-year-old GitHub Actions workflow?

That workflow's approach is mostly still valid — the Supabase CLI flags it uses
(`--role-only`, `--data-only`, `--use-copy`, `-f`) all still exist. But:

- **Its restore instructions are broken**: `supabase db execute` no longer
  exists in the CLI. Restores are done with `psql` today.
- `supabase db dump` runs `pg_dump` inside a **Docker container** — an extra
  daemon to keep running on a backup server.
- Committing `data.sql` to git **bloats the repository** and permanently leaks
  row data into git history (even after deletion).
- It overwrites the same three files every run — no history, no retention.

This tool produces the same roles/schema/data split using plain
`pg_dump`/`pg_dumpall` — no Docker, no Supabase CLI, no git commits of data —
and stores compressed, timestamped backups on disk with retention.

## Requirements

- **Node.js ≥ 18** (no npm dependencies)
- **PostgreSQL client tools**: `pg_dump`, `pg_dumpall`, `psql`
  - Debian/Ubuntu: `sudo apt install postgresql-client`
  - The client major version must be **≥ the server's** (Supabase currently
    runs Postgres 15/17). Check with `pg_dump --version`.

## Setup

```bash
cp .env.example .env
# edit .env and set SUPABASE_DB_URL
```

Get the connection string from the Supabase Dashboard →
**Project Settings → Database → Connection string**:

- Prefer the **Direct connection** (`db.<ref>.supabase.co:5432`). Note it is
  IPv6-only — if your host has no IPv6 route, use the **Session pooler** string
  instead (also port 5432, user `postgres.<ref>`).
- Avoid the **transaction pooler** (port 6543) — it is unreliable for `pg_dump`.

Verify everything works before scheduling it:

```bash
npm run backup            # real backup
npm run backup:dry-run    # print the commands without executing anything
```

## Running from cron

```bash
mkdir -p logs
crontab -e
```

```cron
PATH=/usr/local/bin:/usr/bin:/bin
# Daily at 03:00 (server local time)
0 3 * * * node /home/enzo/development/supabase-backup/backup.js >> /home/enzo/development/supabase-backup/logs/backup.log 2>&1
```

Notes:

- Cron runs with a minimal environment — that's fine: the script resolves all
  paths relative to itself and loads `.env` on its own.
- Set `BACKUP_ENABLED=false` in `.env` to pause backups without touching the
  crontab.
- Schedule times are in the **server's local timezone**.

## Restoring a backup

Every backup directory contains its own `RESTORE.md` and an executable
`restore.sh`. The short version:

```bash
cd backups/2026-09-30T21-27-32-000Z
./restore.sh "postgresql://postgres:<password>@<target-host>:5432/postgres"
```

Or manually, in order — roles → schema → data:

```bash
zcat roles.sql.gz  | psql "$TARGET_URL"                      # "already exists" errors are benign
zcat schema.sql.gz | psql -v ON_ERROR_STOP=1 "$TARGET_URL"
zcat data.sql.gz   | psql -v ON_ERROR_STOP=1 "$TARGET_URL"
```

Key caveats (also written into each `RESTORE.md`):

- Use a **fresh, empty** target database for disaster recovery (new Supabase
  project or self-hosted Postgres).
- Roles are cluster-level objects; restoring them needs a privileged role.
- Hosted Supabase targets already contain managed roles/schemas (`auth`,
  `storage`, …) — expect benign "already exists"/"permission denied" errors
  for those objects; your own tables and data still restore.

## Configuration

All variables are read from the environment or `.env` (environment wins):

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SUPABASE_DB_URL` | yes | — | Postgres connection string |
| `BACKUP_DIR` | no | `./backups` | Where timestamped backups are stored |
| `BACKUP_KEEP` | no | `7` | Number of backups to retain |
| `BACKUP_ENABLED` | no | `true` | `false` skips backups (cron stays installed) |
| `BACKUP_SCHEMAS` | no | *(all)* | Comma-separated schema allowlist for schema/data dumps |

## Troubleshooting

- **`pg_dump: error: aborting because of server version mismatch`** — install a
  newer PostgreSQL client (major version ≥ the server's).
- **Connection to `db.<ref>.supabase.co` fails / no route to host** — the
  direct connection is IPv6-only. Use the Session pooler connection string.
- **Roles dump fails with `permission denied for table pg_authid`** — expected
  on hosted Supabase (the `postgres` user isn't a full superuser). The backup
  continues without roles; `restore.sh` skips the roles step automatically.
- **Permission errors dumping managed schemas** — restrict the dump with
  `BACKUP_SCHEMAS=public` (add more schemas as needed).
- **`another backup appears to be running`** — a previous run crashed and left
  `backups/.lock`. Locks older than 6 hours are reclaimed automatically;
  otherwise delete the file.

## Security

Backups contain **all of your data**, and `roles.sql` includes password hashes.
`backups/` and `.env` are gitignored — keep it that way, restrict filesystem
permissions on the backup host, and consider encrypting backups or syncing them
off-site for real disaster recovery.
