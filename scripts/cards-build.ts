/* Generate a summary card for every project (ticket B1–B3). Retroactive over the
   whole corpus, so backfilled historical engagements become first-class substrate.
   Run: npm run cards:build */
export {};

async function main() {
  const { listProjects } = await import("../lib/corpus");
  const { generateCard } = await import("../lib/cards");
  const { sectorDensity } = await import("../lib/cards");
  const projects = await listProjects();
  console.log(`generating cards for ${projects.length} projects…`);
  for (const p of projects) {
    const card = await generateCard(p);
    console.log(`  ✓ ${p}: ${card.title}`);
  }
  console.log("\nsector density:");
  for (const d of await sectorDensity()) {
    console.log(`  ${d.ready ? "🟢" : "🟡"} ${d.sector}: ${d.projects} projects · ${d.clients} clients · ${d.cards} cards · ${d.lessons} lessons`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
