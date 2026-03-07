import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile } from "grammy";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { CodexRunner } from "./codex.js";
import { getGitDiffSummary, getGitSummary } from "./git.js";
import { createLogger } from "./logger.js";
import { readSessionIndex } from "./sessions.js";
import { runShellCommand } from "./shell.js";
import { StateStore } from "./state-store.js";
import { chunkText, sanitizeFileName, truncateText } from "./text.js";
import type { ChatMode, SessionIndexRecord } from "./types.js";

const config = loadConfig();
const logger = createLogger(config);
const stateStore = new StateStore(config);
const codexRunner = new CodexRunner(config);
const bot = new Bot(config.telegramBotToken);

const runningStops = new Map<string, () => void>();
const queues = new Map<string, Promise<void>>();
const LONG_TEXT_DOCUMENT_THRESHOLD = 7000;

function queueByChat(chatId: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (queues.get(chatId) === next) {
        queues.delete(chatId);
      }
    });
  queues.set(chatId, next);
  return next;
}

function isAuthorized(chatId: string, userId?: string): boolean {
  const chatAllowed = config.allowedChatIds.size === 0 || config.allowedChatIds.has(chatId);
  const userAllowed = config.allowedUserIds.size === 0 || (userId ? config.allowedUserIds.has(userId) : false);
  return chatAllowed && userAllowed;
}

function actionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Status", "status").text("Changed", "diff").row().text("Sessions", "sessions").text("New", "new").row().text("Stop", "stop");
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Run it", "confirm_run").text("Cancel", "cancel_run");
}

function sessionKeyboard(sessions: SessionIndexRecord[]): InlineKeyboard | undefined {
  if (sessions.length === 0) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
  for (const session of sessions.slice(0, 6)) {
    const label = truncateText(session.thread_name || session.id, 28);
    keyboard.text(label, `session:${session.id}`);
    keyboard.row();
  }
  return keyboard;
}

async function sendText(chatId: number | string, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const chunks = chunkText(text, 3900);
  for (let index = 0; index < chunks.length; index += 1) {
    await bot.api.sendMessage(chatId, chunks[index]!, {
      reply_markup: index === chunks.length - 1 ? keyboard : undefined,
      link_preview_options: {
        is_disabled: true
      }
    });
  }
}

async function sendDocumentText(chatId: number | string, fileName: string, text: string, caption?: string, keyboard?: InlineKeyboard): Promise<void> {
  const document = new InputFile(Buffer.from(text, "utf8"), sanitizeFileName(fileName));
  await bot.api.sendDocument(chatId, document, {
    caption: caption ? truncateText(caption, 900) : undefined,
    reply_markup: keyboard,
    disable_content_type_detection: true
  });
}

async function sendRichText(chatId: number | string, text: string, keyboard?: InlineKeyboard, artifactName?: string, caption?: string): Promise<void> {
  if (text.length > LONG_TEXT_DOCUMENT_THRESHOLD && artifactName) {
    const preview = caption ?? `${truncateText(text, 2500)}\n\nFull output attached as ${artifactName}.`;
    await sendText(chatId, preview, keyboard);
    await sendDocumentText(chatId, artifactName, text, artifactName, keyboard);
    return;
  }

  await sendText(chatId, text, keyboard);
}

async function sendDraft(chatId: number, draftId: number | undefined, text: string): Promise<void> {
  if (!draftId) {
    return;
  }
  try {
    await bot.api.sendMessageDraft(chatId, draftId, truncateText(text, 4096));
  } catch (error) {
    logger.debug({ error, chatId }, "Failed to send Telegram draft");
  }
}

function startChatAction(chatId: number, action: Parameters<typeof bot.api.sendChatAction>[1]): NodeJS.Timeout {
  void bot.api.sendChatAction(chatId, action).catch(() => undefined);
  return setInterval(() => {
    void bot.api.sendChatAction(chatId, action).catch(() => undefined);
  }, 4000);
}

function formatUsageFooter(usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): string {
  if (!usage) {
    return "";
  }
  const parts = [
    usage.inputTokens ? `in ${usage.inputTokens}` : "",
    usage.cachedInputTokens ? `cached ${usage.cachedInputTokens}` : "",
    usage.outputTokens ? `out ${usage.outputTokens}` : ""
  ].filter(Boolean);
  return parts.length ? `[usage: ${parts.join(" | ")}]` : "";
}

function expandUserPath(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", input.slice(2));
  }
  return path.resolve(input);
}

async function assertDirectoryPath(input: string): Promise<string> {
  const resolved = expandUserPath(input);
  const result = await stat(resolved);
  if (!result.isDirectory()) {
    throw new Error("path is not a directory");
  }
  return resolved;
}

function activeTaskLabel(chatId: string): string {
  return runningStops.has(chatId) ? "running" : "idle";
}

async function getCurrentPath(chatId: string): Promise<string | undefined> {
  const currentPath = stateStore.getChat(chatId).currentPath;
  if (!currentPath) {
    return undefined;
  }

  if (!path.isAbsolute(currentPath)) {
    await stateStore.setCurrentPath(chatId, undefined);
    return undefined;
  }

  try {
    const result = await stat(currentPath);
    if (!result.isDirectory()) {
      await stateStore.setCurrentPath(chatId, undefined);
      return undefined;
    }
    return currentPath;
  } catch {
    await stateStore.setCurrentPath(chatId, undefined);
    return undefined;
  }
}

function buildHelp(): string {
  return [
    "Message the bot normally and it will run Codex on your laptop.",
    "",
    "Useful commands:",
    "/cd <path> - switch current path",
    "/pwd - show current path",
    "/status - current path, session, branch, and task state",
    "/sessions - list recent Codex sessions from your laptop",
    "/session <id> - attach to a specific session",
    "/new - start a fresh thread for the current path",
    "/diff - show changed files",
    "/stop - stop the current task",
    "/mode <read|write> - advanced safety toggle",
    "/run <command> - optional shell command with confirmation",
    "",
    "Plain English also works: go to ~/Desktop/foo, switch to /path, continue, start over, what changed."
  ].join("\n");
}

function buildPathHelp(chatId: string): string {
  return 'No current path is set.\n\nSend something like:\n/cd "/absolute/path/to/project"\nor\n"go to ~/Desktop/project"';
}

function summarizeForTelegram(fullText: string): string {
  const trimmed = fullText.trim();
  if (!trimmed) {
    return "(empty response)";
  }
  const paragraphs = trimmed.split(/\n\s*\n/).map((entry) => entry.trim()).filter(Boolean);
  const first = paragraphs[0] ?? trimmed;
  const second = paragraphs[1];
  return truncateText(second ? `${first}\n\n${second}` : first, 2200);
}

async function handleStatus(chatId: string): Promise<string> {
  const chat = stateStore.getChat(chatId);
  const currentPath = await getCurrentPath(chatId);
  const lines = [`Task: ${activeTaskLabel(chatId)}`, `Mode: ${chat.preferredMode}`];

  if (!currentPath) {
    lines.unshift("Current path: none");
    lines.push("", buildPathHelp(chatId));
    return lines.join("\n");
  }

  lines.unshift(`Current path: ${currentPath}`);
  if (chat.selectedThreadId) {
    lines.push(`Selected session: ${chat.selectedThreadLabel ?? chat.selectedThreadId}`);
  } else {
    const thread = stateStore.getThread(chatId, currentPath, chat.preferredMode);
    lines.push(`Path session: ${thread?.threadId ?? "(new conversation)"}`);
  }
  if (chat.lastPrompt) {
    lines.push(`Last prompt: ${truncateText(chat.lastPrompt, 120)}`);
  }
  if (chat.lastRunSeconds) {
    lines.push(`Last run: ${chat.lastRunSeconds}s`);
  }
  const usage = formatUsageFooter(chat.lastUsage);
  if (usage) {
    lines.push(usage);
  }
  lines.push("", await getGitSummary(currentPath, 15_000, 5000));
  return lines.join("\n");
}

async function handleDiff(chatId: string): Promise<string> {
  const currentPath = await getCurrentPath(chatId);
  if (!currentPath) {
    return buildPathHelp(chatId);
  }
  return getGitDiffSummary(currentPath, 15_000, 6000);
}

async function handleSessions(): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const sessions = await readSessionIndex(8);
  if (sessions.length === 0) {
    return { text: "No Codex sessions were found in ~/.codex/session_index.jsonl." };
  }
  const text = sessions
    .map((session, index) => `${index + 1}. ${session.thread_name || "(untitled)"}\n${session.id}\n${session.updated_at}`)
    .join("\n\n");
  return {
    text,
    keyboard: sessionKeyboard(sessions)
  };
}

async function handlePrompt(chatId: string, prompt: string, draftId?: number): Promise<string> {
  const currentPath = await getCurrentPath(chatId);
  if (!currentPath) {
    return buildPathHelp(chatId);
  }

  const chat = stateStore.getChat(chatId);
  const mode = chat.preferredMode;
  const existingThreadId = chat.selectedThreadId ?? stateStore.getThread(chatId, currentPath, mode)?.threadId;
  await stateStore.setLastPrompt(chatId, prompt);

  const runningMessage = await bot.api.sendMessage(chatId, `${existingThreadId ? "Continuing" : "Starting"} Codex in ${currentPath}...`, {
    reply_markup: actionsKeyboard()
  });
  const startedAt = Date.now();
  const phases = ["Reading the path", "Thinking through the task", "Working on the machine", "Wrapping up the result"];
  const chatAction = startChatAction(Number(chatId), "typing");
  await sendDraft(Number(chatId), draftId, `Starting Codex in ${currentPath}...`);

  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const phase = phases[Math.min(phases.length - 1, Math.floor(elapsedSeconds / Math.max(1, config.heartbeatSeconds)))];
    void sendDraft(Number(chatId), draftId, `${phase}...\nPath: ${currentPath}\nElapsed: ${elapsedSeconds}s`);
    void bot.api.editMessageText(chatId, runningMessage.message_id, `${phase}...\nPath: ${currentPath}\nElapsed: ${elapsedSeconds}s`, {
      reply_markup: actionsKeyboard()
    }).catch(() => undefined);
  }, config.heartbeatSeconds * 1000);

  const task = codexRunner.run({
    cwd: currentPath,
    prompt,
    existingThreadId,
    mode
  });

  runningStops.set(chatId, task.stop);
  let finalStatus = "finished";

  try {
    const result = await task.promise;
    await stateStore.setThread(chatId, currentPath, mode, result.threadId);
    await stateStore.selectThread(chatId, result.threadId, currentPath);
    await stateStore.setLastRunMeta(chatId, {
      usage: result.usage,
      runSeconds: Math.round((Date.now() - startedAt) / 1000)
    });
    return summarizeForTelegram(result.text);
  } catch (error) {
    finalStatus = (error as Error).message === "Task stopped by user." ? "stopped" : "failed";
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearInterval(chatAction);
    runningStops.delete(chatId);
    if (finalStatus === "finished") {
      await bot.api.deleteMessage(chatId, runningMessage.message_id).catch(() => undefined);
    } else {
      await bot.api.editMessageText(chatId, runningMessage.message_id, `Codex run ${finalStatus} in ${Math.round((Date.now() - startedAt) / 1000)}s.`, {
        reply_markup: actionsKeyboard()
      }).catch(() => undefined);
    }
  }
}

function isRiskyCommand(command: string): boolean {
  const lowered = command.toLowerCase();
  return ["rm ", "rm -", "git reset", "git clean", "git checkout --", "git restore ", "sudo ", "mv ", "chmod ", "chown ", "npm uninstall", "pnpm remove", "yarn remove"].some((token) =>
    lowered.includes(token)
  );
}

async function executeRun(chatId: string, rawArgs: string, draftId?: number): Promise<string> {
  const currentPath = await getCurrentPath(chatId);
  if (!currentPath) {
    return buildPathHelp(chatId);
  }
  if (!rawArgs.trim()) {
    return "Usage: /run <command>";
  }

  const startedAt = Date.now();
  const runningMessage = await bot.api.sendMessage(chatId, `Running shell command in ${currentPath}...`, {
    reply_markup: actionsKeyboard()
  });
  const chatAction = startChatAction(Number(chatId), "typing");
  await sendDraft(Number(chatId), draftId, `Running shell command in ${currentPath}...`);
  const task = runShellCommand(rawArgs, currentPath, config.maxCommandSeconds * 1000, config.maxOutputChars, config.spawnPath);
  runningStops.set(chatId, task.stop);
  let finalStatus = "finished";

  try {
    const result = await task.promise;
    await stateStore.setLastRunMeta(chatId, {
      runSeconds: Math.round((Date.now() - startedAt) / 1000)
    });
    return truncateText([`Command: ${rawArgs}`, `Exit code: ${result.exitCode ?? "unknown"}`, "", result.output || "(no output)"].join("\n"), config.maxOutputChars);
  } catch (error) {
    finalStatus = (error as Error).message === "Task stopped by user." ? "stopped" : "failed";
    throw error;
  } finally {
    clearInterval(chatAction);
    runningStops.delete(chatId);
    await stateStore.setPendingRunCommand(chatId, undefined);
    if (finalStatus === "finished") {
      await bot.api.deleteMessage(chatId, runningMessage.message_id).catch(() => undefined);
    } else {
      await bot.api.editMessageText(chatId, runningMessage.message_id, `Shell task ${finalStatus} in ${Math.round((Date.now() - startedAt) / 1000)}s.`, {
        reply_markup: actionsKeyboard()
      }).catch(() => undefined);
    }
  }
}

async function handleRun(chatId: string, rawArgs: string, draftId?: number): Promise<{ text: string; keyboard?: InlineKeyboard; artifactName?: string }> {
  if (!config.enableRunCommand) {
    return { text: "The /run command is disabled. Set ENABLE_RUN_COMMAND=true to enable it." };
  }
  if (!rawArgs.trim()) {
    return { text: "Usage: /run <command>" };
  }
  if (isRiskyCommand(rawArgs)) {
    await stateStore.setPendingRunCommand(chatId, rawArgs);
    return { text: `This shell command looks risky and needs confirmation:\n\n${rawArgs}`, keyboard: confirmKeyboard() };
  }
  return { text: await executeRun(chatId, rawArgs, draftId), keyboard: actionsKeyboard(), artifactName: "shell-output.txt" };
}

function interpretNaturalLanguage(text: string): { kind: "command"; name: string; args?: string[]; rawArgs?: string } | { kind: "prompt"; text: string } {
  const normalized = text.trim().toLowerCase();
  if (normalized === "start over" || normalized === "new thread" || normalized === "reset thread") {
    return { kind: "command", name: "new" };
  }
  if (normalized === "continue") {
    return { kind: "prompt", text: "Continue from where you left off." };
  }
  if (normalized === "status" || normalized === "what are you doing?" || normalized === "what are you doing") {
    return { kind: "command", name: "status" };
  }
  if (normalized === "what changed" || normalized === "what changed?" || normalized === "changed files") {
    return { kind: "command", name: "diff" };
  }
  const pathMatch = text.match(/^(?:go to|switch to|work in|cd to|use)\s+(.+)$/i);
  if (pathMatch?.[1]) {
    return { kind: "command", name: "cd", args: [pathMatch[1].trim()] };
  }
  return { kind: "prompt", text };
}

async function handleCd(chatId: string, requestedPath?: string): Promise<string> {
  if (!requestedPath) {
    return buildPathHelp(chatId);
  }
  const resolved = await assertDirectoryPath(requestedPath);
  await stateStore.setCurrentPath(chatId, resolved);
  return `Current path set to:\n${resolved}`;
}

async function handleSessionSelect(chatId: string, sessionId: string): Promise<string> {
  const sessions = await readSessionIndex(30);
  const session = sessions.find((entry) => entry.id === sessionId || entry.id.startsWith(sessionId));
  if (!session) {
    return `Session ${sessionId} was not found in ~/.codex/session_index.jsonl.`;
  }
  await stateStore.selectThread(chatId, session.id, session.thread_name || session.id);
  return `Attached to session:\n${session.thread_name || "(untitled)"}\n${session.id}`;
}

async function handleNewThread(chatId: string): Promise<string> {
  const currentPath = await getCurrentPath(chatId);
  if (!currentPath) {
    return buildPathHelp(chatId);
  }
  const mode = stateStore.getChat(chatId).preferredMode;
  await stateStore.clearThread(chatId, currentPath, mode);
  return `Started a fresh thread for:\n${currentPath}`;
}

async function handleCommand(
  chatId: string,
  userId: string | undefined,
  name: string,
  args: string[],
  rawArgs: string,
  draftId?: number
): Promise<{ text: string; keyboard?: InlineKeyboard; artifactName?: string }> {
  switch (name) {
    case "start":
    case "help":
      return { text: buildHelp(), keyboard: actionsKeyboard() };
    case "whoami":
      return { text: [`Chat ID: ${chatId}`, `User ID: ${userId ?? "(unknown)"}`].join("\n") };
    case "cd":
    case "path":
      return { text: await handleCd(chatId, args.join(" ").trim() || undefined), keyboard: actionsKeyboard() };
    case "pwd":
      {
        const currentPath = await getCurrentPath(chatId);
        return { text: currentPath ? `Current path: ${currentPath}` : buildPathHelp(chatId), keyboard: actionsKeyboard() };
      }
    case "new":
      return { text: await handleNewThread(chatId), keyboard: actionsKeyboard() };
    case "status":
      return { text: await handleStatus(chatId), keyboard: actionsKeyboard() };
    case "diff":
      return { text: await handleDiff(chatId), keyboard: actionsKeyboard(), artifactName: "git-diff-summary.txt" };
    case "sessions":
      return handleSessions();
    case "session":
      return { text: await handleSessionSelect(chatId, args[0] || ""), keyboard: actionsKeyboard() };
    case "mode": {
      const nextMode = args[0];
      if (nextMode !== "read" && nextMode !== "write") {
        return { text: "Usage: /mode <read|write>" };
      }
      await stateStore.setPreferredMode(chatId, nextMode as ChatMode);
      return { text: `Mode set to ${nextMode}.` };
    }
    case "run":
      return handleRun(chatId, rawArgs, draftId);
    default:
      return { text: "Unknown command. Use /help." };
  }
}

bot.on("callback_query:data", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  const userId = ctx.from ? String(ctx.from.id) : undefined;
  if (!chatId || !isAuthorized(chatId, userId)) {
    await ctx.answerCallbackQuery({ text: "Not allowed.", show_alert: true });
    return;
  }

  const data = ctx.callbackQuery.data;
  if (data === "stop") {
    const stop = runningStops.get(chatId);
    stop?.();
    await ctx.answerCallbackQuery({ text: stop ? "Stopping task..." : "No task is running." });
    return;
  }

  await queueByChat(chatId, async () => {
    if (data === "confirm_run") {
      const pending = stateStore.getChat(chatId).pendingRunCommand;
      if (!pending) {
        await ctx.answerCallbackQuery({ text: "No pending command." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Running command..." });
      const result = await executeRun(chatId, pending, ctx.update.update_id);
      await sendRichText(chatId, result, actionsKeyboard(), "shell-output.txt");
      return;
    }

    if (data === "cancel_run") {
      await stateStore.setPendingRunCommand(chatId, undefined);
      await ctx.answerCallbackQuery({ text: "Cancelled." });
      await sendText(chatId, "Cancelled the pending shell command.");
      return;
    }

    if (data.startsWith("session:")) {
      await ctx.answerCallbackQuery({ text: "Session selected." });
      const result = await handleSessionSelect(chatId, data.slice("session:".length));
      await sendText(chatId, result, actionsKeyboard());
      return;
    }

    await ctx.answerCallbackQuery();
    const result = await handleCommand(chatId, userId, data, [], "", ctx.update.update_id);
    await sendRichText(chatId, result.text, result.keyboard, result.artifactName);
  }).catch(async (error) => {
    logger.error({ error, chatId, data }, "Failed to handle callback");
    await ctx.answerCallbackQuery({ text: "Request failed.", show_alert: true }).catch(() => undefined);
    await sendText(chatId, `Request failed:\n${truncateText((error as Error).message, 3000)}`);
  });
});

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = ctx.from ? String(ctx.from.id) : undefined;

  if (!isAuthorized(chatId, userId)) {
    logger.warn({ chatId, userId }, "Rejected unauthorized Telegram message");
    return;
  }

  const text = ctx.message.text.trim();
  const parsed = parseCommand(text);

  if (parsed?.name === "stop" || text.toLowerCase() === "stop") {
    const stop = runningStops.get(chatId);
    await sendText(chatId, stop ? "Stop signal sent to the current task." : "No task is currently running for this chat.");
    stop?.();
    return;
  }

  await queueByChat(chatId, async () => {
    let response: { text: string; keyboard?: InlineKeyboard; artifactName?: string };
    if (parsed) {
      response = await handleCommand(chatId, userId, parsed.name, parsed.args, parsed.rawArgs, ctx.update.update_id);
    } else {
      const interpreted = interpretNaturalLanguage(text);
      if (interpreted.kind === "command") {
        response = await handleCommand(chatId, userId, interpreted.name, interpreted.args ?? [], interpreted.rawArgs ?? "", ctx.update.update_id);
      } else {
        response = { text: await handlePrompt(chatId, interpreted.text, ctx.update.update_id), keyboard: actionsKeyboard(), artifactName: "codex-response.txt" };
      }
    }

    await sendRichText(chatId, response.text, response.keyboard, response.artifactName);
  }).catch(async (error) => {
    logger.error({ error, chatId }, "Failed to handle Telegram message");
    await sendText(chatId, `Request failed:\n${truncateText((error as Error).message, 3000)}`);
  });
});

bot.catch((error) => {
  const context = error.ctx;
  logger.error({ error, updateId: context.update.update_id }, "Telegram bot error");
  if (error.error instanceof GrammyError) {
    logger.error({ description: error.error.description }, "Telegram API error");
    return;
  }
  if (error.error instanceof HttpError) {
    logger.error({ message: error.error.message }, "Network error while talking to Telegram");
  }
});

async function main(): Promise<void> {
  await stateStore.init();
  logger.info({ stateDir: config.stateDir, codexBin: config.codexBin, spawnPath: config.spawnPath }, "State store ready");
  await bot.api.setMyCommands([
    { command: "cd", description: "Switch current path" },
    { command: "pwd", description: "Show current path" },
    { command: "status", description: "Show current status" },
    { command: "sessions", description: "List recent Codex sessions" },
    { command: "new", description: "Start fresh thread" },
    { command: "stop", description: "Stop current task" }
  ]);
  await bot.start({
    onStart(botInfo) {
      logger.info({ username: botInfo.username }, "Telegram polling started");
    }
  });
}

main().catch((error) => {
  logger.fatal({ error }, "Bridge failed to start");
  process.exitCode = 1;
});
