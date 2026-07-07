/* Rebuild the shared-memory database from the git-tracked markdown seeds.
   Run: npm run db:reseed   */
export {};

async function main() {
  const { reseed } = await import("../lib/seed");
  const { getDb } = await import("../lib/db");
  console.log("reseeding workspace.db from markdown seeds…");
  const n = await reseed();
  const counts = ["memories", "signals", "promotions", "proposals"].map((t) => {
    const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number };
    return `${t}=${row.c}`;
  });
  console.log(`✅ seeded ${n} memories → workspace/index/workspace.db  (${counts.join(", ")})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
