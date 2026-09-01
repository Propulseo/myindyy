import { ProjectDetail } from "@/components/project/ProjectDetail";

export const metadata = {
  title: "Projet",
};

export default async function ProjectPage({ params }: PageProps<"/projets/[id]">) {
  const { id } = await params;
  return <ProjectDetail projectId={id} />;
}
