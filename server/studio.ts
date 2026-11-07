import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { GrblController, type JobView, type LogKind } from '../src/machine/controller';
import { SimulatedGrbl } from '../src/machine/simulator';
import type { Transport } from '../src/machine/transport';
import { prepareProgram } from '../src/gcode/clean';
import { LinuxSerialTransport, listSerialPorts } from './linuxSerial';
import type { SystemActions } from './system';

export interface StudioOptions {
  /** Folder with the built web app (dist/). */
  staticDir: string | null;
  /** Serial port to use; when empty the first detected port is used. */
  serialPort?: string;
  /** When set, browsers must log in with this password. */
  password?: string;
  /** For tests: how to open a serial port. */
  openPort?: (path: string) => Transport;
  /** Shutdown, restart and self-update. Without it those requests are refused. */
  system?: SystemActions;
}

export interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
  time: number;
}

export interface StateMessage {
  machine: GrblController['machine'];
  job: JobView | null;
  port: string | null;
  serverNow: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const MAX_BODY = 64 * 1024 * 1024;
const LOG_BACKLOG = 300;
const STATE_INTERVAL_MS = 150;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest();

/**
 * Runs the GRBL controller next to the machine (on the Raspberry Pi) and exposes it to any
 * browser on the network: a small JSON API for commands plus a Server-Sent Events stream with
 * live state and the console log. Jobs are streamed from here, so they keep going when the
 * laptop that started them goes to sleep.
 */
export class StudioServer {
  readonly controller = new GrblController();
  readonly server: Server;
  private port: string | null = null;
  private program: { name: string; text: string } | null = null;
  private log: LogEntry[] = [];
  private nextLogId = 1;
  private clients = new Set<ServerResponse>();
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Set<string>();

  constructor(private options: StudioOptions) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        if (!res.headersSent) this.json(res, status, { error: (error as Error).message });
        else res.end();
      });
    });
    this.controller.onChange(() => this.scheduleState());
    this.controller.onLog((kind, text) => this.addLog(kind, text));
    setInterval(() => {
      for (const client of this.clients) client.write(': keep-alive\n\n');
    }, 15000).unref();
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const address = this.server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    await this.controller.disconnect();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    await new Promise((resolve) => this.server.close(resolve));
  }

  state(): StateMessage {
    const job = this.controller.job;
    // Everything but the (possibly huge) list of lines.
    const view: JobView | null = job && {
      name: job.name, total: job.total, sent: job.sent, acked: job.acked, status: job.status, message: job.message,
      startedAt: job.startedAt, finishedAt: job.finishedAt, pausedMs: job.pausedMs, pauseStartedAt: job.pauseStartedAt,
    };
    return { machine: this.controller.machine, job: view, port: this.port, serverNow: Date.now() };
  }

  async connect(simulator: boolean, requestedPort?: string): Promise<void> {
    if (this.controller.jobActive) throw new HttpError(409, 'A job is running');
    if (simulator) {
      await this.controller.connect(new SimulatedGrbl());
      this.port = 'simulator';
      return;
    }
    const path = requestedPort || this.options.serialPort || listSerialPorts()[0];
    if (!path) throw new HttpError(404, 'No USB serial port found. Is the machine plugged into the Pi and switched on?');
    const transport = this.options.openPort ? this.options.openPort(path) : new LinuxSerialTransport(path);
    try {
      await this.controller.connect(transport);
    } catch (error) {
      const message = (error as Error).message;
      throw new HttpError(500, /EACCES/.test(message)
        ? `No permission to open ${path}. Add the user to the "dialout" group and restart.`
        : message);
    }
    this.port = path;
  }

  private requireSystem(): SystemActions {
    if (!this.options.system) throw new HttpError(501, 'Not available on this server');
    return this.options.system;
  }

  private addLog(kind: LogKind, text: string): void {
    const entry: LogEntry = { id: this.nextLogId++, kind, text, time: Date.now() };
    this.log.push(entry);
    if (this.log.length > LOG_BACKLOG) this.log.shift();
    this.broadcast('log', entry);
  }

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.broadcast('state', this.state());
    }, STATE_INTERVAL_MS);
  }

  private broadcast(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(message);
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.options.password) return true;
    const cookie = req.headers.cookie ?? '';
    const token = /(?:^|;\s*)studio=([a-f0-9]+)/.exec(cookie)?.[1];
    return !!token && this.sessions.has(token);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Upload too large');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return this.serveStatic(path, res);

    if (req.method === 'POST') {
      // A custom header forces browsers to ask permission (CORS preflight) before another
      // website could send commands here; this server never grants it.
      if (req.headers['x-studio'] !== '1') throw new HttpError(403, 'Missing X-Studio header');
    }

    if (path === '/api/login' && req.method === 'POST') {
      const { password } = await this.body(req);
      if (!this.options.password) return this.json(res, 200, { ok: true });
      if (typeof password !== 'string' || !timingSafeEqual(hash(password), hash(this.options.password))) {
        throw new HttpError(401, 'Wrong password');
      }
      const token = randomBytes(24).toString('hex');
      this.sessions.add(token);
      res.setHeader('Set-Cookie', `studio=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}`);
      return this.json(res, 200, { ok: true });
    }

    if (!this.authorized(req)) throw new HttpError(401, 'Login required');

    if (req.method === 'GET') {
      switch (path) {
        case '/api/system':
          return this.json(res, 200, await this.requireSystem().info());
        case '/api/info':
          return this.json(res, 200, { app: '3018-studio', ports: listSerialPorts(), passwordRequired: !!this.options.password });
        case '/api/state':
          return this.json(res, 200, this.state());
        case '/api/ports':
          return this.json(res, 200, { ports: listSerialPorts() });
        case '/api/job/program':
          if (!this.program) throw new HttpError(404, 'No job has been sent');
          return this.json(res, 200, this.program);
        case '/api/events':
          return this.events(req, res);
      }
      throw new HttpError(404, 'Not found');
    }

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = await this.body(req);
    const c = this.controller;
    switch (path) {
      case '/api/connect':
        await this.connect(body.simulator === true, typeof body.port === 'string' ? body.port : undefined);
        return this.json(res, 200, this.state());
      case '/api/disconnect':
        if (c.jobActive) throw new HttpError(409, 'Stop the job before disconnecting');
        await c.disconnect();
        this.port = null;
        return this.json(res, 200, this.state());
      case '/api/command': {
        if (typeof body.line !== 'string') throw new HttpError(400, 'Missing line');
        if (!c.connected) throw new HttpError(409, 'Machine not connected');
        return this.json(res, 200, { response: await c.send(body.line) });
      }
      case '/api/realtime': {
        const commands: Record<string, '?' | '!' | '~' | number> = { status: '?', hold: '!', resume: '~', jogCancel: 0x85 };
        const command = commands[String(body.command)];
        if (command === undefined) throw new HttpError(400, 'Unknown real-time command');
        c.realtime(command);
        return this.json(res, 200, { ok: true });
      }
      case '/api/reset':
        c.softReset();
        return this.json(res, 200, { ok: true });
      case '/api/job/start': {
        if (typeof body.name !== 'string' || typeof body.gcode !== 'string') throw new HttpError(400, 'Missing name or gcode');
        if (!c.connected) throw new HttpError(409, 'Machine not connected');
        if (c.jobActive) throw new HttpError(409, 'A job is already running');
        this.program = { name: body.name, text: body.gcode };
        c.startJob(body.name, prepareProgram(body.gcode));
        return this.json(res, 200, this.state());
      }
      case '/api/job/pause':
        c.pauseJob();
        return this.json(res, 200, this.state());
      case '/api/job/resume':
        c.resumeJob();
        return this.json(res, 200, this.state());
      case '/api/job/stop':
        await c.stopJob();
        return this.json(res, 200, this.state());
      case '/api/system/check-updates':
        return this.json(res, 200, await this.requireSystem().checkForUpdates());
      case '/api/system/update': {
        const system = this.requireSystem();
        if (c.jobActive) throw new HttpError(409, 'Wait for the job to finish before updating');
        const { updateBlocker } = await system.info();
        if (updateBlocker) throw new HttpError(409, updateBlocker);
        await system.startUpdate();
        this.addLog('info', 'Updating 3018 Studio on the Pi. This takes a few minutes; the page reloads when it is done.');
        return this.json(res, 202, { ok: true });
      }
      case '/api/system/power': {
        const action = body.action;
        if (action !== 'poweroff' && action !== 'reboot') throw new HttpError(400, 'Unknown power action');
        const system = this.requireSystem();
        if (c.jobActive) throw new HttpError(409, 'Stop the job before shutting down the Pi');
        const { powerBlocker } = await system.info();
        if (powerBlocker) throw new HttpError(409, powerBlocker);
        if (c.connected) {
          // Make sure the spindle is off before the Pi goes away.
          await Promise.race([c.send('M5'), new Promise((r) => setTimeout(r, 1000))]);
          await c.disconnect();
          this.port = null;
        }
        this.addLog('info', action === 'poweroff'
          ? 'The Pi is shutting down. It is safe to unplug once its green light has stopped flashing (about 30 seconds).'
          : 'The Pi is restarting. This page reconnects in a minute or two.');
        this.json(res, 202, { ok: true });
        // Give the response and the log message a moment to reach the browsers first.
        setTimeout(() => system.power(action).catch((error) => this.addLog('error', `Could not ${action}: ${(error as Error).message}`)), 500);
        return;
      }
    }
    throw new HttpError(404, 'Not found');
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
    for (const entry of this.log) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<void> {
    const root = this.options.staticDir;
    if (!root) throw new HttpError(404, 'Not found');
    let file = normalize(join(root, decodeURIComponent(path)));
    if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new HttpError(403, 'Forbidden');
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      throw new HttpError(404, 'Not found');
    }
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(data);
  }
}
