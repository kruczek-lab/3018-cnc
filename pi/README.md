# Running 3018 Studio on a Raspberry Pi

With the 3018 plugged into a Raspberry Pi, you can use the app from any computer, phone or
tablet on your home network, in any browser (Safari too). Jobs run on the Pi, so you can close
the laptop once a carve has started, and check on it from your phone.

## Which Pi?

| Model | Works? |
| --- | --- |
| **Pi 3** (Model B, B+ or A+) | **Best choice.** Built-in Wi-Fi, quick enough to install everything itself. |
| Pi 4 / Pi 5 / Zero 2 W | Also great. |
| Pi 2 | Works, but has no Wi-Fi: use an Ethernet cable (or a USB Wi-Fi dongle). |
| Zero W, Zero, Pi 1 Model A/B | Can *run* the app but can't *build* it. Not recommended to start with (see the end). |

The model is printed on the board, e.g. "Raspberry Pi 3 Model B+". Use a proper power supply
(5 V, 2.5 A for a Pi 3). A weak one causes USB drop-outs, which stop a running job.

## 1. Prepare the SD card (on your Mac)

1. Install **Raspberry Pi Imager** from raspberrypi.com/software and open it.
2. **Choose Device**: your model (e.g. Raspberry Pi 3).
3. **Choose OS**: *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.
   (Lite has no desktop, which is all we need. For a Pi 2 choose the 32-bit Lite.)
4. **Choose Storage**: the SD card (8 GB or more).
5. Click **Next** → **Edit Settings**:
   - **Hostname**: `cnc`
   - **Username and password**: pick your own; you'll need them in a moment.
   - **Wireless LAN**: your Wi-Fi name and password, and your country.
   - On the **Services** tab: tick **Enable SSH** → *Use password authentication*.
6. **Save** → **Yes** → wait for it to write and verify.

## 2. Start the Pi and log in to it

1. Put the card in the Pi and power it up. Give it 2–3 minutes the first time.
2. On the Mac, open **Terminal** and type (with your username):
   ```
   ssh yourname@cnc.local
   ```
   Answer `yes` to the question about authenticity, then type the Pi's password (nothing
   shows while you type). The prompt changes to `yourname@cnc:~ $`. You're now typing on the Pi.

## 3. Download the app onto the Pi

In the same window (logged in to the Pi), type these two lines:
```
sudo apt-get install -y git
git clone --branch claude/grbl-web-app https://github.com/kruczek-lab/3018-cnc.git studio
```
The first installs git, a tool for downloading and updating code. The second downloads the app
into a folder called `studio`. Then go into that folder:
```
cd studio
```

Downloading it this way (rather than copying a zip) is what lets the Pi update itself later.

## 4. Install

Still on the Pi:
```
bash pi/install.sh
```
This installs Node.js, builds the app (about 5–10 minutes on a Pi 3), and sets it up to start
automatically whenever the Pi powers on. It ends by printing the address, e.g.
`http://cnc.local:8018`.

## 5. Use it

1. Plug the 3018's USB cable into the Pi and switch the machine on.
2. On your Mac, phone or tablet, open **http://cnc.local:8018**.
3. The top bar says **Pi · …**. Press **Connect machine** (it connects by itself if the
   machine was on when the Pi started).
4. Everything else works as in the main README: create a job, set zero, **Start**.
   Files you make or open are stored on the Pi, so they're there on every device and after the
   browser is closed; settings such as bit sizes and feeds are shared the same way.
5. Once a job is running you can close the page. Open the address on your phone to watch,
   pause or stop it. Tip: in Safari use *Share → Add to Home Screen* for a one-tap icon.

**Simulator** runs a pretend machine on the Pi, handy to practise with the machine switched off.

## Set a password (recommended)

Without one, anyone on your Wi-Fi can move the machine. On the Pi:
```
sudo nano /etc/default/3018-studio
```
Put a password after `STUDIO_PASSWORD=`, press Ctrl-O, Return, Ctrl-X, then:
```
sudo systemctl restart 3018-studio
```
Each browser asks for it once.

## Shutting down and restarting the Pi

Always shut the Pi down before unplugging it; pulling the power can damage its SD card.

In the app, the **Raspberry Pi** section (under the machine controls) has **Shut down Pi** and
**Restart Pi**. They switch the spindle off and disconnect the machine first, and they're refused
while a job is running. After **Shut down Pi**, wait until the green light on the Pi stops
flashing (about 30 seconds), then unplug it. To turn it back on, plug the power back in.

These buttons are deliberately the only things the app can do to the Pi itself. For anything
else, log in with ssh.

## Updating

In the app's **Raspberry Pi** section press **Check for updates**. If there are any, it lists
them; press **Install update**. The Pi downloads and builds the new version (a few minutes on
a Pi 3) while the old one keeps running, then switches over and the page reloads by itself.
If anything goes wrong, the old version simply carries on. Updates are refused while a job runs.

The same from ssh, showing the progress:
```
cd ~/studio
bash pi/update.sh
```
If an update ever says *"this update changed the installer"*, run `bash pi/install.sh` once.

**Switching to the main version later.** The app currently comes from the `claude/grbl-web-app`
branch. Once it's merged into `main`, switch the Pi over with:
```
cd ~/studio
git switch main
bash pi/update.sh
```

## Everyday commands (on the Pi, over ssh)

| What | Command |
| --- | --- |
| See what it's doing | `journalctl -u 3018-studio -f` (Ctrl-C to stop watching) |
| See how the last update went | `journalctl -u 3018-studio-update -n 50` |
| Restart the app | `sudo systemctl restart 3018-studio` |
| Stop it / start it | `sudo systemctl stop 3018-studio` / `sudo systemctl start 3018-studio` |
| Shut the Pi down safely | `sudo poweroff` |

### Installed from a zip?

A copy installed from a zip can't update itself (the app says so). Switch to a git copy once;
your settings and password are kept:
```
rm -rf ~/studio
sudo apt-get install -y git
git clone --branch claude/grbl-web-app https://github.com/kruczek-lab/3018-cnc.git ~/studio
cd ~/studio && bash pi/install.sh
```

## Troubleshooting

- **`cnc.local` doesn't open** (common on Android and some routers): use the Pi's number address
  instead. The installer printed it, or run `hostname -I` on the Pi, e.g. `http://192.168.1.42:8018`.
- **"No USB serial port found"**: check the machine is on and the cable is in, then run
  `ls /dev/ttyUSB*` on the Pi; it should list `/dev/ttyUSB0`. Try another cable (some only charge).
- **Connection drops mid-job**: usually power or electrical noise from the spindle. Use a good
  Pi power supply and a short USB cable, and keep it away from the spindle wires.
- **Page says "Pi unreachable"**: the Pi is off, rebooting, or off the Wi-Fi. A running job carries on
  as long as the Pi itself is up.

## Pi Zero W and Pi 1 (advanced)

These older chips can't run the build tools, but can run the finished app. On the Mac, in the
project folder, run `npm install && npm run build:pi`. Then copy the whole folder, now with
`dist` and `dist-server` in it, to the Pi, and run `bash pi/install.sh` there; it uses the
ready-made build. Raspberry Pi OS Lite (32-bit) is needed on these models. The **Install
update** button doesn't work on them for the same reason: update by rebuilding on the Mac
and copying again.

## Removing it

```
sudo systemctl disable --now 3018-studio
sudo rm -f /etc/systemd/system/3018-studio.service /etc/systemd/system/3018-studio-update.service
sudo rm -f /etc/sudoers.d/3018-studio
sudo systemctl daemon-reload
rm -rf ~/studio
```
Use your app folder's name in the last line if it isn't `studio`. Your password and port stay
in `/etc/default/3018-studio`, and your saved files and shared settings in
`~/.local/share/3018-studio`, ready for a reinstall. To remove those too:
`sudo rm -f /etc/default/3018-studio` and `rm -rf ~/.local/share/3018-studio`.
