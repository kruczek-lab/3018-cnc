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

## 3. Copy the app to the Pi

Open a **second** Terminal window on the Mac (⌘N), and copy the zip across. Type `scp `
(with a space), drag the zip file into the window, then type ` yourname@cnc.local:` and press
Return:
```
scp /Users/you/Downloads/3018-cnc-claude-grbl-web-app.zip yourname@cnc.local:
```
Back in the **first** window (the Pi), unpack it:
```
sudo apt-get install -y unzip
unzip 3018-cnc-*.zip
mv 3018-cnc-*/ studio
cd studio
```

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

## Everyday commands (on the Pi, over ssh)

| What | Command |
| --- | --- |
| See what it's doing | `journalctl -u 3018-studio -f` (Ctrl-C to stop watching) |
| Restart it | `sudo systemctl restart 3018-studio` |
| Stop it / start it | `sudo systemctl stop 3018-studio` / `sudo systemctl start 3018-studio` |
| Shut the Pi down safely | `sudo poweroff` |

## Updating to a new version

Copy the new zip over as in step 3, then on the Pi:
```
rm -rf studio
unzip 3018-cnc-*.zip && mv 3018-cnc-*/ studio && cd studio
bash pi/install.sh
```
Your settings and password are kept.

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
ready-made build. Raspberry Pi OS Lite (32-bit) is needed on these models.

## Removing it

```
sudo systemctl disable --now 3018-studio
sudo rm /etc/systemd/system/3018-studio.service /etc/default/3018-studio
rm -rf ~/studio
```
