import './style.css';
import { GrblController, OVERRIDES, type JobView, type LogKind, type StartOptions } from './machine/controller';
import { checkMoves, checkPoint, describeViolations } from './machine/travel';
import type { Vec3 } from './machine/status';
import { traceOutline } from './gcode/trace';
import { resumeFrom } from './gcode/resume';
import type { MachineClient } from './machine/client';
import { RemoteMachine, detectRemote } from './remote/remoteMachine';
import { WebSerialTransport } from './machine/webSerialTransport';
import { SimulatedGrbl } from './machine/simulator';
import { analyzeProgram } from './gcode/analyze';
import { maskFromRGBA, mirrorMask, type Mask } from './cam/mask';
import { planCarve, COVERAGE, type CarveSettings } from './cam/carve';
import { emitGcode, orderPaths, type Operation } from './cam/operation';
import { placePaths, type Placement, type Rotation } from './cam/placement';
import { planSurfacing } from './cam/surfacing';
import { svgToPolylines } from './cam/svgLines';
import { LocalLibrary, RemoteLibrary, type Library, type LoadedFile, type NewFile } from './files/library';
import { PreviewCanvas, bitmapLayer, cssVar } from './ui/preview';

// ───────────────────────── helpers ─────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const value = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id).value;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const fmt = (v: number) => v.toFixed(3);
const minutes = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const MAX_PIXELS = 6_000_000;

// ───────────────────────── controller ─────────────────────────

// Served by the Pi server → drive the machine attached to the Pi; otherwise talk USB from this browser.
const remote = (await detectRemote()) ? new RemoteMachine() : null;
const local = remote ? null : new GrblController();
const controller: MachineClient = remote ?? local!;
const library: Library = remote ? new RemoteLibrary(remote) : new LocalLibrary();

// ───────────────────────── persisted settings ─────────────────────────

// Kept in this browser, and on the Pi too when there is one, so every device uses the same bits and feeds.
const SETTINGS_KEY = 'studio3018.settings';
type Settings = Record<string, string | boolean>;

function applySettings(saved: Settings) {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((el) => {
    const v = saved[el.dataset.key!];
    if (v === undefined) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = String(v);
  });
}

function collectSettings(): Settings {
  const data: Settings = {};
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((el) => {
    data[el.dataset.key!] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
  });
  return data;
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;
function saveSettings() {
  const data = collectSettings();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable */
  }
  if (remote) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => remote.saveSettings(data).catch(() => undefined), 500);
  }
}

try {
  applySettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  /* storage unavailable */
}
if (remote) {
  try {
    const shared = await remote.settings();
    if (Object.keys(shared).length) applySettings(shared);
    else saveSettings(); // first device to connect: share its settings
  } catch {
    /* older Pi version without shared settings */
  }
}
document.addEventListener('change', (e) => {
  if ((e.target as HTMLElement).dataset?.key) saveSettings();
});

// ───────────────────────── log ─────────────────────────

const logEl = $('log');
function log(kind: LogKind, text: string) {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = (kind === 'tx' ? '> ' : '') + text;
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.appendChild(line);
  while (logEl.childElementCount > 500) logEl.firstElementChild!.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
controller.onLog(log);
log('info', remote
  ? 'Running from the Raspberry Pi. Jobs run on the Pi, so you can close this page while it carves.'
  : 'Welcome. Connect the machine over USB (Chrome or Edge), or try the simulator.');

async function send(command: string) {
  try {
    return await controller.send(command);
  } catch (e) {
    log('error', String(e));
    return 'error';
  }
}

// ───────────────────────── machine panel ─────────────────────────

if (remote) {
  $('btn-connect').textContent = 'Connect machine';
  $('btn-connect').title = 'Connect to the 3018 plugged into the Pi';
  $('btn-simulator').title = 'Run the simulator on the Pi';
  $('mode').textContent = 'Connected through the Raspberry Pi';
} else if (!WebSerialTransport.isSupported()) {
  $('serial-unsupported').hidden = false;
  $<HTMLButtonElement>('btn-connect').disabled = true;
}

async function connect(simulator: boolean) {
  if (remote) return remote.connect(simulator);
  try {
    await local!.connect(simulator ? new SimulatedGrbl() : new WebSerialTransport());
  } catch (e) {
    if ((e as Error)?.name !== 'NotFoundError') log('error', `Could not connect: ${(e as Error).message ?? e}`);
  }
}
$('btn-connect').addEventListener('click', () => connect(false));
$('btn-simulator').addEventListener('click', () => connect(true));
$('btn-disconnect').addEventListener('click', () => controller.disconnect());

document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => b.addEventListener('click', () => send(b.dataset.cmd!)));
$('btn-zero-paper').addEventListener('click', () => send('G10 L20 P1 Z0.1'));
$('btn-goto-zero').addEventListener('click', async () => {
  const m = controller.machine;
  const liftZ = Math.max(m.wpos[2], 5);
  if (m.limits) {
    const target: Vec3 = [m.wco[0], m.wco[1], liftZ + m.wco[2]];
    const violations = checkPoint(target, m.limits);
    if (violations.length) {
      log('error', `Not moving: X0 Y0 is ${describeViolations(violations)}.`);
      return;
    }
  }
  if (m.wpos[2] < 5) await send('G90 G0 Z5');
  await send('G90 G0 X0 Y0');
});
$('btn-spindle-on').addEventListener('click', () => send(`M3 S${num('spindle-s')}`));
$('btn-reset').addEventListener('click', () => controller.softReset());

document.querySelectorAll<HTMLButtonElement>('[data-jog]').forEach((b) =>
  b.addEventListener('click', () => {
    const distance = Number(value('jog-step')) * Number(b.dataset.dir);
    send(`$J=G91 G21 ${b.dataset.jog}${distance} F${num('jog-feed')}`);
  }),
);

// ───────────────────────── travel limits ─────────────────────────

const travelSize = (): Vec3 => [num('travel-x'), num('travel-y'), num('travel-z')];
const travelMargin = () => Math.max(0, num('travel-margin'));

$('btn-set-reference').addEventListener('click', async () => {
  const question = [
    'Is the machine at the reference corner?',
    '',
    '• X jogged all the way to its X− end',
    '• Y jogged all the way to its Y− end',
    '• Z jogged all the way up (Z+)',
    '',
    `Travel: ${travelSize().join(' × ')} mm (change under "How it works & settings").`,
  ].join('\n');
  if (!confirm(question)) return;
  try {
    await controller.setTravelReference(travelSize(), travelMargin());
  } catch (e) {
    log('error', (e as Error).message);
  }
});
$('btn-clear-limits').addEventListener('click', () => controller.clearLimits());
$('btn-home').addEventListener('click', async () => {
  try {
    const response = await controller.home(travelMargin());
    if (response !== 'ok') log('error', `Homing failed (${response}).`);
  } catch (e) {
    log('error', (e as Error).message);
  }
});

// ───────────────────────── console ─────────────────────────

const history: string[] = [];
let historyIndex = 0;
$('console-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('console-input');
  const text = input.value.trim();
  if (!text) return;
  history.push(text);
  historyIndex = history.length;
  input.value = '';
  if (text === '?') controller.realtime('?');
  else send(text);
});
$('console-input').addEventListener('keydown', (e) => {
  const input = e.target as HTMLInputElement;
  if (e.key === 'ArrowUp' && historyIndex > 0) input.value = history[--historyIndex];
  else if (e.key === 'ArrowDown' && historyIndex < history.length) input.value = history[++historyIndex] ?? '';
  else return;
  e.preventDefault();
});

// ───────────────────────── preview ─────────────────────────

const preview = new PreviewCanvas($<HTMLCanvasElement>('preview'));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((tab) =>
  tab.addEventListener('click', () => showView(tab.dataset.view as 'toolpath' | 'print')),
);
function showView(view: 'toolpath' | 'print') {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  preview.setMode(view);
  updateLegend();
}
let legendMode: 'relief' | 'engrave' = 'relief';
function updateLegend() {
  const sw = (color: string, label: string) => `<span><i style="background:${color}"></i>${label}</span>`;
  const [stays, removed] = legendMode === 'relief' ? ['--ink', '--carved'] : ['--carved', '--ink'];
  $('legend').innerHTML =
    preview.mode === 'print'
      ? sw(`var(${stays})`, legendMode === 'relief' ? 'Prints' : 'Surface') + sw(`var(${removed})`, legendMode === 'relief' ? 'Carved away' : 'Engraved') + sw('var(--missed)', 'Too narrow for the bits')
      : sw('var(--rapid)', 'Travel') + sw('var(--text)', 'Cut (darker = deeper)') + sw('var(--done)', 'Done');
}
updateLegend();

// ───────────────────────── files ─────────────────────────

let active: LoadedFile | null = null;

function setActive(file: LoadedFile | null) {
  active = file;
  preview.setProgram(file?.info ?? null, file?.block ?? null);
  if (file?.print) preview.setPrint(file.print);
  renderFiles();
  renderRun();
}

async function selectFile(id: string) {
  if (controller.jobActive) return;
  const file = await library.load(id);
  if (file) setActive(file);
  else log('error', 'That file is no longer available.');
}

async function addFile(file: NewFile): Promise<LoadedFile> {
  const added = await library.add(file);
  if (added.info.warnings.length) log('info', `${added.name}: ${added.info.warnings.join(' ')}`);
  return added;
}

async function download(id: string) {
  const file = await library.load(id);
  if (!file) return;
  const url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name.replace(/[^\w.\- ]+/g, '_') + (/\.\w+$/.test(file.name) ? '' : '.nc');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderFiles() {
  const list = $('files');
  list.innerHTML = '';
  const entries = library.list();
  if (!entries.length) {
    list.innerHTML = '<li class="muted">Nothing yet.</li>';
    return;
  }
  const running = controller.jobActive;
  for (const entry of entries) {
    const isActive = entry.id === active?.id;
    const li = document.createElement('li');
    li.className = 'file' + (isActive ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = `${entry.tool ? entry.tool + ' · ' : ''}${entry.summary}`;
    const row = document.createElement('div');
    row.className = 'row';
    const button = (label: string, fn: () => void, disabled = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      row.appendChild(b);
    };
    button(isActive ? 'Selected' : 'Select', () => selectFile(entry.id), isActive || running);
    button('Download', () => download(entry.id));
    button('Remove', async () => {
      if (remote && !confirm(`Remove "${entry.name}" from the Pi?`)) return;
      await library.remove(entry.id).catch((e) => log('error', (e as Error).message));
      if (active?.id === entry.id) setActive(null);
    }, running && isActive);
    li.append(name, meta, row);
    list.appendChild(li);
  }
}
library.onChange(() => {
  // Another device removed the file this one has open.
  if (active && !library.list().some((f) => f.id === active!.id)) setActive(null);
  else renderFiles();
});

// ───────────────────────── design panel ─────────────────────────

function showJobType() {
  const type = value('job-type');
  document.querySelectorAll<HTMLElement>('[data-job]').forEach((s) => (s.hidden = !s.dataset.job!.split(' ').includes(type)));
}
$('job-type').addEventListener('change', showJobType);
showJobType();

function syncClearing() {
  $('clear-fields').closest('fieldset')!.classList.toggle('disabled', !checked('clear-enabled'));
}
$('clear-enabled').addEventListener('change', syncClearing);
syncClearing();

function message(text: string, kind: 'note' | 'error' | 'warn' = 'note') {
  const el = $('generate-message');
  el.hidden = !text;
  el.className = `note ${kind === 'note' ? '' : kind}`;
  el.textContent = text;
}

const placement = (): Placement => ({ x: num('place-x'), y: num('place-y'), rotation: Number(value('place-rotation')) as Rotation });

// Image source
let image: { bitmap: ImageBitmap; name: string } | null = null;

$('image-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    image = { bitmap: await createImageBitmap(file), name: file.name.replace(/\.\w+$/, '') };
    updateImageDraft();
    showView('print');
  } catch {
    message('Could not read that image.', 'error');
  }
});

function rasterize(res: number): Mask {
  if (!image) throw new Error('Choose an image first.');
  const widthMM = num('img-width');
  const w = Math.max(2, Math.round(widthMM / res));
  const h = Math.max(2, Math.round((widthMM * image.bitmap.height) / image.bitmap.width / res));
  if (w * h > MAX_PIXELS) throw new Error(`That is ${(w * h / 1e6).toFixed(1)} million pixels — use a coarser resolution (larger mm/px).`);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.bitmap, 0, 0, w, h);
  const mask = maskFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h, res, num('img-threshold'), value('img-mode') === 'engrave');
  return checked('img-mirror') ? mirrorMask(mask) : mask;
}

function maskColors(): Record<number, string> {
  const relief = value('img-mode') === 'relief';
  return {
    [COVERAGE.keep]: cssVar(relief ? '--ink' : '--carved'),
    [COVERAGE.cut]: cssVar(relief ? '--carved' : '--ink'),
    [COVERAGE.missed]: cssVar('--missed'),
  };
}

/** Quick low-resolution preview of the threshold while adjusting settings. */
function updateImageDraft() {
  if (!image) return;
  const widthMM = num('img-width');
  $('img-height').textContent = `${((widthMM * image.bitmap.height) / image.bitmap.width).toFixed(1)}`;
  legendMode = value('img-mode') as 'relief' | 'engrave';
  updateLegend();
  try {
    const mask = rasterize(Math.max(num('img-res'), widthMM / 800));
    // keep = 0 in COVERAGE terms; everything else would be carved.
    const values = mask.keep.map((k) => (k ? COVERAGE.keep : COVERAGE.cut));
    preview.setPrint(bitmapLayer(values, mask.width, mask.height, mask.res, maskColors(), checked('img-mirror')));
    message('');
  } catch (e) {
    message((e as Error).message, 'error');
  }
}
['img-width', 'img-threshold', 'img-mode', 'img-mirror', 'img-res'].forEach((id) => $(id).addEventListener('input', updateImageDraft));

// SVG source
let svg: { text: string; name: string } | null = null;
$('svg-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) svg = { text: await file.text(), name: file.name.replace(/\.\w+$/, '') };
});

// G-code files load straight into the list
$('gcode-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    setActive(await addFile({ name: file.name, tool: '', text: await file.text() }));
    showView('toolpath');
  } catch (err) {
    log('error', `Could not add ${file.name}: ${(err as Error).message}`);
  }
  input.value = '';
});

async function generate() {
  const type = value('job-type');
  const safeZ = num('safe-z');
  const spindle = num('job-spindle');
  message('Working…');
  await nextFrame();
  const started = performance.now();
  try {
    const created: LoadedFile[] = [];
    if (type === 'image') {
      const mask = rasterize(num('img-res'));
      const settings: CarveSettings = {
        safeZ,
        detail: {
          angle: num('v-angle'),
          tipDiameter: num('v-tip'),
          depth: num('v-depth'),
          minDepth: num('v-min-depth'),
          feed: num('v-feed'),
          plungeFeed: num('v-plunge'),
          spindle,
        },
        clearing: checked('clear-enabled')
          ? {
              diameter: num('c-diameter'),
              depth: num('c-depth'),
              stepover: num('c-stepover') / 100,
              stepdown: num('c-stepdown'),
              feed: num('c-feed'),
              plungeFeed: num('c-plunge'),
              spindle,
            }
          : null,
      };
      const plan = planCarve(mask, settings);
      const colors = maskColors();
      const place = placement();
      const width = mask.width * mask.res;
      const height = mask.height * mask.res;
      const block = { ...bitmapLayer(plan.coverage, mask.width, mask.height, mask.res, colors), ...place };
      const print = bitmapLayer(plan.coverage, mask.width, mask.height, mask.res, colors, checked('img-mirror'));
      for (const [i, op] of plan.operations.entries()) {
        const placed = { ...op, paths: placePaths(op.paths, width, height, place) };
        created.push(await addFile({ name: `${image!.name} ${i + 1}-${op.name.toLowerCase()}.nc`, tool: op.tool, text: emitGcode(placed), block, print }));
      }
      const total = created.reduce((m, f) => m + f.info.estimatedMinutes, 0);
      const missed = plan.missedArea > 0.5
        ? ` ${plan.missedArea.toFixed(1)} mm² is too narrow for the bits (red in the print preview) and will stay at surface level.`
        : '';
      message(
        `Made ${created.length} file${created.length === 1 ? '' : 's'} (~${minutes(total)} total). Run them in order, changing the bit and re-zeroing Z between them.${missed}`,
        missed ? 'warn' : 'note',
      );
      preview.setPrint(print);
    } else if (type === 'svg') {
      if (!svg) throw new Error('Choose an SVG file first.');
      const width = num('svg-width');
      const { lines, height } = svgToPolylines(svg.text, width, checked('svg-mirror'));
      const depth = num('svg-depth');
      const paths = lines.map((l) => l.map(([x, y]) => [x, y, -depth] as [number, number, number]));
      const op: Operation = {
        name: `Engrave ${svg.name}`,
        tool: value('svg-tool'),
        spindle,
        feed: num('svg-feed'),
        plungeFeed: num('svg-plunge'),
        stepdown: num('svg-stepdown'),
        safeZ,
        paths: orderPaths(placePaths(paths, width, height, placement())),
      };
      created.push(await addFile({ name: `${svg.name}-engrave.nc`, tool: op.tool, text: emitGcode(op) }));
      message(`Made 1 file (~${minutes(created[0].info.estimatedMinutes)}).`);
    } else if (type === 'surface') {
      const op = planSurfacing({
        width: num('s-width'),
        height: num('s-height'),
        diameter: num('s-diameter'),
        depth: num('s-depth'),
        stepover: num('s-stepover') / 100,
        stepdown: num('s-stepdown'),
        feed: num('s-feed'),
        plungeFeed: Math.min(num('s-feed'), 200),
        spindle,
        safeZ,
      });
      created.push(await addFile({ name: `surface-${num('s-width')}x${num('s-height')}.nc`, tool: op.tool, text: emitGcode(op) }));
      message(`Made 1 file (~${minutes(created[0].info.estimatedMinutes)}).`);
    }
    log('info', `Generated ${created.length} file(s) in ${Math.round(performance.now() - started)} ms`);
    if (created.length && !controller.jobActive) {
      setActive(created[0]);
      showView('toolpath');
    }
  } catch (e) {
    message((e as Error).message ?? String(e), 'error');
  }
}
$('btn-generate').addEventListener('click', generate);

// ───────────────────────── run bar ─────────────────────────

/** The program's moves checked against the limits from the current zero: null if no limits are set. */
function limitCheck(lines: string[]): { ok: boolean; text: string } | null {
  const m = controller.machine;
  if (!m.limits) return null;
  const info = active && active.lines === lines ? active.info : analyzeProgram(lines);
  const violations = checkMoves(info.moves, m.wco, m.limits);
  const unchecked = info.unchecked ? ' It also uses machine-coordinate moves (G28/G53 …), which can\'t be checked.' : '';
  return violations.length
    ? { ok: false, text: `From the current zero this job goes ${describeViolations(violations)}.${unchecked}` }
    : { ok: !unchecked, text: unchecked ? `Mostly checked against the travel limits.${unchecked}` : 'Fits inside the travel limits from the current zero.' };
}

const axisList = (axes: string) => [...axes].join(', ').replace(/, (\w)$/, ' and $1');

/** Starts a job, asking first if it goes past the limits. Returns false if it didn't start. */
async function startChecked(name: string, lines: string[], options: StartOptions): Promise<boolean> {
  const check = limitCheck(lines);
  let ignoreLimits = false;
  if (check && !check.ok && /goes/.test(check.text)) {
    if (!confirm(`${check.text}\n\nMove the zero, or start anyway?\n(OK = start anyway)`)) return false;
    ignoreLimits = true;
  }
  try {
    await controller.startJob(name, lines, { ...options, ignoreLimits });
    return true;
  } catch (e) {
    alert((e as Error).message);
    return false;
  }
}

/** The questions to ask before cutting. Returns false if the user backs out. */
function confirmStart(title: string): boolean {
  const file = active!;
  const m = controller.machine;
  if (m.state.startsWith('Alarm')) {
    alert('The controller is in an alarm state. Press Unlock first (and check your zero).');
    return false;
  }
  const b = file.info.cutBounds;
  const checklist = [
    ...(m.zeroUnverified ? [`⚠ The controller restarted since the zero was set, so the ${axisList(m.zeroUnverified)} zero may have moved. Set it again first unless you're sure.`, ''] : []),
    title,
    '',
    file.tool ? `• The ${file.tool} is in the spindle` : '• The right bit is in the spindle',
    '• X0 Y0 is set at the bottom-left of the design',
    '• Z0 is set on the top of the material',
    '• The material is held down firmly',
    b ? `\nIt cuts ${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} mm, down to Z${fmt(b.min[2])}.` : '',
    m.limits ? '' : '\nTravel limits aren\'t set, so nothing checks that it fits. "Trace outline" shows where it will go.',
  ];
  return confirm(checklist.join('\n'));
}

$('btn-start').addEventListener('click', async () => {
  if (!active || !confirmStart(`Run "${active.name}"?`)) return;
  await startChecked(active.name, active.lines, { kind: 'job', source: active.id });
});

$('btn-start-from').addEventListener('click', async () => {
  if (!active) return;
  const file = active;
  const job = controller.job;
  // After a stopped job, suggest a little before where it got to: the last few acknowledged
  // lines were only planned, and re-cutting a few millimetres does no harm.
  const reached = job && job.kind === 'job' && job.source === file.id && job.status !== 'finished' ? job.acked + (job.lineOffset ?? 0) : null;
  const suggested = reached !== null ? Math.max(1, reached - 20) : 1;
  const answer = prompt(
    `Start "${file.name}" from which line? (1–${file.lines.length})` + (reached !== null ? `\nThe last run got to about line ${reached}.` : ''),
    String(suggested),
  );
  if (answer === null) return;
  const line = Math.round(Number(answer));
  if (!(line >= 1 && line <= file.lines.length)) {
    alert(`Enter a line number from 1 to ${file.lines.length}.`);
    return;
  }
  let plan;
  try {
    plan = resumeFrom(file.lines, line - 1, num('safe-z'));
  } catch (e) {
    alert((e as Error).message);
    return;
  }
  if (!confirmStart(`Run "${file.name}" from line ${line}?\nThe bit lifts, moves to where that line starts and plunges there.`)) return;
  await startChecked(`${file.name} (from line ${line})`, plan.lines, { kind: 'job', source: file.id, lineOffset: line - 1 - plan.preamble });
});

$('btn-trace').addEventListener('click', async () => {
  const b = active?.info.cutBounds;
  if (!active || !b) return;
  const lift = Math.max(controller.machine.wpos[2], num('safe-z'));
  await startChecked(`Trace outline: ${active.name}`, traceOutline(b, lift), { kind: 'trace', source: active.id });
});

$('btn-pause').addEventListener('click', () => controller.pauseJob());
document.querySelectorAll<HTMLButtonElement>('[data-ov]').forEach((b) =>
  b.addEventListener('click', () => controller.realtime(OVERRIDES[b.dataset.ov as keyof typeof OVERRIDES])),
);
$('btn-resume').addEventListener('click', () => controller.resumeJob());
$('btn-stop').addEventListener('click', () => controller.stopJob());

const isFromActive = (job: JobView | null) => !!job && !!active && job.source === active.id;

function renderRun() {
  const job = controller.job;
  const running = controller.jobActive;
  const showingJob = job && (running || isFromActive(job));
  $('run-name').textContent = showingJob ? job!.name : active?.name ?? 'No file loaded';
  $('run-stats').textContent = active?.summary ?? '';
  const fraction = showingJob && job!.total ? job!.acked / job!.total : 0;
  $('run-progress').style.width = `${(fraction * 100).toFixed(1)}%`;
  const ready = !!active && controller.connected && !running;
  $<HTMLButtonElement>('btn-start').disabled = !ready;
  $<HTMLButtonElement>('btn-start-from').disabled = !ready;
  $<HTMLButtonElement>('btn-trace').disabled = !ready || !active?.info.cutBounds;
  const check = ready ? limitCheck(active!.lines) : null;
  const limitsNote = $('run-limits');
  limitsNote.hidden = !check;
  limitsNote.textContent = check?.text ?? '';
  limitsNote.className = `note ${check?.ok ? 'ok' : 'warn'}`;
  $<HTMLButtonElement>('btn-pause').disabled = job?.status !== 'running';
  $<HTMLButtonElement>('btn-resume').disabled = job?.status !== 'paused';
  $<HTMLButtonElement>('btn-stop').disabled = !running;
  // Overrides act on the running job (and on manual moves), so show them while connected.
  const [feedOv, , spindleOv] = controller.machine.overrides;
  $('overrides').hidden = !controller.connected;
  $('ov-feed').textContent = `${feedOv}%`;
  $('ov-spindle').textContent = `${spindleOv}%`;

  let time = '';
  if (showingJob) {
    const end = job!.finishedAt ?? Date.now();
    const pausedNow = job!.status === 'paused' && job!.pauseStartedAt ? Date.now() - job!.pauseStartedAt : 0;
    const elapsed = (end - job!.startedAt - job!.pausedMs - pausedNow) / 60000;
    time = `${job!.status} · ${minutes(elapsed)} elapsed`;
    if (running && fraction > 0.03) time += ` · ~${minutes((elapsed / fraction) * (1 - fraction))} left`;
  }
  $('run-time').textContent = time;
  const msg = $('run-message');
  msg.hidden = !(showingJob && job!.message);
  msg.textContent = job?.message ?? '';
  msg.className = `note ${job?.status === 'finished' ? '' : 'error'}`;
  preview.setProgress(job && job.kind === 'job' && isFromActive(job) ? job.acked + (job.lineOffset ?? 0) : -1);
}

function renderMachine() {
  const m = controller.machine;
  const connected = controller.connected;
  document.body.classList.toggle('connected', connected);
  $('btn-connect').hidden = connected;
  $('btn-simulator').hidden = connected;
  $('btn-disconnect').hidden = !connected;
  const badge = $('conn-badge');
  const where = remote ? 'Pi · ' : '';
  badge.textContent = remote && !remote.online ? 'Pi unreachable' : connected ? `${where}${m.transportName} · ${m.state}` : `${where}Disconnected`;
  badge.className = `badge ${m.state.startsWith('Alarm') || (remote && !remote.online) ? 'alarm' : connected ? 'on' : ''}`;
  $('machine-state').textContent = m.state;
  (['x', 'y', 'z'] as const).forEach((axis, i) => {
    $(`w${axis}`).textContent = fmt(m.wpos[i]);
    $(`m${axis}`).textContent = fmt(m.mpos[i]);
  });
  const zeroWarning = $('zero-warning');
  zeroWarning.hidden = !connected || !m.zeroUnverified;
  zeroWarning.textContent = `The controller restarted, so the ${axisList(m.zeroUnverified)} zero may no longer match the material. Set ${m.zeroUnverified.length > 1 ? 'them' : 'it'} again before cutting.`;
  // No jogging or zeroing while a job is streaming.
  const locked = controller.jobActive;
  document.querySelectorAll<HTMLButtonElement>('#machine-panel .needs-connection button:not(#btn-reset)').forEach((b) => (b.disabled = locked));
  $<HTMLInputElement>('console-input').disabled = locked;
  $('pi-section').classList.toggle('locked', locked);
  preview.setTool(connected ? m.wpos : null);
  const limits = connected ? m.limits : null;
  const status = $('limits-status');
  status.textContent = limits
    ? limits.source === 'homing' ? 'Set by homing. Jogs and jobs are kept inside.' : 'Set from the reference corner. Jogs and jobs are kept inside.'
    : m.homingEnabled ? 'Not set yet: press Home.' : 'Not set: nothing stops jogs or jobs at the ends of the axes.';
  status.className = `note ${limits ? 'set' : ''}`;
  $('btn-clear-limits').hidden = !limits;
  $('btn-home').hidden = !m.homingEnabled;
  $('btn-set-reference').hidden = m.homingEnabled;
  preview.setTravel(limits && {
    min: limits.min.map((v, i) => v - m.wco[i]) as Vec3,
    max: limits.max.map((v, i) => v - m.wco[i]) as Vec3,
  });
  if (remote) void followRemoteJob();
}

/** When a job was started from another device, open its file here too so the preview follows it. */
let following = false;
async function followRemoteJob() {
  const job = controller.job;
  if (!job?.source || !controller.jobActive || following || active?.id === job.source) return;
  following = true;
  try {
    const file = await library.load(job.source);
    if (file) setActive(file);
  } finally {
    following = false;
  }
}

// ───────────────────────── Raspberry Pi ─────────────────────────

if (remote) {
  const note = (id: string, text: string, kind = '') => {
    const el = $(id);
    el.hidden = !text;
    el.textContent = text;
    el.className = `note ${kind}`;
  };
  let commit: string | null = null;
  let updating = false;

  const refresh = async () => {
    try {
      const info = await remote.systemInfo();
      const v = info.version;
      $('pi-version').textContent = v
        ? `Version ${v.commit} (${new Date(v.date).toLocaleDateString()}, ${v.branch}): ${v.subject}`
        : 'Version unknown';
      if (commit && v && v.commit !== commit) location.reload();
      commit ??= v?.commit ?? null;
      $<HTMLButtonElement>('btn-pi-check').disabled = !!info.updateBlocker;
      $<HTMLButtonElement>('btn-pi-reboot').disabled = !!info.powerBlocker;
      $<HTMLButtonElement>('btn-pi-shutdown').disabled = !!info.powerBlocker;
      if (info.updateBlocker) note('pi-update-info', info.updateBlocker, 'warn');
      if (info.powerBlocker) note('pi-power-info', `Shut down / restart: ${info.powerBlocker}`, 'warn');
    } catch {
      $('pi-version').textContent = 'This Pi does not support updates and power controls yet.';
    }
  };
  $('pi-section').hidden = false;
  void refresh();
  remote.onReconnect = () => void refresh();

  $('btn-pi-check').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('btn-pi-check');
    button.disabled = true;
    note('pi-update-info', 'Checking…');
    try {
      const { behind, commits } = await remote.checkForUpdates();
      $('btn-pi-update').hidden = behind === 0;
      note('pi-update-info', behind === 0
        ? 'Up to date.'
        : `${behind} update${behind === 1 ? '' : 's'} available:\n${commits.map((c) => '• ' + c.replace(/^\w+ /, '')).join('\n')}`);
    } catch (e) {
      note('pi-update-info', `Could not check: ${(e as Error).message}`, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-pi-update').addEventListener('click', async () => {
    if (updating || !confirm('Install the update on the Pi?\n\nIt takes a few minutes (longer if new build tools are needed). The machine is disconnected and this page reloads when it is done.')) return;
    try {
      const requestedAt = await remote.update();
      updating = true;
      $('btn-pi-update').hidden = true;
      note('pi-update-info', 'Updating… this page reloads by itself when the Pi is back.');
      // The Pi restarts the server at the end; keep checking for the new version, or a failure.
      const poll = setInterval(async () => {
        try {
          const info = await remote.systemInfo();
          const last = info.lastUpdate;
          if (info.version && info.version.commit !== commit) {
            clearInterval(poll);
            location.reload();
          } else if (last && last.time >= requestedAt - 1000 && last.state !== 'running') {
            clearInterval(poll);
            updating = false;
            if (last.state === 'failed') {
              note('pi-update-info', `The update failed while ${last.step}. The previous version is still running. Details on the Pi: journalctl -u 3018-studio-update -n 50`, 'error');
            } else {
              note('pi-update-info', 'Already up to date.');
            }
          } else if (last?.state === 'running') {
            note('pi-update-info', `Updating (${last.step})… this page reloads by itself when the Pi is back.`);
          }
        } catch {
          /* still restarting */
        }
      }, 3000);
    } catch (e) {
      note('pi-update-info', (e as Error).message, 'error');
    }
  });

  const power = async (action: 'poweroff' | 'reboot') => {
    const question = action === 'poweroff'
      ? 'Shut down the Pi?\n\nThe spindle is switched off and the machine disconnected. Wait until the green light on the Pi stops flashing (about 30 seconds) before unplugging its power. To start it again, unplug and plug the power back in.'
      : 'Restart the Pi?\n\nThe machine is disconnected; the page reconnects in a minute or two.';
    if (!confirm(question)) return;
    try {
      await remote.power(action);
      note('pi-power-info', action === 'poweroff'
        ? 'Shutting down. Safe to unplug once the green light on the Pi stops flashing.'
        : 'Restarting… this page reconnects by itself.');
    } catch (e) {
      note('pi-power-info', (e as Error).message, 'error');
    }
  };
  $('btn-pi-shutdown').addEventListener('click', () => power('poweroff'));
  $('btn-pi-reboot').addEventListener('click', () => power('reboot'));
}

let scheduled = false;
let wasActive = false;
controller.onChange(() => {
  if (controller.jobActive !== wasActive) {
    wasActive = controller.jobActive;
    renderFiles();
  }
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    renderMachine();
    renderRun();
  });
});
setInterval(() => controller.jobActive && renderRun(), 1000);
renderFiles();
renderMachine();
renderRun();
