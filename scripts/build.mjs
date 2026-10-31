// Construit le serveur dans dist/. Les dépendances npm restent externes,
// sauf les paquets @br-ia/* (sources TypeScript) qui sont intégrés au bundle.
// Voir scripts/esbuild.mjs pour la façon dont esbuild est lancé.
import { readFileSync } from "node:fs";
import { esbuild } from "./esbuild.mjs";

const { dependencies } = JSON.parse(readFileSync("package.json", "utf8"));
const externals = Object.keys(dependencies)
  .filter((name) => !name.startsWith("@br-ia/"))
  .map((name) => `--external:${name}`);

await esbuild([
  "src/index.ts",
  "--outfile=dist/index.js",
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--sourcemap",
  "--log-level=warning",
  ...externals,
]);
