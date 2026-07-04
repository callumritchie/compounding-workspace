/* POST /api/upload  (multipart: file, project)
   → extract text → save into the corpus as markdown → chunk + embed into the index.

   The extracted PDF becomes a normal .md file, so it shows up in the file list
   and is searchable exactly like everything else — the "PDF vs MD" difference
   lives only here, in ingestion.
*/

import { extractText } from "@/lib/ingest";
import { writeFile, DEFAULT_PROJECT } from "@/lib/corpus";
import { addFileToIndex } from "@/lib/vectors";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const project = String(form.get("project") || DEFAULT_PROJECT);
  if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });

  let text: string;
  try {
    text = await extractText(file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "extraction failed";
    return Response.json({ error: detail }, { status: 500 });
  }
  if (!text.trim()) return Response.json({ error: "no text could be extracted" }, { status: 422 });

  const base = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const rel = `uploads/${base}.md`;
  await writeFile(project, rel, text);

  let chunks = 0;
  try {
    chunks = await addFileToIndex(project, rel);
  } catch {
    // extraction/write succeeded even if embedding hiccuped; surface 0 chunks
  }
  return Response.json({ file: rel, chunks });
}
