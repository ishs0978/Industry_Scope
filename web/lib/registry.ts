import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Sector } from "./types";

let cached: Sector[] | null = null;

export function sectors(): Sector[] {
  if (cached) return cached;
  const registryPath = path.resolve(process.cwd(), "..", "ingest", "config", "sectors.yaml");
  const document = YAML.parse(fs.readFileSync(registryPath, "utf8")) as { sectors: Sector[] };
  cached = document.sectors;
  return cached;
}

export function sectorBySlug(slug: string): Sector | undefined {
  return sectors().find((sector) => sector.slug === slug);
}

