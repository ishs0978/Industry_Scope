import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(process.cwd(), ".."),
  outputFileTracingIncludes: {
    "/*": ["../ingest/config/sectors.yaml", "../ingest/config/fred_map.yaml"],
    "/api/industry/[slug]": ["../ingest/config/sectors.yaml", "../ingest/config/fred_map.yaml"],
  },
};

export default nextConfig;

