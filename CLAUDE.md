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
- Annulation : ne jamais vider la ligne ni stocker
  les infos dans un commentaire Excel (zone la plus
  fragile du classeur : perdue via
  Google Sheets/LibreOffice, supprimée par une
  réparation Excel, et accrochée à une cellule donc
  décalée dès qu'on trie). La ligne reste intacte,
  seulement barrée et grisée.

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
