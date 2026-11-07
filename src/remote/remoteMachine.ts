import type { JobView, LogKind, MachineState } from '../machine/controller';
import type { MachineClient } from '../machine/client';

interface StateMessage {
  machine: MachineState;
  job: JobView | null;
  port: string | null;
  serverNow: number;
}

interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
}

export interface RemoteInfo {
  ports: string[];
}

export interface SystemInfo {
  version: { commit: string; date: string; subject: string; branch: string } | null;
  updateBlocker: string | null;
  powerBlocker: string | null;
}

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} ${res.statusText}`), { status: res.status });
  return data as T;
}

/**
 * Finds out whether this page was served by the 3018 Studio server on a Raspberry Pi.
 * Asks for the password if the server has one. Returns null when running standalone.
 */
export async function detectRemote(): Promise<RemoteInfo | null> {
  if (location.protocol === 'file:') return null;
  for (;;) {
    try {
      return await api<RemoteInfo>('api/info');
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 401) return null;
      const password = prompt('This 3018 Studio needs a password:');
      if (password === null) return null;
      await api('api/login', { password }).catch(() => alert('Wrong password.'));
    }
  }
}

/** The machine attached to the Pi, driven over HTTP with live updates from a Server-Sent Events stream. */
export class RemoteMachine implements MachineClient {
  machine: MachineState = {
    connected: false, transportName: '', state: 'Disconnected', mpos: [0, 0, 0], wpos: [0, 0, 0],
    wco: [0, 0, 0], feed: 0, spindle: 0, version: '',
  };
  job: JobView | null = null;
  port: string | null = null;
  /** Whether this browser can currently reach the Pi. */
  online = false;
  /** Called when the Pi comes back after being unreachable (e.g. after an update or restart). */
  onReconnect: (() => void) | null = null;
  private clockOffset = 0;
  private lastLogId = 0;
  private changeListeners = new Set<() => void>();
  private logListeners = new Set<(kind: LogKind, text: string) => void>();

  constructor() {
    const events = new EventSource('api/events');
    events.addEventListener('state', (e) => this.applyState(JSON.parse((e as MessageEvent).data)));
    events.addEventListener('log', (e) => {
      const entry: LogEntry = JSON.parse((e as MessageEvent).data);
      if (entry.id <= this.lastLogId) return;
      this.lastLogId = entry.id;
      this.log(entry.kind, entry.text);
    });
    let everOpen = false;
    events.addEventListener('open', () => {
      if (!this.online) this.log('info', 'Connected to the Pi');
      if (everOpen && !this.online) this.onReconnect?.();
      everOpen = true;
      this.online = true;
      this.emit();
    });
    events.addEventListener('error', () => {
      if (this.online) this.log('error', 'Lost contact with the Pi — retrying… (a running job carries on)');
      this.online = false;
      this.emit();
    });
  }

  get connected(): boolean {
    return this.online && this.machine.connected;
  }

  get jobActive(): boolean {
    return this.job?.status === 'running' || this.job?.status === 'paused';
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onLog(fn: (kind: LogKind, text: string) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  connect(simulator: boolean): Promise<void> {
    return this.call('api/connect', { simulator });
  }

  disconnect(): Promise<void> {
    return this.call('api/disconnect', {});
  }

  async send(line: string): Promise<string> {
    const { response } = await api<{ response: string }>('api/command', { line });
    return response;
  }

  realtime(command: '?' | '!' | '~' | number): void {
    const name = { '?': 'status', '!': 'hold', '~': 'resume' }[command as string] ?? (command === 0x85 ? 'jogCancel' : null);
    if (name) void this.call('api/realtime', { command: name });
  }

  softReset(): void {
    void this.call('api/reset', {});
  }

  startJob(name: string, lines: string[]): Promise<void> {
    return this.call('api/job/start', { name, gcode: lines.join('\n') });
  }

  pauseJob(): void {
    void this.call('api/job/pause', {});
  }

  resumeJob(): void {
    void this.call('api/job/resume', {});
  }

  stopJob(): Promise<void> {
    return this.call('api/job/stop', {});
  }

  systemInfo(): Promise<SystemInfo> {
    return api('api/system');
  }

  checkForUpdates(): Promise<{ behind: number; commits: string[] }> {
    return api('api/system/check-updates', {});
  }

  /** Starts the update on the Pi; the page should reload once the Pi is back. */
  update(): Promise<unknown> {
    return api('api/system/update', {});
  }

  power(action: 'poweroff' | 'reboot'): Promise<unknown> {
    return api('api/system/power', { action });
  }

  /** The G-code of the current/last job, for previewing a job started from another device. */
  program(): Promise<{ name: string; text: string }> {
    return api('api/job/program');
  }

  private async call(path: string, body: unknown): Promise<void> {
    try {
      const result = await api<StateMessage | { ok: boolean }>(path, body);
      if ('machine' in result) this.applyState(result);
    } catch (error) {
      this.log('error', (error as Error).message);
    }
  }

  private applyState(state: StateMessage): void {
    // Job times come from the Pi's clock; shift them onto this browser's clock.
    this.clockOffset = Date.now() - state.serverNow;
    const shift = (t?: number) => (t === undefined ? undefined : t + this.clockOffset);
    this.machine = state.machine;
    this.port = state.port;
    this.job = state.job && {
      ...state.job,
      startedAt: state.job.startedAt + this.clockOffset,
      finishedAt: shift(state.job.finishedAt),
      pauseStartedAt: shift(state.job.pauseStartedAt),
    };
    this.emit();
  }

  private log(kind: LogKind, text: string): void {
    for (const fn of this.logListeners) fn(kind, text);
  }

  private emit(): void {
    for (const fn of this.changeListeners) fn();
  }
}
