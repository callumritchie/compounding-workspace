/* Run memory maintenance: decay untouched learned memory, auto-archive the lowest.
   Run: npm run db:maintain   (or on a schedule) */
export {};

async function main() {
  const { decayMemories } = await import("../lib/lifecycle");
  const { decayed, archived } = await decayMemories();
  console.log(`✅ maintenance: decayed ${decayed} memories, archived ${archived}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
