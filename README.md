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

Designed to run passively on a Raspberry Pi with a single SQLite file for storage.

---

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it `1984Bot`.
2. **Bot** tab → **Reset Token** → copy the token (this is `DISCORD_TOKEN`).
3. Still on the **Bot** tab, enable both **Privileged Gateway Intents**:
   - ✅ **Presence Intent** (required for game tracking)
   - ✅ **Server Members Intent** (required for co-presence & member data)
4. **General Information** tab → copy the **Application ID** (this is `CLIENT_ID`).
5. Invite the bot: **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`,
   bot permissions: *View Channels, Connect, Speak, Send Messages, Embed Links*.
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

---

## Running 24/7 on the Pi (systemd)

```bash
sudo cp deploy/1984bot.service /etc/systemd/system/1984bot.service
sudo nano /etc/systemd/system/1984bot.service   # set User + WorkingDirectory + node path
sudo systemctl daemon-reload
sudo systemctl enable --now 1984bot
journalctl -u 1984bot -f                          # live logs
```

The service uses `SIGTERM` on stop so the bot closes any open voice/game sessions
cleanly before exiting.

---

## Commands

**Music:** `/play` · `/skip` · `/stop` · `/pause` · `/resume` · `/queue` ·
`/nowplaying` · `/volume` · `/shuffle` · `/leave`

**Voice:**
- `/voicestats [user] [period]` — total time, alone vs with-others %, top companions
- `/voiceleaderboard [period]` — who spent the most time in voice
- `/voiceheatmap [period]` — busiest hours of the day (server local time)

**Games:**
- `/gamestats [user] [period]` — a user's most-played games
- `/gameleaderboard [period]` — who logged the most total game time
- `/topgames [period]` — the server's most-played games

`period` is one of `day` / `week` / `month` / `year` / `all` (default `week`).

---

## How tracking works

- **`voiceStateUpdate`** opens/closes rows in `voice_sessions`; **`presenceUpdate`**
  does the same for `game_sessions`. These two tables are the only source of truth.
- Every statistic (leaderboards, co-presence, alone time, hourly heatmap) is
  **derived at query time** by clamping sessions to the requested window, so no
  aggregates can drift.
- **Crash resilience:** a 60-second heartbeat stamps `last_seen_at` on open
  sessions. On startup the bot reconciles — adopting sessions for anyone still
  connected/playing and closing orphaned sessions at their last-seen time — so a
  reboot loses at most ~1 minute of data.

## Privacy note

This bot records who is in voice with whom and what everyone plays. That's the
point ("1984"), but tell your members it's running — some servers are required to.
All data stays in the local `data/1984bot.sqlite` file; nothing leaves the Pi.
