#!/usr/bin/env bash
# Updates 3018 Studio from GitHub and restarts it. On the Pi, in the app folder: bash pi/update.sh
# Also run by the "Install update" button (through the 3018-studio-update service).
# The new version is built next to the running one and only swapped in once it has built,
# so a failed update leaves the working version in place.
set -euo pipefail
cd "$(dirname "$0")/.."
SYSTEMCTL="${STUDIO_SYSTEMCTL:-/usr/bin/systemctl}"

if [ ! -d .git ]; then
  echo "This copy was not installed with git, so it can't update itself."
  echo "See 'Updating' in pi/README.md."
  exit 1
fi

# The commit the running version was built from (HEAD can be ahead of it after a failed build).
built="$(cat dist-server/BUILT_FROM 2>/dev/null || true)"
echo "==> Fetching updates ($(git rev-parse --abbrev-ref HEAD) branch)"
git fetch --quiet origin
if ! git merge --ff-only --quiet '@{u}'; then
  echo "Could not update: files in this folder were changed by hand. Undo with 'git stash' and try again."
  exit 1
fi
after="$(git rev-parse HEAD)"

if [ "$built" = "$after" ] && [ -f dist/index.html ] && [ -f dist-server/main.js ] && [ "${REBUILD:-0}" != "1" ]; then
  echo "Already up to date: $(git log -1 --format='%h %s')"
  exit 0
fi
if [ -n "$built" ] && git cat-file -e "$built" 2>/dev/null; then
  git log --format='    %h %s' "$built..$after"
fi

lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ "$(cat node_modules/.studio-lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
  echo "==> Installing build tools"
  npm ci --no-audit --no-fund
  echo "$lock_hash" > node_modules/.studio-lock-hash
fi

echo "==> Building"
rm -rf .build
npx vite build --outDir .build/dist --emptyOutDir --logLevel warn
npx vite build --ssr server/main.ts --outDir .build/dist-server --emptyOutDir --logLevel warn

echo "==> Switching to the new version"
rm -rf dist.old dist-server.old
[ -d dist ] && mv dist dist.old
[ -d dist-server ] && mv dist-server dist-server.old
mv .build/dist dist
mv .build/dist-server dist-server
rmdir .build
echo "$after" > dist-server/BUILT_FROM

if [ -n "$built" ] && ! git diff --quiet "$built" "$after" -- pi/install.sh 2>/dev/null; then
  echo
  echo "NOTE: this update changed the installer. Run 'bash pi/install.sh' once to apply it."
fi

if "$SYSTEMCTL" is-enabled --quiet 3018-studio 2>/dev/null; then
  echo "==> Restarting 3018 Studio"
  sudo -n "$SYSTEMCTL" restart 3018-studio
fi
echo "Updated to $(git log -1 --format='%h %s')"
