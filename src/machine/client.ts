import type { JobView, LogKind, MachineState, StartOptions } from './controller';
import type { Vec3 } from './status';

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
  /** Throws (LimitError locally, Error remotely) when the job would go past the travel limits. */
  startJob(name: string, lines: string[], options?: StartOptions): void | Promise<void>;
  setTravelReference(size: Vec3, margin: number): void | Promise<void>;
  clearLimits(): void | Promise<void>;
  /** Runs homing; resolves with GRBL's response. */
  home(margin: number): Promise<string>;
  pauseJob(): void;
  resumeJob(): void;
  stopJob(): Promise<void>;
  disconnect(): Promise<void>;
}
