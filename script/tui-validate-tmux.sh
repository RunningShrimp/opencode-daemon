#!/bin/zsh
set -euo pipefail

REPO="${REPO:-/Users/didi/Desktop/opencode/opencode-daemon}"
PACKAGE_DIR="$REPO/packages/opencode"
REAL_HOME="${REAL_HOME:-$HOME}"
REAL_CONFIG_DIR="${REAL_CONFIG_DIR:-$REAL_HOME/.config/opencode}"
REAL_DATA_DIR="${REAL_DATA_DIR:-$REAL_HOME/.local/share/opencode}"
REAL_COMPAT_DATA_DIR="${REAL_COMPAT_DATA_DIR:-$REAL_HOME/.local/share/opencoded}"
MODEL="${MODEL:-zhipuai-coding-plan/glm-5}"
MODEL_SLUG="${MODEL//\//-}"
MODEL_SLUG="${MODEL_SLUG//./-}"
MODEL_SLUG="${MODEL_SLUG// /-}"
if [[ -z "${BASE_ENV:-}" ]]; then
  case "$MODEL" in
    minimax-cn-coding-plan/MiniMax-M2.5) BASE_ENV="/tmp/opencode-tui-minimax-cn-coding-plan-MiniMax-M2-5" ;;
    *) BASE_ENV="/tmp/opencode-tui-glm" ;;
  esac
fi
if [[ ! -d "$BASE_ENV/home" || ! -d "$BASE_ENV/config" ]]; then
  FALLBACK_BASE_ENV="/tmp/opencode-tui-glm"
  if [[ "$BASE_ENV" != "$FALLBACK_BASE_ENV" && -d "$FALLBACK_BASE_ENV/home" && -d "$FALLBACK_BASE_ENV/config" ]]; then
    echo "BASE_ENV $BASE_ENV missing snapshot data, falling back to $FALLBACK_BASE_ENV" >&2
    BASE_ENV="$FALLBACK_BASE_ENV"
  fi
fi
TEST_ENV="${TEST_ENV:-/tmp/opencode-tui-${MODEL_SLUG}}"
if [[ "$BASE_ENV" == "$TEST_ENV" ]]; then
  FALLBACK_BASE_ENV="/tmp/opencode-tui-glm"
  if [[ "$BASE_ENV" != "$FALLBACK_BASE_ENV" && -d "$FALLBACK_BASE_ENV/home" && -d "$FALLBACK_BASE_ENV/config" ]]; then
    echo "BASE_ENV $BASE_ENV conflicts with TEST_ENV, falling back to $FALLBACK_BASE_ENV" >&2
    BASE_ENV="$FALLBACK_BASE_ENV"
  else
    echo "BASE_ENV must not match TEST_ENV: $BASE_ENV" >&2
    exit 1
  fi
fi
SESSION="${SESSION:-oc-tui-${MODEL_SLUG}}"
REPORT="${REPORT:-/tmp/tui-validate-${MODEL_SLUG}.txt}"
TMUX_BIN="${TMUX_BIN:-tmux}"
TMUX_SOCKET="${TMUX_SOCKET:-opencode-tui-${MODEL_SLUG}}"
PROMPT_TAG="${PROMPT_TAG:-${MODEL_SLUG}-ok}"
PROMPT_EXPECTED="${PROMPT_EXPECTED:-579}"
PROMPT_TEXT="${PROMPT_TEXT:-Please think briefly, compute 123 + 456, and reply with the number only.}"
if [[ -z "${START_WAIT_SECONDS:-}" ]]; then
  case "$MODEL" in
    minimax-cn-coding-plan/MiniMax-M2.5) START_WAIT_SECONDS=25 ;;
    *) START_WAIT_SECONDS=15 ;;
  esac
fi
COMMAND_WAIT_SECONDS="${COMMAND_WAIT_SECONDS:-2}"
if [[ -z "${RESPONSE_WAIT_SECONDS:-}" ]]; then
  case "$MODEL" in
    minimax-cn-coding-plan/MiniMax-M2.5) RESPONSE_WAIT_SECONDS=180 ;;
    *) RESPONSE_WAIT_SECONDS=60 ;;
  esac
fi
LOG_FILE_PRIMARY="$TEST_ENV/state/opencoded/log/dev.log"
LOG_FILE_LEGACY="$TEST_ENV/data/opencode/log/dev.log"
LOG_FILE="$LOG_FILE_PRIMARY"
INITIAL_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-initial.txt"
SESSION_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-session.txt"
SESSIONS_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-sessions.txt"
PROMPT_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-prompt.txt"
PIPE_LOG="/tmp/tui-validate-${MODEL_SLUG}-pipe.log"

tmux_cmd() {
  "$TMUX_BIN" -L "$TMUX_SOCKET" "$@"
}

rm -f "$REPORT" "$INITIAL_CAPTURE" "$SESSION_CAPTURE" "$SESSIONS_CAPTURE" "$PROMPT_CAPTURE" "$PIPE_LOG"
rm -rf "$TEST_ENV"
mkdir -p "$TEST_ENV/home" "$TEST_ENV/config" "$TEST_ENV/data" "$TEST_ENV/state" "$TEST_ENV/cache"

if [[ ! -d "$BASE_ENV/home" || ! -d "$BASE_ENV/config" ]]; then
  echo "Missing BASE_ENV snapshot: $BASE_ENV" >&2
  exit 1
fi

cp -R "$BASE_ENV/home/." "$TEST_ENV/home"
cp -R "$BASE_ENV/config/." "$TEST_ENV/config"

if [[ -d "$REAL_CONFIG_DIR" ]]; then
  mkdir -p "$TEST_ENV/config/opencode"
  cp -R "$REAL_CONFIG_DIR/." "$TEST_ENV/config/opencode"
fi

if [[ -f "$TEST_ENV/config/opencode/opencode.json" ]] && command -v jq >/dev/null 2>&1; then
  tmp_config="$TEST_ENV/config/opencode/opencode.json.tmp"
  jq --arg model "$MODEL" 'del(.plugin, .mcp) | .model = $model | .small_model = $model' "$TEST_ENV/config/opencode/opencode.json" > "$tmp_config"
  mv "$tmp_config" "$TEST_ENV/config/opencode/opencode.json"
fi

if [[ -d "$REAL_DATA_DIR" ]]; then
  mkdir -p "$TEST_ENV/data/opencode"
  cp -R "$REAL_DATA_DIR/." "$TEST_ENV/data/opencode"
fi

rm -rf "$TEST_ENV/data/opencode/models-cache"

if [[ -f "$REAL_COMPAT_DATA_DIR/auth.json" && ! -f "$TEST_ENV/data/opencode/auth.json" ]]; then
  mkdir -p "$TEST_ENV/data/opencode"
  cp "$REAL_COMPAT_DATA_DIR/auth.json" "$TEST_ENV/data/opencode/auth.json"
fi

tmux_cmd kill-server 2>/dev/null || true

tmux_cmd new-session -Ad -x 180 -y 50 -s "$SESSION" -c "$PACKAGE_DIR" \
  "env HOME='$TEST_ENV/home' XDG_DATA_HOME='$TEST_ENV/data' XDG_CONFIG_HOME='$TEST_ENV/config' XDG_STATE_HOME='$TEST_ENV/state' XDG_CACHE_HOME='$TEST_ENV/cache' OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 TERM=xterm-256color bun --conditions=browser src/index.ts '$REPO' --log-level DEBUG --model '$MODEL'"

tmux_cmd pipe-pane -o -t "$SESSION:0" "cat > $PIPE_LOG"
sleep 1

capture() {
  local target="$1"
  tmux_cmd capture-pane -ep -t "$SESSION:0" -S -240 > "$target"
}

capture_contains() {
  local target="$1"
  local needle="$2"
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g' "$target" | grep -Fq "$needle"
}

capture_matches_regex() {
  local target="$1"
  local pattern="$2"
  perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g' "$target" | grep -Eq "$pattern"
}

wait_for_capture_contains() {
  local target="$1"
  local needle="$2"
  local timeout="$3"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    capture "$target"
    if capture_contains "$target" "$needle"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_prompt_result() {
  local deadline=$((SECONDS + RESPONSE_WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    capture "$PROMPT_CAPTURE"
    if capture_matches_regex "$PROMPT_CAPTURE" "(^|[^0-9])${PROMPT_EXPECTED}([^0-9]|$)"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

capture "$INITIAL_CAPTURE"
if ! wait_for_capture_contains "$INITIAL_CAPTURE" "Build" "$START_WAIT_SECONDS"; then
  capture "$INITIAL_CAPTURE"
fi

tmux_cmd send-keys -l -t "$SESSION:0" "/session"
tmux_cmd send-keys -t "$SESSION:0" Enter
if ! wait_for_capture_contains "$SESSION_CAPTURE" "Sessions" "$COMMAND_WAIT_SECONDS"; then
  capture "$SESSION_CAPTURE"
fi

tmux_cmd send-keys -t "$SESSION:0" Escape
sleep 1
tmux_cmd send-keys -l -t "$SESSION:0" "/sessions"
tmux_cmd send-keys -t "$SESSION:0" Enter
if ! wait_for_capture_contains "$SESSIONS_CAPTURE" "Sessions" "$COMMAND_WAIT_SECONDS"; then
  capture "$SESSIONS_CAPTURE"
fi

tmux_cmd send-keys -t "$SESSION:0" Escape
sleep 1
tmux_cmd send-keys -l -t "$SESSION:0" "$PROMPT_TEXT"
tmux_cmd send-keys -t "$SESSION:0" Enter
PROMPT_STATUS="timeout"
if wait_for_prompt_result; then
  PROMPT_STATUS="received"
fi

PANE_PID="$(tmux_cmd display-message -p -t "$SESSION:0" '#{pane_pid}')"
PANE_META="$(tmux_cmd display-message -p -t "$SESSION:0" '#{pane_width}x#{pane_height} alternate=#{alternate_on} mode=#{pane_in_mode} dead=#{pane_dead}')"
INITIAL_RENDERED="no"
if capture_contains "$INITIAL_CAPTURE" "Build" || capture_contains "$INITIAL_CAPTURE" "Ask anything..."; then
  INITIAL_RENDERED="yes"
fi
SESSION_ALIAS_STATUS="unknown"
if capture_contains "$SESSION_CAPTURE" "Sessions"; then
  SESSION_ALIAS_STATUS="opened-dialog"
elif capture_contains "$SESSION_CAPTURE" "/session"; then
  SESSION_ALIAS_STATUS="not-resolved"
elif ! cmp -s "$INITIAL_CAPTURE" "$SESSION_CAPTURE"; then
  SESSION_ALIAS_STATUS="changed-ui"
fi
SESSIONS_STATUS="unknown"
if capture_contains "$SESSIONS_CAPTURE" "Sessions"; then
  SESSIONS_STATUS="opened-dialog"
elif ! cmp -s "$INITIAL_CAPTURE" "$SESSIONS_CAPTURE"; then
  SESSIONS_STATUS="changed-ui"
fi
THINKING_VISIBLE="no"
if capture_contains "$PROMPT_CAPTURE" 'Thinking:' || ([[ -f "$PIPE_LOG" ]] && capture_contains "$PIPE_LOG" 'Thinking:'); then
  THINKING_VISIBLE="yes"
fi
FINAL_VISIBLE="no"
if capture_matches_regex "$PROMPT_CAPTURE" "(^|[^0-9])${PROMPT_EXPECTED}([^0-9]|$)"; then
  FINAL_VISIBLE="yes"
fi
LOG_EXISTS="no"
ERROR_COUNT="0"
if [[ -f "$LOG_FILE" ]]; then
  LOG_EXISTS="yes"
  ERROR_COUNT="$(grep -Ec '^ERROR ' "$LOG_FILE" || true)"
elif [[ -f "$LOG_FILE_LEGACY" ]]; then
  LOG_FILE="$LOG_FILE_LEGACY"
  LOG_EXISTS="yes"
  ERROR_COUNT="$(grep -Ec '^ERROR ' "$LOG_FILE" || true)"
fi

{
  echo "model=$MODEL"
  echo "prompt_tag=$PROMPT_TAG"
  echo "prompt_expected=$PROMPT_EXPECTED"
  echo "response_wait_seconds=$RESPONSE_WAIT_SECONDS"
  echo "session=$SESSION"
  echo "test_env=$TEST_ENV"
  echo "pane_pid=$PANE_PID"
  echo "pane_meta=$PANE_META"
  echo "ps=$(ps -p "$PANE_PID" -o pid=,ppid=,state=,tty=,etime=,command=)"
  echo "initial_rendered=$INITIAL_RENDERED"
  echo "slash_session_status=$SESSION_ALIAS_STATUS"
  echo "slash_sessions_status=$SESSIONS_STATUS"
  echo "prompt_status=$PROMPT_STATUS"
  echo "thinking_visible=$THINKING_VISIBLE"
  echo "final_visible=$FINAL_VISIBLE"
  echo "log_exists=$LOG_EXISTS"
  echo "log_error_count=$ERROR_COUNT"
  echo ""
  echo "initial_capture_preview:"
  sed -n '1,50p' "$INITIAL_CAPTURE"
  echo ""
  echo "slash_session_capture_preview:"
  sed -n '1,50p' "$SESSION_CAPTURE"
  echo ""
  echo "slash_sessions_capture_preview:"
  sed -n '1,50p' "$SESSIONS_CAPTURE"
  echo ""
  echo "prompt_capture_preview:"
  sed -n '1,120p' "$PROMPT_CAPTURE"
  echo ""
  echo "log_file=$LOG_FILE"
  if [[ -f "$LOG_FILE" ]]; then
    echo "log_tail:"
    tail -n 120 "$LOG_FILE"
  fi
} > "$REPORT"

echo "$REPORT"

tmux_cmd kill-session -t "$SESSION" 2>/dev/null || true
tmux_cmd kill-server 2>/dev/null || true