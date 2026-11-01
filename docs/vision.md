# \<br\>.ia — Document de vision

_Version 1, 31 octobre 2026. Auteur : Dominique Bria._

## En une phrase

\<br\>.ia est un chat d'équipe autour d'un projet, dans lequel l'IA est à la fois le chef d'orchestre, qui écoute, note et arbitre, et la main-d'œuvre, qui produit le code et les documents demandés.

## Le problème

Les IA actuelles travaillent en tête-à-tête : une personne, une conversation. Dès qu'une équipe travaille sur un même projet, chacun a sa propre conversation, ses propres demandes et sa propre version du projet. Les décisions se perdent, les demandes se contredisent, et personne n'a une vue d'ensemble.

Les outils de groupe qui existent (discussions de groupe de ChatGPT, Mantle Chat, Cotera, MeshAgent) font de l'IA un participant de plus, qui répond quand on l'appelle. Aucun ne lui confie le rôle de chef d'orchestre du projet, et aucun ne la fait travailler directement sur les machines de l'équipe.

## Pour qui

- Les équipes en entreprise qui travaillent sur un même projet.
- Les étudiants en projet de groupe.
- Les freelances qui s'associent sur un projet.
- Une personne seule qui porte toutes les casquettes.

\<br\>.ia ne gère pas de relation client-prestataire : tout le monde travaille dans la même équipe.

## Le concept : un serveur et un cuisinier

\<br\>.ia repose sur deux agents, comme dans un restaurant.

|               | Agent serveur (en salle)                                                          | Agent cuisinier (en cuisine)                           |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Rôle          | Écoute, reconnaît chaque membre, note, synthétise, arbitre, propose des compromis | Produit les livrables : code et documents              |
| Disponibilité | Toujours disponible, ne bloque jamais                                             | Travaille en arrière-plan, parfois longtemps           |
| Lien          | Prend les commandes et les passe en cuisine                                       | Rend le travail au serveur, qui le présente à l'équipe |

Le serveur reste ainsi libre de répondre pendant que le cuisinier construit.

### Savoir quand intervenir

Les membres se parlent aussi entre eux. Le serveur ne répond donc pas à chaque message. Il classe chacun d'eux :

- **une discussion entre collègues** : il se tait, mais il note ;
- **une question qui lui est adressée**, clairement ou à demi-mot : il répond ;
- **une décision prise** : il l'enregistre ;
- **une contradiction entre deux membres** : il la signale et propose un compromis ;
- **une demande de livrable** : il passe la commande en cuisine.

C'est ce qui distingue \<br\>.ia d'une IA de groupe qui ne parle que quand on l'appelle.

## L'équipe

- **Un chef et des collaborateurs.** Il n'y a pas d'observateurs : tout le monde participe.
- **N'importe quel membre peut passer commande** au serveur.
- **Le chef peut stopper** la décision de n'importe qui si elle ne lui convient pas.
- **Les compromis** se règlent de deux façons : le chef tranche, ou les membres concernés trouvent un terrain d'entente et le disent au serveur, sans passer par le chef.
- La collaboration se fait **en direct et en différé**.

## La cuisine itinérante

Le cuisinier ne travaille pas sur les serveurs de \<br\>.ia. Il travaille sur les machines des membres, grâce à l'extension VS Code. La plateforme ne garde que le léger (conversations, notes, décisions, état des tâches), ce qui limite fortement les coûts d'hébergement.

### Le cycle de travail

1. L'équipe installe l'application GitHub de \<br\>.ia sur son dépôt et le branche dans le chat. Les accès se règlent dépôt par dépôt, sans compte partagé.
2. Le cuisinier travaille par défaut sur la machine du membre qui a passé la commande, s'il est connecté, par exemple Ali. Il lit et écrit les fichiers et lance les commandes.
3. À la fin de chaque tâche testée, il pousse sur GitHub, selon les accès qu'Ali lui a donnés ou à sa demande.
4. Les autres membres reçoivent une notification : « Nouvelle version disponible, la récupérer ? » S'ils acceptent, le cuisinier lance la récupération sur leur machine, après avoir vérifié qu'ils n'ont pas de travail en cours non enregistré.
5. Si la tâche passe sur la machine de Fatou, le cuisinier récupère le dépôt, installe les dépendances et continue.

### Les règles du relais

- **Pousser à la fin de chaque tâche testée**, pour ne rien perdre. Si une machine perd son travail en cours, le cuisinier recommence la tâche à partir de la conversation, qui est gardée sur le serveur.
- **Vérifier l'environnement** avant de reprendre sur une nouvelle machine (système d'exploitation, versions de Node, Python, etc.) et l'adapter avec l'accord du propriétaire.
- **Rester dans le dossier du projet**, sauf si le propriétaire de la machine demande autre chose (par exemple déplacer des fichiers du disque C: vers le disque D:).
- **Si aucune machine n'est disponible**, la commande est mise en attente et l'équipe est prévenue.

## L'extension VS Code

VS Code est le client principal de \<br\>.ia. Tout s'y fait : création de compte, chat, conversations, notifications. Un membre n'a pas besoin d'aller sur le site.

L'extension sera aussi publiée sur Open VSX, pour fonctionner dans Cursor et Windsurf.

### Les modes de permission

Chaque membre choisit ce que le cuisinier peut faire sur sa machine, comme dans l'extension Claude :

| Mode             | Fichiers                          | Commandes                                   | Push                          |
| ---------------- | --------------------------------- | ------------------------------------------- | ----------------------------- |
| **Manuel**       | demande                           | demande                                     | demande                       |
| **Édition auto** | automatique                       | demande                                     | demande                       |
| **Auto**         | automatique                       | automatique, sauf les commandes dangereuses | selon la préférence du membre |
| **Plan**         | ne touche à rien, propose un plan | —                                           | —                             |

Le chef peut stopper une décision, mais il ne peut pas forcer l'accès à la machine d'un membre.

### La mémoire locale

Les préférences de chaque membre se négocient dans le chat, par exemple « je fais mes push moi-même ». Elles sont enregistrées dans la mémoire de l'agent, sur la machine du membre, pour ne pas interroger la base de données à chaque fois. Une copie de sauvegarde est gardée sur le serveur, uniquement pour restaurer cette mémoire sur une nouvelle machine.

### Le coffre de secrets

Les fichiers `.env` (mots de passe, clés d'API) ne vont jamais sur GitHub. \<br\>.ia les gère ainsi :

1. Le chef dépose les secrets depuis l'extension, sous la forme nom + valeur.
2. Ils sont stockés sur le serveur avec un chiffrement simple.
3. Le chef choisit quels membres y ont accès.
4. Quand le cuisinier arrive sur une machine, l'extension écrit le `.env` en local, en vérifiant qu'il figure dans `.gitignore`.
5. **L'IA ne voit jamais la valeur des secrets.** Elle connaît leur nom, pas leur contenu. L'extension masque toute valeur secrète qui apparaîtrait dans le résultat d'une commande.
6. Un journal enregistre qui a récupéré quel secret, et quand.
7. Quand un membre quitte l'équipe, \<br\>.ia rappelle au chef de changer les clés concernées.

## Les tableaux de bord

### Le tableau de bord d'administration (équipe interne de \<br\>.ia)

Sur le site web, accessible uniquement à l'équipe interne :

- **Revenus :** abonnements actifs, revenus du mois, résiliations, essais convertis en abonnements.
- **Coûts d'IA et marge :** consommation de chaque équipe, coût réel chez chaque fournisseur, marge par formule. Des alertes signalent les équipes qui coûtent plus qu'elles ne rapportent.
- **Réglages des crédits :** la valeur du crédit et les quotas de chaque formule.
- **Codes promotionnels :** création, suivi de l'utilisation, désactivation.
- **Utilisateurs et équipes :** recherche, formule, historique de paiement, suspension d'un compte.
- **Santé de la plateforme :** extensions connectées, commandes en attente faute de machine disponible, erreurs.

La valeur des secrets des équipes n'apparaît jamais, même pour l'équipe interne.

### L'espace du chef d'équipe

Dans l'extension VS Code, avec un lien vers le site pour le paiement :

- les membres et leurs rôles ;
- les crédits consommés et restants, par membre ;
- la formule, les factures, les recharges de crédits ;
- le coffre de secrets et son journal.

## Les IA utilisées

\<br\>.ia s'appuie sur plusieurs fournisseurs : Claude, ChatGPT, Gemini, etc. Le serveur lit tous les messages : il utilise donc un modèle rapide et bon marché. Le cuisinier, qui produit, utilise un modèle plus puissant.

- **Serveur :** un modèle rapide de Claude ou de ChatGPT.
- **Cuisinier :** Claude.
- **Secours :** d'autres fournisseurs prennent le relais en cas de panne ou de quota atteint.

**Pendant la bêta, uniquement des API gratuites.** Une couche commune fait tourner plusieurs fournisseurs gratuits et bascule de l'un à l'autre quand un quota est atteint. La bêta valide le fonctionnement du produit, pas la qualité finale des modèles. Le passage à Claude se fait ensuite par un simple réglage.

| Rôle      | Fournisseurs gratuits envisagés                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| Serveur   | Google AI Studio (Gemini Flash / Flash-Lite), Groq                                     |
| Cuisinier | Mistral (Codestral), OpenRouter (Qwen3 Coder), Z.AI (GLM Flash), Cloudflare Workers AI |

Les testeurs sont prévenus que certaines offres gratuites utilisent les échanges pour entraîner leurs modèles.

## Les documents

- Les notes de l'IA (synthèses, décisions, comptes rendus) sont en Markdown. L'interface doit bien les afficher : titres, tableaux, listes de tâches, blocs de code.
- Les autres formats (Word, PDF, etc.) sont produits à la demande des utilisateurs.

## Les langues

L'interface est en français et en anglais dès la première version.

## Le modèle économique

- **Produit commercial, sur abonnement.**
- **Les appels aux IA sont inclus dans l'abonnement.** Chaque formule aura des quotas, pour qu'une équipe très active ne coûte pas plus cher qu'elle ne rapporte.
- **Le site web** sert à la présentation et au paiement. Le paiement ouvre le navigateur un instant, comme l'exigent les prestataires de paiement.
- **Le marché :** le monde entier à terme. On commence par l'Afrique francophone, avec des prix en dollars américains.

### Les crédits

La consommation d'IA se compte en crédits. Un message traité par le serveur coûte peu, une tâche du cuisinier coûte plus. Si les prix des fournisseurs d'IA changent, on ajuste la valeur du crédit sans toucher aux formules. Chaque formule doit rapporter au moins 2 à 3 fois le coût moyen en IA qu'elle génère.

### Les formules

| Formule        | Prix indicatif                    | Pour qui                                     | Contenu                                          |
| -------------- | --------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| **Essai**      | gratuit, 14 jours                 | tout nouveau compte                          | toutes les fonctions, petit quota de crédits     |
| **Solo**       | 15 $/mois                         | une personne qui porte toutes les casquettes | 1 membre, projets illimités, quota mensuel       |
| **Équipe**     | 12 $/membre/mois (2 à 15 membres) | équipes, freelances associés                 | crédits mis en commun pour toute l'équipe        |
| **Étudiant**   | –50 % sur Équipe                  | projets de groupe                            | vérification par e-mail d'école ou code promo    |
| **Entreprise** | sur devis                         | grandes équipes                              | membres illimités, factures, support prioritaire |

- **Recharges de crédits** quand le quota est épuisé, au lieu de bloquer l'équipe.
- **Paiement annuel :** 2 mois offerts.
- **Pas de formule gratuite permanente :** chaque utilisateur gratuit coûterait de l'argent en IA chaque mois. L'essai et les codes promotionnels jouent ce rôle.

### Les codes promotionnels

Ils ont une place importante dans la stratégie commerciale.

- **Ce qu'un code peut offrir :** une réduction en pourcentage ou d'un montant fixe, une formule offerte pendant une durée donnée, des crédits en bonus, un essai prolongé.
- **Durée de l'effet :** une seule fois, ou pendant X mois. L'effet « pour toujours » est réservé à l'équipe interne de \<br\>.ia.
- **Limites :** date d'expiration, nombre maximal d'utilisations, une seule utilisation par compte, réservé aux nouveaux clients, réservé à une formule.
- **Trois sortes de codes :** public pour une campagne (`LANCEMENT`), unique et généré en lot pour une école ou un partenaire, parrainage (le parrain et le filleul gagnent des crédits).
- **Saisie :** dans l'extension VS Code ou au moment du paiement sur le site.
- **Administration :** un tableau de bord pour créer les codes, suivre leur utilisation et les désactiver.
- **Garde-fou :** une formule offerte garde les mêmes quotas qu'une formule payante, et chaque code a un nombre limité d'utilisations.

## Ce qui distingue \<br\>.ia

En octobre 2026, aucun outil connu ne combine :

1. un agent qui **arbitre et propose des compromis**, pas seulement un assistant qui répond ;
2. un agent qui **travaille directement sur la machine des membres** ;
3. un **cycle GitHub complet** : travail chez un membre, push, proposition de la mise à jour à l'équipe, installation chez chacun après accord.

Le besoin est reconnu : Y Combinator demande précisément ce type de produit dans ses appels à startups de l'automne 2026. D'autres vont donc se lancer : il faut avancer vite.

## La première version

- **Livrables :** code et documents.
- **Client :** l'extension VS Code.
- **Site :** présentation et paiement.

## Les étapes

### Étape 1 — Construction

On construit tout, sauf le paiement : les agents serveur et cuisinier, l'extension VS Code, le cycle GitHub, le coffre de secrets, les crédits, les codes promotionnels, le tableau de bord d'administration et le site de présentation.

### Étape 2 — Bêta privée

On teste avec des camarades, sans paiement.

- L'accès se fait par invitation, avec des codes uniques.
- Les formules sont attribuées depuis le tableau de bord d'administration.
- Les quotas de crédits restent actifs : pendant la bêta, les coûts d'IA sont entièrement à la charge de \<br\>.ia.
- Les retours des testeurs sont recueillis directement dans l'extension.

### Étape 3 — Maintenance

On met la plateforme en maintenance pour intégrer le paiement. Le mode maintenance se pilote depuis le tableau de bord d'administration :

- **Programmer** une date de début et une durée estimée, avec un message personnalisé.
- **Prévenir** les utilisateurs à l'avance, par une notification dans l'extension et un bandeau sur le site.
- **Arrêter proprement :** les nouvelles commandes sont refusées, et les cuisiniers en cours terminent ou poussent leur travail sur GitHub avant l'arrêt.
- **Pendant la maintenance :** l'extension et le site affichent le message. Les conversations, les notes et les dépôts restent intacts.
- **Liste d'exceptions :** l'équipe interne et quelques testeurs choisis gardent l'accès, pour tester le paiement avant la réouverture.
- **Réouvrir** d'un clic, avec une notification aux utilisateurs.

### Étape 4 — Paiement et lancement

On intègre le paiement, puis on ouvre \<br\>.ia au public.

## Questions ouvertes pour le cahier des charges

1. **Les technologies :** langage et framework du serveur, base de données, temps réel (WebSocket).
2. **Le paiement (étape 4) :** quels prestataires (cartes et mobile money), selon le pays où l'entreprise est immatriculée. Faut-il des prix adaptés à chaque région ?
3. **Les modèles exacts** du serveur et du cuisinier, et la chaîne de secours.
4. **L'hébergement :** des offres gratuites pendant la bêta (GitHub Student Pack, 100 $ de crédit Azure, Backblaze B2 pour les fichiers), puis une bascule vers des offres payantes au lancement. Les avantages étudiants sont réservés à un usage non commercial. Pendant la bêta, uniquement des services qui n'exigent pas de carte bancaire : le serveur sur Azure for Students, la base de données sur Neon, le site sur Vercel, les e-mails avec Resend, le suivi des erreurs avec Sentry et les fichiers sur Backblaze B2.
