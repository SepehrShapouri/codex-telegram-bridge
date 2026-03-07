import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionIndexRecord } from "./types.js";

const SESSION_INDEX_PATH = path.join(os.homedir(), ".codex", "session_index.jsonl");

export async function readSessionIndex(limit = 12): Promise<SessionIndexRecord[]> {
  try {
    const raw = await readFile(SESSION_INDEX_PATH, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionIndexRecord)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, limit);
  } catch {
    return [];
  }
}
