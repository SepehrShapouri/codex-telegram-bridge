export type ChatMode = "read" | "write";

export interface ThreadRecord {
  threadId: string;
  updatedAt: string;
  path?: string;
}

export interface ChatStateRecord {
  currentPath?: string;
  preferredMode: ChatMode;
  threads: Record<string, ThreadRecord>;
  selectedThreadId?: string;
  selectedThreadLabel?: string;
  lastPrompt?: string;
  lastResultAt?: string;
  pendingRunCommand?: string;
  lastUsage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  lastRunSeconds?: number;
}

export interface PersistedState {
  version: 1;
  chats: Record<string, ChatStateRecord>;
}

export interface SessionIndexRecord {
  id: string;
  thread_name?: string;
  updated_at: string;
}
