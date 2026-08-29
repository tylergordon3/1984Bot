# 1984Bot 👁️

A private, single-guild Discord bot for your server. It plays music (YouTube +
Spotify-links-resolved-to-YouTube) and quietly keeps a dossier on everyone:

- **Music** — `/play` a YouTube/Spotify link or search term, plus queue controls.
- **Voice surveillance** — total time in voice, who spends the most time, who
  they spent it *with* (and how much of it *alone*), and which hours of the day
  voice channels are busiest.
- **Game surveillance** — per-user most-played games, a game-time leaderboard,
  and the server's overall top games — over the past day / week / month / year /
  all time.
- **Chat surveillance** — who talks the most (filterable by channel and by hour
  of day, e.g. *only after 2pm*), when each person is most active, and a full
  tag graph: who tags whom, who gets tagged most, and who never tags back.
- **Reaction surveillance** — who gets reacted to, who does the reacting, which
  emoji this server actually uses, and the best-received messages of any period
  (with jump links). Reactions taken back are forgotten, as though they never
  happened.
- **Attendance streaks** — consecutive days on which someone turned up at all
  (a message sent, or any time in voice). Current streaks, longest ever, and an
  announcement when a real one lapses.
- **It answers when you @ it** — with something it actually knows about you.
- **The Ministry's report** — a daily digest posted on a schedule (and a weekly
  one), assembled from everything above: the loudest talkers, who logged the
  most voice time, the top games, who was inseparable from whom, who spent the
  longest alone in a channel, who got tagged most, and a heatmap of when the
  day was busiest. `/digest` renders one for any period on demand. A dead
  period posts nothing, and a restart never replays an edition.
- **Milestones** — announcements as they're earned: round numbers crossed
  (100 hours in voice, 1,000 messages on the record, 250 hours in a single
  game, 100 hours spent *alone*, 100 hours spent with the same person, 500
  reactions collected, 30 days' perfect attendance) and server records broken
  (longest voice session, longest unbroken game session, most messages in a
  day, best-received message, longest completed streak), plus a *first
  sighting* the first time anyone plays a game the server has never recorded,
  and an obituary when a long streak ends. `/records` shows the standing records
  and what was most recently filed. Switching the feature on takes a silent
  baseline of everything already achieved, so history is never dumped into the
  channel — only what happens next is announced.
- **Severe weather alerts** — polls the National Weather Service and posts
  Severe Thunderstorm / Tornado Warnings for watched locations to a channel,
  pinging each location's subscribers (watches are off by default — add them to
  `WEATHER_EVENTS`). Every alert comes with a **map**
  of the warned area — live NEXRAD radar over OpenStreetMap, with the watched
  location marked — so you can see at a glance whether the storm is over your
  house or two counties away, and which way it's going. `WEATHER_RADAR=false`
  drops back to the plain basemap; `WEATHER_MAPS=false` to text-only alerts. Anyone can `/weather add` a US place by name (geocoded
  automatically) and `/weather subscribe` to be pinged; `/weather map` shows
  everything in effect right now — watches included, whatever the ping settings
  are — and `/weather list` shows who's watching what.
- **SMITE 2 watch** — when a member starts playing SMITE 2, posts a stat card
  (rank + MMR, ranked win rate and record, recent form, top gods) built from
  their linked [smite2.live](https://smite2.live) profile, plus their
  [SmiteSource](https://smitesource.com) profile link. When a linked member's
  match finishes, a match report follows: every guild member in that match with
  their god, role, KDA, performance grade, and result. Members link themselves
  once with `/smite link <in-game name>`.

  **Currently switched off** — `SMITE_ENABLED` defaults to `false`, which hides
  the `/smite` command and stops the session announcements and match reports.
  The code and any linked accounts stay put; set `SMITE_ENABLED=true` and
  re-run `npm run deploy` to bring it back.

Designed to run passively on a Raspberry Pi with a single SQLite file for storage.

---

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it `1984Bot`.
2. **Bot** tab → **Reset Token** → copy the token (this is `DISCORD_TOKEN`).
3. Still on the **Bot** tab, enable all three **Privileged Gateway Intents**:
   - ✅ **Presence Intent** (required for game tracking)
   - ✅ **Server Members Intent** (required for co-presence & member data)
   - ✅ **Message Content Intent** (required for word counts and for the bot to
     read what you say when you @ it — *who tagged whom* is still tracked
     without it, since Discord sends the mention list separately). If you'd
     rather not enable it, set `MESSAGE_CONTENT=false` in `.env`; leaving it
     requested but disabled makes Discord reject the login outright.
   The bot also uses the **Message Reactions** intent for reaction tracking.
   That one is *not* privileged — there's nothing to enable for it here.
4. **General Information** tab → copy the **Application ID** (this is `CLIENT_ID`).
5. Invite the bot: **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`,
   bot permissions: *View Channels, Connect, Speak, Send Messages, Embed Links,
   Read Message History*.
   Open the generated URL and add it to your server.
6. In Discord (User Settings → Advanced → **Developer Mode** on), right-click your
   server icon → **Copy Server ID** (this is `GUILD_ID`).

## 2. Install system dependencies

The bot shells out to **yt-dlp** and **ffmpeg** for audio (yt-dlp self-maintains
against YouTube changes, which is why it's used instead of a JS library).

On Raspberry Pi OS / Debian / Ubuntu:

```bash
sudo apt update && sudo apt install -y ffmpeg
node -v                            # needs Node.js >= 18.17 (use nvm or nodesource)
```

Install **yt-dlp** as the standalone binary (recommended — always current against
YouTube changes and self-updates via `yt-dlp -U`). On modern Ubuntu/Debian, `pip`
is blocked by PEP 668, so use the binary rather than `pip install`:

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

## 3. Configure and install

```bash
cd 1984Bot
cp .env.example .env
nano .env                          # fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID
npm install
```

> `npm install` compiles two native modules (`better-sqlite3`, `@discordjs/opus`).
> On a Pi this can take a few minutes; prebuilt ARM binaries are used when available.
> If a build fails, `sudo apt install -y build-essential python3` and retry.

## 4. Register slash commands (once, and after adding commands)

```bash
npm run deploy
```

## 5. Run

```bash
npm start
```

You should see `1984Bot is watching. 👁️`. Try `/voiceleaderboard`, `/play`, etc.

## 6. (Optional) Import existing chat history

Message tracking starts empty. To make the chat stats useful on day one, import
what's already been said:

```bash
npm run backfill                      # last 90 days of the tracked channels
npm run backfill -- --days=365
npm run backfill -- --all             # everything, from the first message
npm run backfill -- --channel=the-resources
```

It's safe to re-run — every message is keyed by id and imported at most once.

Reactions on old messages are not imported by default — that costs an API
request per emoji per message. Add `--reactions` when you want them:

```bash
npm run backfill -- --days=90 --reactions
```

It reconciles rather than appends, so it also clears reactions that were taken
back while the bot was offline. Imported reactions are dated to their message,
since Discord doesn't record when a reaction was added.

---

## Running 24/7 on the Pi (systemd)

The bot runs as a systemd **user** unit, so nothing here needs `sudo` and the
unit files are symlinked straight out of the repo — a `git pull` updates the
service definition along with the code.

### One-time setup

Install the system dependencies (sections 2 above), plus `gcc-12`:

```bash
sudo apt-get install -y gcc-12 g++-12 sqlite3
```

`@discordjs/opus` bundles an opus release that predates GCC 14, which turned
`-Wincompatible-pointer-types` and `-Wimplicit-function-declaration` into hard
errors. Debian 13 and Ubuntu 24.10+ default to GCC 14, so the native build is
pinned to 12. Upgrading the package doesn't help — 0.10.0 fails the same way.

Secrets live outside the repo, in `~/secrets/1984bot.env`, and are handed to the
service by `EnvironmentFile=`. Create it from `.env.example` — at minimum
`DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and an absolute `DATABASE_PATH`:

```bash
install -m 600 /dev/null ~/secrets/1984bot.env
```

For the failure alerts, `~/secrets/notify.env` needs `RESEND_API` and
`RESEND_EMAIL`. Then:

```bash
git clone git@github.com:tylergordon3/1984Bot.git ~/apps/1984Bot && cd ~/apps/1984Bot && ./deploy/pi-bootstrap.sh
```

That links the units, enables lingering (so the bot starts at boot without
anyone logging in), arms the timers, and runs the first deploy.

### Deploying afterwards

```bash
ssh <pi> 'cd ~/apps/1984Bot && ./deploy/pi-deploy.sh'
```

The script is idempotent: it skips `npm ci` unless the lockfile moved, skips
slash-command registration unless `src/commands` changed, restarts the unit and
then health-checks it, failing loudly with the last 40 log lines if the bot
didn't survive startup.

### Operating

```bash
systemctl --user status 1984bot
journalctl --user-unit=1984bot -f
```

Use `--user-unit=` rather than `--user -u`: the latter reads per-user journal
files that only exist once journald has flushed to persistent storage.

The service stops with `SIGTERM` so the bot closes any open voice/game sessions
cleanly before exiting, and gives up after 5 crashes in 5 minutes so a broken
deploy raises an alert instead of restarting forever.

### What runs on a schedule

| Timer | When | What |
|---|---|---|
| `1984bot-backup.timer` | 04:15 daily | `sqlite3 .backup` snapshot to `~/backups/1984bot`, integrity-checked, gzipped, pruned past 14 days |
| `ytdlp-update.timer` | Sundays 05:00 | `yt-dlp -U`, since YouTube changes break extraction with no warning |

Both are `Persistent=true`, so a run missed while the Pi was off happens at next
boot. Any unit that fails triggers `notify@`, which emails the last 40 log lines
via Resend.

The bot also schedules work of its own, inside the process rather than as
systemd units: severe weather is polled every minute, milestones are swept
every five minutes (the pairwise checks hourly), and the digest goes out at
`DIGEST_HOUR`. None of them replay after a restart — posted alerts, sent
editions and awarded milestones are all recorded in the database.

---

## Commands

**Music:** `/play` · `/skip` · `/stop` · `/pause` · `/resume` · `/queue` ·
`/nowplaying` · `/volume` · `/shuffle` · `/leave`

**Voice:**
- `/voicestats [user] [period]` — total time, alone vs with-others %, top companions, and time spent streaming / muted / deafened / on camera
- `/voiceleaderboard [period]` — who spent the most time in voice
- `/voiceheatmap [period]` — busiest hours of the day (server local time)
- `/voiceflag state:<streaming|muted|deafened|camera> [period]` — leaderboard for time spent in a given state

**Games:**
- `/gamestats [user] [period]` — a user's most-played games
- `/gameleaderboard [period]` — who logged the most total game time
- `/topgames [period]` — the server's most-played games

**Chat:**
- `/messagestats [user] [period] [channel]` — volume, average length, when and
  where they talk, plus who they tag and who tags them
- `/messageleaderboard [period] [channel] [after] [before]` — who talks the most.
  `after`/`before` are hours 0–23 in server local time, so *who messages the most
  after 2pm* is `/messageleaderboard after:14`, and *late night* is
  `after:22 before:4` (the range wraps past midnight)
- `/messageheatmap [period] [channel] [user]` — busiest hours of the day
- `/tagstats [user] [period]` — who tags this person the most, who they tag back,
  and where the tagging is most one-sided
- `/tagleaderboard [period]` — most-tagged people, biggest taggers, closest pairs

**Reactions & attendance:**
- `/reactionstats [user] [period]` — what they get reacted with, who reacts to
  them, who they react to, and their best-received message
- `/reactionleaderboard [period]` — most reacted to, biggest reactors, the
  server's most-used emoji, and the best-received messages
- `/streaks [user]` — current attendance streaks and the longest ever

**Reports:**
- `/digest [period]` — the Ministry's report for a period, the same one posted
  on a schedule
- `/records` — standing records and the milestones most recently filed

**Weather:**
- `/weather map [place]` — a map of every watch and warning in effect right now
  (all watched places if you don't name one)
- `/weather add place:<US town or address> [lat] [lon]` — watch somewhere new
- `/weather subscribe place:<place> [user]` · `/weather unsubscribe` — who gets
  pinged
- `/weather list` — every watched place and its subscribers
- `/weather remove place:<place>` — stop watching somewhere entirely

**SMITE** (off — see `SMITE_ENABLED`)**:**
- `/smite link profile:<name-or-url> [user]` — link your SMITE 2 identity.
  An exact in-game name (or `smite2.live/profile/...` URL) links smite2.live
  stats; a `smitesource.com/player/...` URL additionally links SmiteSource.
- `/smite stats [user]` — the stat card on demand
- `/smite unlink [user]` · `/smite list`

`period` is one of `day` / `week` / `month` / `year` / `all` (default `week`).

**@ the bot:** ping `@1984Bot` in any channel and it replies with something from
its files — your message count, your peak hour, who tags you most, or the tag
balance between you and anyone else you tagged in the same message. Tag someone
else and ask a question ("`@1984Bot who tags @alice the most?`") and it answers
about them. Replies are rate-limited to one per person every 8 seconds, and it
ignores `@everyone` and role pings. Set `MENTION_REPLIES=false` to turn it off.

---

## How tracking works

- **`voiceStateUpdate`** opens/closes rows in `voice_sessions`, and also in
  `voice_flags` for each active state (streaming / muted / deafened / camera);
  **`presenceUpdate`** does the same for `game_sessions`. These tables are the
  only source of truth. ("Muted" means mic-off-but-listening — a full deafen is
  counted as `deafened`, not double-counted as muted.)
- Every statistic (leaderboards, co-presence, alone time, hourly heatmap) is
  **derived at query time** by clamping sessions to the requested window, so no
  aggregates can drift.
- **`messageCreate`** writes one row per message to `messages`, plus a row in
  `message_mentions` for every person tagged. Messages are point events rather
  than sessions, so counts are plain aggregates over a window; hour-of-day is
  derived from the timestamp at query time in the server's local timezone.
  An @mention and a reply-ping to the *same* person in one message count as a
  single tag, never two.
- **Crash resilience:** a 60-second heartbeat stamps `last_seen_at` on open
  sessions. On startup the bot reconciles — adopting sessions for anyone still
  connected/playing and closing orphaned sessions at their last-seen time — so a
  reboot loses at most ~1 minute of data. For messages, startup also re-fetches
  anything posted in tracked channels while the bot was down (up to 1000 per
  channel), so short outages lose nothing at all.

## Privacy note

This bot records who is in voice with whom, what everyone plays, what everyone
says and who they say it to. That's the point ("1984"), but tell your members
it's running — some servers are required to. Chat logging can be narrowed to
specific channels with `MESSAGE_CHANNELS`, or the message content intent left
off so only metadata is kept. All data stays in the local
`data/1984bot.sqlite` file; nothing leaves the Pi.
