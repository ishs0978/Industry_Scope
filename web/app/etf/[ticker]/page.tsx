import type { Metadata } from "next";
import { notFound } from "next/navigation";
import EtfDetail from "@/components/EtfDetail";
import { getEtfPayload } from "@/lib/data";
import { fundsWithSector } from "@/lib/registry";

export const revalidate = 86400;
export const dynamicParams = false;

export function generateStaticParams() {
  return fundsWithSector().map((fund) => ({ ticker: fund.ticker }));
}

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  const payload = await getEtfPayload(ticker);
  return payload
    ? {
      title: `${payload.ticker} · ${payload.meta?.name ?? payload.sectorName}`,
      description: `${payload.ticker} performance, risk, fees and composition, measured over one user-controlled date range.`,
    }
    : {};
}

export default async function EtfPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const payload = await getEtfPayload(ticker);
  if (!payload) notFound();
  return <EtfDetail payload={payload} />;
}
