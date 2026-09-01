import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Les tests portent sur la logique du cockpit — permissions, sélecteurs, règles de
 * décision — qui vit entièrement dans des modules purs. Aucun composant n'est monté :
 * il n'y a donc ni jsdom, ni bibliothèque de rendu à installer.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
