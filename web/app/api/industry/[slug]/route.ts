import { NextResponse } from "next/server";
import { getIndustryPayload } from "@/lib/data";

// The live Excel template refreshes against this endpoint, so a 24-hour window
// meant pressing Refresh in Excel could return day-old data with no indication.
export const revalidate = 3600;

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
  // generated_at lets the workbook show when this response was built.
  return NextResponse.json({ ...payload, generated_at: new Date().toISOString() }, {
    status,
    headers: { ...cors, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=3600" },
  });
}

