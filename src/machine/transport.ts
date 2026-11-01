/**
 * A byte pipe to a GRBL controller. The controller logic never cares whether
 * it is talking to a real USB serial port or the built-in simulator.
 */
export interface Transport {
  readonly name: string;
  /** Opens the connection. `onLine` receives each line GRBL sends, without line endings. */
  open(onLine: (line: string) => void, onClose: (error?: unknown) => void): Promise<void>;
  /** Sends one G-code / `$` command line (a newline is appended). */
  writeLine(line: string): void;
  /** Sends a single real-time command byte (`?`, `!`, `~`, 0x18, 0x85 …). */
  writeRealtime(byte: number): void;
  close(): Promise<void>;
}
