import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { ChatMode } from "./types.js";

export interface CodexRunProgress {
  type: "started" | "turn_started" | "heartbeat";
  threadId?: string;
  elapsedMs?: number;
}

export interface CodexRunResult {
  threadId: string;
  text: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
}

export interface CodexTaskHandle {
  promise: Promise<CodexRunResult>;
  stop: () => void;
}

export interface CodexRunOptions {
  cwd: string;
  prompt: string;
  existingThreadId?: string;
  mode: ChatMode;
  onProgress?: (progress: CodexRunProgress) => void;
}

interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  item?: {
    type?: string;
    text?: string;
  };
}

export class CodexRunner {
  public constructor(private readonly config: AppConfig) {}

  public run(options: CodexRunOptions): CodexTaskHandle {
    let child: ReturnType<typeof spawn> | undefined;
    let stopped = false;

    const promise = new Promise<CodexRunResult>((resolve, reject) => {
      const args = this.buildArgs(options);
      console.error(
        JSON.stringify({
          codexBin: this.config.codexBin,
          spawnPath: this.config.spawnPath,
          cwd: options.cwd,
          args
        })
      );
      child = spawn(this.config.codexBin, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: this.config.spawnPath
        }
      });

      let stdoutBuffer = "";
      let stderr = "";
      let threadId = options.existingThreadId;
      let finalText = "";
      let usage: CodexRunResult["usage"];

      child.stdout?.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          let event: CodexJsonEvent;
          try {
            event = JSON.parse(trimmed) as CodexJsonEvent;
          } catch {
            continue;
          }

          if (event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
            options.onProgress?.({ type: "started", threadId });
            continue;
          }

          if (event.type === "turn.started") {
            options.onProgress?.({ type: "turn_started", threadId });
            continue;
          }

          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            finalText = event.item.text ?? finalText;
            continue;
          }

          if (event.type === "turn.completed") {
            usage = {
              inputTokens: event.usage?.input_tokens,
              cachedInputTokens: event.usage?.cached_input_tokens,
              outputTokens: event.usage?.output_tokens
            };
          }
        }
      });

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (stopped) {
          reject(new Error("Task stopped by user."));
          return;
        }

        if (code !== 0) {
          reject(new Error(stderr.trim() || `codex exited with code ${code ?? "unknown"}`));
          return;
        }

        if (!threadId) {
          reject(new Error("codex completed without emitting a thread_id"));
          return;
        }

        resolve({
          threadId,
          text: finalText.trim() || "(Codex returned no final message.)",
          usage
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

  private buildArgs(options: CodexRunOptions): string[] {
    const args = options.existingThreadId
      ? ["exec", "resume", options.existingThreadId, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check"];

    if (this.config.codexModel) {
      args.push("-m", this.config.codexModel);
    }

    if (!options.existingThreadId) {
      if (options.mode === "read") {
        args.push("-s", "read-only");
      } else {
        args.push("-s", "workspace-write");
      }
    }

    if (this.config.codexEnableSearch && !options.existingThreadId) {
      args.push("--search");
    }

    args.push(options.prompt);
    return args;
  }
}
