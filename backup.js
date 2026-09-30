#!/usr/bin/env node
'use strict';

/**
 * supabase-backup — zero-dependency, cron-friendly backup tool for
 * Supabase (Postgres) databases.
 *
 * Each run creates a timestamped directory containing:
 *   roles.sql.gz   cluster roles & memberships (pg_dumpall --roles-only)
 *   schema.sql.gz  schema DDL                    (pg_dump --schema-only)
 *   data.sql.gz    table rows in COPY format     (pg_dump --data-only)
 *   restore.sh     one-command restore helper
 *   RESTORE.md     restore instructions for this specific backup
 *   manifest.json  backup metadata
 *
 * Configuration is read from environment variables or a `.env` file located
 * next to this script (see .env.example). Safe to run from cron: paths are
 * resolved relative to this script, a lock file prevents overlapping runs,
 * and exit code is non-zero on failure.
 *
 * Usage: node backup.js [--dry-run] [--help]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SCRIPT_DIR = __dirname;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value; // real env wins
  }
}

/** Mask the password in a postgres connection string (for logs). */
function redactSecret(s) {
  // Greedy up to the LAST '@' so even unencoded '@' in a password can't leak.
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+):.*@/i, '$1:***@');
}

/** Non-secret connection metadata for the manifest. */
function dbMeta(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port, name: u.pathname.slice(1), user: u.username };
  } catch {
    return null;
  }
}

/**
 * Run a command, streaming output to the log.
 * fatal=true  -> throw on any failure.
 * fatal=false -> log a warning and return false.
 */
function run(cmd, args, { dryRun, fatal }) {
  log('$', [cmd, ...args.map(redactSecret)].join(' '));
  if (dryRun) return true;
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (res.error) {
    if (fatal) throw new Error(`failed to execute ${cmd}: ${res.error.message}`);
    log(`WARNING: failed to execute ${cmd}: ${res.error.message} — continuing`);
    return false;
  }
  if (res.status !== 0) {
    if (fatal) throw new Error(`${cmd} exited with code ${res.status}`);
    log(`WARNING: ${cmd} exited with code ${res.status} — continuing without this step`);
    return false;
  }
  return true;
}

function gzipFile(file) {
  return new Promise((resolve, reject) => {
    const gz = `${file}.gz`;
    const src = fs.createReadStream(file);
    const zip = zlib.createGzip({ level: 9 });
    const dst = fs.createWriteStream(gz);
    src.on('error', reject);
    zip.on('error', reject);
    dst.on('error', reject);
    dst.on('finish', () => {
      fs.unlinkSync(file);
      resolve(gz);
    });
    src.pipe(zip).pipe(dst);
  });
}

/** Keep the newest `keep` timestamped backup directories, delete the rest. */
function pruneOldBackups(dir, keep, dryRun) {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse(); // ISO timestamps sort lexicographically, newest first
  const pruned = names.slice(Math.max(keep, 0));
  for (const name of pruned) {
    log(`Pruning old backup: ${name}`);
    if (!dryRun) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  return pruned;
}

/** Prevent overlapping cron runs. Stale locks (>6h) are taken over. */
function acquireLock(dir) {
  const lockPath = path.join(dir, '.lock');
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === 'EEXIST') {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        log('Removing stale lock file');
        fs.unlinkSync(lockPath);
        return acquireLock(dir);
      }
      throw new Error(
        `another backup appears to be running (lock file: ${lockPath}). ` +
          'If no backup is running, delete the lock file and retry.'
      );
    }
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}

function checkTools(tools) {
  const missing = tools.filter(
    (t) => spawnSync(t, ['--version'], { stdio: 'ignore' }).error
  );
  if (missing.length > 0) {
    throw new Error(
      `missing required tools: ${missing.join(', ')}\n` +
        'Install the PostgreSQL client, e.g. Debian/Ubuntu: sudo apt install postgresql-client\n' +
        'Use a client major version >= your Supabase Postgres version (check pg_dump --version).'
    );
  }
}

function toolVersion(cmd) {
  const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return res.error ? null : String(res.stdout).trim();
}

// ---------------------------------------------------------------------------
// per-backup restore assets
// ---------------------------------------------------------------------------

// NOTE for template authors: JS template literals interpolate ${...}, so the
// shell script below deliberately uses only $var / "$0" style expansions.
const RESTORE_SH = `#!/usr/bin/env bash
# Restores the backup in this directory into a target database.
# Usage: ./restore.sh "postgresql://user:password@host:5432/postgres"
set -euo pipefail
cd "$(dirname "$0")"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <target-database-url>" >&2
  exit 1
fi
TARGET="$1"

if [ -f roles.sql.gz ]; then
  echo "==> Restoring roles (errors about already-existing roles are usually benign)..."
  zcat roles.sql.gz | psql -d "$TARGET" || echo "    roles step reported errors -- continuing anyway."
else
  echo "==> No roles.sql.gz in this backup -- skipping roles."
fi

echo "==> Restoring schema..."
zcat schema.sql.gz | psql -v ON_ERROR_STOP=1 -d "$TARGET"

echo "==> Restoring data..."
zcat data.sql.gz | psql -v ON_ERROR_STOP=1 -d "$TARGET"

echo "==> Restore complete."
`;

function restoreReadme(stamp, hasRoles) {
  return `# How to restore this backup

Backup taken: \`${stamp}\` (UTC)

## Contents

| File | What it is | Produced by |
| --- | --- | --- |
| \`roles.sql.gz\`${hasRoles ? '' : ' ⚠️ *(roles dump failed — may be missing)*'} | Cluster roles and role memberships | \`pg_dumpall --roles-only\` |
| \`schema.sql.gz\` | Tables, indexes, functions, triggers, policies, … | \`pg_dump --schema-only\` |
| \`data.sql.gz\` | All table rows (COPY format) | \`pg_dump --data-only\` |
| \`restore.sh\` | Helper script performing the steps below | — |
| \`manifest.json\` | Metadata about this backup | — |

## Prerequisites

- PostgreSQL client tools (\`psql\`) with a major version **greater than or equal to** the source database.
- A target database. For disaster recovery use a **fresh, empty** database
  (a new Supabase project or a self-hosted Postgres instance).

## Option A — automatic

\`\`\`bash
./restore.sh "postgresql://postgres:<password>@<target-host>:5432/postgres"
\`\`\`

## Option B — manual

\`\`\`bash
# 1. Roles (cluster-wide; needs a privileged role).
#    Errors about roles that already exist are benign — the script continues.
zcat roles.sql.gz | psql "postgresql://<target>"

# 2. Schema
zcat schema.sql.gz | psql -v ON_ERROR_STOP=1 "postgresql://<target>"

# 3. Data
zcat data.sql.gz | psql -v ON_ERROR_STOP=1 "postgresql://<target>"
\`\`\`

## Notes & caveats

- **Order matters**: roles → schema → data.
- Roles are cluster-level objects, not database-level. Restoring them requires
  a sufficiently privileged role (e.g. \`postgres\`).
- When restoring into a **hosted Supabase project**, managed roles
  (\`supabase_admin\`, \`authenticator\`, …) and managed schemas (\`auth\`,
  \`storage\`, …) already exist. Expect some "already exists" / "permission
  denied" errors for those objects — your own tables and data still restore.
- To restore into a database that is **not empty**, drop/recreate it first or
  expect conflicts.
- Before restoring into a new Supabase project, you may want to revoke default
  privileges so your restored grants apply cleanly:
  \`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;\`
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(
      'Usage: node backup.js [--dry-run]\n\n' +
        'Reads configuration from environment variables or a .env file next to\n' +
        'this script. See .env.example and README.md for details.'
    );
    return;
  }
  const dryRun = argv.includes('--dry-run');

  loadEnvFile(path.join(SCRIPT_DIR, '.env'));

  const enabled = (process.env.BACKUP_ENABLED ?? 'true').trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(enabled)) {
    log('BACKUP_ENABLED is false — nothing to do.');
    return;
  }

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      'SUPABASE_DB_URL is not set. Copy .env.example to .env and fill in your connection string.'
    );
  }

  const backupDir = path.resolve(SCRIPT_DIR, process.env.BACKUP_DIR || './backups');
  const keep = Number.parseInt(process.env.BACKUP_KEEP ?? '7', 10);
  if (!Number.isFinite(keep) || keep < 1) {
    throw new Error('BACKUP_KEEP must be a positive integer.');
  }
  const schemas = (process.env.BACKUP_SCHEMAS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const schemaArgs = schemas.flatMap((s) => ['--schema', s]);

  if (dryRun) log('Dry run — commands are printed, nothing is executed or written.');
  else checkTools(['pg_dump', 'pg_dumpall', 'psql']);

  if (!dryRun) fs.mkdirSync(backupDir, { recursive: true });
  const releaseLock = dryRun ? () => {} : acquireLock(backupDir);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(backupDir, stamp);

  let hasRoles = false;
  try {
    log(`Starting backup ${stamp}`);
    if (!dryRun) fs.mkdirSync(outDir);

    // 1. Roles — cluster-level objects. Not fatal: hosted Supabase restricts
    //    pg_authid, so this can fail there while schema + data still succeed.
    hasRoles = run(
      'pg_dumpall',
      ['--roles-only', '-d', dbUrl, '-f', path.join(outDir, 'roles.sql')],
      { dryRun, fatal: false }
    );

    // 2. Schema (fatal on error)
    run(
      'pg_dump',
      ['-d', dbUrl, '--schema-only', ...schemaArgs, '-f', path.join(outDir, 'schema.sql')],
      { dryRun, fatal: true }
    );

    // 3. Data, COPY format (fatal on error)
    run(
      'pg_dump',
      ['-d', dbUrl, '--data-only', ...schemaArgs, '-f', path.join(outDir, 'data.sql')],
      { dryRun, fatal: true }
    );

    if (!dryRun) {
      const gzFiles = [];
      for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith('.sql'))) {
        gzFiles.push(await gzipFile(path.join(outDir, f)));
      }
      fs.writeFileSync(path.join(outDir, 'restore.sh'), RESTORE_SH, { mode: 0o755 });
      fs.writeFileSync(path.join(outDir, 'RESTORE.md'), restoreReadme(stamp, hasRoles));
      fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify(
          {
            created_at: new Date().toISOString(),
            database: dbMeta(dbUrl),
            pg_dump: toolVersion('pg_dump'),
            schemas_included: schemas.length > 0 ? schemas : 'all',
            roles_dumped: hasRoles,
            files: gzFiles.map((f) => ({
              name: path.basename(f),
              bytes: fs.statSync(f).size,
            })),
          },
          null,
          2
        ) + '\n'
      );
    }

    pruneOldBackups(backupDir, keep, dryRun);
    log(dryRun ? 'Dry run complete.' : `Backup complete: ${outDir}`);
  } catch (err) {
    if (!dryRun) fs.rmSync(outDir, { recursive: true, force: true });
    throw err;
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(new Date().toISOString(), 'ERROR:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { loadEnvFile, redactSecret, pruneOldBackups, dbMeta, RESTORE_SH };
