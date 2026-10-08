# Isolation env for a test server or test app. Source it, do not run it:
#   source scripts/isolated-env.sh <scratch-dir> [<dev-mlx-worker-path>]
# The scratch dir must be under /tmp or /private/tmp. See
# .claude/skills/live-testing/SKILL.md.
#
# Why a scratch HOME: the managed MLX worker (~/.cache/freestyle/mlx-asr) and
# the whisper cache use homedir(). The server refreshes the managed worker
# before each worker start even when OPENSTYLE_MLX_ASR_WORKER is set
# (apps/server/src/lib/mlx-asr/server.ts, updateManagedMlxRuntimeIfNeeded).
# This file does not change HOME in your shell. Start the server or app with
# `isolated_run <command>`, which sets HOME to the scratch home for that one
# command only.

if [ -z "${BASH_VERSION:-}${ZSH_VERSION:-}" ]; then
  echo "isolated-env: use bash or zsh" >&2
  # shellcheck disable=SC2317 # exit runs only when the file is executed, not sourced
  return 1 2>/dev/null || exit 1
fi
if [ -n "${BASH_VERSION:-}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "isolated-env: source this file: source scripts/isolated-env.sh <scratch-dir> [<worker>]" >&2
  exit 1
fi

_iso_setup() {
  local scratch=${1:-} worker=${2:-} resolved real_home
  if [ -z "$scratch" ]; then
    echo "isolated-env: usage: source scripts/isolated-env.sh <scratch-dir> [<dev-mlx-worker-path>]" >&2
    return 1
  fi
  case "$scratch" in
    *..*)
      echo "isolated-env: refused: '$scratch' contains '..'" >&2
      return 1
      ;;
    /tmp/?* | /private/tmp/?*) ;;
    *)
      echo "isolated-env: refused: '$scratch' is not under /tmp or /private/tmp" >&2
      return 1
      ;;
  esac
  mkdir -p "$scratch" || return 1
  resolved=$(cd "$scratch" && pwd -P) || return 1
  real_home=$(cd ~ && pwd -P)
  case "$resolved" in
    /private/tmp/?*) ;;
    *)
      echo "isolated-env: refused: '$scratch' resolves to '$resolved', not under /private/tmp" >&2
      return 1
      ;;
  esac
  case "$resolved" in
    "$real_home"/.cache/freestyle* | "$real_home"/.cache/huggingface* | "$real_home/Library/Application Support/Openstyle"*)
      echo "isolated-env: refused: '$resolved' is a real profile or cache path" >&2
      return 1
      ;;
  esac
  if [ -n "$worker" ] && [ ! -x "$worker" ]; then
    echo "isolated-env: refused: worker '$worker' is not an executable file" >&2
    return 1
  fi

  mkdir -p "$resolved/home" "$resolved/userdata" "$resolved/hf/hub" || return 1
  export OPENSTYLE_ISOLATED_HOME="$resolved/home"
  export OPENSTYLE_USER_DATA="$resolved/userdata"
  export OPENSTYLE_DB_PATH="$resolved/userdata/freestyle.db"
  export HF_HOME="$resolved/hf"
  export HUGGINGFACE_HUB_CACHE="$resolved/hf/hub"
  unset OPENSTYLE_LOG_DIR
  if [ -n "$worker" ]; then
    export OPENSTYLE_MLX_ASR_WORKER="$worker"
  else
    unset OPENSTYLE_MLX_ASR_WORKER
  fi

  echo "isolated-env: set"
  echo "  OPENSTYLE_ISOLATED_HOME=$OPENSTYLE_ISOLATED_HOME (HOME for isolated_run)"
  echo "  OPENSTYLE_USER_DATA=$OPENSTYLE_USER_DATA"
  echo "  OPENSTYLE_DB_PATH=$OPENSTYLE_DB_PATH"
  echo "  HF_HOME=$HF_HOME"
  echo "  HUGGINGFACE_HUB_CACHE=$HUGGINGFACE_HUB_CACHE"
  echo "  OPENSTYLE_MLX_ASR_WORKER=${OPENSTYLE_MLX_ASR_WORKER:-<unset: managed worker under the scratch HOME>}"
  echo "  OPENSTYLE_LOG_DIR=<unset>"
  echo "Start the server or app with: isolated_run <command>"
}

# Run one command with HOME set to the scratch home.
isolated_run() {
  if [ -z "${OPENSTYLE_ISOLATED_HOME:-}" ]; then
    echo "isolated_run: source scripts/isolated-env.sh <scratch-dir> first" >&2
    return 1
  fi
  HOME="$OPENSTYLE_ISOLATED_HOME" "$@"
}

_iso_setup "$@"
_iso_rc=$?
unset -f _iso_setup
return $_iso_rc
