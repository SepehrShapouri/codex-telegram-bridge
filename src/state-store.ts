import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { ChatMode, ChatStateRecord, PersistedState, ThreadRecord } from "./types.js";

const EMPTY_STATE: PersistedState = {
  version: 1,
  chats: {}
};

export class StateStore {
  private readonly filePath: string;
  private state: PersistedState = structuredClone(EMPTY_STATE);

  public constructor(private readonly config: AppConfig) {
    this.filePath = path.join(this.config.stateDir, "state.json");
  }

  public async init(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = this.normalizeState(JSON.parse(raw) as Partial<PersistedState>);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.state = structuredClone(EMPTY_STATE);
    }

    await this.save();
  }

  public ensureChat(chatId: string): ChatStateRecord {
    if (!this.state.chats[chatId]) {
      this.state.chats[chatId] = {
        currentPath: this.config.defaultPath,
        preferredMode: this.config.defaultMode,
        threads: {}
      };
    }
    return this.state.chats[chatId];
  }

  public getChat(chatId: string): ChatStateRecord {
    return this.ensureChat(chatId);
  }

  public async setCurrentPath(chatId: string, currentPath?: string): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.currentPath = currentPath;
    chat.selectedThreadId = undefined;
    chat.selectedThreadLabel = undefined;
    await this.save();
  }

  public async setPreferredMode(chatId: string, mode: ChatMode): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.preferredMode = mode;
    await this.save();
  }

  public async setLastPrompt(chatId: string, prompt: string): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.lastPrompt = prompt;
    chat.lastResultAt = new Date().toISOString();
    await this.save();
  }

  public async setLastRunMeta(
    chatId: string,
    meta: {
      usage?: {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      };
      runSeconds?: number;
    }
  ): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.lastUsage = meta.usage;
    chat.lastRunSeconds = meta.runSeconds;
    chat.lastResultAt = new Date().toISOString();
    await this.save();
  }

  public async setPendingRunCommand(chatId: string, command?: string): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.pendingRunCommand = command;
    await this.save();
  }

  public getThread(chatId: string, currentPath: string, mode: ChatMode): ThreadRecord | undefined {
    const chat = this.ensureChat(chatId);
    return chat.threads[this.threadKey(currentPath, mode)];
  }

  public async setThread(chatId: string, currentPath: string, mode: ChatMode, threadId: string): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.threads[this.threadKey(currentPath, mode)] = {
      threadId,
      updatedAt: new Date().toISOString(),
      path: currentPath
    };
    await this.save();
  }

  public async clearThread(chatId: string, currentPath: string, mode: ChatMode): Promise<void> {
    const chat = this.ensureChat(chatId);
    delete chat.threads[this.threadKey(currentPath, mode)];
    chat.selectedThreadId = undefined;
    chat.selectedThreadLabel = undefined;
    await this.save();
  }

  public async selectThread(chatId: string, threadId?: string, label?: string): Promise<void> {
    const chat = this.ensureChat(chatId);
    chat.selectedThreadId = threadId;
    chat.selectedThreadLabel = label;
    await this.save();
  }

  private threadKey(currentPath: string, mode: ChatMode): string {
    return `${currentPath}::${mode}`;
  }

  private normalizeState(raw: Partial<PersistedState>): PersistedState {
    const state: PersistedState = {
      version: 1,
      chats: raw.chats ?? {}
    };

    for (const chat of Object.values(state.chats)) {
      chat.currentPath ??= this.config.defaultPath;
      chat.preferredMode ??= this.config.defaultMode;
      chat.threads ??= {};
      if ((chat as ChatStateRecord & { activeWorkspaceName?: string }).activeWorkspaceName && !chat.currentPath) {
        chat.currentPath = (chat as ChatStateRecord & { activeWorkspaceName?: string }).activeWorkspaceName;
      }
    }

    return state;
  }

  private async save(): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.state, null, 2));
    await rename(tempPath, this.filePath);
  }
}
