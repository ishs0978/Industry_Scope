"use client";

import type { IndustryPayload } from "@/lib/types";

export default function WorkbookButton({ payload, start, end }: { payload: IndustryPayload; start: string; end: string }) {
  async function download() {
    const { buildIndustryWorkbook } = await import("@/lib/workbook");
    const blob = await buildIndustryWorkbook(payload, start, end);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `IndustryScope_${payload.sector.slug}_${start}_${end}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return <button className="download-button" onClick={download}>Download Excel</button>;
}

