import { spawn } from "node:child_process";
import { truncateText } from "./text.js";

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `git exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function getGitSummary(cwd: string, timeoutMs: number, outputLimit: number): Promise<string> {
  try {
    const [branch, status, diffStat] = await Promise.all([
      runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, timeoutMs),
      runGit(["status", "--short"], cwd, timeoutMs),
      runGit(["diff", "--stat"], cwd, timeoutMs)
    ]);

    const lines = [
      `Branch: ${branch || "(detached)"}`,
      `Dirty files: ${status ? status.split("\n").length : 0}`
    ];

    if (status) {
      lines.push("", "Status:", truncateText(status, Math.floor(outputLimit * 0.4)));
    }

    if (diffStat) {
      lines.push("", "Diff stat:", truncateText(diffStat, Math.floor(outputLimit * 0.4)));
    }

    return truncateText(lines.join("\n"), outputLimit);
  } catch {
    return "No git summary available for this workspace.";
  }
}

export async function getGitDiffSummary(cwd: string, timeoutMs: number, outputLimit: number): Promise<string> {
  try {
    const [nameOnly, diffStat] = await Promise.all([
      runGit(["diff", "--name-only"], cwd, timeoutMs),
      runGit(["diff", "--stat"], cwd, timeoutMs)
    ]);

    const lines = ["Git diff summary:"];
    if (nameOnly) {
      lines.push("", "Changed files:", truncateText(nameOnly, Math.floor(outputLimit * 0.5)));
    }
    if (diffStat) {
      lines.push("", "Diff stat:", truncateText(diffStat, Math.floor(outputLimit * 0.5)));
    }

    if (!nameOnly && !diffStat) {
      lines.push("", "Working tree is clean.");
    }

    return truncateText(lines.join("\n"), outputLimit);
  } catch {
    return "No git diff available for this workspace.";
  }
}
