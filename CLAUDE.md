# Instructions du Projet — Dashboard Assistante de Direction (Faustine)

## Rôle & Posture
- Tu agis en tant que **Développeur Web Senior Full-Stack**, expert en architecture logicielle, ergonomie et propreté du code.
- **Esprit critique & Devoir de conseil :** Ne sois pas un simple exécutant. Si une de mes demandes est une mauvaise idée, risque de bloquer Faustine au quotidien ou mène "dans le mur", signale-le immédiatement, explique pourquoi et propose une solution plus fluide et solide.

## Standards & Bonnes Pratiques
- **Normes de l'industrie :** Respecte scrupuleusement les standards modernes du web (code propre, sémantique HTML5, performance, accessibilité et sécurité).
- **Interface & Ergonomie :** L'outil doit être fluide, intuitif et parfaitement taillé pour les besoins de gestion d'une assistante de direction.

## Directives de Nettoyage & Refactoring
- **Code mort & Décoration :** Repère et supprime impitoyablement tous les boutons factices, les paramètres "coquilles vides", les variables inutilisées et le code de démonstration non fonctionnel.
- **Fonctionnalités :** Ne conserve que ce qui est 100 % opérationnel. Aucune option "fantôme" ne doit subsister dans l'interface.
- **Simplicité :** Privilégie la simplicité d'utilisation sans sur-ingénierie ni dépendances inutiles.

## Consignes de Travail
- **Validation :** Demande confirmation avant d'appliquer des modifications majeures ou d'effacer des pans entiers de code.
- **Explications :** Fournis un résumé synthétique, clair et direct de ce qui a été supprimé ou corrigé à chaque étape.
- **Compactage :** lancer /compact régulièrement (toutes les 30-40 échanges) pour préserver le contexte et économiser les tokens.

## Langue
- Toutes les interactions dans le terminal, les retours de statut, les rapports d'erreurs et les commentaires de code doivent être rédigés exclusivement en **français**.

## Architecture du Code
- Le code doit impérativement rester séparé en 3 fichiers distincts et propres :
  - `index.html`
  - `styles.css`
  - `script.js`
- Interdiction absolue de recréer un monolithe ou de tout mélanger dans un seul fichier.

## Gestion des Doublons et Routage
- Avant toute modification, vérifier et supprimer systématiquement les fonctions en double ou mal routées (notamment entre les vues comme 'piloter' et 'saisie comptable').
- Garantir que chaque bouton pointe directement vers la bonne fonction dédiée.

## Contraintes Système
- 100% offline, aucune connexion internet
- Fichiers Excel en local uniquement
- Serveur local localhost:8080 pour contourner 
  les restrictions file:// de Chrome
- Navigateurs supportés : Chrome et Edge desktop 
  uniquement (File System Access API requise)

## Fichiers Excel Sources
- ventes : suivi des paiements clients, 
  lecture + écriture, toujours feuille 0
- operations : achats pêcheurs, lecture + écriture,
  triple écriture (pêcheur + chèque + stock)
- factures : fournisseurs, lecture + écriture,
  12 feuilles mensuelles + 2 tableaux côte à côte
- credits : crédits et assurances, lecture seule
- bordereaux : livraisons, lecture seule, 
  dossier surveillé
- comptable : export comptable, lecture seule,
  rapprochement uniquement
- banque : relevé bancaire, lecture seule
- stock : pipeline dédié, dossier surveillé,
  un fichier par semaine

## Règles Métier Critiques
- Numérotation facture : premier numéro non utilisé
  dans le fichier Excel source, jamais depuis les
  saisies locales seules
- Numéro de chèque : incrémenté UNIQUEMENT après
  succès réel de l'écriture Excel
- Modification/suppression d'une écriture existante :
  INTERDITE depuis l'interface, rediriger vers Excel
- Total mensuel heures théorique : 151.67h
- Dates Excel : toutes les dates écrites dans
  les fichiers Excel doivent être au format
  numérique série Excel (pas du texte).
  Utiliser _excelSerial(dateIso) pour convertir
  avant toute écriture de date. Si la cellule
  cible est neuve (ligne créée par le dashboard,
  donc sans format), déclarer sa colonne dans
  dateCols pour qu'un format de date lui soit
  appliqué — sans quoi la série s'affiche en
  nombre brut (ex. 46231).
- Aucune dépendance externe, tout en JS pur

## Bugs Corrigés (ne pas réintroduire)
- _locateAppendTarget : filtre formules et 
  libellés agrégat (total/somme/solde/report/cumul)
- ctxStop : défini dans renderVals(), 
  était manquant et cassait toutes les modales
- Bascule HT/TTC : suit amountMode correctement
- Numérotation : intègre les numéros du fichier Excel
- Colonnes qui n'étaient JAMAIS remplies :
  « Paiement » et « Date paiement » du fichier
  fournisseurs (fournWriteValues les forçait à
  vide, aucun autre circuit ne les remplissait) →
  circuit requestPaiementFournPreview. Et le
  Commentaire Grenke, qui n'avait aucune colonne
  et était détruit au nettoyage de la fiche locale.
- Détection de la colonne commentaire : ne JAMAIS
  tester includes('com') — « customer » contient
  aussi « com », le commentaire écraserait le nom
  du client. Utiliser _isComHeader().
- Marquage d'une ligne (annulé) : passer par
  _markRowAnnule, qui ne réécrit QUE l'attribut de
  style des cellules. Ne jamais le faire via
  patchXlsxFile : il remplace la cellule entière et
  détruirait les formules de la ligne (Solde…).
- <strike/> dans une police : se place APRÈS <b/>
  et <i/> et AVANT le reste (séquence CT_Font
  d'ECMA-376). Un mauvais ordre déclenche la
  réparation du fichier par Excel.
- États du suivi de paiement : vocabulaire UNIQUE
  (constantes ETAT_*) partagé par _venteEtat,
  _paySuiviEtat et _etatAttendu. Si les trois
  divergent, chaque paiement enregistré ressort
  aussitôt « en écart » à la relecture.
- Duplicata de facture : ne JAMAIS déduire le reste
  dû de « TTC moins réglé ». Sur les factures
  reprises d'Excel, la colonne « payé » est souvent
  vide alors que la facture est soldée — seul l'état
  porte l'information. Le calcul faisait réclamer à
  un client une somme déjà encaissée. Ordre correct :
  colonne reste → état soldé → règlement connu →
  état impayé → sinon « non renseigné ».
- Annulation : ne jamais vider la ligne ni stocker
  les infos dans un commentaire Excel (zone la plus
  fragile du classeur : perdue via
  Google Sheets/LibreOffice, supprimée par une
  réparation Excel, et accrochée à une cellule donc
  décalée dès qu'on trie). La ligne reste intacte,
  seulement barrée et grisée.

## Réglage de l'écriture (colonnes)
- Les colonnes d'écriture sont DÉTECTÉES automatiquement
  à partir des en-têtes (_writeKw + _autoWriteCols).
  L'assistant de pointage manuel ne sert plus que de
  repli quand un champ essentiel manque.
- _autoWriteCols fait DEUX passes GLOBALES : toutes les
  égalités strictes d'abord, les correspondances
  partielles ensuite. Champ par champ, un libellé
  générique traité tôt raflerait en `includes` la
  colonne qu'un champ précis prendrait en égalité
  (« Date » volant « Date de paiement »).
- PIÈGE (même famille que includes('com')) : la passe
  `includes` ignore les mots-clés de moins de 4
  caractères. « an » est contenu dans « montant »,
  « ht » dans « chiffre ». Les mots courts ne servent
  qu'à l'égalité stricte.
- Fichier fournisseurs : la recherche est BORNÉE aux
  colonnes du bloc courant (deux tableaux côte à côte),
  sinon on marque les lignes du bloc voisin.
- La colonne « Annulé » se répare à chaud
  (_retrouveColAnnule) : elle manquait à
  _detectFacturesSheet, ce qui rendait le bouton ⊘ des
  factures fournisseurs définitivement inopérant.

## Classeur de stock (modèle, contrôle, calculs)
- La RÉFÉRENCE est une empreinte du fichier modèle
  désigné par l'utilisatrice (clé avStockModele),
  capturée par enregistrerModeleStock(). Elle ne
  change QUE par l'import d'un nouveau modèle.
- La lecture d'un fichier de semaine est TOLÉRANTE :
  seuls les libellés font foi, jamais les coordonnées.
  Les variantes existent réellement dans les fichiers :
  « COMMANDES - SORTIE » / « VENTE - SORTIE »,
  « ACHAT - ENTREE » / « ACHAT -  ENTREE » (double
  espace), libellé suivi de retours ligne.
- PIÈGE : _norm appelle toLowerCase. Toute cellule
  passée aux marqueurs doit être convertie par
  String() — une cellule de stock contient souvent un
  NOMBRE (stock précédent, code client), et sans la
  conversion la lecture de structure plante et le
  fichier entier devient illisible.
- PIÈGE : une ligne de TOTAL porte les mêmes colonnes
  que les lignes de données. L'inclure double tous les
  chiffres. estTotal() arrête le bloc dessus.
- Une structure d'une autre génération (bloc achat ou
  sortie introuvable) part dans `nonCalculables` et
  n'est JAMAIS comptée 0 en silence : les anciens
  fichiers contiennent de vraies données, un zéro
  muet ferait croire à une semaine sans activité.
- Pourquoi tout recalculer : le RECAP VENTES du modèle
  ne récapitulait que 5 espèces sur 9, et 4 de ces 5
  lignes visaient de mauvaises cellules. Par ailleurs
  IFERROR(...,"-  € / Kg") renvoie du TEXTE quand une
  espèce n'a rien vendu, que le récap multiplie par un
  poids → #VALUE! sur le total de la semaine entière.

## Report du stock d'une semaine sur l'autre
- Le reliquat entre par DEUX endroits complémentaires :
  la case « STOCK PRECEDENT » (poids total, lecture
  d'un coup d'œil) et une LIGNE du bloc ACHAT - ENTREE
  libellée « STOCK SEMAINE PRECEDENTE » à la place du
  nom du client, qui porte le détail par calibre.
  C'est cette ligne qui fait entrer le report dans les
  totaux, sans traitement particulier ailleurs.
- Le report est valorisé au prix moyen d'ACHAT du
  calibre : reporter un poids sans sa valeur ferait
  tomber le stock valorisé à zéro et fausserait la marge.
- Garde-fous : jamais d'écrasement d'une ligne où un
  pêcheur est saisi ; report déjà présent = mis à jour,
  pas dupliqué ; calibres différents entre les deux
  semaines = refus explicite ; reliquat négatif (sorties
  > entrées) signalé et NON reporté.
- Totaux et saisie manuelle : les totaux étant des
  VALEURS, ils ne se mettent plus à jour seuls. On ne
  leur fait donc JAMAIS confiance — ecartsTotauxStock()
  recalcule et compare à chaque lecture. Une case vide
  est signalée « vide », pas « fausse ». Tolérance de
  5 millièmes pour les arrondis.

## Documents édités (impression / PDF)
- Un navigateur n'expose AUCUNE API d'imprimante :
  la Web Printing API de Chrome est réservée aux
  Isolated Web Apps. Le seul levier est
  window.print(), et le <title> du document devient
  le nom proposé dans « Enregistrer au format PDF ».
- Circuit UNIQUE : tout bouton Imprimer appelle
  openDocument(type, html, vars). Le type porte un
  modèle de nom à jetons ({numero}, {tiers}, {date},
  {periode}…) et un mode (demander / imprimer / PDF),
  réglés dans Paramètres → Gestion des documents.
- Ne JAMAIS rajouter un window.print() direct sur un
  bouton : le nom de fichier et le mode choisis par
  l'utilisatrice seraient ignorés.
- Au passage Electron, _emitDoc() est le SEUL point
  à reprendre : webContents.print({ silent,
  deviceName, copies }) et printToPDF(). Les
  gabarits, les modèles de nom et la pop-up ne
  bougent pas.
- Les gabarits reçoivent les valeurs DÉJÀ calculées
  par la vue (fiche tiers). Ne jamais recalculer
  dans le gabarit : le papier doit être le reflet
  exact de l'écran.

## Déploiement final (à faire en dernier)
- Empaqueter avec Electron pour usage desktop Windows
- Une seule utilisatrice : Faustine
- Objectif : double-clic sur icône, zéro terminal

Note architecture : au moment du passage 
Electron, retirer server.py, l'endpoint 
/open-file et la contrainte Chrome/Edge. 
Les remplacer par fs Node (lecture/écriture 
Excel) et shell.openPath (ouverture Excel). 
La règle "aucune dépendance externe" 
s'applique au code métier uniquement, 
pas au packaging final.
