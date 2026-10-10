#!/usr/bin/env bash
# One-time setup of a local code-signing identity named "Openstyle Dev".
# The OWNER runs this script once: bash scripts/dev-signing-setup.sh
# Do not run it from an agent. It changes the login keychain and trust settings.
#
# Why: the native helpers and the dev Electron are ad-hoc signed. macOS can only
# identify an ad-hoc binary by its code hash or path, so every rebuild asks for
# the Privacy permissions again. A stable self-signed identity keeps one
# identity across rebuilds. Local builds use it through
# apps/electron/scripts/dev-sign.mjs. CI and other machines never use it.
#
# What this script does:
#   1. Create a self-signed certificate (codeSigning key usage, 10 years).
#   2. Import the certificate and key into the login keychain.
#      The tools codesign and security may use the key.
#   3. Trust the certificate for code signing only.
#      macOS asks for your login password ONCE here (a system dialog).
#   4. Show the identity from "security find-identity".
#
# The script is idempotent. If the identity exists, it prints it and stops.
set -euo pipefail

NAME="Openstyle Dev"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
# macOS /usr/bin/openssl is LibreSSL. Its PKCS#12 default cipher (3DES) is the
# one "security import" can read. A Homebrew OpenSSL 3 file would fail to import.
OPENSSL=/usr/bin/openssl

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script runs on macOS only." >&2
  exit 1
fi

# find-identity -v lists only valid identities. -v also hides an untrusted one.
existing="$(security find-identity -v -p codesigning | grep -F "\"${NAME}\"" || true)"
if [[ -n "${existing}" ]]; then
  echo "Identity \"${NAME}\" already exists. Nothing to do."
  echo "${existing}"
  exit 0
fi
all_ids="$(security find-identity -p codesigning || true)"
if grep -qF "\"${NAME}\"" <<<"${all_ids}"; then
  echo "A certificate \"${NAME}\" exists but is not valid (not trusted)." >&2
  echo "Delete it first, then run this script again:" >&2
  echo "  security delete-identity -c \"${NAME}\" -t" >&2
  exit 1
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

echo "Creating the certificate (valid 10 years)..."
"${OPENSSL}" req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -config "${work}/openssl.cnf" \
  -keyout "${work}/key.pem" -out "${work}/cert.pem" 2>/dev/null

# The PKCS#12 password protects only a temporary file that the EXIT trap deletes.
# "security import -P" takes the password as an argument, so other local
# processes can see it for a moment.
P12_PASS="$("${OPENSSL}" rand -hex 16)"
export P12_PASS
"${OPENSSL}" pkcs12 -export -name "${NAME}" \
  -inkey "${work}/key.pem" -in "${work}/cert.pem" \
  -out "${work}/identity.p12" -passout env:P12_PASS

echo "Importing into the login keychain (codesign and security may use the key)..."
security import "${work}/identity.p12" -k "${KEYCHAIN}" -P "${P12_PASS}" \
  -T /usr/bin/codesign >/dev/null

echo "Trusting the certificate for code signing only."
echo "macOS asks for your login password ONCE now."
if ! security add-trusted-cert -p codeSign -k "${KEYCHAIN}" "${work}/cert.pem"; then
  echo "The key is in the keychain but not trusted. To retry, delete it first:" >&2
  echo "  security delete-identity -c \"${NAME}\" -t" >&2
  exit 1
fi

echo
echo "Result of: security find-identity -v -p codesigning"
result="$(security find-identity -v -p codesigning)"
echo "${result}"
if ! grep -qF "\"${NAME}\"" <<<"${result}"; then
  echo "ERROR: identity \"${NAME}\" is not valid after setup." >&2
  exit 1
fi

cat <<UNDO

Done. Rebuild the native helpers so they use the new identity:
  pnpm --filter @openstyle/electron compile:native
  pnpm --filter @openstyle/electron sign:dev
If codesign asks to use the key, enter your login password and choose "Always Allow".

How to undo (deletes the identity, the key and the trust setting):
  security delete-identity -c "${NAME}" -t
To turn the identity off without deleting it: OPENSTYLE_DEV_SIGN=0
UNDO
