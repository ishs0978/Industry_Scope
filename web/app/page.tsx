import HomeExplorer from "@/components/HomeExplorer";
import { getHomePerformance } from "@/lib/data";
import { sectors } from "@/lib/registry";

// Ingest runs daily at 06:00 America/New_York. A 24-hour window let the home
// page serve numbers up to a full day behind the database.
export const revalidate = 3600;

export default async function HomePage() {
  return <HomeExplorer sectors={sectors()} performance={await getHomePerformance()} />;
}

