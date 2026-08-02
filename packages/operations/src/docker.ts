import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface DockerRunner {
  run(arguments_: readonly string[]): Promise<CommandResult>;
}

function resolveDockerExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DOCKER_CLI_PATH !== undefined && existsSync(environment.DOCKER_CLI_PATH)) {
    return environment.DOCKER_CLI_PATH;
  }
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (localAppData !== undefined) {
      const userInstall = join(
        localAppData,
        "Programs",
        "DockerDesktop",
        "resources",
        "bin",
        "docker.exe",
      );
      if (existsSync(userInstall)) return userInstall;
    }
    const machineInstall = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
    if (existsSync(machineInstall)) return machineInstall;
  }
  return "docker";
}

export class DockerCommandRunner implements DockerRunner {
  readonly #executable: string;
  readonly #timeoutMs: number;

  public constructor(environment: NodeJS.ProcessEnv = process.env, timeoutMs = 600_000) {
    this.#executable = resolveDockerExecutable(environment);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Docker command timeout must be a positive integer.");
    }
    this.#timeoutMs = timeoutMs;
  }

  public run(arguments_: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [...arguments_], {
        shell: false,
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.#timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        const result = {
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
        };
        if (timedOut) {
          reject(new Error(`Docker command exceeded the ${String(this.#timeoutMs)} ms timeout.`));
          return;
        }
        if (code === 0) {
          resolve(result);
          return;
        }
        reject(
          new Error(
            `Docker command failed with exit code ${String(code)}: ${result.stderr || "no diagnostic output"}`,
          ),
        );
      });
    });
  }
}
