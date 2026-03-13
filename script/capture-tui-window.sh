#!/bin/zsh
set -euo pipefail

SESSION="${1:-oc-tui-minimax-cn-coding-plan-MiniMax-M2-5}"
OUTPUT="${2:-/Users/didi/Desktop/opencode/opencode-daemon/tmp/tui-proof.png}"
TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
ATTACH_SCRIPT="/tmp/attach-${SESSION}.zsh"

mkdir -p "$(dirname "$OUTPUT")"

cat > "$ATTACH_SCRIPT" <<EOF
#!/bin/zsh
exec "$TMUX_BIN" attach -t "$SESSION"
EOF
chmod +x "$ATTACH_SCRIPT"

WINDOW_ID="$(osascript - "$ATTACH_SCRIPT" <<'APPLESCRIPT' | tr -d '[:space:]'
on run argv
  set attachScript to item 1 of argv
  tell application "Terminal"
    activate
    do script "/bin/zsh " & quoted form of attachScript
    delay 3
    return id of front window
  end tell
end run
APPLESCRIPT
)"

screencapture -x -l "$WINDOW_ID" "$OUTPUT"
echo "$OUTPUT"