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
| `npm run dev`                    | Serveur en développement (à relancer après une modification)      |
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

## Comptes en développement

- Le code d'invitation `BETA-DEV` est créé au démarrage, pour 100 comptes.
- Sans clé Resend, les e-mails ne partent pas : le code de connexion est écrit dans le journal du serveur.
- Pour envoyer de vrais e-mails, ajouter `RESEND_API_KEY` (et `MAIL_FROM`) dans `.env`.
- Pour créer d'autres codes d'invitation, définir `ADMIN_TOKEN` dans `.env`, puis :

  ```sh
  curl -X POST http://127.0.0.1:4000/admin/beta-invites \
    -H "x-admin-token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \
    -d '{"maxUses": 5, "note": "camarades"}'
  ```
