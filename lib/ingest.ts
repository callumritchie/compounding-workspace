/* ---------------------------------------------------------------------------
   ingest.ts — turn an uploaded file into plain text.

   This is the "format router" (PRD FR-23): whatever comes in — PDF, txt, md —
   is normalised to text so the rest of the system treats it uniformly. A PDF is
   extracted locally with pdf-parse; text formats pass straight through. After
   this, an upload is chunked + embedded exactly like any other corpus file.
--------------------------------------------------------------------------- */

import { PDFParse } from "pdf-parse";

export async function extractText(filename: string, buffer: Uint8Array): Promise<string> {
  if (filename.toLowerCase().endsWith(".pdf")) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text.trim();
    } finally {
      await parser.destroy();
    }
  }
  // txt / md / anything else → treat as UTF-8 text.
  return Buffer.from(buffer).toString("utf8");
}
