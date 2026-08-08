#!/usr/bin/env bash
# One-time setup of 1984Bot on the Pi. Run once after cloning into ~/apps;
# everything after this is `pi deploy 1984Bot`.
#
#   ssh gordpi 'cd ~/apps/1984Bot && ./deploy/pi-bootstrap.sh'
set -euo pipefail

UNIT=1984bot
UNIT_DIR="$HOME/.config/systemd/user"
SECRETS="$HOME/secrets/1984bot.env"

cd "$(git rev-parse --show-toplevel)"
log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

########################################
# PRECONDITIONS
########################################
for c in node npm ffmpeg yt-dlp sqlite3; do
  command -v "$c" >/dev/null || { echo "❌ missing: $c"; exit 1; }
done

# See the note in pi-deploy.sh: the native opus build needs GCC 12, not 14.
command -v gcc-12 >/dev/null || {
  echo "❌ missing gcc-12 — run: sudo apt-get install -y gcc-12 g++-12"; exit 1; }

if [ ! -f "$SECRETS" ]; then
  cat >&2 <<EOF
❌ No secrets file at $SECRETS

Create it from the repo's .env.example, with the PRODUCTION bot token
(your laptop's .env should hold a separate dev token so both can run at once):

  install -m 600 /dev/null $SECRETS
  nano $SECRETS

It needs at minimum DISCORD_TOKEN, CLIENT_ID and GUILD_ID. Use an absolute
DATABASE_PATH so the db doesn't depend on the working directory:

  DATABASE_PATH=$HOME/apps/1984Bot/data/1984bot.sqlite
EOF
  exit 1
fi
chmod 600 "$SECRETS"

########################################
# UNITS
########################################
mkdir -p "$UNIT_DIR" "$HOME/bin" data

# Symlink rather than copy, so a git pull updates the unit definition too.
ln -sfn "$PWD/deploy/$UNIT.service" "$UNIT_DIR/$UNIT.service"
ln -sfn "$PWD/deploy/notify@.service" "$UNIT_DIR/notify@.service"
install -m 755 deploy/notify-failure "$HOME/bin/notify-failure"
log "units linked into $UNIT_DIR"

# Survive logout and start at boot without anyone logging in.
loginctl enable-linger "$USER"

systemctl --user daemon-reload
systemctl --user enable "$UNIT"
log "$UNIT enabled at boot"

########################################
# FIRST DEPLOY
########################################
exec ./deploy/pi-deploy.sh
