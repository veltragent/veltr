import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-mono-jb",
  subsets: ["latin"],
  display: "swap",
});

/**
 * The canonical origin.
 *
 * Without it Next resolves Open Graph and canonical URLs against localhost, so
 * every link preview a deployed site produces points somewhere nobody else can
 * reach. `VELTR_SITE_URL` overrides it for a preview deployment.
 */
const SITE_URL = process.env.VELTR_SITE_URL?.trim() || "https://veltragent.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  title: "Veltr Agent — autonomous market analyst for Robinhood Chain",
  description:
    "Veltr Agent reads Robinhood Chain directly, watches whatever you point it at — a token, a repository, a page — and acts only with your approval. US equities trade here as tokens that never rebase, so your balance and your ownership stop agreeing the moment a split lands. Every figure it quotes came from a call it made; it has no path to inventing one.",
  openGraph: {
    title: "Veltr Agent — autonomous market analyst for Robinhood Chain",
    description:
      "Your balance is fixed. Your ownership is not. Veltr Agent reads what your wallet cannot, watches what you choose, and never reports a number it did not fetch.",
    type: "website",
    url: SITE_URL,
    siteName: "Veltr Agent",
  },
  twitter: {
    card: "summary_large_image",
    title: "Veltr Agent",
    description:
      "Your balance is fixed. Your ownership is not. An autonomous analyst for Robinhood Chain that never reports a number it did not fetch.",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${jetbrains.variable} h-full`}
    >
      <body className="grain min-h-full flex flex-col">{children}</body>
    </html>
  );
}
