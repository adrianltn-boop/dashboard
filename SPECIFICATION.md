# SPECIFICATION.md — Dashboard Faustine (Achat/Vente)

> Document généré par lecture directe du code (`index.html`, `styles.css`, `script.js`, `CLAUDE.md`) le 2026-07-25. Aucune information ci-dessous n'est supposée : quand le code ne tranche pas, la mention `[INFO MANQUANTE]` l'indique.

---

## 1. IDENTITÉ DU PROJET

**Nom** : `Dashboard Faustine — Achat/Vente` (titre HTML, `index.html:6`).

**Objectif principal** : piloter l'activité d'une entreprise de mareyage/pêche (achat de poisson aux pêcheurs, vente aux clients) à partir des fichiers Excel existants de l'entreprise, sans base de données ni serveur. Le dashboard lit et écrit directement dans ces classeurs Excel, qui restent « la source de vérité » (`script.js:5698`). Il ajoute une couche de saisie rapide, de calculs (marge, trésorerie, stock valorisé) et de rapprochement entre fichiers (ventes/achats/factures/banque/stock).

**Utilisateurs cibles et contexte** : une assistante de direction (Faustine, nom en dur dans le titre) et éventuellement d'autres profils internes à droits limités (« profil simplifié » vs « admin », `script.js:3833-3874`). Application 100 % locale et hors ligne : « Tout se passe en local, hors ligne : aucune donnée n'est envoyée sur Internet » (`script.js:5698`). Fonctionne uniquement sur ordinateur, navigateur Chrome ou Edge (répété à ~10 endroits, ex. `script.js:2512`, `2577`, `5780`) — l'écriture Excel dépend de la File System Access API, absente de Firefox/Safari et des mobiles.

---

## 2. FICHIERS EXCEL SOURCES

Il n'y a **aucun nom de fichier figé en dur** pour la lecture réelle (les seuls noms en dur, `Stock_S27_2026.xlsx` etc. à `script.js:429-436`, sont des données de **démo**, `static STOCK`). En production, chaque fichier/dossier est choisi par l'utilisatrice via `showOpenFilePicker`/`showDirectoryPicker` et mémorisé (IndexedDB `avHandles`). Un préfixe de nom configurable (`PREFIX_KEY` → `avPrefixes`) sert à repérer automatiquement les nouveaux fichiers dans un dossier surveillé (pattern `` `${préfixe} ${semaine}.xlsx` ``, `script.js:1094`).

Sources définies dans `importSpec(kind)` (`script.js:3134+`) :

### 2.1 Ventes clients (`kind: 'ventes'`)
- **Fichier/emplacement** : choisi par l'utilisatrice (`showOpenFilePicker`, filtre `.xlsx/.xlsm`) — un seul fichier surveillé.
- **Feuille ciblée** : détection par mot-clé `/suivi des paiements|paiement|factur|vente/`, sinon feuille d'index 0 (`forceSheetIndex: 0`).
- **Colonnes canoniques** (`headers`) : Date, Numero de facture, Nom du client, Montant TTC, Montant regle, Date echeance, Sens, Etat, Montant HT, Delai de paiement, Solde, Paye le.
- **Détection de la ligne d'en-tête** : score sur mots-clés parmi les 20 premières lignes (`script.js:2744-2759`).
- **Rôle** : lecture (import) + écriture (nouvelle vente ajoutée en ligne via `commitVente()` puis `patchXlsxFile`).
- **Calcul dérivé** : TTC reconstitué = Montant HT + TVA France + TVA Irlande (`script.js:3141, 3156`).

### 2.2 Achat pêche (`kind: 'operations'`)
- **Colonnes canoniques** : Date, Type, Partenaire, Montant, Statut, Reference, Paye, Solde.
- **Feuille ciblée** : `/facturation|suivi|recap/` préférée, feuilles purement numériques ou « graphique »/« bat » évitées.
- **Colonnes d'écriture réelles** (`writeFieldsFor('operations')`, `script.js:1692`) : N° de facture, Année, Date, Nom du pêcheur/client, Montant, N° de chèque, Total payé, Date de paiement, Solde.
- **Rôle** : lecture + écriture (`commitAchat()`).

### 2.3 Factures fournisseurs (`kind: 'factures'`)
- **Colonnes canoniques** : Date, Fournisseur, Numero de facture, Montant TTC, Montant regle, Date paiement, Sens.
- **Feuilles** : une par mois (`/janv|fevr|.../dec/`), agrégées (`aggregate: true`).
- **Particularité** : deux tableaux jumeaux par feuille (FOURNISSEURS et FOURNISSEURS CRUSTACÉS) lus tous les deux et dépliés par `foldBlocks()` (`script.js:2778-2792`).
- **Rôle** : lecture + écriture (`commitFourn()`).

### 2.4 Crédits & assurances (`kind: 'credits'`)
- **Colonnes canoniques** : Denomination, Entreprise, Montant total, Mensualite, Restant.
- **Rôle** : lecture seule (saisie 100 % manuelle côté dashboard selon l'agent d'exploration, `script.js:~4152` — pas d'écriture Excel identifiée).

### 2.5 Bordereaux de livraison (`kind: 'bordereaux'`)
- **Colonnes canoniques** : Date, Bordereau, Destinataire, Facture, Colis, Transporteur, Statut.
- **Emplacement** : dossier surveillé (`showDirectoryPicker`), pas un fichier unique.
- **Rôle** : lecture seule.

### 2.6 Stock (`kind: 'stock'`)
- **Emplacement** : dossier surveillé, un fichier par semaine (nom = préfixe + semaine).
- **Colonnes attendues** : semaine/periode/fichier, poids total/poids kg/quantite, total prix/valorisation/valeur/montant.
- **Cas particulier « RECAP »** : sans colonne semaine, une seule ligne TOTAL est produite par fichier (`script.js:3083-3088`).
- **Contrôle de cohérence** : le récapitulatif est comparé aux feuilles détaillées par espèce (`script.js:3634`).
- **Rôle** : lecture seule.

### 2.7 Export comptable (`kind` dédié, `sheetHints: /export|compta|grand.?livre|ecritur|journal|factur|vente|achat/`)
- **Colonnes canoniques** : Date, Numero de facture, Partenaire, Montant.
- **Rôle** : lecture seule, sert uniquement au rapprochement registre interne ↔ export comptable (§5.4).

### 2.8 Banque (relevé bancaire)
- **Rôle** : lecture seule, utilisée pour le rapprochement bancaire (catégorisation, règles automatiques).
- [INFO MANQUANTE : structure de colonnes exacte du relevé bancaire — non remontée par l'exploration, à vérifier directement dans `importSpec` autour du `kind` bancaire dans `script.js`]

### 2.9 Fichier de suivi cumulé (généré par l'appli, pas importé)
- **Nom généré** : `` `Suivi Dashboard ${nom entreprise}.xlsx` `` (`suiviFileName()`, `script.js:2575`).
- **Colonnes** (`static SUIVI_COLS`, `script.js:2574`) : Période, Clé, CA ventes (€), Achats pêcheurs (€), Marge brute (€), Taux de marge (%), Nb ventes, Nb achats, Stock valorisé (€), Trésorerie nette (€), On me doit (€), Je dois (€), En retard à relancer (€), Mensualités crédit (€), Capital restant dû (€), Dernière mise à jour.
- **Rôle** : écriture uniquement (une ligne ajoutée/mise à jour à chaque export, fusion par clé de période).

**Aucune librairie externe de type SheetJS n'est utilisée** : tout le parsing/écriture `.xlsx` (ZIP + OOXML) est réimplémenté à la main dans `script.js` (voir §7).

---

## 3. FONCTIONNALITÉS

Le template (`index.html`) compte 330 attributs `onclick`, majoritairement des callbacks construits dynamiquement (tableaux d'objets `{label, onClick}` interpolés), pas des noms fixes par bouton. Liste des actions identifiables avec certitude :

| Bouton / action | Déclenche | Fichier(s) Excel impacté(s) | Comportement attendu vs actuel |
|---|---|---|---|
| « 🎣 Nouvel achat » (Saisie comptable) | `commitAchat()` — panier multi-espèces, moyen de paiement, chéquier | Fichier Achat pêche (écriture patch) | Fonctionnel. Le n° de chèque n'est incrémenté qu'après succès réel de l'écriture Excel (`script.js:1024`). |
| « Nouvelle vente » (Saisie comptable) | `commitVente()` — client, espèces/HT/TVA/GRENKE/TTC, délai | Fichier Ventes (écriture patch) | Fonctionnel à la création. **Modification d'une vente déjà enregistrée bloquée** (message d'erreur explicite, `script.js:870`) — divergence assumée : "corrigez directement dans Excel". |
| Enregistrement facture fournisseur | `commitFourn()` | Fichier Factures fournisseurs (écriture patch) | Idem : création OK, **modification bloquée** (`script.js:1119`). |
| Ajout de chéquier | `addChequier()` | — (localStorage `avChequiers`) | Fonctionnel, rejette les doublons de nom. |
| Connexion d'un fichier/dossier (Paramètres) | `showOpenFilePicker`/`showDirectoryPicker` puis mémorisation IndexedDB | Le fichier/dossier choisi | Fonctionnel, avec repli automatique vers `<input type=file>` si l'API n'est pas supportée. |
| « onRefreshAll » / actualisation manuelle | `refreshAll()` | Tous les fichiers/dossiers surveillés | Fonctionnel — relit tout à la demande. |
| Surveillance auto (toggle) | `toggleAutoRefresh()` | — | Fonctionnel, persisté (`avAutoRefresh`) ; scrute toutes les 20 s (`pollWatched()`, `script.js:4171`). |
| « onBackup » — Sauvegarde complète | `runBackup()` → `buildBackupZip()` | Copie de tous les fichiers Excel connectés + `etat.json` + page HTML | Fonctionnel. Génère un `.zip` nommé `Sauvegarde Dashboard <entreprise> - <date>.zip`. |
| Restauration de sauvegarde | `pickRestoreFile()` / `confirmRestore()` | — (remplace `localStorage`) | Fonctionnel, avec validation stricte (whitelist de clés, plafond de taille) puis `location.reload()`. |
| « onConnectFolder » / « onResyncFolder » | Connexion/reconnexion d'un dossier surveillé (Stock, Bordereaux, etc.) | Dossier choisi | Fonctionnel. |
| Export « Suivi Dashboard » | `runSuivi()` | Fichier de suivi cumulé (écriture, fusion par période) | Fonctionnel. |
| Carnet d'erreurs — ajout / copie | `addErrNote()` / `copyErrReport()` | — | Fonctionnel, copie presse-papiers. |
| « onGoImport » | Navigation vers Paramètres/import | — | Fonctionnel (navigation uniquement). |
| « onGoAgenda » | Navigation vers Agenda | — | Fonctionnel. |
| « onDisconnect » / « onReconnect » | Déconnexion / reconnexion d'un fichier surveillé | — | Fonctionnel ; la reconnexion redemande la permission navigateur si elle est passée en "prompt". |
| « onProfilToggle » | Changement de profil actif (admin / simplifié) | — | Fonctionnel, filtre les vues visibles. |
| « onToggleHtTtc » | Bascule affichage HT/TTC | — | Fonctionnel (affichage uniquement). |
| Rapprochement manuel Grenke / banque | Association manuelle ligne ↔ facture | — (liens stockés en localStorage) | Fonctionnel, décrit comme « sans écriture interne » (`script.js:6467`). |

**Fonctionnalités explicitement non disponibles (assumées dans le code, pas des bugs)** :
- Modifier ou supprimer une vente / un achat / une facture fournisseur déjà enregistré·e dans le fichier Excel : bloqué avec message d'erreur dédié (`script.js:847, 870, 1009, 1021, 1118, 1119`). Seule la vente a une promesse explicite : « Bientôt : correction guidée » (`script.js:870`) — non implémentée à ce jour.

---

## 4. FLUX DE DONNÉES

**Chargement** :
1. Au démarrage, `restoreHandles()` (`script.js:4093-4107`) relit les handles de fichiers/dossiers stockés dans IndexedDB (`avHandles`), teste la permission navigateur (`queryPermission`) et réapplique automatiquement ceux déjà accordés.
2. Chaque fichier est lu octet par octet, dézippé « à la main » (`unzipXlsx`), converti en lignes via `readWorkbook()`/`xlsxToText()`, la ligne d'en-tête étant détectée par score de mots-clés.
3. Les lignes importées sont mappées vers les colonnes canoniques (`importSpec`) puis stockées dans `localStorage` (une clé par source, ex. `avVentes`, `avOps`, `avFactures`…).
4. Les saisies manuelles (formulaire « Saisie comptable ») sont stockées séparément (`avVentesSaisie`, `avAchatsSaisie`, `avFournSaisie`) puis **fusionnées avec l'import Excel, dédoublonnées par numéro de facture, priorité à la saisie manuelle** (`script.js:4432`).

**Écriture vers Excel** :
1. À la validation d'un formulaire (`commitVente`/`commitAchat`/`commitFourn`), une sauvegarde datée du fichier cible est créée AVANT toute modification (`_backupBeforeWrite`, `script.js:1737-1747`).
2. `patchXlsxFile()` repart des octets originaux du fichier utilisateur et ne remplace que les cellules concernées par une opération regex sur le XML — styles, formules des autres cellules, autres feuilles et graphiques sont conservés.
3. Si la cellule cible contient déjà une formule, l'écriture peut être refusée (`opts.refuseFormula`) ou la formule est écrasée et `xl/calcChain.xml` supprimé pour éviter le message de réparation Excel.
4. Les cellules écrites par l'appli sont marquées visuellement (police Andale Mono bleue) pour que l'utilisatrice les repère dans Excel.
5. Le fichier patché est réécrit via le handle `FileSystemFileHandle` (`createWritable()`), donc directement sur le fichier d'origine dans son dossier.

**Points de synchronisation** :
- Surveillance automatique toutes les 20 secondes (`pollWatched()`) : compare `file.lastModified`, réimporte silencieusement si l'utilisatrice a enregistré une modification dans Excel.
- Actualisation manuelle via le bouton de rafraîchissement (`refreshAll()`).
- Export périodique volontaire vers le fichier de suivi cumulé (`runSuivi()`), fréquence laissée au choix de l'utilisatrice (jour/semaine/mois/trimestre/année, texte d'aide `index.html:2128`).
- Sauvegarde complète manuelle (`.zip`) via le bouton dédié.

---

## 5. RÈGLES MÉTIER DÉTECTÉES

### 5.1 Numérotation / séquences
- Pas de génération automatique de numéro de facture : les références viennent du fichier Excel importé ou de la saisie manuelle.
- Numéro de chèque géré par « chéquier » : compteur `next`/`used` par chéquier ; le numéro est **pré-calculé sans incrémenter** tant que l'écriture Excel n'a pas réussi, incrément réel seulement après succès (`script.js:1024, 1052-1053`) — logique anti-trou volontaire.
- Détection de doublons de référence à l'import : regroupement par `ref`, signalement si une référence apparaît plusieurs fois, plafonné à 25 lignes affichées (`_checkCoherence`, `script.js:4009-4028`).
- Dédoublonnage saisie manuelle ↔ import Excel par numéro de facture, priorité à la saisie manuelle (`script.js:4432, 5882`).

### 5.2 Calculs automatiques
- TTC (ventes) = Montant HT + TVA France + TVA Irlande (deux montants distincts déjà présents dans le fichier, pas de taux % calculé par l'appli).
- Marge brute (tableau de bord) = CA ventes − Achats pêcheurs ; taux de marge = marge / CA × 100.
- Montant ligne d'achat = poids × prix au kilo, arrondi à 2 décimales.
- Marge par espèce lue directement dans un bloc « RESUME BENEFICES » du fichier Stock (pas recalculée par l'appli, sauf données de démo).
- Flux net période = encaissements réels (ventes payées) − décaissements réels (achats payés), distinct de la marge comptable.
- Conversion dates ↔ numéro de série Excel (base 30/12/1899) dans les deux sens.

### 5.3 Validations
- Aucune validation HTML5 (`required`, regex de champ) : contrôles JS manuels avec messages d'erreur français, avant chaque enregistrement (titre + date, client + montant > 0, au moins une ligne de panier, nom de chéquier non dupliqué, etc.).
- Aucune validation de format email/téléphone/SIRET détectée.

### 5.4 Croisements entre fichiers
- Rapprochement registre interne ↔ export comptable : écart < 1 € → « Rapproché », sinon « Écart montant » avec delta ; facture interne non trouvée → « Absent de l'export » ; ligne export sans correspondance → « Absent du registre » (`script.js:4249-4251`).
- Rapprochement Grenke (financeur) ↔ factures ventes internes, match sur la partie numérique (`script.js:4458, 4666`).
- Rapprochement bancaire manuel (association ligne bancaire ↔ écriture interne), sans écriture retour vers les fichiers.
- Contrôle de cohérence du Stock : comparaison du récapitulatif aux feuilles détaillées par espèce.

---

## 6. ÉTAT ACTUEL

**Ce qui fonctionne** (d'après lecture du code, sans test d'exécution réel) :
- Import Excel multi-sources avec détection automatique de feuille/en-tête.
- Écriture patch en place (préservation formules/styles/graphiques) pour ventes, achats pêcheurs, factures fournisseurs.
- Sauvegarde complète `.zip` et restauration avec validation stricte.
- Export de suivi cumulé périodique.
- Surveillance automatique des fichiers et resynchronisation.
- Gestion de profils (admin / simplifié) avec restriction de vues.
- Rapprochements bancaire/Grenke/comptable.

**Ce qui est explicitement incomplet (assumé dans le code)** :
- Modification/suppression d'une vente, d'un achat ou d'une facture déjà enregistrée : bloquée, redirection vers Excel (§3). La « correction guidée » des ventes est annoncée mais non codée.
- Vue « Comptabilité analytique » marquée `hidden: true` — accessible seulement via un lien direct depuis Stock, absente du menu de navigation (`script.js:5909`). Incohérence potentielle avec l'attente d'un menu complet.

**Bugs probables / points de vigilance identifiés par lecture** :
- Aucun `TODO`/`FIXME` littéral dans le code — les seules « fonctionnalités manquantes » sont assumées et documentées par des messages utilisateur, pas des marqueurs de dette technique.
- Structure de colonnes du fichier Banque non confirmée par l'exploration (voir `[INFO MANQUANTE]` §2.8) — à vérifier avant toute intervention sur le module bancaire.
- Le rapprochement banque/interne est décrit comme « le plus lourd de la page » (commentaire `script.js:6006`, complexité O(lignes × candidats)) — risque de lenteur si le volume de lignes bancaires devient important, aucun index/optimisation mentionné.
- La compatibilité est strictement limitée à Chrome/Edge desktop (File System Access API) : toute utilisatrice sur Firefox, Safari ou mobile perd l'écriture Excel et la mémorisation de dossiers, avec repli silencieux vers `<input type=file>` (perte de la surveillance automatique, à confirmer côté UX que le repli est bien signalé partout).

**Incohérences CLAUDE.md vs code réel** :
- CLAUDE.md exige : « Interdiction absolue de recréer un monolithe ou de tout mélanger dans un seul fichier » — respecté : 3 fichiers distincts confirmés (`index.html`, `styles.css`, `script.js`).
- CLAUDE.md exige : « repère et supprime impitoyablement tous les boutons factices, les paramètres “coquilles vides” » — le bouton/lien vers la vue « Comptabilité analytique » est volontairement masqué du menu (`hidden: true`) tout en restant fonctionnel via un lien direct : ce n'est pas une coquille vide, mais l'absence du menu peut donner l'impression d'une fonctionnalité manquante à l'utilisatrice. À signaler pour arbitrage (menu visible ou suppression du lien caché).
- Aucune autre divergence structurelle détectée entre les directives de CLAUDE.md et le code lu (routage propre observé entre `SaisieCompta` et les vues métier, pas de doublon de fonction repéré par l'exploration).

---

## 7. DÉPENDANCES TECHNIQUES

- **Aucune bibliothèque externe** : ni SheetJS, ni PapaParse, ni framework front (pas de React/Vue/Angular). `index.html` ne référence que `styles.css` et `script.js` en local (`index.html:7, 3273`) — aucun `<script>` CDN.
- **Aucune API externe / réseau** : l'application revendique fonctionner « 100 % hors ligne » (`script.js:5698, 5780`).
- **Moteur de template custom** : tags `sc-if` (436 occurrences) et `sc-for` (308 occurrences) dans `index.html`, avec `hint-placeholder-val`/`hint-placeholder-count` — système de templating maison, pas une lib connue. [INFO MANQUANTE : nom/documentation de ce moteur de template — le moteur d'exécution (parsing des tags `sc-if`/`sc-for`) n'a pas été localisé dans `script.js` par l'exploration, à investiguer si besoin de le faire évoluer]
- **API navigateur requises** :
  - File System Access API (`showOpenFilePicker`, `showDirectoryPicker`, `FileSystemFileHandle.createWritable`) — Chrome/Edge desktop uniquement.
  - IndexedDB (base `avHandles`) pour mémoriser les handles de fichiers/dossiers entre sessions.
  - `CompressionStream`/`DecompressionStream` (`deflate-raw`) pour le zip/dézip natif des fichiers `.xlsx`/sauvegardes `.zip`.
  - `localStorage` pour toutes les données métier (48 clés recensées, préfixe `av`).
- **Contrainte navigateur explicite** répétée dans l'UI (~10 endroits) : « Fonctionne sur Chrome ou Edge (ordinateur) ».

---

## 8. PROMPT DE RECONSTRUCTION

```
Construis une application web mono-page en français, 100 % hors ligne, sans framework
ni dépendance externe, séparée strictement en 3 fichiers : index.html, styles.css,
script.js (aucun monolithe, aucun CDN). Il s'agit d'un dashboard de pilotage pour une
assistante de direction d'une entreprise de mareyage/pêche (achat de poisson à des
pêcheurs, vente à des clients), qui utilise les fichiers Excel existants de
l'entreprise comme UNIQUE source de vérité — l'application ne doit jamais imposer sa
propre base de données.

CONTRAINTES TECHNIQUES CLÉS :
- Aucune librairie externe (pas de SheetJS/xlsx-lib). Réimplémente en JS pur : un
  lecteur/écrivain ZIP minimal (signatures PKZIP 0x04034b50 / 0x02014b50 / 0x06054b50),
  un générateur OOXML minimal (.xlsx = Content_Types + _rels + xl/workbook.xml +
  xl/worksheets/sheetN.xml), en t'appuyant sur les API navigateur natives
  CompressionStream/DecompressionStream (deflate-raw) pour compresser/décompresser.
- Utilise la File System Access API (showOpenFilePicker, showDirectoryPicker,
  FileSystemFileHandle.createWritable) pour lire ET écrire directement dans les
  fichiers Excel choisis par l'utilisatrice sur son disque — précise clairement que
  cela ne fonctionne que sur Chrome/Edge desktop, avec repli vers <input type=file>
  en lecture seule sinon.
- Mémorise les handles de fichiers/dossiers choisis dans IndexedDB (une base dédiée,
  un seul object store clé/valeur) pour ne pas redemander la sélection à chaque
  session ; redemande la permission navigateur (queryPermission/requestPermission)
  si elle a expiré.
- Stocke toutes les données métier dans localStorage (import Excel + saisies
  manuelles), avec un préfixe commun aux clés pour permettre une sauvegarde/
  restauration globale.
- Écriture Excel = PATCH EN PLACE : ne jamais régénérer tout le fichier depuis zéro
  lors d'une saisie. Repartir des octets originaux, ne modifier que la/les cellule(s)
  concernée(s) par une manipulation ciblée du XML de la feuille, afin de préserver
  formules, styles, mises en forme et graphiques existants dans les autres cellules
  et feuilles. Avant toute écriture, sauvegarder automatiquement une copie datée du
  fichier cible. Refuser ou avertir si la cellule cible contient déjà une formule.
  Marquer visuellement (police/couleur distincte) les cellules écrites par
  l'application pour que l'utilisatrice les repère dans Excel.

SOURCES DE DONNÉES À GÉRER (chaque source = un fichier ou un dossier Excel connecté
séparément par l'utilisatrice, jamais de nom de fichier figé en dur) :
1. Ventes clients : colonnes Date, Numero de facture, Nom du client, Montant TTC,
   Montant regle, Date echeance, Sens, Etat, Montant HT, Delai de paiement, Solde,
   Paye le. TTC = Montant HT + TVA France + TVA Irlande (deux montants distincts, pas
   de taux %). Détecte la bonne feuille par mots-clés (paiement/factur/vente).
2. Achat pêche (achats aux pêcheurs) : colonnes Date, Type, Partenaire, Montant,
   Statut, Reference, Paye, Solde. Écriture avec N° de facture, Année, Date, Nom du
   pêcheur, Montant, N° de chèque, Total payé, Date de paiement, Solde.
3. Factures fournisseurs : colonnes Date, Fournisseur, Numero de facture, Montant
   TTC, Montant regle, Date paiement, Sens. Feuilles mensuelles. Gère deux tableaux
   côte à côte dans la même feuille (ex. FOURNISSEURS et FOURNISSEURS CRUSTACÉS) —
   il faut savoir déplier deux blocs de tableau juxtaposés en une seule liste.
4. Crédits & assurances : colonnes Denomination, Entreprise, Montant total,
   Mensualite, Restant (saisie manuelle, pas d'écriture Excel).
5. Bordereaux de livraison : colonnes Date, Bordereau, Destinataire, Facture, Colis,
   Transporteur, Statut (dossier surveillé, lecture seule).
6. Stock : dossier surveillé, un fichier par semaine, colonnes semaine/poids/
   valorisation. Cas particulier : une feuille RECAP sans colonne semaine produit une
   seule ligne TOTAL par fichier. Compare le récapitulatif aux feuilles détaillées
   par espèce et signale les écarts.
7. Export comptable : colonnes Date, Numero de facture, Partenaire, Montant — sert
   uniquement au rapprochement avec le registre interne (écart < 1€ = rapproché,
   sinon écart signalé avec montant du delta ; entrées manquantes des deux côtés
   signalées séparément).
8. Relevé bancaire : import + catégorisation manuelle/par règles automatiques +
   rapprochement manuel avec les écritures internes (ventes/achats), sans écriture
   retour vers les fichiers Excel.
9. Fichier de suivi cumulé généré par l'application (pas importé) : nommé
   « Suivi Dashboard <nom entreprise>.xlsx », une ligne par période (jour/semaine/
   mois/trimestre/année au choix), colonnes : Période, Clé, CA ventes, Achats
   pêcheurs, Marge brute, Taux de marge, Nb ventes, Nb achats, Stock valorisé,
   Trésorerie nette, On me doit, Je dois, En retard à relancer, Mensualités crédit,
   Capital restant dû, Dernière mise à jour. Chaque export relit le fichier existant
   et fusionne par clé de période (jamais de doublon).

DÉTECTION AUTOMATIQUE DE FEUILLE/EN-TÊTE : dans chaque classeur importé, détecte la
ligne d'en-tête en testant les 20 premières lignes de chaque feuille candidate et en
comptant les correspondances avec une liste de mots-clés métier (date, montant,
fournisseur, client, facture, paiement, semaine, solde, denomination, mensualite,
prix, poids, destinataire, bordereau, total) — la ligne avec le plus de
correspondances devient l'en-tête. Pour chaque colonne canonique attendue, cherche
dans les en-têtes réels des mots-clés tolérants à la casse/accents (ex. "montant
regle"/"réglé"/"payé"/"encaissé"/"paiement"/"chèque" désignent tous le même champ).

VUES DE NAVIGATION (menu latéral, groupé) :
- Piloter : Tableau de bord (CA, achats, marge, trésorerie), Agenda
- Saisie : Saisie comptable (formulaire « Nouvel achat pêcheur » multi-espèces avec
  moyen de paiement/chéquier, et « Nouvelle vente » avec HT/TVA/TTC/délai) — chaque
  saisie alimente directement stock/journal/statistiques et remonte dans les onglets
  Ventes/Achat pêche, dédoublonnée par numéro de facture (priorité à la saisie
  manuelle en cas de doublon avec l'import Excel)
- Ventes & clients : Ventes, Suivi de paiement, Financement Grenke (financeur tiers,
  rapprochement par numéro), Clients
- Achats & stock : Achat pêche, Facture fournisseur (+ onglet Rapprochement),
  Comptabilité analytique (marge par espèce, masquée du menu mais accessible depuis
  Stock), Stock
- Finances : Banque, Crédits
- Gestion : Heures, Employés, Messages (messagerie interne locale), Bordereaux,
  Bibliothèque (documents indexés depuis un dossier), Véhicules
- Paramètres (réservé aux profils admin) : connexion des fichiers/dossiers, gestion
  des profils, sauvegarde/restauration, mode démo, objectifs

GESTION DES PROFILS : un profil "admin" voit toutes les vues ; un profil "simplifié"
ne voit que les vues explicitement cochées pour lui, et n'a jamais accès à
Paramètres. Le dernier profil admin ne peut être ni supprimé ni rétrogradé.

RÈGLES MÉTIER À REPRODUIRE :
- Numérotation de chèque par chéquier (nom, numéro de départ, compteur "next") : le
  numéro est pré-calculé à l'affichage mais SEULEMENT incrémenté après succès réel
  de l'écriture dans le fichier Excel (jamais avant), pour éviter tout trou de
  numérotation en cas d'échec d'écriture.
- Détection de doublons de référence/facture à l'import (regroupement par numéro,
  alerte si plusieurs occurrences).
- Marge brute = CA ventes − Achats pêcheurs ; taux de marge = marge / CA × 100.
  Montant d'une ligne d'achat = poids × prix au kilo (arrondi 2 décimales). Flux net
  de période = encaissements réels − décaissements réels (distinct de la marge
  comptable).
- Conversion des dates entre format ISO et numéro de série Excel (base 30/12/1899)
  dans les deux sens, avec tolérance de plusieurs formats de saisie (jj/mm/aaaa,
  aaaa-mm-jj, série Excel).
- INTERDICTION explicite de modifier ou supprimer une vente/un achat/une facture déjà
  enregistré·e depuis l'interface : rediriger vers une correction manuelle dans
  Excel, avec message d'erreur clair. Ne pas complexifier avec un mode édition tant
  que l'écriture patch ne le gère pas explicitement.
- Validations de saisie 100 % en JavaScript (pas de required HTML), avec messages
  d'erreur clairs en français : champs obligatoires, montants > 0, au moins une
  ligne de panier, noms de chéquier non dupliqués.

FONCTIONNALITÉS TRANSVERSES :
- Sauvegarde complète : génère un fichier .zip (construit manuellement, pas de lib)
  contenant une copie HTML autonome de l'application, un JSON de tout le
  localStorage préfixé, une copie de chaque fichier Excel connecté, et un fichier
  LISEZMOI explicatif. Nommage : "Sauvegarde Dashboard <entreprise> - <date
  AAAA-MM-JJ HHhMM>.zip".
- Restauration : lit le .zip, exige la présence du JSON d'état, valide chaque clé
  contre une whitelist stricte de clés autorisées, plafonne la taille par valeur et
  au total, remplace tout le localStorage préfixé puis recharge la page.
- Surveillance automatique des fichiers connectés (vérification périodique toutes
  les 20 secondes de la date de dernière modification), réimport silencieux en cas
  de changement, avec bouton d'actualisation manuelle et interrupteur pour
  désactiver la surveillance automatique.
- Recherche globale transverse sur toutes les données (ventes, achats, factures,
  Grenke, bordereaux), avec navigation directe vers la page filtrée correspondant au
  résultat cliqué.

Respecte un style d'interface professionnel, sobre, en français, pensé pour un usage
quotidien de gestion (pas de jargon technique visible pour l'utilisatrice finale) —
la charte graphique exacte n'a pas besoin d'être reproduite à l'identique, seul le
comportement fonctionnel compte.
```
