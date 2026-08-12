import { NextResponse } from "next/server";
import { getIndustryPayload } from "@/lib/data";

export const revalidate = 86400;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors });
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const payload = await getIndustryPayload(slug);
  if (!payload) return NextResponse.json({ error: { source: "sector registry", reason: `Unknown sector: ${slug}` } }, { status: 404, headers: cors });
  const status = payload.errors.some((error) => error.source === "Neon Postgres") ? 503 : 200;
  return NextResponse.json(payload, {
    status,
    headers: { ...cors, "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" },
  });
}

