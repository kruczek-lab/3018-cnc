#!/usr/bin/env bash
# Installs 3018 Studio on a Raspberry Pi as a service that starts at boot.
# Run from the unpacked project folder:   bash pi/install.sh
# Safe to run again (e.g. after updating the files).
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
SERVICE=/etc/systemd/system/3018-studio.service
SETTINGS=/etc/default/3018-studio

if [ "$(id -u)" -eq 0 ]; then
  echo "Please run this as your normal user (it uses sudo where needed): bash pi/install.sh"
  exit 1
fi
APP_USER="$(id -un)"

echo "==> Checking Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  sudo apt-get update
  sudo apt-get install -y nodejs npm
fi
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
  echo "==> Building"
  npm run build:pi
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

echo "==> Installing the service"
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
