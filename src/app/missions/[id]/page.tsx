import { MissionDetail } from "@/components/mission/MissionDetail";

export const metadata = {
  title: "Mission",
};

export default async function MissionPage({ params }: PageProps<"/missions/[id]">) {
  const { id } = await params;
  return <MissionDetail missionId={id} />;
}
