# 3018 Studio

A browser app for the SainSmart Genmitsu **CNC 3018-PRO** (or any GRBL 1.1 machine). It replaces
the bundled Candle software: it turns a design into G-code and streams it to the machine over USB.
Nothing to install — it runs in Chrome or Edge on macOS, Windows, Linux or a Chromebook.

It was built with linocuts in mind, but the machine side knows nothing about linocuts. Every job
type just produces G-code, and any G-code file from other software can be run too.

| Job type | What it's for |
| --- | --- |
| **Carve an image** | Linocuts, rubber stamps, printing blocks (remove the light areas), or engraving a picture into wood/acrylic (remove the dark areas). |
| **Engrave lines from an SVG** | Follows every line in a drawing — signs, text, outlines. |
| **Surface an area** | Flattens the spoilboard or stock so shallow carving comes out even. |
| **Open a G-code file** | Run output from Inkscape, Estlcam, Kiri:Moto, Carbide Create, etc. |

There is also a **simulator**: a pretend GRBL machine in the browser, for trying things out with
no machine attached.

## Two ways to run it

- **On your computer**, with the 3018 plugged into it by USB. Needs Chrome or Edge, and the
  computer has to stay awake until a job finishes. See *Using it* below.
- **On a Raspberry Pi** next to the machine. Use it from any browser on your network (phone
  included), and close the laptop once a job has started. See **[pi/README.md](pi/README.md)**.

## Using it

1. Open the app in **Chrome or Edge** (Safari and Firefox can't talk to USB serial devices).
2. Plug in the 3018 and press **Connect USB**; pick the port (on a Mac it looks like
   `USB Serial` / `wchusbserial…`). If no port appears, install the CH340 driver from the
   chip maker, WCH. Recent macOS versions usually include it.
3. Optional but recommended: set the **travel limits** (see below).
4. Jog the bit to the bottom-left corner of where the design should go and press **Zero X and Y**.
5. Set Z zero with the **paper method**: put a sheet of paper on the material, jog Z down in
   0.1 mm then 0.01 mm steps until the bit just grips the paper, then press **Z0 on paper**.
6. Load a file (or generate one) and check the preview. Press **Trace outline** to watch the
   bit, raised and with the spindle off, go round the edge of the job: it should stay on the
   material and clear of clamps. Then press **Start**.

**Pause** is a feed hold (the spindle keeps turning; **Resume** continues). **Stop** holds, waits for
the machine to stop, then resets the controller, so the position isn't lost. **Reset controller**
stops everything immediately.

**While it cuts:** the **Feed** and **Spindle** buttons in the run bar speed the job up or slow it
down in 10% steps, instantly, without regenerating the file: handy for finding the right speed
for a new material. Commands can't be sent while a job runs (they would land in the middle of it).

**Picking a job up part-way:** **Start from…** asks for a line number and, after a stopped job,
suggests one a little before where it got to. The bit lifts, starts the spindle, moves to where
that line begins and plunges there. If the controller lost its position in between (a red
"zero may have moved" note), set the zero again exactly first.

**"The zero may have moved":** when the controller restarts (reconnecting, a USB glitch, the Pi
server restarting) it forgets where the machine is but keeps the saved zero, so the zero can end
up in the wrong place. The app shows a red note under the position display, and Start warns too,
until you set X/Y and Z zero again.

**Placing a design:** for image and SVG jobs, *Placement* moves the design's bottom-left corner
away from X0 Y0 and can turn it in quarter turns, e.g. to fit a tall design on a wide block.

## Travel limits

Without limit switches the machine doesn't know where the ends of its axes are; driving past
one makes the motor stall and lose its position, so the rest of the job lands in the wrong place.
The app can guard against that once it knows one corner:

1. After switching on, jog **X−** until X reaches its end, **Y−** until Y reaches its end and
   **Z+** until the spindle is at the top. Use small steps near the ends.
2. Press **Set reference here** (in *Travel limits*).

From then on:
- jogs stop at the ends of the axes;
- the preview shows the reachable area as a dashed rectangle;
- the run bar says whether the selected job fits from the current zero, and **Start** asks before
  running one that doesn't (you can still start it: the check is advice, not a lock).

The travel size (300 × 180 × 45 mm for the 3018-PRO) and a safety margin are under
*How it works & settings*. The reference is forgotten automatically whenever position may be
lost (an alarm, a controller restart, a lost connection), and the app asks you to set it again.
It can't notice skipped steps (e.g. cutting too fast) or the axes being turned by hand with the
power off; set it again if either happens. Commands typed into the console aren't checked.

### When you fit limit switches

The same checks then come from homing, which is exact and automatic. After wiring the switches,
type these into the console (one per line), with a hand near the power switch the first time:

| Setting | Meaning |
| --- | --- |
| `$22=1` | Enable homing. The **Home** button appears in place of *Set reference here*. |
| `$23=0` | Which way each axis homes. `0` = towards X+, Y+ and Z+ (switches at those ends). If an axis heads the wrong way, see the GRBL docs for the mask value. |
| `$27=2` | Back off 2 mm from the switch after homing. |
| `$130=300` `$131=180` `$132=45` | The travel of each axis in mm (measure yours). |
| `$20=1` | GRBL's own soft limits: it also refuses moves past the ends, including from programs made elsewhere. |

With homing enabled, GRBL starts up locked (*Alarm*) until you press **Home**. Then use the
machine as before. Hard limits (`$21=1`, stopping instantly when a switch is touched) are often
set off by electrical noise from the spindle on these machines; leave them off unless your
switch wiring is shielded.

## Making a linocut

1. Choose **Carve an image**, pick a black-and-white image and set the width in mm.
   Adjust the threshold until the **Print preview** looks right. Leave **Mirror** on.
2. Fill in your bits:
   - **Detail — V-bit**: a 20–30° engraving bit cuts crisp edges with sloped walls that support
     the printing surface. *Depth* around 1 mm suits lino (typically 3–4.5 mm thick).
   - **Clearing — flat end mill** (optional): a 2–3.175 mm bit removes large open areas
     much faster. Clearing a little deeper than the detail (e.g. 1.5 mm) keeps the roller out of
     big spaces.
3. **Generate G-code** produces one file per bit: `…1-clearing.nc` and `…2-detail.nc`.
4. Run the clearing file, swap to the V-bit, **re-zero Z only** (paper method — don't touch X/Y),
   then run the detail file.

The print preview shows in red anything narrower than your bits can reach; it will stay at
surface height and pick up ink. Use a finer V-bit, a smaller *min depth*, or thicken the design.

Tips:
- Fix the block with double-sided carpet tape. Lino is soft: around 600–800 mm/min with the
  spindle at full speed works well; slow down if edges crumble.
- Shallow cuts are very sensitive to a block that isn't flat. Surface the spoilboard once
  (**Surface an area** with the largest flat bit you have, 0.2–0.3 mm deep).
- Try settings on a scrap first, and run the clearing pass with the spindle guard in place.

## How the carving planner works

Everything is computed from one *distance field*: for every pixel, the distance to the nearest
part that must stay. A V-bit plunged to depth *d* cuts a circle of radius `tip/2 + d·tan(angle/2)`
at the surface, so tracing the line where the distance equals that radius cuts exactly to the
edge. More traces at full depth widen the cut; shallower ones reach into narrow gaps and sharp
corners (like V-carving). The end mill only goes where it fits entirely. A coverage map records
what has been cut, so redundant passes are skipped and anything left is shown in red.

## Development

```sh
npm install
npm run dev       # http://localhost:5173
npm test          # unit tests (planner, G-code, GRBL streaming, simulator, Pi server)
npm run test:e2e  # browser tests: builds, then drives the app in Chromium in both USB and Pi mode
npm run build     # typecheck, static site in dist/, Pi server in dist-server/
npm start         # run the Pi server locally: http://localhost:8018
```

The serial-port tests need `socat` (virtual serial cables); they're skipped without it. The
browser tests need Playwright's Chromium (`npx playwright install chromium`). Both run in CI.

Code layout:

- `src/machine/`: GRBL protocol. `controller.ts` streams with GRBL's character-counting
  protocol (keeps its 128-byte buffer full), parses status reports and handles
  pause/resume/stop and errors. `webSerialTransport.ts` is the USB link; `simulator.ts` is the
  fake machine.
- `src/gcode/`: cleaning, parsing and analysing G-code (preview, bounds, time estimate).
- `src/cam/`: design → toolpaths. `carve.ts` (image carving), `svgLines.ts`, `surfacing.ts`, and
  `operation.ts` which writes G-code. New job types go here; they only need to produce an
  `Operation`.
- `src/files/library.ts`: the file list, kept in the browser (USB mode) or on the Pi.
- `src/ui/preview.ts`, `src/main.ts`: the interface. `src/machine/client.ts` is what the interface
  needs from a machine; `src/remote/remoteMachine.ts` provides it over the network.
- `server/`: the Raspberry Pi server. It runs the same `GrblController` next to the machine
  (`linuxSerial.ts` opens the USB port with `stty`, no native modules) and serves the app plus a
  small JSON API and a Server-Sent Events stream of state and log. `files.ts` keeps G-code files
  and shared settings in `~/.local/share/3018-studio`. `pi/install.sh` installs it as a systemd
  service.

### Hosting

`.github/workflows/pages.yml` runs the tests and publishes the app to GitHub Pages on every push
to `main`. Turn it on once in the repository's **Settings → Pages → Source: GitHub Actions**. Web
Serial needs HTTPS or `localhost`, which Pages provides.

## Ideas for later

- Auto-levelling: probe a grid with a DIY probe (crocodile clip on the bit + foil on the work,
  wired to the board's probe pins) and warp the G-code to match a warped block.
- Multi-colour reduction prints with registration marks; text tool; laser module support.
- Deeper clearing further from the edges; a 3-D simulation of the carved block.
