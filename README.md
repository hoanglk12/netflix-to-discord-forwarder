# Netflix Email To Discord Forwarder

Local Node.js service for Windows that polls Gmail for Netflix emails and forwards them to a Discord webhook as rich embeds.

## Features

- Gmail polling with OAuth desktop flow and saved refresh token
- Smart message selection: forward latest 5 Netflix emails per run
- Duplicate detection: skip sending when all 5 latest IDs exactly match previous run
- Rich Discord embeds with sender details, timestamps, and previews
- Exponential backoff for transient Gmail and Discord failures
- Safe checkpoint writes for once-run history
- Web dashboard for easy configuration and manual triggers

## Requirements

- Node.js 20+
- A Google Cloud OAuth desktop client with Gmail API enabled
- A Discord webhook URL

## Setup

1. Install dependencies.

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your local values.

3. Put your Google OAuth client JSON somewhere local, for example `./secrets/gmail-oauth-client.json`.

4. Run the one-time authorization flow.

   ```powershell
   npm run auth
   ```

   This opens a browser, asks for consent, and stores the refresh token at `GMAIL_TOKEN_PATH`.

### Running

```powershell
npm run once
```

Sends the latest 5 Netflix-matching emails as of that run time. If the exact same 5 emails (by ID) were sent in the previous run, this run skips them.

### Web Dashboard

For ease of use, a web UI is available:

```powershell
npm run ui
```

Open `http://localhost:3000` in your browser. The dashboard lets you:
- View current configuration
- Manually trigger a run with one click
- **Update Discord webhook URL** without restarting
- See recent logs in real-time
- Check checkpoint status and history
- Monitor run results

The UI auto-refreshes every 5 seconds. Any changes to the webhook URL are saved to `.env` immediately and take effect on the next run.

## Configuration

Environment variables (set in `.env`):

### Required
- `GMAIL_OAUTH_CREDENTIALS_PATH`: path to the Google OAuth desktop client JSON (e.g., `./secrets/gmail-oauth-client.json`)
- `GMAIL_TOKEN_PATH`: path to the saved OAuth token JSON (created by `npm run auth`, e.g., `./secrets/gmail-token.json`)
- `DISCORD_WEBHOOK_URL`: Discord webhook URL where emails will be posted

### Optional
- `GMAIL_QUERY`: full Gmail search query (default: `in:inbox newer_than:1d` for last 24h)
- `GMAIL_SENDER_FILTER`: sender domain to filter by when using default query (default: `netflix.com`)
- `GMAIL_FETCH_LIMIT`: max recent messages to inspect per poll (default: `25`)
- `FORWARD_LATEST_COUNT`: number of latest matching emails to consider for sending (default: `5`)
- `CHECKPOINT_PATH`: local file storing run state (default: `./data/checkpoint.json`)
- `LOG_FILE_PATH`: application log file (default: `./output/app.log`)
- `CHECKPOINT_MAX_IDS`: max IDs to remember in checkpoint (default: `250`)

### Checkpoint Behavior

The checkpoint file stores the latest 5 message IDs from each run. If the current latest 5 IDs exactly match the previous run's 5 IDs, the messages are skipped.

## Verification

Run parser tests:

```powershell
npm test
```

### Manual Once-Mode Testing

1. Run `npm run once` and confirm the latest 5 matching emails appear in Discord.
2. Run `npm run once` again and confirm:
   - If no new emails arrived: nothing posts (duplicate-5 detection blocks them)
   - If new emails arrived: only the new ones post
3. Wait for a new Gmail message to arrive, then run `npm run once` to confirm it posts.
4. Test Discord webhook failure by breaking the webhook URL temporarily, then run `npm run once` to confirm retries and graceful error handling.

## Discord Embed Format

Each forwarded email appears as a rich Discord embed with:

- **Title**: Email subject (truncated to 256 chars)
- **Description**: Full email body with a quick Gmail link (up to 4000 chars)
- **Metadata Fields**:
  - Sender (display name + address)
  - Sender Email (extracted email address)
  - Received (Discord dynamic timestamp, shows absolute & relative time)
  - Preview (first 1000 chars of message, sanitized to prevent accidental @mentions)
- **Footer**: "Netflix Gmail Forwarder • [compact message ID]"
- **Timestamp**: Email's internal date
- **Color**: Netflix orange (14875136)

All content is safely truncated to stay within Discord limits. No attachments are included.