import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Chaque fichier démarre son serveur et sa base PGlite : le démarrage peut être lent.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Chaque base PGlite (WebAssembly) prend beaucoup de mémoire : au-delà de deux fichiers en
    // parallèle, des processus de test s'arrêtent net quand la machine fait aussi tourner le
    // serveur, le site et VS Code.
    maxWorkers: 2,
  },
});
