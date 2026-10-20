#!/usr/bin/env bash
# macOS signing hook. Drivebay ships unsigned until a Developer ID is available.
# Set DRIVEBAY_CODESIGN_IDENTITY to the certificate name and, later,
# DRIVEBAY_NOTARY_PROFILE to a notarytool keychain profile. This script does
# not notarize unless both are set, and it never embeds a key.
set -euo pipefail

TARGET="${1:-}"
if [[ -z "${DRIVEBAY_CODESIGN_IDENTITY:-}" ]]; then
  echo "Drivebay for Mac is unsigned."
  echo "If macOS says it cannot be opened, right-click Drivebay and choose Open, then click Open."
  echo "Or run: xattr -dr com.apple.quarantine /Applications/Drivebay.app"
  echo "The same command works on an unpacked tarball folder."
  echo "Release signing uses APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD (see installer/macos/sign-dmg.sh)."
  echo "To sign a folder locally: DRIVEBAY_CODESIGN_IDENTITY='Developer ID Application: Mesa and Moon Studios LLC' bash installer/unix/sign-mac.sh <folder>"
  exit 0
fi

if [[ -z "$TARGET" || ! -e "$TARGET" ]]; then
  echo "Pass the folder to sign."
  exit 1
fi

echo "Signing $TARGET with $DRIVEBAY_CODESIGN_IDENTITY"
codesign --force --sign "$DRIVEBAY_CODESIGN_IDENTITY" --timestamp "$TARGET"

if [[ -n "${DRIVEBAY_NOTARY_PROFILE:-}" ]]; then
  echo "Notarization profile is set. Submit the archive with notarytool when Aaron turns that on."
  echo "xcrun notarytool submit <zip> --keychain-profile \"$DRIVEBAY_NOTARY_PROFILE\" --wait"
else
  echo "Notarization is not configured. The build stays unsigned by Apple until DRIVEBAY_NOTARY_PROFILE is set."
fi
