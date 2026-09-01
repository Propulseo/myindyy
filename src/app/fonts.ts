/**
 * Trois rôles typographiques, trois familles. Toutes sous SIL Open Font License 1.1,
 * chargées et auto-hébergées au build par `next/font/google` (aucun appel réseau à l'exécution).
 *
 * - Fraunces        : serif expressive, réservée aux titres et aux chiffres de tête.
 * - Hanken Grotesk  : sans-serif d'interface, très lisible en corps de texte dense.
 * - JetBrains Mono  : monospace pour statuts, durées, budgets et références techniques.
 */
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";

export const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

export const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const fontVariables = [fraunces, hanken, jetbrainsMono]
  .map((font) => font.variable)
  .join(" ");
