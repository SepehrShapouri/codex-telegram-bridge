import { spawn } from "node:child_process";
import { truncateText } from "./text.js";

export interface ShellRunResult {
  output: string;
  exitCode: number | null;
}

export interface ShellTaskHandle {
  promise: Promise<ShellRunResult>;
  stop: () => void;
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
  spawnPath = process.env.PATH ?? ""
): ShellTaskHandle {
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;

  const promise = new Promise<ShellRunResult>((resolve, reject) => {
    child = spawn(process.env.SHELL || "zsh", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: spawnPath
      }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped) {
        reject(new Error("Task stopped by user."));
        return;
      }
      resolve({
        exitCode: code,
        output: truncateText([stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n"), outputLimit)
      });
    });
  });

  return {
    promise,
    stop: () => {
      stopped = true;
      child?.kill("SIGTERM");
    }
  };
}
