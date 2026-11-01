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

## Using it

1. Open the app in **Chrome or Edge** (Safari and Firefox can't talk to USB serial devices).
2. Plug in the 3018 and press **Connect USB**; pick the port (on a Mac it looks like
   `USB Serial` / `wchusbserial…`). If no port appears, install the CH340 driver from the
   chip maker, WCH. Recent macOS versions usually include it.
3. Jog the bit to the bottom-left corner of where the design should go and press **Zero X and Y**.
4. Set Z zero with the **paper method**: put a sheet of paper on the material, jog Z down in
   0.1 mm then 0.01 mm steps until the bit just grips the paper, then press **Z0 on paper**.
5. Load a file (or generate one), check the preview, press **Start**.

**Pause** is a feed hold (the spindle keeps turning; **Resume** continues). **Stop** holds, waits for
the machine to stop, then resets the controller, so the position isn't lost. **Reset controller**
stops everything immediately.

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
npm run dev      # http://localhost:5173
npm test         # unit tests (planner, G-code, GRBL streaming, simulator)
npm run build    # static site in dist/
```

Code layout:

- `src/machine/`: GRBL protocol. `controller.ts` streams with GRBL's character-counting
  protocol (keeps its 128-byte buffer full), parses status reports and handles
  pause/resume/stop and errors. `webSerialTransport.ts` is the USB link; `simulator.ts` is the
  fake machine.
- `src/gcode/`: cleaning, parsing and analysing G-code (preview, bounds, time estimate).
- `src/cam/`: design → toolpaths. `carve.ts` (image carving), `svgLines.ts`, `surfacing.ts`, and
  `operation.ts` which writes G-code. New job types go here; they only need to produce an
  `Operation`.
- `src/ui/preview.ts`, `src/main.ts`: the interface.

### Hosting

`.github/workflows/pages.yml` runs the tests and publishes the app to GitHub Pages on every push
to `main`. Turn it on once in the repository's **Settings → Pages → Source: GitHub Actions**. Web
Serial needs HTTPS or `localhost`, which Pages provides.

## Ideas for later

- Auto-levelling: probe a grid with a DIY probe (crocodile clip on the bit + foil on the work,
  wired to the board's probe pins) and warp the G-code to match a warped block.
- Homing, once the limit switches are fitted (`$22=1`, then `$H`).
- Multi-colour reduction prints with registration marks; text tool; laser module support.
- Deeper clearing further from the edges; a 3-D simulation of the carved block.
