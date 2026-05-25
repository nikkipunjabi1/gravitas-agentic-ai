import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gravitas Transformation Co-Pilot",
  description:
    "Describe a digital problem; the Co-Pilot reasons across UX, CX, technology, and AI dimensions and renders a tailored transformation roadmap — live, on a Generative Canvas.",
  // The favicon is sourced from the Gravitas logo data URI at runtime by the
  // canvas chrome; the favicon link itself is kept minimal to avoid bundling
  // brand assets into the static <head>.
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
