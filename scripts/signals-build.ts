/* Extract signal atoms from every project's transcripts into the atom store
   (Primitive A). Retroactive over the whole corpus, like cards:build.
   Run: npm run signals:build   (after npm run seed:interactions && npm run index) */
export {};

async function main() {
  const { listProjects } = await import("../lib/corpus");
  const { extractProjectAtoms } = await import("../lib/signals/extract");
  const { insertAtoms, countAtoms } = await import("../lib/signals/atoms");
  const projects = await listProjects();
  console.log(`extracting signal atoms from ${projects.length} projects…`);
  let total = 0;
  for (const p of projects) {
    const atoms = await extractProjectAtoms(p);
    if (atoms.length) await insertAtoms(atoms);
    total += atoms.length;
    const byType = atoms.reduce<Record<string, number>>((m, a) => ((m[a.type] = (m[a.type] ?? 0) + 1), m), {});
    console.log(`  ✓ ${p}: ${atoms.length} atoms${atoms.length ? " (" + Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(", ") + ")" : ""}`);
  }
  console.log(`\n✅ extracted ${total} atoms; store now holds ${countAtoms()}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
