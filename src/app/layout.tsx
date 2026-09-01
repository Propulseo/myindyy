import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/shell/AppShell";
import { SensitiveActionProvider } from "@/components/decision/SensitiveAction";
import { CockpitProvider } from "@/lib/cockpit";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Indy — cockpit Propul'SEO",
    template: "%s · Indy",
  },
  description:
    "Cockpit interne Propul'SEO : suivre et contrôler les missions confiées aux agents.",
};

export const viewport: Viewport = {
  themeColor: "#0b0c10",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={fontVariables}>
      <body>
        <CockpitProvider>
          <SensitiveActionProvider>
            <AppShell>{children}</AppShell>
          </SensitiveActionProvider>
        </CockpitProvider>
      </body>
    </html>
  );
}
