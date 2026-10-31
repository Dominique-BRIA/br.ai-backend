import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Chaque fichier démarre son serveur et sa base PGlite : le démarrage peut être lent.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
