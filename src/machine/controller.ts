import type { Transport } from './transport';
import { parseStatus, type StatusReport, type Vec3 } from './status';
import { describeAlarm, describeError } from './errors';
import { cleanLine } from '../gcode/clean';
import { analyzeProgram } from '../gcode/analyze';
import { parseWords } from '../gcode/words';
import { checkMoves, clampJog, describeViolations, limitsFromHoming, limitsFromReference, type TravelLimits } from './travel';

export interface MachineState {
  connected: boolean;
  transportName: string;
  /** GRBL state: Idle, Run, Hold:0, Jog, Alarm, Door, Check, Home, Sleep. */
  state: string;
  mpos: Vec3;
  wpos: Vec3;
  wco: Vec3;
  feed: number;
  spindle: number;
  version: string;
  /** Where the axes can go, once a reference corner is set or the machine is homed. */
  limits: TravelLimits | null;
  /** GRBL's homing cycle is enabled ($22=1), i.e. limit switches are fitted. */
  homingEnabled: boolean;
}

export type JobStatus = 'running' | 'paused' | 'finished' | 'stopped' | 'error';

/** A job as seen from outside the controller (and over the network, where the lines are not sent). */
export interface JobView {
  name: string;
  /** A real job, or the trace-outline dry run. */
  kind: 'job' | 'trace';
  /** Number of lines in the job. */
  total: number;
  sent: number;
  acked: number;
  status: JobStatus;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  pausedMs: number;
  pauseStartedAt?: number;
}

export interface JobState extends JobView {
  lines: string[];
}

export type LogKind = 'tx' | 'rx' | 'info' | 'error';

interface Command {
  line: string;
  job: boolean;
  /** Don't echo GRBL's reply lines to the log (e.g. the automatic settings read). */
  quiet?: boolean;
  resolve?: (response: string) => void;
}

export interface StartOptions {
  kind?: 'job' | 'trace';
  /** Start even though the job goes past the travel limits. */
  ignoreLimits?: boolean;
}

/** Thrown by startJob when a job would run past the travel limits. */
export class LimitError extends Error {}

const disconnected = (): MachineState => ({
  connected: false,
  transportName: '',
  state: 'Disconnected',
  mpos: [0, 0, 0],
  wpos: [0, 0, 0],
  wco: [0, 0, 0],
  feed: 0,
  spindle: 0,
  version: '',
  limits: null,
  homingEnabled: false,
});

/**
 * Talks to GRBL 1.1. Lines are streamed with GRBL's "character counting" protocol: we keep
 * sending as long as the bytes not yet acknowledged with `ok`/`error` fit in its 128-byte
 * receive buffer, which keeps the planner full and motion smooth.
 */
export class GrblController {
  static readonly RX_BUFFER_SIZE = 127;
  static readonly STATUS_POLL_MS = 250;

  machine: MachineState = disconnected();
  job: JobState | null = null;

  private transport: Transport | null = null;
  private inFlight: (Command & { bytes: number })[] = [];
  private pending: Command[] = [];
  private rxBytes = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** GRBL `$` settings, read on connect. */
  settings: Record<number, number> = {};
  private settingsRequested = false;
  /** Where queued jogs will end up (machine coordinates), so rapid jog clicks are clamped too. */
  private jogTarget: Vec3 | null = null;
  /** Set when we reset GRBL while it stood still, which keeps its position. */
  private expectReset = false;
  private changeListeners = new Set<() => void>();
  private logListeners = new Set<(kind: LogKind, text: string) => void>();

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onLog(fn: (kind: LogKind, text: string) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  get connected(): boolean {
    return this.machine.connected;
  }

  get jobActive(): boolean {
    return this.job?.status === 'running' || this.job?.status === 'paused';
  }

  async connect(transport: Transport): Promise<void> {
    if (this.transport) await this.disconnect();
    await transport.open(
      (line) => this.handleLine(line),
      (error) => this.handleClosed(error),
    );
    this.transport = transport;
    this.clearQueues();
    this.settings = {};
    this.settingsRequested = false;
    this.jogTarget = null;
    this.machine = { ...disconnected(), connected: true, transportName: transport.name, state: 'Unknown' };
    this.pollTimer = setInterval(() => this.realtime('?'), GrblController.STATUS_POLL_MS);
    this.log('info', `Connected via ${transport.name}`);
    this.emit();
  }

  async disconnect(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    this.transport = null;
    await transport.close().catch(() => undefined);
    this.handleClosed();
  }

  /** Queues a command line; resolves with GRBL's response (`ok`, `error:N`, or `reset`). */
  send(raw: string, options: { quiet?: boolean } = {}): Promise<string> {
    let line = cleanLine(raw);
    if (!line) return Promise.resolve('ok');
    if (!this.transport) return Promise.reject(new Error('Not connected'));
    if (line.startsWith('$J=') && this.machine.limits) {
      const limited = this.limitJog(line);
      if (!limited) {
        this.log('error', 'Not jogging: that axis is at its travel limit.');
        return Promise.resolve('error:limit');
      }
      line = limited;
    }
    const changesSetting = /^\$\d+=/.test(line);
    return new Promise<string>((resolve) => {
      this.pending.push({ line, job: false, quiet: options.quiet, resolve });
      if (!options.quiet) this.log('tx', line);
      this.pump();
    }).then((response) => {
      if (changesSetting && response === 'ok') void this.readSettings();
      return response;
    });
  }

  /** Re-reads GRBL's `$$` settings (homing enabled, max travel …). */
  async readSettings(): Promise<void> {
    this.settingsRequested = true;
    await this.send('$$', { quiet: true });
    this.machine.homingEnabled = this.settings[22] === 1;
    this.emit();
  }

  /** Rewrites a jog as a relative move that stops at the travel limits, or null if it can't move at all. */
  private limitJog(line: string): string | null {
    const limits = this.machine.limits!;
    const words = parseWords(line.slice(3));
    if (!words) return line;
    let relative = false;
    let machineCoords = false;
    let scale = 1;
    let feed: number | undefined;
    const axes: (number | undefined)[] = [undefined, undefined, undefined];
    for (const [letter, value] of words) {
      if (letter === 'G' && value === 91) relative = true;
      else if (letter === 'G' && value === 53) machineCoords = true;
      else if (letter === 'G' && value === 20) scale = 25.4;
      else if (letter === 'F') feed = value;
      else if (letter === 'X' || letter === 'Y' || letter === 'Z') axes['XYZ'.indexOf(letter)] = value;
    }
    const from = this.jogTarget ?? this.machine.mpos;
    const delta = axes.map((v, i) => {
      if (v === undefined) return 0;
      const mm = v * scale;
      if (relative) return mm;
      return (machineCoords ? mm : mm + this.machine.wco[i]) - from[i];
    }) as Vec3;
    const clamped = clampJog(from, delta, limits);
    if (clamped.every((d) => Math.abs(d) < 1e-4)) return null;
    if (clamped.some((d, i) => Math.abs(d - delta[i]) > 1e-4)) this.log('info', 'Jog shortened to stay inside the travel limits.');
    this.jogTarget = from.map((v, i) => v + clamped[i]) as Vec3;
    const parts = clamped.map((d, i) => (Math.abs(d) < 1e-4 ? '' : `${'XYZ'[i]}${+d.toFixed(3)}`)).join('');
    return `$J=G91G21${parts}F${feed !== undefined ? feed * scale : 500}`;
  }

  /** Takes the current position as the X−/Y−/Z-top corner of the machine's travel. */
  setTravelReference(size: Vec3, margin: number): void {
    if (!this.connected) throw new Error('Not connected');
    if (this.machine.state !== 'Idle') throw new Error('The machine must be idle to set the reference.');
    this.machine.limits = limitsFromReference(this.machine.mpos, size, margin);
    this.log('info', 'Travel limits set from this corner. Jogs and jobs now stay inside them.');
    this.emit();
  }

  clearLimits(): void {
    this.machine.limits = null;
    this.emit();
  }

  /** Runs GRBL's homing cycle (needs limit switches and $22=1); the limits then come from $130–$132. */
  async home(margin: number): Promise<string> {
    const response = await this.send('$H');
    if (response !== 'ok') return response;
    await this.readSettings();
    const s = this.settings;
    this.machine.limits = limitsFromHoming([s[130] ?? 300, s[131] ?? 180, s[132] ?? 45], margin);
    this.log('info', 'Homed. Travel limits set from the machine settings ($130–$132).');
    this.emit();
    return response;
  }

  private forgetLimits(reason: string): void {
    if (!this.machine.limits) return;
    this.machine.limits = null;
    this.log('error', `Travel limits cleared: ${reason}. Set the reference again (or home) before relying on them.`);
  }

  /** Sends a real-time command, which GRBL acts on immediately, bypassing its buffer. */
  realtime(command: '?' | '!' | '~' | number): void {
    this.transport?.writeRealtime(typeof command === 'number' ? command : command.charCodeAt(0));
  }

  feedHold(): void {
    this.realtime('!');
  }

  cycleResume(): void {
    this.realtime('~');
  }

  jogCancel(): void {
    this.realtime(0x85);
  }

  softReset(): void {
    // GRBL keeps its position over a reset while standing still; mid-move it raises ALARM:3.
    this.expectReset = ['Idle', 'Hold:0', 'Check'].includes(this.machine.state);
    this.realtime(0x18);
    this.clearQueues();
    if (this.jobActive) this.finishJob('stopped', 'Controller was reset');
    this.emit();
  }

  startJob(name: string, lines: string[], options: StartOptions = {}): void {
    if (!this.transport) throw new Error('Not connected');
    if (this.jobActive) throw new Error('A job is already running');
    const limits = this.machine.limits;
    if (limits && !options.ignoreLimits) {
      const violations = checkMoves(analyzeProgram(lines).moves, this.machine.wco, limits);
      if (violations.length) throw new LimitError(`From the current zero this job goes ${describeViolations(violations)}.`);
    }
    this.job = { name, kind: options.kind ?? 'job', lines, total: lines.length, sent: 0, acked: 0, status: 'running', startedAt: Date.now(), pausedMs: 0 };
    this.log('info', `Job started: ${name} (${lines.length} lines)`);
    this.pump();
    this.emit();
  }

  pauseJob(message?: string): void {
    const job = this.job;
    if (!job || job.status !== 'running') return;
    job.status = 'paused';
    job.pauseStartedAt = Date.now();
    if (message) job.message = message;
    this.feedHold();
    this.emit();
  }

  resumeJob(): void {
    const job = this.job;
    if (!job || job.status !== 'paused') return;
    job.status = 'running';
    job.message = undefined;
    job.pausedMs += Date.now() - (job.pauseStartedAt ?? Date.now());
    this.cycleResume();
    this.pump();
    this.emit();
  }

  /** Stops a job without losing position: feed hold, wait for the machine to stop, then reset. */
  async stopJob(): Promise<void> {
    const job = this.job;
    if (!job || !this.jobActive) return;
    job.status = 'paused';
    this.feedHold();
    await this.waitFor(() => this.machine.state === 'Hold:0' || this.machine.state === 'Idle', 3000);
    this.finishJob('stopped', 'Stopped by user');
    this.softReset();
  }

  private finishJob(status: JobStatus, message?: string): void {
    const job = this.job;
    if (!job) return;
    if (job.pauseStartedAt && job.status === 'paused') job.pausedMs += Date.now() - job.pauseStartedAt;
    job.status = status;
    job.finishedAt = Date.now();
    if (message) job.message = message;
    this.log(status === 'finished' ? 'info' : 'error', `Job ${status}: ${job.name}${message ? ` — ${message}` : ''}`);
  }

  private waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (condition()) resolve(true);
        else if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(check, 50);
      };
      check();
    });
  }

  private pump(): void {
    const transport = this.transport;
    if (!transport) return;
    for (;;) {
      let command: Command;
      const job = this.job;
      if (this.pending.length) command = this.pending[0];
      else if (job && job.status === 'running' && job.sent < job.lines.length) command = { line: job.lines[job.sent], job: true };
      else return;
      const bytes = command.line.length + 1;
      if (this.inFlight.length > 0 && this.rxBytes + bytes > GrblController.RX_BUFFER_SIZE) return;
      if (command.job) job!.sent++;
      else this.pending.shift();
      this.inFlight.push({ ...command, bytes });
      this.rxBytes += bytes;
      transport.writeLine(command.line);
    }
  }

  private handleLine(line: string): void {
    if (line === 'ok' || line.startsWith('error:')) {
      this.handleResponse(line);
    } else if (line.startsWith('<')) {
      const status = parseStatus(line);
      if (status) this.applyStatus(status);
    } else if (line.startsWith('ALARM:')) {
      const code = Number(line.slice(6));
      this.machine.state = 'Alarm';
      this.log('error', `${line} ${describeAlarm(code)}`);
      this.forgetLimits('the controller raised an alarm, so its position may be off');
      if (this.jobActive) this.finishJob('error', `${line} ${describeAlarm(code)}`);
    } else if (/^Grbl\s/i.test(line)) {
      this.machine.version = line;
      this.clearQueues();
      if (this.jobActive) this.finishJob('stopped', 'Controller was reset');
      if (!this.expectReset) this.forgetLimits('the controller restarted');
      this.expectReset = false;
      this.jogTarget = null;
      this.log('info', line);
      void this.readSettings();
    } else {
      const setting = /^\$(\d+)=(-?[\d.]+)/.exec(line);
      if (setting) this.settings[Number(setting[1])] = Number(setting[2]);
      if (!this.inFlight[0]?.quiet) this.log('rx', line);
    }
    this.emit();
  }

  private handleResponse(line: string): void {
    const command = this.inFlight.shift();
    if (command) this.rxBytes -= command.bytes;
    if (line.startsWith('error:')) {
      const code = Number(line.slice(6));
      const message = `${line} ${describeError(code)}${command ? ` (line: ${command.line})` : ''}`;
      this.log('error', message);
      if (command?.job) this.pauseJob(`${message} Resume to continue anyway, or Stop.`);
    } else if (command && !command.job && !command.quiet) {
      this.log('rx', 'ok');
    }
    const job = this.job;
    if (command?.job && job) {
      job.acked++;
      // GRBL acknowledges a line when it is planned, not when it has been cut; the job is
      // done once everything is acknowledged and the machine reports Idle (see applyStatus).
      if (job.acked === job.total && job.status === 'running') this.log('info', 'All lines sent; finishing the last moves…');
    }
    command?.resolve?.(line);
    this.pump();
  }

  private applyStatus(status: StatusReport): void {
    const m = this.machine;
    m.state = status.subState !== undefined ? `${status.state}:${status.subState}` : status.state;
    if (status.wco) m.wco = status.wco;
    if (status.mpos) {
      m.mpos = status.mpos;
      m.wpos = [m.mpos[0] - m.wco[0], m.mpos[1] - m.wco[1], m.mpos[2] - m.wco[2]];
    } else if (status.wpos) {
      m.wpos = status.wpos;
      m.mpos = [m.wpos[0] + m.wco[0], m.wpos[1] + m.wco[1], m.wpos[2] + m.wco[2]];
    }
    if (status.feed !== undefined) m.feed = status.feed;
    if (status.spindle !== undefined) m.spindle = status.spindle;
    if (status.state === 'Idle') this.jogTarget = null;
    // Some boards don't restart (and greet) when the port opens; read the settings anyway.
    if (!this.settingsRequested) void this.readSettings();
    const job = this.job;
    if (job?.status === 'running' && job.acked === job.total && status.state === 'Idle') this.finishJob('finished');
  }

  private handleClosed(error?: unknown): void {
    if (!this.machine.connected) return;
    this.transport = null;
    clearInterval(this.pollTimer);
    if (this.jobActive) this.finishJob('error', 'Connection lost');
    this.clearQueues();
    this.machine = disconnected();
    this.log(error ? 'error' : 'info', error ? `Disconnected: ${String(error)}` : 'Disconnected');
    this.emit();
  }

  private clearQueues(): void {
    for (const c of [...this.inFlight, ...this.pending]) c.resolve?.('reset');
    this.inFlight = [];
    this.pending = [];
    this.rxBytes = 0;
  }

  private log(kind: LogKind, text: string): void {
    for (const fn of this.logListeners) fn(kind, text);
  }

  private emit(): void {
    for (const fn of this.changeListeners) fn();
  }
}
