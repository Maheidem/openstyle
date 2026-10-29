#!/usr/bin/env bash
# Table test for scripts/guard-hook.sh. No network: it only pipes hook JSON
# into the script and checks the exit code (0 = allow, 2 = block).
# Run: bash scripts/guard-hook.test.sh
set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/guard-hook.sh"
pass=0
fail=0

# expect | tool | command or file path
CASES=$(
  cat <<'EOF'
block|Bash|timeout 5 curl -s http://127.0.0.1:4649/api/health
block|Bash|curl localhost:4649/api/settings
block|Bash|node -e "fetch('http://127.0.0.1:4649/api/health')"
block|Bash|wget -qO- http://127.0.0.1:4649/
allow|Bash|grep -rn "localhost:4649" apps/electron/src
allow|Bash|lsof -nP -iTCP:4649 -sTCP:LISTEN
allow|Bash|timeout 30 curl -s http://127.0.0.1:4651/api/health
allow|Bash|timeout 30 curl -s http://127.0.0.1:46490/x
block|Bash|rm -rf ~/.cache/freestyle/mlx-asr/runtime
block|Bash|rm -rf "$HOME/.cache/huggingface/hub/models--x"
block|Bash|mv ~/.cache/freestyle/whisper-models /tmp/x
block|Bash|cp -R /tmp/w/runtime ~/.cache/freestyle/mlx-asr/
block|Bash|touch "$HOME/Library/Application Support/Openstyle/x"
block|Bash|rm ~/Library/Application\ Support/Openstyle/freestyle.db
block|Bash|sqlite3 "$HOME/Library/Application Support/Openstyle/freestyle.db" "delete from meetings"
block|Bash|echo hi > ~/.cache/freestyle/x
block|Bash|echo hi >> "/Users/someone/Library/Application Support/Openstyle/settings.json"
block|Bash|find ~/.cache/huggingface -name '*.lock' -delete
block|Bash|sed -i '' 's/a/b/' "$HOME/Library/Application Support/Openstyle/settings.json"
block|Bash|tar -xzf w.tgz -C ~/.cache/freestyle/mlx-asr
block|Bash|rm -rf /Applications/Openstyle.app
block|Bash|ls /tmp && rm -rf ~/.cache/freestyle/x
allow|Bash|ls ~/.cache/freestyle
allow|Bash|ls -la "$HOME/Library/Application Support/Openstyle"
allow|Bash|du -sh ~/.cache/huggingface/hub
allow|Bash|cat ~/.cache/freestyle/mlx-asr/runtime/VERSION
allow|Bash|stat /Applications/Openstyle.app
allow|Bash|defaults read /Applications/Openstyle.app/Contents/Info.plist CFBundleShortVersionString
allow|Bash|defaults read-type /Applications/Openstyle.app/Contents/Info.plist CFBundleVersion
block|Bash|defaults write /Applications/Openstyle.app/Contents/Info.plist LSUIElement -bool true
block|Bash|defaults delete "$HOME/Library/Application Support/Openstyle/x.plist"
block|Bash|defaults import /Applications/Openstyle.app/Contents/Info.plist /tmp/x.plist
allow|Bash|sqlite3 -readonly "$HOME/Library/Application Support/Openstyle/freestyle.db" ".backup /tmp/t/copy.db"
allow|Bash|cp -R ~/.cache/freestyle/mlx-asr/runtime /tmp/t/home/.cache/freestyle/mlx-asr/
allow|Bash|rm -rf /tmp/t/home/.cache/freestyle
allow|Bash|rm -rf ~/.cache/freestyle-scratch
allow|Bash|tar -czf /tmp/t/w.tgz ~/.cache/freestyle/mlx-asr/runtime
block|Bash|say hello
block|Bash|say -v Samantha "The quick brown fox"
block|Bash|cd /tmp && say hi
block|Bash|afplay /nonexistent.aiff
block|Bash|bash -c "say hi"
allow|Bash|say -v Samantha -o /tmp/t/en.aiff "The quick brown fox"
allow|Bash|say -o x.aiff hi
allow|Bash|say --output-file=/tmp/t/x.aiff hi
allow|Bash|echo say hello
allow|Bash|grep -rn "afplay" .claude
block|Bash|pkill -f mlx_asr_worker
block|Bash|killall node
block|Bash|sudo killall Openstyle
block|Bash|kill $(pgrep -f Openstyle)
block|Bash|rtk rm -rf ~/.cache/freestyle/x
block|Bash|rtk proxy pkill -f node
allow|Bash|kill 1234
allow|Bash|kill $(cat /tmp/t/server.pid)
allow|Bash|pgrep -fl mlx_asr_worker
allow|Bash|curl -s http://127.0.0.1:8123/v1/audio/transcriptions -F file=@a.wav -F model=Qwen3-ASR
allow|Bash|timeout 8 curl -s http://127.0.0.1:8123/v1/models
allow|Bash|timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models
allow|Bash|grep -rn "127.0.0.1:8123" scripts
allow|Bash|timeout 30 curl -s http://127.0.0.1:81230/x
allow|Bash|timeout 30 curl -s http://127.0.0.1:4651/v1/models
block|Bash|osascript -e 'quit app "Openstyle"'
block|Bash|open -a Openstyle
block|Bash|open /Applications/Openstyle.app
block|Bash|/Applications/Openstyle.app/Contents/MacOS/Openstyle
allow|Bash|osascript -e 'display notification "done"'
allow|Bash|open https://github.com/Maheidem/openstyle
allow|Bash|pnpm --filter @openstyle/electron test
allow|Bash|git commit -m "docs: guard notes"
block|Bash|gh pr list --repo Maheidem/openstyle
allow|Bash|GH_TOKEN="$(gh auth token -u Maheidem)" gh pr list --repo Maheidem/openstyle
allow|Bash|GH_TOKEN=$(gh auth token -u Maheidem) gh pr list
allow|Bash|GH_TOKEN="$(gh auth token -u Maheidem)" rtk gh pr list
allow|Bash|cd /tmp && GH_TOKEN="$(gh auth token -u Maheidem)" gh run list | head
allow|Bash|gh auth status
allow|Bash|gh auth token -u Maheidem
allow|Bash|gh auth token -h github.com -u Maheidem
allow|Bash|gh auth token -u Maheidem -h github.com
allow|Bash|gh --version
allow|Bash|gh help
block|Bash|gh auth token
block|Bash|gh auth token -u SomeoneElse
block|Bash|rtk gh issue list
block|Bash|git status && gh run list
block|Bash|echo $(gh pr list)
block|Bash|GH_TOKEN="$(gh auth token -u Maheidem)" gh pr list && gh pr view 1
block|Bash|GH_TOKEN="$(gh auth token -u Maheidem)" gh pr list; gh run list
block|Bash|GH_TOKEN="$(gh auth token -u Other)" gh pr list
block|Bash|GH_TOKEN=abc gh pr list
allow|Bash|rg "gh pr" specs
allow|Bash|git commit -m "docs: use gh pr list"
allow|Bash|echo gh pr list
block|Bash|git push origin main
block|Bash|git push origin HEAD:main
block|Bash|git push origin HEAD:refs/heads/main
block|Bash|git push -f origin main
block|Bash|git push origin +main
block|Bash|git push origin --delete main
block|Bash|git -C /tmp/r push origin main
block|Bash|rtk git push origin main
block|Bash|cd /tmp/r && git push origin main
block|Bash|OTHER=1 git push origin main
allow|Bash|OPENSTYLE_RELEASE_LOCAL=1 git push origin HEAD:refs/heads/main
allow|Bash|cd /tmp/r && OPENSTYLE_RELEASE_LOCAL=1 git push origin main
allow|Bash|git push origin chore/local-release
allow|Bash|git push -u origin fix/main-menu
allow|Bash|git push origin main-preview
allow|Bash|git commit -m "docs: push to main through a PR"
allow|Bash|git fetch origin main
allow|Bash|git pull --ff-only origin main
block|Write|~/.cache/freestyle/x.txt
block|Edit|~/Library/Application Support/Openstyle/settings.json
block|MultiEdit|~/.cache/huggingface/token
allow|Write|/tmp/t/home/.cache/freestyle/x.txt
allow|Edit|/Users/maheidem/Documents/dev/openstyle-iso/README.md
EOF
)

while IFS='|' read -r expect tool arg; do
  [[ -z $expect ]] && continue
  if [[ $tool == Bash ]]; then
    json=$(jq -nc --arg c "$arg" '{tool_name:"Bash",tool_input:{command:$c},cwd:"/tmp"}')
  else
    path=${arg/#\~/$HOME}
    json=$(jq -nc --arg t "$tool" --arg p "$path" '{tool_name:$t,tool_input:{file_path:$p},cwd:"/tmp"}')
  fi
  code=0
  err=$(bash "$HOOK" <<<"$json" 2>&1 >/dev/null) || code=$?
  got=allow
  [[ $code -eq 2 ]] && got=block
  if [[ $code -ne 0 && $code -ne 2 ]]; then got="error($code)"; fi
  if [[ $got == "$expect" ]]; then
    pass=$((pass + 1))
    printf 'ok    %-5s %-9s %s\n' "$got" "$tool" "$arg"
  else
    fail=$((fail + 1))
    printf 'FAIL  want=%s got=%s %s %s %s\n' "$expect" "$got" "$tool" "$arg" "$err"
  fi
done <<<"$CASES"

echo "guard-hook: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
