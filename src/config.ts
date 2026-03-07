import { config as loadDotenv } from "dotenv";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ChatMode } from "./types.js";

loadDotenv();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional().default(""),
  STATE_DIR: z.string().optional().default("./data"),
  LOG_LEVEL: z.string().optional().default("info"),
  CODEX_BIN: z.string().optional().default("codex"),
  CODEX_MODEL: z.string().optional().default(""),
  CODEX_ENABLE_SEARCH: z.string().optional().default("false"),
  DEFAULT_WORKSPACE_NAME: z.string().optional().default(""),
  DEFAULT_WORKSPACE_PATH: z.string().optional().default(""),
  DEFAULT_PATH: z.string().optional().default(""),
  DEFAULT_MODE: z.enum(["read", "write"]).optional().default("read"),
  ENABLE_RUN_COMMAND: z.string().optional().default("false"),
  MAX_OUTPUT_CHARS: z.coerce.number().int().positive().optional().default(12000),
  MAX_COMMAND_SECONDS: z.coerce.number().int().positive().optional().default(1800),
  HEARTBEAT_SECONDS: z.coerce.number().int().positive().optional().default(5)
});

const env = envSchema.parse(process.env);

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTrue(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveCodexBin(input: string): string {
  const trimmed = input.trim();
  const candidates = [
    trimmed || "codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(process.env.HOME ?? "", ".local/bin/codex")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
    const probe = spawnSync(resolved, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (probe.status === 0) {
      return resolved;
    }
  }

  return trimmed || "codex";
}

export interface AppConfig {
  telegramBotToken: string;
  allowedChatIds: Set<string>;
  allowedUserIds: Set<string>;
  stateDir: string;
  logLevel: string;
  codexBin: string;
  codexModel?: string;
  codexEnableSearch: boolean;
  defaultWorkspaceName?: string;
  defaultWorkspacePath?: string;
  defaultPath?: string;
  defaultMode: ChatMode;
  enableRunCommand: boolean;
  maxOutputChars: number;
  maxCommandSeconds: number;
  heartbeatSeconds: number;
  spawnPath: string;
}

export function loadConfig(): AppConfig {
  const defaultWorkspaceName = env.DEFAULT_WORKSPACE_NAME.trim() || undefined;
  const defaultWorkspacePath = env.DEFAULT_WORKSPACE_PATH.trim() || undefined;
  const defaultPath = env.DEFAULT_PATH.trim() || defaultWorkspacePath || undefined;
  const allowedChatIds = new Set(splitCsv(env.TELEGRAM_ALLOWED_CHAT_IDS));
  const allowedUserIds = new Set(splitCsv(env.TELEGRAM_ALLOWED_USER_IDS));

  if ((defaultWorkspaceName && !defaultWorkspacePath) || (!defaultWorkspaceName && defaultWorkspacePath)) {
    throw new Error("DEFAULT_WORKSPACE_NAME and DEFAULT_WORKSPACE_PATH must be set together");
  }

  if (allowedChatIds.size === 0 && allowedUserIds.size === 0) {
    throw new Error("At least one Telegram allowlist must be configured via TELEGRAM_ALLOWED_CHAT_IDS or TELEGRAM_ALLOWED_USER_IDS");
  }

  const spawnPath = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH ?? ""
  ]
    .filter(Boolean)
    .join(":");

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    allowedChatIds,
    allowedUserIds,
    stateDir: path.resolve(env.STATE_DIR),
    logLevel: env.LOG_LEVEL,
    codexBin: resolveCodexBin(env.CODEX_BIN),
    codexModel: env.CODEX_MODEL.trim() || undefined,
    codexEnableSearch: isTrue(env.CODEX_ENABLE_SEARCH),
    defaultWorkspaceName,
    defaultWorkspacePath: defaultWorkspacePath ? path.resolve(defaultWorkspacePath) : undefined,
    defaultPath: defaultPath ? path.resolve(defaultPath) : undefined,
    defaultMode: env.DEFAULT_MODE,
    enableRunCommand: isTrue(env.ENABLE_RUN_COMMAND),
    maxOutputChars: env.MAX_OUTPUT_CHARS,
    maxCommandSeconds: env.MAX_COMMAND_SECONDS,
    heartbeatSeconds: env.HEARTBEAT_SECONDS,
    spawnPath
  };
}
