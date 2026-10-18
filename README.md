# Comparateur de cotes football 1X2

Service Node.js et TypeScript qui récupère les cotes des matchs de football à venir, rapproche les mêmes rencontres entre bookmakers et conserve les relevés dans SQLite. Il affiche les écarts dépassant un seuil, dans le terminal et dans une interface web locale.

Les trois issues comparées sont `1` (victoire à domicile), `X` (nul) et `2` (victoire à l’extérieur). Le projet inclut trois sources réelles et un mode d’exemple utilisable sans clé API.

## Installation et premier lancement

Prérequis : **Node.js 24 ou supérieur** et npm. SQLite est fourni par Node.js ; aucun serveur de base de données n’est nécessaire.

Depuis la racine du dépôt :

```sh
npm ci
npm run demo
```

`demo` force le mode d’exemple et effectue une collecte unique à partir de `data/examples/`, sans accès réseau. Les fichiers incluent une cote invalide et un match passé pour vérifier leur exclusion ; leurs diagnostics sont attendus. L’historique est créé dans `data/odds.sqlite` par défaut.

Sous PowerShell, utiliser `npm.cmd` à la place de `npm` si l’exécution de `npm.ps1` est bloquée.

### Interface web avec les exemples

Copier `.env.example` vers `.env` si ce fichier n’existe pas déjà, puis conserver ces valeurs :

```dotenv
DATA_SOURCE=mock
DATABASE_PATH=./data/odds.sqlite
```

```sh
npm run web
```

Ouvrir **http://127.0.0.1:3000**. Le serveur lance une collecte au démarrage, puis automatiquement toutes les dix minutes par défaut. L’interface propose les rencontres, les alertes, l’historique, les diagnostics, une collecte manuelle et le réglage du seuil. L’automatisme peut être suspendu depuis l’interface. Arrêter le service avec `Ctrl+C`.

### Données réelles

Renseigner le fichier local `.env` :

```dotenv
DATA_SOURCE=odds-api
ODDS_API_KEY=votre_cle
ODDS_API_SPORTS=soccer_epl
BET261_ENABLED=true
DATABASE_PATH=./data/odds-live.sqlite
```

Puis choisir une seule collecte ou le tableau de bord :

```sh
npm run collect
# ou
npm run web
```

| Source | Mode de récupération |
| --- | --- |
| 1xBet | The Odds API, bookmaker `onexbet`, marché `h2h` |
| Pinnacle | The Odds API, bookmaker `pinnacle`, avec la même clé |
| Bet261 | Extraction du flux JSON public utilisé par le site, sans navigateur automatisé ni compte |

Bet261 découvre le serveur d’événements dans la configuration publique du site, retrouve les compétitions, puis parcourt leurs événements prématch et le marché 1X2. `BET261_ENABLED=false` désactive uniquement ce collecteur.

Le programme conserve uniquement les cotes du bookmaker demandé ; une source absente n’est pas remplacée par une autre. Les modes réel et exemple utilisent des bases distinctes dans la configuration ci-dessus. **Ne pas publier `.env` ni une clé API** : le fichier est ignoré par Git et `.env.example` contient une clé vide.

## Commandes

| Commande | Utilisation |
| --- | --- |
| `npm run demo` | Collecte unique avec les exemples, quel que soit le mode configuré |
| `npm run collect` | Collecte unique dans le mode configuré |
| `npm run watch` | Collecte immédiate, puis répétition selon l’intervalle |
| `npm run history -- --limit 20` | Dernières observations enregistrées |
| `npm run alerts -- --limit 20` | Dernières alertes enregistrées |
| `npm run web` | Serveur et interface web locale |
| `npm run check` | Vérification des types, tests et compilation |
| `npm run typecheck` | Vérification des types du code et des tests |
| `npm test` | Tests unitaires et d’intégration |
| `npm run build` | Compilation de `src/` vers `dist/` |

Après compilation :

```sh
npm start -- --once
npm start -- --watch
npm run web:prod
```

Exécuter ces commandes depuis la racine du projet ; `public/` reste nécessaire pour le serveur web compilé. La boucle attend **dix minutes après la fin du cycle précédent**, sans chevauchement dans une même instance. Utiliser soit la boucle du terminal, soit celle du serveur web pour éviter des collectes en double.

## Configuration

Le fichier `.env` est chargé au démarrage. Les variables déjà présentes dans l’environnement restent prioritaires. Les modifications nécessitent un redémarrage, sauf les réglages proposés dans l’interface.

| Variable | Valeur par défaut | Rôle |
| --- | --- | --- |
| `DATA_SOURCE` | `odds-api` si une clé est présente, sinon `mock` | Mode de collecte ; le modèle fourni fixe `mock` |
| `ODDS_API_KEY` | Vide | Clé obligatoire en mode réel, commune à 1xBet et Pinnacle |
| `ODDS_API_SPORTS` | `soccer_epl` | Clés de football `soccer_*`, séparées par des virgules |
| `BET261_ENABLED` | `true` | Activation du collecteur Bet261 en mode réel |
| `MOCK_DATA_DIR` | `./data/examples` | Dossier des sources JSON en mode exemple |
| `DATABASE_PATH` | `./data/odds.sqlite` en exemple ; `./data/odds-live.sqlite` en réel | Fichier SQLite ; une valeur explicite reste prioritaire |
| `ODDS_THRESHOLD_MODE` | `percentage` | Comparaison en `percentage` ou en `absolute` |
| `ODDS_THRESHOLD` | `10` | Seuil positif ou nul, strictement dépassé pour déclencher une alerte |
| `INTERVAL_MINUTES` | `10` | Attente entre deux cycles terminés |
| `MATCH_TOLERANCE_MINUTES` | `15` | Écart maximal entre les horaires d’une rencontre |
| `COLLECTOR_TIMEOUT_MS` | `15000` | Délai maximal par source pour un cycle complet |
| `WEB_PORT` | `3000` | Port HTTP local |

Le fichier `.env.example` fixe explicitement `DATABASE_PATH=./data/odds.sqlite` : changer aussi cette valeur lors du passage au réel.

## Approche et logique de traitement

Un même service métier alimente le terminal et le serveur web :

```text
Sources → collecteurs → validation et normalisation → rapprochement
        → comparaison 1/X/2 → transaction SQLite → terminal / interface web
```

1. **Collecter.** Les adaptateurs produisent le même format : identifiant source, équipes, compétition, horaire et trois cotes. Les sources sont lues en parallèle et leurs erreurs sont isolées.
2. **Valider et normaliser.** Les dates doivent préciser un fuseau et sont converties en UTC. Les cotes doivent être des nombres finis supérieurs à `1`. Les observations invalides sont rejetées et les matchs déjà commencés sont exclus. Les noms sont normalisés ; une liste d’alias explicites rapproche certaines variantes d’équipes.
3. **Rapprocher.** Les équipes à domicile et à l’extérieur, dans cet ordre, ainsi que la compétition normalisée doivent correspondre. L’ensemble du groupe doit tenir dans la tolérance horaire, avec au plus une observation par source. Les groupes ambigus restent séparés pour éviter une comparaison incorrecte.
4. **Comparer.** Dès qu’une rencontre possède au moins deux sources, le programme compare la cote minimale et la cote maximale pour chaque issue. Une rencontre peut donc produire jusqu’à trois alertes.
5. **Enregistrer.** Chaque cycle, ses observations, ses alertes et ses diagnostics sont sauvegardés dans une transaction SQLite. Une erreur d’écriture annule la transaction entière.

Les deux mesures disponibles sont :

```text
Écart absolu       = cote maximale − cote minimale
Écart en pourcent  = (cote maximale − cote minimale) / cote minimale × 100
Alerte            = écart strictement supérieur au seuil
```

Par exemple, `2.00` et `2.20` donnent un écart de `10 %` : aucune alerte avec un seuil de `10`, car le dépassement doit être strict. La décision utilise une comparaison décimale à base de `BigInt`, sans arrondir l’écart avant de le comparer ; l’arrondi concerne l’affichage.

SQLite conserve quatre tables : `collection_runs`, `matches`, `odds_snapshots` et `alerts`. Un nouveau relevé est ajouté à chaque cycle même si les cotes sont inchangées. Les requêtes utilisent des paramètres liés, les clés étrangères sont activées et le mode WAL est utilisé pour les bases sur disque.

## Organisation et outils

```text
src/index.ts           Commandes du terminal
src/config.ts          Configuration validée
src/collectors/         Adaptateurs des sources et accès HTTP
src/services/           Normalisation, rapprochement, comparaison, cycle
src/database/sqlite.ts  Stockage et historique
src/web/                Serveur HTTP et API du tableau de bord
src/types.ts            Contrats communs
public/                 Interface HTML, CSS et JavaScript
data/examples/          Sources fictives pour une exécution sans clé
tests/                  Tests unitaires et d’intégration
```

Le projet utilise TypeScript en mode strict et des modules ESM. Le serveur HTTP, `fetch`, l’annulation des requêtes et SQLite reposent sur les modules natifs de Node.js. `tsx` exécute TypeScript, `tsc` compile le service et `node:test` exécute les tests. Le frontend ne nécessite aucun framework ni compilation séparée.

Pour ajouter une source, implémenter le contrat `Collector` de `src/types.ts`, convertir les données dans le format commun et enregistrer l’adaptateur dans `src/collectors/index.ts`. Pour une source réelle, compléter aussi `REAL_SOURCES` et la liste initiale des sources dans `src/web/server.ts`, ainsi que les libellés de l’interface. Les services métier restent communs. En mode exemple, chaque fichier JSON du dossier configuré devient automatiquement une source.

## API HTTP locale

| Route | Résultat |
| --- | --- |
| `GET /api/state` | Réglages, sources, dernier cycle et état du service |
| `GET /api/history?limit=50` | Observations enregistrées |
| `GET /api/alerts?limit=50` | Alertes enregistrées |
| `POST /api/collect` | Collecte manuelle |
| `POST /api/settings` | Seuil et activation de l’automatisme |

`limit` accepte un entier de `1` à `10000`. Les lectures ne déclenchent aucune collecte. Pour les réglages, envoyer du JSON avec `Content-Type: application/json`, par exemple `{"threshold":{"mode":"percentage","value":10},"automatic":true}`. Les erreurs HTTP suivent le format `{"error":"message","code":"CODE_ERREUR"}`.

## Gestion des erreurs et vérification

Une source indisponible ne bloque pas les autres : le cycle conserve leurs observations et expose les diagnostics. Chaque source dispose d’un délai global borné, incluant ses requêtes et éventuelles nouvelles tentatives. Les lectures HTTP GET sont retentées une seule fois après `200 ms` en cas d’erreur réseau ou de statut `408`, `500`, `502`, `503`, `504` ; les refus de clé et de quota ne sont pas retentés immédiatement.

La configuration invalide, les erreurs SQLite et les échecs de démarrage sont signalés explicitement. Les diagnostics masquent les secrets reconnus. L’interface conserve son dernier affichage en cas de problème de lecture, signale que les données ne sont plus actualisées et permet de réessayer. `Ctrl+C` annule les collectes en cours et ferme les ressources.

```sh
npm run check
```

Cette commande exécute successivement `typecheck`, `test` et `build`. Les tests couvrent les collecteurs, les données invalides, les alias, les ambiguïtés de rapprochement, les seuils, les délais et annulations, les erreurs réseau, les transactions et lectures SQLite, la planification, le terminal, les routes HTTP et les erreurs du frontend. Les réponses des fournisseurs sont simulées : les tests ne consomment aucune clé ni quota API.

## Limites

- **Couverture des sources.** Les cotes réelles dépendent de la disponibilité et des formats des fournisseurs. Bet261 est adapté à cinq championnats : Premier League anglaise, Ligue 1, Liga, Bundesliga et Serie A. Un changement du flux public peut nécessiter une mise à jour du collecteur.
- **Consommation API.** 1xBet et Pinnacle génèrent normalement deux requêtes The Odds API par ligue et par cycle, jusqu’à quatre tentatives en cas d’erreur temporaire. Le coût en crédits dépend du fournisseur ; aucun suivi du quota restant n’est intégré. Adapter l’intervalle et le nombre de ligues au compte utilisé.
- **Rapprochement conservateur.** Les alias sont limités, les équipes inversées ne sont pas rapprochées et les noms de compétition doivent correspondre après normalisation. L’identifiant d’une rencontre peut changer si son horaire ou le groupe rapproché change.
- **Périmètre fonctionnel.** Seuls les matchs à venir et le marché 1X2 sont traités. Les relevés des sources ne sont pas nécessairement simultanés et un écart affiché ne garantit pas la disponibilité actuelle de la cote. Aucun pari ni notification externe n’est envoyé.
- **Exploitation locale.** Le serveur écoute sur `127.0.0.1`, sans authentification, et n’est pas prévu pour une exposition directe sur Internet. Les verrous de collecte concernent une seule instance. Le processus doit rester actif pour assurer la boucle.
- **Persistance.** L’historique n’est pas purgé automatiquement. Les modifications du seuil et de l’automatisme dans l’interface restent en mémoire ; le redémarrage reprend la configuration initiale de `.env`. Le nouveau seuil recalcule les alertes affichées du dernier cycle, sans réécrire les alertes historiques.

Les fichiers `.env`, les bases SQLite, `node_modules/` et `dist/` sont ignorés par Git. Le dépôt contient les sources, les exemples, les tests et les fichiers nécessaires à une installation reproductible avec `npm ci`.
