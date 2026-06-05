#!/bin/bash
# dev-session.sh — Runs a Claude Code development session in the background
# Called by Nexus when a build/develop task is delegated.
#
# Usage: dev-session.sh <session-id> <working-dir> <prompt-file> <telegram-chat-id>
#
# Flow:
# 1. Runs `claude -p` with the prompt in the specified working directory
# 2. Monitors progress (timeout: 20 minutes)
# 3. Sends Telegram notification when done (success or failure)
# 4. Writes result to a log file for Nexus to read

set -e

SESSION_ID="$1"
WORK_DIR="$2"
PROMPT_FILE="$3"
CHAT_ID="$4"

if [ -z "$SESSION_ID" ] || [ -z "$WORK_DIR" ] || [ -z "$PROMPT_FILE" ] || [ -z "$CHAT_ID" ]; then
  echo "Usage: dev-session.sh <session-id> <working-dir> <prompt-file> <chat-id>"
  exit 1
fi

# Load secrets for Telegram notifications
source ~/.nexus/secrets.env 2>/dev/null || true
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"

LOG_DIR="$HOME/.nexus/dev-sessions"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${SESSION_ID}.json"
STATUS_FILE="$LOG_DIR/${SESSION_ID}.status"

# Send Telegram message
send_tg() {
  local msg="$1"
  if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\": \"${CHAT_ID}\", \"text\": \"${msg}\"}" > /dev/null 2>&1 || true
  fi
}

# Mark as running
echo "running" > "$STATUS_FILE"
send_tg "🔨 Dev session started: ${SESSION_ID}\\nWorking in: ${WORK_DIR}\\nI'll notify you when it's done."

# Read prompt
PROMPT="$(cat "$PROMPT_FILE")"

# Run Claude Code
cd "$WORK_DIR"

RESULT=$(claude -p \
  --output-format json \
  --permission-mode bypassPermissions \
  --model sonnet \
  --max-budget-usd 5 \
  "$PROMPT" 2>/dev/null) || true

# Parse result
if [ -z "$RESULT" ]; then
  echo "{\"session_id\": \"${SESSION_ID}\", \"status\": \"error\", \"error\": \"No output from Claude Code\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$LOG_FILE"
  echo "error" > "$STATUS_FILE"
  send_tg "❌ Dev session failed: ${SESSION_ID}\\nNo output from Claude Code (likely timeout)."
  exit 1
fi

# Write full result
echo "$RESULT" > "$LOG_FILE"

# Check if error
IS_ERROR=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('is_error', False))" 2>/dev/null || echo "False")
COST=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"\${d.get('total_cost_usd', 0):.2f}\")" 2>/dev/null || echo "unknown")
TURNS=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('num_turns', '?'))" 2>/dev/null || echo "?")
RESPONSE=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('result',''); print(r[:500])" 2>/dev/null || echo "")

if [ "$IS_ERROR" = "True" ]; then
  echo "error" > "$STATUS_FILE"
  send_tg "❌ Dev session failed: ${SESSION_ID}\\nError: ${RESPONSE:0:200}\\nCost: ${COST}"
else
  echo "done" > "$STATUS_FILE"
  # Truncate response for Telegram (max ~4000 chars)
  TG_RESPONSE="${RESPONSE:0:800}"
  send_tg "✅ Dev session complete: ${SESSION_ID}\\nTurns: ${TURNS} | Cost: ${COST}\\n\\n${TG_RESPONSE}"
fi
