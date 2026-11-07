import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionInfo {
  commit: string;
  date: string;
  subject: string;
  branch: string;
}

export interface SystemInfo {
  version: VersionInfo | null;
  /** Why the app can't update itself, or null if it can. */
  updateBlocker: string | null;
  /** Why the Pi can't be shut down / restarted from the app, or null if it can. */
  powerBlocker: string | null;
}

export interface UpdateCheck {
  behind: number;
  commits: string[];
}

/** Things the server may do to the Pi itself. Kept to a fixed list on purpose: no arbitrary commands. */
export interface SystemActions {
  info(): Promise<SystemInfo>;
  checkForUpdates(): Promise<UpdateCheck>;
  startUpdate(): Promise<void>;
  power(action: 'poweroff' | 'reboot'): Promise<void>;
}

const run = (cmd: string, args: string[], cwd?: string, timeout = 30000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout }, (error, stdout, stderr) =>
      error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout.trim()),
    ),
  );

/**
 * The real thing on Raspberry Pi OS. Shutting down, restarting and updating go through
 * `sudo -n systemctl …`, which pi/install.sh allows for exactly these commands.
 */
export class PiSystem implements SystemActions {
  private systemctl = process.env.STUDIO_SYSTEMCTL || '/usr/bin/systemctl';

  constructor(private appDir: string) {}

  /** The commit the running build came from; git's HEAD can be ahead of it after a failed update. */
  private builtFrom(): string {
    try {
      return readFileSync(join(this.appDir, 'dist-server', 'BUILT_FROM'), 'utf8').trim() || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  async info(): Promise<SystemInfo> {
    let version: VersionInfo | null = null;
    let updateBlocker: string | null = null;
    if (!existsSync(join(this.appDir, '.git'))) {
      updateBlocker = 'This copy was not installed with git, so it cannot update itself. See "Updating" in pi/README.md.';
    } else {
      try {
        const [commit, date, subject] = (await run('git', ['log', '-1', '--format=%h%x00%cI%x00%s', this.builtFrom()], this.appDir)).split('\0');
        const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], this.appDir);
        version = { commit, date, subject, branch };
      } catch (error) {
        updateBlocker = `git is not working: ${(error as Error).message}`;
      }
    }
    const allowed = async (args: string[]) => {
      try {
        await run('sudo', ['-n', '-l', this.systemctl, ...args]);
        return true;
      } catch {
        return false;
      }
    };
    const setupHint = 'Run "bash pi/install.sh" on the Pi once to allow this.';
    const powerBlocker = (await allowed(['poweroff'])) && (await allowed(['reboot'])) ? null : setupHint;
    if (!updateBlocker && !(await allowed(['start', '--no-block', '3018-studio-update.service']))) updateBlocker = setupHint;
    return { version, updateBlocker, powerBlocker };
  }

  async checkForUpdates(): Promise<UpdateCheck> {
    await run('git', ['fetch', '--quiet', 'origin'], this.appDir, 60000);
    const log = await run('git', ['log', '--format=%h %s', `${this.builtFrom()}..@{u}`], this.appDir);
    const commits = log ? log.split('\n') : [];
    return { behind: commits.length, commits };
  }

  async startUpdate(): Promise<void> {
    // Runs pi/update.sh as its own service, so it survives this server being restarted at the end.
    await run('sudo', ['-n', this.systemctl, 'start', '--no-block', '3018-studio-update.service']);
  }

  async power(action: 'poweroff' | 'reboot'): Promise<void> {
    await run('sudo', ['-n', this.systemctl, action]);
  }
}
