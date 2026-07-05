/* Local check of the memory store — no model involved.
   Run with: npx tsx scripts/check-memory.ts */

import { getMemoriesForContext } from "../lib/memory";

async function main() {
  for (const user of ["callum", "bob"]) {
    const mems = await getMemoriesForContext(user, "acme-health");
    console.log(`\n=== ${user} @ acme-health → ${mems.length} in-scope memories ===`);
    for (const m of mems) {
      console.log(`  [${m.scope} · ${m.type} · imp ${m.importance}] ${m.body.slice(0, 72)}…`);
    }
  }
}

main();
