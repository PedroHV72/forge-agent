#!/usr/bin/env bash
# build.sh — compile the Forge menu bar app into a real .app bundle.
#
# No Xcode project: swiftc plus a hand-rolled bundle is enough for a menu-bar
# app, so the build works anywhere the Command Line Tools are installed.
#
#   ./app/build.sh              build into app/build/Forge.app
#   ./app/build.sh --install    also copy it into /Applications
#   ./app/build.sh --run        also launch it
#   ./app/build.sh --debug      assemble the bundle from the DEBUG binary
#
# --debug composes freely with --run and --install; it changes only which
# binary gets packaged, never where the bundle goes. It exists because a real
# bundle is the only way to run this app at all: `swift run Forge` dies inside
# Notifier.shared's init, where UNUserNotificationCenter needs a bundle and
# throws "bundleProxyForCurrentProcess is nil". On a machine without Xcode the
# canvas is unavailable too, which leaves this script as the whole loop.
#
# Costs, measured on this machine:
#   --debug     ~10s, because an incremental `swift build` is sub-second and the
#               rest is icon, plist and codesign. Use it to judge FORM.
#   (release)   minutes. This is the loop that proves the stamped version (D25)
#               and final fidelity; a debug bundle never substitutes for it.
#
# The other loop, when Xcode exists: the canvas. Open app/Package.swift in
# Xcode, then app/Sources/Forge/Previews.swift, and press ⌥⌘↩ — sub-second.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${APP_DIR}/build"
BUNDLE="${BUILD_DIR}/Forge.app"

DO_INSTALL=false
DO_RUN=false
DO_DEBUG=false
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=true ;;
    --run)     DO_RUN=true ;;
    --debug)   DO_DEBUG=true ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "build.sh: opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build.sh: swiftc não encontrado. Instale as Command Line Tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

echo "▸ Limpando build anterior"
rm -rf "$BUNDLE"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"

# SPM rather than a bare swiftc invocation: the terminal needs SwiftTerm's VT
# emulator as a dependency. First build downloads it; later builds are cached.
#
# `-c debug` is spelled out rather than left as an empty array: this script runs
# under `set -u`, and expanding an empty array trips it on the bash 3.2 that
# ships with macOS.
if $DO_DEBUG; then
  SWIFT_ARGS=(-c debug)
  CONFIG_LABEL="debug"
else
  SWIFT_ARGS=(-c release --arch arm64)
  CONFIG_LABEL="release, arm64"
fi

echo "▸ Compilando (swift build ${CONFIG_LABEL}, SwiftTerm)"
( cd "$APP_DIR" && swift build "${SWIFT_ARGS[@]}" ) || exit 1
BIN="$(cd "$APP_DIR" && swift build "${SWIFT_ARGS[@]}" --show-bin-path)/Forge"
if [ ! -f "$BIN" ]; then
  echo "build.sh: binário não encontrado em $BIN" >&2
  exit 1
fi
cp "$BIN" "${BUNDLE}/Contents/MacOS/Forge"

ICON="${APP_DIR}/Forge.icns"
if [ ! -f "$ICON" ]; then
  echo "▸ Gerando ícone"
  swift "${APP_DIR}/make-icon.swift" "$ICON" || echo "  aviso: ícone não gerado — o app usa o genérico"
fi
if [ -f "$ICON" ]; then
  cp "$ICON" "${BUNDLE}/Contents/Resources/Forge.icns"
fi

cp "${APP_DIR}/Info.plist" "${BUNDLE}/Contents/Info.plist"

echo "▸ Assinando (ad-hoc)"
# Ad-hoc signature: enough for the app to run locally. A Developer ID would be
# needed only to distribute it to another machine without Gatekeeper warnings.
codesign --force --sign - --timestamp=none "$BUNDLE" >/dev/null 2>&1 \
  || echo "  aviso: codesign falhou — o app ainda roda localmente"

echo "✓ ${BUNDLE}"

if $DO_INSTALL; then
  echo "▸ Instalando em /Applications"
  rm -rf "/Applications/Forge.app"
  cp -R "$BUNDLE" "/Applications/Forge.app"
  echo "✓ /Applications/Forge.app"
  BUNDLE="/Applications/Forge.app"
fi

if $DO_RUN; then
  echo "▸ Abrindo"
  pkill -x Forge 2>/dev/null || true
  open "$BUNDLE"
fi
