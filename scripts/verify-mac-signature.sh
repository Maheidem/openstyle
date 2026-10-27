#!/usr/bin/env bash
# Verify the release signature of a packaged Openstyle.app.
#   bash scripts/verify-mac-signature.sh <devid|self> <path/to/Openstyle.app> [<dmg>...]
# The CI package job (.github/workflows/build.yml, "Verify release signature")
# and scripts/release-local.sh both run it, so the two paths check the same things.
#
# It checks the app and every Mach-O file under Contents/Resources (helpers in
# bin/, vec0.dylib, whisper/). electron-builder signs them with
# @electron/osx-sign, which walks the whole bundle and uses
# mac.entitlementsInherit for every file except the main app.
# devid: Authority "Developer ID Application", one TeamIdentifier, hardened
#   runtime; then Gatekeeper (spctl) and the stapled ticket.
# self: Authority "Openstyle Release" and a "certificate leaf" requirement.
# NOTARIZED=0 skips the Gatekeeper and ticket checks of the devid mode
# (local dry run without notary credentials). Default: 1.
set -euo pipefail

MODE=${1:-}
app=${2:-}
if [ "$MODE" != devid ] && [ "$MODE" != self ] || [ -z "$app" ]; then
  echo "usage: bash scripts/verify-mac-signature.sh <devid|self> <app> [<dmg>...]" >&2
  exit 2
fi
shift 2
NOTARIZED=${NOTARIZED:-1}
if [ ! -d "$app" ]; then
  echo "::error::No app at $app."
  exit 1
fi

# True when the hardened runtime flag (0x10000) is on for $1.
has_runtime() {
  local flags_hex
  flags_hex="$(codesign -dv "$1" 2>&1 | sed -n 's/.*flags=\(0x[0-9a-fA-F]*\).*/\1/p' | head -n 1)"
  [ -n "$flags_hex" ] && (( (flags_hex & 0x10000) != 0 ))
}

targets=("$app")
executables=()
while IFS= read -r -d '' f; do
  kind="$(file -b "$f")"
  case "$kind" in
    *Mach-O*)
      targets+=("$f")
      case "$kind" in *executable*) executables+=("$f") ;; esac
      ;;
  esac
done < <(find "$app/Contents/Resources" -type f -print0)
if [ "${#executables[@]}" -eq 0 ]; then
  echo "::error::No native helpers found under $app/Contents/Resources."
  exit 1
fi

app_team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
for target in "${targets[@]}"; do
  echo "== codesign -dv --verbose=4 $target"
  details="$(codesign -dv --verbose=4 "$target" 2>&1)"
  echo "$details"
  if [ "$MODE" = "devid" ]; then
    if ! grep -q '^Authority=Developer ID Application: ' <<<"$details"; then
      echo "::error::$target is not signed by a Developer ID Application identity."
      exit 1
    fi
    team="$(sed -n 's/^TeamIdentifier=//p' <<<"$details")"
    if [ -z "$team" ] || [ "$team" = "not set" ] || [ "$team" != "$app_team" ]; then
      echo "::error::$target has TeamIdentifier '${team:-none}', the app has '${app_team:-none}'."
      exit 1
    fi
    if ! has_runtime "$target"; then
      echo "::error::$target has no hardened runtime flag. Notarization rejects it."
      exit 1
    fi
  else
    if ! grep -qxF 'Authority=Openstyle Release' <<<"$details"; then
      echo "::error::$target is not signed by Openstyle Release."
      exit 1
    fi
    echo "== codesign -d -r- $target"
    requirement="$(codesign -d -r- "$target" 2>&1)"
    echo "$requirement"
    if ! grep -qF 'certificate leaf' <<<"$requirement"; then
      echo "::error::The designated requirement of $target has no certificate leaf."
      exit 1
    fi
  fi
done

echo "== codesign --verify --deep --strict --verbose=2 $app"
codesign --verify --deep --strict --verbose=2 "$app"

if ! has_runtime "$app"; then
  echo "::error::$app has no hardened runtime flag."
  exit 1
fi
echo "Hardened runtime flag is on for $app."

# electron-builder signs each helper with the hardened runtime too
# (mac.hardenedRuntime defaults to true). Check every helper.
for helper in "${executables[@]}"; do
  if ! has_runtime "$helper"; then
    echo "::error::$helper has no hardened runtime flag."
    exit 1
  fi
done
echo "Hardened runtime flag is on for all ${#executables[@]} helpers."

# The entitlement that lets the app load helpers with another signature.
entitlements="$(codesign -d --entitlements - "$app" 2>&1)"
for key in com.apple.security.cs.disable-library-validation com.apple.security.cs.allow-jit; do
  if ! grep -qF "$key" <<<"$entitlements"; then
    echo "::error::$app lacks the entitlement $key."
    exit 1
  fi
done
echo "App entitlements are present."

# Under the hardened runtime a helper that opens the mic, sends
# Apple Events or reads Calendars needs the entitlement itself.
for helper in "${executables[@]}"; do
  helper_ents="$(codesign -d --entitlements - "$helper" 2>&1)"
  for key in com.apple.security.device.audio-input com.apple.security.automation.apple-events com.apple.security.personal-information.calendars; do
    if ! grep -qF "$key" <<<"$helper_ents"; then
      echo "::error::$helper lacks the entitlement $key."
      exit 1
    fi
  done
done
echo "Helper entitlements are present (${#executables[@]} executables)."

if [ "$MODE" != "devid" ]; then
  exit 0
fi
if [ "$NOTARIZED" = 0 ]; then
  echo "SKIPPED  Gatekeeper and ticket checks (NOTARIZED=0: the app is not notarized)."
  exit 0
fi

echo "== spctl -a -vv -t exec $app"
assessment="$(spctl -a -vv -t exec "$app" 2>&1 || true)"
echo "$assessment"
if ! grep -qF 'accepted' <<<"$assessment" || ! grep -qF 'source=Notarized Developer ID' <<<"$assessment"; then
  echo "::error::Gatekeeper does not accept $app as Notarized Developer ID."
  exit 1
fi
echo "== xcrun stapler validate $app"
xcrun stapler validate "$app"

# electron-builder notarizes the .app only. Check the dmg ticket
# when the dmg has one; a dmg without a ticket is not an error.
for dmg in "$@"; do
  [ -f "$dmg" ] || continue
  if xcrun stapler validate "$dmg" > /dev/null 2>&1; then
    echo "The dmg $dmg has a valid stapled ticket."
  else
    echo "::notice::The dmg $dmg has no stapled ticket. The app inside it is stapled."
  fi
done
