#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
backup_dir="${BACKUP_DIR:-./backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$backup_dir"
pg_dump --format=custom --file="$backup_dir/rustdesk-control-$timestamp.dump" "$DATABASE_URL"
pg_restore --list "$backup_dir/rustdesk-control-$timestamp.dump" >/dev/null
printf 'Created %s\n' "$backup_dir/rustdesk-control-$timestamp.dump"
