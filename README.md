# br.ia — serveur

Serveur de br.ia : API HTTP, connexions WebSocket avec les extensions, agents IA et base de données.

La vision, le cahier des charges et la charte des interfaces sont dans [`docs/`](docs/).

## Démarrer en local

Prérequis : Node.js 22 ou plus. Aucune installation de PostgreSQL n'est nécessaire : en local, la base tourne avec PGlite, dans `.data/`.

```sh
npm install
cp .env.example .env
npm run dev
```

Le serveur écoute sur `http://127.0.0.1:4000`. Vérification : `http://127.0.0.1:4000/health`.

## Commandes

| Commande                         | Rôle                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                    | Serveur en développement, relancé à chaque modification           |
| `npm run build` puis `npm start` | Version construite, dans `dist/`                                  |
| `npm test`                       | Tests                                                             |
| `npm run typecheck`              | Vérification des types                                            |
| `npm run check`                  | Vérification du style (Biome) ; `npm run format` corrige          |
| `npm run db:generate`            | Génère une migration après une modification de `src/db/schema.ts` |

## Organisation

| Dossier              | Contenu                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/`               | Le serveur : `app.ts` (routes), `ws/` (connexions des extensions), `db/` (schéma et accès à la base) |
| `packages/protocol/` | Le protocole partagé avec l'extension et le site (`@br-ia/protocol`)                                 |
| `drizzle/`           | Migrations de la base, appliquées au démarrage                                                       |
| `test/`              | Tests                                                                                                |
| `docs/`              | Documents du projet                                                                                  |
