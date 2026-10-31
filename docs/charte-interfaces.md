# br.ia — Charte des interfaces

_Version 1, 31 octobre 2026._

Cette charte fixe la façon de concevoir les trois interfaces de br.ia : l'**extension VS Code** (l'interface client), le **tableau de bord d'administration** et le **site de présentation**.

Deux règles de départ, posées par Dominique :

- **de vraies icônes, pas de stickers ni d'emoji** dans l'interface ;
- **pas de « style IA »**, c'est-à-dire pas les motifs visuels que les générateurs d'interfaces produisent par défaut.

Elle s'appuie sur les recommandations officielles de VS Code et sur des analyses des défauts typiques des interfaces générées par IA (sources en fin de document).

---

## 1. Principes communs

### 1.1 Ce qu'on s'interdit

| Motif à éviter                                                                                | Pourquoi                                                                         | À la place                                                                              |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Emoji, stickers, étincelles (✨) pour signaler l'IA                                           | Décoratif, ne dit rien                                                           | De vraies icônes (Codicons, Lucide) et des libellés clairs : « serveur », « cuisinier » |
| Violet par défaut, dégradés violet-bleu                                                       | Couleur par défaut de nombreux outils, donc signature de l'IA                    | Une couleur de marque choisie volontairement (voir 1.2)                                 |
| Dégradés et halos décoratifs, effet verre dépoli                                              | Un effet partout ne signale plus rien                                            | Aucun effet ; à la rigueur un seul accent, à un seul endroit                            |
| Bordure épaisse et colorée sur un côté d'une carte arrondie                                   | Décrite comme la signature la plus reconnaissable des interfaces générées par IA | Une bordure fine et uniforme, ou pas de bordure                                         |
| Coins très arrondis partout                                                                   | Tout se ressemble                                                                | Une petite échelle d'arrondis (voir 1.2)                                                |
| Tout en cartes, toutes du même poids                                                          | Pas de hiérarchie                                                                | Un élément principal par écran, le reste en listes denses                               |
| Petits titres en majuscules très espacées                                                     | Gêne la lecture                                                                  | Des titres en casse normale                                                             |
| Badges « Live » ou « Nouveau » qui clignotent                                                 | « De la décoration déguisée en information »                                     | Un badge seulement quand l'information est vraie et utile                               |
| Ombres fortes, réglages par défaut d'un kit                                                   | Bruit visuel                                                                     | Une seule ombre légère, pour ce qui flotte (menus, fenêtres)                            |
| Illustrations « plastiques » générées, photos d'ordinateurs                                   | Impersonnel                                                                      | De vraies captures du produit, avec de vraies données                                   |
| Textes creux : « Bienvenue ! », « Libérez la puissance de l'IA », « Une erreur est survenue » | Ne dit rien                                                                      | Nommer l'objet, dire ce qui se passe, proposer la suite                                 |
| Apparitions en fondu sur tout                                                                 | Animation sans raison                                                            | Une animation seulement pour un changement d'état                                       |

### 1.2 Les fondations

On décide ces valeurs **avant** de dessiner un écran, et on ne les change pas écran par écran.

- **Couleur de marque :** une seule, choisie volontairement et **pas violette**. Elle sert aux actions principales et aux liens, nulle part ailleurs. Proposition à valider : un rouge brique, en clin d'œil à la cuisine (`oklch(58% 0.15 35)`).
- **Couleurs d'état :** succès, avertissement, erreur, information. Elles servent uniquement à signaler un état.
- **Gris :** une échelle de gris neutres pour le texte, les bordures et les fonds.
- **Arrondis :** 4 px pour les champs et les boutons, 6 px pour les panneaux. La forme de pilule est réservée aux étiquettes.
- **Espacements :** une échelle de 4 px (4, 8, 12, 16, 24, 32, 48). On serre à l'intérieur d'un groupe et on aère entre les groupes.
- **Typographie :** deux familles au maximum, une pour le texte et une à chasse fixe pour le code, les identifiants et les chiffres alignés. Pas d'Inter par défaut. Proposition à valider : IBM Plex Sans et IBM Plex Mono (sobres, techniques, bons accents français). L'extension, elle, utilise les polices de VS Code (voir 2.2).
- **Icônes :** un seul jeu, au trait, sans couleur. Codicons dans l'extension ; Lucide sur le site et le tableau de bord.
- **Thèmes :** clair et sombre, testés tous les deux.

### 1.3 Chaque écran

- **Une seule action principale**, nettement visible. Les autres sont secondaires et discrètes.
- **Les quatre états prévus :** vide (il explique quoi faire ensuite), chargement (un squelette qui annonce le contenu, pas une roue qui tourne), erreur (elle dit ce qui s'est passé et comment réparer), contenu.
- **Du vrai contenu** pendant la conception, jamais de « Lorem ipsum ».
- **Accessibilité :** contraste suffisant, navigation complète au clavier, focus visible, libellés pour les lecteurs d'écran, respect de la préférence « réduire les animations ».
- **Français et anglais :** les textes ne sont jamais écrits en dur ; prévoir que l'anglais est plus court et le français plus long.

### 1.4 Les textes

- Nommer les choses par leur nom : « Commande n° 12 : page de connexion », pas « Votre tâche ».
- Dire ce qui se passe et ce que la personne peut faire : « Aucune machine disponible. La commande démarrera quand Ali ou Fatou se connectera. »
- Le serveur et le cuisinier s'expriment comme un collègue, sans enthousiasme forcé ni points d'exclamation.
- Pas de jargon marketing.

### 1.5 Comment vérifier

Avant de valider un écran :

1. **Le test du plissement d'yeux :** en plissant les yeux, voit-on immédiatement l'élément principal ?
2. **Le test des composants par défaut :** reconnaît-on un kit d'interface non retouché ?
3. **Le test des états :** les états vide, chargement et erreur existent-ils ?
4. **Le test des textes :** chaque bouton dit-il précisément ce qu'il fait ?
5. **Le test de la liste ci-dessus :** aucun motif de la section 1.1 n'est présent.

---

## 2. L'extension VS Code (interface client)

L'objectif : que br.ia ait l'air **d'une partie de VS Code**, pas d'un site web collé dans l'éditeur.

### 2.1 Natif d'abord

Les recommandations officielles de VS Code demandent de n'utiliser une webview que lorsque c'est vraiment nécessaire, car elles sont coûteuses en ressources.

| Élément                                             | Composant VS Code                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Liste des équipes et des projets                    | Vue arborescente native (_Tree View_)                                             |
| Liste des commandes et leur statut                  | Vue arborescente native                                                           |
| Mémoire du projet                                   | Vue arborescente native, chaque élément ouvre un document Markdown en lecture     |
| **Le chat**                                         | **Webview dans la barre latérale (_Webview View_)**, la seule vraiment nécessaire |
| Vue avant/après d'une modification                  | L'éditeur de différences natif de VS Code                                         |
| Coffre de secrets, espace du chef                   | Webview, ouverte à la demande                                                     |
| Prise en main                                       | Guide de démarrage natif (_Walkthrough_), pas une page d'accueil sur mesure       |
| Connexion, mode de permission, cuisinier au travail | Un seul élément dans la barre d'état                                              |

**Barre latérale :** un seul conteneur br.ia, et pas plus de trois à cinq vues dedans.

### 2.2 Thème et polices

- **Aucune couleur écrite en dur.** Toutes les couleurs viennent des variables du thème actif (`var(--vscode-editor-foreground)`, `var(--vscode-button-background)`, etc.), avec une valeur de repli.
- La webview s'adapte aux classes `vscode-light`, `vscode-dark` et `vscode-high-contrast`. **Elle est testée en contraste élevé.**
- Le texte utilise la police de l'interface de VS Code ; le code utilise la police de l'éditeur (`--vscode-editor-font-family`, `--vscode-editor-font-size`).
- Les icônes viennent des Codicons, qui sont celles de VS Code.
- La couleur de marque de br.ia n'apparaît **pas** dans l'extension : on respecte le thème de l'utilisateur.

### 2.3 Le chat

- **Lecture d'abord :** des messages denses, avec un en-tête discret (nom de l'auteur et heure) et du texte à pleine largeur. Pas de bulles colorées façon messagerie mobile.
- **Distinguer les auteurs sans décor :** les membres par leur nom ; le serveur et le cuisinier par une étiquette texte (`serveur`, `cuisinier`) et une teinte de fond très légère tirée du thème. Pas d'avatar animé ni d'étincelle.
- **Silence du serveur visible :** quand il enregistre une décision sans répondre, une petite icône apparaît sur le message, avec une infobulle « Décision notée ».
- **Le Markdown** suit le rendu de VS Code : même coloration du code, mêmes tableaux.
- **Le travail du cuisinier** apparaît comme une suite d'étapes repliables : fichiers lus, fichiers modifiés (un clic ouvre la vue avant/après native), commandes lancées avec leur sortie, tests. Le résumé reste visible, le détail se déplie.
- **Le bouton « Stopper »** reste visible tant que le cuisinier travaille.
- **La zone de saisie** se trouve en bas, avec l'autocomplétion des mentions (`@Ali`, `@bria`).

### 2.4 Notifications

Les règles officielles de VS Code :

- n'envoyer une notification que lorsqu'elle est vraiment nécessaire, une seule à la fois ;
- regrouper plusieurs notifications en une seule ;
- proposer « Ne plus afficher » ;
- ne jamais l'utiliser pour de la promotion, ni pour demander un avis juste après l'installation ;
- pour une progression peu importante, utiliser la barre d'état plutôt qu'une notification ;
- les fenêtres modales sont réservées aux actions qui exigent une réponse immédiate : chez nous, la confirmation d'une commande dangereuse.

**Ce qui mérite une notification dans br.ia :** une mention, une commande terminée ou échouée, une nouvelle version à récupérer, une maintenance annoncée, un quota à 80 %. Rien d'autre.

### 2.5 Barre d'état

Un seul élément br.ia, à gauche : un texte court (`br.ia : connecté`, `br.ia : cuisinier au travail`) avec une icône seulement si elle est claire. Pas de couleur personnalisée. Un clic ouvre le panneau.

### 2.6 Accessibilité

- Navigation complète au clavier dans la webview ; F6 permet de passer de la webview au reste de l'éditeur.
- Libellés ARIA sur tous les boutons d'icône.
- Respect des classes « lecteur d'écran » et « réduire les animations » ajoutées par VS Code.

---

## 3. Le tableau de bord d'administration

L'objectif : un outil de travail **dense et calme**, pour trouver une information et agir vite.

### 3.1 Structure

- **Navigation latérale fixe**, courte : Utilisateurs et équipes, Coûts d'IA, Codes, Réglages, Santé, Retours, Maintenance.
- **Disposition liste et détail :** une liste filtrable à gauche ou en pleine page ; le détail s'ouvre à côté ou sur sa propre page. C'est le cœur du tableau de bord.
- **Pas de mur de cartes chiffrées.** La page d'accueil montre ce qui demande une action (équipes qui coûtent trop cher, commandes bloquées, erreurs, retours non traités), puis quelques chiffres clés en une seule ligne.

### 3.2 Tableaux

- Lignes compactes (environ 36 px), avec un réglage de densité « compact / confortable ».
- Chiffres alignés à droite, en chiffres à largeur fixe (`tabular-nums`) ; identifiants et codes en police à chasse fixe.
- Tri, filtres et recherche sur chaque liste ; filtres reflétés dans l'adresse de la page, pour pouvoir partager une vue.
- Statuts en texte avec une pastille de couleur d'état, jamais la couleur seule.
- Actions sur une ligne dans un menu en fin de ligne ; actions groupées quand plusieurs lignes sont cochées.

### 3.3 Graphiques

- Peu de graphiques, et seulement quand ils répondent à une question (par exemple : « quel fournisseur consomme le plus ce mois-ci ? »).
- Des axes lisibles, une seule couleur par série, pas de graphique en camembert pour plus de trois valeurs.

### 3.4 Actions sensibles

Suspendre un compte, désactiver un code, lancer une maintenance : une confirmation qui **rappelle les conséquences** (« 3 équipes utilisent ce code ; elles garderont leur formule jusqu'au 30 novembre »). Chaque action est enregistrée dans un journal.

### 3.5 Outils

Next.js, avec des composants accessibles et non stylés à la base (par exemple shadcn/ui, entièrement retravaillés selon la section 1.2, pas laissés tels quels) et TanStack Table pour les tableaux.

---

## 4. Le site de présentation

L'objectif : comprendre en quelques secondes **ce que fait br.ia**, le voir fonctionner, et demander une invitation.

### 4.1 Contenu

1. **En-tête :** une phrase qui dit précisément ce que fait le produit, par exemple : « Un chat d'équipe où l'IA note vos décisions, arbitre vos désaccords et écrit le code sur vos machines. » En dessous, une **vraie capture de l'extension** (ou une courte vidéo en boucle) et un seul bouton : « Demander une invitation ».
2. **Comment ça marche :** le serveur et le cuisinier, illustrés par de vraies captures du chat.
3. **La cuisine itinérante :** un schéma simple du passage d'une machine à l'autre via GitHub.
4. **Vos secrets restent les vôtres :** l'IA ne voit jamais les valeurs ; chaque membre contrôle sa machine.
5. **Pour qui :** équipes, étudiants, freelances, personne seule.
6. **Questions fréquentes.**
7. **Pied de page :** liens vers l'extension, les pages légales, le choix de la langue.

Les formules et les prix s'ajouteront à l'étape 4, avec le paiement.

### 4.2 Style

- **Montrer le produit**, pas des illustrations abstraites.
- Un ton direct et précis, sans formules commerciales.
- Beaucoup d'espace, une seule couleur d'accent, une typographie soignée.
- Thèmes clair et sombre.
- Page légère : rapide à charger, y compris sur une connexion mobile modeste (notre premier marché est l'Afrique francophone).

---

## Sources

- [VS Code — Recommandations d'interface : vue d'ensemble](https://code.visualstudio.com/api/ux-guidelines/overview)
- [VS Code — Webviews](https://code.visualstudio.com/api/ux-guidelines/webviews)
- [VS Code — Barres latérales](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- [VS Code — Guide des webviews (thèmes)](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code — Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications)
- [VS Code — Barre d'état](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- [VS Code — Guides de démarrage](https://code.visualstudio.com/api/ux-guidelines/walkthroughs)
- [VS Code — Menus contextuels](https://code.visualstudio.com/api/ux-guidelines/context-menus)
- [VS Code — Accessibilité](https://code.visualstudio.com/docs/configure/accessibility/accessibility)
- [Noqta — Les motifs d'interface trop utilisés par l'IA (juin 2026)](https://noqta.tn/en/blog/ai-design-slop-overused-ui-patterns-fix-2026)
- [SaaS UI — Pourquoi une interface SaaS a l'air générée par IA (juin 2026)](https://www.saasui.design/blog/saas-ui-looks-ai-generated)
- [Superdesign — Rendre une interface générée moins générique](https://www.superdesign.dev/blog/how-to-make-ai-ui-look-less-generic)
- [Setproduct — Guide des tableaux de données 2026](https://www.setproduct.com/blog/data-table-ui-design)
- [AdminLTE — Conception de tableaux de bord d'administration (2026)](https://adminlte.io/blog/admin-dashboard-design/)
