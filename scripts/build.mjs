// Construit le serveur dans dist/. Les dépendances npm restent externes,
// sauf les paquets @br-ia/* (sources TypeScript) qui sont intégrés au bundle.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  plugins: [
    {
      name: "externaliser-dependances",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith("@br-ia/") ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
