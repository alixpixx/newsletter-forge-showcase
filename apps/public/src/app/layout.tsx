import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Newsletter · Example Media",
  description: "Inscription aux newsletters Example Media.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // lang neutre au niveau racine ; le CONTENU de chaque page est localisé (kit conformité).
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
