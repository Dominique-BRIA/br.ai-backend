# \<br/\> — Cahier des charges

_Version 1, 31 octobre 2026. Auteur : Dominique Bria._

Ce document décrit ce que \<br/\> doit faire pour la **bêta privée** (étapes 1 et 2 du [document de vision](vision.md)) : tout sauf le paiement. Le contexte, le concept et le modèle économique sont dans le document de vision. Ici, on décrit ce qu'il faut construire.

Chaque exigence porte un identifiant (`F-CPT-01`, etc.) et une priorité :

- **Bêta** : obligatoire pour lancer la bêta ;
- **Plus tard** : prévu, mais hors bêta.

---

## 1. Acteurs

| Acteur              | Description                                                                             |
| ------------------- | --------------------------------------------------------------------------------------- |
| **Visiteur**        | Consulte le site de présentation.                                                       |
| **Membre**          | Personne inscrite, membre d'une ou plusieurs équipes.                                   |
| **Chef d'équipe**   | Membre qui dirige une équipe. Il y en a un seul par équipe.                             |
| **Administrateur**  | Membre de l'équipe interne de \<br/\>. Il accède au tableau de bord d'administration. |
| **Agent serveur**   | Agent IA qui écoute le chat, note, synthétise, arbitre et passe les commandes.          |
| **Agent cuisinier** | Agent IA qui produit les livrables sur la machine d'un membre.                          |

## 2. Vocabulaire

| Terme                 | Sens                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Équipe**            | Groupe de membres avec un chef. Elle porte la formule et les crédits. Une personne seule forme une équipe d'un membre. |
| **Projet**            | Un sujet de travail d'une équipe : un chat, une mémoire, un dépôt GitHub. Tous les membres de l'équipe y ont accès.    |
| **Commande**          | Demande de livrable transmise par le serveur au cuisinier.                                                             |
| **Machine**           | Un poste où l'extension VS Code est installée et connectée.                                                            |
| **Prêt de machine**   | Le réglage par lequel un membre autorise le cuisinier à travailler chez lui pour les commandes des autres.             |
| **Relais**            | Le passage d'une commande d'une machine à une autre.                                                                   |
| **Note de reprise**   | Le résumé laissé par le cuisinier pour qu'une autre machine reprenne le travail.                                       |
| **Mémoire du projet** | Les décisions, questions ouvertes, tâches et compromis notés par le serveur.                                           |
| **Mémoire locale**    | Les préférences d'un membre, enregistrées sur sa machine.                                                              |
| **Crédit**            | L'unité de consommation d'IA.                                                                                          |

---

## 3. Exigences fonctionnelles

### 3.1 Comptes et connexion

| ID       | Exigence                                                                                                                              | Priorité  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| F-CPT-01 | Créer un compte depuis l'extension VS Code avec une adresse e-mail et un code de vérification envoyé par e-mail. Pas de mot de passe. | Bêta      |
| F-CPT-02 | Se connecter de la même façon. La session reste ouverte sur la machine jusqu'à déconnexion.                                           | Bêta      |
| F-CPT-03 | Pendant la bêta, l'inscription n'est possible qu'avec un code d'invitation.                                                           | Bêta      |
| F-CPT-04 | Profil : nom affiché, langue (français ou anglais), photo facultative.                                                                | Bêta      |
| F-CPT-05 | Déconnecter une machine à distance depuis une autre.                                                                                  | Bêta      |
| F-CPT-06 | Supprimer son compte. Ses messages restent dans les projets, signés « ancien membre ».                                                | Bêta      |
| F-CPT-07 | Connexion avec GitHub.                                                                                                                | Plus tard |

### 3.2 Équipes et projets

| ID       | Exigence                                                                                                                      | Priorité |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-EQP-01 | Créer une équipe. Son créateur en devient le chef.                                                                            | Bêta     |
| F-EQP-02 | Le chef invite des membres par lien ou par e-mail.                                                                            | Bêta     |
| F-EQP-03 | Le chef retire un membre. \<br/\> lui rappelle alors de changer les secrets auxquels ce membre avait accès (voir F-SEC-08). | Bêta     |
| F-EQP-04 | Le chef transmet son rôle à un autre membre.                                                                                  | Bêta     |
| F-EQP-05 | Un membre quitte une équipe. Le chef ne peut pas partir sans avoir transmis son rôle.                                         | Bêta     |
| F-EQP-06 | Créer, renommer et archiver des projets dans une équipe.                                                                      | Bêta     |
| F-EQP-07 | Le nombre de membres et de projets respecte les limites de la formule de l'équipe.                                            | Bêta     |

### 3.3 Le chat

| ID       | Exigence                                                                                                               | Priorité  |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| F-CHT-01 | Un chat par projet, en temps réel. Les messages reçus pendant une absence sont disponibles au retour.                  | Bêta      |
| F-CHT-02 | Chaque message est signé par son auteur (membre, serveur ou cuisinier) et horodaté.                                    | Bêta      |
| F-CHT-03 | Affichage Markdown complet : titres, listes, listes de tâches, tableaux, code coloré, diagrammes Mermaid, liens.       | Bêta      |
| F-CHT-04 | Répondre à un message précis (fil de réponse).                                                                         | Bêta      |
| F-CHT-05 | Mentionner un membre (`@Ali`) ou l'IA (`@bria`). Une mention de l'IA déclenche toujours une réponse du serveur.        | Bêta      |
| F-CHT-06 | Joindre des fichiers (images, PDF, documents). Ils sont stockés sur Backblaze B2. Taille maximale : 20 Mo par fichier. | Bêta      |
| F-CHT-07 | Voir qui est en ligne et quelles machines sont disponibles.                                                            | Bêta      |
| F-CHT-08 | Notifications VS Code pour les mentions, les commandes terminées et les mises à jour disponibles.                      | Bêta      |
| F-CHT-09 | Rechercher dans l'historique du chat.                                                                                  | Plus tard |
| F-CHT-10 | Modifier ou supprimer son message pendant 5 minutes. Le serveur tient compte de la modification.                       | Plus tard |

### 3.4 L'agent serveur

**Savoir quand intervenir**

| ID       | Exigence                                                                                                                                                               | Priorité  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| F-SRV-01 | Le serveur classe chaque message dans l'une de ces catégories : discussion entre membres, question qui lui est adressée, décision, contradiction, demande de livrable. | Bêta      |
| F-SRV-02 | **Discussion entre membres** : il ne répond pas, mais il met à jour la mémoire du projet si besoin.                                                                    | Bêta      |
| F-SRV-03 | **Question qui lui est adressée**, explicitement (`@bria`) ou implicitement : il répond dans le chat.                                                                  | Bêta      |
| F-SRV-04 | **Décision** : il l'enregistre dans la mémoire du projet et le signale discrètement (par exemple une icône sur le message).                                            | Bêta      |
| F-SRV-05 | **Contradiction** entre deux membres ou avec une décision passée : il la signale et propose un compromis.                                                              | Bêta      |
| F-SRV-06 | **Demande de livrable** : il reformule la commande, demande les précisions qui manquent, puis la passe en cuisine.                                                     | Bêta      |
| F-SRV-07 | Le serveur ne bloque jamais : il répond pendant que le cuisinier travaille.                                                                                            | Bêta      |
| F-SRV-08 | Un membre peut dire au serveur « tais-toi » ou « tu peux intervenir plus » ; ce niveau d'intervention est réglable par projet.                                         | Plus tard |

**Mémoire et synthèse**

| ID       | Exigence                                                                                                                                                                    | Priorité |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-SRV-10 | La mémoire du projet contient : les décisions, les questions ouvertes, les tâches et les compromis. Chaque élément indique qui l'a proposé, quand, et le message d'origine. | Bêta     |
| F-SRV-11 | La mémoire du projet est consultable dans un onglet de l'extension, en Markdown.                                                                                            | Bêta     |
| F-SRV-12 | Résumé « pendant ton absence » quand un membre revient après plusieurs heures.                                                                                              | Bêta     |
| F-SRV-13 | Synthèse à la demande (« fais le point sur le projet »).                                                                                                                    | Bêta     |
| F-SRV-14 | Le serveur reconnaît chaque membre et tient compte de son rôle et de ses demandes passées.                                                                                  | Bêta     |

**Arbitrage**

| ID       | Exigence                                                                                                                                                          | Priorité |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-SRV-20 | Quand le serveur propose un compromis, il peut être réglé de deux façons : le chef tranche, ou les membres concernés se mettent d'accord et le disent au serveur. | Bêta     |
| F-SRV-21 | Le chef peut stopper la décision ou la commande de n'importe quel membre. Le serveur l'annonce dans le chat.                                                      | Bêta     |
| F-SRV-22 | Un compromis réglé devient une décision dans la mémoire du projet.                                                                                                | Bêta     |

### 3.5 Les commandes

| ID       | Exigence                                                                                                                                                                                                           | Priorité  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| F-CMD-01 | N'importe quel membre peut passer une commande, par l'intermédiaire du serveur.                                                                                                                                    | Bêta      |
| F-CMD-02 | Statuts d'une commande : _en attente_, _en cours_, _à valider_, _terminée_, _stoppée_, _échouée_.                                                                                                                  | Bêta      |
| F-CMD-03 | La commande et sa progression sont visibles dans le chat (étapes, fichiers modifiés, tests).                                                                                                                       | Bêta      |
| F-CMD-04 | Le demandeur ou le chef peut annuler une commande. Le chef peut stopper n'importe quelle commande.                                                                                                                 | Bêta      |
| F-CMD-05 | **Choix de la machine**, dans l'ordre : la machine du demandeur, s'il est connecté ; sinon la machine d'un membre qui a activé le prêt de machine ; sinon la commande reste _en attente_ et l'équipe est prévenue. | Bêta      |
| F-CMD-06 | Une seule commande active à la fois par projet pendant la bêta, pour éviter les conflits. Les autres attendent leur tour.                                                                                          | Bêta      |
| F-CMD-07 | Plusieurs commandes en parallèle sur des machines différentes.                                                                                                                                                     | Plus tard |

### 3.6 L'agent cuisinier et ses outils

Le cuisinier tourne sur les serveurs de \<br/\> (la boucle d'IA), mais **toutes ses actions s'exécutent sur la machine du membre**, à travers l'extension.

| ID       | Exigence                                                                                                                                                                             | Priorité |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| F-CUI-01 | Outils disponibles : lire un fichier, écrire ou modifier un fichier, lister un dossier, rechercher dans les fichiers, lancer une commande, opérations Git, vérifier l'environnement. | Bêta     |
| F-CUI-02 | Le cuisinier reste dans le dossier du projet. Il n'en sort que si le propriétaire de la machine le lui demande explicitement (par exemple déplacer des fichiers vers le disque D:).  | Bêta     |
| F-CUI-03 | Il teste son travail (lancer les tests, compiler) avant de le déclarer terminé, quand le projet le permet.                                                                           | Bêta     |
| F-CUI-04 | Il enregistre son travail sur Git régulièrement, par petites étapes, pour limiter les pertes en cas d'interruption.                                                                  | Bêta     |
| F-CUI-05 | Il traite le contenu des fichiers et des résultats de commandes comme des données, jamais comme des instructions (protection contre l'injection de consignes).                       | Bêta     |
| F-CUI-06 | Il produit les documents en Markdown par défaut, et dans d'autres formats (Word, PDF) à la demande, avec les outils disponibles sur la machine.                                      | Bêta     |
| F-CUI-07 | Si sa tâche échoue, il l'explique dans le chat et propose une solution.                                                                                                              | Bêta     |

### 3.7 L'extension VS Code

**Interface**

| ID       | Exigence                                                                                                 | Priorité |
| -------- | -------------------------------------------------------------------------------------------------------- | -------- |
| F-EXT-01 | Un panneau latéral avec : la liste des équipes et projets, le chat, la mémoire du projet, les commandes. | Bêta     |
| F-EXT-02 | Interface en français et en anglais, selon le profil.                                                    | Bêta     |
| F-EXT-03 | Thème clair et sombre, qui suit celui de VS Code.                                                        | Bêta     |
| F-EXT-04 | Un bouton pour envoyer un retour (bug, idée) aux administrateurs.                                        | Bêta     |
| F-EXT-05 | Publication sur le Marketplace VS Code et sur Open VSX (Cursor, Windsurf).                               | Bêta     |

**Connexion et exécution**

| ID       | Exigence                                                                     | Priorité |
| -------- | ---------------------------------------------------------------------------- | -------- |
| F-EXT-10 | Connexion permanente au serveur (WebSocket), avec reconnexion automatique.   | Bêta     |
| F-EXT-11 | Le membre associe un dossier local à chaque projet.                          | Bêta     |
| F-EXT-12 | Le membre active ou désactive le prêt de machine.                            | Bêta     |
| F-EXT-13 | Une barre d'état indique : connecté ou non, cuisinier au travail ou non.     | Bêta     |
| F-EXT-14 | Un bouton « stopper le cuisinier » toujours visible pendant qu'il travaille. | Bêta     |

**Modes de permission**

| ID       | Exigence                                                                                                                                                                                                                        | Priorité |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-EXT-20 | Quatre modes, choisis par chaque membre pour sa machine : **Manuel**, **Édition auto**, **Auto**, **Plan** (voir le tableau du document de vision).                                                                             | Bêta     |
| F-EXT-21 | En mode Manuel et Édition auto, chaque modification demandée s'affiche en vue avant/après, à accepter ou refuser.                                                                                                               | Bêta     |
| F-EXT-22 | Les commandes dangereuses demandent toujours une confirmation, quel que soit le mode : suppression de fichiers en masse, sortie du dossier du projet, installation globale, `git push --force`, réécriture de l'historique Git. | Bêta     |
| F-EXT-23 | Un point de restauration est créé avant chaque modification de fichier. Le membre peut revenir en arrière.                                                                                                                      | Bêta     |

**Mémoire locale**

| ID       | Exigence                                                                                                                              | Priorité |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-EXT-30 | Les préférences négociées dans le chat (par exemple « je fais mes push moi-même ») sont enregistrées sur la machine, dans `~/.bria/`. | Bêta     |
| F-EXT-31 | Le cuisinier lit cette mémoire avant de travailler sur la machine.                                                                    | Bêta     |
| F-EXT-32 | Une copie de sauvegarde est envoyée sur le serveur. Elle sert uniquement à restaurer la mémoire sur une nouvelle machine.             | Bêta     |
| F-EXT-33 | Le membre peut consulter et modifier sa mémoire locale.                                                                               | Bêta     |

### 3.8 GitHub

| ID       | Exigence                                                                                                                                                                                                                                                                                                                                                                                                                              | Priorité |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-GIT-01 | Par défaut, chaque membre passe par sa propre connexion GitHub dans VS Code et par Git sur sa machine : branches, commits et pushes à son nom, pull requests et fusions par l'API de GitHub avec son accès. Aucune installation n'est exigée.                                                                                                                                                                                         | Bêta     |
| F-GIT-02 | Le chef branche le dépôt au projet depuis le chat.                                                                                                                                                                                                                                                                                                                                                                                    | Bêta     |
| F-GIT-10 | L'application GitHub \<br/\> est facultative. Quand le chef (celui qui a créé le dépôt) branche le dépôt, \<br/\> lui propose de l'installer en expliquant brièvement ses avantages : le serveur crée et fusionne les pull requests même quand aucune machine n'est allumée, et il est prévenu des fusions faites directement sur GitHub. Le chef accepte ou refuse ; sans elle, tout fonctionne avec les connexions des membres. | Bêta     |
| F-GIT-03 | Chaque commande travaille sur sa propre branche : `bria/<numéro>-<titre-court>`.                                                                                                                                                                                                                                                                                                                                                      | Bêta     |
| F-GIT-04 | À la fin d'une tâche testée, le cuisinier pousse la branche, selon la préférence du membre (automatiquement, ou après sa validation).                                                                                                                                                                                                                                                                                                 | Bêta     |
| F-GIT-05 | Le demandeur valide le résultat. La branche est alors fusionnée dans la branche principale, par une pull request.                                                                                                                                                                                                                                                                                                                     | Bêta     |
| F-GIT-06 | Après la fusion, les autres membres reçoivent une notification « nouvelle version disponible ».                                                                                                                                                                                                                                                                                                                                       | Bêta     |
| F-GIT-07 | Si le membre accepte, le cuisinier récupère la nouvelle version sur sa machine. Il vérifie d'abord qu'il n'y a pas de travail non enregistré ; s'il y en a, il demande quoi faire.                                                                                                                                                                                                                                                    | Bêta     |
| F-GIT-08 | Après la récupération, il installe les nouvelles dépendances si besoin.                                                                                                                                                                                                                                                                                                                                                               | Bêta     |
| F-GIT-09 | Les commits du cuisinier sont signés au nom du membre, sans mention de l'IA comme co-auteur.                                                                                                                                                                                                                                                                                                                                          | Bêta     |

### 3.9 Le relais entre machines

| ID       | Exigence                                                                                                                                                                          | Priorité |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-REL-01 | Avant de quitter une machine, le cuisinier pousse sa branche et laisse une note de reprise : ce qui est fait, ce qui reste, les commandes à relancer.                             | Bêta     |
| F-REL-02 | Sur la nouvelle machine, il récupère le dépôt (ou le met à jour), se place sur la branche, installe les dépendances et lit la note de reprise.                                    | Bêta     |
| F-REL-03 | Il vérifie l'environnement (système, versions de Node, Python, etc.) et propose les ajustements nécessaires au propriétaire.                                                      | Bêta     |
| F-REL-04 | Il écrit le `.env` à partir du coffre de secrets (voir 3.10).                                                                                                                     | Bêta     |
| F-REL-05 | Si une machine se déconnecte en pleine tâche, la commande repasse _en attente_. Le travail non poussé est perdu ; le cuisinier reprend depuis le dernier push et la conversation. | Bêta     |

### 3.10 Le coffre de secrets

| ID       | Exigence                                                                                                                                                           | Priorité  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| F-SEC-01 | Le chef dépose des secrets (nom + valeur) pour un projet, depuis l'extension.                                                                                      | Bêta      |
| F-SEC-02 | Les secrets sont chiffrés côté serveur (AES-256-GCM) avec une clé maîtresse stockée dans les variables d'environnement du serveur, jamais dans la base de données. | Bêta      |
| F-SEC-03 | Le chef choisit quels membres ont accès à quels secrets.                                                                                                           | Bêta      |
| F-SEC-04 | L'extension écrit le `.env` en local et vérifie qu'il figure dans `.gitignore` ; sinon, elle l'y ajoute.                                                           | Bêta      |
| F-SEC-05 | **L'IA ne voit jamais la valeur d'un secret.** Elle connaît seulement son nom.                                                                                     | Bêta      |
| F-SEC-06 | L'extension remplace toute valeur secrète par `****` dans les résultats de commandes avant de les envoyer à l'IA.                                                  | Bêta      |
| F-SEC-07 | Un journal enregistre qui a récupéré quel secret, et quand. Le chef le consulte.                                                                                   | Bêta      |
| F-SEC-08 | Quand un membre quitte l'équipe, \<br/\> rappelle au chef de changer les secrets auxquels il avait accès.                                                        | Bêta      |
| F-SEC-09 | Séparer les secrets de test et de production.                                                                                                                      | Plus tard |

### 3.11 Crédits et quotas

| ID       | Exigence                                                                                                                                                                       | Priorité  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| F-CRD-01 | Chaque appel à une IA est mesuré (tokens en entrée et en sortie, modèle, fournisseur) et converti en crédits selon un barème par modèle.                                       | Bêta      |
| F-CRD-02 | Le barème est réglable dans le tableau de bord d'administration. Pendant la bêta, les IA sont gratuites ; le barème sert à mesurer la consommation réelle pour fixer les prix. | Bêta      |
| F-CRD-03 | Chaque équipe a un quota mensuel de crédits, selon sa formule.                                                                                                                 | Bêta      |
| F-CRD-04 | Le chef est prévenu à 80 % du quota. À 100 %, les nouvelles commandes sont refusées ; le serveur continue de répondre avec un quota réduit.                                    | Bêta      |
| F-CRD-05 | Recharges de crédits payantes.                                                                                                                                                 | Plus tard |

### 3.12 Formules et codes promotionnels

| ID       | Exigence                                                                                                                                                           | Priorité  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| F-FRM-01 | Les formules (Essai, Solo, Équipe, Étudiant, Entreprise) sont définies dans le tableau de bord : limites de membres et de projets, quota de crédits.               | Bêta      |
| F-FRM-02 | Pendant la bêta, les formules sont attribuées par un administrateur ou par un code. Il n'y a pas de paiement.                                                      | Bêta      |
| F-PRO-01 | Types de codes : réduction en pourcentage, réduction d'un montant fixe, formule offerte pendant une durée, crédits en bonus, essai prolongé, invitation à la bêta. | Bêta      |
| F-PRO-02 | Durée de l'effet : une fois, ou pendant X mois. « Pour toujours » est réservé aux comptes de l'équipe interne.                                                     | Bêta      |
| F-PRO-03 | Limites : date d'expiration, nombre maximal d'utilisations, une utilisation par compte, nouveaux clients seulement, formule précise.                               | Bêta      |
| F-PRO-04 | Sortes de codes : public, unique généré en lot, parrainage.                                                                                                        | Bêta      |
| F-PRO-05 | Saisie d'un code dans l'extension.                                                                                                                                 | Bêta      |
| F-PRO-06 | Les réductions de prix ne s'appliquent qu'une fois le paiement intégré.                                                                                            | Plus tard |

### 3.13 L'espace du chef d'équipe

| ID       | Exigence                                                                 | Priorité  |
| -------- | ------------------------------------------------------------------------ | --------- |
| F-CHF-01 | Dans l'extension : les membres et leurs rôles, les invitations en cours. | Bêta      |
| F-CHF-02 | Les crédits consommés et restants, au total et par membre.               | Bêta      |
| F-CHF-03 | La formule de l'équipe et sa date de fin.                                | Bêta      |
| F-CHF-04 | Le coffre de secrets et son journal.                                     | Bêta      |
| F-CHF-05 | Les factures et le lien vers le paiement sur le site.                    | Plus tard |

### 3.14 Le tableau de bord d'administration

Sur le site, réservé aux administrateurs.

| ID       | Exigence                                                                                                                                 | Priorité  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| F-ADM-01 | **Utilisateurs et équipes** : recherche, détail, formule, consommation, suspension d'un compte.                                          | Bêta      |
| F-ADM-02 | **Coûts d'IA** : consommation par équipe, par fournisseur et par modèle ; coût réel estimé ; alertes sur les équipes les plus coûteuses. | Bêta      |
| F-ADM-03 | **Réglages** : barème des crédits, formules et quotas, liste des fournisseurs d'IA et ordre de secours.                                  | Bêta      |
| F-ADM-04 | **Codes promotionnels** : création (y compris en lot), suivi des utilisations, désactivation.                                            | Bêta      |
| F-ADM-05 | **Santé de la plateforme** : extensions connectées, commandes en attente faute de machine, erreurs, quotas des fournisseurs gratuits.    | Bêta      |
| F-ADM-06 | **Retours des testeurs** : liste, statut (nouveau, en cours, traité).                                                                    | Bêta      |
| F-ADM-07 | La valeur des secrets des équipes n'apparaît jamais.                                                                                     | Bêta      |
| F-ADM-08 | **Revenus** : abonnements, revenus du mois, résiliations, conversions.                                                                   | Plus tard |

### 3.15 Le mode maintenance

| ID       | Exigence                                                                                                              | Priorité |
| -------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| F-MNT-01 | Un administrateur programme une maintenance : date de début, durée estimée, message en français et en anglais.        | Bêta     |
| F-MNT-02 | Les utilisateurs sont prévenus à l'avance par une notification dans l'extension et un bandeau sur le site.            | Bêta     |
| F-MNT-03 | À l'heure prévue, les nouvelles commandes sont refusées. Les cuisiniers en cours poussent leur travail avant l'arrêt. | Bêta     |
| F-MNT-04 | Pendant la maintenance, l'extension et le site affichent le message. Les données restent intactes.                    | Bêta     |
| F-MNT-05 | Une liste d'exceptions (comptes choisis) garde l'accès.                                                               | Bêta     |
| F-MNT-06 | La réouverture se fait d'un clic, avec une notification aux utilisateurs.                                             | Bêta     |

### 3.16 Le site web

| ID       | Exigence                                                                                                                         | Priorité  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | --------- |
| F-WEB-01 | Une page de présentation en français et en anglais.                                                                              | Bêta      |
| F-WEB-02 | Un lien d'installation de l'extension (Marketplace et Open VSX).                                                                 | Bêta      |
| F-WEB-03 | Une page pour demander une invitation à la bêta.                                                                                 | Bêta      |
| F-WEB-04 | Les pages légales : conditions d'utilisation et politique de confidentialité, qui mentionnent l'usage des offres d'IA gratuites. | Bêta      |
| F-WEB-05 | Le paiement.                                                                                                                     | Plus tard |

---

## 4. Exigences non fonctionnelles

### 4.1 Performances

| ID        | Exigence                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------ |
| NF-PRF-01 | Un message apparaît chez les autres membres en moins d'une seconde.                                    |
| NF-PRF-02 | Le serveur commence sa réponse en moins de 5 secondes (avec des IA gratuites, la latence peut varier). |
| NF-PRF-03 | Le classement d'un message (F-SRV-01) ne retarde pas son affichage.                                    |
| NF-PRF-04 | L'extension ne ralentit pas VS Code quand le cuisinier ne travaille pas.                               |

### 4.2 Sécurité

| ID        | Exigence                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| NF-SEC-01 | Tous les échanges sont chiffrés (HTTPS et WSS).                                                               |
| NF-SEC-02 | Chaque machine a son propre jeton de session, révocable.                                                      |
| NF-SEC-03 | Le serveur vérifie, à chaque action, que le membre a le droit de la faire (rôle, équipe, projet).             |
| NF-SEC-04 | L'extension refuse toute action hors du dossier du projet sans l'accord explicite du propriétaire (F-CUI-02). |
| NF-SEC-05 | Les clés des fournisseurs d'IA et la clé maîtresse des secrets ne quittent jamais le serveur.                 |
| NF-SEC-06 | Limitation du nombre de requêtes par compte, pour éviter les abus.                                            |
| NF-SEC-07 | Les codes de vérification par e-mail expirent après 10 minutes et après 5 essais ratés.                       |

### 4.3 Confidentialité

| ID        | Exigence                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| NF-CNF-01 | Le serveur de \<br/\> stocke les conversations, la mémoire du projet et les métadonnées. Le code reste sur GitHub et sur les machines des membres. |
| NF-CNF-02 | Les testeurs sont prévenus, à l'inscription, que certaines IA gratuites utilisent les échanges pour leur entraînement.                               |
| NF-CNF-03 | Un membre peut exporter ses données.                                                                                                                 |

### 4.4 Compatibilité

| ID        | Exigence                                            |
| --------- | --------------------------------------------------- |
| NF-CMP-01 | L'extension fonctionne sur Windows, macOS et Linux. |
| NF-CMP-02 | Elle fonctionne sur VS Code, Cursor et Windsurf.    |

### 4.5 Exploitation

| ID        | Exigence                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------ |
| NF-EXP-01 | Les erreurs du serveur, du site et de l'extension remontent dans Sentry.                         |
| NF-EXP-02 | Les appels aux IA sont journalisés (modèle, tokens, durée, erreur), sans le contenu des secrets. |
| NF-EXP-03 | Pendant la bêta, seuls des services qui n'exigent pas de carte bancaire sont utilisés.           |

---

## 5. Architecture technique

### 5.1 Vue d'ensemble

```
┌──────────────────────────── Machine d'un membre ────────────────────────────┐
│  VS Code + extension <br/>                                                  │
│   ├─ panneau (webview React) : chat, mémoire, commandes                     │
│   ├─ exécuteur d'outils : fichiers, commandes, Git, .env                    │
│   └─ mémoire locale ~/.bria/                                                │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ WebSocket (WSS)
┌───────────────────────────────▼─────────────────────────────────────────────┐
│  Serveur API (Node.js, Fastify) — Azure                                     │
│   ├─ temps réel : chat, présence, notifications                             │
│   ├─ agent serveur : classement, réponses, mémoire du projet                │
│   ├─ agent cuisinier : boucle d'IA, appels d'outils vers l'extension        │
│   ├─ file d'attente des commandes (pg-boss)                                 │
│   ├─ coffre de secrets, crédits, codes, maintenance                         │
│   └─ webhooks et API GitHub (application GitHub)                            │
└──────┬──────────────────┬───────────────────┬────────────────────┬──────────┘
       │                  │                   │                    │
  PostgreSQL         Portkey Gateway      Backblaze B2          GitHub
   (Neon)          → Gemini, Groq,       (pièces jointes,
                     Mistral, Z.AI,       sauvegardes de
                     OpenRouter…          mémoire locale)

Site + tableau de bord d'administration (Next.js) — Vercel ──► Serveur API
```

### 5.2 Organisation du code

Trois dépôts GitHub :

| Dépôt                                                                      | Contenu                                                                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`br.ai-backend`](https://github.com/Dominique-BRIA/br.ai-backend)         | Serveur Fastify : HTTP, WebSocket, agents, file d'attente, base de données (Drizzle), couche d'IA (Portkey) |
| [`br.ai-extension`](https://github.com/Dominique-BRIA/br.ai-extension)     | Extension VS Code et sa webview React                                                                       |
| [`br.ai-frontendweb`](https://github.com/Dominique-BRIA/br.ai-frontendweb) | Site de présentation et tableau de bord d'administration (Next.js)                                          |

**Le protocole partagé.** Les types et les schémas Zod des échanges entre l'extension, le site et le serveur vivent dans le dépôt `br.ai-backend` (dossier `packages/protocol`). Ils sont publiés comme paquet npm public, que l'extension et le site installent. Le serveur reste ainsi la référence, et une modification du protocole se voit par un changement de version.

**Les interfaces** suivent la [charte des interfaces](charte-interfaces.md).

### 5.3 Technologies

| Partie                 | Choix                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Langage                | TypeScript partout                                                                            |
| Serveur                | Node.js, Fastify, WebSocket                                                                   |
| Base de données        | PostgreSQL (Neon), Drizzle ORM                                                                |
| File d'attente         | pg-boss                                                                                       |
| IA                     | Portkey Gateway devant les fournisseurs gratuits                                              |
| Fichiers               | Backblaze B2 (API compatible S3)                                                              |
| Site                   | Next.js (lire la documentation de la version installée : elle diffère des anciennes versions) |
| Extension              | API VS Code, webview React, react-markdown, Shiki, Mermaid, vscode-l10n                       |
| E-mails                | Resend                                                                                        |
| Erreurs                | Sentry                                                                                        |
| Validation des données | Zod, partagé entre le serveur, l'extension et le site                                         |

### 5.4 Protocole entre l'extension et le serveur

Messages JSON sur WebSocket, validés par Zod des deux côtés. Les principaux :

| Sens                | Message          | Rôle                                                             |
| ------------------- | ---------------- | ---------------------------------------------------------------- |
| Extension → serveur | `hello`          | Authentification de la machine, système, version de l'extension  |
| Extension → serveur | `machine.status` | Disponible, occupée, prêt de machine activé ou non               |
| Extension → serveur | `chat.send`      | Envoi d'un message                                               |
| Serveur → extension | `chat.message`   | Nouveau message dans un projet                                   |
| Serveur → extension | `tool.call`      | Le cuisinier demande une action (identifiant, outil, paramètres) |
| Extension → serveur | `tool.result`    | Résultat de l'action, ou refus du membre                         |
| Serveur → extension | `order.update`   | Progression d'une commande                                       |
| Serveur → extension | `notify`         | Notification (mise à jour disponible, maintenance, quota)        |
| Serveur → extension | `secrets.sync`   | Secrets à écrire dans le `.env`                                  |

### 5.5 Les outils du cuisinier

| Outil       | Action                                         | Confirmation                                        |
| ----------- | ---------------------------------------------- | --------------------------------------------------- |
| `fs.read`   | Lire un fichier                                | Jamais                                              |
| `fs.list`   | Lister un dossier                              | Jamais                                              |
| `fs.search` | Chercher dans les fichiers                     | Jamais                                              |
| `fs.write`  | Créer ou modifier un fichier (vue avant/après) | Selon le mode                                       |
| `fs.move`   | Déplacer ou supprimer                          | Selon le mode ; toujours hors du projet ou en masse |
| `shell.run` | Lancer une commande (avec délai maximal)       | Selon le mode ; toujours si dangereuse              |
| `git.*`     | status, commit, branche, push, pull, clone     | Push selon la préférence du membre                  |
| `env.check` | Système, versions des outils installés         | Jamais                                              |

### 5.6 Données principales

| Table                                        | Contenu                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `users`                                      | Compte, e-mail, nom, langue                                                                        |
| `sessions`                                   | Jeton par machine, date de dernière connexion                                                      |
| `teams` / `team_members`                     | Équipe, chef, membres et rôles                                                                     |
| `projects`                                   | Projet, équipe, dépôt GitHub associé                                                               |
| `messages`                                   | Chat : auteur (membre ou agent), contenu Markdown, fil, catégorie attribuée par le serveur         |
| `memory_items`                               | Mémoire du projet : type (décision, question, tâche, compromis), statut, auteur, message d'origine |
| `orders` / `order_events`                    | Commandes, statut, demandeur, machine, branche, note de reprise, étapes                            |
| `machines`                                   | Machine, propriétaire, système, prêt de machine, dernière présence                                 |
| `secrets` / `secret_access` / `secret_audit` | Secrets chiffrés, accès par membre, journal                                                        |
| `ai_calls`                                   | Appels aux IA : fournisseur, modèle, tokens, crédits, durée, erreur                                |
| `plans` / `subscriptions`                    | Formules et formule de chaque équipe                                                               |
| `promo_codes` / `promo_redemptions`          | Codes et utilisations                                                                              |
| `local_memory_backups`                       | Sauvegardes de la mémoire locale                                                                   |
| `feedback`                                   | Retours des testeurs                                                                               |
| `maintenance_windows`                        | Maintenances programmées et liste d'exceptions                                                     |

---

## 6. Hébergement de la bêta

Aucun service ne doit exiger de carte bancaire.

| Partie                 | Service                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Serveur API            | Azure for Students (100 $ de crédit)                                                  |
| Base de données        | Neon, offre gratuite                                                                  |
| Site + tableau de bord | Vercel, offre Hobby                                                                   |
| Fichiers               | Backblaze B2, 10 Go gratuits                                                          |
| E-mails                | Resend, offre gratuite                                                                |
| Erreurs                | Sentry (GitHub Student Pack)                                                          |
| Domaine                | Name.com ou Namecheap (GitHub Student Pack), à réserver au moment de la mise en ligne |
| IA                     | Google AI Studio, Groq, Mistral, Z.AI, OpenRouter gratuit, Cloudflare Workers AI      |

Les offres Vercel Hobby et GitHub Student Pack sont réservées à un usage non commercial : il faudra en changer avant le lancement payant.

---

## 7. Lots de développement

Chaque lot se termine par quelque chose qu'on peut essayer.

| Lot                                   | Contenu                                                             | Terminé quand…                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **0. Fondations**                     | Dépôt, outillage, base de données, serveur vide, extension vide, CI | L'extension se connecte au serveur en local.                                                                      |
| **1. Comptes, équipes, chat**         | 3.1, 3.2, 3.3                                                       | Deux comptes discutent en temps réel dans un projet, avec Markdown et pièces jointes.                             |
| **2. Agent serveur**                  | 3.4, couche d'IA avec Portkey et secours, mesure des crédits        | Le serveur se tait entre collègues, répond à `@bria`, note une décision, signale une contradiction.               |
| **3. Cuisinier sur une machine**      | 3.5, 3.6, modes de permission, mémoire locale                       | Un membre demande une fonction ; le cuisinier l'écrit et la teste sur sa machine, avec validation en mode Manuel. |
| **4. GitHub et relais**               | 3.8, 3.9                                                            | Une commande commencée chez Ali se termine chez Fatou ; les autres reçoivent la nouvelle version.                 |
| **5. Coffre de secrets**              | 3.10                                                                | Le `.env` est écrit sur une nouvelle machine ; l'IA ne voit jamais les valeurs.                                   |
| **6. Administration**                 | 3.11 à 3.15                                                         | Un administrateur crée des codes d'invitation, suit les coûts et programme une maintenance.                       |
| **7. Site et préparation de la bêta** | 3.16, publication de l'extension, déploiement                       | Un camarade reçoit une invitation, installe l'extension et rejoint une équipe.                                    |

---

## 8. Critères d'acceptation de la bêta

La bêta peut commencer quand ce scénario fonctionne de bout en bout, avec trois personnes sur trois machines :

1. Dominique crée une équipe et invite Ali et Fatou avec des codes.
2. Il branche un dépôt GitHub et dépose une clé dans le coffre de secrets.
3. Ali et Fatou discutent d'une fonctionnalité ; le serveur ne les interrompt pas, mais note leur décision.
4. Fatou contredit la décision ; le serveur le signale et propose un compromis ; Ali et Fatou s'accordent et le lui disent.
5. Ali demande la fonctionnalité ; le cuisinier travaille sur sa machine en mode Édition auto, teste et pousse sa branche.
6. Ali ferme VS Code en cours de route ; la commande passe sur la machine de Fatou, qui a activé le prêt de machine ; le cuisinier reprend grâce à la note de reprise.
7. Ali valide ; la branche est fusionnée ; Dominique reçoit la notification et récupère la nouvelle version.
8. Le chef stoppe une seconde commande qu'il n'approuve pas.
9. À aucun moment, la valeur du secret n'apparaît dans les échanges avec l'IA.
10. Le tableau de bord montre la consommation de crédits de l'équipe.

---

## 9. Hors périmètre de la bêta

- Le paiement et les factures (étape 4).
- L'environnement cloud de secours pour le cuisinier.
- Le chiffrement de bout en bout des secrets.
- Une interface web de chat.
- Plusieurs commandes en parallèle dans un même projet.
- Les fonctions Entreprise (connexion d'entreprise, contrats).

---

## 10. Risques

| Risque                                                       | Conséquence                                  | Parade                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Les quotas des IA gratuites sont trop bas                    | Les commandes s'arrêtent en cours de journée | Plusieurs fournisseurs avec bascule ; quotas par équipe ; peu de testeurs                           |
| Les modèles gratuits appellent mal les outils                | Le cuisinier échoue souvent                  | Tester chaque modèle dès le lot 2 ; ne garder que ceux qui fonctionnent                             |
| Une offre gratuite change ou disparaît (comme GitHub Models) | Panne d'un fournisseur                       | La couche commune permet d'en changer par simple réglage                                            |
| Le serveur classe mal les messages                           | Il parle trop ou pas assez                   | Mesurer pendant la bêta ; `@bria` force toujours une réponse                                        |
| Le cuisinier abîme le projet d'un membre                     | Perte de confiance                           | Points de restauration, branches dédiées, confirmations, commandes dangereuses bloquées             |
| Injection de consignes dans un fichier ou un message         | Action non voulue                            | Contenu traité comme données (F-CUI-05), confirmations obligatoires pour les actions risquées       |
| Le crédit Azure s'épuise                                     | Arrêt du serveur                             | Surveiller la consommation ; passer à Heroku ou à une offre payante quand une carte sera disponible |

---

## 11. Points ouverts

1. **Une équipe, plusieurs projets :** ce document suppose que tous les membres d'une équipe accèdent à tous ses projets, avec un seul chef pour l'équipe. À confirmer.
2. **La fusion dans la branche principale :** ce document propose que le demandeur valide, puis qu'une pull request soit fusionnée. Faut-il aussi l'accord du chef ?
3. **Une commande active à la fois par projet** pendant la bêta : acceptable pour les tests ?
4. **Les modèles gratuits retenus :** à confirmer après les essais d'appels d'outils du lot 2.
5. **Le prestataire de paiement :** à choisir à l'étape 4.
