#!/usr/bin/env bash
# Nightly SQLite snapshot. Run by 1984bot-backup.timer; safe to run by hand.
#
# The bot writes continuously, so this uses sqlite3's .backup (which takes a
# consistent snapshot of a live database) rather than cp, which would happily
# copy a torn page mid-write.
set -euo pipefail

DB="${DATABASE_PATH:-$HOME/apps/1984Bot/data/1984bot.sqlite}"
DEST="$HOME/backups/1984bot"
KEEP_DAYS="${KEEP_DAYS:-14}"

[ -f "$DB" ] || { echo "❌ no database at $DB"; exit 1; }
mkdir -p "$DEST"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/1984bot-$STAMP.sqlite"

sqlite3 "$DB" ".backup '$OUT'"

# Verify the copy before trusting it — a backup that's never been read is a
# guess. Checking the snapshot rather than the live db also keeps this off the
# bot's write path.
if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -qx ok; then
  echo "❌ snapshot failed integrity check, discarding"
  rm -f "$OUT"
  exit 1
fi

gzip -f "$OUT"
SIZE="$(du -h "$OUT.gz" | cut -f1)"

# Retention. -mtime +N is "older than N days", so this keeps today plus KEEP_DAYS.
DELETED="$(find "$DEST" -name '1984bot-*.sqlite.gz' -mtime +"$KEEP_DAYS" -print -delete | wc -l)"

echo "✅ $OUT.gz ($SIZE); pruned $DELETED old snapshot(s); $(find "$DEST" -name '*.gz' | wc -l) retained"
