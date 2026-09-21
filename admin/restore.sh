#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${RESTORE_CONFIRM:?Set RESTORE_CONFIRM=Y after verifying DATABASE_URL targets an isolated database}"

if [[ "$RESTORE_CONFIRM" != "Y" ]]; then
  printf '%s\n' 'RESTORE_CONFIRM must be Y' >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  printf 'Backup file does not exist: %s\n' "$BACKUP_FILE" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$BACKUP_FILE"
printf 'Restored %s\n' "$BACKUP_FILE"
