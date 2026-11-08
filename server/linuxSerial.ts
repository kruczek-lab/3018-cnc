import { execFile } from 'node:child_process';
import { closeSync, constants, existsSync, openSync, read, readdirSync, realpathSync, writeSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Transport } from '../src/machine/transport';

const run = promisify(execFile);

/**
 * Lists likely GRBL serial ports. The 3018's CH340 USB chip shows up as /dev/ttyUSB0;
 * stable /dev/serial/by-id names are preferred when present.
 */
export function listSerialPorts(): string[] {
  const ports: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    ports.push(path);
  };
  try {
    for (const name of readdirSync('/dev/serial/by-id').sort()) add(`/dev/serial/by-id/${name}`);
  } catch {
    /* no by-id directory */
  }
  try {
    for (const name of readdirSync('/dev').sort()) if (/^tty(USB|ACM)\d+$/.test(name)) add(`/dev/${name}`);
  } catch {
    /* not Linux */
  }
  return ports;
}

/**
 * Serial port access with no native modules: the port is configured with `stty` and read
 * and written as a file. Reads time out every 100 ms (VMIN=0, VTIME=1) so the read loop
 * can notice when it should stop. An unplugged USB adapter also just reads 0 bytes, so the
 * loop checks the device is still there, and a failed write ends the connection too.
 */
export class LinuxSerialTransport implements Transport {
  readonly name: string;
  private fd: number | null = null;
  private closing = false;
  private failure: Error | null = null;
  private loop: Promise<void> | null = null;

  /** `configure: false` skips stty, for tests that use a plain file as the "port". */
  constructor(readonly path: string, private baudRate = 115200, private configure = true) {
    this.name = `USB ${path}`;
  }

  async open(onLine: (line: string) => void, onClose: (error?: unknown) => void): Promise<void> {
    const fd = openSync(this.path, constants.O_RDWR | constants.O_NOCTTY);
    try {
      if (this.configure) await run('stty', ['-F', this.path, String(this.baudRate), 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', 'min', '0', 'time', '1']);
    } catch (error) {
      closeSync(fd);
      throw new Error(`Could not configure ${this.path}: ${(error as Error).message}`);
    }
    this.fd = fd;
    this.loop = this.readLoop(fd, onLine).then(
      () => onClose(),
      (error) => onClose(this.closing ? undefined : error),
    );
  }

  private async readLoop(fd: number, onLine: (line: string) => void): Promise<void> {
    const buffer = Buffer.alloc(1024);
    const decoder = new TextDecoder();
    let pending = '';
    let quietReads = 0;
    while (!this.closing) {
      if (this.failure) throw this.failure;
      const bytes = await new Promise<number>((resolve, reject) =>
        read(fd, buffer, 0, buffer.length, null, (error, n) => (error ? reject(error) : resolve(n))),
      );
      if (!bytes) {
        // About once a second of silence, make sure the device hasn't been unplugged.
        if (++quietReads % 10 === 0 && !existsSync(this.path)) throw new Error(`${this.path} was disconnected`);
        continue;
      }
      quietReads = 0;
      pending += decoder.decode(buffer.subarray(0, bytes), { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) onLine(line);
      }
    }
  }

  writeLine(line: string): void {
    this.write(Buffer.from(line + '\n', 'latin1'));
  }

  writeRealtime(byte: number): void {
    this.write(Buffer.from([byte]));
  }

  // Synchronous writes keep bytes in order; GRBL's 128-byte limit means they never block for long.
  private write(data: Buffer): void {
    if (this.fd === null) return;
    try {
      writeSync(this.fd, data);
    } catch (error) {
      // EIO/ENXIO/ENODEV: the adapter is gone. The read loop reports it and closes the connection.
      this.failure ??= new Error(`Writing to ${this.path} failed: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.loop?.catch(() => undefined);
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
