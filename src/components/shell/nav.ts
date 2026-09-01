import {
  FileText,
  History,
  Layers,
  Repeat,
  Settings2,
  Sun,
  Target,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  /** Libellé court du rail intermédiaire et de la barre basse. */
  short: string;
  icon: LucideIcon;
}

/**
 * Sept entrées, plates, sans accordéon. Pas d'entrée « Chat », « Agents »,
 * « Logs » ni « Analytics » : ce sont des moyens, pas des destinations.
 */
export const navItems: NavItem[] = [
  { href: "/", label: "Aujourd'hui", short: "Aujourd'hui", icon: Sun },
  { href: "/missions", label: "Missions", short: "Missions", icon: Target },
  { href: "/automatisations", label: "Automatisations", short: "Autom.", icon: Repeat },
  { href: "/projets", label: "Projets", short: "Projets", icon: Layers },
  { href: "/livrables", label: "Livrables", short: "Livrables", icon: FileText },
  { href: "/historique", label: "Historique", short: "Historique", icon: History },
  { href: "/reglages", label: "Réglages", short: "Réglages", icon: Settings2 },
];

/** Sur mobile, quatre entrées au pouce ; le reste passe dans la feuille « Plus ». */
export const mobilePrimary = navItems.slice(0, 2).concat(navItems.slice(3, 5));
export const mobileSecondary = navItems.filter(
  (item) => !mobilePrimary.includes(item),
);

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
