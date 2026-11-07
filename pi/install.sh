#!/usr/bin/env bash
# Installs 3018 Studio on a Raspberry Pi as a service that starts at boot.
# Run from the unpacked project folder:   bash pi/install.sh
# Safe to run again (e.g. after updating the files).
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
SERVICE=/etc/systemd/system/3018-studio.service
UPDATE_SERVICE=/etc/systemd/system/3018-studio-update.service
SUDOERS=/etc/sudoers.d/3018-studio
SETTINGS=/etc/default/3018-studio

if [ "$(id -u)" -eq 0 ]; then
  echo "Please run this as your normal user (it uses sudo where needed): bash pi/install.sh"
  exit 1
fi
APP_USER="$(id -un)"

echo "==> Checking Node.js and git"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  sudo apt-get update
  sudo apt-get install -y nodejs npm
fi
command -v git >/dev/null || sudo apt-get install -y git
echo "    Node $(node --version)"

if [ -f dist/index.html ] && [ -f dist-server/main.js ] && [ "${REBUILD:-0}" != "1" ]; then
  echo "==> Using the existing build (run with REBUILD=1 to rebuild)"
else
  if [ "$(uname -m)" = "armv6l" ]; then
    echo
    echo "This Pi (Pi 1, Zero or Zero W) can run 3018 Studio, but is too old to build it."
    echo "On another computer, in this folder, run:  npm install && npm run build:pi"
    echo "then copy the 'dist' and 'dist-server' folders here and run this script again."
    exit 1
  fi
  echo "==> Installing build tools (a few minutes on a Pi)"
  npm ci --no-audit --no-fund
  sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.studio-lock-hash
  echo "==> Building"
  npm run build:pi
  if [ -d .git ]; then git rev-parse HEAD > dist-server/BUILT_FROM; fi
fi

echo "==> Settings in $SETTINGS"
if [ ! -f "$SETTINGS" ]; then
  sudo install -m 600 -o root -g root pi/3018-studio.env.example "$SETTINGS"
  echo "    Created with defaults"
else
  echo "    Keeping your existing settings"
fi

echo "==> Allowing $APP_USER to use USB serial ports"
sudo usermod -aG dialout "$APP_USER"

SYSTEMCTL="$(readlink -f "$(command -v systemctl)")"

echo "==> Allowing the app to shut down, restart and update the Pi (and nothing else)"
rules="$(mktemp)"
cat > "$rules" <<RULES
# Written by 3018 Studio's pi/install.sh: lets the app's buttons shut down,
# restart and update the Pi. Remove this file to take that away.
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL poweroff, $SYSTEMCTL reboot, $SYSTEMCTL start --no-block 3018-studio-update.service, $SYSTEMCTL restart 3018-studio
RULES
if sudo visudo -cqf "$rules"; then
  sudo install -m 440 -o root -g root "$rules" "$SUDOERS"
else
  echo "    Skipped: the permission rules did not validate"
fi
rm -f "$rules"

echo "==> Installing the service"
sudo tee "$UPDATE_SERVICE" >/dev/null <<UNIT
[Unit]
Description=Update 3018 Studio from GitHub

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=STUDIO_SYSTEMCTL=$SYSTEMCTL
ExecStart=/bin/bash $APP_DIR/pi/update.sh
UNIT
sudo tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=3018 Studio (CNC controller web app)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
SupplementaryGroups=dialout
WorkingDirectory=$APP_DIR
EnvironmentFile=-$SETTINGS
Environment=STUDIO_SYSTEMCTL=$SYSTEMCTL
ExecStart=$(command -v node) $APP_DIR/dist-server/main.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable 3018-studio >/dev/null
sudo systemctl restart 3018-studio
sleep 3

PORT="$(sudo sed -n 's/^STUDIO_PORT=//p' "$SETTINGS")"
PORT="${PORT:-8018}"
if systemctl is-active --quiet 3018-studio; then
  echo
  echo "3018 Studio is running. On any computer, phone or tablet on your network, open:"
  echo "    http://$(hostname).local:$PORT"
  for ip in $(hostname -I); do
    case "$ip" in *:*) ;; *) echo "    http://$ip:$PORT" ;; esac
  done
  echo
  echo "Settings (password, port): sudo nano $SETTINGS  then  sudo systemctl restart 3018-studio"
  echo "Logs:                      journalctl -u 3018-studio -f"
else
  echo "The service did not start. See: journalctl -u 3018-studio -n 50"
  exit 1
fi
