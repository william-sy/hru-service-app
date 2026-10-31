#!/bin/sh
# Local debug build. Usage: ./build.sh [install]   ("install" also installs on a phone connected over adb)
# Needs: Node 20+, JDK 17, the Android SDK (ANDROID_HOME). The pipeline in .github/workflows does the same steps.
set -eu
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
./scripts/prepare.sh
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}" ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
(cd android && ./gradlew assembleDebug --console=plain -q)
cp android/app/build/outputs/apk/debug/app-debug.apk hru-service.apk
echo "built $(pwd)/hru-service.apk"
if [ "${1:-}" = "install" ]; then "$ANDROID_HOME/platform-tools/adb" install -r hru-service.apk; fi
