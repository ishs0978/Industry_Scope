import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CompanyDetail from "@/components/CompanyDetail";
import { getCompanyPayload } from "@/lib/data";

// Companies come and go from a fund, and there are hundreds of them, so these
// render on demand and are cached rather than being built up front.
export const revalidate = 86400;
export const dynamic = "force-static";
export const dynamicParams = true;

export function generateStaticParams() {
  return [] as { ticker: string }[];
}

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  const payload = await getCompanyPayload(ticker);
  return payload
    ? {
      title: `${payload.ticker}${payload.meta?.name ? ` · ${payload.meta.name}` : ""}`,
      description: `${payload.ticker} reported fundamentals, valuation, analyst view and return history.`,
    }
    : {};
}

export default async function CompanyPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const payload = await getCompanyPayload(ticker);
  if (!payload) notFound();
  return <CompanyDetail payload={payload} />;
}
