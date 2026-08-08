#!/usr/bin/env bash
# Idempotent deploy of 1984Bot on the Pi. Safe to re-run; does the minimum.
#
#   ssh gordpi 'cd ~/apps/1984Bot && ./deploy/pi-deploy.sh'
#
# or from your laptop: pi deploy 1984Bot
set -euo pipefail

UNIT=1984bot
cd "$(git rev-parse --show-toplevel)"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

########################################
# SECRETS
########################################
# systemd hands the service its own environment via EnvironmentFile=, but the
# steps below (slash-command registration) run as plain commands outside the
# unit, so they need the same variables loaded here.
SECRETS="$HOME/secrets/1984bot.env"
[ -f "$SECRETS" ] || { echo "❌ no secrets at $SECRETS — see deploy/pi-bootstrap.sh"; exit 1; }
set -o allexport
# shellcheck source=/dev/null
. "$SECRETS"
set +o allexport

########################################
# PULL
########################################
BRANCH="$(git branch --show-current)"
BEFORE="$(git rev-parse HEAD)"

git fetch --quiet origin "$BRANCH"
# --ff-only on purpose: the Pi is a deploy target, not a dev box. If this fails,
# someone committed on the Pi and that's worth looking at rather than clobbering.
git merge --ff-only "origin/$BRANCH" --quiet
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  log "already at $(git rev-parse --short HEAD) — no new commits"
else
  log "$(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER")"
fi

changed() { ! git diff --quiet "$BEFORE" "$AFTER" -- "$@"; }

########################################
# DEPENDENCIES
########################################
# better-sqlite3 and @discordjs/opus are native modules, so node_modules is
# never copied from the laptop — it's always built here, on ARM.
if [ ! -d node_modules ] || changed package-lock.json package.json; then
  log "installing dependencies (native modules may take a few minutes)"
  # @discordjs/opus bundles an opus release that predates GCC 14, which turned
  # -Wincompatible-pointer-types and -Wimplicit-function-declaration into hard
  # errors. Debian 13 defaults to GCC 14, so pin this build to 12. (Upgrading
  # the package doesn't help — 0.10.0 fails the same way.)
  if command -v gcc-12 >/dev/null; then
    export CC=gcc-12 CXX=g++-12
  fi
  npm ci --omit=dev
else
  log "dependencies unchanged"
fi

########################################
# SLASH COMMANDS
########################################
# Registering hits the Discord API, so only do it when the commands changed.
if [ "$BEFORE" = "$AFTER" ] && [ -f .command-hash ]; then
  log "slash commands unchanged"
elif changed src/commands scripts/deploy-commands.js || [ ! -f .command-hash ]; then
  log "registering slash commands"
  npm run deploy
  git rev-parse HEAD > .command-hash
else
  log "slash commands unchanged"
fi

########################################
# RESTART
########################################
log "restarting $UNIT"
systemctl --user restart "$UNIT"

########################################
# HEALTH CHECK
########################################
# Give it long enough to get past a startup crash (bad token, missing env var)
# rather than reporting success on a process that's about to die.
sleep 8

if systemctl --user is-active --quiet "$UNIT"; then
  log "✅ $UNIT is running ($(git rev-parse --short HEAD))"
  journalctl --user-unit="$UNIT" --no-pager --lines=8 --since "1 min ago"
else
  log "❌ $UNIT failed to start"
  journalctl --user-unit="$UNIT" --no-pager --lines=40
  exit 1
fi
