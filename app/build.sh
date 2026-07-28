#!/usr/bin/env bash
# build.sh — compile the Forge menu bar app into a real .app bundle.
#
# No Xcode project: swiftc plus a hand-rolled bundle is enough for a menu-bar
# app, so the build works anywhere the Command Line Tools are installed.
#
#   ./app/build.sh              build into app/build/Forge.app
#   ./app/build.sh --install    also copy it into /Applications
#   ./app/build.sh --run        also launch it
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${APP_DIR}/build"
BUNDLE="${BUILD_DIR}/Forge.app"

DO_INSTALL=false
DO_RUN=false
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=true ;;
    --run)     DO_RUN=true ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

echo "▸ Compilando (swift build, SwiftTerm)"
# SPM rather than a bare swiftc invocation: the terminal needs SwiftTerm's VT
# emulator as a dependency. First build downloads it; later builds are cached.
( cd "$APP_DIR" && swift build -c release --arch arm64 ) || exit 1
BIN="$(cd "$APP_DIR" && swift build -c release --arch arm64 --show-bin-path)/Forge"
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
