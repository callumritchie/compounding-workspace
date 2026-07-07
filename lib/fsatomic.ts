/* ---------------------------------------------------------------------------
   fsatomic.ts — safe writes for the state that stays in files.

   Shared memory moved to a transactional database (lib/db.ts). But some state is
   still files: the shared document corpus, and each user's private chat history.
   Those need two guarantees under concurrency:

     1. no TORN file — a reader must never see a half-written file. We write to a
        temp file and atomically rename it over the target (rename is atomic on
        the same filesystem).
     2. no LOST update — two writers doing read-modify-write on the same file (e.g.
        a user's two tabs both appending to the chat index) must not clobber each
        other. We serialise writes per path with a small in-process async mutex.

   Single-server scope: one Node process, so an in-process lock is sufficient.
--------------------------------------------------------------------------- */

import { promises as fs } from "fs";
import path from "path";

// One promise chain per file path = a mutex. Each queued task runs after the
// previous resolves, so read-modify-write sequences on the same path can't interleave.
const chains = new Map<string, Promise<unknown>>();

export function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task); // run regardless of prior outcome
  // Keep the chain alive but don't leak rejections into the next waiter.
  chains.set(key, next.catch(() => {}));
  return next;
}

// Atomic write: temp file in the same directory → rename over the target.
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

// The common case: serialise + write atomically.
export function writeFileSafe(filePath: string, data: string): Promise<void> {
  return withFileLock(filePath, () => writeFileAtomic(filePath, data));
}

// Read-modify-write under the lock: read current text (or undefined), transform,
// write atomically — with no other writer able to interleave on this path.
export function updateFileSafe(
  filePath: string,
  transform: (current: string | undefined) => string | Promise<string>
): Promise<void> {
  return withFileLock(filePath, async () => {
    let current: string | undefined;
    try {
      current = await fs.readFile(filePath, "utf8");
    } catch {
      current = undefined;
    }
    await writeFileAtomic(filePath, await transform(current));
  });
}
