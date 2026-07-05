/* Quick local check of the corpus + tools — no model involved.
   Run with: npx tsx scripts/check-corpus.ts */

import { DEFAULT_PROJECT } from "../lib/corpus";
import { executeTool } from "../lib/tools";

async function main() {
  const ctx = { projectId: DEFAULT_PROJECT, user: "callum" };

  console.log("— list_files —");
  console.log((await executeTool(ctx, "list_files", {})).result, "\n");

  console.log("— search_files 'sensitivity analysis' —");
  console.log((await executeTool(ctx, "search_files", { query: "sensitivity analysis" })).result, "\n");

  console.log("— read_file interviews/cfo-interview.md (first 120 chars) —");
  console.log((await executeTool(ctx, "read_file", { path: "interviews/cfo-interview.md" })).result.slice(0, 120), "…\n");

  console.log("— path safety: read_file '../../../etc/passwd' (should error) —");
  console.log((await executeTool(ctx, "read_file", { path: "../../../etc/passwd" })).result, "\n");

  console.log("— write_file then list (temp file) —");
  console.log((await executeTool(ctx, "write_file", { path: "synthesis/_check-tmp.md", content: "temp" })).summary);
  console.log((await executeTool(ctx, "list_files", {})).result);
}

main();
