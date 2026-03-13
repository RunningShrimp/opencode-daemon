#!/bin/zsh
set -euo pipefail

REPO="${REPO:-/Users/didi/Desktop/opencode/opencode-daemon}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO/tmp}"

mkdir -p "$OUTPUT_DIR"

strip_ansi() {
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g' "$1"
}

write_proof() {
  local name="$1"
  local model="$2"
  local report="$3"
  local initial="$4"
  local session="$5"
  local prompt="$6"
  local out="$OUTPUT_DIR/${name}-tui-proof.txt"

  {
    echo "model=${model}"
    echo "generated_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
    echo
    echo "=== report summary ==="
    sed -n '1,16p' "$report"
    echo
    echo "=== initial screen ==="
    strip_ansi "$initial"
    echo
    echo "=== /session dialog ==="
    strip_ansi "$session"
    echo
    echo "=== prompt render ==="
    strip_ansi "$prompt"
  } > "$out"

  echo "$out"
}

write_proof \
  glm \
  zhipuai-coding-plan/glm-5 \
  /tmp/tui-validate-zhipuai-coding-plan-glm-5.txt \
  /tmp/tui-validate-zhipuai-coding-plan-glm-5-initial.txt \
  /tmp/tui-validate-zhipuai-coding-plan-glm-5-session.txt \
  /tmp/tui-validate-zhipuai-coding-plan-glm-5-prompt.txt

write_proof \
  minimax \
  minimax-cn-coding-plan/MiniMax-M2.5 \
  /tmp/tui-validate-minimax-cn-coding-plan-MiniMax-M2-5.txt \
  /tmp/tui-validate-minimax-cn-coding-plan-MiniMax-M2-5-initial.txt \
  /tmp/tui-validate-minimax-cn-coding-plan-MiniMax-M2-5-session.txt \
  /tmp/tui-validate-minimax-cn-coding-plan-MiniMax-M2-5-prompt.txt