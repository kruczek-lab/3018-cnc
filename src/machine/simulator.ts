import type { Transport } from './transport';
import type { Vec3 } from './status';
import { parseWords } from '../gcode/words';

interface SimMove {
  from: Vec3;
  to: Vec3;
  durationMs: number;
  elapsedMs: number;
  jog: boolean;
}

const SETTINGS = [
  '$0=10', '$1=25', '$2=0', '$3=0', '$4=0', '$5=0', '$6=0', '$10=1', '$11=0.010', '$12=0.002',
  '$13=0', '$20=0', '$21=0', '$22=0', '$23=0', '$24=25.000', '$25=500.000', '$26=250', '$27=1.000',
  '$30=1000', '$31=0', '$32=0', '$100=800.000', '$101=800.000', '$102=800.000', '$110=1000.000',
  '$111=1000.000', '$112=600.000', '$120=30.000', '$121=30.000', '$122=30.000', '$130=300.000',
  '$131=180.000', '$132=45.000',
];

const fmt = (v: number) => v.toFixed(3);

/**
 * A rough GRBL 1.1 stand-in so the app can be tried without the machine. It understands the
 * subset of G-code this app produces (G0/G1, G90/G91, G10 L20, G4, M3/M5, $J=, $X …), acknowledges
 * lines as its 15-move planner frees up and "moves" the tool `speedup` times faster than real life.
 */
export class SimulatedGrbl implements Transport {
  readonly name = 'Simulator';
  speedup = 10;
  static readonly PLANNER_SIZE = 15;
  static readonly MAX_RATE = 1000;

  private onLine: (line: string) => void = () => undefined;
  private onClose: () => void = () => undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private mpos: Vec3 = [0, 0, 0];
  private planned: Vec3 = [0, 0, 0];
  private wco: Vec3 = [0, 0, 0];
  private absolute = true;
  private motion = 0;
  private feed = 0;
  private spindleSpeed = 0;
  private spindleOn = false;
  private hold = false;
  private moves: SimMove[] = [];
  private rx: string[] = [];

  async open(onLine: (line: string) => void, onClose: () => void): Promise<void> {
    this.onLine = onLine;
    this.onClose = onClose;
    this.timer = setInterval(() => this.tick(20), 20);
    this.say("Grbl 1.1f ['$' for help]");
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.onClose();
  }

  writeLine(line: string): void {
    this.rx.push(line.trim());
    this.drain();
  }

  writeRealtime(byte: number): void {
    switch (byte) {
      case 0x3f: // ?
        this.say(this.statusLine());
        break;
      case 0x21: // !
        if (this.moves.length) this.hold = true;
        break;
      case 0x7e: // ~
        this.hold = false;
        break;
      case 0x18: // Ctrl-X soft reset
        this.moves = [];
        this.rx = [];
        this.hold = false;
        this.planned = [...this.mpos];
        this.absolute = true;
        this.motion = 0;
        this.spindleOn = false;
        this.say("Grbl 1.1f ['$' for help]");
        break;
      case 0x85: // jog cancel
        this.moves = this.moves.filter((m) => !m.jog);
        this.planned = this.moves.length ? [...this.moves[this.moves.length - 1].to] : [...this.mpos];
        break;
    }
  }

  private say(line: string): void {
    setTimeout(() => this.onLine(line), 0);
  }

  private state(): string {
    if (this.hold && this.moves.length) return 'Hold:0';
    if (this.moves.length) return this.moves[0].jog ? 'Jog' : 'Run';
    return 'Idle';
  }

  private statusLine(): string {
    const s = this.spindleOn ? this.spindleSpeed : 0;
    return `<${this.state()}|MPos:${this.mpos.map(fmt).join(',')}|FS:${Math.round(this.feed)},${s}|WCO:${this.wco.map(fmt).join(',')}>`;
  }

  private tick(dtMs: number): void {
    if (this.hold && !this.moves.length) this.hold = false;
    let budget = this.hold ? 0 : dtMs * this.speedup;
    while (budget > 0 && this.moves.length) {
      const m = this.moves[0];
      const used = Math.min(m.durationMs - m.elapsedMs, budget);
      m.elapsedMs += used;
      budget -= used;
      const t = m.durationMs > 0 ? m.elapsedMs / m.durationMs : 1;
      this.mpos = [0, 1, 2].map((i) => m.from[i] + (m.to[i] - m.from[i]) * t) as Vec3;
      if (m.elapsedMs >= m.durationMs) this.moves.shift();
    }
    this.drain();
  }

  private drain(): void {
    while (this.rx.length && this.moves.length < SimulatedGrbl.PLANNER_SIZE) {
      for (const response of this.execute(this.rx.shift()!)) this.say(response);
    }
  }

  private queueMove(to: Vec3, rate: number, jog: boolean): void {
    const from = this.planned;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    this.moves.push({ from, to, durationMs: (length / rate) * 60000, elapsedMs: 0, jog });
    this.planned = to;
  }

  private execute(raw: string): string[] {
    const line = raw.toUpperCase().replace(/\s+/g, '');
    if (!line) return ['ok'];
    if (line.startsWith('$')) {
      if (line === '$X') return ['[MSG:Caution: Unlocked]', 'ok'];
      if (line === '$$') return [...SETTINGS, 'ok'];
      if (line === '$I') return ['[VER:1.1f.20170801:]', '[OPT:V,15,128]', 'ok'];
      if (line === '$G') {
        return [`[GC:G${this.motion} G54 G17 G21 G${this.absolute ? 90 : 91} G94 M${this.spindleOn ? 3 : 5} M9 T0 F${this.feed} S${this.spindleSpeed}]`, 'ok'];
      }
      if (line === '$H') return ['error:5'];
      if (line.startsWith('$J=')) return [this.jog(line.slice(3))];
      return ['ok'];
    }
    const words = parseWords(line);
    if (!words) return ['error:1'];
    const axes: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
    let g10 = false;
    let dwell = false;
    let p = 0;
    let l = 0;
    for (const [letter, value] of words) {
      switch (letter) {
        case 'G':
          if ([0, 1, 2, 3].includes(value)) this.motion = value;
          else if (value === 90) this.absolute = true;
          else if (value === 91) this.absolute = false;
          else if (value === 10) g10 = true;
          else if (value === 4) dwell = true;
          break;
        case 'M':
          if (value === 3 || value === 4) this.spindleOn = true;
          else if (value === 5 || value === 2 || value === 30) this.spindleOn = false;
          break;
        case 'F': this.feed = value; break;
        case 'S': this.spindleSpeed = value; break;
        case 'P': p = value; break;
        case 'L': l = value; break;
        case 'X': case 'Y': case 'Z': axes[letter] = value; break;
      }
    }
    const keys = ['X', 'Y', 'Z'] as const;
    if (g10) {
      if (l !== 20) return ['error:28'];
      keys.forEach((k, i) => {
        if (axes[k] !== undefined) this.wco[i] = this.planned[i] - axes[k]!;
      });
      return ['ok'];
    }
    if (dwell) {
      this.moves.push({ from: this.planned, to: this.planned, durationMs: p * 1000, elapsedMs: 0, jog: false });
      return ['ok'];
    }
    if (Object.keys(axes).length) {
      if (this.motion !== 0 && this.feed <= 0) return ['error:22'];
      const to = keys.map((k, i) => {
        const v = axes[k];
        if (v === undefined) return this.planned[i];
        return this.absolute ? v + this.wco[i] : this.planned[i] + v;
      }) as Vec3;
      this.queueMove(to, this.motion === 0 ? SimulatedGrbl.MAX_RATE : Math.min(this.feed, SimulatedGrbl.MAX_RATE), false);
    }
    return ['ok'];
  }

  private jog(body: string): string {
    const words = parseWords(body);
    if (!words) return 'error:16';
    let relative = false;
    let feed = 0;
    const axes: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
    for (const [letter, value] of words) {
      if (letter === 'G' && value === 91) relative = true;
      else if (letter === 'F') feed = value;
      else if (letter === 'X' || letter === 'Y' || letter === 'Z') axes[letter] = value;
    }
    if (feed <= 0) return 'error:22';
    const to = (['X', 'Y', 'Z'] as const).map((k, i) => {
      const v = axes[k];
      if (v === undefined) return this.planned[i];
      return relative ? this.planned[i] + v : v + this.wco[i];
    }) as Vec3;
    this.queueMove(to, Math.min(feed, SimulatedGrbl.MAX_RATE), true);
    return 'ok';
  }
}
