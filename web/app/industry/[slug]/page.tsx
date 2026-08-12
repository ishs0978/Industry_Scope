import type { Metadata } from "next";
import { notFound } from "next/navigation";
import IndustryDashboard from "@/components/IndustryDashboard";
import { getIndustryPayload } from "@/lib/data";
import { sectorBySlug, sectors } from "@/lib/registry";

export const revalidate = 86400;
export const dynamicParams = false;

export function generateStaticParams() {
  return sectors().map((sector) => ({ slug: sector.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const sector = sectorBySlug(slug);
  return sector ? { title: sector.name, description: `${sector.name} performance, composition, fundamentals, capital, macro, and sourced events.` } : {};
}

export default async function IndustryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const payload = await getIndustryPayload(slug);
  if (!payload) notFound();
  return <IndustryDashboard initialPayload={payload} />;
}

