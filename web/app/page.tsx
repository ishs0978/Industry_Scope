import HomeExplorer from "@/components/HomeExplorer";
import { getHomePerformance } from "@/lib/data";
import { sectors } from "@/lib/registry";

// Ingest runs daily at 06:00 America/New_York. A 24-hour window let the home
// page serve numbers up to a full day behind the database.
export const revalidate = 3600;

export default async function HomePage() {
  const { performance, pricesThrough, lastChecked } = await getHomePerformance();
  return <HomeExplorer sectors={sectors()} performance={performance} pricesThrough={pricesThrough} lastChecked={lastChecked} />;
}

