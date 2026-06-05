#!/bin/bash
# Helper: print recent updates from your Telegram bot so you can grab user/chat IDs.
# Usage:
#   1. Create your bot via @BotFather, get a token like 1234567890:AAH...
#   2. Open Telegram, send any message to your new bot
#   3. Run this script with the token (or have TELEGRAM_BOT_TOKEN exported):
#        ./tools/get-chat-id.sh                    # uses $TELEGRAM_BOT_TOKEN
#        ./tools/get-chat-id.sh 1234567890:AAH...  # explicit token
#
# Output shows: from.id (your user_id), chat.id, and chat.type for every recent message.

set -e

TOKEN="${1:-$TELEGRAM_BOT_TOKEN}"
if [ -z "$TOKEN" ]; then
    if [ -f "$HOME/.nexus/secrets.env" ]; then
        TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$HOME/.nexus/secrets.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    fi
fi
if [ -z "$TOKEN" ]; then
    echo "[error] No token. Pass as arg or set TELEGRAM_BOT_TOKEN in environment / ~/.nexus/secrets.env"
    exit 1
fi

echo "Fetching updates..."
RESP=$(curl -sf "https://api.telegram.org/bot${TOKEN}/getUpdates" || true)
if [ -z "$RESP" ]; then
    echo "[error] empty response from telegram (token bad or network down)"
    exit 1
fi

echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if not d.get('ok'):
    print('[error]', d.get('description', d))
    sys.exit(1)
results = d.get('result', [])
if not results:
    print('No updates yet. Send a message to your bot first, then re-run.')
    sys.exit(0)
seen_users = set()
seen_chats = set()
for upd in results:
    msg = upd.get('message') or upd.get('edited_message') or {}
    frm = msg.get('from', {})
    chat = msg.get('chat', {})
    uid = frm.get('id')
    name = (frm.get('first_name', '') + ' ' + frm.get('last_name', '')).strip() or frm.get('username', '?')
    cid = chat.get('id')
    ctype = chat.get('type', '?')
    title = chat.get('title') or chat.get('username') or name
    key = (uid, cid)
    if key in seen_users: continue
    seen_users.add(key)
    print(f'  user_id={uid:<15} ({name})')
    print(f'    chat_id={cid:<15} type={ctype:<10} \"{title}\"')
    print()
print('Add the user_id to allowlist.users in config.json.')
print('For groups, add the (negative) chat_id to allowlist.groups.')
"
