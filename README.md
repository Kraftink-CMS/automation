# KraftInk Automation

Outils communs de publication pour les plugins, thèmes, modules de jeu et projets personnalisés de Kraftink-CMS.

## Publier une version

1. Poussez vos changements sur `dev`.
2. Dans votre dépôt, ouvrez **Actions → Release → Run workflow**.
3. Choisissez `auto`, `patch`, `minor` ou `major`, puis lancez la publication.

Un droit d’écriture sur votre dépôt suffit. Vous n’avez besoin d’aucun droit sur le dépôt `automation` ni de jeton personnel.

L’automatisation installe le bouton **Release** et les protections du dépôt. Pour un nouveau projet, cette installation attend le prochain passage du contrôleur. Les plugins, thèmes et jeux indépendants sont reconnus par leurs noms `Plugin-*`, `Theme-*` et `Game-*`.

Le wrapper **Release** installé automatiquement est la seule configuration GitHub Actions nécessaire aux plugins, thèmes et jeux standards. Une action locale `.github/actions/build/action.yml` est réservée aux constructions personnalisées, comme Maven pour KraftLink.

Ce wrapper vérifie aussi les PR vers `dev`, sans publication ni artifact conservé. La PR et la release réutilisent les mêmes validations. Le résultat requis **checks / Validate changes** bloque la fusion sur `dev` en cas d’échec. Les rôles GitHub **Maintain** et **Admin** peuvent forcer cette règle et pousser directement sur `dev`. La release conserve son blocage automatique en cas d’échec, même pour un mainteneur. Les commits techniques de version sont validés comme des changements de métadonnées uniquement.

Pour ajouter des tests, versionnez une action composite facultative `.github/actions/test/action.yml`. La validation commune l’exécute avant le build des PR et des releases, avec un jeton en lecture seule. Cette action place ses étapes à la racine du projet (`${{ github.action_path }}/../../..`), installe son environnement et lance les commandes choisies (`npm test`, PHPUnit, etc.), sans framework imposé ; un échec bloque la validation. Sans tests, aucun fichier n’est requis. Le build Maven de KraftLink exécute déjà ses tests éventuels.

Une fois le bouton présent, chaque lancement prépare la version stable sur `dev` et ouvre sa PR vers `master` avant le build. Un job en lecture seule valide et construit les fichiers, puis le workflow fusionne la PR validée et publie la release. Toutes ces étapes s’exécutent dans votre dépôt, sans attendre le contrôleur central. Un échec du build laisse la PR ouverte et empêche la fusion et la publication. Une nouvelle demande est refusée tant qu’une PR de release reste ouverte, avec un lien vers celle-ci.

La première version reprend le numéro du manifeste sans son suffixe de développement. Les suivantes suivent les Conventional Commits avec `auto`, ou le niveau choisi explicitement. La politique `.github/release-policy.json` reste facultative.

Le formulaire propose aussi `notes_mode` et le champ Markdown `notes` :

- `auto` génère la liste des commits. Laissez `notes` vide.
- `append` place votre message avant la liste automatique.
- `replace` utilise uniquement votre message.

`append` et `replace` exigent un message, limité à 8 Kio en UTF-8. La liste automatique part de la précédente stable, avec au plus 100 commits et un lien de comparaison. Elle écarte les bots, les fusions et les commits techniques de métadonnées. La reprise des jobs échoués conserve les notes préparées et ne remplace pas celles d’une release déjà publiée. Les mêmes options s’appliquent aux constructions personnalisées.

`master` porte la version stable publiée. Après publication, `dev` passe au patch suivant avec le suffixe `-dev`. Faites un `git pull` avant de continuer vos modifications.

Pour une erreur temporaire sur la même source, utilisez **Re-run failed jobs** dans l’exécution **Release** concernée. Pour corriger le code avant fusion, poussez la correction sur `dev`, puis utilisez **Re-run all jobs** dans cette même exécution : la source est préparée à nouveau et le build entier est refait, en conservant la version choisie. Changer de cible demande de fermer la PR puis de lancer une nouvelle **Release**. Une publication interrompue après fusion doit aussi être terminée avant la suivante. Le contexte et les artifacts temporaires sont conservés sept jours. Les fichiers déjà publiés restent immuables. Le Market se met à jour au passage suivant de son actualisation automatique.

## Publier des fichiers personnalisés

Pour utiliser le même bouton avec votre propre build :

1. Placez le [wrapper Release](templates/workflow-templates/extension-release.yml) dans `.github/workflows/release.yml` sur `dev`.
2. Ajoutez une action composite `.github/actions/build/action.yml` recevant les entrées `version` et `output-directory`.
3. Dans cette action, installez votre environnement et construisez les fichiers dans le dossier absolu `output-directory` fourni.

La même action vérifie les PR vers `dev` avec la version courante des sources, éventuellement suffixée `-dev`. Pour une release, elle reçoit la version stable préparée. Les fichiers construits sur une PR restent temporaires dans le runner.

Le contrôleur installe le bouton sur `master`. Le lancement suivant récupère la source stable préparée et exécute votre action de build avec un jeton en lecture seule. L’automatisation conserve la gestion des versions, de la PR, des sommes de contrôle et de la publication. Aucun secret d’organisation ni script de publication local n’est nécessaire.

Les dépôts utilisant ce bouton exigent une PR vers `master` et le statut GitHub Actions `Release validated source`. Le workflow publie ce statut après le build et la vérification de la source. Un contributeur disposant des droits d’écriture peut aussi fusionner une PR déjà validée ou modifier les workflows du dépôt. Les protections contre les suppressions et les modifications forcées de `master` restent actives.

L’action `Kraftink-CMS/automation@master` expose aussi les opérations réutilisables suivantes pour un workflow existant :

- `operation: plan` renvoie `version` et `plan-path`.
- `operation: publish` reçoit ce `plan-path`, le dossier `artifacts-path` et le `github-token` du workflow, avec les permissions `contents: write` et `statuses: write` pour ouvrir le prochain cycle de développement.

## Développement

Prérequis : Node.js 24, PHP 8.5, Composer 2 et Git.

```shell
npm ci --ignore-scripts
composer install --working-dir=scripts/releases/php-scoper --no-interaction --prefer-dist --no-progress --no-scripts --no-plugins
npm test
```
