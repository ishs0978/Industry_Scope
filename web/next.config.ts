import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/*": ["./config/sectors.yaml", "./config/fred_map.yaml"],
    "/api/industry/[slug]": ["./config/sectors.yaml", "./config/fred_map.yaml"],
  },
};

export default nextConfig;
