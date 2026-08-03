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
- Statut des achats pêcheur : rendu par un <span>,
  jamais par un <button>. Ces lignes ne fournissent ni
  statusButtonStyle ni onResolve — le bouton s'affichait
  nu (police et cadre par défaut du navigateur) et ne
  faisait rien au clic. Vérifier qu'un placeholder de
  style existe VRAIMENT dans le constructeur de lignes
  avant de le poser dans le gabarit.
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
- États des dossiers Grenke : même règle que les
  ETAT_* du suivi de paiement. Vocabulaire UNIQUE
  (GRK_FINANCE / GRK_ATTENTE / GRK_PARTIEL /
  GRK_SOLDE), état TOUJOURS déduit par _grenkeEtat
  (montant financé, p1, p2, charges, restant dû,
  réception), JAMAIS recopié de la cellule Excel.
  GRENKE_STATUT n'est plus une chaîne concurrente :
  c'est GRK_ATTENTE. Avant, trois vocabulaires
  coexistaient (« En attente paiement Grenke » écrit
  dans Excel, « En cours » codé en dur à la création
  d'une fiche — un mot absent de tous les fichiers —,
  et `g.statut || '—'` à l'affichage) : le même
  dossier portait trois états selon l'endroit d'où on
  le regardait.
- PIÈGE (même famille que ETAT_*) : ce que le tableau
  de bord ÉCRIT et ce que la relecture ATTEND doivent
  coïncider. Une ligne présente dans la feuille
  « Grenke » est par définition un dossier transmis
  (drapeau `transmis`) : sans lui, une vente écrite à
  l'instant en GRK_ATTENTE ressortirait aussitôt « en
  écart » vers GRK_FINANCE à chaque démarrage.
- _grkEtatConnu : ORDRE des tests. « partiel » AVANT
  les mots du solde, sinon « PARTIELLEMENT RÉGLÉ »
  (qui contient « regle ») serait rattaché à SOLDÉ.
  Les libellés hérités (« sold out », « En cours »,
  « paid ») sont reconnus et rattachés à la constante
  la plus proche ; un texte non reconnu est montré tel
  quel dans l'aperçu, jamais deviné ni écrasé en
  silence — la correction passe par _grenkeEcarts →
  requestVerifPreview (aperçu, sauvegarde datée,
  écriture, relecture de contrôle).
- Cellule « Remains » VIDE n'est pas un zéro. La
  traiter comme 0 ferait déclarer « soldé » un dossier
  dont rien n'a été encaissé (même famille d'erreur
  que « TTC moins réglé » sur les duplicata).
- Tableau Grenke : UN SEUL, import Excel + saisies
  locales fusionnés et dédoublonnés par n° de dossier
  (la saisie l'emporte). Un dossier SANS numéro
  exploitable reçoit une clé propre (`loc#id` /
  `xl#rang`) : dédoublonner sur une clé vide ferait
  disparaître toutes les lignes sans numéro sauf une.
- PIÈGE renderVals (zone morte temporelle) : les
  centaines de `const` de renderVals partagent UNE
  portée. Réutiliser dans le bloc Grenke un style
  déclaré plus bas (payRowBtnStyle) lève un
  ReferenceError au premier rendu de l'onglet. Chaque
  bloc déclare les styles qu'il pose.
- Relecture automatique : un seul chemin
  (relectureAuto), verrou `_relectureEnCours` comme
  `_stockRecalcEnCours`. On compare d'abord
  file.lastModified et on ne relit intégralement que
  ce qui a bougé — relire tous les classeurs à chaque
  tour figerait l'écran plusieurs secondes.
  refreshFolders() force la relecture COMPLÈTE des
  dossiers : réservé au mode forcé (bouton Rafraîchir).
  Minuteries rendues (clearInterval) à la mise en
  arrière-plan et sur beforeunload.
- Le bandeau de relecture ne dit JAMAIS « aucun
  changement » quand rien n'était connecté : il compte
  les documents surveillés (`docs`) et le dit.
- Numérotation de vente, les « 7000 et plus » :
  _venteNextId prenait le MAXIMUM des chiffres des n°
  de facture du fichier (`state.ventes`) et des ID du
  suivi de paiement (contenu du fichier lui aussi).
  Sur le classeur réel il valait 7023, et ce 7023
  s'affichait comme « ID facture » au formulaire
  (index.html liait `venteDraft.id` alors que
  refreshVenteIdFacture remplissait `venteDraft.idFacture`,
  lu du fichier), puis servait de référence de repli
  « FV-7023 » aux listes — une facture inexistante dans
  le fichier source, et la vente affichée EN DOUBLE.
  RÈGLE : une clé interne est PRÉFIXÉE (« L12 ») et
  _refEcrivable interdit à toute clé interne (L…, FV-…,
  AP-…) d'atteindre une cellule Excel. Le n° de facture
  ET l'ID Facture se lisent sur LA MÊME ligne cible
  (refreshVenteNumeros).
- Dédoublonnage des ventes : DEUX passes. Par numéro
  (la saisie manuelle l'emporte), puis RATTRAPAGE par
  signature métier (type + tiers + date + montant) —
  une saisie locale dont le numéro est inconnu du
  fichier mais dont la signature s'y retrouve est un
  doublon déjà créé ; c'est la ligne LOCALE qui saute,
  le fichier fait foi. Sans cette 2e passe, un correctif
  ne vaut que pour l'avenir et laisse les doublons déjà
  présents chez l'utilisatrice.
- « 7000 et plus », TROISIÈME signalement : le correctif de
  20dbcfc a été REJOUÉ dans les conditions de Faustine
  (saisies locales portant des numéros absents du fichier,
  doublons déjà créés, saisie sans numéro). Il tient : le
  doublon accroché au 7023 disparaît par la 2e passe de
  dédoublonnage (signature métier), la vraie ligne du fichier
  est conservée, et le bouton de nettoyage retire le reste.
  Ce qui manquait n'était pas du code mais du SIGNALEMENT :
  une saisie locale que le fichier ne recoupe NI par le
  numéro NI par la signature reste visible (on n'efface
  jamais d'office une vente peut-être réelle), et rien ne le
  disait — Faustine la retrouvait dans ses chiffres.
  LIVRÉ : bandeau orange sur le tableau de bord dès qu'il
  reste des saisies fantômes — nombre, part de doublons,
  numéros fautifs cités, nettoyage en un clic, masquable
  pour la session (alertsHidden.fantomes). Un problème
  silencieux qui revient trois fois est un problème de
  signalement autant que de code.
- PIÈGE rencontré en posant ce bandeau : `fantomesInfo` était
  déclaré tout en bas de renderVals alors que les alertes du
  tableau de bord sont construites bien plus haut. Le
  déplacer était OBLIGATOIRE (zone morte temporelle : une
  seule portée pour toutes les const de renderVals).
- Bouton « Saisies de vente fantômes » (Paramètres) :
  ne JAMAIS l'activer quand `state.ventes` est vide ou
  nul — toutes les saisies passeraient pour fantômes et
  seraient effacées. Il ne touche que le stockage local.
- <input type="number"> et la VIRGULE : Chrome refuse la
  virgule décimale et renvoie une valeur VIDE. Un montant
  saisi « 412,50 » devenait 41250 ou 0. TOUT champ de
  montant est un `type="text" inputmode="decimal"` lu
  par _vNum. Idem pour Number() : les objectifs saisis
  « 32 000,50 » devenaient NaN et repassaient en silence
  à la valeur par défaut.
- <input type="date"> ET rendu complet : Chrome émet
  « change » DÈS que la date devient momentanément
  valide (au 1er chiffre de l'année : 2026 → an 0002).
  Comme chaque setState remplace TOUT le DOM, le champ
  en cours de frappe était détruit et le curseur ramené
  au premier segment — date littéralement impossible à
  saisir. RÈGLE : toute saisie de date passe par `dateH`
  (_renderQuiet : l'état change, aucun ré-affichage) et
  par `onchange`, jamais `oninput` ; le rattrapage se
  fait à la sortie du champ (onDateBlur).
- PIÈGE du rattrapage : le « blur » a lieu à l'APPUI de
  la souris. Rafraîchir immédiatement détruit le bouton
  visé entre l'appui et le relâchement, et le clic est
  purement perdu. onDateBlur attend donc la fin du clic
  en cours (écoute `click` en remontée) avec une
  temporisation de secours.
- Fond d'une modale de SAISIE : ne referme que si (a) le
  clic a bien COMMENCÉ sur le fond (une sélection de
  texte relâchée à côté produit un « click » dont la
  cible est le fond) et (b) RIEN n'a été tapé. Sinon on
  le dit et on garde la fiche. Une saisie ne doit jamais
  disparaître sur un clic malheureux.
- PAIEMENT PAR CHÈQUE IMPOSSIBLE À VALIDER (bloquant,
  signalé par Faustine). Trois causes cumulées, aucune
  visible :
  (1) la validation EXIGEAIT un chéquier sélectionné
  (`!pd.chequier` → refus). Or le chéquier n'est qu'une
  ÉTIQUETTE : la feuille du chèque est retrouvée par le
  NUMÉRO (_chequeSheetForNumber, préfixe à 3 chiffres,
  516001 → feuille « 516000 »), le nom du carnet n'étant
  qu'un repli. Et quand aucun onglet chéquier n'est
  détecté, la liste déroulante ne propose QUE
  « — aucun chéquier détecté — » (valeur VIDE) : la
  condition était littéralement impossible à satisfaire.
  RÈGLE : n'exiger le carnet que si le numéro fait moins
  de 3 chiffres.
  (2) le refus n'était écrit que dans le BANDEAU GLOBAL,
  en haut de page. Le formulaire Paiement pêcheur est
  précédé de la liste complète des factures d'achat :
  au moment du clic, le bandeau est à plusieurs écrans
  au-dessus. Le bouton paraissait inopérant, sans un mot.
  RÈGLE : tout refus passe par _formErr(zone, texte) —
  bandeau global ET message rouge posé JUSTE au-dessus
  du bouton concerné (zones « paiement », « chqadd »,
  « achat »). Un bouton qui refuse d'agir dit pourquoi,
  LÀ OÙ ON CLIQUE.
  (3) le mode Chèque n'avait AUCUN champ montant : il
  soldait toujours la facture entière. Un chèque partiel
  était donc impossible. Champ ajouté, `type="text"
  inputmode="decimal"` lu par _vNum (jamais type=number,
  cf. la virgule), pré-rempli au solde restant ; laissé
  vide il garde l'ancien comportement.
- Achat pêcheur, n° de chèque JETÉ en silence : quand
  aucun onglet chéquier n'était détecté, commitAchatSaisie
  ne remplissait `chequeNum` que `if (cq)`. Le numéro
  RÉELLEMENT tapé disparaissait, et l'étape « chèque »
  basculait en échec après l'écriture pêcheur. Le numéro
  saisi fait foi ; le carnet ne sert qu'à proposer le
  suivant.
- _paiementOpsSetup accepte une ZONE. « silent » (relecture
  d'état, _refreshChqLiveStatus) ne peint pas le formulaire
  en rouge : sans ça, la simple sélection d'une facture
  affichait une erreur avant tout clic sur un bouton.
- Suivi de paiement, AUTO-REMPLISSAGE par le n° de facture
  (demande de Faustine : « que je ne rentre que le
  paiement »). « ID Facture » et « Numéro de facture » sont
  DEUX colonnes distinctes du fichier de ventes
  (writeFieldsFor('ventes')) et RIEN ne permet de déduire
  l'une de l'autre : les lignes anciennes, saisies à la main
  dans Excel, ont souvent un ID vide ou sans rapport (c'est
  d'ailleurs pour ça que requestPaiementClientPreview
  cherche la ligne par ID PUIS par numéro). On n'écrase donc
  JAMAIS la colonne ID et on n'invente aucun identifiant :
  la RECHERCHE accepte l'un OU l'autre (_factureParRef, clé
  invoiceKey), et l'ID affiché est celui de la facture
  trouvée. Une facture repérée dans l'onglet « Factures »
  mais absente du suivi n'a PAS d'ID : on le dit, on n'en
  fabrique pas (règle des « 7000 »).
  Rien trouvé ⇒ RIEN de pré-rempli, et ce qu'un numéro
  précédent avait rempli est effacé (`_auto` / `_idAvant`
  dans le brouillon) — sinon l'écran montrerait les données
  d'une AUTRE facture sous le numéro courant.
  Ces clés internes ne sortent jamais du brouillon :
  commitPay reconstruit `rec` champ par champ.
- commitPay : `+d.id || _payNextId()` renvoyait NaN sur un
  ID NON NUMÉRIQUE (fréquent sur les lignes anciennes) et le
  remplaçait par un numéro FABRIQUÉ, qui ne correspondait
  alors à aucune ligne du fichier. Même famille que les
  « 7000 ». L'ID est repris tel quel, chaîne comprise.
- Le champ « Montant réglé » du suivi est un TOTAL cumulé
  (c'est lui qui part dans la colonne Excel), pas le dernier
  encaissement. L'auto-remplissage le pré-remplit avec le
  déjà-réglé du fichier et l'écrit noir sur blanc sous le
  formulaire : sans cette phrase, saisir « le chèque du
  jour » écraserait les règlements précédents.
- SAUVEGARDE / RESTAURATION, le filet qui n'existait pas
  (bloquant, 4 anomalies d'audit pour UNE cause) :
  buildBackupZip exportait « toutes les clés av… » et
  validateRestoreState les validait contre une LISTE BLANCHE
  figée. Les deux listes avaient divergé de 14 clés — dont
  avSetupDone, écrite dès le premier clic sur « Terminer ✓ » :
  AUCUNE sauvegarde d'un poste réel n'était restaurable, et
  le refus tombait sur la PREMIÈRE clé inconnue, rejetant
  l'archive entière. Manquaient aussi avVentesSaisie /
  avAchatsSaisie / avGrenkeManuel / avAnnule, les seules
  données qui n'existent nulle part ailleurs que dans le
  navigateur. RÈGLE : une seule règle STRUCTURELLE
  (Component.estCleSauvegarde, /^av[A-Z]…/) décide à la fois
  ce qui est exporté et ce qui est accepté — deux listes
  tenues à la main re-divergeront toujours. RESTORE_KEYS ne
  sert plus qu'à SIGNALER les réglages venus d'une autre
  version. Une clé inconnue mais bien formée est restaurée
  (une version plus récente ne doit rien perdre) et annoncée
  dans l'aperçu ; une entrée hors format est écartée et
  NOMMÉE. Jamais de rejet global.
- confirmRestore, trois catch VIDES sur le seul chemin de
  récupération : on effaçait toutes les clés av… PUIS on
  écrivait, chaque setItem enveloppé d'un catch vide, puis
  location.reload(). Quota dépassé ⇒ les données de Faustine
  étaient détruites, les nouvelles non écrites, et la page
  rechargée sans un mot (reproduit : 3 clés avant, 1 après).
  Désormais TRANSACTIONNEL : photo de l'existant, écriture
  comptée, et au moindre échec RETOUR à l'état d'avant +
  message explicite, SANS rechargement. Plafonds ramenés
  sous le quota réel du navigateur (4 Mo/clé, 4,5 Mo au
  total ; c'était 10 et 30 Mo, six fois le quota).
- « Réinitialiser » d'UNE source : passe par la même
  confirmation que le bouton global, en NOMMANT ce qui sera
  perdu (Component.RESET_DETAIL), et affiche un compte rendu
  après coup. Un clic effaçait auparavant les règles de
  catégorisation bancaire et les catégories créées à la main
  — des mois de travail, absents de tout fichier Excel —
  sans confirmation et avec msg forcé à null dans chaque
  branche, donc sans le moindre signe que quelque chose
  s'était passé.
- APERÇU DE FICHIER (Bibliothèque / Bordereaux / Stock) :
  il RÉÉCRIVAIT le classeur sur le disque, tout seul, 600 ms
  après chaque frappe. Quatre anomalies bloquantes pour un
  seul circuit (editFpCell → saveFilePreview) :
  (1) openHandleFile armait _previewHandle dès que le handle
  exposait createWritable — donc TOUT fichier venu d'un
  dossier autorisé en lecture-écriture devenait modifiable,
  y compris les sources déclarées LECTURE SEULE (bordereaux)
  et les documents de la bibliothèque. RÈGLE : l'écriture
  est un OPT-IN explicite de l'appelant
  (openHandleFile(h, nom, { ecriture: true })) ; seul
  « Modifier à la source » (stock) le demande.
  (2) patchXlsxFile était appelé SANS refuseFormula : une
  cellule en formule (SUM…) était remplacée par une valeur
  figée, en silence. Reproduit : D4 <f>SUM(D2:D3)</f> devenu
  <v>120</v>. Désormais refuseFormula partout, y compris
  dans la copie téléchargée (onFpDownload), et les cellules
  protégées sont NOMMÉES à l'utilisatrice.
  (3) saveFilePreview repartait de _previewBlob, l'instantané
  pris à l'OUVERTURE, jamais revalidé : ce qu'Excel avait
  enregistré entre-temps était effacé. On compare désormais
  lastModified ET la taille avant d'écrire (même garde-fou
  que relectureAuto) et on REFUSE en l'expliquant.
  (4) fpRows tronquait la valeur à 200 caractères POUR
  L'AFFICHAGE et alimentait la case de saisie avec cette
  valeur tronquée : une cellule de 300 caractères en perdait
  100 à la première frappe. La case porte maintenant la
  valeur complète ; au-delà de 2 000 caractères la cellule
  est affichée raccourcie et N'EST PAS modifiable, et on le
  dit.
  RÈGLE GÉNÉRALE : l'aperçu n'est plus une exception au
  pipeline. Écrire est un GESTE (bouton « 💾 Enregistrer
  dans le fichier »), et ce geste enchaîne fichier inchangé
  → sauvegarde datée obligatoire (_backupBeforeWrite, pas de
  sauvegarde = pas d'écriture) → écriture → RELECTURE de
  contrôle cellule par cellule. Fermer l'aperçu n'écrit plus
  rien (avant, « Retour » enregistrait) : premier clic =
  avertissement, second = fermeture assumée.
- IMPORT, parseTable : ne JAMAIS re-deviner la structure
  d'un flux qu'on a soi-même produit. applyImport reçoit
  TOUJOURS la sortie d'emitTSV (tabulation, en-tête en
  première ligne, aucune citation CSV) ; parseTable la
  jetait et re-devinait le séparateur. sepScore prend le
  MAXIMUM sur 15 lignes : un libellé bancaire ordinaire
  (« PRLV SEPA EDF, REF 4471, MDT 908812, ECH 03/26 »)
  portant 3 virgules faisait élire « , » sur un gabarit à
  4 colonnes. Toutes les colonnes s'effondraient en une, et
  parseDate/parseAmount retombaient par hasard sur des
  chiffres plausibles : message VERT « 3 lignes importées »
  avec des montants de 3, 4 et 5 €. Et la grammaire CSV
  appliquée au même flux faisait disparaître toute ligne
  contenant un guillemet impair (« CREVETTES 16/20 5" LOT »,
  « LE P"TIT MOUSSE ») : 6 000 € sur 12 000 € perdus derrière
  « 2 lignes ignorées ». RÈGLE : parseTable(texte,
  { sep:'\t', brut:true, headerIdx:0 }) pour tout flux
  interne ; la détection automatique ne subsiste que pour un
  texte d'origine inconnue.
  PIÈGE VOISIN, corrigé du même geste : parseTable faisait
  l.trim() sur CHAQUE ligne — une première colonne vide
  (« \tDupont\t12 ») décalait toutes les suivantes d'un cran.
  Et emitTSV n'aplatissait pas les cellules : une tabulation
  ou un retour à la ligne saisi dans Excel créait une colonne
  ou une ligne fantôme.
  CONTRÔLE : une ligne dont le nombre de colonnes diffère de
  l'en-tête fait REFUSER l'import (message rouge), jamais un
  succès vert. Et une ligne écartée est NOMMÉE (n° de
  facture, tiers, n° de ligne, raison) — un chiffre d'affaires
  amputé de moitié ne tient pas dans le mot « ignorées ».
- Bouton « Payée » d'une facture FOURNISSEUR : il envoyait
  f.reste (le reste dû) dans la colonne « Paiement ». Or
  cette colonne est RELUE comme le total réglé CUMULÉ
  (importSpec('factures'), champ « paid »). Sur une facture
  de 4 630 € dont 2 000 € étaient déjà encaissés, la cellule
  passait de 2 000 à 2 630 : les 2 000 € disparaissaient du
  classeur, et la facture soldée ressortait à la relecture en
  créance de 2 000 €, bouton « Payée » toujours proposé. On
  écrit désormais paid + reste, et l'aperçu détaille d'où
  vient le chiffre. Même famille que « TTC moins réglé » des
  duplicata et que « Montant réglé est un TOTAL cumulé ».
- _vNum et le num() local de commitPay faisaient
  String(v).replace(',', '.') : UNE SEULE virgule remplacée.
  « 1.234,56 » devenait « 1.234.56 », tronqué par parseFloat
  à 1.234 — un règlement de 1 234,56 € enregistré 1,23 €
  puis écrit tel quel dans la feuille « Suivi des
  paiements ». RÈGLE : un seul lecteur (_montantTexte, via
  _vNum) ; on retire les séparateurs de MILLIERS (espaces
  sous toutes leurs formes, apostrophes), puis, quand points
  et virgules coexistent, seul le DERNIER des deux est la
  décimale. Plusieurs points sans virgule = milliers.
  Un num() local qui diverge du lecteur commun est la
  cause, pas le symptôme : commitPay appelle _vNum.
  Forme réellement ambiguë (« 1,234 ») : on garde la lecture
  française (décimale) et on l'ÉCRIT au-dessus du bouton
  (_montantAmbigu → payAmbigu), jamais un choix muet.
- <input type="time"> : MÊME piège que <input type="date">,
  et il avait été oublié. Chrome émet « input » dès que la
  valeur devient momentanément valide (18:03 au premier
  chiffre des minutes) ; le setState reconstruisait tout le
  DOM, le champ était détruit et recréé, le curseur repartait
  au PREMIER segment, et la 4e frappe changeait les HEURES.
  Reproduit au clavier : 18:30 tapé, 12:03 enregistré — dans
  l'état, dans localStorage, dans les totaux de semaine, dans
  la fiche mensuelle et sur la feuille de présence imprimée.
  RÈGLE ÉLARGIE : tout champ <input type="date"> OU
  type="time" passe par dateH/_renderQuiet et onchange,
  jamais oninput, avec rattrapage par onDateBlur.
  (Heures → Semaine, et l'heure d'un rendez-vous d'Agenda.)
- Suppression d'une personne dans les Heures : le
  récapitulatif « Historique complet » et le bouton d'archive
  PDF étaient construits par hEmpArchiveData(NOM) alors que
  la suppression opère par ID. Nom vidé (geste courant : on
  efface pour retaper) ⇒ aucune correspondance ⇒ « Aucune
  heure enregistrée », bouton d'archive masqué, et
  « Enlever » détruisait 24 h de saisie. hEmpArchiveData
  cherche désormais par IDENTIFIANT (le nom n'est qu'un
  repli), et une ligne PORTANT des heures mais SANS nom ne
  peut plus être supprimée : on dit pourquoi et on renvoie
  vers la saisie du nom — une archive PDF sans nom ne
  désigne personne.
- idbGet n'existait pas. Le prototype ne portait que _idb,
  idbSet, idbGetAll et idbDel, mais openEmpDoc et
  openVehicleAttachment appelaient this.idbGet : la promesse
  était rejetée AVANT le test « if (!file) », donc même le
  message d'erreur prévu par le code était mort. Aucune
  pièce jointe (bulletin de paie, feuille d'heures signée,
  carte grise) ne pouvait être relue — l'archive était en
  écriture seule. Méthode ajoutée, et les deux appelants
  entourés d'un try/catch qui PARLE.
- Grenke, colonne « Remains » JETÉE par la fiche : le
  tableau lui donnait la priorité (rem = g.rem != null ?
  g.rem : calcul) mais editGrenkeDossier ne la recopiait pas
  dans le brouillon, commitGrk ne la conservait pas et
  gLocalNorm forçait rem: null. Ouvrir une fiche par ✎ et
  cliquer « Mettre à jour » SANS RIEN CHANGER faisait donc
  bouger le restant dû et l'état — 51,60 € devenus 0,00 € et
  PARTIELLEMENT RÉGLÉ devenu SOLDÉ, ce faux statut partant
  dans la colonne Statut de la feuille Grenke pendant que
  Remains y restait à 51,60. Deux états contradictoires pour
  le même dossier, au même instant, sur le même écran.
  Même famille que « Cellule Remains VIDE n'est pas un
  zéro », sauf qu'ici c'est une cellule RENSEIGNÉE qui était
  jetée. RÈGLE : `rem` est porté de bout en bout
  (editGrenkeDossier → grkDraft → commitGrk → gLocalNorm) et
  PRIME tant qu'aucun montant n'est modifié (_remBase /
  _grkRemDuFichier). Dès qu'un montant bouge, le restant est
  recalculé ET la fiche l'annonce avec les DEUX chiffres.
  ARBITRAGE LAISSÉ OUVERT : le tableau de bord n'écrit PAS
  la colonne Remains (elle peut porter une formule) ; la
  fiche le dit explicitement.
- Fiche Grenke, « N° facture » : setGrkField ne remplissait
  que les champs VIDES et ne mémorisait pas ce qu'il avait
  rempli — il n'effaçait donc jamais le pré-remplissage
  précédent. Corriger 2041 en 2044 laissait le client, le
  TTC, le 1er paiement et les charges du 2041 sous le numéro
  2044 (reproduit au clavier), et requestGrenkeUpdate
  écrivait ces montants dans la ligne du 2044. Même règle
  que l'auto-remplissage du suivi de paiement : le brouillon
  mémorise ce qu'il a rempli (`_auto`) et l'efface à chaque
  changement de numéro.
- Modale du préfixe des dossiers (Stock / Livraison /
  Transport) : le champ est en `onchange` (jamais
  `oninput`) et onPrefixKey faisait e.preventDefault() puis
  confirmPrefix() DANS le keydown — donc avant que le
  navigateur n'émette « change ». confirmPrefix lisait
  state.prefixAskValue restée à la valeur d'OUVERTURE :
  « Chronopost, DHL, Heppner » validé par Entrée
  enregistrait une chaîne VIDE (dossier lu sans filtre,
  aucun transporteur attribué), et « BL-2026 » enregistrait
  « BL ». RÈGLE : quand un raccourci clavier valide un
  formulaire, il transmet la valeur AFFICHÉE (e.target.value)
  — jamais l'état, qui n'a pas encore reçu le « change ».
- Journal des modifications, photo de référence caduque :
  au-delà de 30 % des lignes de la source OU 50 lignes
  (le plus grand des deux), ne RIEN lister. Poste
  différent, données locales réinitialisées ou lecture
  qui remonte soudain plus de lignes qu'avant ⇒ le
  fichier entier ressort en « ajouté » (vécu : 1818
  fausses alertes). On le dit franchement, on enregistre
  la nouvelle photo, on ne demande rien.

## Performance (mesurée, pas supposée)
- fmt() : JAMAIS Number.toLocaleString directement — il
  reconstruit un formateur Intl à chaque appel (~50 µs)
  et un rendu en fait des milliers. Formateur unique mis
  en cache (_nf). C'était 91,8 % du temps de renderVals().
- renderFor : `Object.create(vals)`, jamais
  `Object.assign({}, vals)` — recopier les ~1 000 clés de
  renderVals() à chaque ligne de chaque liste pesait 69 %
  d'un rendu complet.
- TOUT tableau long est paginé (`paginate`). Le Suivi de
  paiement ne l'était pas : 18 127 nœuds reconstruits à
  chaque changement d'état. Les TOTAUX restent calculés
  sur l'intégralité des lignes, jamais sur la page.
- Un tri ne rappelle pas sa fonction de clé à chaque
  comparaison quand celle-ci contient une expression
  régulière : clé calculée une fois par ligne.
- Repères après correction : renderVals 6–7 ms, rendu
  complet 8–12 ms, frappe clavier 16,5 ms.

## Espèces et lignes de saisie
- Component.ESP est dérivé de ESP_BASE + CAL_COMMUNS
  (Épate / Mort / Boette, communs à toutes les espèces).
  _norm supprimant les accents, « Épate » retrouve la
  colonne « EPATE » des feuilles de stock. « Mort » et
  « Boette » n'ont pas de colonne : la ligne de stock est
  signalée non placée, jamais perdue en silence.
- Bilingue : ESP_EN + ESP_SYN forment un INDEX de
  synonymes vers la clé canonique (especeCanonique).
  Ce n'est PAS une espèce de plus — dédoublonner par la
  clé reste exact. _stockSheetHint canonicalise d'abord,
  sinon une espèce saisie en anglais n'aurait plus de
  feuille de stock.
- Lignes de SERVICE (prestation / commission /
  transport) : `{ type, libelle, montant }`, ni espèce ni
  calibre ni poids. Elles comptent dans le total mais
  sont écartées de l'écriture du stock
  (lignesMarchandise) — sans quoi elles partiraient en
  « non résolu » à chaque enregistrement.

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

## Recalcul du stock
- rafraichirStock() est appelé à CHAQUE entrée dans
  l'onglet Stock (handler de navigation) et pose un
  verrou _stockRecalcEnCours contre les appels
  concurrents.
- Le contrôle de structure et l'écart des totaux sont
  calculés DANS la passe de lecture de
  refreshStockFolder — jamais dans une seconde lecture
  des fichiers, qui doublerait les entrées/sorties.
- Le bandeau dit toujours l'état réel : heure du
  dernier recalcul, écarts de structure, totaux
  divergents, cases vides, feuilles non reconnues,
  absence de modèle. Ne jamais afficher un état vert
  par défaut quand rien n'a été contrôlé.

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

RÈGLE ABSOLUE DU PASSAGE ELECTRON — L'ORIGINE
NE DOIT PAS CHANGER. localStorage et IndexedDB
sont cloisonnés par ORIGINE. Aujourd'hui tout
vit sous http://localhost:8080. Un
win.loadFile('index.html') charge la page en
file:// — une origine DIFFÉRENTE : au premier
double-clic sur l'icône, Faustine retrouverait
un tableau de bord VIERGE. Perdus : entreprise,
objectifs, saisies locales non encore portées
dans Excel (avVentesSaisie, avAchatsSaisie,
avGrenkeManuel), lignes annulées (avAnnule),
réglages d'écriture (avWriteMap), photo de
référence du journal (avSeenSnap), et les
handles de fichiers de la base IndexedDB
avHandles — donc les 8 sources à reconnecter
une à une. Reproduit en navigateur réel
(anomalie d'audit).
⇒ Electron démarre un petit serveur local Node
(≈40 lignes, remplaçant server.py) et charge
l'interface par
win.loadURL('http://localhost:8080'). Données
retrouvées telles quelles, aucune migration,
et /open-file peut même être conservé.
⇒ Si l'on choisit malgré tout loadFile, il FAUT
une migration explicite au premier lancement
(export de sauvegarde depuis l'origine http
puis restauration) — elle ne récupère PAS les
handles IndexedDB. À décider par Adrian avant
l'empaquetage, jamais après.
