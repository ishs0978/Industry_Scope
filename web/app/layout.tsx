import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "IndustryScope", template: "%s · IndustryScope" },
  description: "Source-transparent industry performance, fundamentals, capital, macro, and event analytics.",
  openGraph: {
    title: "IndustryScope",
    description: "See the whole industry.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "IndustryScope — See the whole industry." }],
  },
  twitter: { card: "summary_large_image", title: "IndustryScope", description: "See the whole industry.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="wordmark" href="/">Industry<span>Scope</span></Link>
          <nav aria-label="Primary navigation">
            <Link href="/">Industries</Link>
            <Link href="/methodology">Methodology</Link>
          </nav>
        </header>
        {children}
        <footer>
          <span>IndustryScope</span>
          <span>Source data only. No generated market narrative.</span>
        </footer>
      </body>
    </html>
  );
}
