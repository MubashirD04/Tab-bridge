#!/bin/sh
# Regenerates store/screenshots/*.png (1280×800, light mode) with headless
# Firefox. Start the harness first: node store/harness/serve.mjs
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../screenshots"
firefox="${FIREFOX:-/Applications/Firefox.app/Contents/MacOS/firefox}"
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT
# Light mode. Without these, headless Firefox follows the system's dark mode.
cat > "$profile/user.js" <<'PREFS'
user_pref("ui.systemUsesDarkTheme", 0);
user_pref("browser.theme.content-theme", 1);
user_pref("browser.theme.toolbar-theme", 1);
user_pref("layout.css.prefers-color-scheme.content-override", 1);
PREFS
i=1
for shot in popup onboarding-start onboarding settings; do
  "$firefox" --headless --no-remote --profile "$profile" --window-size=1280,800 \
    --screenshot "$out/$i-$shot.png" "http://127.0.0.1:${PORT:-4173}/store/harness/shot.html?shot=$shot" >/dev/null 2>&1
  echo "store/screenshots/$i-$shot.png"
  i=$((i + 1))
done
