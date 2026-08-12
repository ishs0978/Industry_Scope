import HomeExplorer from "@/components/HomeExplorer";
import { getHomePerformance } from "@/lib/data";
import { sectors } from "@/lib/registry";

export const revalidate = 86400;

export default async function HomePage() {
  return <HomeExplorer sectors={sectors()} performance={await getHomePerformance()} />;
}

