import type { JobView, LogKind, MachineState } from './controller';

/**
 * What the interface needs from "the machine", whether GRBL is plugged into this computer
 * (GrblController) or into a Raspberry Pi running the 3018 Studio server (RemoteMachine).
 */
export interface MachineClient {
  readonly machine: MachineState;
  readonly job: JobView | null;
  readonly connected: boolean;
  readonly jobActive: boolean;
  onChange(fn: () => void): () => void;
  onLog(fn: (kind: LogKind, text: string) => void): () => void;
  send(line: string): Promise<string>;
  realtime(command: '?' | '!' | '~' | number): void;
  softReset(): void;
  startJob(name: string, lines: string[]): void | Promise<void>;
  pauseJob(): void;
  resumeJob(): void;
  stopJob(): Promise<void>;
  disconnect(): Promise<void>;
}
