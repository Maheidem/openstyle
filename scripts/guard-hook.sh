#!/usr/bin/env bash
# PreToolUse guard hook: enforces the isolation rules of
# .claude/skills/live-testing/SKILL.md. It reads the Claude Code hook JSON on
# stdin. To block, it prints one line on stderr and exits 2. Otherwise it
# exits 0. Tests: scripts/guard-hook.test.sh.
set -euo pipefail

SKILL=".claude/skills/live-testing/SKILL.md"

block() {
  echo "BLOCKED by guard hook ($1): $2 Read $SKILL." >&2
  exit 2
}

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
cwd=$(jq -r '.cwd // ""' <<<"$input")

# Owner paths that a test must never change. A scratch copy such as
# /tmp/x/home/.cache/freestyle does not match: the prefix must be the real home.
# shellcheck disable=SC2016 # literal $HOME and ~ in the regex
HOME_RE='(~|\$HOME|\$\{HOME\}|/Users/[^/[:space:]"'\'']+|/home/[^/[:space:]"'\'']+)'
END_RE='(/|"|'\''|[[:space:]]|$)'
PROTECTED_RE="(${HOME_RE}/\\.cache/(freestyle|huggingface)${END_RE}|Library/Application(\\\\? | )Support/Openstyle${END_RE}|/Applications/Openstyle\\.app${END_RE})"

is_protected_path() {
  local p=$1
  # shellcheck disable=SC2088 # a literal ~ for the regex
  [[ $p == "$HOME"/* ]] && p="~/${p#"$HOME"/}"
  [[ $p == "$HOME" ]] && p="~"
  [[ "$p " =~ $PROTECTED_RE ]]
}

# --- File tools: block a write to a protected path. ---
case "$tool" in
  Write | Edit | MultiEdit | NotebookEdit)
    while IFS= read -r path; do
      [[ -z $path ]] && continue
      if is_protected_path "$path"; then
        block "rule b" "$tool to $path changes the owner's app data or model cache."
      fi
    done < <(jq -r '[.tool_input.file_path, .tool_input.notebook_path, (.tool_input.edits // [] | .[].file_path)] | .[] | select(. != null)' <<<"$input")
    exit 0
    ;;
  Bash) ;;
  *) exit 0 ;;
esac

cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
[[ -z $cmd ]] && exit 0

# Rule a: the installed app owns port 4649.
if [[ $cmd =~ (127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):4649([^0-9]|$) ]] &&
  [[ $cmd =~ (^|[^[:alnum:]_-])(curl|wget|http|https|xh|nc|ncat|websocat|node|bun|deno|python3?|fetch)([^[:alnum:]_-]|$) ]]; then
  block "rule a" "port 4649 belongs to the installed app; start an isolated server on another port."
fi

# Rule e: only Qwen3-ASR and Qwen3.8-27B go to the owner's oMLX server.
if [[ $cmd =~ (127\.0\.0\.1|localhost):8123/v1/(audio/transcriptions|chat/completions) ]]; then
  models=$(grep -oE '(\\?"model\\?"[[:space:]]*:[[:space:]]*\\?"[^"\\]+|model=[^[:space:]"'\''&]+)' <<<"$cmd" |
    sed -E 's/.*[:=][[:space:]]*\\?"?//' || true)
  # A JSON body from a file (-d @body.json): read the model from the file.
  while IFS= read -r f; do
    [[ -z $f ]] && continue
    [[ $f != /* && -n $cwd ]] && f="$cwd/$f"
    if [[ -r $f && ! $f =~ \.(wav|aiff|mp3|m4a|flac|ogg|webm)$ ]]; then
      models+=$'\n'$(jq -r '.model // empty' "$f" 2>/dev/null || true)
    fi
  done < <(grep -oE '(-d|--data|--data-binary|--data-raw)[[:space:]]+@[^[:space:]"'\'']+' <<<"$cmd" | sed -E 's/.*@//' || true)
  models=$(grep -v '^[[:space:]]*$' <<<"$models" || true)
  if [[ -z $models ]]; then
    block "rule e" "the model sent to 127.0.0.1:8123 is not visible; put model=Qwen3-ASR or Qwen3.8-27B in the command."
  fi
  while IFS= read -r m; do
    base=$(tr '[:upper:]' '[:lower:]' <<<"${m##*/}")
    if [[ $base != "qwen3-asr" && $base != "qwen3.8-27b" ]]; then
      block "rule e" "model '$m' on the owner's oMLX server (127.0.0.1:8123); only Qwen3-ASR and Qwen3.8-27B are allowed."
    fi
  done <<<"$models"
fi

# kill $(pgrep ... Openstyle) is a kill by name of the installed app.
if [[ $cmd =~ (^|[^[:alnum:]_-])kill[[:space:]] ]] && [[ $cmd =~ pgrep[^\;\&\|]*[Oo]pen[Ss]tyle ]]; then
  block "rule f" "do not kill the installed app."
fi

# Strip the wrappers in front of the real command word of one segment.
command_word() {
  local s=$1 prev=""
  while [[ $s != "$prev" ]]; do
    prev=$s
    s="${s#"${s%%[![:space:]\(\{\"\']*}"}"
    if [[ $s =~ ^[A-Za-z_][A-Za-z0-9_]*=(\"[^\"]*\"|\'[^\']*\'|[^[:space:]]*)[[:space:]]+(.*)$ ]]; then
      s=${BASH_REMATCH[2]}
    elif [[ $s =~ ^(sudo|env|nohup|exec|time|command|builtin|xargs|caffeinate|rtk|proxy)[[:space:]]+(.*)$ ]]; then
      s=${BASH_REMATCH[2]}
    elif [[ $s =~ ^(timeout|gtimeout)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*[0-9.]+[smh]?[[:space:]]+(.*)$ ]]; then
      s=${BASH_REMATCH[3]}
    elif [[ $s =~ ^(ba|z)?sh[[:space:]]+-c[[:space:]]+(.*)$ ]]; then
      s=${BASH_REMATCH[2]}
    elif [[ $s =~ ^-[^[:space:]]*[[:space:]]+(.*)$ ]]; then
      s=${BASH_REMATCH[1]}
    fi
  done
  local w=${s%%[[:space:]]*}
  w=${w%%[\"\')]*}
  echo "${w##*/}"
}

# Split on ; && || | & newlines $( and backticks. Quotes are not parsed, so a
# separator inside a quoted string makes an extra segment. That only adds checks.
segments=$(perl -pe 's/\$\(|`|&&|\|\||[;|]/\n/g; s/(^|[^>])&(?!>)/$1\n/g' <<<"$cmd")

while IFS= read -r seg; do
  [[ -z ${seg//[[:space:]]/} ]] && continue
  word=$(command_word "$seg")

  case "$word" in
    # Rule c: audio playback.
    say)
      if ! [[ $seg =~ [[:space:]](-o|--output-file)([[:space:]=]|[^[:space:]]) ]]; then
        block "rule c" "'say' without -o plays through the owner's speakers; use say -v <voice> -o <file> \"text\"."
      fi
      ;;
    afplay)
      block "rule c" "audio playback (afplay) plays through the owner's speakers."
      ;;
    # Rule d: kill by name.
    pkill | killall)
      block "rule d" "$word kills by name and can hit the installed app or its worker; use kill <pid> of a process you started."
      ;;
    # Rule f: quit or launch the installed app.
    osascript)
      if [[ $seg =~ [Oo]pen[Ss]tyle ]]; then
        block "rule f" "do not quit or control the installed Openstyle app."
      fi
      ;;
    open)
      if [[ $seg =~ -a[[:space:]]+[\"\']?[Oo]pen[Ss]tyle || $seg =~ /Applications/Openstyle\.app || $seg =~ -b[[:space:]]+[^[:space:]]*openstyle ]]; then
        block "rule f" "do not launch the installed Openstyle app; launch a test build with launchOpenstyle (isolated profile)."
      fi
      ;;
    Openstyle)
      if [[ $seg =~ /Applications/Openstyle\.app/ ]]; then
        block "rule f" "do not launch the installed Openstyle app."
      fi
      ;;
  esac

  # Rule b: writes, deletes and moves under the owner's paths.
  if [[ $seg =~ $PROTECTED_RE ]]; then
    case "$word" in
      rm | rmdir | unlink | shred | trash | touch | mkdir | truncate | chmod | chown | chflags | ln | mv | tee | dd | xattr | defaults)
        block "rule b" "'$word' on a protected path (owner app data, model cache or installed app)."
        ;;
      cp | rsync | ditto | install | scp)
        last=$(awk '{print $NF}' <<<"$seg")
        if is_protected_path "${last//[\"\']/}"; then
          block "rule b" "'$word' into a protected path; copy into your scratch folder instead."
        fi
        ;;
      sed | perl)
        if [[ $seg =~ [[:space:]]-[[:alpha:]]*i ]]; then
          block "rule b" "in-place edit of a protected path."
        fi
        ;;
      find)
        if [[ $seg =~ -delete|-exec[[:space:]]+(rm|mv) ]]; then
          block "rule b" "find -delete/-exec on a protected path."
        fi
        ;;
      sqlite3)
        if ! [[ $seg =~ -readonly|mode=ro ]]; then
          block "rule b" "sqlite3 on the owner's DB without -readonly; use sqlite3 -readonly \"<db>\" \".backup <scratch>/copy.db\"."
        fi
        ;;
      tar | unzip | bsdtar)
        if [[ $seg =~ (-C|-d|--directory)[[:space:]=]+[\"\']?$PROTECTED_RE ]]; then
          block "rule b" "extract into a protected path."
        fi
        ;;
    esac
  fi
done <<<"$segments"

# Rule b: shell redirection into a protected path.
REDIRECT_RE=">>?[[:space:]]*[\"']?[^[:space:]\"';|&>]*$PROTECTED_RE"
if [[ $cmd =~ $REDIRECT_RE ]]; then
  block "rule b" "redirect into a protected path."
fi

exit 0
