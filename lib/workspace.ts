/* ---------------------------------------------------------------------------
   workspace.ts — the tiny "storage layer".

   Everything the app remembers lives as plain files under ./workspace, so you
   can open them in a text editor and SEE the state.

   Chat history is PRIVATE per user, and now split into multiple TABS so you can
   run concurrent tasks. Each user has:
     workspace/users/<user>/chats/<chatId>.json   — one chat's messages
     workspace/users/<user>/chats/index.json      — the tab list (metadata)

   Memory + files stay SHARED, so a memory saved in one tab is available in all
   of them, and each tab can see what the others are working on (the index's
   title + last message feed the "other open tabs" awareness block).
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_PROJECT } from "./corpus";
import { writeFileSafe, updateFileSafe } from "./fsatomic";

// Per-assistant-message "X-ray": everything that produced the answer, stored
// with the message so it can be inspected later (persists across reloads).
export type MessageMeta = {
  trace?: { tool: string; input: Record<string, unknown>; summary: string; result?: string }[];
  reasoning?: string;
  injected?: { id: string; scope: string; type: string; tier: string; text: string }[];
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
  composition?: { label: string; tokens: number; tier: string }[];
};

// A single chat turn. `meta` is set on assistant turns for the X-ray view.
export type Message = { role: "user" | "assistant"; content: string; meta?: MessageMeta };

// One tab's metadata (the messages themselves live in <chatId>.json).
export type ChatMeta = {
  chatId: string;
  title: string;
  updated: string;
  lastUserMessage?: string;
  openFile?: string | null;
  agentId?: string; // which agent from the roster this chat uses (undefined = default)
  projectId?: string; // which project this chat belongs to (undefined = default project)
};

// The project a chat belongs to, backfilling old chats to the default project.
export function chatProject(c: ChatMeta): string {
  return c.projectId ?? DEFAULT_PROJECT;
}

// The two simulated users. Switching between them is how we demo "shared vs
// private": chat history is PRIVATE, files + memory are SHARED.
export const USERS = ["callum", "bob"] as const;
export type User = (typeof USERS)[number];

// Root of all on-disk state.
const WORKSPACE = path.join(process.cwd(), "workspace");

function chatsDir(user: User): string {
  return path.join(WORKSPACE, "users", user, "chats");
}
function indexPath(user: User): string {
  return path.join(chatsDir(user), "index.json");
}
function chatPath(user: User, chatId: string): string {
  // basename() guards against a chatId containing path separators.
  return path.join(chatsDir(user), `${path.basename(chatId)}.json`);
}

async function readIndex(user: User): Promise<ChatMeta[]> {
  try {
    return JSON.parse(await fs.readFile(indexPath(user), "utf8")) as ChatMeta[];
  } catch {
    return [];
  }
}
// Read-modify-write the tab index under a per-file lock so two concurrent tab
// operations (e.g. a user's two tabs) can't clobber each other's update.
function mutateIndex(user: User, mutate: (list: ChatMeta[]) => ChatMeta[]): Promise<void> {
  return updateFileSafe(indexPath(user), (current) => {
    let list: ChatMeta[] = [];
    try {
      list = current ? (JSON.parse(current) as ChatMeta[]) : [];
    } catch {
      list = [];
    }
    return JSON.stringify(mutate(list), null, 2);
  });
}

// The full tab list (all projects). The chat route + project filtering use this.
export async function listChats(user: User): Promise<ChatMeta[]> {
  return readIndex(user);
}

// Just this user's chats within one project (old chats fall under the default).
export async function listChatsForProject(user: User, projectId: string): Promise<ChatMeta[]> {
  return (await readIndex(user)).filter((c) => chatProject(c) === projectId);
}

// Start a new tab in a project.
export async function createChat(user: User, projectId: string, title = "New chat"): Promise<ChatMeta> {
  const chatId = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const meta: ChatMeta = { chatId, title, updated: new Date().toISOString(), projectId };
  await mutateIndex(user, (list) => [...list, meta]);
  await writeFileSafe(chatPath(user, chatId), "[]");
  return meta;
}

// One tab's messages ([] if none yet).
export async function getChatHistory(user: User, chatId: string): Promise<Message[]> {
  try {
    return JSON.parse(await fs.readFile(chatPath(user, chatId), "utf8")) as Message[];
  } catch {
    return [];
  }
}

// Save one tab's messages back to disk (atomic — no torn reads mid-write).
export async function saveChatHistory(user: User, chatId: string, messages: Message[]): Promise<void> {
  await writeFileSafe(chatPath(user, chatId), JSON.stringify(messages, null, 2));
}

// Patch a tab's metadata (title, last message, open file, updated time).
export async function updateChatMeta(user: User, chatId: string, patch: Partial<ChatMeta>): Promise<void> {
  await mutateIndex(user, (list) => {
    const i = list.findIndex((c) => c.chatId === chatId);
    if (i === -1) return list;
    list[i] = { ...list[i], ...patch };
    return list;
  });
}

// Empty a tab's messages but keep the tab.
export async function clearChat(user: User, chatId: string): Promise<void> {
  await saveChatHistory(user, chatId, []);
}

// Remove a tab entirely.
export async function deleteChat(user: User, chatId: string): Promise<void> {
  await mutateIndex(user, (list) => list.filter((c) => c.chatId !== chatId));
  try {
    await fs.unlink(chatPath(user, chatId));
  } catch {
    /* already gone */
  }
}

// Guard: reject anything that isn't one of our known users.
export function isUser(value: unknown): value is User {
  return typeof value === "string" && (USERS as readonly string[]).includes(value);
}
