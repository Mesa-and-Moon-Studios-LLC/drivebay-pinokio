#!/bin/bash
# Sign and notarize a Drivebay.app or the disk image that contains it.
#
# Off unless secrets are present. The release workflow passes these through;
# an empty value leaves the build unsigned.
#
#   APPLE_CERTIFICATE            base64 Developer ID Application .p12
#   APPLE_CERTIFICATE_PASSWORD   password for that .p12
#   APPLE_SIGNING_IDENTITY       optional exact codesign identity
#   APPLE_TEAM_ID                optional team id (recorded in the log only)
#   APPLE_NOTARY_KEY             base64 AuthKey .p8, or the PEM itself
#   APPLE_NOTARY_KEY_ID          App Store Connect API key id
#   APPLE_NOTARY_ISSUER_ID       App Store Connect issuer id
#
# Aliases accepted: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER,
# APPLE_API_ISSUER_ID. A machine that already has the cert in the login
# keychain can set DRIVEBAY_CODESIGN_IDENTITY instead of APPLE_CERTIFICATE.
#
#   bash installer/macos/sign-dmg.sh sign /path/to/Drivebay.app
#   bash installer/macos/sign-dmg.sh notarize /path/to/Drivebay-version-arm64.dmg
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="$HERE/entitlements.plist"
ACTION="${1:-}"
TARGET="${2:-}"

NOTARY_KEY="${APPLE_NOTARY_KEY:-${APPLE_API_KEY:-}}"
NOTARY_KEY_ID="${APPLE_NOTARY_KEY_ID:-${APPLE_API_KEY_ID:-}}"
NOTARY_ISSUER="${APPLE_NOTARY_ISSUER_ID:-${APPLE_API_ISSUER:-${APPLE_API_ISSUER_ID:-}}}"

b64dec() {
  if printf 'dGVzdA==' | base64 -d >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}

unsigned_help() {
  printf '%s\n' "Drivebay for Mac is unsigned."
  printf '%s\n' "If macOS says it cannot be opened, right-click Drivebay and choose Open, then click Open."
  printf '%s\n' "Or run: xattr -dr com.apple.quarantine /Applications/Drivebay.app"
  printf '%s\n' "The same command works on an unpacked tarball folder."
  printf '%s\n' "To sign a later build, set APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD."
  printf '%s\n' "To notarize, also set APPLE_NOTARY_KEY, APPLE_NOTARY_KEY_ID, and APPLE_NOTARY_ISSUER_ID."
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf '%s\n' "Signing and notarization run on the macOS release runner." >&2
    exit 1
  fi
}

SIGN_KEYCHAIN=""
SIGN_P12=""
SIGN_PREV_KEYCHAIN=""
SIGN_KEYCHAIN_LIST=""

cleanup_sign() {
  if [[ -n "$SIGN_KEYCHAIN" ]]; then
    security delete-keychain "$SIGN_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SIGN_PREV_KEYCHAIN" ]]; then
    security default-keychain -s "$SIGN_PREV_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SIGN_KEYCHAIN_LIST" && -f "$SIGN_KEYCHAIN_LIST" ]]; then
    # shellcheck disable=SC2046
    security list-keychains -d user -s $(tr -d '"' < "$SIGN_KEYCHAIN_LIST") >/dev/null 2>&1 || true
    rm -f "$SIGN_KEYCHAIN_LIST"
  fi
  rm -f "$SIGN_P12"
}

sign_app() {
  if [[ -z "${APPLE_CERTIFICATE:-}" && -z "${DRIVEBAY_CODESIGN_IDENTITY:-}" ]]; then
    unsigned_help
    exit 0
  fi
  require_macos
  if [[ -z "$TARGET" || ! -d "$TARGET" ]]; then
    printf '%s\n' "Pass the Drivebay.app bundle to sign." >&2
    exit 1
  fi
  if [[ -n "${APPLE_CERTIFICATE:-}" && -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    printf '%s\n' "APPLE_CERTIFICATE is set. APPLE_CERTIFICATE_PASSWORD is required." >&2
    exit 1
  fi

  trap cleanup_sign EXIT
  local identity="" pass=""

  if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
    SIGN_KEYCHAIN="$(mktemp -u "${TMPDIR:-/tmp}/drivebay-sign.XXXXXX").keychain-db"
    pass="$(openssl rand -hex 16)"
    SIGN_PREV_KEYCHAIN="$(security default-keychain 2>/dev/null | tr -d '"' || true)"
    SIGN_KEYCHAIN_LIST="$(mktemp)"
    security list-keychains -d user > "$SIGN_KEYCHAIN_LIST" || true
    security create-keychain -p "$pass" "$SIGN_KEYCHAIN"
    security set-keychain-settings -lut 21600 "$SIGN_KEYCHAIN"
    security unlock-keychain -p "$pass" "$SIGN_KEYCHAIN"
    security list-keychains -d user -s "$SIGN_KEYCHAIN"
    security default-keychain -s "$SIGN_KEYCHAIN"
    SIGN_P12="$(mktemp)"
    printf '%s' "$APPLE_CERTIFICATE" | b64dec > "$SIGN_P12"
    security import "$SIGN_P12" -k "$SIGN_KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$SIGN_KEYCHAIN" >/dev/null
    rm -f "$SIGN_P12"
    SIGN_P12=""
    identity="${APPLE_SIGNING_IDENTITY:-}"
    if [[ -z "$identity" ]]; then
      identity="$(security find-identity -v -p codesigning "$SIGN_KEYCHAIN" | sed -n 's/.*"\(.*\)"$/\1/p' | head -n 1)"
    fi
    if [[ -z "$identity" ]]; then
      printf '%s\n' "No codesigning identity was found in the imported certificate." >&2
      exit 1
    fi
    export CODESIGN_KEYCHAIN="$SIGN_KEYCHAIN"
  else
    identity="$DRIVEBAY_CODESIGN_IDENTITY"
  fi

  if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
    printf '%s\n' "Signing $TARGET for team ${APPLE_TEAM_ID}."
  else
    printf '%s\n' "Signing $TARGET."
  fi

  local file
  while IFS= read -r -d '' file; do
    if /usr/bin/file -b "$file" | grep -q "Mach-O"; then
      if [[ -n "${CODESIGN_KEYCHAIN:-}" ]]; then
        codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
          --sign "$identity" --keychain "$CODESIGN_KEYCHAIN" "$file"
      else
        codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
          --sign "$identity" "$file"
      fi
    fi
  done < <(find "$TARGET" -type f -print0)

  if [[ -n "${CODESIGN_KEYCHAIN:-}" ]]; then
    codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
      --sign "$identity" --keychain "$CODESIGN_KEYCHAIN" "$TARGET"
  else
    codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
      --sign "$identity" "$TARGET"
  fi
  codesign --verify --verbose=2 "$TARGET"
  printf '%s\n' "Signed $TARGET."
}

notarize_target() {
  if [[ -z "$NOTARY_KEY" ]]; then
    printf '%s\n' "Notarization is off. Set APPLE_NOTARY_KEY, APPLE_NOTARY_KEY_ID, and APPLE_NOTARY_ISSUER_ID to turn it on."
    exit 0
  fi
  if [[ -z "${APPLE_CERTIFICATE:-}" && -z "${DRIVEBAY_CODESIGN_IDENTITY:-}" ]]; then
    printf '%s\n' "Notarization needs a Developer ID. Set APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD." >&2
    exit 1
  fi
  if [[ -z "$NOTARY_KEY_ID" || -z "$NOTARY_ISSUER" ]]; then
    printf '%s\n' "Set APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID with APPLE_NOTARY_KEY." >&2
    exit 1
  fi
  require_macos
  if [[ -z "$TARGET" || ! -e "$TARGET" ]]; then
    printf '%s\n' "Pass the disk image to notarize." >&2
    exit 1
  fi

  NOTARY_KEY_FILE="$(mktemp)"
  trap 'rm -f "$NOTARY_KEY_FILE"' EXIT
  local key="$NOTARY_KEY_FILE"
  if printf '%s' "$NOTARY_KEY" | grep -q "BEGIN"; then
    printf '%s\n' "$NOTARY_KEY" > "$key"
  else
    printf '%s' "$NOTARY_KEY" | b64dec > "$key"
  fi
  chmod 600 "$key"
  printf '%s\n' "Submitting $TARGET for notarization."
  xcrun notarytool submit "$TARGET" \
    --key "$key" \
    --key-id "$NOTARY_KEY_ID" \
    --issuer "$NOTARY_ISSUER" \
    --wait
  xcrun stapler staple "$TARGET"
  printf '%s\n' "Notarized and stapled $TARGET."
}

case "$ACTION" in
  sign) sign_app ;;
  notarize) notarize_target ;;
  *)
    printf '%s\n' "Use: sign-dmg.sh sign <Drivebay.app> | notarize <image.dmg>" >&2
    exit 1
    ;;
esac
