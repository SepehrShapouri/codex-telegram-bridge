# Codex Telegram Bridge

Run Codex on your laptop and talk to it over Telegram without pushing your project to the cloud.

## What it does

- Polls Telegram from your laptop using a bot token
- Restricts access to explicit chat IDs and optional user IDs
- Starts and resumes real `codex exec` sessions per Telegram chat and path
- Persists the current path, active sessions, and preferred mode on disk
- Lets you switch folders naturally with `/cd` or messages like `go to ~/Desktop/project`
- Exposes remote commands for status, git context, session reset, and session selection
- Defaults to `write` mode and keeps shell execution disabled unless you opt in
- Uses Telegram drafts and chat actions for live progress in private chats
- Sends oversized outputs as attached text documents instead of flooding the chat

## Quick start

1. Create a Telegram bot with BotFather and copy the token.
2. Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN` and your Telegram chat ID.
3. Set `DEFAULT_PATH` if you want the bot to immediately use one project without asking.
4. Install dependencies with `npm install`.
5. Start the bridge with `npm run dev`.
6. Message your bot:
   - `/whoami` to confirm your chat and user IDs
   - If you set a default path, just say what you want done
   - Otherwise: `/cd "/absolute/path/to/project"`
   - Then just message the bot normally

## Commands

- `/help` shows available commands
- `/whoami` prints chat and user IDs for allowlisting
- `/cd <path>` switches the current path for the chat
- `/pwd` shows the current path
- `/sessions` lists recent Codex sessions from your laptop
- `/session <id>` attaches to a specific Codex session
- `/mode <read|write>` switches the preferred mode for the current chat
- `/new` starts a fresh Codex thread for the current path and mode
- `/status` shows path, mode, current session, and git summary
- `/diff` shows a git diff summary for the current path
- `/run <command>` runs a shell command only when `ENABLE_RUN_COMMAND=true`
- `/stop` stops the current in-flight Codex or shell task for the current chat
- Any non-command message is sent to Codex in the current path
- Plain English shortcuts also work: `start over`, `continue`, `what changed`, `status`, `go to ~/Desktop/project`

## Telegram UX

- In private chats, the bot uses Telegram draft updates to stream live progress states while Codex is working.
- The bot sends native Telegram activity states like `typing` while jobs are running.
- Large outputs such as long diffs or shell logs are attached as `.txt` documents with a short preview in chat.
- Risky `/run` commands require an inline confirmation button before execution.

## Notes

- Each chat gets its own session state.
- Mode changes are isolated by path and mode, so switching from `read` to `write` starts a separate Codex thread.
- The bridge uses long polling, so you do not need webhooks, tunnels, or port forwarding.
- If your local Codex state DB is noisy, the bridge still tracks the session `thread_id` it needs for resume.
- Startup fails closed if you leave both Telegram allowlists empty.
- `/stop` bypasses the normal chat queue so you can interrupt a long task immediately.
- Inline buttons keep common actions one tap away: `Status`, `Changed`, `Sessions`, `New`, and `Stop`.
- Risky `/run` commands require an explicit Telegram button confirmation.

## Production

For a laptop daemon on macOS:

1. Build once with `npm run build`.
2. Copy `.env.example` to `.env` and fill in the real values.
3. Run `./scripts/install-launchagent.sh`.
4. Check logs under `./logs`.

The launchd template lives at `launchd/com.sepiboi.codex-telegram-bridge.plist.template` and points at `/opt/homebrew/bin/node`. Adjust it if your Node binary lives elsewhere.
