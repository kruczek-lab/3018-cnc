import type { Transport } from './transport';
import { parseStatus, type StatusReport, type Vec3 } from './status';
import { describeAlarm, describeError } from './errors';
import { cleanLine } from '../gcode/clean';

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
}

export type JobStatus = 'running' | 'paused' | 'finished' | 'stopped' | 'error';

export interface JobState {
  name: string;
  lines: string[];
  sent: number;
  acked: number;
  status: JobStatus;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  pausedMs: number;
  pauseStartedAt?: number;
}

export type LogKind = 'tx' | 'rx' | 'info' | 'error';

interface Command {
  line: string;
  job: boolean;
  resolve?: (response: string) => void;
}

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
  send(raw: string): Promise<string> {
    const line = cleanLine(raw);
    if (!line) return Promise.resolve('ok');
    if (!this.transport) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => {
      this.pending.push({ line, job: false, resolve });
      this.log('tx', line);
      this.pump();
    });
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
    this.realtime(0x18);
    this.clearQueues();
    if (this.jobActive) this.finishJob('stopped', 'Controller was reset');
    this.emit();
  }

  startJob(name: string, lines: string[]): void {
    if (!this.transport) throw new Error('Not connected');
    if (this.jobActive) throw new Error('A job is already running');
    this.job = { name, lines, sent: 0, acked: 0, status: 'running', startedAt: Date.now(), pausedMs: 0 };
    this.log('info', `Job started: ${name} (${lines.length} lines)`);
    if (lines.length === 0) this.finishJob('finished');
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
      if (this.jobActive) this.finishJob('error', `${line} ${describeAlarm(code)}`);
    } else if (/^Grbl\s/i.test(line)) {
      this.machine.version = line;
      this.clearQueues();
      if (this.jobActive) this.finishJob('stopped', 'Controller was reset');
      this.log('info', line);
    } else {
      this.log('rx', line);
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
    } else if (command && !command.job) {
      this.log('rx', 'ok');
    }
    const job = this.job;
    if (command?.job && job) {
      job.acked++;
      if (job.acked === job.lines.length && this.jobActive) this.finishJob('finished');
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
