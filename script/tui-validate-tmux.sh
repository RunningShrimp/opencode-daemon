#!/bin/zsh
set -euo pipefail

REPO="${REPO:-/Users/didi/Desktop/opencode/opencode-daemon}"
PACKAGE_DIR="$REPO/packages/opencode"
LAUNCH_MODE="${LAUNCH_MODE:-source}"
REAL_HOME="${REAL_HOME:-$HOME}"
REAL_CONFIG_DIR="${REAL_CONFIG_DIR:-$REAL_HOME/.config/opencode}"
REAL_DATA_DIR="${REAL_DATA_DIR:-$REAL_HOME/.local/share/opencode}"
REAL_COMPAT_DATA_DIR="${REAL_COMPAT_DATA_DIR:-$REAL_HOME/.local/share/opencoded}"
MODEL="${MODEL:-zhipuai-coding-plan/glm-5}"
MODEL_SLUG="${MODEL//\//-}"
MODEL_SLUG="${MODEL_SLUG//./-}"
MODEL_SLUG="${MODEL_SLUG// /-}"
RUN_ID="${RUN_ID:-$(date +%s)-$$}"
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
TEST_ENV="${TEST_ENV:-/tmp/opencode-tui-${MODEL_SLUG}-${RUN_ID}}"
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
SESSION="${SESSION:-oc-tui-${MODEL_SLUG}-${RUN_ID}}"
REPORT="${REPORT:-/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}.txt}"
TMUX_BIN="${TMUX_BIN:-tmux}"
TMUX_SOCKET="${TMUX_SOCKET:-opencode-tui-${MODEL_SLUG}-${RUN_ID}}"
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  aarch64) HOST_ARCH="arm64" ;;
  x86_64) HOST_ARCH="x64" ;;
esac
BINARY_PATH="${BINARY_PATH:-$PACKAGE_DIR/dist/opencode-${HOST_OS}-${HOST_ARCH}/bin/opencoded}"
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
LOG_DIR_PRIMARY="$TEST_ENV/state/opencoded/log"
LOG_DIR_LEGACY="$TEST_ENV/data/opencode/log"
LOG_FILE_PRIMARY="$LOG_DIR_PRIMARY/dev.log"
LOG_FILE_LEGACY="$LOG_DIR_LEGACY/dev.log"
LOG_FILE="$LOG_FILE_PRIMARY"
DB_FILE="$TEST_ENV/data/opencode/opencode-dev.db"
INITIAL_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}-initial.txt"
SESSION_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}-session.txt"
SESSIONS_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}-sessions.txt"
PROMPT_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}-prompt.txt"
FINAL_CAPTURE="/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}-final.txt"
PIPE_LOG="/tmp/tui-validate-${MODEL_SLUG}-${RUN_ID}-pipe.log"
SESSION_DB_ID=""

tmux_cmd() {
  "$TMUX_BIN" -L "$TMUX_SOCKET" "$@"
}

cleanup() {
  local pane_pid=""
  if [[ "${KEEP_SESSION:-0}" != "1" ]]; then
    pane_pid="$(tmux_cmd display-message -p -t "$SESSION:0" '#{pane_pid}' 2>/dev/null || true)"
    tmux_cmd kill-server 2>/dev/null || true
    if [[ -n "$pane_pid" ]]; then
      kill "$pane_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pane_pid" 2>/dev/null || true
    fi
  fi
}

trap cleanup EXIT

rm -f "$REPORT" "$INITIAL_CAPTURE" "$SESSION_CAPTURE" "$SESSIONS_CAPTURE" "$PROMPT_CAPTURE" "$FINAL_CAPTURE" "$PIPE_LOG"
rm -rf "$TEST_ENV"
mkdir -p "$TEST_ENV/home" "$TEST_ENV/config" "$TEST_ENV/data" "$TEST_ENV/state" "$TEST_ENV/cache"

if [[ ! -d "$BASE_ENV/home" || ! -d "$BASE_ENV/config" ]]; then
  echo "Missing BASE_ENV snapshot: $BASE_ENV" >&2
  exit 1
fi

case "$LAUNCH_MODE" in
  source)
    LAUNCH_CMD="bun --conditions=browser src/index.ts '$REPO' --log-level DEBUG --model '$MODEL'"
    ;;
  binary)
    if [[ ! -x "$BINARY_PATH" ]]; then
      echo "Binary not found or not executable: $BINARY_PATH" >&2
      exit 1
    fi
    LAUNCH_CMD="'$BINARY_PATH' '$REPO' --log-level DEBUG --model '$MODEL'"
    ;;
  *)
    echo "Unsupported LAUNCH_MODE: $LAUNCH_MODE" >&2
    exit 1
    ;;
esac

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

rm -rf "$TEST_ENV/data/opencode/log"
rm -rf "$TEST_ENV/data/opencoded/log"
rm -rf "$TEST_ENV/state/opencoded/log"
rm -rf "$TEST_ENV/data/opencode/sochdb"
rm -f "$TEST_ENV/data/opencode/opencode-dev.db"
rm -rf "$TEST_ENV/data/opencode/models-cache"

if [[ -f "$REAL_COMPAT_DATA_DIR/auth.json" && ! -f "$TEST_ENV/data/opencode/auth.json" ]]; then
  mkdir -p "$TEST_ENV/data/opencode"
  cp "$REAL_COMPAT_DATA_DIR/auth.json" "$TEST_ENV/data/opencode/auth.json"
fi

tmux_cmd kill-server 2>/dev/null || true

tmux_cmd new-session -Ad -x 180 -y 50 -s "$SESSION" -c "$PACKAGE_DIR" \
  "env HOME='$TEST_ENV/home' XDG_DATA_HOME='$TEST_ENV/data' XDG_CONFIG_HOME='$TEST_ENV/config' XDG_STATE_HOME='$TEST_ENV/state' XDG_CACHE_HOME='$TEST_ENV/cache' OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 TERM=xterm-256color $LAUNCH_CMD"

tmux_cmd pipe-pane -o -t "$SESSION:0" "cat > $PIPE_LOG"
sleep 1

capture() {
  local target="$1"
  local primary="${target}.primary"
  local alternate="${target}.alternate"
  tmux_cmd capture-pane -ep -t "$SESSION:0" -S -240 > "$primary" 2>/dev/null || :
  tmux_cmd capture-pane -aep -t "$SESSION:0" -S -240 > "$alternate" 2>/dev/null || :

  if [[ ! -s "$primary" && -s "$alternate" ]]; then
    mv "$alternate" "$target"
    rm -f "$primary"
    return
  fi

  mv "$primary" "$target"
  rm -f "$alternate"
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

sql_escape() {
  local value="$1"
  print -nr -- "${value//\'/\'\'}"
}

resolve_session_db_id() {
  if [[ -n "$SESSION_DB_ID" ]]; then
    return 0
  fi
  if ! command -v sqlite3 >/dev/null 2>&1 || [[ ! -f "$DB_FILE" ]]; then
    return 1
  fi
  local latest
  latest="$(sqlite3 -noheader "$DB_FILE" 'select id from session order by time_created desc limit 1;' 2>/dev/null | tr -d '\r')"
  if [[ -z "$latest" ]]; then
    return 1
  fi
  SESSION_DB_ID="$latest"
  return 0
}

assistant_marker_seen() {
  resolve_session_db_id || return 1
  local session_sql marker_sql count
  session_sql="$(sql_escape "$SESSION_DB_ID")"
  marker_sql="$(sql_escape "$PROMPT_EXPECTED")"
  count="$(sqlite3 -noheader "$DB_FILE" "select count(1) from message m join part p on p.message_id = m.id where m.session_id = '$session_sql' and json_extract(m.data,'$.role') = 'assistant' and json_extract(p.data,'$.type') = 'text' and coalesce(json_extract(p.data,'$.text'),'') like '%$marker_sql%';" 2>/dev/null | tr -d '\r')"
  [[ "${count:-0}" != "0" ]]
}

assistant_final_text() {
  resolve_session_db_id || return 1
  local session_sql
  session_sql="$(sql_escape "$SESSION_DB_ID")"
  sqlite3 -noheader "$DB_FILE" "select coalesce(json_extract(p.data,'$.text'),'') from message m join part p on p.message_id = m.id where m.session_id = '$session_sql' and json_extract(m.data,'$.role') = 'assistant' and json_extract(p.data,'$.type') = 'text' order by m.time_created desc, p.time_created desc limit 1;" 2>/dev/null
}

assistant_emitted_capabilities() {
  resolve_session_db_id || return 1
  local session_sql
  session_sql="$(sql_escape "$SESSION_DB_ID")"
  sqlite3 -noheader "$DB_FILE" "select distinct json_extract(p.data,'$.state.metadata.capability') from message m join part p on p.message_id = m.id where m.session_id = '$session_sql' and json_extract(m.data,'$.role') = 'assistant' and json_extract(p.data,'$.type') = 'tool' and json_extract(p.data,'$.state.metadata.capability') is not null order by 1;" 2>/dev/null
}

resolve_log_file() {
  if [[ -f "$LOG_FILE_PRIMARY" ]]; then
    LOG_FILE="$LOG_FILE_PRIMARY"
    return 0
  fi
  if [[ -f "$LOG_FILE_LEGACY" ]]; then
    LOG_FILE="$LOG_FILE_LEGACY"
    return 0
  fi
  local matches=()
  matches=("$LOG_DIR_PRIMARY"/*.log(Nom[1]))
  if (( ${#matches[@]} > 0 )); then
    LOG_FILE="$matches[1]"
    return 0
  fi
  matches=("$LOG_DIR_LEGACY"/*.log(Nom[1]))
  if (( ${#matches[@]} > 0 )); then
    LOG_FILE="$matches[1]"
    return 0
  fi
  return 1
}

wait_for_runtime_ready() {
  local target="$1"
  local timeout="$2"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    capture "$target"
    if capture_contains "$target" "Build" || capture_contains "$target" "Ask anything" || capture_contains "$target" "Sisyphus"; then
      return 0
    fi
    if resolve_log_file; then
      if grep -Fq 'path=/command request' "$LOG_FILE" && grep -Fq 'path=/session/status request' "$LOG_FILE"; then
        sleep 2
        capture "$target"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
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

wait_for_assistant_result() {
  local deadline=$((SECONDS + RESPONSE_WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    capture "$FINAL_CAPTURE"
    if assistant_marker_seen; then
      sleep 2
      capture "$FINAL_CAPTURE"
      return 0
    fi
    sleep 1
  done
  return 1
}

capture "$INITIAL_CAPTURE"
if ! wait_for_runtime_ready "$INITIAL_CAPTURE" "$START_WAIT_SECONDS"; then
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
sleep 1
capture "$PROMPT_CAPTURE"
PROMPT_STATUS="timeout"
if wait_for_assistant_result; then
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
if capture_contains "$PROMPT_CAPTURE" 'Thinking:' || capture_contains "$FINAL_CAPTURE" 'Thinking:' || ([[ -f "$PIPE_LOG" ]] && capture_contains "$PIPE_LOG" 'Thinking:'); then
  THINKING_VISIBLE="yes"
fi
FINAL_VISIBLE="no"
if assistant_marker_seen; then
  FINAL_VISIBLE="yes"
fi
LOG_EXISTS="no"
ERROR_COUNT="0"
if resolve_log_file; then
  LOG_EXISTS="yes"
  ERROR_COUNT="$(grep -Ec '^ERROR ' "$LOG_FILE" || true)"
fi
ASSISTANT_FINAL_TEXT=""
EMITTED_CAPABILITIES=""
if resolve_session_db_id; then
  ASSISTANT_FINAL_TEXT="$(assistant_final_text || true)"
  EMITTED_CAPABILITIES="$(assistant_emitted_capabilities | paste -sd ',' - || true)"
fi

{
  echo "model=$MODEL"
  echo "launch_mode=$LAUNCH_MODE"
  echo "binary_path=$BINARY_PATH"
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
  echo "session_db_id=$SESSION_DB_ID"
  echo "emitted_capabilities=$EMITTED_CAPABILITIES"
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
  echo "final_capture_preview:"
  sed -n '1,120p' "$FINAL_CAPTURE"
  echo ""
  echo "assistant_final_text_preview:"
  printf '%s\n' "$ASSISTANT_FINAL_TEXT" | sed -n '1,80p'
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