import type { Metadata, Viewport } from "next";
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
  applicationName: "Veltr Agent",
  /**
   * Ownership proof for Virtuals Protocol.
   *
   * Goes through `verification.other` rather than a hand-written <meta> in the
   * layout's JSX: Next owns the contents of <head> here, and a tag placed
   * outside the Metadata API is the kind of thing a later refactor silently
   * drops — at which point the listing quietly fails re-verification with
   * nothing in the diff to explain why.
   *
   * The value is a public proof of control, not a credential. It grants
   * nothing, so it belongs in the repository where it stays with the site it
   * verifies rather than in an environment variable nobody remembers setting.
   */
  verification: {
    other: {
      "virtual-protocol-site-verification": "3a0a1c8466879ba109c494f4473bdc3e",
    },
  },
};

/**
 * The colour a browser paints its own chrome with.
 *
 * The same cream the page starts on, so the address bar on a phone and the tab
 * strip on a desktop continue the page rather than framing it in white. There
 * is no dark variant because the site has one palette; offering a second here
 * would be inventing a brand colour that appears nowhere else.
 */
export const viewport: Viewport = {
  themeColor: "#f7f2e7",
  colorScheme: "light",
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
