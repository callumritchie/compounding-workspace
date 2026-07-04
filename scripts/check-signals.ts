/* Verify the signal ledger: same pattern 3× → auto-nomination on the 3rd.
   Run: npx tsx scripts/check-signals.ts */
export {};

async function main() {
  const { noteSignal, listSignals } = await import("../lib/signals");
  const { listNominations } = await import("../lib/promotion");

  for (let i = 1; i <= 3; i++) {
    const r = await noteSignal({
      pattern: "test-signal-demo",
      observation: "Test pattern recurs.",
      targetScope: "sector/healthcare",
      sourceProject: "acme-health",
      sourceClient: "acme",
    });
    console.log(`note ${i}: strength ${r.count}/${r.threshold}${r.nominatedNow ? "  → NOMINATED" : ""}`);
  }

  const pending = await listNominations("pending");
  const fromSignal = pending.filter((n) => n.nominatedBy === "signal-ledger");
  console.log("nominations from signal-ledger:", fromSignal.length);
  console.log("ledger:", (await listSignals()).map((s) => `${s.pattern}=${s.count}`).join(", "));
}

main();
