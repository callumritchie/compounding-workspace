/* ---------------------------------------------------------------------------
   workspace.ts — the tiny "storage layer".

   Everything the app remembers lives as plain files under ./workspace, so you
   can open them in a text editor and SEE the state. This module only knows how
   to read/write per-user chat history for now; memory + corpus come later.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";

// A single chat turn. Kept intentionally minimal.
export type Message = { role: "user" | "assistant"; content: string };

// The two simulated users. Switching between them is how we demo "shared vs
// private" later: chat history is PRIVATE, files + memory will be SHARED.
export const USERS = ["alice", "bob"] as const;
export type User = (typeof USERS)[number];

// Root of all on-disk state.
const WORKSPACE = path.join(process.cwd(), "workspace");

function historyPath(user: User): string {
  return path.join(WORKSPACE, "users", user, "chat-history.json");
}

// Make sure a user's folder exists before we write to it.
async function ensureUserDir(user: User): Promise<void> {
  await fs.mkdir(path.join(WORKSPACE, "users", user), { recursive: true });
}

// Load a user's private chat history (empty list if they've never chatted).
export async function getHistory(user: User): Promise<Message[]> {
  try {
    const raw = await fs.readFile(historyPath(user), "utf8");
    return JSON.parse(raw) as Message[];
  } catch {
    return [];
  }
}

// Save a user's private chat history back to disk.
export async function saveHistory(user: User, messages: Message[]): Promise<void> {
  await ensureUserDir(user);
  await fs.writeFile(historyPath(user), JSON.stringify(messages, null, 2), "utf8");
}

// Guard: reject anything that isn't one of our known users.
export function isUser(value: unknown): value is User {
  return typeof value === "string" && (USERS as readonly string[]).includes(value);
}
