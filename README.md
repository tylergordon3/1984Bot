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
- **It answers when you @ it** — with something it actually knows about you.

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
