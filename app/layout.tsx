import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Compounding Workspace",
  description: "A local workspace for learning context engineering (RAG + memory).",
};

// The root layout wraps every page. We keep it deliberately tiny.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
