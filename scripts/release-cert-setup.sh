#!/usr/bin/env bash
# One-time setup of the code-signing certificate "Openstyle Release".
# The OWNER runs this script once: bash scripts/release-cert-setup.sh
# Do not run it from an agent. It writes GitHub secrets and changes the login keychain.
#
# Why: CI signs the macOS release build with a fixed self-signed certificate.
# macOS keeps Privacy (TCC) permissions between two builds that have the same
# identifier and the same certificate. An ad-hoc build gets a new identity on
# every update, so macOS asks for the permissions again. This certificate is
# separate from the local "Openstyle Dev" certificate
# (scripts/dev-signing-setup.sh). A Developer ID is still deferred
# (specs/under-the-hood.md, item 1).
#
# What this script does:
#   1. Create a self-signed certificate (codeSigning key usage, RSA 2048, 10 years).
#   2. Save the identity in your login keychain as a backup, WITHOUT trust.
#   3. Store two GitHub Actions secrets on the repository:
#        MAC_RELEASE_CERT_P12       the identity as base64 PKCS#12
#        MAC_RELEASE_CERT_PASSWORD  a random password for that file
#   The secret values are never printed. The temporary files are removed on exit.
#
# Options:
#   --force   replace secrets that already exist
#   -h        show this text
#
# IMPORTANT: if the key is lost, nobody can sign a build with the same
# identity again. Users must then grant the Privacy permissions once more.
set -euo pipefail

REPO="${OPENSTYLE_REPO:-Maheidem/openstyle}"
GH_USER="${OPENSTYLE_GH_USER:-Maheidem}"
NAME="Openstyle Release"
SECRET_P12="MAC_RELEASE_CERT_P12"
SECRET_PASS="MAC_RELEASE_CERT_PASSWORD"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
# macOS /usr/bin/openssl is LibreSSL. Its PKCS#12 default cipher (3DES) is the
# one "security import" and electron-builder can read. A Homebrew OpenSSL 3
# file would fail to import.
OPENSSL=/usr/bin/openssl

force=0
for arg in "$@"; do
  case "${arg}" in
    --force) force=1 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script runs on macOS only." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "The gh CLI is not installed." >&2
  exit 1
fi

# Every write to GitHub uses the personal account token for that one command.
# The token is never printed and the active gh account does not change.
gh_owner() {
  GH_TOKEN="$(gh auth token -u "${GH_USER}")" gh "$@"
}

if ! gh auth token -u "${GH_USER}" >/dev/null 2>&1; then
  echo "gh has no login for the account ${GH_USER}. Run: gh auth login" >&2
  exit 1
fi

# Step 0: refuse to replace secrets that exist.
existing="$(gh_owner secret list --repo "${REPO}" --json name --jq '.[].name')"
found=()
for secret in "${SECRET_P12}" "${SECRET_PASS}"; do
  if grep -qx "${secret}" <<<"${existing}"; then
    found+=("${secret}")
  fi
done
if ((${#found[@]} > 0)) && ((force == 0)); then
  echo "These secrets already exist on ${REPO}: ${found[*]}" >&2
  echo "A new certificate replaces the old one. Users must then grant the" >&2
  echo "Privacy permissions once more. To replace them anyway, run:" >&2
  echo "  bash scripts/release-cert-setup.sh --force" >&2
  exit 1
fi

ids="$(security find-identity -p codesigning)"
if grep -qF "\"${NAME}\"" <<<"${ids}"; then
  echo "Note: your login keychain already has an identity named \"${NAME}\"."
  echo "The new one has the same name. Tell them apart by the SHA-1 fingerprint below."
fi

work="$(mktemp -d)"
chmod 700 "${work}"
cleanup() { rm -rf "${work}"; }
trap cleanup EXIT

umask 077
cat >"${work}/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${NAME}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

echo "Creating the certificate (RSA 2048, valid 10 years)..."
"${OPENSSL}" req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -config "${work}/openssl.cnf" \
  -keyout "${work}/key.pem" -out "${work}/cert.pem" 2>/dev/null

# The password goes through the environment, not through argv, for openssl.
# "security import -P" takes it as an argument, so other local processes can
# see it for a moment. The file is a backup of a self-signed key, so this is accepted.
P12_PASS="$("${OPENSSL}" rand -hex 16)"
export P12_PASS
"${OPENSSL}" pkcs12 -export -name "${NAME}" \
  -inkey "${work}/key.pem" -in "${work}/cert.pem" \
  -out "${work}/identity.p12" -passout env:P12_PASS

# Prove that the file can be read back before anything is stored.
"${OPENSSL}" pkcs12 -in "${work}/identity.p12" -passin env:P12_PASS -nokeys -clcerts \
  2>/dev/null | "${OPENSSL}" x509 -noout >/dev/null
fingerprint="$("${OPENSSL}" x509 -in "${work}/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"

# Step 2 first: the keychain copy is the backup. Save it before the secrets, so
# the key is never only in GitHub (GitHub secrets cannot be read back).
echo "Saving the identity in the login keychain as a backup (no trust)..."
security import "${work}/identity.p12" -k "${KEYCHAIN}" -P "${P12_PASS}" \
  -T /usr/bin/codesign >/dev/null

# Step 3: store the secrets. gh reads the value from stdin: it is never echoed.
echo "Storing the GitHub secrets on ${REPO}..."
if ! base64 <"${work}/identity.p12" | tr -d '\n' |
  gh_owner secret set "${SECRET_P12}" --repo "${REPO}"; then
  echo "ERROR: gh could not store ${SECRET_P12}. The keychain backup stays." >&2
  echo "To remove it before you retry:" >&2
  echo "  security delete-identity -Z ${fingerprint} -t" >&2
  exit 1
fi
if ! printf '%s' "${P12_PASS}" |
  gh_owner secret set "${SECRET_PASS}" --repo "${REPO}"; then
  echo "ERROR: gh stored ${SECRET_P12} but could not store ${SECRET_PASS}." >&2
  echo "The two secrets on ${REPO} may now be mismatched (new file, old password)." >&2
  echo "Run this script again with --force to replace both secrets." >&2
  echo "The keychain backup of this run stays. Remove it first if you retry:" >&2
  echo "  security delete-identity -Z ${fingerprint} -t" >&2
  exit 1
fi

echo
echo "Secrets now on ${REPO}:"
gh_owner secret list --repo "${REPO}" | grep -E "^(${SECRET_P12}|${SECRET_PASS})[[:space:]]" || true

cat <<DONE

Done. Certificate "${NAME}", SHA-1 ${fingerprint}.
The next Build & Test run on macOS signs the app with it.
The first update from an ad-hoc build to this build asks for the Privacy
permissions once more. Later updates keep them.

Backup: the identity is in your login keychain (not trusted on this Mac, so it
is not used for local builds). To export it again to a PKCS#12 file:
  security export -k "${KEYCHAIN}" -t identities -f pkcs12 -o ~/openstyle-release.p12
Keep the exported file in a password manager. GitHub secrets cannot be read back.

If this key is lost, nobody can sign a build with the same identity again.
Users must then grant the Privacy permissions once more. To rotate on purpose,
run this script again with --force.
DONE
