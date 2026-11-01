import type { Transport } from './transport';

/** USB connection to the real machine via the browser's Web Serial API. */
export class WebSerialTransport implements Transport {
  readonly name = 'USB';
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private closing = false;
  private encoder = new TextEncoder();

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  async open(onLine: (line: string) => void, onClose: (error?: unknown) => void): Promise<void> {
    if (!navigator.serial) throw new Error('This browser has no Web Serial support. Use Chrome or Edge.');
    const port = await navigator.serial.requestPort();
    // The 3018-PRO's GRBL board talks at 115200 baud.
    await port.open({ baudRate: 115200 });
    if (!port.readable || !port.writable) throw new Error('Serial port is not readable/writable');
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.readLoop = this.read(this.reader, onLine).then(
      () => onClose(),
      (error) => onClose(this.closing ? undefined : error),
    );
  }

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>, onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onLine(line);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  writeLine(line: string): void {
    this.write(this.encoder.encode(line + '\n'));
  }

  writeRealtime(byte: number): void {
    this.write(new Uint8Array([byte]));
  }

  private write(data: Uint8Array): void {
    this.writer?.write(data).catch((error) => console.error('Serial write failed', error));
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.reader?.cancel().catch(() => undefined);
    await this.readLoop;
    this.writer?.releaseLock();
    await this.port?.close().catch(() => undefined);
    this.port = null;
    this.reader = null;
    this.writer = null;
  }
}
