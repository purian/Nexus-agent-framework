#!/bin/bash
# Bootstrap for nexus-runner.
# - Sources secrets from ~/.nexus/secrets.env
# - Sets timezone (so the cron scheduler fires at the right local time)
# - Execs node on the built runner
#
# Used both for manual `./start.sh` and as the launchd ProgramArguments target.

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SECRETS="$HOME/.nexus/secrets.env"
if [ ! -f "$SECRETS" ]; then
    echo "[error] $SECRETS not found. Create it with:"
    echo "  TELEGRAM_BOT_TOKEN=..."
    echo "  ANTHROPIC_API_KEY=..."
    echo "  TZ=Asia/Jerusalem    # or your timezone"
    exit 1
fi

# Source the env file (POSIX-compliant export)
set -a
# shellcheck disable=SC1090
source "$SECRETS"
set +a

# Default timezone if not set in secrets.env
export TZ="${TZ:-Asia/Jerusalem}"

# Find node — launchd has a minimal PATH so we can't rely on `node` being found.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    for candidate in \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node" \
        ; do
        if [ -x "$candidate" ]; then
            NODE_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "[error] node not found in PATH or standard locations"
    exit 1
fi

if [ ! -f "$DIR/dist/runner.js" ]; then
    echo "[error] dist/runner.js not built. Run: npm install && npm run build"
    exit 1
fi

echo "[start] $(date) — node=$NODE_BIN tz=$TZ"
exec "$NODE_BIN" "$DIR/dist/runner.js"
