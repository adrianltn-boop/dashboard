// ---------- expression resolver (chemins pointés, littéraux, égalités simples) ----------
var IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
var NUMBER_RE = /^-?\d+(\.\d+)?$/;
function resolve(vals, src) {
  var expr = String(src).trim();
  if (!expr) return undefined;
  if (expr[0] === '(' && expr[expr.length - 1] === ')' && parensWrapWhole(expr)) {
    return resolve(vals, expr.slice(1, -1));
  }
  var eq = findTopLevelEquality(expr);
  if (eq) {
    var lv = resolve(vals, expr.slice(0, eq.index));
    var rv = resolve(vals, expr.slice(eq.index + eq.op.length));
    switch (eq.op) {
      case '===': return lv === rv;
      case '!==': return lv !== rv;
      case '==': return lv == rv;
      default: return lv != rv;
    }
  }
  if (expr[0] === '!') return !resolve(vals, expr.slice(1));
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (expr === 'null') return null;
  if (expr === 'undefined') return undefined;
  if (NUMBER_RE.test(expr)) return Number(expr);
  if (expr.length >= 2 && (expr[0] === '"' || expr[0] === "'") && expr[expr.length - 1] === expr[0]) {
    return expr.slice(1, -1);
  }
  return resolvePath(vals, expr);
}
function parensWrapWhole(expr) {
  var depth = 0;
  for (var i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') { depth--; if (depth === 0) return false; }
  }
  return true;
}
function findTopLevelEquality(expr) {
  var depth = 0;
  for (var i = 0; i < expr.length; i++) {
    var c = expr[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && (c === '=' || c === '!') && expr[i + 1] === '=') {
      if (i > 0 && (expr[i - 1] === '=' || expr[i - 1] === '!')) continue;
      if (!expr.slice(0, i).trim()) continue;
      var op = expr[i + 2] === '=' ? c + '==' : c + '=';
      return { index: i, op: op };
    }
  }
  return null;
}
function resolvePath(vals, expr) {
  var head = expr.match(IDENT_RE);
  if (!head) return undefined;
  var cur = vals == null ? undefined : vals[head[0]];
  var i = head[0].length;
  while (i < expr.length) {
    if (expr[i] === '.') {
      var m = expr.slice(i + 1).match(IDENT_RE) || expr.slice(i + 1).match(/^\d+/);
      if (!m) return undefined;
      cur = cur == null ? undefined : cur[m[0]];
      i += 1 + m[0].length;
    } else if (expr[i] === '[') {
      var depth = 1, j = i + 1;
      while (j < expr.length && depth > 0) {
        if (expr[j] === '[') depth++;
        else if (expr[j] === ']') { depth--; if (depth === 0) break; }
        j++;
      }
      if (depth !== 0) return undefined;
      var key = resolve(vals, expr.slice(i + 1, j));
      cur = cur == null ? undefined : cur[key];
      i = j + 1;
    } else return undefined;
  }
  return cur;
}

// ---------- interpolation "texte {{ expr }} texte" ----------
function interp(vals, raw) {
  var whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return resolve(vals, whole[1]);
  if (raw.indexOf('{{') === -1) return raw;
  var parts = raw.split(/\{\{([\s\S]+?)\}\}/g);
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    if (i & 1) { var v = resolve(vals, parts[i]); out += (v === null || v === undefined) ? '' : String(v); }
    else out += parts[i];
  }
  return out;
}

// ---------- interprétation d'un fragment de template en vrais nœuds DOM ----------
var EVENT_ATTRS = { onclick: 'click', onchange: 'change', oninput: 'input', onsubmit: 'submit',
  onkeydown: 'keydown', onkeyup: 'keyup', onmousedown: 'mousedown', onmouseup: 'mouseup',
  onmouseenter: 'mouseenter', onmouseleave: 'mouseleave', onfocus: 'focus', onblur: 'blur',
  ondblclick: 'dblclick', oncontextmenu: 'contextmenu', ondrop: 'drop', ondragover: 'dragover' };
var toFocus = [];
var FOCUSABLE = { input: 1, textarea: 1, select: 1 };

// Stampe chaque élément du template statique avec un index stable (une fois, au montage) —
// sert de clé pour retrouver/re-focaliser un champ de saisie après un ré-rendu complet.
function stampTemplate(root) {
  var n = 0;
  (function walk(node) {
    if (node.nodeType === 1) { node.setAttribute('data-tpl-idx', String(n++)); }
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  })(root);
}

function renderNodeList(nodes, vals, out, path) {
  for (var i = 0; i < nodes.length; i++) renderNode(nodes[i], vals, out, path);
}
function renderNode(node, vals, out, path) {
  if (node.nodeType === 3) { // text
    var txt = node.nodeValue;
    if (txt.indexOf('{{') === -1) { if (txt.trim() !== '' || /\s/.test(txt)) out.push(document.createTextNode(txt)); return; }
    var parts = txt.split(/\{\{([\s\S]+?)\}\}/g);
    var s = '';
    for (var i = 0; i < parts.length; i++) {
      if (i & 1) { var v = resolve(vals, parts[i]); s += (v === null || v === undefined || typeof v === 'boolean') ? '' : String(v); }
      else s += parts[i];
    }
    if (s !== '') out.push(document.createTextNode(s));
    return;
  }
  if (node.nodeType !== 1) return; // ignore comments etc.
  var tag = node.tagName.toLowerCase();
  if (tag === 'sc-for') { renderFor(node, vals, out, path); return; }
  if (tag === 'sc-if') { renderIf(node, vals, out, path); return; }
  out.push(renderElement(node, vals, path));
}
function renderFor(node, vals, out, path) {
  var list = interpRaw(vals, node.getAttribute('list') || '');
  var asName = node.getAttribute('as') || 'item';
  if (!Array.isArray(list)) return;
  var kids = node.childNodes;
  var base = path + '.' + node.getAttribute('data-tpl-idx');
  for (var i = 0; i < list.length; i++) {
    var sub = Object.assign({}, vals);
    sub[asName] = list[i];
    sub.$index = i;
    renderNodeList(kids, sub, out, base + ':' + i);
  }
}
function renderIf(node, vals, out, path) {
  var v = interpRaw(vals, node.getAttribute('value') || '');
  if (!v) return;
  renderNodeList(node.childNodes, vals, out, path + '.' + node.getAttribute('data-tpl-idx'));
}
function renderElement(node, vals, path) {
  var tag = node.tagName.toLowerCase();
  var el = document.createElement(tag);
  var attrs = node.attributes;
  var isFocusAttr = false;
  var pendingValue, hasValue = false, pendingChecked, hasChecked = false;
  for (var i = 0; i < attrs.length; i++) {
    var a = attrs[i], name = a.name, raw = a.value;
    if (name === 'value') { hasValue = true; pendingValue = interpRaw(vals, raw); continue; }
    if (name === 'checked') { hasChecked = true; pendingChecked = interpRaw(vals, raw); continue; }
    if (name === 'autofocus') { if (interpRaw(vals, raw)) isFocusAttr = true; continue; }
    if (EVENT_ATTRS[name]) {
      var fn = resolve(vals, (raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/) || [,raw])[1]);
      if (typeof fn === 'function') el.addEventListener(EVENT_ATTRS[name], fn);
      continue;
    }
    if (name === 'data-tpl-idx') continue;
    var val = interp(vals, raw);
    if (val !== undefined && val !== null && typeof val !== 'boolean') el.setAttribute(name, val);
  }
  var elPath = path + '.' + node.getAttribute('data-tpl-idx');
  var kids = [];
  renderNodeList(node.childNodes, vals, kids, elPath);
  for (var k = 0; k < kids.length; k++) el.appendChild(kids[k]);
  if (hasValue) el.value = (pendingValue === null || pendingValue === undefined) ? '' : pendingValue;
  if (hasChecked) el.checked = !!pendingChecked;
  if (isFocusAttr) toFocus.push(el);
  if (FOCUSABLE[tag]) el.setAttribute('data-fkey', elPath);
  return el;
}
function interpRaw(vals, raw) {
  var whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return resolve(vals, whole[1]);
  return interp(vals, raw);
}

function interpretTemplate(fragTemplateEl, vals) {
  toFocus = [];
  var frag = document.createDocumentFragment();
  var out = [];
  renderNodeList(fragTemplateEl.content.childNodes, vals, out, '');
  for (var i = 0; i < out.length; i++) frag.appendChild(out[i]);
  return { frag: frag, toFocus: toFocus.slice() };
}
class Component {
  constructor() {
    this.props = {};
  }
  state = {
    view: 'Tableau de bord', facTab: 'Factures', tiers: 'Clients',
    cat: 'Toutes', facFilter: 'Tous', blStatus: 'Tous', period: 'Cette semaine', anchor: null, weekOff: 0,
    q: '', page: 0, pageSize: 50,
    ops: null, opsName: null, factures: null, facturesName: null, bordereaux: null, bordereauxName: null, stock: null, stockName: null, stockEspeces: null, stockChecks: null, stockTab: 'actuel', stockObs: {}, credits: null, creditsName: null,
    msg: null, folder: null, links: {}, models: {}, obj: {}, blOverrides: {}, observations: [], errPanelOpen: false, errAvant: '', errApres: '', autoRefresh: true, watchCount: 0, lastSync: null, reconnectCount: 0,
    pending: null, mappings: {}, ventes: null, ventesName: null, folderStock: null, sideNote: '', sideCollapsed: {}, guideStep: null,
    comptable: null, comptableName: null, folderBl: null,
    grenke: null, grenkeName: null, folderTransp: null, blLibrary: null,
    demoMode: true, prefixes: {}, recoKey: 'ref', prefixAsk: null, prefixAskValue: '',
    grenkeLinks: {}, grenkeLink: null, grenkeLinkQuery: '',
    grenkeSort: { key: 'date', dir: 'desc' }, htTtcAsk: false, htTtcCheck: false, credEdit: null, credPayAsk: null,
    amountMode: 'TTC', bannerDismiss: null, tiersPeriodMode: 'Année',
    filePreview: null, hiddenOps: {}, grenkeHidden: {}, trashAsk: null, tblStatusF: {},
    banque: null, banqueName: null, bankLinks: {}, bankHidden: {}, bankLink: null, bankLinkQuery: '', bankQ: '', bankFilter: 'Toutes',
    bankCats: {}, bankCatRules: {}, bankCatList: null, bankCatAsk: null, bankCatAskValue: '', bankCatPick: null,
    heures: {}, heuresMois: {}, filePaths: {}, annule: {}, hRoster: [], hFocus: null, hMode: 'semaine', hRange: null, hCollapse: {}, hDelAsk: null, hNuit: false,
    empDocs: {}, empDelDoc: null, bankSalaryEmp: '', bankSalaryMonth: '',
    agenda: [], agendaMonth: null, agendaEdit: null, agendaDelAsk: null,
    payTrack: [], payDraft: null, payDelAsk: null,
    ventesSaisie: [], venteDraft: null,
    grenkeMan: [], grkDraft: null, grkDelAsk: null,
    achatsSaisie: [], achatDraft: null, chequiersLive: [], compTab: 'Achat', venteGrenke: null, compFan: null, paiementDraft: null, chqEditDraft: null,
    paiementFilters: [], paiementSort: null, chqAnnuleConfirm: null, chqAnnuleReplaceAsk: null, chqAddDraft: null, chqLiveStatus: null,
    fournSaisie: [], fournDraft: null,
    backupFolderName: null, backupStatus: null, backupLast: null, backupError: null, restoreStatus: null, restorePreview: null,
    suiviFolderName: null, suiviStatus: null, suiviError: null, suiviLast: null,
    globalQuery: '', globalOpen: false,
    importChecks: null, importChecksOpen: false,
    blMenuOpen: false,
    helpMode: false, helpTip: null,
    chargesSel: null, chargesPickOpen: null, chargesPickQ: '',
    entreprise: null,
    profils: null, profilMenuOpen: false, whoOpen: false,
    messages: null, msgText: '', msgTo: 'all', vehicles: null, vehicleBankPick: null,
    caPeriod: 'mois', analytique: null, setupOpen: false,
    paymentOverrides: {}, payResolveRef: null,
    writeMap: {}, paramWrite: null, writePreview: null, writeTest: null, healthCheck: null,
    alertsHidden: {}, stockModelName: null, srcMenuOpen: {}, advOpen: false,
  };

  static OPS_KEY = 'avOps';
  static HEURES_KEY = 'avHeures';
  static HMOIS_KEY = 'avHeuresMois';
  static FILEPATHS_KEY = 'avFilePaths';
  static ANNULE_KEY = 'avAnnule';
  static EMPDOCS_KEY = 'avEmpDocs';
  static AGENDA_KEY = 'avAgenda';
  static PAYTRACK_KEY = 'avPayTrack';
  static VSAISIE_KEY = 'avVentesSaisie';
  static GRKMAN_KEY = 'avGrenkeManuel';
  static ACHSAISIE_KEY = 'avAchatsSaisie';
  static FOURN_KEY = 'avFournSaisie';
  static FAC_KEY = 'avFactures';
  static BL_KEY = 'avBordereaux';
  static STK_KEY = 'avStock';
  static STKESP_KEY = 'avStockEspeces';
  static STKOBS_KEY = 'avStockObs';
  static CHARGES_KEY = 'avChargesSel';
  static ENT_KEY = 'avEntreprise';
  static ENT_DEFAULTS = { nom: 'Faustine', accent: '#1a56db', logo: '', especes: ['LANGOUSTE ROYAL', 'HOMARD', 'TOURTEAU', 'LANGOUSTINE', 'BIG - C.V', 'VEL-BQ-AR', 'PRODUIT FINI', 'LANGOUSTE ROSE', 'CONGELATION'] };
  static PROF_KEY = 'avProfils';
  static MSG_KEY = 'avMessages';
  static HNUIT_KEY = 'avHoraireNuit';
  static VEH_KEY = 'avVehicles';
  static AVANALY_KEY = 'avAnalytique';
  // Vues qu'un profil simplifié peut se voir accorder (Paramètres reste réservé aux admins)
  static PROFIL_VIEWS = [
    { view: 'Tableau de bord', label: 'Tableau de bord' },
    { view: 'Ventes', label: 'Ventes' },
    { view: 'SaisieCompta', label: 'Saisie comptable' },
    { view: 'Relance', label: 'Suivi de paiement' },
    { view: 'Grenke', label: 'Financement Grenke' },
    { view: 'Tiers', label: 'Clients' },
    { view: 'Achats', label: 'Achat pêche' },
    { view: 'Factures', label: 'Facture fournisseur' },
    { view: 'Crédits', label: 'Crédits' },
    { view: 'Banque', label: 'Banque' },
    { view: 'Comptabilité analytique', label: 'Comptabilité analytique' },
    { view: 'Stock', label: 'Stock' },
    { view: 'Bordereaux', label: 'Bordereaux' },
    { view: 'Bibliothèque', label: 'Bibliothèque' },
    { view: 'Heures', label: 'Heures' },
    { view: 'Employés', label: 'Employés' },
    { view: 'Agenda', label: 'Agenda' },
    { view: 'Véhicules', label: 'Véhicules' },
  ];
  static PROFIL_DEFAULT_VIEWS = ['Tableau de bord', 'Stock', 'Bordereaux', 'Heures'];
  static AUTO_KEY = 'avAutoRefresh';
  static BLOV_KEY = 'avBlStatuts';
  static LINKS_KEY = 'avLinks';
  static MODELS_KEY = 'avModels';
  static OBJ_KEY = 'avObjectifs';
  static OBS_KEY = 'avObservations';
  static CRED_KEY = 'avCredits';
  static VEN_KEY = 'avVentes';
  static PAY_OVERRIDE_KEY = 'avPaymentOverrides';
  static MAP_KEY = 'avMappings';
  static AVWMAP_KEY = 'avWriteMap';
  static APP_VERSION = 'version 24'; // affichée sous le nom — permet de vérifier qu'on est sur le bon fichier
  static CMP_KEY = 'avComptable';
  static GRENKE_KEY = 'avGrenke';
  static GLINK_KEY = 'avGrenkeLinks';
  static HIDE_OPS_KEY = 'avHiddenOps';
  static HIDE_GRK_KEY = 'avHiddenGrenke';
  static DEMO_KEY = 'avDemoMode';
  static PREFIX_KEY = 'avPrefixes';
  static RECOKEY_KEY = 'avRecoKey';
  static DEFAULT_PREFIX = { stock: 'Stock week', bordereaux: 'BL', livraison: 'BL', transport: '' };
  static BLLIB_KEY = 'avBlLibrary';
  static BNK_KEY = 'avBanque';
  static BLINK_KEY = 'avBankLinks';
  static HIDE_BNK_KEY = 'avHiddenBank';
  static BCAT_KEY = 'avBankCats';
  static BRULE_KEY = 'avBankCatRules';
  static BCATLIST_KEY = 'avBankCatList';
  static RESTORE_KEYS = new Set([
    'avOps','avHeures','avFactures','avBordereaux','avStock','avStockEspeces','avChargesSel','avEntreprise',
    'avProfils','avMessages','avHoraireNuit','avAutoRefresh','avBlStatuts','avLinks','avModels','avObjectifs',
    'avObservations','avCredits','avVentes','avMappings','avComptable','avGrenke','avGrenkeLinks','avHiddenOps',
    'avHiddenGrenke','avDemoMode','avPrefixes','avRecoKey','avBlLibrary','avBanque','avBankLinks','avHiddenBank',
    'avBankCats','avBankCatRules','avBankCatList','avVehicles','avPaymentOverrides','avSideNote','avSideCollapsed','avGuideSeen','avReportHeader','avEmpDocs','avAgenda','avPayTrack','avWriteMap','avFournSaisie'
  ]);
  static BANK_CATS = ['Achat pêcheur', 'Achat fournisseur', 'Alimentation', 'Carburant', 'Crédit & assurance', 'EDF', 'Encaissement client', 'Frais bancaires', 'Impôts & taxes', 'Location véhicule', 'Logement', 'Salaires & charges', 'Transport', 'Autre'];
  static TODAY = (() => { try { const n = new Date(); const y = n.getFullYear(); if (y >= 2020 && y <= 2100) return { y, m: n.getMonth() + 1, d: n.getDate() }; } catch (e) {} return { y: 2026, m: 7, d: 5 }; })();
  static MONTHS = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  static SEGMENTS = {
    'Boulangerie Martin': 'Commerce', 'Café du Port': 'Restauration', 'Épicerie Bio Sud': 'Commerce',
    'Restaurant Le Cèdre': 'Restauration', 'Hôtel Bellevue': 'Hôtellerie', 'Superette Colline': 'Commerce',
    'Traiteur Delacroix': 'Restauration',
  };

  static DATA = [
    [2026,7,26,'VTE-1071','Vente','Restaurant Le Cèdre','Marchandises',4310,'En attente'],
    [2026,7,25,'ACH-0891','Achat','Grossic Metro','Marchandises',-5940,'Payé'],
    [2026,7,24,'VTE-1070','Vente','Boulangerie Martin','Marchandises',2480,'Payé'],
    [2026,7,22,'VTE-1069','Vente','Traiteur Delacroix','Marchandises',5230,'Payé'],
    [2026,7,21,'ACH-0890','Achat','TransExpress','Transport',-480,'Retard'],
    [2026,7,18,'VTE-1068','Vente','Hôtel Bellevue','Services',2650,'Payé'],
    [2026,7,16,'ACH-0889','Achat','TechnoPro','Matériel',-2140,'Payé'],
    [2026,7,15,'VTE-1067','Vente','Épicerie Bio Sud','Marchandises',3275,'Payé'],
    [2026,7,11,'VTE-1066','Vente','Superette Colline','Marchandises',3890,'Payé'],
    [2026,7,9,'ACH-0888','Achat','NetServices','Services',-1250,'Payé'],
    [2026,7,8,'VTE-1065','Vente','Café du Port','Services',1120,'Payé'],
    [2026,7,5,'ACH-0887','Achat','AgroSud','Marchandises',-4630,'Payé'],
    [2026,7,3,'VTE-1064','Vente','Boulangerie Martin','Marchandises',2190,'Payé'],
    [2026,7,1,'ACH-0886','Achat','Grossic Metro','Marchandises',-5120,'Payé'],
    [2026,6,30,'ACH-0885','Achat','TransExpress','Transport',-420,'Payé'],
    [2026,6,28,'VTE-1063','Vente','Restaurant Le Cèdre','Marchandises',4120,'Payé'],
    [2026,6,26,'ACH-0884','Achat','Bureau Vallée','Fournitures',-318,'Payé'],
    [2026,6,25,'VTE-1062','Vente','Épicerie Bio Sud','Marchandises',3200,'Payé'],
    [2026,6,24,'VTE-1061','Vente','Hôtel Bellevue','Services',1650,'En attente'],
    [2026,6,21,'ACH-0883','Achat','Grossic Metro','Marchandises',-4200,'Payé'],
    [2026,6,20,'ACH-0882','Achat','Grossic Metro','Marchandises',-6480,'Payé'],
    [2026,6,18,'VTE-1060','Vente','Superette Colline','Marchandises',3840,'Payé'],
    [2026,6,16,'ACH-0881','Achat','TransExpress','Transport',-580,'Payé'],
    [2026,6,14,'VTE-1059','Vente','Boulangerie Martin','Marchandises',2190,'Payé'],
    [2026,6,12,'ACH-0880','Achat','NetServices','Services',-1200,'Payé'],
    [2026,6,10,'VTE-1058','Vente','Café du Port','Services',2400,'Payé'],
    [2026,6,6,'VTE-1057','Vente','Traiteur Delacroix','Marchandises',5230,'Payé'],
    [2026,6,3,'ACH-0878','Achat','AgroSud','Marchandises',-3980,'Payé'],
    [2026,5,30,'VTE-1056','Vente','Boulangerie Martin','Marchandises',2260,'Payé'],
    [2026,5,29,'VTE-1055','Vente','Restaurant Le Cèdre','Marchandises',3960,'Payé'],
    [2026,5,26,'ACH-0877','Achat','AgroSud','Marchandises',-4870,'Payé'],
    [2026,5,22,'VTE-1054','Vente','Superette Colline','Marchandises',3510,'Payé'],
    [2026,5,21,'VTE-1053','Vente','Hôtel Bellevue','Services',2380,'Payé'],
    [2026,5,15,'ACH-0875','Achat','TechnoPro','Matériel',-2650,'Payé'],
    [2026,5,12,'VTE-1052','Vente','Épicerie Bio Sud','Marchandises',2910,'Payé'],
    [2026,5,7,'ACH-0873','Achat','Grossic Metro','Marchandises',-5610,'Payé'],
    [2026,5,3,'VTE-1051','Vente','Café du Port','Services',1140,'Payé'],
    [2026,4,28,'VTE-1050','Vente','Restaurant Le Cèdre','Marchandises',3660,'Payé'],
    [2026,4,22,'ACH-0872','Achat','AgroSud','Marchandises',-4300,'Payé'],
    [2026,4,18,'ACH-0871','Achat','Grossic Metro','Marchandises',-5890,'Payé'],
    [2026,4,16,'VTE-1048','Vente','Traiteur Delacroix','Marchandises',4890,'Payé'],
    [2026,4,10,'VTE-1046','Vente','Boulangerie Martin','Marchandises',2050,'Payé'],
    [2026,3,27,'VTE-1043','Vente','Traiteur Delacroix','Marchandises',4780,'Payé'],
    [2026,3,15,'ACH-0865','Achat','NetServices','Services',-980,'Payé'],
    [2026,2,20,'ACH-0862','Achat','AgroSud','Marchandises',-4420,'Payé'],
    [2026,1,16,'ACH-0859','Achat','Bureau Vallée','Fournitures',-450,'Payé'],
  ];

  static FACTURES = [
    {d:'2026-07-02',ref:'FAC-2045',sens:'Client',partner:'Superette Colline',cat:'Marchandises',ttc:3840,paid:0,due:'2026-08-01'},
    {d:'2026-07-01',ref:'FAC-2044',sens:'Client',partner:'Épicerie Bio Sud',cat:'Marchandises',ttc:3200,paid:3200,due:'2026-07-31'},
    {d:'2026-06-26',ref:'FAC-2041',sens:'Client',partner:'Restaurant Le Cèdre',cat:'Marchandises',ttc:4310,paid:0,due:'2026-07-26'},
    {d:'2026-06-18',ref:'FAC-2039',sens:'Client',partner:'Hôtel Bellevue',cat:'Services',ttc:2650,paid:0,due:'2026-07-18'},
    {d:'2026-06-11',ref:'FAC-2036',sens:'Client',partner:'Superette Colline',cat:'Marchandises',ttc:3890,paid:1500,due:'2026-07-11'},
    {d:'2026-05-30',ref:'FAC-2030',sens:'Client',partner:'Café du Port',cat:'Services',ttc:1120,paid:0,due:'2026-06-30'},
    {d:'2026-05-28',ref:'FAC-2028',sens:'Client',partner:'Boulangerie Martin',cat:'Marchandises',ttc:2190,paid:0,due:'2026-06-28'},
    {d:'2026-05-15',ref:'FAC-2025',sens:'Client',partner:'Épicerie Bio Sud',cat:'Marchandises',ttc:3275,paid:1000,due:'2026-06-15'},
    {d:'2026-05-10',ref:'FAC-2021',sens:'Client',partner:'Traiteur Delacroix',cat:'Marchandises',ttc:5230,paid:0,due:'2026-06-09'},
    {d:'2026-04-29',ref:'FAC-2016',sens:'Client',partner:'Restaurant Le Cèdre',cat:'Marchandises',ttc:3960,paid:0,due:'2026-05-29'},
    {d:'2026-04-21',ref:'FAC-2012',sens:'Client',partner:'Hôtel Bellevue',cat:'Services',ttc:2380,paid:0,due:'2026-05-21'},
    {d:'2026-04-15',ref:'FAC-2007',sens:'Client',partner:'Superette Colline',cat:'Marchandises',ttc:3510,paid:0,due:'2026-05-15'},
    {d:'2026-03-27',ref:'FAC-1998',sens:'Client',partner:'Boulangerie Martin',cat:'Marchandises',ttc:2050,paid:0,due:'2026-04-26'},
    {d:'2026-04-24',ref:'FAC-1990',sens:'Client',partner:'Café du Port',cat:'Services',ttc:1860,paid:1860,due:'2026-05-24'},
    {d:'2026-06-25',ref:'FAC-F891',sens:'Fournisseur',partner:'Grossic Metro',cat:'Marchandises',ttc:5940,paid:5940,due:'2026-07-25'},
    {d:'2026-06-21',ref:'FAC-F890',sens:'Fournisseur',partner:'TransExpress',cat:'Transport',ttc:480,paid:0,due:'2026-06-28'},
    {d:'2026-06-16',ref:'FAC-F889',sens:'Fournisseur',partner:'TechnoPro',cat:'Matériel',ttc:2140,paid:0,due:'2026-07-16'},
    {d:'2026-06-05',ref:'FAC-F887',sens:'Fournisseur',partner:'AgroSud',cat:'Marchandises',ttc:4630,paid:2000,due:'2026-07-05'},
    {d:'2026-06-26',ref:'FAC-F884',sens:'Fournisseur',partner:'Bureau Vallée',cat:'Fournitures',ttc:318,paid:0,due:'2026-07-26'},
    {d:'2026-06-20',ref:'FAC-F882',sens:'Fournisseur',partner:'Grossic Metro',cat:'Marchandises',ttc:6480,paid:6480,due:'2026-07-20'},
    {d:'2026-06-12',ref:'FAC-F880',sens:'Fournisseur',partner:'NetServices',cat:'Services',ttc:1200,paid:1200,due:'2026-07-12'},
  ];

  static CREDITS = [
    {label:'Crédit véhicule utilitaire',type:'Crédit',mens:620,total:22320,paid:13640,next:'2026-07-15'},
    {label:'Crédit matériel froid',ent:'Crédit Maritime',type:'Crédit',mens:340,total:12240,paid:9520,next:'2026-07-10'},
    {label:'Crédit aménagement local',ent:'BNP Paribas',type:'Crédit',mens:410,total:14760,paid:4920,next:'2026-07-20'},
    {label:'Assurance locaux (RC Pro)',ent:'AXA',type:'Assurance',mens:185,total:2220,paid:1295,next:'2026-08-01'},
    {label:'Assurance flotte véhicules',ent:'Groupama',type:'Assurance',mens:240,total:2880,paid:1680,next:'2026-07-28'},
  ];

  static BORDEREAUX = [
    {d:'2026-07-02',ref:'BL-3092',dest:'Restaurant Le Cèdre',fac:'FAC-2041',colis:6,transp:'TransExpress',statut:'En transit'},
    {d:'2026-07-02',ref:'BL-3091',dest:'Superette Colline',fac:'FAC-2045',colis:9,transp:'Chronopost',statut:'Préparé'},
    {d:'2026-07-01',ref:'BL-3090',dest:'Épicerie Bio Sud',fac:'FAC-2044',colis:4,transp:'TransExpress',statut:'Livré'},
    {d:'2026-06-28',ref:'BL-3089',dest:'Hôtel Bellevue',fac:'FAC-2039',colis:3,transp:'DPD',statut:'Livré'},
    {d:'2026-06-27',ref:'BL-3088',dest:'Café du Port',fac:'FAC-2030',colis:2,transp:'Colissimo',statut:'Livré'},
    {d:'2026-06-24',ref:'BL-3087',dest:'Boulangerie Martin',fac:'FAC-2028',colis:5,transp:'TransExpress',statut:'Livré'},
    {d:'2026-06-20',ref:'BL-3086',dest:'Traiteur Delacroix',fac:'FAC-2021',colis:8,transp:'Chronopost',statut:'Livré'},
    {d:'2026-07-03',ref:'BL-3093',dest:'Restaurant Le Cèdre',fac:'—',colis:4,transp:'TransExpress',statut:'En attente'},
    {d:'2026-06-30',ref:'BL-3085',dest:'Hôtel Bellevue',fac:'FAC-2012',colis:3,transp:'DPD',statut:'Livré'},
    {d:'2026-06-18',ref:'BL-3084',dest:'Superette Colline',fac:'FAC-2007',colis:7,transp:'Chronopost',statut:'Livré'},
    {d:'2026-07-01',ref:'BL-3083',dest:'Traiteur Delacroix',fac:'—',colis:6,transp:'TransExpress',statut:'Expédié'},
    {d:'2026-06-15',ref:'BL-3082',dest:'Épicerie Bio Sud',fac:'FAC-2025',colis:4,transp:'Colissimo',statut:'Livré'},
  ];

  static STOCK = [
    {file:'Stock_S27_2026.xlsx',sem:'30/06 – 06/07',poids:3420,valo:128400},
    {file:'Stock_S26_2026.xlsx',sem:'23 – 29/06',poids:3355,valo:125700},
    {file:'Stock_S25_2026.xlsx',sem:'16 – 22/06',poids:3402,valo:127500},
    {file:'Stock_S24_2026.xlsx',sem:'09 – 15/06',poids:3298,valo:123500},
    {file:'Stock_S23_2026.xlsx',sem:'02 – 08/06',poids:3320,valo:124500},
    {file:'Stock_S22_2026.xlsx',sem:'26/05 – 01/06',poids:3286,valo:123100},
    {file:'Stock_S21_2026.xlsx',sem:'19 – 25/05',poids:3351,valo:125600},
    {file:'Stock_S20_2026.xlsx',sem:'12 – 18/05',poids:3300,valo:123500},
  ];

  // Saisie comptable — espèces & calibres (repris de la maquette), palette et moyens de paiement
  static ESP = { 'Homard': ['4/6', '6/8', '8/10', '10/13', '13/16', '16+'], 'Langouste royale': ['6/8', '8/10', '10/13', '13/16', '16+'], 'Langouste rose': ['3/4', '4/6', '6/8'], 'Tourteau': ['4/6', '6/8', '8/10', '10/13', 'Pinces'], 'Langoustine': ['T1', 'T2', 'T3'], 'Araignée': ['Standard'], 'Velvet-crab': ['8/10'], 'Bouquet': ['Standard'], 'Bigorneau': ['Standard'], 'Crabe vert': ['Standard'] };
  static ESP_PAL = { 'Homard': '#1a56db', 'Langouste royale': '#be185d', 'Langouste rose': '#db2777', 'Tourteau': '#b45309', 'Langoustine': '#0f766e', 'Araignée': '#7c3aed', 'Velvet-crab': '#0e7490', 'Bouquet': '#4d7c0f', 'Bigorneau': '#9a3412', 'Crabe vert': '#15803d' };
  static PAYMODES = { virement: { lbl: 'Virement', ic: '🏦', col: '#1a56db' }, cheque: { lbl: 'Chèque', ic: '🧾', col: '#0f766e' }, liquide: { lbl: 'Liquide', ic: '💶', col: '#7c3aed' }, autre: { lbl: 'Autre', ic: '❓', col: '#64748b' } };

  // Relevé bancaire (démo) : {d ISO, label, amt signé}
  static BANQUE = [
    [2026,7,31,'FRAIS TENUE DE COMPTE JUILLET',-12.5,11837.9],
    [2026,7,25,'PRLV SEPA GROSSIC METRO SAS',-5940,11850.4],
    [2026,7,24,'VIR RECU BOULANGERIE MARTIN',2480,17790.4],
    [2026,7,21,'PRLV TRANSEXPRESS TRANSPORT',-480,15310.4],
    [2026,7,17,'PRLV TECHNOPRO SARL',-2140,15790.4],
    [2026,7,16,'VIR RECU EPICERIE BIO SUD',3275,17930.4],
    [2026,7,15,'ECHEANCE PRET 00071 CREDIT MARITIME',-340,14655.4],
    [2026,7,12,'VIR RECU SUPERETTE COLLINE',3890,14995.4],
    [2026,7,10,'PRLV SEPA NETSERVICES ABONNEMENT',-1250,11105.4],
    [2026,7,8,'CARTE 05/07 STATION AVIA',-84.6,12355.4],
    [2026,7,6,'PRLV AGROSUD DISTRIBUTION',-4630,12440],
    [2026,7,4,'VIR SEPA BOULANGERIE MARTIN FACT VTE-1064',2190,17070],
    [2026,6,30,'VIR RECU HOTEL BELLEVUE',1650,14880],
    [2026,6,26,'VIR RECU TRAITEUR DELACROIX',5230,13230],
  ];

  // Comptabilité analytique (démo) : un instantané Stock par espèce, cohérent (prix vente > prix
  // achat, poids vendu ≤ poids acheté). CONGELATION est volontairement « manquante » pour montrer
  // comment le tableau signale une feuille absente. Remplacé par les vraies données dès qu'un
  // dossier Stock est connecté ou que le mode démo est quitté.
  static DEMO_STOCK_ESPECES = [{
    file: 'Stock week 28 (démo).xlsx', sem: 'Semaine 28',
    bySpecies: {
      'LANGOUSTE ROYAL': { species: 'LANGOUSTE ROYAL', missing: false, poidsAchete: 120, poidsVendu: 95, prixAchat: 38.5, prixVente: 47 },
      'HOMARD': { species: 'HOMARD', missing: false, poidsAchete: 260, poidsVendu: 215, prixAchat: 23.4, prixVente: 31.2 },
      'TOURTEAU': { species: 'TOURTEAU', missing: false, poidsAchete: 480, poidsVendu: 405, prixAchat: 5.4, prixVente: 7.8 },
      'LANGOUSTINE': { species: 'LANGOUSTINE', missing: false, poidsAchete: 350, poidsVendu: 310, prixAchat: 14.2, prixVente: 19.6 },
      'BIG - C.V': { species: 'BIG - C.V', missing: false, poidsAchete: 220, poidsVendu: 180, prixAchat: 1.9, prixVente: 3.2 },
      'VEL-BQ-AR': { species: 'VEL-BQ-AR', missing: false, structure: 'B', poidsAchete: 160, poidsVendu: 140, valeurAchat: 1088, valeurVendu: 1316, prixAchat: 6.8, prixVente: 9.4, products: [
        { name: 'VELVET-CRAB', state: 'confirme', achatPoids: 70, achatValeur: 280, venduPoids: 68, venduValeur: 421.6, benefice: 141.6 },
        { name: 'BOUQUET', state: 'zero', achatPoids: 0, achatValeur: 0, venduPoids: 0, venduValeur: 0, benefice: 0 },
        { name: 'ARAIGNEE', state: 'confirme', achatPoids: 90, achatValeur: 117, venduPoids: 72, venduValeur: 115.2, benefice: -1.8 },
      ] },
      'PRODUIT FINI': { species: 'PRODUIT FINI', missing: false, poidsAchete: 90, poidsVendu: 88, prixAchat: 12.5, prixVente: 17.9 },
      'LANGOUSTE ROSE': { species: 'LANGOUSTE ROSE', missing: false, poidsAchete: 75, poidsVendu: 60, prixAchat: 33, prixVente: 42.5 },
      'CONGELATION': { species: 'CONGELATION', missing: true, reason: 'feuille absente du fichier (exemple de signalement)' },
    },
    missing: [{ species: 'CONGELATION', reason: 'feuille absente du fichier (exemple de signalement)' }],
  }];
  // Charges pré-cochées en démo (clés = libellés du relevé de démo, normalisés par bankLabelKey)
  static DEMO_CHARGES_SEL = {
    fixe: ['ECHEANCE PRET CREDIT MARITIME', 'PRLV SEPA NETSERVICES ABONNEMENT', 'FRAIS TENUE DE COMPTE JUILLET'],
    variable: ['PRLV SEPA GROSSIC METRO SAS', 'PRLV AGROSUD DISTRIBUTION', 'PRLV TRANSEXPRESS TRANSPORT', 'CARTE STATION AVIA', 'PRLV TECHNOPRO SARL'],
  };

  componentDidMount() {
    // ---- Mode aide (Helpeur) : en phase capture pour intercepter le clic AVANT l'action normale
    // du bouton/lien visé — en mode aide, cliquer un élément l'explique au lieu de l'exécuter.
    this._helpClick = e => {
      if (!this.state.helpMode) return;
      const t = e.target;
      if (t.closest && (t.closest('[data-help-tip]') || t.closest('[data-help-btn]'))) return;
      e.preventDefault(); e.stopPropagation();
      const el = t.closest ? t.closest('[data-help]') : null;
      const x = Math.max(10, Math.min(e.clientX, window.innerWidth - 380));
      const y = Math.max(10, Math.min(e.clientY + 14, window.innerHeight - 220));
      if (el && el.getAttribute('data-help')) {
        this.setState({ helpTip: { x, y, title: el.getAttribute('data-help-title') || '', text: el.getAttribute('data-help') } });
      } else {
        this.setState({ helpTip: { x, y, title: '', text: 'Pas d’explication disponible pour cet élément. Cliquez sur un chiffre, une carte ou un total — ou re-cliquez sur « ? Aide » (en haut) pour quitter le mode aide.' } });
      }
    };
    document.addEventListener('click', this._helpClick, true);
    // En mode aide, bloquer aussi mousedown/contextmenu : sinon le mécanisme d'observation
    // (clic gauche → note épinglée) s'ouvre et re-rend le DOM avant que le click n'arrive.
    this._helpDown = e => {
      if (!this.state.helpMode) return;
      const t = e.target;
      if (t.closest && (t.closest('[data-help-tip]') || t.closest('[data-help-btn]'))) return;
      e.stopPropagation();
      // preventDefault empêche aussi la prise de focus (un champ de saisie qui prend le focus
      // re-rend la page au milieu du clic, et la bulle d'aide ne s'afficherait jamais).
      if (e.type === 'mousedown') e.preventDefault();
    };
    document.addEventListener('mousedown', this._helpDown, true);
    document.addEventListener('contextmenu', this._helpDown, true);
    this._helpEsc = e => { if (e.key === 'Escape' && this.state.helpMode) this.setState({ helpMode: false, helpTip: null }); };
    document.addEventListener('keydown', this._helpEsc);
    // Restauration au démarrage : chaque clé est lue isolément — une clé corrompue est ignorée
    // et signalée, sans empêcher la restauration de toutes les autres données.
    const badKeys = [];
    try {
      const j = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { badKeys.push(k); return null; } };
      const o = j(Component.OPS_KEY); if (o && Array.isArray(o.rows) && o.rows.length) this.setState({ ops: o.rows, opsName: o.name });
      const f = j(Component.FAC_KEY); if (f && Array.isArray(f.rows) && f.rows.length) this.setState({ factures: f.rows, facturesName: f.name });
      const b = j(Component.BL_KEY); if (b && Array.isArray(b.rows) && b.rows.length) this.setState({ bordereaux: b.rows, bordereauxName: b.name });
      const s = j(Component.STK_KEY); if (s && Array.isArray(s.rows) && s.rows.length) this.setState({ stock: s.rows, stockName: s.name });
      const se = j(Component.STKESP_KEY); if (se && Array.isArray(se.rows) && se.rows.length) this.setState({ stockEspeces: se.rows });
      const so = j(Component.STKOBS_KEY); if (so && typeof so === 'object' && !Array.isArray(so)) this.setState({ stockObs: so });
      const an = j(Component.AVANALY_KEY); if (an && typeof an === 'object') this.setState({ analytique: an });
      const vh = j(Component.VEH_KEY); if (vh && Array.isArray(vh.rows)) this.setState({ vehicles: vh.rows });
      const cs = j(Component.CHARGES_KEY); if (cs && typeof cs === 'object') this.setState({ chargesSel: { fixe: Array.isArray(cs.fixe) ? cs.fixe.filter(x => typeof x === 'string') : [], variable: Array.isArray(cs.variable) ? cs.variable.filter(x => typeof x === 'string') : [] } });
      const blo = j(Component.BLOV_KEY); if (blo && typeof blo === 'object') this.setState({ blOverrides: blo });
      const l = j(Component.LINKS_KEY); if (l && typeof l === 'object') this.setState({ links: l });
      const m = j(Component.MODELS_KEY); if (m && typeof m === 'object') this.setState({ models: m });
      const ob = j(Component.OBJ_KEY); if (ob && typeof ob === 'object') this.setState({ obj: ob });
      const cr = j(Component.CRED_KEY); if (cr && Array.isArray(cr.rows) && cr.rows.length) this.setState({ credits: cr.rows, creditsName: cr.name });
      // v2 : les lignes ventes doivent porter statusPaid (statut « Payée » du fichier). Les anciennes données faussaient les relances → on les purge.
      const vn = j(Component.VEN_KEY);
      if (vn && Array.isArray(vn.rows) && vn.rows.length) {
        const isV4 = vn.v >= 6;
        if (isV4) this.setState({ ventes: vn.rows, ventesName: vn.name });
        else {
          // purge données ET mappage enregistré : tout sera re-détecté proprement au prochain import
          try { localStorage.removeItem(Component.VEN_KEY); } catch (e) {}
          try { const mps = j(Component.MAP_KEY); if (mps && mps.ventes) { delete mps.ventes; localStorage.setItem(Component.MAP_KEY, JSON.stringify(mps)); } } catch (e) {}
          this.setState({ msg: { kind: 'error', text: 'Le calcul des statuts payés a été corrigé — ré-importez votre fichier de ventes (Paramètres → Ventes) pour des relances justes.' } });
        }
      }
      const pov = j(Component.PAY_OVERRIDE_KEY); if (pov && typeof pov === 'object' && !Array.isArray(pov)) this.setState({ paymentOverrides: pov });
      const mp = j(Component.MAP_KEY); if (mp && typeof mp === 'object') this.setState({ mappings: mp });
      const wmp = j(Component.AVWMAP_KEY); if (wmp && typeof wmp === 'object' && !Array.isArray(wmp)) this.setState({ writeMap: wmp });
      const obs = j(Component.OBS_KEY); if (Array.isArray(obs)) this.setState({ observations: obs });
      try { const sn = localStorage.getItem('avSideNote'); if (sn != null) this.setState({ sideNote: sn }); } catch (e) {}
      try {
        if (!localStorage.getItem('avSetupDone')) this.setState({ setupOpen: true, view: 'Tableau de bord' });
        else if (!localStorage.getItem('avGuideSeen')) this.setState({ guideStep: 0, view: 'Tableau de bord' });
      } catch (e) {}
      const scM = j('avSideCollapsed'); if (scM && typeof scM === 'object') this.setState({ sideCollapsed: scM });
      const ar = localStorage.getItem(Component.AUTO_KEY); if (ar === '0') this.setState({ autoRefresh: false });
      const cm = j(Component.CMP_KEY); if (cm && Array.isArray(cm.rows) && cm.rows.length) this.setState({ comptable: cm.rows, comptableName: cm.name });
      const gk = j(Component.GRENKE_KEY); if (gk && Array.isArray(gk.rows) && gk.rows.length) this.setState({ grenke: gk.rows, grenkeName: gk.name });
      const glk = j(Component.GLINK_KEY); if (glk && typeof glk === 'object' && !Array.isArray(glk)) this.setState({ grenkeLinks: glk });
      const ho = j(Component.HIDE_OPS_KEY); if (ho && typeof ho === 'object' && !Array.isArray(ho)) this.setState({ hiddenOps: ho });
      const hg = j(Component.HIDE_GRK_KEY); if (hg && typeof hg === 'object' && !Array.isArray(hg)) this.setState({ grenkeHidden: hg });
      const bl = j(Component.BLLIB_KEY); if (bl && Array.isArray(bl.rows) && bl.rows.length) this.setState({ blLibrary: bl.rows });
      const px = j(Component.PREFIX_KEY); if (px && typeof px === 'object') this.setState({ prefixes: px });
      const rk = localStorage.getItem(Component.RECOKEY_KEY); if (rk) this.setState({ recoKey: rk });
      const bq = j(Component.BNK_KEY); if (bq && Array.isArray(bq.rows) && bq.rows.length) this.setState({ banque: bq.rows, banqueName: bq.name });
      const blk = j(Component.BLINK_KEY); if (blk && typeof blk === 'object' && !Array.isArray(blk)) this.setState({ bankLinks: blk });
      const hb = j(Component.HIDE_BNK_KEY); if (hb && typeof hb === 'object' && !Array.isArray(hb)) this.setState({ bankHidden: hb });
      const bc = j(Component.BCAT_KEY); if (bc && typeof bc === 'object' && !Array.isArray(bc)) this.setState({ bankCats: bc });
      const br = j(Component.BRULE_KEY); if (br && typeof br === 'object' && !Array.isArray(br)) this.setState({ bankCatRules: br });
      const bcl = j(Component.BCATLIST_KEY); if (Array.isArray(bcl) && bcl.length) this.setState({ bankCatList: bcl });
      const dm = localStorage.getItem(Component.DEMO_KEY); if (dm === '0') this.setState({ demoMode: false });
      const ent = j(Component.ENT_KEY); if (ent && typeof ent === 'object' && !Array.isArray(ent)) this.setState({ entreprise: ent });
      const prf = j(Component.PROF_KEY); if (prf && typeof prf === 'object' && !Array.isArray(prf)) this.setState({ profils: prf });
      const msgs = j(Component.MSG_KEY); if (msgs && Array.isArray(msgs.list)) this.setState({ messages: msgs.list });
      if (localStorage.getItem(Component.HNUIT_KEY) === '1') this.setState({ hNuit: true });
    } catch (e) { console.error('[restore]', e); }
    // Chat entre profils : si le tableau de bord est ouvert dans deux fenêtres en même temps,
    // les messages envoyés dans l'une apparaissent dans l'autre sans recharger.
    this._onStorage = e => {
      if (e.key !== Component.MSG_KEY) return;
      try {
        const v = JSON.parse(e.newValue || 'null');
        if (v && Array.isArray(v.list)) {
          this.setState({ messages: v.list });
          if (this.state.view === 'Messages') this.markMessagesRead();
        }
      } catch (err) {}
    };
    try { window.addEventListener('storage', this._onStorage); } catch (e) {}
    // Filet de sécurité : en ouverture directe du fichier (file://), l'événement « storage »
    // peut ne pas circuler entre fenêtres — on revérifie donc aussi toutes les 4 secondes.
    this._msgLastRaw = (() => { try { return localStorage.getItem(Component.MSG_KEY) || ''; } catch (e) { return ''; } })();
    this._msgPollT = setInterval(() => {
      try {
        const raw = localStorage.getItem(Component.MSG_KEY) || '';
        if (raw === this._msgLastRaw) return;
        this._msgLastRaw = raw;
        const v = JSON.parse(raw || 'null');
        if (v && Array.isArray(v.list)) {
          this.setState({ messages: v.list });
          if (this.state.view === 'Messages') this.markMessagesRead();
        }
      } catch (e) {}
    }, 4000);
    this._applyEntTitle();
    // Profil simplifié mémorisé : si la vue de démarrage ne lui est pas ouverte, on bascule
    // sur sa première page autorisée.
    if (!this.isAdminProfil() && !this.profilAllowed(this.state.view)) {
      const p = this.activeProfil();
      const vs = p.views.length ? p.views : Component.PROFIL_DEFAULT_VIEWS;
      this.setState({ view: vs[0] || 'Tableau de bord' });
    }
    // « Qui êtes-vous ? » à l'ouverture, dès qu'il y a un choix à faire (2 profils ou plus).
    if (this.profCfg().list.length >= 2) this.setState({ whoOpen: true });
    if (badKeys.length) this.setState({ msg: { kind: 'error', text: `Certaines données mémorisées sont illisibles et ont été ignorées (${badKeys.join(', ')}) — le reste a été restauré normalement. Ré-importez la source concernée depuis Paramètres si un tableau semble vide.` } });
    try {
      const hd = JSON.parse(localStorage.getItem(Component.HEURES_KEY) || 'null') || {};
      const weeks = (hd && hd.weeks && typeof hd.weeks === 'object') ? { ...hd.weeks } : {};
      let roster = (Array.isArray(hd.roster) && hd.roster.length) ? hd.roster.slice() : null;
      const key = this.hISO(this.hMonday(new Date()));
      if (!roster) { const ks = Object.keys(weeks).sort(); roster = ks.length ? ((weeks[ks[ks.length - 1]].employees || []).map(e => e.name)) : []; }
      if (!roster.length) roster = ['Employé 1'];
      if (!weeks[key]) weeks[key] = { employees: roster.map((n, i) => ({ id: this.hNewId(i), name: n, days: {} })) };
      this.setState({ heures: weeks, hRoster: roster, hFocus: key });
      this.saveJSON(Component.HEURES_KEY, { weeks, roster });
    } catch (e) {}
    try { const ed = JSON.parse(localStorage.getItem(Component.EMPDOCS_KEY) || 'null'); if (ed && typeof ed === 'object' && !Array.isArray(ed)) this.setState({ empDocs: ed }); } catch (e) {}
    try { const hm = JSON.parse(localStorage.getItem(Component.HMOIS_KEY) || 'null'); if (hm && typeof hm === 'object' && !Array.isArray(hm)) this.setState({ heuresMois: hm }); } catch (e) {}
    try { const fp = JSON.parse(localStorage.getItem(Component.FILEPATHS_KEY) || 'null'); if (fp && typeof fp === 'object' && !Array.isArray(fp)) this.setState({ filePaths: fp }); } catch (e) {}
    try { const an = JSON.parse(localStorage.getItem(Component.ANNULE_KEY) || 'null'); if (an && typeof an === 'object' && !Array.isArray(an)) this.setState({ annule: an }); } catch (e) {}
    try { const ag = JSON.parse(localStorage.getItem(Component.AGENDA_KEY) || 'null'); if (Array.isArray(ag)) this.setState({ agenda: ag }); } catch (e) {}
    try { const pt = JSON.parse(localStorage.getItem(Component.PAYTRACK_KEY) || 'null'); if (Array.isArray(pt)) this.setState({ payTrack: pt }); } catch (e) {}
    try { const vs = JSON.parse(localStorage.getItem(Component.VSAISIE_KEY) || 'null'); if (Array.isArray(vs)) this.setState({ ventesSaisie: vs }); } catch (e) {}
    try { const gm = JSON.parse(localStorage.getItem(Component.GRKMAN_KEY) || 'null'); if (Array.isArray(gm)) this.setState({ grenkeMan: gm }); } catch (e) {}
    try { const as = JSON.parse(localStorage.getItem(Component.ACHSAISIE_KEY) || 'null'); if (Array.isArray(as)) this.setState({ achatsSaisie: as }); } catch (e) {}
    try { const fs = JSON.parse(localStorage.getItem(Component.FOURN_KEY) || 'null'); if (Array.isArray(fs)) this.setState({ fournSaisie: fs }); } catch (e) {}
    try { this.restoreHandles(); } catch (e) {}
    this._onVisible = () => {
      if (document.hidden) this.stopWatching();
      else if (this.state.autoRefresh) { this.startWatching(true); this.pollWatched(); this.refreshFolders(); }
    };
    this._onFocus = () => { if (this.state.autoRefresh) { this.pollWatched(); this.refreshFolders(); } };
    try { document.addEventListener('visibilitychange', this._onVisible); window.addEventListener('focus', this._onFocus); } catch (e) {}
  }
  // ---------- helpers ----------
  hexToRgba(hex, a) { const h = hex.replace('#', ''); return `rgba(${parseInt(h.substring(0,2),16)},${parseInt(h.substring(2,4),16)},${parseInt(h.substring(4,6),16)},${a})`; }
  fmt(n) { const v = Math.round(((+n) || 0) * 100) / 100; return v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  pctStr(n) { return Math.min(100, Math.max(0, Math.round(n))) + '%'; }
  vehicleRows() { return Array.isArray(this.state.vehicles) ? this.state.vehicles : []; }
  saveVehicles(rows) { this.setState({ vehicles: rows }); this.saveJSON(Component.VEH_KEY, { rows }); }
  // ---------- Comptabilité analytique : saisies manuelles (personnel, amortissements, transport, frais fin.) ----------
  analyCfg() {
    const a = this.state.analytique || {};
    return {
      personnel: +a.personnel || 0, transport: +a.transport || 0, ff: +a.ff || 0,
      amortVeh: Array.isArray(a.amortVeh) ? a.amortVeh : [],
    };
  }
  setAnaly(patch) { const next = { ...this.analyCfg(), ...patch }; this.setState({ analytique: next }); this.saveJSON(Component.AVANALY_KEY, next); }
  setStockObs(key, val) { const m = { ...(this.state.stockObs || {}) }; if (val && val.trim()) m[key] = val; else delete m[key]; this.setState({ stockObs: m }); this.saveJSON(Component.STKOBS_KEY, m); }
  addAnalyVeh() { const v = this.analyCfg().amortVeh.slice(); v.push({ id: 'am' + Date.now().toString(36), nom: 'Véhicule / matériel', prix: 0, duree: 5 }); this.setAnaly({ amortVeh: v }); }
  updateAnalyVeh(id, patch) { this.setAnaly({ amortVeh: this.analyCfg().amortVeh.map(v => v.id === id ? { ...v, ...patch } : v) }); }
  deleteAnalyVeh(id) { this.setAnaly({ amortVeh: this.analyCfg().amortVeh.filter(v => v.id !== id) }); }
  // ---------- Assistant de première connexion (paramétrage guidé) ----------
  openSetup() { this.setState({ setupOpen: true }); }
  closeSetup() { try { localStorage.setItem('avSetupDone', '1'); } catch (e) {} this.setState({ setupOpen: false }); }
  addVehicle() { const rows = this.vehicleRows().slice(); rows.push({ id: 'v' + Date.now().toString(36), name: 'Nouveau véhicule', bankKeys: [], attachments: [] }); this.saveVehicles(rows); }
  updateVehicle(id, patch) { this.saveVehicles(this.vehicleRows().map(v => v.id === id ? { ...v, ...patch } : v)); }
  deleteVehicle(id) { this.saveVehicles(this.vehicleRows().filter(v => v.id !== id)); }
  linkVehicleBank(id, key) { const v = this.vehicleRows().find(x => x.id === id); if (!v) return; const keys = Array.isArray(v.bankKeys) ? v.bankKeys.slice() : []; const i = keys.indexOf(key); if (i >= 0) keys.splice(i, 1); else keys.push(key); this.updateVehicle(id, { bankKeys: keys }); }
  pickVehicleAttachment(id) { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.onchange = () => { const files = [...(inp.files || [])]; if (!files.length) return; const v = this.vehicleRows().find(x => x.id === id); if (!v) return; const attachments = Array.isArray(v.attachments) ? v.attachments.slice() : []; files.forEach(f => { const aid = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); attachments.push({ id: aid, name: f.name, type: f.type || '', size: f.size || 0 }); this.idbSet('vehicle:' + id + ':' + aid, { file: f }); }); this.updateVehicle(id, { attachments }); }; inp.click(); }
  async openVehicleAttachment(vehicleId, att) { const rec = await this.idbGet('vehicle:' + vehicleId + ':' + att.id); const file = rec && rec.file; if (!file) { this.setState({ msg: { kind: 'error', text: 'Pièce jointe indisponible : ajoutez-la de nouveau.' } }); return; } const url = URL.createObjectURL(file); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  // ---------- Employés : fiches de paie (archive locale) + salaires issus du rapprochement bancaire ----------
  empDocKey(name, month) { return String(name || '').trim() + '|' + month; } // month = 'AAAA-MM'
  saveEmpDocs(m) { this.setState({ empDocs: m }); this.saveJSON(Component.EMPDOCS_KEY, m); }
  // Agrège les heures travaillées par (employé, mois) à partir de la saisie hebdomadaire.
  empHoursByMonth() {
    const weeks = this.state.heures || {};
    const out = {}; // 'name|AAAA-MM' -> heures décimales
    Object.keys(weeks).forEach(k => {
      const monday = this.hParse(k);
      (weeks[k] && weeks[k].employees || []).forEach(emp => {
        const nm = String(emp.name || '').trim(); if (!nm) return;
        for (let i = 0; i < 7; i++) {
          const dt = new Date(monday); dt.setDate(dt.getDate() + i);
          const iso = this.hISO(dt);
          const d = (emp.days || {})[iso];
          if (!this.hDayHasData(d)) continue;
          const key = nm + '|' + iso.slice(0, 7);
          out[key] = (out[key] || 0) + this.hDayTotal(d);
        }
      });
    });
    return out;
  }
  pickEmpDoc(name, month, kind) {
    kind = kind === 'heures' ? 'heures' : 'paie'; // 'paie' = fiche de paie, 'heures' = feuille d'heures signée
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.doc,.docx'; inp.multiple = true;
    inp.onchange = () => {
      const files = [...(inp.files || [])]; if (!files.length) return;
      const dk = this.empDocKey(name, month);
      const m = { ...(this.state.empDocs || {}) }; const list = Array.isArray(m[dk]) ? m[dk].slice() : [];
      files.forEach(f => { const aid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); list.push({ id: aid, name: f.name, type: f.type || '', size: f.size || 0, kind }); this.idbSet('payslip:' + dk + ':' + aid, { file: f }); });
      m[dk] = list; this.saveEmpDocs(m);
    };
    inp.click();
  }
  async openEmpDoc(name, month, att) {
    const rec = await this.idbGet('payslip:' + this.empDocKey(name, month) + ':' + att.id); const file = rec && rec.file;
    if (!file) { this.setState({ msg: { kind: 'error', text: 'Pièce jointe indisponible : ajoutez-la de nouveau.' } }); return; }
    const url = URL.createObjectURL(file); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  deleteEmpDoc(name, month, att) {
    const dk = this.empDocKey(name, month); const m = { ...(this.state.empDocs || {}) };
    m[dk] = (m[dk] || []).filter(a => a.id !== att.id); if (!m[dk].length) delete m[dk];
    this.idbDel('payslip:' + dk + ':' + att.id); this.saveEmpDocs(m); this.setState({ empDelDoc: null });
  }
  // Rapproche une ligne bancaire à un salaire (employé + mois) : le montant de la ligne devient le salaire versé.
  linkBankSalary(bankKey, emp, month, monthLabel) {
    if (!emp || !month) { this.setState({ msg: { kind: 'error', text: 'Choisissez un employé et un mois pour rapprocher ce salaire.' } }); return; }
    this.setBankLink(bankKey, { ref: '', kind: 'Salaire', partner: `${emp} — ${monthLabel || month}`, emp, month });
  }
  // ---------- Agenda d'entreprise (événements manuels, 100 % hors ligne) ----------
  static AGENDA_CATS = [
    { key: 'Rendez-vous', color: '#1a56db' },
    { key: 'Transport / Ferry', color: '#0f766e' },
    { key: 'Congés / Absence', color: '#b45309' },
    { key: 'Administratif', color: '#7c3aed' },
    { key: 'Autre', color: '#475569' },
  ];
  agCatColor(cat) { const c = Component.AGENDA_CATS.find(x => x.key === cat); return c ? c.color : '#475569'; }
  agTodayIso() { const T = Component.TODAY; return `${T.y}-${this.dd(T.m)}-${this.dd(T.d)}`; }
  agParse(iso) { const p = String(iso || '').split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
  agIso(d) { return d.getFullYear() + '-' + this.dd(d.getMonth() + 1) + '-' + this.dd(d.getDate()); }
  agendaList() { return Array.isArray(this.state.agenda) ? this.state.agenda : []; }
  saveAgenda(arr) { this.setState({ agenda: arr }); this.saveJSON(Component.AGENDA_KEY, arr); }
  agMonthAnchor() { const m = this.state.agendaMonth; if (m && /^\d{4}-\d{2}$/.test(m)) return m; const T = Component.TODAY; return `${T.y}-${this.dd(T.m)}`; }
  agendaShiftMonth(delta) { const a = this.agMonthAnchor().split('-'); let y = +a[0], mo = +a[1] + delta; while (mo > 12) { mo -= 12; y++; } while (mo < 1) { mo += 12; y--; } this.setState({ agendaMonth: `${y}-${this.dd(mo)}` }); }
  agendaToday() { const T = Component.TODAY; this.setState({ agendaMonth: `${T.y}-${this.dd(T.m)}` }); }
  openAgendaNew(dateIso) { this.setState({ agendaEdit: { id: null, date: dateIso || this.agTodayIso(), time: '', title: '', cat: 'Rendez-vous', recur: 'none', note: '' } }); }
  openAgendaEdit(id) { const ev = this.agendaList().find(e => e.id === id); if (!ev) return; this.setState({ agendaEdit: { id: ev.id, date: ev.date, time: ev.time || '', title: ev.title || '', cat: ev.cat || 'Autre', recur: ev.recur || 'none', note: ev.note || '' } }); }
  closeAgendaEdit() { this.setState({ agendaEdit: null }); }
  setAgendaField(k, v) { this.setState({ agendaEdit: { ...(this.state.agendaEdit || {}), [k]: v } }); }
  commitAgenda() {
    const e = this.state.agendaEdit; if (!e) return;
    const title = (e.title || '').trim(); if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) { this.setState({ msg: { kind: 'error', text: 'Indiquez au moins un titre et une date valide.' } }); return; }
    const rec = { id: e.id || 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), date: e.date, time: (e.time || '').trim(), title, cat: e.cat || 'Autre', recur: ['weekly', 'monthly'].includes(e.recur) ? e.recur : 'none', note: (e.note || '').trim() };
    const arr = this.agendaList().slice(); const i = arr.findIndex(x => x.id === rec.id);
    if (i >= 0) arr[i] = rec; else arr.push(rec);
    this.saveAgenda(arr); this.setState({ agendaEdit: null });
  }
  askDeleteAgenda(id) { const ev = this.agendaList().find(e => e.id === id); if (ev) this.setState({ agendaDelAsk: ev }); }
  deleteAgendaEvent() { const ev = this.state.agendaDelAsk; if (!ev) return; this.saveAgenda(this.agendaList().filter(e => e.id !== ev.id)); this.setState({ agendaDelAsk: null, agendaEdit: null }); }
  // Développe les occurrences (récurrence hebdo/mensuelle) sur la fenêtre [fromIso, toIso].
  agendaOccurrences(fromIso, toIso) {
    const from = this.agParse(fromIso), to = this.agParse(toIso); const out = [];
    this.agendaList().forEach(ev => {
      const base = this.agParse(ev.date); if (isNaN(base.getTime())) return;
      if (ev.recur === 'weekly') { const d = new Date(base); while (d < from) d.setDate(d.getDate() + 7); for (; d <= to; d.setDate(d.getDate() + 7)) out.push({ ev, iso: this.agIso(d) }); }
      else if (ev.recur === 'monthly') { const d = new Date(base); while (d < from) d.setMonth(d.getMonth() + 1); for (; d <= to; d.setMonth(d.getMonth() + 1)) out.push({ ev, iso: this.agIso(d) }); }
      else if (base >= from && base <= to) out.push({ ev, iso: this.agIso(base) });
    });
    out.sort((a, b) => a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : (a.ev.time || '').localeCompare(b.ev.time || ''));
    return out;
  }
  // ---------- Suivi de paiement (saisie manuelle, structure « Suivi des paiements ») ----------
  payTrackRows() { return Array.isArray(this.state.payTrack) ? this.state.payTrack : []; }
  savePayTrack(arr) { this.setState({ payTrack: arr }); this.saveJSON(Component.PAYTRACK_KEY, arr); }
  _payNextId() { const ids = this.payTrackRows().map(r => +r.id || 0); return (ids.length ? Math.max(...ids) : 141) + 1; }
  _payTodayIso() { const T = Component.TODAY; return `${T.y}-${this.dd(T.m)}-${this.dd(T.d)}`; }
  payDefault() { return { id: this._payNextId(), num: '', client: '', ttc: '', avoir: '', dateFac: this._payTodayIso(), dateEch: '', regle: '', datePay: '', etat: 'En attente', editing: false }; }
  setPayField(k, v) { const d = this.state.payDraft || this.payDefault(); this.setState({ payDraft: { ...d, [k]: v } }); }
  resetPayDraft() { this.setState({ payDraft: this.payDefault() }); }
  editPayRow(id) { const r = this.payTrackRows().find(x => String(x.id) === String(id)); if (!r) return; this.setState({ payDraft: { ...r, ttc: r.ttc === '' ? '' : String(r.ttc), avoir: r.avoir === '' ? '' : String(r.avoir), regle: r.regle === '' ? '' : String(r.regle), editing: true } }); }
  commitPay() {
    const d = this.state.payDraft || this.payDefault();
    const client = (d.client || '').trim();
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; };
    if (!client || !(num(d.ttc) > 0)) { this.setState({ msg: { kind: 'error', text: 'Indiquez au moins le nom du client et un Montant TTC.' } }); return; }
    const rec = { id: +d.id || this._payNextId(), num: (d.num || '').trim(), client, ttc: num(d.ttc), avoir: num(d.avoir), dateFac: d.dateFac || '', dateEch: d.dateEch || '', regle: num(d.regle), datePay: d.datePay || '', etat: d.etat || 'En attente' };
    const arr = this.payTrackRows().slice(); const i = arr.findIndex(x => String(x.id) === String(rec.id));
    if (i >= 0) arr[i] = rec; else arr.unshift(rec);
    this.savePayTrack(arr); this.setState({ payDraft: this.payDefault() });
  }
  askDeletePay(id) { const r = this.payTrackRows().find(x => String(x.id) === String(id)); if (r) this.setState({ payDelAsk: r }); }
  deletePayRow() { const r = this.state.payDelAsk; if (!r) return; this.savePayTrack(this.payTrackRows().filter(x => String(x.id) !== String(r.id))); this.setState({ payDelAsk: null }); }
  // ---------- Saisie de vente (transaction manuelle : facture complète) ----------
  venteSaisieRows() { return Array.isArray(this.state.ventesSaisie) ? this.state.ventesSaisie : []; }
  saveVenteSaisie(arr) { this.setState({ ventesSaisie: arr }); this.saveJSON(Component.VSAISIE_KEY, arr); }
  grenkeManRows() { return Array.isArray(this.state.grenkeMan) ? this.state.grenkeMan : []; }
  saveGrenkeMan(arr) { this.setState({ grenkeMan: arr }); this.saveJSON(Component.GRKMAN_KEY, arr); }
  _vNum(v) { const n = parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; }
  _addDaysIso(iso, days) { if (!iso) return ''; const p = String(iso).split('-').map(Number); const d = new Date(p[0], (p[1] || 1) - 1, p[2] || 1); d.setDate(d.getDate() + (+days || 0)); return d.getFullYear() + '-' + this.dd(d.getMonth() + 1) + '-' + this.dd(d.getDate()); }
  _venteNextId() { const fromFile = (this.state.ventes || []).map(r => +String(r.ref || '').replace(/\D/g, '') || 0); const ids = [...fromFile, ...this.venteSaisieRows().map(r => +r.id || 0), ...this.payTrackRows().map(r => +r.id || 0)]; return (ids.length ? Math.max(...ids) : 0) + 1; }
  compEmptyLigne() { const e = Object.keys(Component.ESP)[0]; return { espece: e, calibre: (Component.ESP[e] || ['Standard'])[0], poids: '', prixKg: '' }; }
  openCompForm(mode) { this.setState({ compTab: mode, compFan: null }); if (mode === 'Achat') { this.resetAchatDraft(); this.refreshAchatInvoiceNumber(); this._refreshChequiersLive(); } else if (mode === 'Fournisseur') this.resetFournDraft(); else if (mode === 'Paiement') { this.setState({ paiementDraft: null }); this._refreshChequiersLive(); } else { this.resetVenteDraft(); this.refreshVenteInvoiceNumber(); this.refreshVenteIdFacture(); } }
  // RÈGLE 5 (achat pêcheur) : lit le n° de facture pré-imprimé de la prochaine ligne à remplir
  // (colonne « N° de facture ») et le propose, modifiable. Non bloquant si non réglé/connecté.
  async refreshAchatInvoiceNumber() {
    try {
      const cfg = this.writeMapFor('operations'); if (!cfg || !cfg.enabled || !cfg.cols) return;
      const hi = this._writableHandleFor('operations'); if (!hi || !hi.handle) return;
      const f = await hi.handle.getFile(); const buf = await f.arrayBuffer();
      const wb = await this.readWorkbook(buf.slice(0)); const sh = wb.find(s => s.name === cfg.sheetName); if (!sh) return;
      const hdrIdx = cfg.headerRowIdx != null ? cfg.headerRowIdx : 1;
      const invCol = cfg.cols.ref; if (invCol == null || invCol < 0) return; // colonne déjà réglée dans Paramètres
      const anchorKeys = this._anchorFieldsFor('operations');
      const af = this.writeFieldsFor('operations').filter(x => cfg.cols[x.key] != null && anchorKeys.indexOf(x.key) >= 0);
      const idxs = af.length ? af.map(x => cfg.cols[x.key]) : Object.keys(cfg.cols).map(k => cfg.cols[k]);
      const dateKey = Object.keys(this._dateFieldsFor('operations')).find(k => anchorKeys.indexOf(k) >= 0 && cfg.cols[k] != null && cfg.cols[k] >= 0);
      const dateColIdx = dateKey != null ? cfg.cols[dateKey] : -1;
      const loc = await this._locateAppendTarget(buf.slice(0), cfg.sheetName, idxs, cfg.firstDataIdx != null ? cfg.firstDataIdx : (hdrIdx + 1), dateColIdx);
      const row = sh.rows[loc.previewIdx] || []; const preNum = String(row[invCol] == null ? '' : row[invCol]).trim();
      if (preNum) {
        if (this.state.view !== 'SaisieCompta' || this.state.compTab !== 'Achat') return; // vue/onglet quittés pendant l'attente : abandon silencieux
        const d = this.state.achatDraft; if (d && !d.editing) this.setState({ achatDraft: { ...d, num: preNum, numFromFile: true, numRow: loc.excelRow } });
      }
    } catch (e) { /* non bloquant */ }
  }
  // RÈGLE 5 : le n° de facture est LU dans le fichier (n° réellement pré-imprimé de la prochaine ligne
  // à remplir), jamais fabriqué. Reste entièrement modifiable. Non bloquant si le fichier n'est pas réglé.
  async refreshVenteInvoiceNumber() {
    try {
      const cfg = this.writeMapFor('ventes'); if (!cfg || !cfg.enabled || !cfg.cols) return;
      const hi = this._writableHandleFor('ventes'); if (!hi || !hi.handle) return;
      const f = await hi.handle.getFile(); const buf = await f.arrayBuffer();
      const wb = await this.readWorkbook(buf.slice(0)); const sh = wb.find(s => s.name === cfg.sheetName); if (!sh) return;
      const hdrIdx = cfg.headerRowIdx != null ? cfg.headerRowIdx : 0;
      const invCol = cfg.cols.ref; if (invCol == null || invCol < 0) return; // colonne déjà réglée dans Paramètres
      const fields = this.writeFieldsFor('ventes').filter(x => cfg.cols[x.key] != null && cfg.cols[x.key] >= 0);
      const venteAnchorKeys = this._anchorFieldsFor('ventes');
      const venteDateKey = Object.keys(this._dateFieldsFor('ventes')).find(k => venteAnchorKeys.indexOf(k) >= 0 && cfg.cols[k] != null && cfg.cols[k] >= 0);
      const venteDateColIdx = venteDateKey != null ? cfg.cols[venteDateKey] : -1;
      const loc = await this._locateAppendTarget(buf.slice(0), cfg.sheetName, fields.map(x => cfg.cols[x.key]), cfg.firstDataIdx != null ? cfg.firstDataIdx : (hdrIdx + 1), venteDateColIdx);
      const row = sh.rows[loc.previewIdx] || [];
      const preNum = String(row[invCol] == null ? '' : row[invCol]).trim();
      if (preNum) { const d = this.state.venteDraft; if (d && !d.editing) this.setState({ venteDraft: { ...d, num: preNum, numFromFile: true, numRow: loc.excelRow } }); }
    } catch (e) { /* non bloquant : on garde le n° courant */ }
  }
  // ID Facture (colonne dédiée, ex. colonne I) : PAS pré-imprimé comme le n° de facture — calculé
  // comme dernier ID existant + 1, lu directement dans le fichier (même logique que _venteNextId(),
  // mais sur la vraie colonne Excel plutôt que sur les chiffres du n° de facture).
  async refreshVenteIdFacture() {
    try {
      const cfg = this.writeMapFor('ventes'); if (!cfg || !cfg.enabled || !cfg.cols) return;
      const idCol = cfg.cols.idFacture; if (idCol == null || idCol < 0) return; // colonne pas encore réglée dans Paramètres
      const hi = this._writableHandleFor('ventes'); if (!hi || !hi.handle) return;
      const f = await hi.handle.getFile(); const buf = await f.arrayBuffer();
      const wb = await this.readWorkbook(buf); const sh = wb.find(s => s.name === cfg.sheetName); if (!sh) return;
      const hdrIdx = cfg.headerRowIdx != null ? cfg.headerRowIdx : 0;
      const firstData = cfg.firstDataIdx != null ? cfg.firstDataIdx : (hdrIdx + 1);
      let max = 0;
      for (let r = firstData; r < sh.rows.length; r++) { const v = (sh.rows[r] || [])[idCol]; const n = parseInt(String(v == null ? '' : v).trim(), 10); if (!isNaN(n) && n > max) max = n; }
      const d = this.state.venteDraft; if (d && !d.editing) this.setState({ venteDraft: { ...d, idFacture: String(max + 1) } });
    } catch (e) { /* non bloquant : on garde l'ID courant */ }
  }
  venteDefault() { const t = this._payTodayIso(); return { id: this._venteNextId(), num: '', idFacture: '', client: '', date: t, delai: '30', datePrev: this._addDaysIso(t, 30), lignes: [this.compEmptyLigne()], tvaIrl: '', tvaFr: '', grenke: null, avoirActif: false, avoir: '', editing: false }; }
  setVenteField(k, v) { const d = this.state.venteDraft || this.venteDefault(); const patch = { ...d, [k]: v }; if (k === 'delai') patch.datePrev = this._addDaysIso(d.date, Math.max(0, Math.min(30, Math.round(this._vNum(v))))); if (k === 'date') patch.datePrev = this._addDaysIso(v, Math.max(0, Math.min(30, Math.round(this._vNum(d.delai))))); this.setState({ venteDraft: patch }); }
  setVenteLigne(i, k, v) { const d = this.state.venteDraft || this.venteDefault(); const lignes = (d.lignes || []).map((l, j) => { if (j !== i) return l; const nl = { ...l, [k]: v }; if (k === 'espece') nl.calibre = (Component.ESP[v] || ['Standard'])[0]; return nl; }); this.setState({ venteDraft: { ...d, lignes } }); }
  addVenteLigne() { const d = this.state.venteDraft || this.venteDefault(); this.setState({ venteDraft: { ...d, lignes: [...(d.lignes || []), this.compEmptyLigne()] } }); }
  removeVenteLigne(i) { const d = this.state.venteDraft || this.venteDefault(); const lignes = (d.lignes || []).filter((l, j) => j !== i); this.setState({ venteDraft: { ...d, lignes: lignes.length ? lignes : [this.compEmptyLigne()] } }); }
  resetVenteDraft() { this.setState({ venteDraft: this.venteDefault() }); }
  // Modifier une vente est désactivé tant que l'écriture Excel ne le gère pas (pas de divergence).
  openVenteGrenke() { const d = this.state.venteDraft || this.venteDefault(); const g = d.grenke || {}; this.setState({ venteGrenke: { montant: g.montant == null ? '' : String(g.montant), p1: g.p1 == null ? '' : String(g.p1), p2: g.p2 == null ? '' : String(g.p2), charges: g.charges == null ? '' : String(g.charges) } }); }
  setVenteGrenkeField(k, v) { this.setState({ venteGrenke: { ...(this.state.venteGrenke || {}), [k]: v } }); }
  saveVenteGrenke() { const g = this.state.venteGrenke || {}; const montant = this._vNum(g.montant); const d = this.state.venteDraft || this.venteDefault(); let grenke = null; if (montant > 0) { const p1 = this._vNum(g.p1), p2 = this._vNum(g.p2), charges = this._vNum(g.charges); grenke = { montant, p1, p2, charges, rest: Math.round((montant - p1 - p2 - charges) * 100) / 100 }; } this.setState({ venteDraft: { ...d, grenke }, venteGrenke: null }); }
  closeVenteGrenke() { this.setState({ venteGrenke: null }); }
  commitVenteSaisie() {
    const d = this.state.venteDraft || this.venteDefault();
    const client = (d.client || '').trim();
    const lignes = (d.lignes || []).map(l => ({ espece: (l.espece || '').trim(), calibre: (l.calibre || '').trim(), poids: this._vNum(l.poids), prixKg: this._vNum(l.prixKg) })).filter(l => l.poids > 0 && l.prixKg > 0);
    if (!client || !lignes.length) { this.setState({ msg: { kind: 'error', text: 'Indiquez le client et au moins une espèce avec un poids et un prix.' } }); return; }
    lignes.forEach(l => { l.montant = Math.round(l.poids * l.prixKg * 100) / 100; });
    const ht = Math.round(lignes.reduce((s, l) => s + l.montant, 0) * 100) / 100;
    const tvaIrl = this._vNum(d.tvaIrl), tvaFr = this._vNum(d.tvaFr);
    const ttc = Math.round((ht + tvaIrl + tvaFr) * 100) / 100;
    const delai = Math.max(0, Math.min(30, Math.round(this._vNum(d.delai))));
    const datePrev = this._addDaysIso(d.date, delai);
    const id = +d.id || this._venteNextId();
    const grenke = (d.grenke && this._vNum(d.grenke.montant) > 0) ? d.grenke : null;
    const avoir = (d.avoirActif && this._vNum(d.avoir) > 0) ? this._vNum(d.avoir) : 0;
    const rec = { id, num: (d.num || '').trim(), idFacture: (d.idFacture || '').trim(), client, date: d.date || '', lignes, ht, tvaIrl, tvaFr, ttc, delai, datePrev, grenke, avoir };
    const arr = this.venteSaisieRows().slice(); const i = arr.findIndex(x => String(x.id) === String(id));
    // Circuit A — le fichier Excel fait foi. Une vente n'est enregistrée QUE si l'écriture
    // Excel réussit (aperçu → confirmation → relecture de contrôle). Aucune compta parallèle :
    // les vues opérationnelles (suivi de paiement, Grenke) ne sont alimentées qu'APRÈS le succès.
    if (i >= 0) { this.setState({ msg: { kind: 'error', text: 'La modification d’une vente déjà enregistrée n’est pas encore disponible : corrigez-la directement dans votre fichier Excel. (Bientôt : correction guidée.)' } }); return; }
    if (!this._venteWriteReady()) { this.setState({ msg: { kind: 'error', text: 'Avant d’enregistrer une vente, réglez l’écriture de votre fichier : Paramètres → « Ventes client » → « Régler l’écriture », puis connectez le fichier. Rien n’est enregistré tant que le fichier ne peut pas être écrit.' } }); return; }
    // ID Facture s'écrit toujours dans « Suivi des paiements » (pour que les formules s'y
    // accrochent, avoir ou non) ; Avoir n'y est écrit que si > 0 — même transaction editsBySheet
    // que l'écriture Factures (voir requestAppendPreview).
    this.requestAppendPreview('ventes', this.venteWriteValues(rec), { refuseFormula: true, suiviAvoir: rec.idFacture ? { avoir, idFacture: rec.idFacture } : null, after: () => this._venteAfterWrite(rec), afterClose: () => {
      if (this._stockDir) { this._writeQueue = [() => this.requestStockPreview(rec, 'vente')]; this._runNextWrite(); }
    } });
  }
  _venteWriteReady() { const cfg = this.writeMapFor('ventes'); if (!cfg || !cfg.enabled || !cfg.cols) return false; const hi = this._writableHandleFor('ventes'); return !!(hi && hi.handle); }
  // Appelé UNIQUEMENT après une écriture Excel confirmée et vérifiée : met à jour les vues
  // opérationnelles internes (suivi de paiement, Grenke) et affiche le récapitulatif.
  async _venteAfterWrite(rec) {
    const id = rec.id, client = rec.client, ttc = rec.ttc, datePrev = rec.datePrev, delai = rec.delai, ht = rec.ht, grenke = rec.grenke, lignes = rec.lignes;
    const arr = this.venteSaisieRows().slice(); const i = arr.findIndex(x => String(x.id) === String(id));
    if (i >= 0) arr[i] = rec; else arr.unshift(rec);
    this.saveVenteSaisie(arr);
    const pt = this.payTrackRows().slice(); const pi = pt.findIndex(x => String(x.id) === String(id));
    const ptRec = { id, num: rec.num, client, ttc, avoir: pi >= 0 ? this._vNum(pt[pi].avoir) : (rec.avoir || 0), dateFac: rec.date, dateEch: datePrev, regle: pi >= 0 ? this._vNum(pt[pi].regle) : 0, datePay: (pi >= 0 ? pt[pi].datePay : '') || '', etat: (pi >= 0 ? pt[pi].etat : 'En attente') || 'En attente' };
    if (pi >= 0) pt[pi] = ptRec; else pt.unshift(ptRec);
    this.savePayTrack(pt);
    const gm = this.grenkeManRows().slice(); const gi = gm.findIndex(x => String(x.id) === String(id));
    if (grenke) { const g = { id, num: rec.num, cust: client, ttc: grenke.montant, p1: grenke.p1, p2: grenke.p2, charge: grenke.charges, statut: (gi >= 0 ? gm[gi].statut : 'En cours') || 'En cours', com: (gi >= 0 ? gm[gi].com : '') || '', fromVente: true }; if (gi >= 0) gm[gi] = g; else gm.unshift(g); this.saveGrenkeMan(gm); }
    else if (gi >= 0 && gm[gi].fromVente) { gm.splice(gi, 1); this.saveGrenkeMan(gm); }
    const espLbl = lignes.map(l => `${l.espece} ${l.calibre} −${l.poids} kg`).join(' · ');
    const cards = [{ l: '📦 Stock', v: espLbl }, { l: '🏷️ Facture client', v: `${rec.num} — ${client} · TTC ${this.fmt(ttc)} · ${delai === 0 ? 'comptant' : 'délai ' + delai + ' j'} · prévue ${this.dd((datePrev.split('-')[2] || 0))}/${this.dd((datePrev.split('-')[1] || 0))}` }, { l: '💳 Suivi de paiement', v: `Solde à encaisser ${this.fmt(ttc)}` }, { l: '📊 Analytique', v: `Chiffre d'affaires (HT) ${this.fmt(ht)}` }];
    if (grenke) cards.push({ l: '🏦 Grenke', v: `Financé ${this.fmt(grenke.montant)} · restant dû ${this.fmt(grenke.rest)}` });
    await this._appendNextBlankRow('ventes'); // CORRECTION 2 — best-effort, ne bloque jamais la saisie ; awaited pour que le refresh ci-dessous lise le fichier à jour
    // Le stock (best-effort) n'est plus déclenché ici : requestAppendPreview le programme via
    // afterClose, exécuté par confirmAppendWrite juste après la fermeture de CETTE modale — ordre
    // garanti, sans dépendre du temps que met refreshVenteInvoiceNumber (I/O réelle) ci-dessous.
    this.setState({ venteDraft: this.venteDefault(), compFan: { mode: 'vente', title: `Vente de ${lignes.length} espèce${lignes.length > 1 ? 's' : ''} à ${client}`, cards } });
    await this.refreshVenteInvoiceNumber(); // BUG 2 — après la ligne vierge ET après la réinitialisation du draft
  }
  // ---------- Enregistrement des paiements Grenke (manuel, structure feuille « Grenke ») ----------
  _grkNextId() { const ids = [...this.grenkeManRows().map(r => +r.id || 0), ...this.venteSaisieRows().map(r => +r.id || 0), ...this.payTrackRows().map(r => +r.id || 0)]; return (ids.length ? Math.max(...ids) : 141) + 1; }
  grkDefault() { return { id: this._grkNextId(), num: '', cust: '', ttc: '', p1: '', p2: '', charge: '', statut: 'En cours', com: '', editing: false }; }
  setGrkField(k, v) {
    const d = this.state.grkDraft || this.grkDefault();
    const patch = { ...d, [k]: v };
    // Pré-remplissage : dès que le n° de facture correspond à un dossier/facture connu,
    // les informations déjà notées (client, TTC, paiements…) se remplissent toutes seules.
    if (k === 'num' && !d.editing) {
      const key = this.gNumKey(v);
      if (key) {
        const g = this.state.grenke; const glist = (g && g.list) ? g.list : (Array.isArray(g) ? g : []);
        const gi = glist.find(x => this.gNumKey(x.ref) === key);
        if (gi) {
          if (!String(d.cust || '').trim() && gi.cust) patch.cust = gi.cust;
          if (!this._vNum(d.ttc) && gi.ttc) patch.ttc = String(gi.ttc);
          if (!this._vNum(d.p1) && gi.p1) patch.p1 = String(gi.p1);
          if (!this._vNum(d.p2) && gi.p2) patch.p2 = String(gi.p2);
          if (!this._vNum(d.charge) && gi.charge) patch.charge = String(gi.charge);
        }
        if (!String(patch.cust || '').trim() || !this._vNum(patch.ttc)) {
          const ven = this.state.ventes; const vlist = (ven && ven.list) ? ven.list : (Array.isArray(ven) ? ven : []);
          const vi = vlist.find(x => this.gNumKey(x.ref) === key);
          if (vi) {
            if (!String(patch.cust || '').trim() && vi.partner && vi.partner !== '—') patch.cust = vi.partner;
            if (!this._vNum(patch.ttc) && vi.ttc) patch.ttc = String(vi.ttc);
          }
        }
        if (!String(patch.cust || '').trim() || !this._vNum(patch.ttc)) {
          const pi = this.payTrackRows().find(x => this.gNumKey(x.num) === key);
          if (pi) {
            if (!String(patch.cust || '').trim() && pi.client) patch.cust = pi.client;
            if (!this._vNum(patch.ttc) && pi.ttc) patch.ttc = String(pi.ttc);
          }
        }
      }
    }
    this.setState({ grkDraft: patch });
  }
  resetGrkDraft() { this.setState({ grkDraft: this.grkDefault() }); }
  editGrkRow(id) { const r = this.grenkeManRows().find(x => String(x.id) === String(id)); if (!r) return; this.setState({ grkDraft: { ...r, ttc: String(r.ttc == null ? '' : r.ttc), p1: String(r.p1 == null ? '' : r.p1), p2: String(r.p2 == null ? '' : r.p2), charge: String(r.charge == null ? '' : r.charge), editing: true } }); }
  commitGrk() {
    const d = this.state.grkDraft || this.grkDefault();
    const cust = (d.cust || '').trim();
    const ttc = this._vNum(d.ttc);
    if (!cust || !(ttc > 0)) { this.setState({ msg: { kind: 'error', text: 'Indiquez au moins le client et le Total TTC du dossier Grenke.' } }); return; }
    const id = +d.id || this._grkNextId();
    const prev = this.grenkeManRows().find(x => String(x.id) === String(id));
    const rec = { id, num: (d.num || '').trim(), cust, ttc, p1: this._vNum(d.p1), p2: this._vNum(d.p2), charge: this._vNum(d.charge), statut: d.statut || 'En cours', com: (d.com || '').trim(), fromVente: prev ? !!prev.fromVente : false };
    const arr = this.grenkeManRows().slice(); const i = arr.findIndex(x => String(x.id) === String(id));
    if (i >= 0) arr[i] = rec; else arr.unshift(rec);
    this.saveGrenkeMan(arr); this.setState({ grkDraft: this.grkDefault() });
    this.requestGrenkeUpdate(rec); // écrit le paiement dans la feuille « Grenke » du fichier de ventes
  }
  // Le paiement enregistré est réécrit dans la feuille « Grenke » du fichier de ventes :
  // dossier existant → mise à jour de SES cases (paiements, charges, statut) ; sinon → nouvelle ligne.
  async requestGrenkeUpdate(rec) {
    const hi = this._writableHandleFor('ventes');
    if (!hi || !hi.handle) return; // pas de fichier connecté → le paiement reste dans le tableau de bord
    try {
      const okPerm = await this._ensureWritePermission(hi.handle); if (!okPerm) return;
      const file = await hi.handle.getFile(); const buf = await file.arrayBuffer();
      const wb = await this.readWorkbook(buf);
      const gs = wb.find(s => /grenke/i.test(s.name)); if (!gs) return;
      const norm = s => this._norm(s);
      let hIdx = -1, cols = null;
      for (let i = 0; i < Math.min(gs.rows.length, 10); i++) {
        const h = (gs.rows[i] || []).map(norm);
        const inv = h.findIndex(x => x.includes('invoice'));
        if (inv >= 0) { hIdx = i; cols = { inv, cust: h.findIndex(x => x.includes('customer')), ttc: h.findIndex(x => x.includes('total ttc')), p1: h.findIndex(x => x.includes('1er')), p2: h.findIndex(x => x.includes('2e')), charge: h.findIndex(x => x.includes('charge')), statut: h.findIndex(x => x.includes('statut')) }; break; }
      }
      if (!cols || cols.inv < 0) return;
      const key = this.gNumKey(rec.num);
      let rowIdx = -1;
      if (key) for (let r = hIdx + 1; r < gs.rows.length; r++) { if (this.gNumKey(String((gs.rows[r] || [])[cols.inv] ?? '')) === key) { rowIdx = r; break; } }
      const colName = n => { let s = '', m = n; while (m > 0) { const q = (m - 1) % 26; s = String.fromCharCode(65 + q) + s; m = Math.floor((m - 1) / 26); } return s; };
      const colVals = {}; const preview = [];
      const put = (ci, val, label) => { if (ci >= 0 && val !== '' && val != null) { colVals[ci] = val; preview.push({ label, col: colName(ci + 1), value: String(val) }); } };
      const isUpdate = rowIdx >= 0;
      let previewIdx = rowIdx, mode = 'patch', excelRow = null;
      if (!isUpdate) {
        const loc = await this._locateAppendTarget(buf, gs.name, [cols.inv], hIdx + 1);
        previewIdx = loc.previewIdx; mode = loc.mode; excelRow = loc.excelRow;
        put(cols.inv, rec.num, 'Invoice Number'); put(cols.ttc, rec.ttc, 'Total TTC');
      }
      put(cols.cust, rec.cust, 'Customer');
      put(cols.p1, rec.p1 || '', '1er paiement'); put(cols.p2, rec.p2 || '', '2e paiement');
      put(cols.charge, rec.charge || '', 'Charges'); put(cols.statut, rec.statut || '', 'Statut');
      if (!Object.keys(colVals).length) return;
      const after = async (pbuf) => {
        try {
          const wb2 = await this.readWorkbook(pbuf);
          this._wbCache = this._wbCache || {}; this._wbCache.ventes = { wb: wb2, name: hi.name, handle: hi.handle, lastMod: Date.now() };
          this.extractGrenke(wb2, hi.name); // la table des dossiers se met à jour
          this.saveGrenkeMan(this.grenkeManRows().filter(x => String(x.id) !== String(rec.id))); // plus de doublon manuel
        } catch (e) {}
      };
      this._pendingWrite = { kind: 'ventes', buf, handle: hi.handle, name: hi.name, sheetName: gs.name, excelRow, previewIdx, mode, colVals, after };
      this.setState({ writePreview: { kind: 'ventes', fileName: hi.name, sheetName: gs.name, excelRow, rows: preview, status: null, update: isUpdate, updateNum: rec.num || '' } });
    } catch (e) { /* silencieux : le paiement est déjà enregistré dans le tableau de bord */ }
  }
  askDeleteGrk(id) { const r = this.grenkeManRows().find(x => String(x.id) === String(id)); if (r) this.setState({ grkDelAsk: r }); }
  deleteGrkRow() { const r = this.state.grkDelAsk; if (!r) return; this.saveGrenkeMan(this.grenkeManRows().filter(x => String(x.id) !== String(r.id))); this.setState({ grkDelAsk: null }); }
  // ---------- Saisie d'achat pêcheur (transaction manuelle : panier multi-espèces) ----------
  achatSaisieRows() { return Array.isArray(this.state.achatsSaisie) ? this.state.achatsSaisie : []; }
  saveAchatSaisie(arr) { this.setState({ achatsSaisie: arr }); this.saveJSON(Component.ACHSAISIE_KEY, arr); }
  // Chéquiers lus automatiquement depuis les onglets du fichier operations (plus de saisie manuelle).
  chequierRows() { return Array.isArray(this.state.chequiersLive) ? this.state.chequiersLive : []; }
  // Dernier numéro utilisé sur un onglet chéquier : dernière ligne dont MONTANT est rempli et ≠ CANCELLED.
  _scanChequierSheet(sh) {
    const rows = sh.rows; const U = c => String(c == null ? '' : c).trim().toUpperCase();
    let hi = -1; for (let r = 0; r < Math.min(rows.length, 10); r++) { if ((rows[r] || []).some(c => U(c) === 'NUMERO')) { hi = r; break; } }
    if (hi < 0) return null;
    const hdr = rows[hi]; const zones = [];
    for (let c = 0; c < hdr.length; c++) { if (U(hdr[c]) === 'NUMERO') { const z = { num: c, mont: -1 }; for (let k = c + 1; k < hdr.length; k++) { const l = U(hdr[k]); if (l === 'NUMERO') break; if (l === 'MONTANT' && z.mont < 0) z.mont = k; } zones.push(z); } }
    if (!zones.length) return null;
    let lastUsed = 0;
    for (let r = hi + 1; r < rows.length; r++) {
      for (const z of zones) {
        const numRaw = rows[r][z.num]; if (numRaw === '' || numRaw == null) continue;
        const montStr = U(z.mont >= 0 ? rows[r][z.mont] : '');
        if (montStr === '' || montStr === 'CANCELLED') continue; // chèque pas encore utilisé, ou annulé
        const n = this._vNum(numRaw); if (n > lastUsed) lastUsed = n;
      }
    }
    return lastUsed;
  }
  // Relit les onglets chéquiers (noms 100% numériques, ex. « 516000 ») dans le fichier operations
  // connecté, et calcule le prochain numéro pour chacun. Best-effort, ne bloque jamais l'UI.
  async _refreshChequiersLive() {
    const hi = this._writableHandleFor('operations');
    if (!hi || !hi.handle) { this.setState({ chequiersLive: [] }); return; }
    try {
      const file = await hi.handle.getFile();
      const buf = await file.arrayBuffer();
      const wb = await this.readWorkbook(buf);
      const list = wb
        .filter(s => /^\d+$/.test(String(s.name || '').trim()))
        .map(s => { const last = this._scanChequierSheet(s); return { nom: String(s.name).trim(), next: (last || 0) + 1 }; })
        .sort((a, b) => (parseInt(a.nom, 10) || 0) - (parseInt(b.nom, 10) || 0));
      this.setState({ chequiersLive: list });
    } catch (e) { this.setState({ chequiersLive: [] }); }
  }
  _achatNextId() { const fromFile = (this.state.ops || []).map(r => +String(r.ref || '').replace(/\D/g, '') || 0); const ids = [...fromFile, ...this.achatSaisieRows().map(r => +r.id || 0)]; return (ids.length ? Math.max(...ids) : 0) + 1; }
  achatDefault() { return { id: this._achatNextId(), num: '', pecheur: '', date: this._payTodayIso(), lignes: [this.compEmptyLigne()], paiement: 'virement', chequier: '', chequeNum: '', observation: '', paiementImmediat: false, editing: false }; }
  setAchatField(k, v) { const d = this.state.achatDraft || this.achatDefault(); const patch = { ...d, [k]: v }; if (k === 'paiement' && v === 'cheque') { const first = this.chequierRows()[0]; if (first && !patch.chequier) { patch.chequier = first.nom; patch.chequeNum = String(first.next || ''); } } if (k === 'chequier') { const cq = this.chequierRows().find(c => c.nom === v); if (cq) patch.chequeNum = String(cq.next || ''); } this.setState({ achatDraft: patch }); }
  setAchatLigne(i, k, v) { const d = this.state.achatDraft || this.achatDefault(); const lignes = (d.lignes || []).map((l, j) => { if (j !== i) return l; const nl = { ...l, [k]: v }; if (k === 'espece') nl.calibre = (Component.ESP[v] || ['Standard'])[0]; return nl; }); this.setState({ achatDraft: { ...d, lignes } }); }
  addAchatLigne() { const d = this.state.achatDraft || this.achatDefault(); this.setState({ achatDraft: { ...d, lignes: [...(d.lignes || []), this.compEmptyLigne()] } }); }
  removeAchatLigne(i) { const d = this.state.achatDraft || this.achatDefault(); const lignes = (d.lignes || []).filter((l, j) => j !== i); this.setState({ achatDraft: { ...d, lignes: lignes.length ? lignes : [this.compEmptyLigne()] } }); }
  resetAchatDraft() { this.setState({ achatDraft: this.achatDefault() }); }
  // Modifier / Supprimer un achat sont désactivés tant que l'écriture Excel ne les gère pas.
  _achatWriteReady() { const cfg = this.writeMapFor('operations'); if (!cfg || !cfg.enabled || !cfg.cols) return false; const hi = this._writableHandleFor('operations'); return !!(hi && hi.handle); }
  commitAchatSaisie() {
    const d = this.state.achatDraft || this.achatDefault();
    const pecheur = (d.pecheur || '').trim();
    const lignes = (d.lignes || []).map(l => ({ espece: (l.espece || '').trim(), calibre: (l.calibre || '').trim(), poids: this._vNum(l.poids), prixKg: this._vNum(l.prixKg) })).filter(l => l.poids > 0 && l.prixKg > 0);
    if (!pecheur || !lignes.length) { this.setState({ msg: { kind: 'error', text: 'Indiquez le pêcheur et au moins une espèce avec un poids et un prix.' } }); return; }
    lignes.forEach(l => { l.montant = Math.round(l.poids * l.prixKg * 100) / 100; });
    const total = Math.round(lignes.reduce((s, l) => s + l.montant, 0) * 100) / 100;
    const id = +d.id || this._achatNextId();
    const arr = this.achatSaisieRows().slice(); const i = arr.findIndex(x => String(x.id) === String(id));
    // Circuit B — le fichier Excel fait foi. Un achat n'est enregistré QUE si l'écriture Excel réussit.
    if (i >= 0) { this.setState({ msg: { kind: 'error', text: 'La modification d’un achat déjà enregistré n’est pas encore disponible : corrigez-le directement dans votre fichier Excel.' } }); return; }
    if (!this._achatWriteReady()) { this.setState({ msg: { kind: 'error', text: 'Avant d’enregistrer un achat, réglez l’écriture de votre fichier : Paramètres → « Achat pêcheur » → « Régler l’écriture », puis connectez le fichier. Rien n’est enregistré tant que le fichier ne peut pas être écrit.' } }); return; }
    const paiement = d.paiement || 'virement';
    const observation = (d.observation || '').trim();
    if (paiement === 'autre' && !observation) { this.setState({ msg: { kind: 'error', text: 'Indiquez une observation (ex. BB, accord verbal…) pour le moyen de paiement « Autre ».' } }); return; }
    // Le n° de chèque est PRÉ-CALCULÉ (sans incrémenter le chéquier, lu en direct depuis l'onglet).
    let chequier = '', chequeNum = '';
    if (paiement === 'cheque') { const arrCq = this.chequierRows(); const cq = arrCq.find(c => c.nom === d.chequier) || arrCq[0];
      if (cq) { chequier = cq.nom; chequeNum = String(this._vNum(d.chequeNum) || cq.next || 0); } }
    const rec = { id, num: (d.num || '').trim(), pecheur, date: d.date || '', lignes, total, paiement, chequier, chequeNum, observation, paiementImmediat: !!d.paiementImmediat };
    // RÈGLE 8/13 : suivi de l'état de chaque étape de la transaction (aucune annonce « enregistré » tant que tout n'est pas résolu).
    this._achatSteps = { rec, pecheur: 'attente', cheque: paiement === 'cheque' ? 'attente' : 'na', stock: this._stockDir ? 'attente' : 'na' };
    this.requestAppendPreview('operations', this.achatWriteValues(rec), { refuseFormula: true, step: 'pecheur', after: () => this._achatAfterWrite(rec) });
  }
  // Bilan consolidé de l'achat : ne s'affiche que lorsque TOUTES les étapes sont résolues (ok/échec/annulé/sans objet).
  async _maybeFinalizeAchat() {
    const s = this._achatSteps; if (!s) return;
    if (s.pecheur === 'attente' || s.cheque === 'attente' || s.stock === 'attente') return; // encore en cours
    this._achatSteps = null;
    const rec = s.rec || {}; const ic = v => v === 'ok' ? '✓' : v === 'na' ? '—' : v === 'annulé' ? '⊘' : '✗';
    const anyFail = s.cheque === 'fail' || s.stock === 'fail' || s.pecheur === 'fail';
    const cards = [
      { l: '🎣 Suivi pêcheur', v: `${ic(s.pecheur)} ${s.pecheur === 'ok' ? 'écrit et relu' : s.pecheur === 'fail' ? 'ÉCHEC' : s.pecheur}` },
      { l: '🧾 Chèque', v: `${ic(s.cheque)} ${s.cheque === 'ok' ? 'ligne complétée' : s.cheque === 'na' ? 'non concerné' : s.cheque === 'fail' ? 'ÉCHEC — à compléter à la main' : s.cheque}` },
      { l: '📦 Stock', v: `${ic(s.stock)} ${s.stock === 'ok' ? 'poids/prix ajoutés' : s.stock === 'na' ? 'non configuré' : s.stock === 'fail' ? 'ÉCHEC' : s.stock}` },
      { l: '🔍 Relecture', v: `${s.pecheur === 'ok' ? '✓ vérifiée' : '—'}` },
    ];
    // CORRECTION 2 — seulement si l'écriture pêcheur a réussi (et une fois chèque/stock résolus,
    // pour ne jamais lire/écrire le fichier « operations » en même temps que ces étapes). Best-effort.
    if (s.pecheur === 'ok') await this._appendNextBlankRow('operations'); // awaited pour que le refresh lise le fichier à jour
    this.setState({ compFan: { mode: 'achat', title: anyFail ? `Achat de ${rec.pecheur || ''} — ⚠ une étape a échoué (voir ci-dessous)` : `Achat de ${rec.pecheur || ''} — enregistré, toutes les étapes OK ✓`, cards } });
    if (s.pecheur === 'ok') await this.refreshAchatInvoiceNumber(); // BUG 2 — après la ligne vierge ET après la réinitialisation du draft (achatDraft déjà remis à défaut plus tôt dans _achatAfterWrite)
  }
  // Appelé UNIQUEMENT après une écriture Excel confirmée et vérifiée.
  async _achatAfterWrite(rec) {
    const arr = this.achatSaisieRows().slice(); const i = arr.findIndex(x => String(x.id) === String(rec.id));
    if (i >= 0) arr[i] = rec; else arr.unshift(rec); this.saveAchatSaisie(arr);
    this.setState({ achatDraft: this.achatDefault() }); // reset du formulaire — le bilan consolidé arrive à la fin des étapes
    await this.ensureWeeklyStockFile(rec.date); // nouvelle semaine → fichier stock créé depuis le modèle (avant l'écriture stock)
    // Écritures enchaînées, chacune avec son propre aperçu/confirmation :
    //   B2 (chèque, dans le fichier pêcheur) puis D (stock hebdo, dans le fichier de la semaine).
    this._writeQueue = [];
    if (rec.paiement === 'cheque' && rec.chequeNum && this._achatWriteReady()) this._writeQueue.push(() => this.requestChequePreview(rec));
    else if (rec.paiement === 'cheque' && this._achatSteps) this._achatSteps.cheque = 'fail'; // chèque prévu mais écriture non prête
    if (this._stockDir) this._writeQueue.push(() => this.requestStockPreview(rec, 'achat'));
    this._runNextWrite();
    this._maybeFinalizeAchat(); // si ni chèque ni stock à écrire → bilan immédiat
  }
  // ---------- Fichier stock hebdomadaire : création automatique depuis un modèle ----------
  // La personne désigne UNE FOIS son fichier modèle (classeur vierge). Ensuite, à chaque saisie
  // d'achat sur une semaine sans fichier stock, une copie du modèle est créée dans le dossier Stock.
  async pickStockModelFile() {
    const picked = await this.pickFile(); if (picked.aborted || !picked.file) return;
    if (!picked.handle) { this.setState({ msg: { kind: 'error', text: 'Choisissez le modèle depuis Chrome ou Edge (ordinateur) pour que je puisse le mémoriser.' } }); return; }
    this._stockModelFile = picked.handle;
    this.idbSet('file:stockmodel', { type: 'file', role: 'stockmodel', name: picked.file.name, handle: picked.handle });
    this.setState({ stockModelName: picked.file.name, msg: { kind: 'ok', text: `Modèle hebdomadaire mémorisé : « ${picked.file.name} ». Chaque nouvelle semaine, un fichier stock sera créé automatiquement à la première saisie d'achat.` } });
  }
  async ensureWeeklyStockFile(dateIso) {
    try {
      if (!this._stockDir || !this._stockModelFile) return;
      const p = String(dateIso || '').split('-').map(Number); if (p.length < 3) return;
      const week = this.isoWeek({ y: p[0], m: p[1], d: p[2] });
      const pfx = this.prefixOf('stock');
      // un fichier de cette semaine existe-t-il déjà ? (préfixe + numéro de semaine dans le nom)
      const weekRe = new RegExp('(^|[^0-9])' + week + '([^0-9]|$)');
      for (const [nm, h] of await this.listFilesDeep(this._stockDir, 3)) {
        if (/^~\$/.test(nm)) continue; // RÈGLE 10 : ignorer les fichiers temporaires Excel
        if (/\.(xlsx|xlsm)$/i.test(nm) && this.matchPrefix(nm, pfx) && weekRe.test(nm.replace(/\.[^.]+$/, ''))) { this._stockWeekHandles = this._stockWeekHandles || {}; this._stockWeekHandles[week] = { handle: h, name: nm }; return; } // déjà là → on garde son handle
      }
      let perm = this._stockDir.queryPermission ? await this._stockDir.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (perm !== 'granted' && this._stockDir.requestPermission) perm = await this._stockDir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return;
      const mf = await this._stockModelFile.getFile();
      const bytes = new Uint8Array(await mf.arrayBuffer());
      const name = `${pfx} ${week}.xlsx`;
      const fh = await this._stockDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(bytes); await w.close();
      this._stockWeekHandles = this._stockWeekHandles || {}; this._stockWeekHandles[week] = { handle: fh, name }; // RÈGLE 10 : on garde le handle du fichier créé
      await this.refreshStockFolder(this._stockDir, true);
      this.setState({ msg: { kind: 'ok', text: `✓ Nouvelle semaine : fichier stock « ${name} » créé depuis votre modèle.` } });
    } catch (e) { /* jamais bloquant pour la saisie */ }
  }
  // ---------- Saisie facture fournisseur (écrit dans FACTURES A PAYER : feuille du mois + bloc) ----------
  fournSaisieRows() { return Array.isArray(this.state.fournSaisie) ? this.state.fournSaisie : []; }
  saveFournSaisie(arr) { this.setState({ fournSaisie: arr }); this.saveJSON(Component.FOURN_KEY, arr); }
  _fournNextId() { const ids = this.fournSaisieRows().map(r => +String(r.id).replace(/\D/g, '') || 0); return 'FR' + ((ids.length ? Math.max(...ids) : 0) + 1); }
  fournDefault() { return { id: this._fournNextId(), date: this._payTodayIso(), fournisseur: '', num: '', montant: '', type: 'normal', editing: false }; }
  setFournField(k, v) { const d = this.state.fournDraft || this.fournDefault(); this.setState({ fournDraft: { ...d, [k]: v } }); }
  resetFournDraft() { this.setState({ fournDraft: this.fournDefault() }); }
  _fournWriteReady() { const cfg = this.writeMapFor('factures'); if (!cfg || !cfg.enabled || (!cfg.months && !cfg.blocks)) return false; const hi = this._writableHandleFor('factures'); return !!(hi && hi.handle); }
  commitFournSaisie() {
    const d = this.state.fournDraft || this.fournDefault();
    const fournisseur = (d.fournisseur || '').trim();
    const montant = this._vNum(d.montant);
    if (!fournisseur || !(montant > 0)) { this.setState({ msg: { kind: 'error', text: 'Indiquez le fournisseur et un montant.' } }); return; }
    const type = d.type === 'crustace' ? 'crustace' : 'normal';
    const rec = { id: d.id || this._fournNextId(), date: d.date || '', fournisseur, num: (d.num || '').trim(), montant, type };
    const arr = this.fournSaisieRows().slice(); const i = arr.findIndex(x => String(x.id) === String(rec.id));
    // Circuit C — le fichier Excel fait foi. Une facture n'est enregistrée QUE si l'écriture réussit.
    if (i >= 0) { this.setState({ msg: { kind: 'error', text: 'La modification d’une facture déjà enregistrée n’est pas encore disponible : corrigez-la directement dans votre fichier Excel.' } }); return; }
    if (!this._fournWriteReady()) { this.setState({ msg: { kind: 'error', text: 'Avant d’enregistrer une facture fournisseur, réglez l’écriture : Paramètres → « Facture fournisseur » → « Régler l’écriture », puis connectez le fichier. Rien n’est enregistré tant que le fichier ne peut pas être écrit.' } }); return; }
    const moisNum = parseInt(String(rec.date).slice(5, 7), 10) || 1;
    this.requestAppendPreview('factures', this.fournWriteValues(rec), { month: moisNum, block: type, refuseFormula: true, after: () => this._fournAfterWrite(rec, moisNum) });
  }
  _fournAfterWrite(rec, moisNum) {
    const arr = this.fournSaisieRows().slice(); const i = arr.findIndex(x => String(x.id) === String(rec.id));
    if (i >= 0) arr[i] = rec; else arr.unshift(rec); this.saveFournSaisie(arr);
    const blkLbl = rec.type === 'crustace' ? 'Fournisseurs crustacé' : 'Fournisseurs';
    const cards = [{ l: '📄 Factures à payer', v: `${rec.fournisseur}${rec.num ? ' · ' + rec.num : ''} · ${this.fmt(rec.montant)} — ${blkLbl} (${Component.MONTHS[moisNum]})` }, { l: '💶 Trésorerie', v: `À régler : ${this.fmt(rec.montant)}` }];
    this._appendNextBlankRow('factures', { month: moisNum, block: rec.type }); // CORRECTION 2 — best-effort
    this.setState({ fournDraft: this.fournDefault(), compFan: { mode: 'fourn', title: `Facture fournisseur — ${rec.fournisseur}`, cards } });
  }
  // Auto-détection des 2 blocs (FOURNISSEURS / FOURNISSEURS CRUSTACE) — PAR MOIS, car la ligne
  // d'en-tête n'est pas la même selon la feuille (ex. JUIN = ligne 2, MAI = ligne 3, autres = ligne 4).
  _detectFacturesSheet(rows) {
    const norm = s => this._norm(s);
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 14); i++) { const h = (rows[i] || []).map(norm); if (h.some(x => x === 'date') && h.some(x => x.includes('fournisseur')) && h.some(x => x.includes('montant'))) { headerIdx = i; break; } }
    if (headerIdx < 0) return null;
    const header = (rows[headerIdx] || []).map(norm);
    const dateCols = []; header.forEach((h, ci) => { if (h === 'date') dateCols.push(ci); });
    const block2Start = dateCols.length > 1 ? dateCols[1] : header.length;
    const mapBlock = (lo, hi) => { const cols = {};
      for (let ci = lo; ci < hi; ci++) { const h = header[ci]; if (!h) continue;
        if (h === 'date') { if (cols.date == null) cols.date = ci; }
        else if (h.includes('fournisseur')) cols.partner = ci;
        else if (h.includes('facture')) cols.ref = ci;
        else if (h.includes('montant')) cols.ttc = ci;
        else if ((h.includes('paiement') || h.includes('paiment')) && h.includes('date')) cols.datePaie = ci;
        else if (h.includes('paiment') || h.includes('paiement')) cols.paye = ci;
      } return cols; };
    return { headerIdx, normalCols: mapBlock(0, block2Start), crustaceCols: block2Start < header.length ? mapBlock(block2Start, header.length) : {} };
  }
  async detectFacturesWrite() {
    const kind = 'factures'; const label = this.writeSourceLabel(kind);
    const got = await this._wbForWrite(kind); if (!got) return;
    const wb = got.wb, name = got.name;
    const norm = s => this._norm(s);
    const monthSheets = Component.MONTHS_UP.map(mn => { const s = wb.find(x => norm(x.name) === norm(mn)); return s ? s.name : null; });
    const months = {}; let detected = 0; let rep = null;
    monthSheets.forEach((sn, idx) => { if (!sn) return; const sh = wb.find(x => x.name === sn); if (!sh) return; const d = this._detectFacturesSheet(sh.rows); if (!d) return;
      months[idx + 1] = { sheetName: sn, headerRowIdx: d.headerIdx, firstDataIdx: d.headerIdx + 1, blocks: { normal: { cols: d.normalCols }, crustace: { cols: d.crustaceCols } } }; detected++; if (!rep) rep = d; });
    if (!detected) { this.setState({ msg: { kind: 'error', text: `Aucune feuille de mois lisible (Date / Fournisseur / Montant introuvables) dans « ${name} ».` } }); return; }
    // en-têtes non alignées → on le signale honnêtement
    const rowsSet = [...new Set(Object.keys(months).map(m => months[m].headerRowIdx + 1))].sort((a, b) => a - b);
    const cfg = { fileName: name, monthly: true, monthSheets, months, enabled: true,
      // compat ancien chemin : bloc global = 1er mois détecté
      headerRowIdx: rep.headerIdx, firstDataIdx: rep.headerIdx + 1, blocks: { normal: { cols: rep.normalCols }, crustace: { cols: rep.crustaceCols } } };
    this.saveWriteMap(kind, cfg);
    const cl = m => Object.keys(m).map(k => this._colLetter(m[k] + 1)).join('');
    this.setState({ msg: { kind: 'ok', text: `Écriture réglée pour « ${label} » : ${detected} mois détectés (en-têtes ligne ${rowsSet.join(' / ')} selon le mois), bloc Fournisseurs (col. ${cl(rep.normalCols)}) et bloc Crustacé (col. ${cl(rep.crustaceCols)}).` } });
  }
  // ---------- Heures de travail ----------
  hNewId(i) { return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + (i || 0); }
  hMonday(d) { const x = new Date(d); const off = (x.getDay() + 6) % 7; x.setDate(x.getDate() - off); x.setHours(0, 0, 0, 0); return x; }
  hISO(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  hParse(iso) { const p = String(iso).split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
  hFocusKey() { return this.state.hFocus || this.hISO(this.hMonday(new Date())); }
  hSaveHeures(weeks, roster) { this.saveJSON(Component.HEURES_KEY, { weeks: weeks || this.state.heures, roster: roster || this.state.hRoster }); }
  hMoisKey(name, mo) { return String(name || '').trim() + '|' + mo; }
  hMoisRow(name, mo) { const m = this.state.heuresMois || {}; return m[this.hMoisKey(name, mo)] || {}; }
  hSetMois(name, mo, field, val) { const key = this.hMoisKey(name, mo); const m = { ...(this.state.heuresMois || {}) }; m[key] = { ...(m[key] || {}), [field]: val }; this.setState({ heuresMois: m }); this.saveJSON(Component.HMOIS_KEY, m); }
  hEmpsFromRoster() { const r = (this.state.hRoster && this.state.hRoster.length) ? this.state.hRoster : ['Employé 1']; return r.map((n, i) => ({ id: this.hNewId(i), name: n, days: {} })); }
  hWeekObj(weeks, key) { return weeks[key] ? { ...weeks[key], employees: (weeks[key].employees || []).slice() } : { employees: this.hEmpsFromRoster() }; }
  hGoWeek(deltaOrKey) {
    let key;
    if (typeof deltaOrKey === 'number') { const c = this.hParse(this.hFocusKey()); c.setDate(c.getDate() + deltaOrKey * 7); key = this.hISO(this.hMonday(c)); }
    else key = deltaOrKey;
    const weeks = { ...(this.state.heures || {}) };
    if (!weeks[key]) { weeks[key] = { employees: this.hEmpsFromRoster() }; this.hSaveHeures(weeks); }
    this.setState({ heures: weeks, hFocus: key, hMode: 'semaine' });
  }
  hSetCell(key, empId, iso, field, value) {
    const weeks = { ...(this.state.heures || {}) };
    const wk = this.hWeekObj(weeks, key);
    wk.employees = wk.employees.map(e => { if (e.id !== empId) return e; const days = { ...(e.days || {}) }; days[iso] = { ...(days[iso] || {}) }; days[iso][field] = value; return { ...e, days }; });
    weeks[key] = wk;
    this.setState({ heures: weeks }); this.hSaveHeures(weeks);
  }
  hGetDay(key, empId, iso) { const wk = (this.state.heures || {})[key]; const emp = wk && (wk.employees || []).find(e => e.id === empId); return (emp && emp.days && emp.days[iso]) || {}; }
  hSetName(key, empId, name) {
    const weeks = { ...(this.state.heures || {}) };
    const wk = this.hWeekObj(weeks, key);
    wk.employees = wk.employees.map(e => e.id === empId ? { ...e, name } : e);
    weeks[key] = wk;
    const roster = wk.employees.map(e => e.name);
    this.setState({ heures: weeks, hRoster: roster }); this.hSaveHeures(weeks, roster);
  }
  hAddEmployee(key) {
    const weeks = { ...(this.state.heures || {}) };
    const wk = this.hWeekObj(weeks, key);
    wk.employees = wk.employees.concat({ id: this.hNewId(wk.employees.length + 3), name: 'Nouvelle personne', days: {} });
    weeks[key] = wk;
    const roster = wk.employees.map(e => e.name);
    this.setState({ heures: weeks, hRoster: roster }); this.hSaveHeures(weeks, roster);
  }
  hAskDelete(key, empId, name) { this.setState({ hDelAsk: { key, empId, name } }); }
  hConfirmDelete() {
    const a = this.state.hDelAsk; if (!a) return;
    const weeks = { ...(this.state.heures || {}) };
    if (weeks[a.key]) weeks[a.key] = { ...weeks[a.key], employees: (weeks[a.key].employees || []).filter(e => e.id !== a.empId) };
    const roster = weeks[a.key] ? weeks[a.key].employees.map(e => e.name) : this.state.hRoster;
    this.setState({ heures: weeks, hRoster: roster, hDelAsk: null }); this.hSaveHeures(weeks, roster);
  }
  hToggleCollapse(id) { const m = { ...(this.state.hCollapse || {}) }; m[id] = !m[id]; this.setState({ hCollapse: m }); }
  // ---------- Heures : mode agenda (arrivée / départ / pause) ----------
  // Heure « 08:30 » → 8,5 (heures décimales). Null si vide ou illisible.
  hTimeVal(s) { const m = String(s == null ? '' : s).trim().match(/^(\d{1,2})[h:](\d{2})$/i); if (!m) return null; const h = +m[1], mn = +m[2]; if (h > 23 || mn > 59) return null; return h + mn / 60; }
  // Pause : « 1h05 » / « 1:05 » → heures+minutes ; un nombre seul = des MINUTES (« 45 » → 45 min)
  hPauseVal(s) {
    const t = String(s == null ? '' : s).trim(); if (!t) return 0;
    const m = t.match(/^(\d{1,2})[h:](\d{1,2})$/i); if (m) return +m[1] + (+m[2]) / 60;
    const n = parseFloat(t.replace(',', '.')); return isFinite(n) ? Math.max(0, n) / 60 : 0;
  }
  hNumVal(v) { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; }
  hRanges(d) { if (!d) return []; return [{ arr: d.arr || '', dep: d.dep || '', pse: d.pse || '' }, ...(Array.isArray(d.ranges) ? d.ranges : [])]; }
  hRangeIssue(d) {
    const spans = this.hRanges(d).map(r => ({ a: this.hTimeVal(r.arr), b: this.hTimeVal(r.dep) })).filter(r => r.a != null || r.b != null);
    if (spans.some(r => r.a == null || r.b == null)) return 'Plage incomplète';
    if (spans.some(r => r.b <= r.a)) return 'Le départ doit être après l’arrivée, sans passage de minuit';
    spans.sort((x, y) => x.a - y.a); if (spans.some((r, i) => i > 0 && r.a < spans[i - 1].b)) return 'Plages qui se chevauchent';
    return '';
  }
  // Total d'une journée : départ − arrivée − pause. Le passage de minuit n'est JAMAIS deviné :
  // il ne compte que si la « Programmation horaire » est réglée sur Nuit dans Paramètres
  // (choix de l'utilisatrice — en mode Jour, un départ avant l'arrivée compte 0 et est signalé ⚠).
  // Ancien format (Matin/Repas/Après-midi/Pause en nombres d'heures) toujours lu tel quel.
  hDayTotal(d) {
    if (!d) return 0;
    if (Array.isArray(d.ranges) && d.ranges.length) {
      if (this.hRangeIssue(d)) return 0;
      return this.hRanges(d).reduce((sum, r) => sum + Math.max(0, this.hTimeVal(r.dep) - this.hTimeVal(r.arr) - this.hPauseVal(r.pse)), 0);
    }
    const a = this.hTimeVal(d.arr), b = this.hTimeVal(d.dep);
    if (a != null && b != null) {
      let w = b - a;
      if (w < 0) { if (!this.state.hNuit) return 0; w += 24; }
      return Math.max(0, w - this.hPauseVal(d.pse));
    }
    return Math.max(0, this.hNumVal(d.matin) + this.hNumVal(d.aprem) - this.hNumVal(d.repas) - this.hNumVal(d.pause));
  }
  setHNuit(v) { this.setState({ hNuit: !!v }); try { localStorage.setItem(Component.HNUIT_KEY, v ? '1' : '0'); } catch (e) {} }
  hFmtH(h) { if (!h || Math.abs(h) < 1e-9) return '0h00'; const neg = h < 0; h = Math.abs(h); let hh = Math.floor(h + 1e-9); let mm = Math.round((h - hh) * 60); if (mm === 60) { hh += 1; mm = 0; } return (neg ? '−' : '') + hh + 'h' + (mm < 10 ? '0' : '') + mm; }
  hDayHasData(d) { return !!(d && (d.arr || d.dep || d.pse || (Array.isArray(d.ranges) && d.ranges.length) || d.matin || d.aprem || d.repas || d.pause)); }
  hAddRange(key, empId, iso) { const d = this.hGetDay(key, empId, iso); const ranges = Array.isArray(d.ranges) ? d.ranges.slice() : []; ranges.push({ arr: '', dep: '', pse: '' }); this.hSetCell(key, empId, iso, 'ranges', ranges); }
  hSetRange(key, empId, iso, index, field, value) { const d = this.hGetDay(key, empId, iso); if (index === 0) { this.hSetCell(key, empId, iso, field, value); return; } const ranges = Array.isArray(d.ranges) ? d.ranges.map(r => ({ ...r })) : []; if (!ranges[index - 1]) return; ranges[index - 1][field] = value; this.hSetCell(key, empId, iso, 'ranges', ranges); }
  hRemoveRange(key, empId, iso, index) { if (index <= 0) return; const d = this.hGetDay(key, empId, iso); const ranges = Array.isArray(d.ranges) ? d.ranges.slice() : []; ranges.splice(index - 1, 1); this.hSetCell(key, empId, iso, 'ranges', ranges); }
  // ---------- archive complète d'une personne (toutes les semaines, par NOM) ----------
  hEmpArchiveData(name) {
    const target = String(name || '').trim().toLowerCase();
    const weeks = this.state.heures || {};
    const H_DOW = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const out = { name: String(name || '').trim(), weeks: [], total: 0, dayCount: 0 };
    Object.keys(weeks).sort().forEach(k => {
      const emp = ((weeks[k] && weeks[k].employees) || []).find(e => String(e.name || '').trim().toLowerCase() === target);
      if (!emp) return;
      const monday = this.hParse(k);
      const days = [];
      let weekTotal = 0;
      for (let i = 0; i < 7; i++) {
        const dt = new Date(monday); dt.setDate(dt.getDate() + i);
        const iso = this.hISO(dt);
        const d = (emp.days || {})[iso];
        if (!this.hDayHasData(d)) continue;
        const tot = this.hDayTotal(d); weekTotal += tot;
        const oldFmt = !(d.arr || d.dep) && (d.matin || d.aprem || d.repas || d.pause);
        days.push({
          dow: H_DOW[i], date: `${this.dd(dt.getDate())}/${this.dd(dt.getMonth() + 1)}/${dt.getFullYear()}`,
          arr: d.arr || '—', dep: d.dep || '—',
          pause: d.pse || (oldFmt ? `ancien format (${[d.matin && 'matin ' + d.matin, d.aprem && 'a-m ' + d.aprem, d.repas && 'repas −' + d.repas, d.pause && 'pause −' + d.pause].filter(Boolean).join(', ')})` : '—'),
          total: this.hFmtH(tot),
        });
      }
      if (!days.length) return;
      out.weeks.push({ key: k, days, weekTotal: this.hFmtH(weekTotal) });
      out.total += weekTotal; out.dayCount += days.length;
    });
    out.totalLabel = this.hFmtH(out.total);
    return out;
  }
  _buildEmpArchiveHtml(name) {
    const a = this.hEmpArchiveData(name);
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const accent = this.entCfg().accent;
    const n = new Date();
    const stamp = `${this.dd(n.getDate())}/${this.dd(n.getMonth() + 1)}/${n.getFullYear()} à ${this.dd(n.getHours())}:${this.dd(n.getMinutes())}`;
    const H_MON = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const weekLabel = k => { const d = this.hParse(k); const b = new Date(d); b.setDate(b.getDate() + 6); return `Semaine du ${d.getDate()} ${H_MON[d.getMonth()]} ${d.getFullYear()}`; };
    const body = a.weeks.length ? a.weeks.map(w => `<section><h2>${esc(weekLabel(w.key))} <span class="badge">${esc(w.weekTotal)}</span></h2><table><thead><tr><th>Jour</th><th>Date</th><th>Arrivée</th><th>Départ</th><th>Pause</th><th class="r">Total</th></tr></thead><tbody>${w.days.map(d => `<tr><td>${esc(d.dow)}</td><td class="mono">${esc(d.date)}</td><td class="mono">${esc(d.arr)}</td><td class="mono">${esc(d.dep)}</td><td class="mono">${esc(d.pause)}</td><td class="r mono"><b>${esc(d.total)}</b></td></tr>`).join('')}</tbody></table></section>`).join('')
      : `<p class="empty">Aucune heure enregistrée pour cette personne.</p>`;
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Archive des heures — ${esc(a.name)}</title><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0e1b2e;background:#f4f6fa}.sheet{max-width:820px;margin:24px auto;background:#fff;padding:38px 44px;box-shadow:0 2px 12px rgba(16,32,54,.08)}header.rh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${accent};padding-bottom:16px}header.rh .t{font-size:22px;font-weight:800}header.rh .s{font-size:13px;color:#5a6b80;margin-top:4px}header.rh .m{font-size:12px;color:#8291a5;text-align:right;line-height:1.5}.grand{margin-top:18px;border:1.5px solid ${accent};background:${this.hexToRgba(accent, 0.06)};border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center}.grand .gl{font-size:13px;font-weight:600}.grand .gv{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}section{margin-top:20px;page-break-inside:avoid}h2{font-size:14px;font-weight:700;margin:0 0 8px;display:flex;align-items:center;gap:10px}.badge{font-size:11.5px;font-weight:600;color:${accent};background:${this.hexToRgba(accent, 0.1)};padding:3px 9px;border-radius:20px}table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#93a1b3;padding:6px 8px;border-bottom:1.5px solid #e6ebf2}td{padding:7px 8px;border-bottom:1px solid #f1f4f8}.r{text-align:right}.mono{font-variant-numeric:tabular-nums;font-family:'SFMono-Regular',Consolas,monospace}.empty{font-size:12.5px;color:#9aa7b8;font-style:italic}footer{margin-top:26px;padding-top:14px;border-top:1px solid #eef1f6;font-size:11px;color:#aeb8c6;text-align:center}.bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #e6ebf2;padding:10px 16px;display:flex;gap:10px;justify-content:flex-end}.bar button{padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${accent};background:${accent};color:#fff}.bar button.sec{background:#fff;color:#475569;border-color:#d7dde6}@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none;padding:0}.bar{display:none}@page{margin:14mm}}</style></head><body><div class="bar"><button class="sec" onclick="window.close()">Fermer</button><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div><div class="sheet"><header class="rh"><div><div class="t">Archive des heures — ${esc(a.name)}</div><div class="s">${esc(this.entCfg().nom)} — totalité des heures enregistrées</div></div><div class="m">éditée le ${esc(stamp)}<br>${a.weeks.length} semaine${a.weeks.length > 1 ? 's' : ''} · ${a.dayCount} jour${a.dayCount > 1 ? 's' : ''}</div></header><div class="grand"><span class="gl">TOTAL GÉNÉRAL</span><span class="gv">${esc(a.totalLabel)}</span></div>${body}<footer>Archive générée depuis le tableau de bord — à enregistrer en PDF via Imprimer.</footer></div></body></html>`;
  }
  generateEmpArchive(name) {
    const html = this._buildEmpArchiveHtml(name);
    const w = window.open('', '_blank');
    if (!w) { this.setState({ msg: { kind: 'error', text: 'Fenêtre bloquée — autorisez les pop-ups pour ouvrir l’archive des heures.' } }); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }
  dd(n) { return String(n).padStart(2, '0'); }
  pIso(s) { if (s && typeof s === 'object') return s; const p = String(s).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  days(o) { return Math.floor(Date.UTC(o.y, o.m - 1, o.d) / 86400000); }
  addDays(o, n) { const t = new Date(Date.UTC(o.y, o.m - 1, o.d) + n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
  nrm(s) { return String(s || '').toUpperCase().replace(/\s+/g, ''); }
  invoiceKey(s) {
    // Les deux feuilles peuvent écrire le même numéro avec des espaces, tirets, points ou « / » différents.
    // La valeur affichée reste intacte ; seule la clé technique de rapprochement est normalisée.
    return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');
  }
  gNumKey(s) { return String(s || '').replace(/\D/g, '').replace(/^0+/, ''); }
  gGrenkeDate(g, fact) { if (fact && fact.em) return fact.em; const o = g && g.date ? this.pIso(g.date) : null; if (o && o.y) return o; const n = parseInt(this.gNumKey(g && g.ref) || '0', 10) || 0; return (n && n < 4005) ? { y: 2024, m: 12, d: 1 } : null; }
  gGrenkePeriod(g, fact) { if (fact && fact.em) return fact.em; const o = g && g.date ? this.pIso(g.date) : null; return (o && o.y) ? o : null; }
  openGrenkeLink(o) { this.setState({ grenkeLink: o, grenkeLinkQuery: '' }); }
  closeGrenkeLink() { this.setState({ grenkeLink: null, grenkeLinkQuery: '' }); }
  // ---------- corbeille : masquer une ligne sans toucher au fichier Excel ----------
  opHideKey(r) { return [this.nrm(r.ref || ''), r.y, r.m, r.d, Math.round(Math.abs(r.amt || 0) * 100)].join('|'); }
  gHideKey(g) { return this.nrm(g.ref || '') + '|' + Math.round((g.ttc || 0) * 100); }
  setTblStatus(key, name) { this.setState({ tblStatusF: { ...(this.state.tblStatusF || {}), [key]: name }, page: 0 }); }
  // ---------- réinitialisation complète : efface données importées, mappages, dossiers connectés ----------
  async fullReset() {
    try { Object.keys(localStorage).filter(k => k.startsWith('av')).forEach(k => { try { localStorage.removeItem(k); } catch (e) {} }); } catch (e) {}
    try { const db = await this._idb(); db.close(); } catch (e) {}
    try { indexedDB.deleteDatabase('avHandles'); } catch (e) {}
    setTimeout(() => { try { location.reload(); } catch (e) {} }, 200);
  }
  confirmTrash() {
    const t = this.state.trashAsk; if (!t) return;
    if (t.kind === 'grenke') { const m = { ...(this.state.grenkeHidden || {}) }; m[t.key] = 1; this.setState({ grenkeHidden: m, trashAsk: null }); this.saveJSON(Component.HIDE_GRK_KEY, m); }
    else if (t.kind === 'bank') { const m = { ...(this.state.bankHidden || {}) }; m[t.key] = 1; this.setState({ bankHidden: m, trashAsk: null }); this.saveJSON(Component.HIDE_BNK_KEY, m); }
    else { const m = { ...(this.state.hiddenOps || {}) }; m[t.key] = 1; this.setState({ hiddenOps: m, trashAsk: null }); this.saveJSON(Component.HIDE_OPS_KEY, m); }
  }
  restoreHidden(kind) {
    if (kind === 'grenke') { this.setState({ grenkeHidden: {} }); try { localStorage.removeItem(Component.HIDE_GRK_KEY); } catch (e) {} }
    else if (kind === 'bank') { this.setState({ bankHidden: {} }); try { localStorage.removeItem(Component.HIDE_BNK_KEY); } catch (e) {} }
    else { this.setState({ hiddenOps: {} }); try { localStorage.removeItem(Component.HIDE_OPS_KEY); } catch (e) {} }
  }
  // ---------- rapprochement bancaire ----------
  bankKey(b) { return `${b.y}-${b.m}-${b.d}|${this.nrm(b.label).slice(0, 40)}|${b.amt}`; }
  setBankLink(key, val) { const m = { ...(this.state.bankLinks || {}) }; m[key] = val; this.setState({ bankLinks: m, bankLink: null, bankLinkQuery: '' }); this.saveJSON(Component.BLINK_KEY, m); }
  clearBankLink(key) { const m = { ...(this.state.bankLinks || {}) }; delete m[key]; this.setState({ bankLinks: m, bankLink: null, bankLinkQuery: '' }); this.saveJSON(Component.BLINK_KEY, m); }
  // ---------- catégories de dépenses (banque) ----------
  // clé de libellé : sans accents, chiffres ni dates → « CARTE 05/07 STATION AVIA » = « CARTE STATION AVIA »
  bankLabelKey(label) { return String(label || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[0-9]/g, '').replace(/[\/:.,*-]/g, ' ').replace(/\s+/g, ' ').trim(); }
  resolveBankCat(b, m, rules, overrides) {
    const o = overrides[this.bankKey(b)]; if (o) return o;
    const r = rules[this.bankLabelKey(b.label)]; if (r) return r;
    return this.guessBankCat(b, m);
  }
  guessBankCat(b, m) {
    const L = this.bankLabelKey(b.label);
    const K = [
      [/AGIOS|FRAIS|COMMISSION|COTISATION|TENUE DE COMPTE/, 'Frais bancaires'],
      [/LOYER|LOGEMENT|IMMOBILIER|FONCIER/, 'Logement'],
      [/EDF|ELECTRICITE|ELEC\b|ENEDIS|ENGIE/, 'EDF'],
      [/STATION|CARBURANT|TOTALENERGIES|AVIA|ESSO|SHELL|GAZOLE|GASOIL/, 'Carburant'],
      [/LOCATION|LLD|LEASING| RENT/, 'Location véhicule'],
      [/CARREFOUR|LECLERC|INTERMARCHE|SUPER U|AUCHAN|LIDL|ALIMENT/, 'Alimentation'],
      [/ECHEANCE|PRET |ASSURANCE|MENSUALITE|MUTUELLE/, 'Crédit & assurance'],
      [/URSSAF|DGFIP|IMPOT|TRESOR PUBLIC|TAXE/, 'Impôts & taxes'],
      [/SALAIRE|PAIE |VIREMENT SALAIRE/, 'Salaires & charges'],
      [/CHRONOPOST|DPD|COLISSIMO|TRANSEXPRESS|HEPPNER|TRANSPORT/, 'Transport'],
      [/PECHEUR|CRIEE|MAREE/, 'Achat pêcheur'],
    ];
    for (const [re, c] of K) if (re.test(L)) return c;
    if (b.amt > 0) return 'Encaissement client';
    if (m && m.kind === 'Crédit') return 'Crédit & assurance';
    if (m && (m.kind === 'Achat' || m.kind === 'Facture')) return 'Achat fournisseur';
    return 'Autre';
  }
  setBankCat(key, cat) { const m = { ...(this.state.bankCats || {}) }; m[key] = cat; this.setState({ bankCats: m }); this.saveJSON(Component.BCAT_KEY, m); }
  // Coche/décoche un libellé de dépense dans un groupe de charges (fixe/variable) —
  // exclusif : cocher dans un groupe retire automatiquement du groupe opposé.
  toggleChargeSel(group, key) {
    // En démo, le premier cochage part des exemples pré-cochés (sinon ils disparaîtraient tous)
    const cur = this.state.chargesSel || (this.state.demoMode !== false ? Component.DEMO_CHARGES_SEL : {});
    const sel = { fixe: [...(cur.fixe || [])], variable: [...(cur.variable || [])] };
    const other = group === 'fixe' ? 'variable' : 'fixe';
    const i = sel[group].indexOf(key);
    if (i >= 0) sel[group].splice(i, 1);
    else { sel[group].push(key); const j = sel[other].indexOf(key); if (j >= 0) sel[other].splice(j, 1); }
    this.setState({ chargesSel: sel });
    this.saveJSON(Component.CHARGES_KEY, sel);
  }
  setBankCatRule(label, cat) {
    const lk = this.bankLabelKey(label); if (!lk) return;
    const rules = { ...(this.state.bankCatRules || {}) }; rules[lk] = cat;
    const bankRaw = this.state.banque || (this.state.demoMode !== false ? Component.BANQUE.map(a => ({ y: a[0], m: a[1], d: a[2], label: a[3], amt: a[4], solde: a[5] != null ? a[5] : null })) : []);
    const n = bankRaw.filter(x => this.bankLabelKey(x.label) === lk).length;
    this.setState({ bankCatRules: rules, msg: { kind: 'success', text: `Règle mémorisée : « ${lk} » → ${cat} — ${n} ligne${n > 1 ? 's' : ''} concernée${n > 1 ? 's' : ''}, prochains imports compris.` } });
    this.saveJSON(Component.BRULE_KEY, rules);
  }
  commitBankCat() {
    const ask = this.state.bankCatAsk; const v = (this.state.bankCatAskValue || '').trim();
    if (!ask) return;
    if (!v) { this.setState({ bankCatAsk: null, bankCatAskValue: '' }); return; }
    const list = [...new Set([...(this.state.bankCatList || []), v])];
    this.setState({ bankCatList: list, bankCatAsk: null, bankCatAskValue: '' });
    this.saveJSON(Component.BCATLIST_KEY, list);
    if (ask.key) this.setBankCat(ask.key, v);
  }
  // pour chaque ligne banque : candidats au même montant, score nom / n° / date
  bankMatch(b, cands) {
    const label = this.nrm(b.label).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const hits = [];
    for (const c of cands) {
      if (Math.abs(c.signed - b.amt) > 0.009) continue;
      let sc = 1;
      if (c.ref && this.gNumKey(c.ref) && label.replace(/\D/g, '').includes(this.gNumKey(c.ref))) sc += 3;
      const pn = this.nrm(c.partner).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const pw = pn.replace(/[^A-Z0-9]/g, '');
      if (pw.length >= 4 && label.replace(/[^A-Z0-9]/g, '').includes(pw)) sc += 2;
      else { const w = pn.split(/[^A-Z0-9]+/).filter(x => x.length >= 5); if (w.some(x => label.includes(x))) sc += 2; }
      const dd = Math.abs(this.days(b) - c.days);
      if (dd <= 5) sc += 2; else if (dd <= 15) sc += 1; else if (dd > 45) sc -= 1;
      hits.push({ c, sc, dd });
    }
    hits.sort((a, z) => z.sc - a.sc || a.dd - z.dd);
    return hits;
  }
  mapBanque(text) {
    const { rows, find } = this.parseTable(text);
    const ci = {
      date: find('date operation', 'date comptable', 'date de valeur', 'date'),
      label: find('libelle operation', 'libelle', 'label', 'description', 'operation', 'detail', 'intitule', 'communication'),
      montant: find('montant eur', 'montant', 'amount'),
      debit: find('debit'),
      credit: find('credit'),
      solde: find('solde courant', 'solde apres', 'nouveau solde', 'solde comptable', 'solde', 'balance'),
    };
    if (ci.date < 0 || (ci.montant < 0 && ci.debit < 0 && ci.credit < 0)) return { list: [], error: 'colonnes « Date » et « Montant » (ou « Débit » / « Crédit ») introuvables' };
    const list = []; let skipped = 0;
    rows.forEach(f => {
      const o = this.smartDate(f[ci.date]); if (!o) { skipped++; return; }
      const label = ci.label >= 0 ? String(f[ci.label] || '').trim() : '';
      let amt = null;
      if (ci.montant >= 0) { const v = this.parseAmount(f[ci.montant]); if (v != null && !isNaN(v) && v !== 0) amt = v; }
      if (amt == null) { const dv = ci.debit >= 0 ? Math.abs(this.parseAmount(f[ci.debit]) || 0) : 0; const cv = ci.credit >= 0 ? Math.abs(this.parseAmount(f[ci.credit]) || 0) : 0; if (dv || cv) amt = cv - dv; }
      if (amt == null || !label) { skipped++; return; }
      const sv = ci.solde >= 0 ? this.parseAmount(f[ci.solde]) : null;
      list.push({ y: o.y, m: o.m, d: o.d, label, amt: Math.round(amt * 100) / 100, solde: (sv == null || isNaN(sv)) ? null : Math.round(sv * 100) / 100 });
    });
    list.sort((a, z) => this.days(z) - this.days(a));
    return { list, skipped, error: list.length ? null : 'aucune ligne exploitable (Date / Libellé / Montant)' };
  }
  setGrenkeLink(gref, factRef) { const m = { ...(this.state.grenkeLinks || {}) }; m[gref] = factRef; this.setState({ grenkeLinks: m, grenkeLink: null, grenkeLinkQuery: '' }); this.saveJSON(Component.GLINK_KEY, m); }
  clearGrenkeLink(gref) { const m = { ...(this.state.grenkeLinks || {}) }; delete m[gref]; this.setState({ grenkeLinks: m, grenkeLink: null, grenkeLinkQuery: '' }); this.saveJSON(Component.GLINK_KEY, m); }
  isoWeek(o) { const d = new Date(Date.UTC(o.y, o.m - 1, o.d)); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const ft = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); const fd = (ft.getUTCDay() + 6) % 7; ft.setUTCDate(ft.getUTCDate() - fd + 3); return 1 + Math.round((d - ft) / 6048e5); }

  // ---------- lecture Excel (.xlsx) hors ligne, sans réseau ----------
  unxml(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)); }
  async inflate(bytes) { const ds = new DecompressionStream('deflate-raw'); return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer()); }
  // ---------- écriture Excel (.xlsx) hors ligne — aperçu éditable, sauvegarde automatique ----------
  async deflate(bytes) { const cs = new CompressionStream('deflate-raw'); return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer()); }
  crc32(bytes) {
    if (!Component._crcTable) { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } Component._crcTable = t; }
    const table = Component._crcTable; let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  async zipBuild(entries, mime) {
    const parts = [], central = []; let offset = 0;
    for (const e of entries) {
      const nameBytes = new TextEncoder().encode(e.name);
      const crc = this.crc32(e.bytes);
      let data = e.bytes, method = 0;
      try { const z = await this.deflate(e.bytes); if (z.length < e.bytes.length) { data = z; method = 8; } } catch (err) {}
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, method, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, e.bytes.length, true);
      lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      const localOffset = offset;
      parts.push(new Uint8Array(lh.buffer), nameBytes, data);
      offset += 30 + nameBytes.length + data.length;
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, method, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, e.bytes.length, true);
      ch.setUint16(28, nameBytes.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, localOffset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
    }
    const centralStart = offset; let centralSize = 0; for (const c of central) centralSize += c.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
    eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true); eocd.setUint32(16, centralStart, true); eocd.setUint16(20, 0, true);
    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  // Valeur saisie → nombre si elle en est un, en acceptant la virgule décimale française
  // (« 12,5 » doit devenir le nombre 12.5 dans le fichier, pas du texte — sinon les formules
  // Excel qui pointent dessus affichent #VALEUR!). Retourne null si ce n'est pas un nombre.
  _editNumeric(val) {
    const s = String(val == null ? '' : val).trim().replace(/[\s  ]/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  async buildXlsxBlob(wbData) {
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const colName = n => { let s = '', m = n + 1; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; };
    const enc = new TextEncoder();
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${wbData.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbData.map((s, i) => `<sheet name="${esc(s.name || ('Feuille' + (i + 1)))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbData.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
    const sheetXml = rows => {
      const body = (rows || []).map((row, ri) => {
        const cells = row.map((v, ci) => {
          if (v === '' || v == null) return '';
          const ref = colName(ci) + (ri + 1);
          const num = this._editNumeric(v);
          if (num != null) return `<c r="${ref}"><v>${num}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      }).join('');
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
    };
    const entries = [
      { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
      { name: '_rels/.rels', bytes: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', bytes: enc.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(workbookRels) },
    ];
    wbData.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, bytes: enc.encode(sheetXml(s.rows)) }));
    return this.zipBuild(entries);
  }
  // ---------- patch en place d'un .xlsx : seules les cellules éditées changent ----------
  // Contrairement à buildXlsxBlob (reconstruction minimale, utilisée pour les copies d'export),
  // on repart des octets ORIGINAUX du fichier : formules des autres cellules, styles, formats de
  // date, autres feuilles, graphiques… tout est préservé tel quel. Une cellule éditée garde son
  // style (attribut s="…") ; si elle contenait une formule, celle-ci est remplacée par la valeur
  // saisie (comme quand on tape par-dessus dans Excel) et xl/calcChain.xml est retiré pour
  // qu'Excel le reconstruise sans signaler de réparation.
  // Parse xl/_rels/workbook.xml.rels sans dépendre de l'ORDRE des attributs (certains fichiers
  // écrivent Type/Target/Id, d'autres Id/Target). Normalise aussi les cibles absolues « /xl/… ».
  _relMapOf(relsXml) {
    const map = {};
    [...String(relsXml).matchAll(/<Relationship\b[^>]*>/g)].forEach(tag => {
      const s = tag[0]; const id = (s.match(/\bId="([^"]+)"/) || [])[1]; let t = (s.match(/\bTarget="([^"]+)"/) || [])[1];
      if (!id || !t) return;
      if (/^\//.test(t)) t = t.slice(1);                 // « /xl/worksheets/sheet1.xml » → « xl/… »
      else if (!/^xl\//.test(t)) t = 'xl/' + t.replace(/^\.\//, ''); // relatif à xl/
      map[id] = t;
    });
    return map;
  }
  // Prépare un « marquage » de style : les cellules écrites par l'application passent en
  // police Andale Mono, couleur bleue — tout en CONSERVANT leur format d'origine (date, €,
  // bordures) : on clone le style existant et on ne remplace QUE la police. Renvoie null si
  // styles.xml est absent/illisible (dans ce cas on écrit sans changer le style).
  _buildMarkStyler(stylesXml) {
    try {
      const fontsM = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/);
      const xfsM = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
      if (!fontsM || !xfsM) return null;
      const fontEls = fontsM[1].match(/<font\b[\s\S]*?<\/font>|<font\b[^>]*\/>/g) || [];
      const blueFontXml = '<font><sz val="11"/><color rgb="FF0000FF"/><name val="Andale Mono"/></font>';
      // Réutilise la police bleue Andale si elle existe déjà (écritures précédentes) → pas d'accumulation.
      let blueFontId = fontEls.findIndex(f => /Andale Mono/i.test(f) && /FF0000FF/i.test(f));
      const appendFont = blueFontId < 0; if (appendFont) blueFontId = fontEls.length;
      const xfEls = xfsM[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
      const baseXfCount = xfEls.length; if (!baseXfCount) return null;
      const added = []; const cache = {};
      const mapStyle = (origIdx) => {
        const oi = (origIdx >= 0 && origIdx < baseXfCount) ? origIdx : 0;
        if (cache[oi] != null) return cache[oi];
        let xf = xfEls[oi] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
        xf = /\bfontId="\d+"/.test(xf) ? xf.replace(/\bfontId="\d+"/, `fontId="${blueFontId}"`) : xf.replace(/<xf\b/, `<xf fontId="${blueFontId}"`);
        xf = /\bapplyFont="/.test(xf) ? xf.replace(/\bapplyFont="[^"]*"/, 'applyFont="1"') : xf.replace(/<xf\b/, '<xf applyFont="1"');
        // Réutilise un style dérivé identique déjà présent (évite d'empiler des xf à chaque écriture).
        const all = xfEls.concat(added); const dup = all.indexOf(xf);
        const idx = dup >= 0 ? dup : (baseXfCount + added.push(xf) - 1);
        cache[oi] = idx; return idx;
      };
      const finalize = () => {
        let out = stylesXml;
        if (appendFont) out = out.replace(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/, (m, inner) => `<fonts count="${fontEls.length + 1}">${inner}${blueFontXml}</fonts>`);
        if (added.length) out = out.replace(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/, (m, inner) => `<cellXfs count="${baseXfCount + added.length}">${inner}${added.join('')}</cellXfs>`);
        return out;
      };
      return { mapStyle, finalize };
    } catch (e) { return null; }
  }
  async patchXlsxFile(origBuf, editsBySheetName, opts) {
    const _refuseFormula = !!(opts && opts.refuseFormula); const _formulaHit = []; const _skipped = {}; // { sheetName: Set(colIdx) }
    const files = await this.unzipAll(origBuf);
    const dec = new TextDecoder(); const enc = new TextEncoder();
    const _mark = (opts && opts.markStyle) ? this._buildMarkStyler(dec.decode(files['xl/styles.xml'] || new Uint8Array())) : null;
    const wbXml = dec.decode(files['xl/workbook.xml'] || new Uint8Array());
    const relsXml = dec.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
    const relMap = this._relMapOf(relsXml);
    const targetByName = {}; [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].forEach(m => { targetByName[this.unxml(m[1])] = relMap[m[2]]; });
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const colName = n => { let s = '', m = n + 1; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; };
    // Style à écrire : si marquage actif, style dérivé (bleu + Andale) du style d'origine ; sinon le style d'origine.
    const styleAttrFor = (origIdxOrNull) => { if (_mark) return ` s="${_mark.mapStyle(origIdxOrNull == null ? 0 : origIdxOrNull)}"`; return origIdxOrNull == null ? '' : ` s="${origIdxOrNull}"`; };
    const cellXmlFor = (ref, styleAttr, val) => {
      const s = String(val == null ? '' : val).trim();
      if (s === '') return `<c r="${ref}"${styleAttr}/>`;
      const num = this._editNumeric(s);
      if (num != null) return `<c r="${ref}"${styleAttr}><v>${num}</v></c>`;
      return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
    };
    for (const sheetName of Object.keys(editsBySheetName)) {
      const target = targetByName[sheetName];
      if (!target || !files[target]) throw new Error(`feuille « ${sheetName} » introuvable dans le fichier — sauvegarde annulée`);
      let xml = dec.decode(files[target]);
      const edits = editsBySheetName[sheetName]; // { 'rIdx:cIdx': val } — rIdx = index de ligne CÔTÉ APERÇU
      const byRow = {};
      Object.keys(edits).forEach(k => { const [r, c] = k.split(':').map(Number); (byRow[r] = byRow[r] || {})[c] = edits[k]; });
      // IMPORTANT : même regex de découpage que readWorkbook (l'aperçu). Une ligne auto-fermée
      // (<row r="5"/>) y est avalée dans le segment de la ligne réelle suivante — les deux comptent
      // pour UNE seule ligne d'aperçu. En itérant à l'identique, l'index d'édition retombe
      // exactement sur le bon segment ; le numéro de ligne Excel est relu sur la DERNIÈRE balise
      // <row …> du segment (celle qui se referme vraiment et porte les cellules).
      const handled = {};
      let rowIdx = -1;
      xml = xml.replace(/<row[^>]*>[\s\S]*?<\/row>/g, rowFull => {
        rowIdx++;
        const rowEdits = byRow[rowIdx];
        if (!rowEdits) return rowFull;
        handled[rowIdx] = true;
        const opens = [...rowFull.matchAll(/<row\b[^>]*?\br="(\d+)"/g)];
        if (!opens.length) throw new Error('ligne sans numéro dans le fichier — sauvegarde annulée');
        const rowNum = opens[opens.length - 1][1];
        let out = rowFull;
        for (const cStr of Object.keys(rowEdits)) {
          const ref = colName(Number(cStr)) + rowNum;
          const cellRe = new RegExp(`<c\\s[^>]*?r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
          const exist = out.match(cellRe);
          if (exist) {
            const styleM = exist[0].match(/\ss="(\d+)"/);
            if (/<f[\s>/]/.test(exist[0])) {
              // Colonne cible en formule : on la SAUTE (silencieux), sauf si explicitement autorisée
              // pour cette colonne (ex. Solde, géré par le dashboard car la formule Excel ne se
              // recalcule pas sur une écriture directe du XML).
              const allowed = !!(opts && opts.allowFormulaCols && opts.allowFormulaCols[sheetName] && opts.allowFormulaCols[sheetName].has(Number(cStr)));
              if (_refuseFormula && !allowed) { _formulaHit.push(ref); (_skipped[sheetName] = _skipped[sheetName] || new Set()).add(Number(cStr)); continue; }
            }
            out = out.replace(cellRe, cellXmlFor(ref, styleAttrFor(styleM ? Number(styleM[1]) : null), rowEdits[cStr]));
          } else {
            // cellule absente (vide à l'origine) : insertion avant la première cellule de colonne
            // supérieure pour garder l'ordre croissant, sinon en fin de ligne.
            const newCell = cellXmlFor(ref, styleAttrFor(null), rowEdits[cStr]);
            const cells = [...out.matchAll(/<c\s[^>]*r="([A-Z]+)(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)];
            const colOf = ltr => { let v = 0; for (const ch of ltr) v = v * 26 + (ch.charCodeAt(0) - 64); return v; };
            const after = cells.find(m => colOf(m[1]) > Number(cStr) + 1);
            if (after) out = out.replace(after[0], newCell + after[0]);
            else out = out.replace(/<\/row>$/, newCell + '</row>');
          }
        }
        return out;
      });
      const unmatched = Object.keys(byRow).filter(r => !handled[r]);
      if (unmatched.length) throw new Error(`ligne introuvable dans « ${sheetName} » (le fichier a peut-être changé entre-temps) — sauvegarde annulée`);
      // Supprime la valeur en cache (<v>) de toute cellule en formule de la feuille modifiée :
      // Excel se fie sinon à ce cache et n'affiche pas le résultat recalculé à l'ouverture.
      xml = xml.replace(/(<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>))<v>[\s\S]*?<\/v>/g, '$1');
      files[target] = enc.encode(xml);
    }
    if (_mark) { const ns = _mark.finalize(); if (ns) files['xl/styles.xml'] = enc.encode(ns); } // police bleue Andale sur les cellules écrites
    // Toute écriture (même sans écraser une formule) peut laisser des formules dépendantes non
    // recalculées par Excel au prochain ouverture s'il se fie à calcChain.xml. On le supprime donc
    // systématiquement dès qu'il existe : Excel reconstruit sa chaîne de calcul et recalcule tout.
    if (files['xl/calcChain.xml']) {
      delete files['xl/calcChain.xml'];
      const ctName = '[Content_Types].xml';
      if (files[ctName]) {
        const ct = dec.decode(files[ctName]).replace(/<Override[^>]*calcChain\.xml[^>]*\/>/g, '');
        files[ctName] = enc.encode(ct);
      }
    }
    const entries = Object.keys(files).map(name => ({ name, bytes: files[name] }));
    const blob = await this.zipBuild(entries, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    blob._skippedFormulaCols = _skipped; blob._skippedFormulaRefs = _formulaHit; // annotation légère (colonnes ignorées, pour la vérification et le message)
    return blob;
  }

  // ================= Écriture dans les vrais fichiers Excel (mode paramétrage) =================
  // Réglage stocké par source, indépendant des mappings d'import (aucun risque de régression).
  writeMapFor(kind) { const m = this.state.writeMap || {}; return m[kind] || null; }
  saveWriteMap(kind, cfg) { const all = { ...(this.state.writeMap || {}) }; if (cfg) all[kind] = cfg; else delete all[kind]; this.setState({ writeMap: all }); this.saveJSON(Component.AVWMAP_KEY, all); }
  // Sources qui reçoivent réellement une écriture (une saisie transaction les alimente).
  writeableKinds() { return ['operations', 'ventes', 'factures']; }
  writeSourceLabel(kind) { return kind === 'operations' ? 'Achat pêcheur' : kind === 'ventes' ? 'Vente client' : kind === 'factures' ? 'Facture fournisseur' : kind; }
  static MONTHS_UP = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE'];
  // Champs candidats à placer, dans l'ordre des vraies colonnes de ses fichiers.
  writeFieldsFor(kind) {
    if (kind === 'operations') return [
      { key: 'ref', label: 'N° de facture' }, { key: 'annee', label: 'Année' }, { key: 'date', label: 'Date' },
      { key: 'partner', label: 'Nom du pêcheur / client' }, { key: 'amt', label: 'Montant' },
      { key: 'cheque', label: 'N° de chèque' }, { key: 'paid', label: 'Total payé' },
      { key: 'paidDate', label: 'Date de paiement' }, { key: 'solde', label: 'Solde' },
      { key: 'annule', label: 'Annulé' },
    ];
    if (kind === 'ventes') return [
      { key: 'idFacture', label: 'ID Facture' }, { key: 'ref', label: 'Numéro de facture' }, { key: 'partner', label: 'Client' }, { key: 'date', label: 'Date' },
      { key: 'ht', label: 'Montant HT' }, { key: 'tvaIr', label: 'TVA Irlande' }, { key: 'tvaFr', label: 'TVA France' },
      { key: 'grenke', label: 'GRENKE' }, { key: 'ttc', label: 'TOTAL TTC' }, { key: 'delai', label: 'Délai' },
      { key: 'datePrev', label: 'Date prévue' }, { key: 'status', label: 'Statut' }, { key: 'annule', label: 'Annulé' },
      // Avoir n'est PAS ici : il s'écrit dans l'onglet « Suivi des paiements », pas « Factures »
      // (voir requestAppendPreview, opts.suiviAvoir).
    ];
    if (kind === 'factures') return [
      { key: 'date', label: 'Date' }, { key: 'partner', label: 'Fournisseur' }, { key: 'ref', label: 'N° de facture' },
      { key: 'ttc', label: 'Montant' }, { key: 'paye', label: 'Paiement' }, { key: 'datePaie', label: 'Date paiement' },
      { key: 'annule', label: 'Annulé' },
    ];
    return [];
  }
  fournWriteValues(rec) { return { date: rec.date || '', partner: rec.fournisseur || '', ref: rec.num || '', ttc: rec.montant, paye: '', datePaie: '' }; }
  _isoToFr(iso) { const p = String(iso || '').split('-'); return (p.length === 3) ? `${p[2]}/${p[1]}/${p[0]}` : (iso || ''); }
  // Date ISO → numéro de série Excel (jours depuis le 30/12/1899). Écrit une VRAIE date Excel
  // (le style date de la cellule existante est conservé par le patch).
  _excelSerial(iso) { const p = String(iso || '').split('-').map(Number); if (p.length !== 3 || !p[0]) return null; const d = Date.UTC(p[0], p[1] - 1, p[2]); const e = Date.UTC(1899, 11, 30); return Math.round((d - e) / 86400000); }
  // Champs qui sont des dates (écrites en série Excel), par source.
  _dateFieldsFor(kind) { return kind === 'ventes' ? { date: 1, datePrev: 1 } : kind === 'operations' ? { date: 1, paidDate: 1 } : kind === 'factures' ? { date: 1, datePaie: 1 } : {}; }
  // RÈGLE 3 : colonnes MÉTIER PRINCIPALES pour repérer la dernière vraie écriture (jamais le n° de facture pré-imprimé).
  _anchorFieldsFor(kind) { return kind === 'ventes' ? ['date', 'ht', 'partner'] : kind === 'operations' ? ['date', 'amt', 'partner'] : kind === 'factures' ? ['date', 'ttc', 'partner'] : []; }
  // Valeurs d'une saisie, par clé de champ (toutes les clés candidates ; l'ajout n'écrit QUE les colonnes réellement mappées).
  achatWriteValues(rec) { const immediat = !!rec.paiementImmediat; return { ref: rec.num || '', annee: String(rec.date || '').slice(0, 4), date: rec.date || '', partner: rec.pecheur || '', amt: rec.total, cheque: rec.paiement === 'cheque' ? (rec.chequeNum || '') : (rec.paiement === 'autre' ? (rec.observation || '') : ''), paid: immediat ? rec.total : '', paidDate: immediat ? this._payTodayIso() : '', solde: immediat ? 0 : rec.total }; }
  venteWriteValues(rec) { const delai = Math.max(0, Math.min(30, Math.round(this._vNum(rec.delai)))); return { idFacture: rec.idFacture || '', ref: rec.num || '', partner: rec.client || '', date: rec.date || '', ht: rec.ht, tvaIr: rec.tvaIrl, tvaFr: rec.tvaFr, grenke: rec.grenke ? rec.grenke.montant : '', ttc: rec.ttc, delai: delai ? (delai + ' jrs') : '', datePrev: rec.datePrev || '', status: '' }; }

  // Handle inscriptible d'une source connectée (fichier surveillé prioritaire, sinon cache d'import).
  _writableHandleFor(kind) {
    const w = this._watched || {};
    for (const k of Object.keys(w)) { if (w[k] && w[k].kind === kind && w[k].handle) return { handle: w[k].handle, name: w[k].name }; }
    const c = (this._wbCache || {})[kind]; if (c && c.handle) return { handle: c.handle, name: c.name };
    return null;
  }
  async _ensureWritePermission(handle) {
    if (!handle) return false;
    try { let p = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted'; if (p !== 'granted' && handle.requestPermission) p = await handle.requestPermission({ mode: 'readwrite' }); return p === 'granted'; }
    catch (e) { return false; }
  }
  // Copie de sauvegarde datée des octets d'origine AVANT toute écriture.
  async _backupBeforeWrite(name, buf) {
    const n = new Date();
    const stamp = `${n.getFullYear()}-${this.dd(n.getMonth() + 1)}-${this.dd(n.getDate())} ${this.dd(n.getHours())}h${this.dd(n.getMinutes())}`;
    const base = String(name || 'fichier').replace(/\.xlsx?$/i, '');
    const bakName = `${base} — sauvegarde ${stamp}.xlsx`;
    const bytes = new Uint8Array(buf.slice(0));
    if (this._backupDir && this._backupDir.getFileHandle) {
      try { const fh = await this._backupDir.getFileHandle(bakName, { create: true }); const wr = await fh.createWritable(); await wr.write(bytes); await wr.close(); return { ok: true, where: this._backupDir.name || 'dossier de sauvegarde', bakName }; } catch (e) {}
    }
    // repli : téléchargement de la copie de sauvegarde
    try { const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = bakName; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000); return { ok: true, where: 'téléchargement', bakName }; } catch (e) { return { ok: false }; }
  }

  // Localise la ligne d'écriture — RÈGLE 3 : on écrit JUSTE APRÈS la dernière ligne contenant une
  // vraie écriture métier (au moins une colonne de saisie renseignée). On ne réutilise JAMAIS une
  // ligne vide située au milieu d'anciennes écritures, et on ignore les lignes seulement formatées
  // ou les formules préparées loin sous le tableau. Retourne { previewIdx, excelRow, mode:'patch'|'append' }.
  async _locateAppendTarget(buf, sheetName, colIdxs, firstDataIdx, dateColIdx) {
    const files = await this.unzipAll(buf); const dec = new TextDecoder();
    const wbXml = dec.decode(files['xl/workbook.xml'] || new Uint8Array());
    const relsXml = dec.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
    const relMap = this._relMapOf(relsXml);
    const targetByName = {}; [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].forEach(m => { targetByName[this.unxml(m[1])] = relMap[m[2]]; });
    const target = targetByName[sheetName];
    if (!target || !files[target]) throw new Error(`feuille « ${sheetName} » introuvable dans le fichier`);
    const xml = dec.decode(files[target]);
    const coln = r => { const mm = r.match(/^([A-Z]+)/); let v = 0; for (const c of mm[1]) v = v * 26 + (c.charCodeAt(0) - 64); return v; };
    const rows = []; const rowsRe = /<row[^>]*>[\s\S]*?<\/row>/g; let rm; let rowIdx = -1; let maxRowNum = 0;
    let lastContentIdx = -1;                       // dernière ligne avec une VRAIE écriture métier
    while (rm = rowsRe.exec(xml)) {
      rowIdx++;
      const opens = [...rm[0].matchAll(/<row\b[^>]*?\br="(\d+)"/g)];
      const rowNum = opens.length ? +opens[opens.length - 1][1] : (maxRowNum + 1);
      maxRowNum = Math.max(maxRowNum, rowNum);
      let hasContent = false;
      if (rowIdx >= firstDataIdx) {
        const cells = {}; const cellsRaw = {}; const cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
        while (cm = cr.exec(rm[0])) { const refM = cm[1].match(/\br="([A-Z]+)\d+"/); if (!refM) continue; const body = cm[2] || ''; const vm = body.match(/<v>([\s\S]*?)<\/v>/); const im = body.match(/<t[^>]*>([\s\S]*?)<\/t>/); const ci = coln(refM[1]); cells[ci] = (im ? im[1] : (vm ? vm[1] : '')).trim(); cellsRaw[ci] = cm[0]; }
        const normAgg = s => this._norm(s);
        const AGG_ROOTS = ['total', 'sous-total', 'sous total', 'somme', 'solde', 'report', 'cumul', 'grand total', 'totaux'];
        const isAgg = v => AGG_ROOTS.some(root => v === root || v.startsWith(root) || v.endsWith(root) || v.includes(root));
        const cellOk = ci => {
          const raw = cellsRaw[ci + 1]; if (!raw) return false;
          if (/<f[\s>/]/.test(raw)) return false; // FILTRE 1 — cellule ancre en formule, ignorée
          if (isAgg(normAgg(cells[ci + 1]))) return false; // FILTRE 2 — libellé agrégat, ignoré (préfixe/inclusion)
          const numVal = parseFloat(String(cells[ci + 1]).replace(',', '.'));
          if (!isNaN(numVal) && numVal <= 1) return false; // FILTRE 3 — date nulle Excel (série ≤ 1, ex. 00/01/1900) ou zéro, ignorée
          return !!cells[ci + 1];
        };
        // FILTRE GLOBAL — si n'importe quelle cellule de la ligne (pas seulement les colonnes
        // ancres) contient un libellé agrégat, toute la ligne est ignorée comme contenu métier.
        const rowIsAgg = Object.values(cells).some(v => v && isAgg(normAgg(String(v))));
        // RÈGLE : une ligne pré-imprimée (n° de facture + année seuls) n'est PAS du contenu métier
        // réel. On exige une date ancre valide (> 1 en série Excel) ET au moins une AUTRE colonne
        // ancre renseignée (montant ou partenaire) — pas l'une ou l'autre seule.
        if (rowIsAgg) {
          hasContent = false;
        } else if (dateColIdx != null && dateColIdx >= 0) {
          const dateOk = cellOk(dateColIdx);
          const otherOk = colIdxs.some(ci => ci !== dateColIdx && cellOk(ci));
          hasContent = dateOk && otherOk;
        } else {
          hasContent = colIdxs.some(cellOk); // colonne date inconnue de l'appelant : comportement précédent
        }
      }
      rows.push({ previewIdx: rowIdx, excelRow: rowNum });
      if (hasContent) lastContentIdx = rowIdx;
    }
    // Tableau vide de saisies → on écrit sur la 1re ligne de données configurée.
    if (lastContentIdx < 0) {
      const first = rows.find(r => r.previewIdx >= firstDataIdx);
      if (first) return { previewIdx: first.previewIdx, excelRow: first.excelRow, mode: 'patch' };
      return { previewIdx: firstDataIdx, excelRow: maxRowNum + 1, mode: 'append' };
    }
    // Ligne logique = juste après la dernière vraie écriture.
    const next = rows.find(r => r.previewIdx === lastContentIdx + 1);
    if (next) return { previewIdx: next.previewIdx, excelRow: next.excelRow, mode: 'patch' };
    // Pas de ligne préformatée disponible après → nouvelle ligne en fin de tableau.
    const last = rows[lastContentIdx];
    return { previewIdx: lastContentIdx + 1, excelRow: (last ? last.excelRow : maxRowNum) + 1, mode: 'append' };
  }

  // CORRECTION 2 : après une écriture réussie, prépare automatiquement la ligne pré-imprimée
  // SUIVANTE (n° de facture + année, tout le reste vide) — pour que le prochain "n° lu du fichier"
  // trouve toujours une ligne prête. Best-effort : toute erreur est journalée en silence et
  // n'affecte jamais la saisie qui vient de réussir (jamais d'exception propagée, jamais de modale).
  async _appendNextBlankRow(kind, opts) {
    try {
      const cfg = this.writeMapFor(kind); if (!cfg || !cfg.enabled) return;
      let sheetName, colsMap, firstDataIdx = cfg.firstDataIdx || 0;
      if (kind === 'factures' && (cfg.months || cfg.blocks)) {
        const m = Math.max(1, Math.min(12, (opts && opts.month) || 1));
        const block = (opts && opts.block) === 'crustace' ? 'crustace' : 'normal';
        const mc = cfg.months && cfg.months[m];
        if (mc) { sheetName = mc.sheetName; colsMap = (mc.blocks[block] || {}).cols || {}; firstDataIdx = mc.firstDataIdx; }
        else { sheetName = (cfg.monthSheets || [])[m - 1]; colsMap = ((cfg.blocks && cfg.blocks[block]) || {}).cols || {}; firstDataIdx = cfg.firstDataIdx || 0; }
        if (!sheetName) return;
      } else {
        if (!cfg.cols) return;
        sheetName = cfg.sheetName; colsMap = cfg.cols;
      }
      const refCol = colsMap.ref; if (refCol == null || refCol < 0) return;
      const hi = this._writableHandleFor(kind); if (!hi || !hi.handle) return;
      const okPerm = await this._ensureWritePermission(hi.handle); if (!okPerm) return;
      const file = await hi.handle.getFile(); const buf = await file.arrayBuffer();
      const wb = await this.readWorkbook(buf.slice(0)); const sh = wb.find(s => s.name === sheetName); if (!sh) return;
      // Dernier numéro du tableau : on scanne toute la colonne référence, on garde le format
      // (préfixe + zéros de tête) du numéro le plus élevé pour générer le suivant à l'identique.
      let bestNum = -1, bestRef = '';
      for (let r = firstDataIdx; r < sh.rows.length; r++) {
        const v = String((sh.rows[r] || [])[refCol] == null ? '' : (sh.rows[r] || [])[refCol]).trim();
        const digits = v.match(/\d+/); if (!digits) continue;
        const n = parseInt(digits[0], 10);
        if (n > bestNum) { bestNum = n; bestRef = v; }
      }
      if (bestNum < 0) return; // aucun numéro exploitable dans le tableau : on n'invente rien
      const digits = bestRef.match(/\d+/)[0];
      const nextRef = bestRef.replace(digits, String(bestNum + 1).padStart(digits.length, '0'));
      const anchorKeys = this._anchorFieldsFor(kind);
      const dateKeyN = Object.keys(this._dateFieldsFor(kind)).find(k => anchorKeys.indexOf(k) >= 0 && colsMap[k] != null && colsMap[k] >= 0);
      const dateColIdxN = dateKeyN != null ? colsMap[dateKeyN] : -1;
      const anchorIdxsN = anchorKeys.map(k => colsMap[k]).filter(ci => ci != null && ci >= 0);
      const loc = await this._locateAppendTarget(buf.slice(0), sheetName, anchorIdxsN.length ? anchorIdxsN : [refCol], firstDataIdx, dateColIdxN);
      const colVals = { [refCol]: nextRef };
      if (colsMap.annee != null && colsMap.annee >= 0) colVals[colsMap.annee] = String(new Date().getFullYear());
      const bak = await this._backupBeforeWrite(hi.name, buf);
      if (!bak || !bak.ok) return; // pas de sauvegarde → pas d'écriture, comme pour les écritures normales
      let patched;
      if (loc.mode === 'append') patched = await this._appendXlsxRow(buf, sheetName, loc.excelRow, colVals);
      else { const edits = {}; edits[sheetName] = {}; Object.keys(colVals).forEach(ci => { edits[sheetName][loc.previewIdx + ':' + ci] = colVals[ci]; }); patched = await this.patchXlsxFile(buf, edits, { refuseFormula: true }); }
      const patchedBuf = await patched.arrayBuffer();
      const w = await hi.handle.createWritable(); await w.write(patchedBuf); await w.close();
      try { const wm = this._watched || {}; for (const k of Object.keys(wm)) if (wm[k] && wm[k].handle === hi.handle) wm[k].lastMod = 0; } catch (e) {}
    } catch (e) { console.error('Ajout de la ligne pré-imprimée suivante impossible (non bloquant) :', e); }
  }

  // Insère une nouvelle <row> (cas où il n'y a plus de ligne vide préformatée). Préserve tout le reste.
  async _appendXlsxRow(buf, sheetName, excelRow, colVals) {
    const files = await this.unzipAll(buf); const dec = new TextDecoder(); const enc = new TextEncoder();
    const wbXml = dec.decode(files['xl/workbook.xml'] || new Uint8Array());
    const relsXml = dec.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
    const relMap = this._relMapOf(relsXml);
    const targetByName = {}; [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].forEach(m => { targetByName[this.unxml(m[1])] = relMap[m[2]]; });
    const target = targetByName[sheetName];
    if (!target || !files[target]) throw new Error(`feuille « ${sheetName} » introuvable — ajout annulé`);
    let xml = dec.decode(files[target]);
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const colName = n => { let s = '', m = n; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; };
    const cols = Object.keys(colVals).map(Number).sort((a, b) => a - b);
    let cellsXml = '';
    cols.forEach(ci => { const ref = colName(ci + 1) + excelRow; const v = colVals[ci]; const s = String(v == null ? '' : v).trim(); if (s === '') return; const num = this._editNumeric(s); cellsXml += num != null ? `<c r="${ref}"><v>${num}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`; });
    const rowXml = `<row r="${excelRow}">${cellsXml}</row>`;
    if (/<\/sheetData>/.test(xml)) xml = xml.replace('</sheetData>', rowXml + '</sheetData>');
    else if (/<sheetData\/>/.test(xml)) xml = xml.replace('<sheetData/>', `<sheetData>${rowXml}</sheetData>`);
    else throw new Error('structure de feuille inattendue — ajout annulé');
    xml = xml.replace(/(<dimension[^>]*ref=")([A-Z]+)(\d+):([A-Z]+)(\d+)("[^>]*\/>)/, (m, a, c1, r1, c2, r2, z) => a + c1 + r1 + ':' + c2 + Math.max(+r2, excelRow) + z);
    files[target] = enc.encode(xml);
    const entries = Object.keys(files).map(name => ({ name, bytes: files[name] }));
    return this.zipBuild(entries, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // Prépare l'aperçu d'écriture d'une saisie (ne WRIT PAS encore — attend la confirmation).
  async requestAppendPreview(kind, valsByField, opts) {
    opts = opts || {};
    if (this.writeableKinds().indexOf(kind) < 0) return;
    const cfg = this.writeMapFor(kind);
    if (!cfg || !cfg.enabled) return; // écriture non réglée / désactivée → saisie déjà en localStorage
    // Résolution de la feuille + du jeu de colonnes (branche « factures » = 12 feuilles-mois + 2 blocs).
    let sheetName, colsMap, firstDataIdx = cfg.firstDataIdx || 0;
    if (kind === 'factures' && (cfg.months || cfg.blocks)) {
      const m = Math.max(1, Math.min(12, opts.month || 1));
      const block = opts.block === 'crustace' ? 'crustace' : 'normal';
      const mc = cfg.months && cfg.months[m]; // configuration PROPRE À CE MOIS (en-tête + colonnes)
      if (mc) { sheetName = mc.sheetName; colsMap = (mc.blocks[block] || {}).cols || {}; firstDataIdx = mc.firstDataIdx; }
      else { sheetName = (cfg.monthSheets || [])[m - 1]; colsMap = ((cfg.blocks && cfg.blocks[block]) || {}).cols || {}; firstDataIdx = cfg.firstDataIdx || 0; }
      if (!sheetName) { this.setState({ msg: { kind: 'error', text: `Écriture impossible : la feuille du mois de ${Component.MONTHS[m]} n'existe pas dans « ${cfg.fileName} ». La facture n'a PAS été enregistrée.` } }); return; }
    } else {
      if (!cfg.cols) return; sheetName = cfg.sheetName; colsMap = cfg.cols;
    }
    const hi = this._writableHandleFor(kind);
    if (!hi || !hi.handle) { this.setState({ msg: { kind: 'error', text: `Écriture impossible : le fichier « ${cfg.fileName || this.writeSourceLabel(kind)} » n'est pas connecté. Reconnectez-le dans Paramètres.` } }); return; }
    const colName = n => { let s = '', m = n; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; };
    try {
      const okPerm = await this._ensureWritePermission(hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0); // empreinte anti-écrasement
      let buf = await file.arrayBuffer();
      const dateFields = this._dateFieldsFor(kind);
      const fields = this.writeFieldsFor(kind).filter(f => colsMap[f.key] != null && colsMap[f.key] >= 0);
      const colIdxs = fields.map(f => colsMap[f.key]);
      // RÈGLE 3 : la « dernière vraie ligne » se détecte sur les COLONNES MÉTIER PRINCIPALES
      // (date, montant, partenaire) — jamais sur la colonne n° de facture, qui est PRÉ-IMPRIMÉE
      // sur toutes les lignes et fausserait la détection (sinon on écrit tout en bas, hors du tableau).
      const anchorKeys = this._anchorFieldsFor(kind);
      let anchorIdxs = fields.filter(f => anchorKeys.indexOf(f.key) >= 0).map(f => colsMap[f.key]);
      if (!anchorIdxs.length) anchorIdxs = colIdxs;
      const dateKey2 = Object.keys(dateFields).find(k => anchorKeys.indexOf(k) >= 0 && colsMap[k] != null && colsMap[k] >= 0);
      const dateColIdx2 = dateKey2 != null ? colsMap[dateKey2] : -1;
      const loc = await this._locateAppendTarget(buf, sheetName, anchorIdxs, firstDataIdx, dateColIdx2);
      // RÈGLE 4 : revérifier que les en-têtes des colonnes écrites existent encore (structure non bousculée).
      const hdrIdx = Math.max(0, firstDataIdx - 1);
      const wbH = await this.readWorkbook(buf.slice(0)); const shH = wbH.find(s => s.name === sheetName);
      const hdrRow = (shH && shH.rows[hdrIdx]) || [];
      const targetRow = (shH && shH.rows[loc.previewIdx]) || []; // valeurs déjà présentes sur la ligne cible (n° pré-imprimé…)
      const missingHdr = colIdxs.filter(ci => !String(hdrRow[ci] == null ? '' : hdrRow[ci]).trim());
      if (colIdxs.length && missingHdr.length === colIdxs.length) throw new Error(`la structure de « ${sheetName} » a changé (en-têtes introuvables ligne ${hdrIdx + 1}) — rouvrez le réglage des colonnes dans Paramètres`);
      const colVals = {}; const preview = [];
      fields.forEach(f => {
        const ci = colsMap[f.key]; const raw = valsByField[f.key];
        // Ne JAMAIS écraser un n° de facture déjà pré-imprimé : on garde celui du fichier.
        if (f.key === 'ref') { const existing = String(targetRow[ci] == null ? '' : targetRow[ci]).trim(); if (existing) { preview.push({ label: f.label, col: colName(ci + 1), value: existing + ' (déjà là)' }); return; } }
        const s = (raw == null ? '' : String(raw)).trim();
        if (dateFields[f.key] && s !== '') {
          const serial = this._excelSerial(raw); // écrit une VRAIE date Excel (série), affiche JJ/MM/AAAA
          if (serial != null) { colVals[ci] = serial; preview.push({ label: f.label, col: colName(ci + 1), value: this._isoToFr(raw) }); return; }
        }
        if (s !== '') colVals[ci] = raw;
        preview.push({ label: f.label, col: colName(ci + 1), value: s === '' ? '—' : s });
      });
      // Solde géré par le dashboard : la formule Excel =SIERREUR(Montant-[Total payé];"") ne se
      // recalcule pas sur une écriture directe du XML — on autorise l'écrasement UNIQUEMENT sur
      // cette colonne, jamais sur les autres (protection anti-formule conservée partout ailleurs).
      const allowFormulaCols = (kind === 'operations' && colsMap.solde != null && colsMap.solde >= 0) ? { [sheetName]: new Set([colsMap.solde]) } : null;
      // Vente avec Avoir : écriture combinée Factures + Suivi des paiements (Avoir uniquement, sur
      // une ligne libre) dans UNE seule transaction editsBySheet — même mécanisme que l'achat pour
      // ses écritures multi-feuilles (pêcheur + chéquier), un seul aperçu/confirmation.
      let editsBySheet = null; let verifyTargets = null; let combinedSheetName = sheetName;
      console.log('[suivi] bloc suiviAvoir déclenché', opts.suiviAvoir);
      if (kind === 'ventes' && opts.suiviAvoir && opts.suiviAvoir.idFacture) {
        const sloc = this._suiviLocate(wbH);
        console.log('[suivi] loc:', sloc ? sloc.sheetName : 'null');
        if (sloc && sloc.cols.idFacture >= 0) {
          // Cherche une ligne EXISTANTE dont la colonne A vaut exactement cet ID Facture — pas
          // la première case vide. Si trouvée, on n'y écrit que l'Avoir (l'ID y est déjà).
          const idStr = String(opts.suiviAvoir.idFacture).trim();
          const rows2 = wbH.find(s => s.name === sloc.sheetName).rows;
          let rowIdx2 = -1;
          for (let r = sloc.dataStart; r < rows2.length; r++) { const v = (rows2[r] || [])[sloc.cols.idFacture]; if (v != null && String(v).trim() === idStr) { rowIdx2 = r; break; } }
          const found = rowIdx2 >= 0;
          if (!found) {
            // Pas de ligne pour cet ID : on en crée une en fin de tableau (jamais un trou plus
            // haut), en recopiant les formules des colonnes calculées de la ligne précédente
            // (B,C,D,F→N), décalées de +1 ligne. Prudence : seules les références relatives
            // simples sont décalées (voir _suiviAppendRowWithFormulas).
            console.log('[suivi] colIdxs:', [sloc.cols.idFacture]);
            const loc2 = await this._locateAppendTarget(buf, sloc.sheetName, [sloc.cols.idFacture], sloc.dataStart);
            if (loc2.mode === 'append') {
              const patched = await this._suiviAppendRowWithFormulas(buf, sloc.sheetName, loc2.excelRow - 1, ['B', 'C', 'D', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N']);
              buf = await patched.arrayBuffer();
              console.log('[suivi] après append, buf size:', buf.byteLength);
            }
            rowIdx2 = loc2.previewIdx;
          }
          console.log('[suivi] rowIdx:', rowIdx2, 'mode:', found ? 'trouvé (ID existant)' : 'créée en fin de tableau');
          editsBySheet = { [sheetName]: {} }; verifyTargets = [];
          Object.keys(colVals).forEach(ci => { editsBySheet[sheetName][loc.previewIdx + ':' + ci] = colVals[ci]; verifyTargets.push({ sheetName, rowIdx: loc.previewIdx, col: +ci, val: colVals[ci] }); });
          editsBySheet[sloc.sheetName] = editsBySheet[sloc.sheetName] || {};
          if (!found) {
            editsBySheet[sloc.sheetName][rowIdx2 + ':' + sloc.cols.idFacture] = opts.suiviAvoir.idFacture;
            preview.push({ label: 'ID Facture (Suivi des paiements)', col: `${colName(sloc.cols.idFacture + 1)}${rowIdx2 + 1}`, value: String(opts.suiviAvoir.idFacture) });
            verifyTargets.push({ sheetName: sloc.sheetName, rowIdx: rowIdx2, col: sloc.cols.idFacture, val: opts.suiviAvoir.idFacture });
          }
          if (opts.suiviAvoir.avoir && sloc.cols.avoir >= 0) {
            editsBySheet[sloc.sheetName][rowIdx2 + ':' + sloc.cols.avoir] = opts.suiviAvoir.avoir;
            preview.push({ label: 'Avoir (Suivi des paiements)', col: `${colName(sloc.cols.avoir + 1)}${rowIdx2 + 1}`, value: this.fmt(opts.suiviAvoir.avoir) });
            verifyTargets.push({ sheetName: sloc.sheetName, rowIdx: rowIdx2, col: sloc.cols.avoir, val: opts.suiviAvoir.avoir });
          }
          combinedSheetName = `${sheetName}, ${sloc.sheetName}`;
        }
      }
      this._pendingWrite = editsBySheet
        ? { kind, buf, handle: hi.handle, name: hi.name, fingerprint, sheetName: combinedSheetName, editsBySheet, verifyTargets, refuseFormula: !!opts.refuseFormula, allowFormulaCols, after: opts.after || null, afterClose: opts.afterClose || null, step: opts.step || null }
        : { kind, buf, handle: hi.handle, name: hi.name, fingerprint, sheetName, excelRow: loc.excelRow, previewIdx: loc.previewIdx, mode: loc.mode, colVals, refuseFormula: !!opts.refuseFormula, allowFormulaCols, after: opts.after || null, afterClose: opts.afterClose || null, step: opts.step || null };
      this.setState({ writePreview: { kind, fileName: hi.name, sheetName: combinedSheetName, excelRow: editsBySheet ? null : loc.excelRow, rows: preview, status: null } });
    } catch (e) {
      const tail = kind === 'ventes' ? " La vente n'a PAS été enregistrée — corrigez le réglage de l'écriture puis recommencez." : ' Votre saisie est enregistrée dans le tableau de bord.';
      this.setState({ msg: { kind: 'error', text: `Préparation de l'écriture impossible : ${(e && e.message) || 'erreur'}.${tail}` } });
    }
  }
  annuleKey(kind, ref) { return kind + '|' + this.nrm(ref || ''); }
  // Repère une ligne DÉJÀ ENREGISTRÉE par son numéro de référence (pas la prochaine ligne
  // vide) — nécessaire pour marquer "Annulé" sur la bonne ligne sans y toucher autrement.
  async _locateRowByRef(buf, sheetName, refColIdx, refValue, firstDataIdx) {
    const files = await this.unzipAll(buf); const dec = new TextDecoder();
    const wbXml = dec.decode(files['xl/workbook.xml'] || new Uint8Array());
    const relsXml = dec.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
    const relMap = this._relMapOf(relsXml);
    const targetByName = {}; [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].forEach(m => { targetByName[this.unxml(m[1])] = relMap[m[2]]; });
    const target = targetByName[sheetName];
    if (!target || !files[target]) throw new Error(`feuille « ${sheetName} » introuvable dans le fichier`);
    const xml = dec.decode(files[target]);
    // Résolution des chaînes partagées (t="s") — <v>N</v> est alors un INDEX dans
    // xl/sharedStrings.xml, pas la valeur. Même mécanique que xlsxToText/readWorkbook.
    const sharedStrings = [];
    const ssx = dec.decode(files['xl/sharedStrings.xml'] || new Uint8Array());
    if (ssx) { const siRe = /<si>([\s\S]*?)<\/si>/g; let sm; while (sm = siRe.exec(ssx)) { const t = [...sm[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''); sharedStrings.push(this.unxml(t)); } }
    const coln = r => { const mm = r.match(/^([A-Z]+)/); let v = 0; for (const c of mm[1]) v = v * 26 + (c.charCodeAt(0) - 64); return v; };
    const want = this.nrm(refValue).replace(/^0+(?=\d)/, '');
    const rowsRe = /<row[^>]*>[\s\S]*?<\/row>/g; let rm; let rowIdx = -1;
    while (rm = rowsRe.exec(xml)) {
      rowIdx++;
      if (rowIdx < firstDataIdx) continue;
      const opens = [...rm[0].matchAll(/<row\b[^>]*?\br="(\d+)"/g)];
      const rowNum = opens.length ? +opens[opens.length - 1][1] : (rowIdx + 1);
      const cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm; let val = '';
      while (cm = cr.exec(rm[0])) {
        const refM = cm[1].match(/\br="([A-Z]+)\d+"/); if (!refM) continue;
        if (coln(refM[1]) === refColIdx + 1) {
          const body = cm[2] || '';
          const typeM = cm[1].match(/\bt="([^"]+)"/); const typ = typeM ? typeM[1] : '';
          const vm = body.match(/<v>([\s\S]*?)<\/v>/); const im = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = im ? im[1] : (vm ? (typ === 's' ? (sharedStrings[+vm[1]] || '') : vm[1]) : '');
          val = String(val).trim();
          break;
        }
      }
      const valNorm = this.nrm(val).replace(/^0+(?=\d)/, '');
      if (valNorm && valNorm === want) return { previewIdx: rowIdx, excelRow: rowNum };
    }
    return null;
  }
  // Annulation visible (ou rétablissement) d'une ligne déjà enregistrée : on n'efface rien,
  // on écrit "Annulé" (ou une case vide, pour rétablir) dans la colonne dédiée réglée comme
  // les autres colonnes d'écriture. Réutilise exactement la même modale/sauvegarde/écriture
  // que l'ajout d'une ligne (confirmAppendWrite gère la sauvegarde datée + le disque + le verrou).
  async requestCancelPreview(kind, ref, opts) {
    opts = opts || {};
    const cfg = this.writeMapFor(kind);
    if (!cfg || !cfg.enabled) { this.setState({ msg: { kind: 'error', text: `Écriture non réglée pour « ${this.writeSourceLabel(kind)} » — réglez-la dans Paramètres avant d'annuler une ligne dans Excel.` } }); return; }
    let sheetName, colsMap, firstDataIdx = cfg.firstDataIdx || 0;
    if (kind === 'factures' && (cfg.months || cfg.blocks)) {
      const m = Math.max(1, Math.min(12, opts.month || 1));
      const block = opts.block === 'crustace' ? 'crustace' : 'normal';
      const mc = cfg.months && cfg.months[m];
      if (mc) { sheetName = mc.sheetName; colsMap = (mc.blocks[block] || {}).cols || {}; firstDataIdx = mc.firstDataIdx; }
      else { sheetName = (cfg.monthSheets || [])[m - 1]; colsMap = ((cfg.blocks && cfg.blocks[block]) || {}).cols || {}; firstDataIdx = cfg.firstDataIdx || 0; }
      if (!sheetName) { this.setState({ msg: { kind: 'error', text: `Annulation impossible : la feuille du mois de ${Component.MONTHS[m]} n'existe pas dans « ${cfg.fileName} ».` } }); return; }
    } else {
      if (!cfg.cols) return;
      sheetName = cfg.sheetName; colsMap = cfg.cols;
    }
    const annuleCol = colsMap.annule;
    if (annuleCol == null || annuleCol < 0) { this.setState({ msg: { kind: 'error', text: `Aucune colonne « Annulé » réglée pour « ${this.writeSourceLabel(kind)} » — ajoutez-la dans Paramètres → Régler l'écriture.` } }); return; }
    const refCol = colsMap.ref;
    if (refCol == null || refCol < 0) { this.setState({ msg: { kind: 'error', text: `Colonne « N° de facture » non réglée pour « ${this.writeSourceLabel(kind)} » — impossible de retrouver la ligne.` } }); return; }
    const hi = this._writableHandleFor(kind);
    if (!hi || !hi.handle) { this.setState({ msg: { kind: 'error', text: `Fichier « ${cfg.fileName || this.writeSourceLabel(kind)} » non connecté. Reconnectez-le dans Paramètres.` } }); return; }
    try {
      const okPerm = await this._ensureWritePermission(hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, sheetName, refCol, ref, firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${sheetName} » — le fichier a peut-être changé. Actualisez puis réessayez.` } }); return; }
      const colVals = { [annuleCol]: opts.restore ? '' : 'Annulé' };
      this._pendingWrite = { kind, buf, handle: hi.handle, name: hi.name, fingerprint, sheetName, excelRow: loc.excelRow, previewIdx: loc.previewIdx, mode: 'patch', colVals, refuseFormula: true, after: () => this.confirmAnnuleAfterWrite(kind, ref, !!opts.restore, { month: opts.month, block: opts.block }) };
      this.setState({ writePreview: { kind: 'annule', fileName: hi.name, sheetName, excelRow: loc.excelRow, rows: [{ label: 'Annulé', col: this._colLetter(annuleCol + 1), value: opts.restore ? '(case vidée)' : 'Annulé' }], status: null, restore: !!opts.restore, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation de l'annulation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  confirmAnnuleAfterWrite(kind, ref, restore, meta) {
    const m = { ...(this.state.annule || {}) };
    const key = this.annuleKey(kind, ref);
    if (restore) delete m[key]; else m[key] = { kind, ref, month: meta && meta.month, block: meta && meta.block, ts: Date.now() };
    this.setState({ annule: m });
    this.saveJSON(Component.ANNULE_KEY, m);
  }
  cancelAppendWrite() { const st = this._pendingWrite && this._pendingWrite.step; this._pendingWrite = null; this.setState({ writePreview: null }); if (st && this._achatSteps) { this._achatSteps[st] = 'annulé'; this._maybeFinalizeAchat(); } this._runNextWrite(); }
  // « Noter plus tard » (modale Fichier ouvert) : mémorise la saisie en attente (métadonnées seulement —
  // buf/handle non sérialisables ne sont pas stockés) puis abandonne comme un Annuler classique.
  savePendingWriteLater() {
    const pw = this._pendingWrite;
    if (pw) {
      try {
        const list = JSON.parse(localStorage.getItem('avPendingWrites') || '[]');
        const arr = Array.isArray(list) ? list : [];
        arr.push({ kind: pw.kind, name: pw.name, sheetName: pw.sheetName, excelRow: pw.excelRow, previewIdx: pw.previewIdx, mode: pw.mode, colVals: pw.colVals, refuseFormula: pw.refuseFormula, step: pw.step, ts: Date.now() });
        localStorage.setItem('avPendingWrites', JSON.stringify(arr));
      } catch (e) {}
    }
    const st = pw && pw.step;
    this._pendingWrite = null;
    this.setState({ writePreview: null });
    if (st && this._achatSteps) { this._achatSteps[st] = 'annulé'; this._maybeFinalizeAchat(); }
    this._runNextWrite();
  }
  // File d'attente des écritures enchaînées après une saisie (ex. achat → chèque → stock).
  // Chaque écriture confirmée (ou annulée) déclenche la suivante, avec son propre aperçu.
  _runNextWrite() { const q = this._writeQueue; if (q && q.length) { const fn = q.shift(); setTimeout(() => { try { fn(); } catch (e) {} }, 0); } }

  // ---------- Circuit B2 — chèque : compléter la ligne du numéro DÉJÀ IMPRIMÉ ----------
  // Retrouve la feuille chèque correspondant au chéquier (par nom identique, tolérant aux espaces).
  _chequeSheetName(chequier, wb) {
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(chequier); if (!target) return null;
    let hit = wb.find(s => norm(s.name) === target);
    if (hit) return hit.name;
    // repli : le chéquier « 516 000 » ↔ feuille dont le nom commence par le même numéro
    const digits = String(chequier || '').replace(/\D/g, ''); if (digits.length >= 3) { hit = wb.find(s => String(s.name).replace(/\D/g, '').startsWith(digits.slice(0, 3))); if (hit) return hit.name; }
    return null;
  }
  // RÈGLE 9 : la feuille du chèque est déterminée par le NUMÉRO réel (516xxx → « 516 000 »),
  // pas par le nom libre du chéquier (qui n'est qu'une étiquette). Repli sur le nom si besoin.
  _chequeSheetForNumber(num, wb, chequierLabel) {
    const digits = String(num == null ? '' : num).replace(/\D/g, '');
    if (digits.length >= 3) { const pre = digits.slice(0, 3); const hit = wb.find(s => String(s.name).replace(/\D/g, '').startsWith(pre)); if (hit) return hit.name; }
    return this._chequeSheetName(chequierLabel, wb); // repli : étiquette du chéquier
  }
  // Localise la ligne où NUMERO == n° du chèque (toutes les zones côte à côte), et repère
  // les colonnes DATE / DESCRIPTION / MONTANT de la même zone. N'écrit rien ; lit seulement.
  _locateChequeRow(wb, sheetName, chequeNum) {
    const sh = wb.find(s => s.name === sheetName); if (!sh) throw new Error(`feuille « ${sheetName} » introuvable`);
    const rows = sh.rows; const U = c => String(c == null ? '' : c).trim().toUpperCase();
    let hi = -1; for (let r = 0; r < Math.min(rows.length, 10); r++) { if ((rows[r] || []).some(c => U(c) === 'NUMERO')) { hi = r; break; } }
    if (hi < 0) throw new Error(`en-tête « NUMERO » introuvable dans « ${sheetName} »`);
    const hdr = rows[hi]; const zones = [];
    for (let c = 0; c < hdr.length; c++) { if (U(hdr[c]) === 'NUMERO') { const z = { num: c, date: -1, desc: -1, mont: -1, paie: -1, etat: -1, obs: -1 }; for (let k = c + 1; k < hdr.length; k++) { const l = U(hdr[k]); if (l === 'NUMERO') break; if (l === 'DATE' && z.date < 0) z.date = k; else if (l === 'DESCRIPTION' && z.desc < 0) z.desc = k; else if (l === 'MONTANT' && z.mont < 0) z.mont = k; else if (l === 'PAIEMENT' && z.paie < 0) z.paie = k; else if (l === 'ETAT' && z.etat < 0) z.etat = k; else if (l === 'OBS' && z.obs < 0) z.obs = k; } zones.push(z); } }
    if (!zones.length) throw new Error(`aucune colonne « NUMERO » dans « ${sheetName} »`);
    const want = this._vNum(chequeNum);
    // Les lignes vierges (numéro pas encore utilisé) sont naturellement ignorées ici (v==='' ne
    // correspond jamais à `want`) — la recherche continue jusqu'à la fin de la feuille.
    for (let r = hi + 1; r < rows.length; r++) { for (const z of zones) { const v = rows[r][z.num]; if (v !== '' && v != null && this._vNum(v) === want) return { previewIdx: r, excelRow: r + 1, dateCol: z.date, descCol: z.desc, montCol: z.mont, paieCol: z.paie, etatCol: z.etat, obsCol: z.obs }; } }
    throw new Error(`le numéro de chèque ${chequeNum} n'existe pas (imprimé) dans la feuille « ${sheetName} »`);
  }
  // Prépare l'aperçu de complétion de la ligne du chèque, DANS LE FICHIER PÊCHEUR (source « operations »).
  // Déclenché seulement après une écriture d'achat réussie. Aucune écriture ici : juste l'aperçu.
  async requestChequePreview(rec) {
    // RÈGLE 8/13 : toute sortie en échec marque l'étape « chèque » et laisse le stock s'enchaîner.
    const chequeFailed = (txt) => { this.setState({ msg: { kind: 'error', text: txt } }); if (this._achatSteps) this._achatSteps.cheque = 'fail'; this._runNextWrite(); this._maybeFinalizeAchat(); };
    const hi = this._writableHandleFor('operations');
    if (!hi || !hi.handle) return chequeFailed(`Chèque n° ${rec.chequeNum} non complété : fichier « ${this.writeSourceLabel('operations')} » non connecté.`);
    const colName = n => { let s = '', m = n; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; };
    try {
      const okPerm = await this._ensureWritePermission(hi.handle); if (!okPerm) return chequeFailed(`Chèque n° ${rec.chequeNum} non complété : autorisation d'écriture refusée.`);
      const file = await hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const wb = await this.readWorkbook(buf);
      const sheetName = this._chequeSheetForNumber(rec.chequeNum, wb, rec.chequier);
      if (!sheetName) return chequeFailed(`Chèque n° ${rec.chequeNum} non complété : aucune feuille ne correspond à la série « ${String(rec.chequeNum).replace(/\D/g, '').slice(0, 3)} » dans ce fichier.`);
      const loc = this._locateChequeRow(wb, sheetName, rec.chequeNum);
      const serial = this._excelSerial(rec.date);
      const desc = rec.pecheur || '';
      const obs = this._chequeObsText(1, 1, rec.num || '');
      const colVals = {}; const preview = [];
      if (loc.dateCol >= 0) { colVals[loc.dateCol] = serial != null ? serial : (rec.date || ''); preview.push({ label: 'Date', col: colName(loc.dateCol + 1), value: this._isoToFr(rec.date) }); }
      if (loc.descCol >= 0) { colVals[loc.descCol] = desc; preview.push({ label: 'Description', col: colName(loc.descCol + 1), value: desc }); }
      if (loc.montCol >= 0) { colVals[loc.montCol] = rec.total; preview.push({ label: 'Montant', col: colName(loc.montCol + 1), value: this.fmt(rec.total) }); }
      if (loc.obsCol >= 0) { colVals[loc.obsCol] = obs; preview.push({ label: 'Obs', col: colName(loc.obsCol + 1), value: obs }); }
      // Paiement immédiat coché (mode chèque) : le chèque est encaissé dès la saisie de l'achat.
      if (rec.paiementImmediat) {
        if (loc.paieCol >= 0) { colVals[loc.paieCol] = rec.total; preview.push({ label: 'Paiement', col: colName(loc.paieCol + 1), value: this.fmt(rec.total) }); }
        if (loc.etatCol >= 0) { colVals[loc.etatCol] = 'PAYE'; preview.push({ label: 'Etat', col: colName(loc.etatCol + 1), value: 'PAYE' }); }
      }
      if (!preview.length) return chequeFailed(`Chèque non complété : colonnes Date/Description/Montant introuvables dans « ${sheetName} ».`);
      this._pendingWrite = { kind: 'operations', buf, handle: hi.handle, name: hi.name, fingerprint, sheetName, excelRow: loc.excelRow, previewIdx: loc.previewIdx, mode: 'patch', colVals, refuseFormula: true, after: () => { this._runNextWrite(); this._refreshChequiersLive(); }, step: 'cheque' };
      this.setState({ writePreview: { kind: 'cheque', fileName: hi.name, sheetName, excelRow: loc.excelRow, rows: preview, status: null, title: `Chèque n° ${rec.chequeNum} — feuille « ${sheetName} », ligne ${loc.excelRow}` } });
    } catch (e) {
      chequeFailed(`Chèque n° ${rec.chequeNum} non complété : ${(e && e.message) || 'erreur'}. Vérifiez le numéro ou complétez la ligne à la main.`);
    }
  }

  paiementDefault() { return { ref: '', pecheur: '', mode: 'virement', montant: '', chequier: '', chequeNum: '', observation: '' }; }
  setPaiementField(k, v) {
    const d = this.state.paiementDraft || this.paiementDefault(); const patch = { ...d, [k]: v };
    if (k === 'mode' && v === 'cheque') { const first = this.chequierRows()[0]; if (first && !patch.chequier) { patch.chequier = first.nom; patch.chequeNum = String(first.next || ''); } }
    if (k === 'chequier') { const cq = this.chequierRows().find(c => c.nom === v); if (cq) patch.chequeNum = String(cq.next || ''); }
    this.setState({ paiementDraft: patch });
  }
  selectPaiementAchat(row) { this.setState({ paiementDraft: { ...this.paiementDefault(), ref: row.ref, pecheur: row.partner }, chqEditDraft: null, chqAddDraft: null, chqLiveStatus: null }); this._refreshChqLiveStatus(row.ref); }
  // Lit RÉELLEMENT le chéquier (une ligne par numéro trouvé dans la colonne Chèque, séparateur
  // « / ») pour savoir si PAIEMENT est déjà rempli — bien plus fiable que déduire « encaissé »
  // du solde de la facture (un chèque peut être encaissé, un autre non, sur la même facture).
  async _refreshChqLiveStatus(ref) {
    const s = this._paiementOpsSetup(); if (!s) { this.setState({ chqLiveStatus: { ref, checked: true, cheques: [] } }); return; }
    try {
      const file = await s.hi.handle.getFile();
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ chqLiveStatus: { ref, checked: true, cheques: [] } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(x => x.name === s.sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const chequeRaw = String(row[s.chequeCol] == null ? '' : row[s.chequeCol]).trim();
      const tokens = this._chequeNumTokens(chequeRaw);
      if (!tokens) { if ((this.state.paiementDraft || {}).ref === ref) this.setState({ chqLiveStatus: { ref, checked: true, cheques: [] } }); return; }
      const cheques = tokens.map(num => {
        try {
          const chequeSheetName = this._chequeSheetForNumber(num, wb);
          if (!chequeSheetName) return { num, montant: null, encaisse: false, introuvable: true };
          const cLoc = this._locateChequeRow(wb, chequeSheetName, num);
          const cSh = wb.find(x => x.name === chequeSheetName);
          const cRow = (cSh && cSh.rows[cLoc.previewIdx]) || [];
          const montant = cLoc.montCol >= 0 ? this._vNum(cRow[cLoc.montCol]) : null;
          const paye = cLoc.paieCol >= 0 ? this._vNum(cRow[cLoc.paieCol]) : 0;
          return { num, montant, encaisse: paye > 0.005 };
        } catch (e) { return { num, montant: null, encaisse: false, introuvable: true }; }
      });
      // Toujours re-vérifier que la sélection n'a pas changé pendant la lecture asynchrone.
      if ((this.state.paiementDraft || {}).ref !== ref) return;
      this.setState({ chqLiveStatus: { ref, checked: true, cheques } });
    } catch (e) {
      this.setState({ chqLiveStatus: { ref, checked: true, cheques: [] } });
    }
  }
  // Ajouter un moyen de paiement (toujours disponible, encaissé ou non) : même choix que le
  // formulaire d'achat pêcheur — Chèque / Virement / Espèces / Autre. « Chèque » réutilise
  // l'écriture chéquier complète (requestChq2Preview) ; les 3 autres ajoutent seulement au
  // Total payé / Solde (et à la colonne Chèque pour « Autre », comme observation).
  chqAddDefault() { const first = this.chequierRows()[0]; return { mode: 'cheque', chequier: first ? first.nom : '', chequeNum: first ? String(first.next || '') : '', montant: '', observation: '' }; }
  openChqAdd(ref) { this.setState({ chqAddDraft: { ref, ...this.chqAddDefault() } }); }
  setChqAddField(k, v) {
    const d = this.state.chqAddDraft; if (!d) return; const patch = { ...d, [k]: v };
    if (k === 'chequier') { const cq = this.chequierRows().find(c => c.nom === v); if (cq) patch.chequeNum = String(cq.next || ''); }
    if (k === 'mode' && v === 'cheque') { const first = this.chequierRows()[0]; if (first && !patch.chequier) { patch.chequier = first.nom; patch.chequeNum = String(first.next || ''); } }
    this.setState({ chqAddDraft: patch });
  }
  cancelChqAdd() { this.setState({ chqAddDraft: null }); }
  commitChqAdd() {
    const d = this.state.chqAddDraft; if (!d || !d.ref) return;
    if (d.mode === 'cheque') {
      if (!d.chequier || !d.chequeNum) { this.setState({ msg: { kind: 'error', text: 'Choisissez un chéquier et un numéro de chèque.' } }); return; }
      if (!(this._vNum(d.montant) > 0)) { this.setState({ msg: { kind: 'error', text: 'Indiquez le montant du chèque.' } }); return; }
      const pd = this.state.paiementDraft;
      this.requestChq2Preview(d.ref, d.chequier, d.chequeNum, this._vNum(d.montant), pd ? pd.pecheur : '');
      return;
    }
    const montant = this._vNum(d.montant);
    if (!(montant > 0)) { this.setState({ msg: { kind: 'error', text: 'Indiquez le montant.' } }); return; }
    if (d.mode === 'autre' && !(d.observation || '').trim()) { this.setState({ msg: { kind: 'error', text: 'Indiquez une observation (ex. BB, accord verbal…) pour le moyen de paiement « Autre ».' } }); return; }
    this.requestChqComplementPreview(d.ref, montant, d.mode === 'autre' ? (d.observation || '').trim() : null);
  }
  // Écrit le complément dans Total payé/Solde (et ajoute une observation à la colonne Chèque
  // si fournie, mode « Autre »). N'écrit rien dans le chéquier.
  async requestChqComplementPreview(ref, montant, appendText) {
    const s = this._paiementOpsSetup(); if (!s) return;
    if (s.paidCol == null || s.paidCol < 0) { this.setState({ msg: { kind: 'error', text: 'Colonne « Total payé » non réglée — impossible d’enregistrer le complément.' } }); return; }
    try {
      const okPerm = await this._ensureWritePermission(s.hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${s.hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await s.hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${s.sheetName} » — actualisez puis réessayez.` } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(x => x.name === s.sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const montantTotal = this._vNum(s.amtCol != null && s.amtCol >= 0 ? row[s.amtCol] : 0);
      const dejaPaye = this._vNum(s.paidCol != null && s.paidCol >= 0 ? row[s.paidCol] : 0);
      const soldeActuel = (s.soldeCol != null && s.soldeCol >= 0 && row[s.soldeCol] !== '' && row[s.soldeCol] != null) ? this._vNum(row[s.soldeCol]) : Math.max(0, montantTotal - dejaPaye);
      if (montant > soldeActuel + 0.01) { this.setState({ msg: { kind: 'error', text: `Le montant saisi (${this.fmt(montant)}) dépasse le solde restant (${this.fmt(soldeActuel)}).` } }); return; }
      const nouveauPaye = Math.round((dejaPaye + montant) * 100) / 100;
      const nouveauSolde = Math.max(0, Math.round((soldeActuel - montant) * 100) / 100);
      const serial = this._excelSerial(this._payTodayIso());
      const colVals = { [s.paidCol]: nouveauPaye };
      const preview = [{ label: 'Total payé', col: this._colLetter(s.paidCol + 1), value: this.fmt(nouveauPaye) }];
      if (s.paidDateCol != null && s.paidDateCol >= 0) { colVals[s.paidDateCol] = serial; preview.push({ label: 'Date de paiement', col: this._colLetter(s.paidDateCol + 1), value: this._isoToFr(this._payTodayIso()) }); }
      if (s.soldeCol != null && s.soldeCol >= 0) { colVals[s.soldeCol] = nouveauSolde; preview.push({ label: 'Solde', col: this._colLetter(s.soldeCol + 1), value: this.fmt(nouveauSolde) }); }
      if (appendText) {
        const chequeRaw = String(row[s.chequeCol] == null ? '' : row[s.chequeCol]).trim();
        const newChq = chequeRaw ? `${chequeRaw} / ${appendText}` : appendText;
        colVals[s.chequeCol] = newChq;
        preview.push({ label: 'Chèque', col: this._colLetter(s.chequeCol + 1), value: newChq });
      }
      const allowFormulaCols = s.soldeCol != null && s.soldeCol >= 0 ? { [s.sheetName]: new Set([s.soldeCol]) } : null;
      this._pendingWrite = { kind: 'operations', buf, handle: s.hi.handle, name: s.hi.name, fingerprint, sheetName: s.sheetName, excelRow: loc.excelRow, previewIdx: loc.previewIdx, mode: 'patch', colVals, refuseFormula: true, allowFormulaCols, after: () => { this.setState({ chqAddDraft: null, msg: { kind: 'ok', text: `Paiement complémentaire enregistré pour la facture ${ref}.` } }); this._refreshChqLiveStatus(ref); } };
      this.setState({ writePreview: { kind: 'chqmodif', fileName: s.hi.name, sheetName: s.sheetName, excelRow: loc.excelRow, rows: preview, status: null, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  // Édition ✏️ du contenu déjà présent dans la colonne Chèque (cas virement/texte uniquement —
  // un ou plusieurs vrais numéros de chèque se gèrent ligne par ligne, Encaisser/Annuler).
  openChqEdit(ref, val) { this.setState({ chqEditDraft: { ref, val: val || '' } }); }
  setChqEditVal(v) { const d = this.state.chqEditDraft; if (!d) return; this.setState({ chqEditDraft: { ...d, val: v } }); }
  cancelChqEdit() { this.setState({ chqEditDraft: null }); }
  commitChqEdit() { const d = this.state.chqEditDraft; if (!d || !d.ref) return; this.requestChequeModifPreview(d.ref, d.val); }
  // Filtres et tri de la liste des factures pêcheurs (module Paiement) — filtres cumulables
  // (boutons toggle indépendants, combinés en ET) ; « Toutes » désactive tous les autres.
  setPaiementFilter(f) {
    if (f === 'toutes') { this.setState({ paiementFilters: [] }); return; }
    const cur = this.state.paiementFilters || [];
    const next = cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f];
    this.setState({ paiementFilters: next });
  }
  setPaiementSort(key) { const s = this.state.paiementSort || { key: 'ref', dir: 'asc' }; this.setState({ paiementSort: s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' } }); }
  // Annulation d'un chèque : demande de confirmation en deux temps (question rapide, puis
  // l'aperçu détaillé habituel avant toute écriture réelle), et proposition de remplacement après coup.
  askChequeAnnule(ref, chequeNum) { this.setState({ chqAnnuleConfirm: { ref, chequeNum } }); }
  cancelChequeAnnuleAsk() { this.setState({ chqAnnuleConfirm: null }); }
  confirmChequeAnnuleAsk() { const c = this.state.chqAnnuleConfirm; if (!c) return; this.setState({ chqAnnuleConfirm: null }); this.requestChequeAnnulePreview(c.ref, c.chequeNum); }
  dismissChqReplaceAsk(keep) { this.setState({ chqAnnuleReplaceAsk: null, ...(keep ? {} : { paiementDraft: null, chqLiveStatus: null, chqAddDraft: null }) }); }
  // Paiement a posteriori d'un achat pêcheur déjà enregistré : écriture atomique multi-feuilles
  // (ligne « operations » + ligne chéquier correspondante si mode chèque). Réutilise l'infra
  // existante (_locateRowByRef, patchXlsxFile multi-feuilles, _backupBeforeWrite via confirmAppendWrite).
  async requestAchatPaiementPreview() {
    const pd = this.state.paiementDraft;
    if (!pd || !pd.ref) { this.setState({ msg: { kind: 'error', text: 'Sélectionnez d’abord une facture pêcheur à payer.' } }); return; }
    const cfg = this.writeMapFor('operations');
    if (!cfg || !cfg.enabled || !cfg.cols) { this.setState({ msg: { kind: 'error', text: `Écriture non réglée pour « ${this.writeSourceLabel('operations')} » — réglez-la dans Paramètres.` } }); return; }
    const colsMap = cfg.cols; const sheetName = cfg.sheetName; const firstDataIdx = cfg.firstDataIdx || 0;
    const refCol = colsMap.ref, amtCol = colsMap.amt, paidCol = colsMap.paid, paidDateCol = colsMap.paidDate, soldeCol = colsMap.solde, chequeCol = colsMap.cheque;
    if (refCol == null || refCol < 0) { this.setState({ msg: { kind: 'error', text: 'Colonne « N° de facture » non réglée — impossible de retrouver la ligne.' } }); return; }
    if (paidCol == null || paidCol < 0) { this.setState({ msg: { kind: 'error', text: 'Colonne « Total payé » non réglée dans Paramètres → Régler l’écriture.' } }); return; }
    const hi = this._writableHandleFor('operations');
    if (!hi || !hi.handle) { this.setState({ msg: { kind: 'error', text: `Fichier « ${cfg.fileName || this.writeSourceLabel('operations')} » non connecté.` } }); return; }
    const mode = pd.mode || 'virement';
    if (mode === 'cheque' && (!pd.chequier || !pd.chequeNum)) { this.setState({ msg: { kind: 'error', text: 'Choisissez un chéquier et un numéro de chèque.' } }); return; }
    if (mode === 'autre' && !(pd.observation || '').trim()) { this.setState({ msg: { kind: 'error', text: 'Indiquez une observation (ex. BB, accord verbal…) pour le moyen de paiement « Autre ».' } }); return; }
    try {
      const okPerm = await this._ensureWritePermission(hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, sheetName, refCol, pd.ref, firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${pd.ref} » introuvable dans « ${sheetName} » — actualisez puis réessayez.` } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(s => s.name === sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const montantTotal = this._vNum(amtCol != null && amtCol >= 0 ? row[amtCol] : 0);
      const dejaPaye = this._vNum(paidCol != null && paidCol >= 0 ? row[paidCol] : 0);
      const soldeActuel = (soldeCol != null && soldeCol >= 0 && row[soldeCol] !== '' && row[soldeCol] != null) ? this._vNum(row[soldeCol]) : Math.max(0, montantTotal - dejaPaye);
      let montantPaye;
      if (mode === 'partiel') {
        montantPaye = this._vNum(pd.montant);
        if (!(montantPaye > 0)) { this.setState({ msg: { kind: 'error', text: 'Indiquez un montant partiel supérieur à 0.' } }); return; }
        if (montantPaye > soldeActuel + 0.01) { this.setState({ msg: { kind: 'error', text: `Le montant saisi (${this.fmt(montantPaye)}) dépasse le solde restant (${this.fmt(soldeActuel)}).` } }); return; }
      } else {
        montantPaye = soldeActuel; // comptant / virement / chèque : solde soldé intégralement
      }
      const nouveauSolde = Math.max(0, Math.round((soldeActuel - montantPaye) * 100) / 100);
      const nouveauPaye = Math.round((dejaPaye + montantPaye) * 100) / 100;
      const serial = this._excelSerial(this._payTodayIso());
      const editsBySheet = {}; const verifyTargets = []; const preview = [];
      const colName = n => this._colLetter(n + 1);
      editsBySheet[sheetName] = {};
      editsBySheet[sheetName][loc.previewIdx + ':' + paidCol] = nouveauPaye;
      verifyTargets.push({ sheetName, rowIdx: loc.previewIdx, col: paidCol, val: nouveauPaye });
      preview.push({ label: 'Total payé', col: colName(paidCol), value: this.fmt(nouveauPaye) });
      if (paidDateCol != null && paidDateCol >= 0) {
        editsBySheet[sheetName][loc.previewIdx + ':' + paidDateCol] = serial;
        verifyTargets.push({ sheetName, rowIdx: loc.previewIdx, col: paidDateCol, val: serial });
        preview.push({ label: 'Date de paiement', col: colName(paidDateCol), value: this._isoToFr(this._payTodayIso()) });
      }
      if (soldeCol != null && soldeCol >= 0) {
        editsBySheet[sheetName][loc.previewIdx + ':' + soldeCol] = nouveauSolde;
        verifyTargets.push({ sheetName, rowIdx: loc.previewIdx, col: soldeCol, val: nouveauSolde });
        preview.push({ label: 'Solde', col: colName(soldeCol), value: this.fmt(nouveauSolde) });
      }
      if (mode === 'autre' && chequeCol != null && chequeCol >= 0) {
        const observation = (pd.observation || '').trim();
        editsBySheet[sheetName][loc.previewIdx + ':' + chequeCol] = observation;
        verifyTargets.push({ sheetName, rowIdx: loc.previewIdx, col: chequeCol, val: observation });
        preview.push({ label: 'Chèque (observation)', col: colName(chequeCol), value: observation });
      }
      let chequeSheetName = null;
      if (mode === 'cheque') {
        if (chequeCol != null && chequeCol >= 0) {
          editsBySheet[sheetName][loc.previewIdx + ':' + chequeCol] = pd.chequeNum;
          verifyTargets.push({ sheetName, rowIdx: loc.previewIdx, col: chequeCol, val: pd.chequeNum });
          preview.push({ label: 'N° de chèque', col: colName(chequeCol), value: String(pd.chequeNum) });
        }
        chequeSheetName = this._chequeSheetForNumber(pd.chequeNum, wb, pd.chequier);
        if (!chequeSheetName) { this.setState({ msg: { kind: 'error', text: `Aucune feuille ne correspond au chéquier « ${pd.chequier} » pour le n° ${pd.chequeNum}.` } }); return; }
        let cLoc;
        try { cLoc = this._locateChequeRow(wb, chequeSheetName, pd.chequeNum); }
        catch (e) { this.setState({ msg: { kind: 'error', text: e.message } }); return; }
        const desc = pd.pecheur || '';
        const obs = this._chequeObsText(1, 1, pd.ref || '');
        editsBySheet[chequeSheetName] = editsBySheet[chequeSheetName] || {};
        if (cLoc.dateCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.dateCol] = serial; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.dateCol, val: serial }); preview.push({ label: 'Chéquier — Date', col: colName(cLoc.dateCol), value: this._isoToFr(this._payTodayIso()) }); }
        if (cLoc.descCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.descCol] = desc; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.descCol, val: desc }); preview.push({ label: 'Chéquier — Description', col: colName(cLoc.descCol), value: desc }); }
        if (cLoc.montCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.montCol] = montantPaye; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.montCol, val: montantPaye }); preview.push({ label: 'Chéquier — Montant', col: colName(cLoc.montCol), value: this.fmt(montantPaye) }); }
        if (cLoc.paieCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.paieCol] = montantPaye; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.paieCol, val: montantPaye }); preview.push({ label: 'Chéquier — Paiement', col: colName(cLoc.paieCol), value: this.fmt(montantPaye) }); }
        if (cLoc.etatCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.etatCol] = 'PAYE'; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.etatCol, val: 'PAYE' }); preview.push({ label: 'Chéquier — Etat', col: colName(cLoc.etatCol), value: 'PAYE' }); }
        if (cLoc.obsCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.obsCol] = obs; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.obsCol, val: obs }); preview.push({ label: 'Chéquier — Obs', col: colName(cLoc.obsCol), value: obs }); }
      }
      const allowFormulaCols = soldeCol != null && soldeCol >= 0 ? { [sheetName]: new Set([soldeCol]) } : null;
      this._pendingWrite = { kind: 'operations', buf, handle: hi.handle, name: hi.name, fingerprint, sheetName: chequeSheetName ? `${sheetName}, ${chequeSheetName}` : sheetName, editsBySheet, verifyTargets, refuseFormula: true, allowFormulaCols, after: () => this._paiementAfterWrite(pd.ref) };
      this.setState({ writePreview: { kind: 'paiement', fileName: hi.name, sheetName: chequeSheetName ? `${sheetName} + ${chequeSheetName}` : sheetName, rows: preview, status: null, refLabel: pd.ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation du paiement impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  _paiementAfterWrite(ref) { this.setState({ paiementDraft: null, msg: { kind: 'ok', text: `Paiement enregistré pour la facture ${ref}.` } }); }
  // Prépare les réglages/handle communs aux actions du module Paiement pêcheur (Encaissé/Annuler/Modifier).
  // Retourne null (et affiche l'erreur) si quoi que ce soit manque.
  _paiementOpsSetup() {
    const cfg = this.writeMapFor('operations');
    if (!cfg || !cfg.enabled || !cfg.cols) { this.setState({ msg: { kind: 'error', text: `Écriture non réglée pour « ${this.writeSourceLabel('operations')} » — réglez-la dans Paramètres.` } }); return null; }
    const colsMap = cfg.cols; const sheetName = cfg.sheetName; const firstDataIdx = cfg.firstDataIdx || 0;
    const refCol = colsMap.ref, amtCol = colsMap.amt, paidCol = colsMap.paid, paidDateCol = colsMap.paidDate, soldeCol = colsMap.solde, chequeCol = colsMap.cheque;
    if (refCol == null || refCol < 0) { this.setState({ msg: { kind: 'error', text: 'Colonne « N° de facture » non réglée — impossible de retrouver la ligne.' } }); return null; }
    if (chequeCol == null || chequeCol < 0) { this.setState({ msg: { kind: 'error', text: 'Colonne « N° de chèque » non réglée — réglez-la dans Paramètres → Régler l’écriture.' } }); return null; }
    const hi = this._writableHandleFor('operations');
    if (!hi || !hi.handle) { this.setState({ msg: { kind: 'error', text: `Fichier « ${cfg.fileName || this.writeSourceLabel('operations')} » non connecté.` } }); return null; }
    return { sheetName, firstDataIdx, refCol, amtCol, paidCol, paidDateCol, soldeCol, chequeCol, hi };
  }
  // Bouton « Encaissé » (chèque déjà détecté dans la colonne Chèque) : écrit Paiement/État « PAYE »
  // sur la ligne déjà imprimée du chéquier (Date/Description/Montant y sont déjà, saisis à l'achat),
  // et solde la facture pêcheur (Total payé = montant, Solde = 0, Date de paiement = aujourd'hui).
  // Somme des montants déjà encaissés (colonne PAIEMENT remplie) parmi une liste de numéros de
  // chèque, en excluant `excludeNum` (dont on fournit le nouveau statut via excludeAmount/excludeOn).
  _sommeChequesEncaisses(wb, tokens, excludeNum, excludeAmount, excludeOn) {
    let somme = 0;
    for (const num of tokens) {
      if (String(num) === String(excludeNum)) { if (excludeOn) somme += excludeAmount || 0; continue; }
      try {
        const sheetName = this._chequeSheetForNumber(num, wb);
        const cLoc = this._locateChequeRow(wb, sheetName, num);
        const cRow = wb.find(x => x.name === sheetName).rows[cLoc.previewIdx] || [];
        const paye = cLoc.paieCol >= 0 ? this._vNum(cRow[cLoc.paieCol]) : 0;
        if (paye > 0.005) somme += cLoc.montCol >= 0 ? this._vNum(cRow[cLoc.montCol]) : paye;
      } catch (e) { /* chèque introuvable — ignoré dans la somme */ }
    }
    return Math.round(somme * 100) / 100;
  }
  // « Encaissé » pour UN chèque précis (une facture peut en avoir plusieurs) : Total payé/Solde
  // recalculés comme la somme de tous les chèques réellement encaissés, pas soldés d'un bloc.
  async requestChequeEncaissePreview(ref, chequeNum) {
    const s = this._paiementOpsSetup(); if (!s) return;
    try {
      const okPerm = await this._ensureWritePermission(s.hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${s.hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await s.hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${s.sheetName} » — actualisez puis réessayez.` } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(x => x.name === s.sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const montantTotal = this._vNum(s.amtCol != null && s.amtCol >= 0 ? row[s.amtCol] : 0);
      const chequeRaw = String(row[s.chequeCol] == null ? '' : row[s.chequeCol]).trim();
      const tokens = this._chequeNumTokens(chequeRaw);
      if (!tokens || tokens.indexOf(String(chequeNum)) < 0) { this.setState({ msg: { kind: 'error', text: `Le chèque n°${chequeNum} n'est plus enregistré pour la facture ${ref} — actualisez puis réessayez.` } }); return; }
      const chequeSheetName = this._chequeSheetForNumber(chequeNum, wb);
      if (!chequeSheetName) { this.setState({ msg: { kind: 'error', text: `Aucune feuille chéquier ne correspond au n° ${chequeNum}.` } }); return; }
      let cLoc; try { cLoc = this._locateChequeRow(wb, chequeSheetName, chequeNum); }
      catch (e) { this.setState({ msg: { kind: 'error', text: e.message } }); return; }
      const cRow = wb.find(x => x.name === chequeSheetName).rows[cLoc.previewIdx] || [];
      const montantChq = cLoc.montCol >= 0 ? this._vNum(cRow[cLoc.montCol]) : 0;
      const nouveauPaye = Math.min(montantTotal, this._sommeChequesEncaisses(wb, tokens, chequeNum, montantChq, true));
      const nouveauSolde = Math.max(0, Math.round((montantTotal - nouveauPaye) * 100) / 100);
      const serial = this._excelSerial(this._payTodayIso());
      const editsBySheet = {}; const verifyTargets = []; const preview = [];
      const colName = n => this._colLetter(n + 1);
      editsBySheet[s.sheetName] = {};
      if (s.paidCol != null && s.paidCol >= 0) { editsBySheet[s.sheetName][loc.previewIdx + ':' + s.paidCol] = nouveauPaye; verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.paidCol, val: nouveauPaye }); preview.push({ label: 'Total payé', col: colName(s.paidCol), value: this.fmt(nouveauPaye) }); }
      if (s.soldeCol != null && s.soldeCol >= 0) { editsBySheet[s.sheetName][loc.previewIdx + ':' + s.soldeCol] = nouveauSolde; verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.soldeCol, val: nouveauSolde }); preview.push({ label: 'Solde', col: colName(s.soldeCol), value: this.fmt(nouveauSolde) }); }
      if (s.paidDateCol != null && s.paidDateCol >= 0) { editsBySheet[s.sheetName][loc.previewIdx + ':' + s.paidDateCol] = serial; verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.paidDateCol, val: serial }); preview.push({ label: 'Date de paiement', col: colName(s.paidDateCol), value: this._isoToFr(this._payTodayIso()) }); }
      editsBySheet[chequeSheetName] = editsBySheet[chequeSheetName] || {};
      if (cLoc.paieCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.paieCol] = montantChq; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.paieCol, val: montantChq }); preview.push({ label: `Chéquier n°${chequeNum} — Paiement`, col: colName(cLoc.paieCol), value: this.fmt(montantChq) }); }
      if (cLoc.etatCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.etatCol] = 'PAYE'; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.etatCol, val: 'PAYE' }); preview.push({ label: `Chéquier n°${chequeNum} — Etat`, col: colName(cLoc.etatCol), value: 'PAYE' }); }
      const allowFormulaCols = s.soldeCol != null && s.soldeCol >= 0 ? { [s.sheetName]: new Set([s.soldeCol]) } : null;
      this._pendingWrite = { kind: 'operations', buf, handle: s.hi.handle, name: s.hi.name, fingerprint, sheetName: `${s.sheetName}, ${chequeSheetName}`, editsBySheet, verifyTargets, refuseFormula: true, allowFormulaCols, after: () => { this.setState({ msg: { kind: 'ok', text: `Chèque n°${chequeNum} de la facture ${ref} marqué encaissé.` } }); this._refreshChqLiveStatus(ref); } };
      this.setState({ writePreview: { kind: 'encaisse', fileName: s.hi.name, sheetName: `${s.sheetName} + ${chequeSheetName}`, rows: preview, status: null, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  // « Confirmer encaissement virement » (colonne Chèque contient « BB ») : pas de chéquier à
  // compléter, on solde simplement la facture pêcheur.
  async requestVirementConfirmPreview(ref) {
    const s = this._paiementOpsSetup(); if (!s) return;
    try {
      const okPerm = await this._ensureWritePermission(s.hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${s.hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await s.hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${s.sheetName} » — actualisez puis réessayez.` } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(x => x.name === s.sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const montantTotal = this._vNum(s.amtCol != null && s.amtCol >= 0 ? row[s.amtCol] : 0);
      const serial = this._excelSerial(this._payTodayIso());
      const colVals = {}; const preview = [];
      const colName = n => this._colLetter(n + 1);
      if (s.paidCol != null && s.paidCol >= 0) { colVals[s.paidCol] = montantTotal; preview.push({ label: 'Total payé', col: colName(s.paidCol), value: this.fmt(montantTotal) }); }
      if (s.soldeCol != null && s.soldeCol >= 0) { colVals[s.soldeCol] = 0; preview.push({ label: 'Solde', col: colName(s.soldeCol), value: this.fmt(0) }); }
      if (s.paidDateCol != null && s.paidDateCol >= 0) { colVals[s.paidDateCol] = serial; preview.push({ label: 'Date de paiement', col: colName(s.paidDateCol), value: this._isoToFr(this._payTodayIso()) }); }
      const allowFormulaCols = s.soldeCol != null && s.soldeCol >= 0 ? { [s.sheetName]: new Set([s.soldeCol]) } : null;
      this._pendingWrite = { kind: 'operations', buf, handle: s.hi.handle, name: s.hi.name, fingerprint, sheetName: s.sheetName, excelRow: loc.excelRow, previewIdx: loc.previewIdx, mode: 'patch', colVals, refuseFormula: true, allowFormulaCols, after: () => { this.setState({ msg: { kind: 'ok', text: `Virement de la facture ${ref} confirmé — facture soldée.` } }); this._refreshChqLiveStatus(ref); } };
      this.setState({ writePreview: { kind: 'encaisse', fileName: s.hi.name, sheetName: s.sheetName, excelRow: loc.excelRow, rows: preview, status: null, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  // Bouton « Annuler » (chèque déjà détecté) : écrit « CANCELLED » sur Date/Description/Montant/Paiement
  // de la ligne du chéquier, et remet la facture pêcheur à zéro (Total payé = 0, Solde = montant initial).
  // Annule UN chèque précis (parmi éventuellement plusieurs) : CANCELLED sur sa ligne chéquier,
  // retiré de la colonne Chèque, OBS des chèques restants renumérotée, Total payé/Solde recalculés
  // sur les chèques restants réellement encaissés (pas remis à zéro d'un bloc).
  async requestChequeAnnulePreview(ref, chequeNum) {
    const s = this._paiementOpsSetup(); if (!s) return;
    try {
      const okPerm = await this._ensureWritePermission(s.hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${s.hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await s.hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${s.sheetName} » — actualisez puis réessayez.` } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(x => x.name === s.sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const montantTotal = this._vNum(s.amtCol != null && s.amtCol >= 0 ? row[s.amtCol] : 0);
      const chequeRaw = String(row[s.chequeCol] == null ? '' : row[s.chequeCol]).trim();
      const tokens = this._chequeNumTokens(chequeRaw);
      if (!tokens || tokens.indexOf(String(chequeNum)) < 0) { this.setState({ msg: { kind: 'error', text: `Le chèque n°${chequeNum} n'est plus enregistré pour la facture ${ref} — actualisez puis réessayez.` } }); return; }
      const chequeSheetName = this._chequeSheetForNumber(chequeNum, wb);
      if (!chequeSheetName) { this.setState({ msg: { kind: 'error', text: `Aucune feuille chéquier ne correspond au n° ${chequeNum}.` } }); return; }
      let cLoc; try { cLoc = this._locateChequeRow(wb, chequeSheetName, chequeNum); }
      catch (e) { this.setState({ msg: { kind: 'error', text: e.message } }); return; }
      const remaining = tokens.filter(t => String(t) !== String(chequeNum));
      const nouveauPaye = this._sommeChequesEncaisses(wb, remaining, null, 0, false);
      const nouveauSolde = Math.max(0, Math.round((montantTotal - nouveauPaye) * 100) / 100);
      const editsBySheet = {}; const verifyTargets = []; const preview = [];
      const colName = n => this._colLetter(n + 1);
      editsBySheet[s.sheetName] = {};
      if (s.paidCol != null && s.paidCol >= 0) { editsBySheet[s.sheetName][loc.previewIdx + ':' + s.paidCol] = nouveauPaye; verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.paidCol, val: nouveauPaye }); preview.push({ label: 'Total payé', col: colName(s.paidCol), value: this.fmt(nouveauPaye) }); }
      if (s.soldeCol != null && s.soldeCol >= 0) { editsBySheet[s.sheetName][loc.previewIdx + ':' + s.soldeCol] = nouveauSolde; verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.soldeCol, val: nouveauSolde }); preview.push({ label: 'Solde', col: colName(s.soldeCol), value: this.fmt(nouveauSolde) }); }
      // Retire le chèque annulé de la colonne Chèque ; vide entièrement si c'était le seul (remplacement possible).
      const newChq = remaining.join(' / ');
      editsBySheet[s.sheetName][loc.previewIdx + ':' + s.chequeCol] = newChq;
      verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.chequeCol, val: newChq });
      preview.push({ label: 'Chèque', col: colName(s.chequeCol), value: newChq || '(case vidée)' });
      editsBySheet[chequeSheetName] = editsBySheet[chequeSheetName] || {};
      [['dateCol', 'Date'], ['descCol', 'Description'], ['montCol', 'Montant'], ['paieCol', 'Paiement']].forEach(([k, label]) => {
        const col = cLoc[k];
        if (col >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + col] = 'CANCELLED'; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col, val: 'CANCELLED' }); preview.push({ label: `Chéquier n°${chequeNum} — ` + label, col: colName(col), value: 'CANCELLED' }); }
      });
      // Renumérote l'OBS des chèques restants (« Chèque 2/2 » redevient « Chèque 1/1 », etc.).
      remaining.forEach((num, i) => {
        try {
          const exSheetName = this._chequeSheetForNumber(num, wb);
          const exLoc = this._locateChequeRow(wb, exSheetName, num);
          if (exLoc.obsCol >= 0) {
            const exObs = this._chequeObsText(i + 1, remaining.length, ref);
            editsBySheet[exSheetName] = editsBySheet[exSheetName] || {};
            editsBySheet[exSheetName][exLoc.previewIdx + ':' + exLoc.obsCol] = exObs;
            verifyTargets.push({ sheetName: exSheetName, rowIdx: exLoc.previewIdx, col: exLoc.obsCol, val: exObs });
            preview.push({ label: `Chéquier ${num} — Obs`, col: colName(exLoc.obsCol), value: exObs });
          }
        } catch (e) { /* chèque restant introuvable — on ignore, la renumérotation n'est qu'un confort */ }
      });
      const allowFormulaCols = s.soldeCol != null && s.soldeCol >= 0 ? { [s.sheetName]: new Set([s.soldeCol]) } : null;
      this._pendingWrite = { kind: 'operations', buf, handle: s.hi.handle, name: s.hi.name, fingerprint, sheetName: `${s.sheetName}, ${chequeSheetName}`, editsBySheet, verifyTargets, refuseFormula: true, allowFormulaCols, after: () => { this.setState({ chqAnnuleReplaceAsk: !remaining.length ? { ref } : null, msg: { kind: 'ok', text: `Chèque n°${chequeNum} de la facture ${ref} annulé.` } }); this._refreshChqLiveStatus(ref); this._refreshChequiersLive(); } };
      this.setState({ writePreview: { kind: 'chqannule', fileName: s.hi.name, sheetName: `${s.sheetName} + ${chequeSheetName}`, rows: preview, status: null, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  // Bouton ✏️ : remplace le contenu (déjà détecté) de la colonne Chèque par un texte libre.
  async requestChequeModifPreview(ref, newVal) {
    const s = this._paiementOpsSetup(); if (!s) return;
    try {
      const okPerm = await this._ensureWritePermission(s.hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${s.hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await s.hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${s.sheetName} » — actualisez puis réessayez.` } }); return; }
      const val = String(newVal || '').trim();
      const colVals = { [s.chequeCol]: val };
      this._pendingWrite = { kind: 'operations', buf, handle: s.hi.handle, name: s.hi.name, fingerprint, sheetName: s.sheetName, excelRow: loc.excelRow, previewIdx: loc.previewIdx, mode: 'patch', colVals, refuseFormula: true, after: () => this.setState({ chqEditDraft: null, msg: { kind: 'ok', text: `Colonne Chèque de la facture ${ref} modifiée.` } }) };
      this.setState({ writePreview: { kind: 'chqmodif', fileName: s.hi.name, sheetName: s.sheetName, excelRow: loc.excelRow, rows: [{ label: 'Chèque', col: this._colLetter(s.chequeCol + 1), value: val || '(case vidée)' }], status: null, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  // Second chèque pour la même facture : complète la ligne déjà imprimée du chéquier
  // (Date/Description/Montant — Paiement/État restent vides, comme à la saisie d'achat), et
  // ajoute le n° à la colonne Chèque du fichier achat (« n°1 / n°2 ») sans toucher Total payé/Solde.
  async requestChq2Preview(ref, chequier, chequeNum, montant, pecheur) {
    const s = this._paiementOpsSetup(); if (!s) return;
    try {
      const okPerm = await this._ensureWritePermission(s.hi.handle);
      if (!okPerm) { this.setState({ msg: { kind: 'error', text: `Autorisation d'écriture refusée sur « ${s.hi.name} ». Rien n'a été modifié.` } }); return; }
      const file = await s.hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer();
      const loc = await this._locateRowByRef(buf, s.sheetName, s.refCol, ref, s.firstDataIdx);
      if (!loc) { this.setState({ msg: { kind: 'error', text: `Ligne « ${ref} » introuvable dans « ${s.sheetName} » — actualisez puis réessayez.` } }); return; }
      const wb = await this.readWorkbook(buf.slice(0));
      const sh = wb.find(x => x.name === s.sheetName);
      const row = (sh && sh.rows[loc.previewIdx]) || [];
      const chequeRaw = String(row[s.chequeCol] == null ? '' : row[s.chequeCol]).trim();
      // Seuls les jetons numériques (vrais numéros de chèque) de la colonne Chèque comptent pour
      // la numérotation « Chèque X/Y » — un « BB » ou une observation libre n'a pas de ligne chéquier.
      const existingNums = chequeRaw ? chequeRaw.split('/').map(x => x.trim()).filter(x => /^\d+$/.test(x)) : [];
      const newTotal = existingNums.length + 1;
      const chequeSheetName = this._chequeSheetForNumber(chequeNum, wb, chequier);
      if (!chequeSheetName) { this.setState({ msg: { kind: 'error', text: `Aucune feuille ne correspond au chéquier « ${chequier} » pour le n° ${chequeNum}.` } }); return; }
      let cLoc; try { cLoc = this._locateChequeRow(wb, chequeSheetName, chequeNum); }
      catch (e) { this.setState({ msg: { kind: 'error', text: e.message } }); return; }
      const serial = this._excelSerial(this._payTodayIso());
      const desc = pecheur || '';
      const editsBySheet = {}; const verifyTargets = []; const preview = [];
      const colName = n => this._colLetter(n + 1);
      const newChq = chequeRaw ? `${chequeRaw} / ${chequeNum}` : String(chequeNum);
      editsBySheet[s.sheetName] = {};
      editsBySheet[s.sheetName][loc.previewIdx + ':' + s.chequeCol] = newChq;
      verifyTargets.push({ sheetName: s.sheetName, rowIdx: loc.previewIdx, col: s.chequeCol, val: newChq });
      preview.push({ label: 'Chèque', col: colName(s.chequeCol), value: newChq });
      // Renumérote l'OBS des chèques déjà présents (« Chèque 1/1 » devient « Chèque 1/2 », etc.).
      for (let i = 0; i < existingNums.length; i++) {
        const num = existingNums[i];
        try {
          const exSheetName = this._chequeSheetForNumber(num, wb, chequier);
          if (!exSheetName) continue;
          const exLoc = this._locateChequeRow(wb, exSheetName, num);
          if (exLoc.obsCol >= 0) {
            const exObs = this._chequeObsText(i + 1, newTotal, ref);
            editsBySheet[exSheetName] = editsBySheet[exSheetName] || {};
            editsBySheet[exSheetName][exLoc.previewIdx + ':' + exLoc.obsCol] = exObs;
            verifyTargets.push({ sheetName: exSheetName, rowIdx: exLoc.previewIdx, col: exLoc.obsCol, val: exObs });
            preview.push({ label: `Chéquier ${num} — Obs`, col: colName(exLoc.obsCol), value: exObs });
          }
        } catch (e) { /* chèque existant introuvable — on ignore, la renumérotation n'est qu'un confort */ }
      }
      const newObs = this._chequeObsText(newTotal, newTotal, ref);
      editsBySheet[chequeSheetName] = editsBySheet[chequeSheetName] || {};
      if (cLoc.dateCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.dateCol] = serial; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.dateCol, val: serial }); preview.push({ label: 'Chéquier — Date', col: colName(cLoc.dateCol), value: this._isoToFr(this._payTodayIso()) }); }
      if (cLoc.descCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.descCol] = desc; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.descCol, val: desc }); preview.push({ label: 'Chéquier — Description', col: colName(cLoc.descCol), value: desc }); }
      if (cLoc.montCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.montCol] = montant; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.montCol, val: montant }); preview.push({ label: 'Chéquier — Montant', col: colName(cLoc.montCol), value: this.fmt(montant) }); }
      if (cLoc.obsCol >= 0) { editsBySheet[chequeSheetName][cLoc.previewIdx + ':' + cLoc.obsCol] = newObs; verifyTargets.push({ sheetName: chequeSheetName, rowIdx: cLoc.previewIdx, col: cLoc.obsCol, val: newObs }); preview.push({ label: 'Chéquier — Obs', col: colName(cLoc.obsCol), value: newObs }); }
      this._pendingWrite = { kind: 'operations', buf, handle: s.hi.handle, name: s.hi.name, fingerprint, sheetName: `${s.sheetName}, ${chequeSheetName}`, editsBySheet, verifyTargets, refuseFormula: true, after: () => { this._refreshChequiersLive(); this.setState({ chqAddDraft: null, msg: { kind: 'ok', text: `Chèque n°${chequeNum} ajouté à la facture ${ref}.` } }); this._refreshChqLiveStatus(ref); } };
      this.setState({ writePreview: { kind: 'chqmodif', fileName: s.hi.name, sheetName: `${s.sheetName} + ${chequeSheetName}`, rows: preview, status: null, refLabel: ref } });
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Préparation impossible : ${(e && e.message) || 'erreur'}. Rien n'a été modifié.` } });
    }
  }
  // Fait avancer le compteur local du chéquier (used/next), comme après un achat en mode chèque.

  // ---------- Circuit D — stock hebdo : remplir poids + prix par espèce/calibre (depuis les achats) ----------
  // Espèce du tableau de bord → feuille (les feuilles combinées portent l'espèce EN COLONNE, pas en onglet).
  _stockSheetHint(espece) {
    const M = {
      'homard': { sheet: 'homard', byCol: null }, 'langouste royale': { sheet: 'langouste royal', byCol: null },
      'langouste rose': { sheet: 'langouste rose', byCol: null }, 'tourteau': { sheet: 'tourteau', byCol: null },
      'langoustine': { sheet: 'langoustine', byCol: null }, 'bigorneau': { sheet: 'big', byCol: 'bigorneau' },
      'crabe vert': { sheet: 'big', byCol: 'crabe vert' }, 'velvet-crab': { sheet: 'vel', byCol: 'velvet' },
      'bouquet': { sheet: 'vel', byCol: 'bouquet' }, 'araignee': { sheet: 'vel', byCol: 'araignee' },
    };
    return M[this._norm(espece)] || null;
  }
  // Localise une section verticale (ACHAT-ENTREE ou COMMANDES-SORTIE) dans la colonne A : titre,
  // en-tête (ligne « ...PRIX... »), 1re ligne de données, et la ligne TOTAL qui borne la section
  // (jamais franchie — sert aussi de garde-fou si RESUMEE BENEFICES arrive avant un TOTAL trouvé).
  // Un libellé peut se trouver dans n'importe quelle colonne de la ligne (ex. colonne D), pas
  // uniquement en colonne A — on teste donc chaque cellule de la ligne, normalisée.
  _stockRowHas(row, ...kws) { return (row || []).some(c => { const n = this._norm(c); return kws.every(k => n.indexOf(k) >= 0); }); }
  _stockFindSection(rows, kw1, kw2) {
    for (let i = 0; i < Math.min(40, rows.length); i++) {
      const has1 = rows[i].some(c => c && this._norm(String(c)).includes(this._norm(kw1)));
      const has2 = rows[i].some(c => c && this._norm(String(c)).includes(this._norm(kw2)));
      if (has1 || has2) console.log('[stockFind] ligne', i, 'kw1:', has1, 'kw2:', has2, 'vals COMPLETES:', rows[i].filter(v => v != null && v !== ''));
    }
    // Ligne titre = contient kw1 ET kw2 mais PAS "total" (sinon confusion avec "TOTAL ACHAT - ENTREE").
    let titleRow = -1;
    for (let r = 0; r < rows.length; r++) { if (this._stockRowHas(rows[r], kw1, kw2) && !this._stockRowHas(rows[r], 'total')) { titleRow = r; break; } }
    if (titleRow < 0) return null;
    // En-tête PRIX : cherché d'abord AVANT le titre (jusqu'à 5 lignes en remontant — cas réel où
    // CLIENTS/calibres/PRIX précèdent la ligne "ACHAT - ENTREE"), sinon en repli après (ancien
    // comportement, pour les fichiers où l'en-tête suit le titre de section).
    let hi = -1;
    for (let r = titleRow - 1; r >= Math.max(0, titleRow - 5); r--) { if ((rows[r] || []).some(c => this._norm(c).indexOf('prix') >= 0)) { hi = r; break; } }
    if (hi < 0) { for (let r = titleRow + 1; r < Math.min(rows.length, titleRow + 4); r++) { if ((rows[r] || []).some(c => this._norm(c).indexOf('prix') >= 0)) { hi = r; break; } } }
    console.log('[stockFind] titleRow:', titleRow, 'hi (en-tête PRIX):', hi);
    // hi peut rester -1 ici (ex. en-tête unique partagé, trop loin de cette section) : on ne
    // bloque pas — l'appelant (_stockResolve) peut réutiliser le headerIdx d'une autre section
    // du même en-tête pour cette feuille.
    // Ligne total = contient "total" ET kw1 (ex. "TOTAL ACHAT - ENTREE"), distincte de la ligne titre.
    // Tolère le singulier (ex. "TOTAL COMMANDE SORTIE" alors que le titre de section dit "COMMANDES").
    const kw1Stem = kw1.endsWith('s') ? kw1.slice(0, -1) : kw1;
    let totalRow = -1;
    for (let r = Math.max(hi, titleRow) + 1; r < Math.min(rows.length, Math.max(hi, titleRow) + 60); r++) {
      if (this._stockRowHas(rows[r], 'total') && (this._stockRowHas(rows[r], kw1) || this._stockRowHas(rows[r], kw1Stem))) { totalRow = r; break; }
      if (this._stockRowHas(rows[r], 'resumee', 'benefices')) break; // section suivante atteinte sans TOTAL trouvé → borne ici
    }
    // La ligne titre EST la 1re ligne de données (ex. "ACHAT - ENTREE" + valeurs de la 1re saisie).
    return { titleRow, headerIdx: hi, dataStart: titleRow, totalRow };
  }
  // Résout (feuille, section, colonnes) pour une espèce/calibre donnés, selon le contexte 'achat' ou 'vente'.
  _stockResolve(wb, espece, calibre, context) {
    console.log('[stockResolve] feuilles disponibles:', wb.map(s => s.name));
    const hint = this._stockSheetHint(espece); if (!hint) return null;
    const sh = wb.find(s => { const n = this._norm(s.name); return n === hint.sheet || n.startsWith(hint.sheet) || n.indexOf(hint.sheet) >= 0; });
    if (!sh) return null;
    const rows = sh.rows;
    const sectionAchat = this._stockFindSection(rows, 'achat', 'entree');
    console.log('[stockResolve] section achat:', sectionAchat);
    const sectionVente = this._stockFindSection(rows, 'commandes', 'sortie');
    console.log('[stockResolve] section vente:', sectionVente);
    let sec = context === 'vente' ? sectionVente : sectionAchat;
    if (!sec) return null;
    if (sec.headerIdx < 0) {
      // En-tête (CLIENTS/calibres/PRIX) unique, partagé par les deux sections de la feuille :
      // si cette section ne l'a pas trouvé à proximité, on réutilise celui de l'autre section.
      const other = context === 'vente' ? sectionAchat : sectionVente;
      if (other && other.headerIdx >= 0) sec = { ...sec, headerIdx: other.headerIdx };
    }
    if (sec.headerIdx < 0) return null;
    const hdr = rows[sec.headerIdx];
    const want = this._norm(hint.byCol ? hint.byCol : ((calibre && this._norm(calibre) !== 'standard') ? calibre : espece));
    let poidsCol = -1; for (let c = 0; c < hdr.length; c++) { const h = this._norm(hdr[c]); if (h === want || (hint.byCol && h.indexOf(want) >= 0)) { poidsCol = c; break; } }
    if (poidsCol < 0) return null;
    let prixCol = poidsCol + 1; // motif universel [calibre][PRIX € / Kg]
    if (this._norm(hdr[prixCol]).indexOf('prix') < 0) { for (let c = poidsCol + 1; c < Math.min(hdr.length, poidsCol + 3); c++) { if (this._norm(hdr[c]).indexOf('prix') >= 0) { prixCol = c; break; } } }
    let clientCol = -1; for (let c = 0; c < hdr.length; c++) { if (this._norm(hdr[c]).indexOf('client') >= 0) { clientCol = c; break; } }
    if (clientCol < 0) clientCol = 4; // repli si l'en-tête « Clients » n'est pas détecté
    return { sheetName: sh.name, headerIdx: sec.headerIdx, dataStart: sec.dataStart, totalRow: sec.totalRow, poidsCol, prixCol, clientCol };
  }
  // Handle inscriptible du fichier stock de la semaine correspondant à une date.
  async _stockWeeklyHandle(dateIso) {
    if (!this._stockDir) return null;
    const p = String(dateIso || '').split('-').map(Number); if (p.length < 3 || !p[0]) return null;
    const week = this.isoWeek({ y: p[0], m: p[1], d: p[2] });
    // RÈGLE 10 : d'abord le handle du fichier qu'on a créé/repéré cette session (pas de re-recherche par nom).
    const kept = (this._stockWeekHandles || {})[week]; if (kept && kept.handle) return kept;
    const pfx = this.prefixOf('stock'); const weekRe = new RegExp('(^|[^0-9])' + week + '([^0-9]|$)');
    try { for (const [nm, h] of await this.listFilesDeep(this._stockDir, 3)) { if (/^~\$/.test(nm)) continue; if (/\.(xlsx|xlsm)$/i.test(nm) && this.matchPrefix(nm, pfx) && weekRe.test(nm.replace(/\.[^.]+$/, ''))) { this._stockWeekHandles = this._stockWeekHandles || {}; this._stockWeekHandles[week] = { handle: h, name: nm }; return { handle: h, name: nm }; } } } catch (e) {}
    return null;
  }
  // Aperçu de remplissage du stock (fichier de la semaine), déclenché après un achat ou une vente réussi(e).
  // context : 'achat' → section ACHAT-ENTREE, 'vente' → section COMMANDES-SORTIE.
  async requestStockPreview(rec, context) {
    console.log('[stock] début requestStockPreview', rec.espece || rec.lignes, context);
    const ctx = context === 'vente' ? 'vente' : 'achat';
    // RÈGLE 8/13 : toute sortie en échec marque l'étape « stock » et clôt le bilan (achat uniquement — pour la vente, best-effort, non bloquant).
    const stockFailed = (txt) => { this.setState({ msg: { kind: 'error', text: txt } }); if (this._achatSteps) this._achatSteps.stock = 'fail'; this._runNextWrite(); this._maybeFinalizeAchat(); };
    if (!this._stockDir) { if (this._achatSteps) this._achatSteps.stock = 'na'; this._runNextWrite(); this._maybeFinalizeAchat(); return; }
    try {
      const hi = await this._stockWeeklyHandle(rec.date);
      if (!hi) return stockFailed(`Stock non rempli (${ctx}) : fichier stock de la semaine introuvable (vérifiez le dossier Stock ou le modèle).`);
      const okPerm = await this._ensureWritePermission(hi.handle); if (!okPerm) return stockFailed(`Stock non rempli (${ctx}) : autorisation d'écriture refusée sur le fichier stock.`);
      const file = await hi.handle.getFile();
      const fingerprint = (file.lastModified || 0) + '/' + (file.size || 0);
      const buf = await file.arrayBuffer(); const wb = await this.readWorkbook(buf);
      const bySheet = {}; const unresolved = [];
      (rec.lignes || []).forEach(l => { const t = this._stockResolve(wb, l.espece, l.calibre, ctx); console.log('[stock] resolve result:', t); if (!t) { unresolved.push(`${l.espece} ${l.calibre}`); return; }
        bySheet[t.sheetName] = bySheet[t.sheetName] || { t, cals: [] }; bySheet[t.sheetName].cals.push({ poidsCol: t.poidsCol, prixCol: t.prixCol, poids: l.poids, prix: l.prixKg, label: `${l.espece} ${l.calibre}` }); });
      const editsBySheet = {}; const preview = []; const verifyTargets = [];
      Object.keys(bySheet).forEach(sn => { const g = bySheet[sn]; const sh = wb.find(s => s.name === sn); const rows = sh.rows; const poidsCols = g.cals.map(c => c.poidsCol);
        const maxRow = Math.min(rows.length, g.t.dataStart + 60, g.t.totalRow >= 0 ? g.t.totalRow : Infinity); // jamais franchir la ligne TOTAL
        let rowIdx = -1; for (let r = g.t.dataStart; r < maxRow; r++) { const rr = rows[r] || []; const clientEmpty = (rr[g.t.clientCol] == null || String(rr[g.t.clientCol]).trim() === ''); const cellsEmpty = poidsCols.every(pc => rr[pc] == null || String(rr[pc]).trim() === ''); if (clientEmpty && cellsEmpty) { rowIdx = r; break; } }
        if (rowIdx < 0) { unresolved.push(`${sn} (pas de ligne libre)`); return; }
        editsBySheet[sn] = {}; editsBySheet[sn][rowIdx + ':' + g.t.clientCol] = rec.pecheur || rec.client || '';
        g.cals.forEach(c => { editsBySheet[sn][rowIdx + ':' + c.poidsCol] = c.poids; editsBySheet[sn][rowIdx + ':' + c.prixCol] = c.prix;
          preview.push({ label: `${sn} · ${c.label}`, col: `${this._colLetter(c.poidsCol + 1)}${rowIdx + 1}`, value: `${c.poids} kg @ ${this.fmt(c.prix)}/kg` });
          verifyTargets.push({ sheetName: sn, rowIdx, col: c.poidsCol, val: c.poids }, { sheetName: sn, rowIdx, col: c.prixCol, val: c.prix }); }); });
      if (!Object.keys(editsBySheet).length) return stockFailed(`Stock non rempli (${ctx})${unresolved.length ? ' : ' + unresolved.join(', ') : ''}.`);
      const sheetList = Object.keys(editsBySheet);
      this._pendingWrite = { kind: 'operations', buf, handle: hi.handle, name: hi.name, fingerprint, sheetName: sheetList.join(', '), editsBySheet, verifyTargets, refuseFormula: true, after: () => this._runNextWrite(), step: 'stock', unresolved };
      console.log('[stock] setState writePreview:', JSON.stringify(preview).substring(0, 100));
      this.setState({ writePreview: { kind: 'stock', fileName: hi.name, sheetName: sheetList.join(', '), excelRow: null, rows: preview, status: null, title: `Stock de la semaine (${ctx === 'vente' ? 'sortie' : 'entrée'}) — ${sheetList.length} feuille(s)${unresolved.length ? ' · non placé : ' + unresolved.join(', ') : ''}` } });
    } catch (e) { stockFailed(`Stock non rempli (${ctx}) : ${(e && e.message) || 'erreur'}.`); }
  }

  // ---------- Circuit E — onglet dédié « Suivi des paiements » du fichier ventes ----------
  // Onglet fixe (pas de réglage utilisateur comme pour operations/ventes/factures) : la feuille
  // et ses en-têtes sont repérés par libellé, comme pour le stock.
  _suiviLocate(wb) {
    const sh = wb.find(s => { const n = this._norm(s.name); return n.indexOf('suivi') >= 0 && n.indexOf('paiement') >= 0; });
    if (!sh) return null;
    const rows = sh.rows;
    let hi = -1;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const rr = rows[r] || [];
      if (rr.some(c => this._norm(c).indexOf('id facture') >= 0) || (rr.some(c => this._norm(c).indexOf('numero facture') >= 0) && rr.some(c => this._norm(c).indexOf('client') >= 0))) { hi = r; break; }
    }
    if (hi < 0) return null;
    const hdr = rows[hi];
    const find = (...kws) => { for (let c = 0; c < hdr.length; c++) { const h = this._norm(hdr[c]); if (kws.every(k => h.indexOf(k) >= 0)) return c; } return -1; };
    const cols = {
      idFacture: find('id', 'facture'), numero: find('numero', 'facture'), client: find('nom', 'client') >= 0 ? find('nom', 'client') : find('client'),
      ttc: find('montant', 'ttc'), avoir: find('avoir'), dateFac: find('date', 'facture'), dateEch: find('date', 'echeance'),
    };
    return { sheetName: sh.name, headerIdx: hi, dataStart: hi + 1, cols };
  }
  // Ajoute une nouvelle ligne en fin de tableau (« Suivi des paiements ») en recopiant les
  // FORMULES des colonnes indiquées depuis la ligne précédente, décalées de +1 ligne. Ne touche
  // qu'aux colonnes demandées (les colonnes A/E, ID Facture/Avoir, sont écrites séparément par
  // l'appelant). Prudence : une formule contenant une référence absolue ($B$5) ou externe
  // (Feuille!B5) n'est PAS recopiée — mieux vaut une case vide qu'une formule fausse.
  async _suiviAppendRowWithFormulas(buf, sheetName, prevRowNum, colLetters) {
    const files = await this.unzipAll(buf); const dec = new TextDecoder(); const enc = new TextEncoder();
    const wbXml = dec.decode(files['xl/workbook.xml'] || new Uint8Array());
    const relsXml = dec.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
    const relMap = this._relMapOf(relsXml);
    const targetByName = {}; [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].forEach(m => { targetByName[this.unxml(m[1])] = relMap[m[2]]; });
    const target = targetByName[sheetName];
    if (!target || !files[target]) throw new Error(`feuille « ${sheetName} » introuvable — ajout annulé`);
    let xml = dec.decode(files[target]);
    const prevRowRe = new RegExp(`<row\\b[^>]*\\br="${prevRowNum}"[^>]*>[\\s\\S]*?<\\/row>`);
    const prevRowMatch = xml.match(prevRowRe);
    if (!prevRowMatch) throw new Error(`ligne ${prevRowNum} introuvable dans « ${sheetName} » — impossible de recopier les formules`);
    const newRowNum = prevRowNum + 1;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm; const newCells = [];
    while (cm = cellRe.exec(prevRowMatch[0])) {
      const refM = cm[1].match(/\br="([A-Z]+)\d+"/); if (!refM) continue;
      const colLetter = refM[1]; if (colLetters.indexOf(colLetter) < 0) continue; // colonne non demandée
      const body = cm[2] || ''; const fM = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
      if (!fM) continue; // pas de formule sur cette cellule de la ligne précédente : rien à recopier
      const formula = fM[1];
      if (/\$|!/.test(formula)) continue; // référence absolue ou externe : trop risqué, on n'y touche pas
      const shifted = formula.replace(/\b([A-Z]{1,3})(\d+)\b/g, (m2, col, num) => (+num === prevRowNum ? col + newRowNum : m2));
      const styleM = cm[1].match(/\ss="(\d+)"/); const styleAttr = styleM ? ` s="${styleM[1]}"` : '';
      newCells.push(`<c r="${colLetter}${newRowNum}"${styleAttr}><f>${shifted}</f></c>`);
    }
    const rowXml = `<row r="${newRowNum}">${newCells.join('')}</row>`;
    if (/<\/sheetData>/.test(xml)) xml = xml.replace('</sheetData>', rowXml + '</sheetData>');
    else if (/<sheetData\/>/.test(xml)) xml = xml.replace('<sheetData/>', `<sheetData>${rowXml}</sheetData>`);
    else throw new Error('structure de feuille inattendue — ajout annulé');
    xml = xml.replace(/(<dimension[^>]*ref=")([A-Z]+)(\d+):([A-Z]+)(\d+)("[^>]*\/>)/, (m, a, c1, r1, c2, r2, z) => a + c1 + r1 + ':' + c2 + Math.max(+r2, newRowNum) + z);
    files[target] = enc.encode(xml);
    const entries = Object.keys(files).map(name => ({ name, bytes: files[name] }));
    return this.zipBuild(entries, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  // ---------- Écran de paramétrage guidé (vous montrez chaque colonne) ----------
  _colLetter(n) { let s = '', m = n; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; }
  _pwSheetView(rows, savedHeaderIdx, rmapHeaderIdx) {
    const headerIdx = savedHeaderIdx != null ? savedHeaderIdx : (rmapHeaderIdx != null ? rmapHeaderIdx : this.guessHeader(rows));
    const header = rows[headerIdx] || [];
    let nCols = header.length; for (let r = headerIdx; r < Math.min(rows.length, headerIdx + 8); r++) nCols = Math.max(nCols, (rows[r] || []).length); nCols = Math.max(nCols, 1);
    const headerCells = []; for (let i = 0; i < nCols; i++) headerCells.push({ col: i, letter: this._colLetter(i + 1), label: (header[i] != null ? String(header[i]) : '').trim() });
    // jusqu'à 40 lignes proposées (et au moins 12 lignes affichées même si la feuille est plus courte)
    const lastRow = Math.max(rows.length, headerIdx + 13);
    const samples = []; for (let r = headerIdx + 1; r < Math.min(lastRow, headerIdx + 41); r++) { const cells = []; for (let i = 0; i < nCols; i++) cells.push((rows[r] && rows[r][i] != null) ? String(rows[r][i]) : ''); samples.push({ previewIdx: r, excelRow: r + 1, cells }); }
    return { headerIdx, nCols, headerCells, samples };
  }
  // Récupère le classeur d'une source pour le réglage : cache → fichier connecté (avec demande
  // d'autorisation) → en dernier recours, sélecteur de fichier direct (le bouton aboutit toujours).
  async _wbForWrite(kind) {
    const c = (this._wbCache || {})[kind]; if (c && c.wb) return { wb: c.wb, name: c.name };
    const hi = this._writableHandleFor(kind);
    if (hi && hi.handle) {
      try {
        let p = hi.handle.queryPermission ? await hi.handle.queryPermission({ mode: 'read' }) : 'granted';
        if (p !== 'granted' && hi.handle.requestPermission) p = await hi.handle.requestPermission({ mode: 'read' });
        if (p === 'granted') { const f = await hi.handle.getFile(); const wb = await this.readWorkbook(await f.arrayBuffer()); if (wb.length) { this._wbCache = this._wbCache || {}; this._wbCache[kind] = { wb, name: hi.name, handle: hi.handle, lastMod: f.lastModified }; return { wb, name: hi.name }; } }
      } catch (e) {}
    }
    // repli : demander le fichier directement, ici et maintenant
    this.setState({ msg: { kind: 'ok', text: `Choisissez votre fichier « ${this.writeSourceLabel(kind)} » pour régler l'écriture.` } });
    const picked = await this.pickFile(); if (picked.aborted || !picked.file) return null;
    try {
      const wb = await this.readWorkbook(await picked.file.arrayBuffer());
      if (!wb.length) throw new Error('aucune feuille lisible');
      this._wbCache = this._wbCache || {}; this._wbCache[kind] = { wb, name: picked.file.name, handle: picked.handle || null, lastMod: picked.file.lastModified };
      if (picked.handle) { this._watched = this._watched || {}; this._watched[picked.file.name] = { kind, name: picked.file.name, handle: picked.handle, lastMod: 0 }; this.setState({ watchCount: Object.keys(this._watched).length }); }
      return { wb, name: picked.file.name };
    } catch (e) { this.setState({ msg: { kind: 'error', text: `Lecture de « ${picked.file.name} » impossible : ${(e && e.message) || 'format non pris en charge'}.` } }); return null; }
  }
  async openParamWrite(kind) {
    if (kind === 'factures') return this.detectFacturesWrite();
    const got = await this._wbForWrite(kind); if (!got) return;
    const wb = got.wb, name = got.name;
    const label = this.writeSourceLabel(kind);
    this._pwWb = wb;
    const spec = this.importSpec(kind);
    const saved = this.writeMapFor(kind);
    const rmap = (this.state.mappings || {})[kind];
    let sheetIdx = saved && saved.sheetName ? wb.findIndex(s => s.name === saved.sheetName) : -1;
    // spec.forceSheetIndex (ex. 'ventes' → toujours feuille 0, « Factures ») prime sur le mapping
    // de LECTURE (rmap) : celui-ci peut légitimement pointer vers un autre onglet pour l'affichage
    // (ex. « Suivi des paiements »), ce qui n'a rien à voir avec où l'ÉCRITURE doit avoir lieu.
    if (sheetIdx < 0 && spec.forceSheetIndex != null && wb[spec.forceSheetIndex]) sheetIdx = spec.forceSheetIndex;
    if (sheetIdx < 0 && rmap && rmap.sheetName) sheetIdx = wb.findIndex(s => s.name === rmap.sheetName);
    if (sheetIdx < 0) sheetIdx = this.guessSheet(spec, wb);
    if (sheetIdx < 0) sheetIdx = 0;
    const onThisSheet = wb[sheetIdx].name;
    const view = this._pwSheetView(wb[sheetIdx].rows, (saved && saved.sheetName === onThisSheet) ? saved.headerRowIdx : null, (rmap && rmap.sheetName === onThisSheet) ? rmap.headerIdx : null);
    const fields = this.writeFieldsFor(kind);
    const pw = { kind, label, fileName: name, sheetNames: wb.map(s => s.name), sheetIdx, sheetName: onThisSheet, ...view, fields, cols: {}, firstDataIdx: null, editKey: null, phase: 'mapping', i: 0 };
    if (saved && saved.cols && saved.sheetName === onThisSheet) { pw.cols = { ...saved.cols }; pw.firstDataIdx = saved.firstDataIdx != null ? saved.firstDataIdx : view.headerIdx + 1; pw.phase = 'recap'; }
    this.setState({ paramWrite: pw });
  }
  pwSetSheet(idx) {
    const pw = this.state.paramWrite; const wb = this._pwWb; if (!pw || !wb || !wb[idx]) return;
    // Mémorise la progression de la feuille qu'on quitte, et restaure celle de la feuille de
    // destination si elle existe déjà — changer de feuille ne doit plus effacer la progression.
    const drafts = { ...(pw.sheetDrafts || {}), [pw.sheetName]: { cols: pw.cols, firstDataIdx: pw.firstDataIdx, phase: pw.phase, i: pw.i } };
    const newSheetName = wb[idx].name;
    const restored = drafts[newSheetName] || { cols: {}, firstDataIdx: null, phase: 'mapping', i: 0 };
    const view = this._pwSheetView(wb[idx].rows, null, null);
    this.setState({ paramWrite: { ...pw, sheetIdx: idx, sheetName: newSheetName, ...view, sheetDrafts: drafts, cols: { ...restored.cols }, firstDataIdx: restored.firstDataIdx, phase: restored.phase, i: restored.i, editKey: null } });
  }
  closeParamWrite() { this._pwWb = null; this.setState({ paramWrite: null }); }
  _pwColOfField(pw, key) { const c = pw.cols[key]; return (c == null || c < 0) ? null : c; }
  _pwFieldOfCol(pw, col) { for (const k of Object.keys(pw.cols)) if (pw.cols[k] === col) return k; return null; }
  pwAssignCol(col) {
    const pw = this.state.paramWrite; if (!pw) return;
    if (pw.phase === 'mapping') {
      const f = pw.fields[pw.i]; const cols = { ...pw.cols };
      Object.keys(cols).forEach(k => { if (cols[k] === col) delete cols[k]; }); // une colonne = un seul champ
      cols[f.key] = col; const ni = pw.i + 1;
      if (ni < pw.fields.length) this.setState({ paramWrite: { ...pw, cols, i: ni } });
      else this.setState({ paramWrite: { ...pw, cols, phase: 'startrow' } });
    } else if (pw.phase === 'editField') {
      const cols = { ...pw.cols }; Object.keys(cols).forEach(k => { if (cols[k] === col) delete cols[k]; }); cols[pw.editKey] = col;
      this.setState({ paramWrite: { ...pw, cols, phase: 'recap', editKey: null } });
    }
  }
  pwSkipField() {
    const pw = this.state.paramWrite; if (!pw || pw.phase !== 'mapping') return;
    const f = pw.fields[pw.i]; const cols = { ...pw.cols }; delete cols[f.key]; const ni = pw.i + 1;
    if (ni < pw.fields.length) this.setState({ paramWrite: { ...pw, cols, i: ni } });
    else this.setState({ paramWrite: { ...pw, cols, phase: 'startrow' } });
  }
  pwSetStartRow(previewIdx) {
    const pw = this.state.paramWrite; if (!pw) return;
    if (pw.phase === 'startrow' || pw.phase === 'editStart') this.setState({ paramWrite: { ...pw, firstDataIdx: previewIdx, phase: 'recap' } });
  }
  pwEditField(key) { const pw = this.state.paramWrite; if (!pw) return; this.setState({ paramWrite: { ...pw, phase: 'editField', editKey: key } }); }
  pwEditStart() { const pw = this.state.paramWrite; if (!pw) return; this.setState({ paramWrite: { ...pw, phase: 'editStart' } }); }
  pwBack() {
    const pw = this.state.paramWrite; if (!pw) return;
    if (pw.phase === 'mapping') { if (pw.i > 0) this.setState({ paramWrite: { ...pw, i: pw.i - 1 } }); else this.closeParamWrite(); }
    else if (pw.phase === 'startrow') this.setState({ paramWrite: { ...pw, phase: 'mapping', i: pw.fields.length - 1 } });
    else if (pw.phase === 'recap') this.setState({ paramWrite: { ...pw, phase: 'startrow' } });
    else if (pw.phase === 'editField' || pw.phase === 'editStart') this.setState({ paramWrite: { ...pw, phase: 'recap', editKey: null } });
  }
  pwRestart() { const pw = this.state.paramWrite; if (!pw) return; this.setState({ paramWrite: { ...pw, cols: {}, firstDataIdx: null, phase: 'mapping', i: 0, editKey: null } }); }
  pwSaveWrite() {
    const pw = this.state.paramWrite; if (!pw) return;
    const cfg = { fileName: pw.fileName, sheetName: pw.sheetName, headerRowIdx: pw.headerIdx, firstDataIdx: pw.firstDataIdx != null ? pw.firstDataIdx : pw.headerIdx + 1, cols: { ...pw.cols }, enabled: true };
    this.saveWriteMap(pw.kind, cfg);
    this.setState({ paramWrite: null, msg: { kind: 'ok', text: `Écriture réglée pour « ${pw.label} » — feuille « ${pw.sheetName} », à partir de la ligne ${(pw.firstDataIdx != null ? pw.firstDataIdx : pw.headerIdx + 1) + 1}.` } });
  }
  toggleWriteEnabled(kind) {
    const cfg = this.writeMapFor(kind); if (!cfg) return;
    this.saveWriteMap(kind, { ...cfg, enabled: !cfg.enabled });
  }
  _srcWriteProps(kind) {
    const cfg = this.writeMapFor(kind); const green = '#15803d', accent = this.entCfg().accent;
    const set = !!(cfg && (cfg.cols || cfg.months || cfg.blocks)); const enabled = !!(cfg && cfg.enabled);
    const setLabel = cfg && cfg.months ? '✍ Écriture active — 12 feuilles mensuelles' : ('✍ Écriture active — feuille « ' + ((cfg && cfg.sheetName) || '') + ' »');
    return {
      canWrite: true, writeConfigured: set,
      writeStatusLabel: set ? (enabled ? setLabel : 'Écriture réglée (en pause)') : 'Écriture non réglée',
      writeStatusStyle: `display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;color:${set && enabled ? green : '#b45309'};background:${set && enabled ? this.hexToRgba(green, 0.1) : '#fff7ed'};border:1px solid ${set && enabled ? this.hexToRgba(green, 0.25) : '#fbd9b4'}`,
      writeBtnLabel: set ? "⚙ Modifier l'écriture" : "⚙ Régler l'écriture",
      writeBtnStyle: `padding:7px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`,
      onParamWrite: () => this.openParamWrite(kind),
      writeToggleLabel: enabled ? 'Mettre en pause' : "Activer l'écriture",
      writeToggleStyle: 'padding:7px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:#69788c;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit;white-space:nowrap',
      onToggleWrite: () => this.toggleWriteEnabled(kind),
      onWriteTest: () => this.openWriteTest(),
    };
  }
  // ---------- Assistant de test « mode débutant » ----------
  // Construit un mini-fichier Excel de test (avec une formule) pour exercer le moteur d'écriture hors ligne.
  _buildTestWorkbook() {
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C4"/><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Client</t></is></c><c r="C1" t="inlineStr"><is><t>Montant</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>01/01/2026</t></is></c><c r="B2" t="inlineStr"><is><t>Client A</t></is></c><c r="C2"><v>100</v></c></row>'
      + '<row r="3"></row>'
      + '<row r="4"><c r="A4" t="inlineStr"><is><t>TOTAL</t></is></c><c r="C4"><f>SUM(C2:C3)</f><v>100</v></c></row>'
      + '</sheetData></worksheet>';
    const wbx = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    const enc = new TextEncoder();
    const entries = [
      { name: '[Content_Types].xml', bytes: enc.encode(ct) },
      { name: '_rels/.rels', bytes: enc.encode(rels) },
      { name: 'xl/workbook.xml', bytes: enc.encode(wbx) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(wbr) },
      { name: 'xl/worksheets/sheet1.xml', bytes: enc.encode(sheet) },
    ];
    return this.zipBuild(entries, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  async _countFormulas(buf) { const files = await this.unzipAll(buf); const dec = new TextDecoder(); let n = 0; Object.keys(files).forEach(k => { if (/sheet\d*\.xml$/.test(k)) n += (dec.decode(files[k]).match(/<f[\s>\/]/g) || []).length; }); return n; }
  openWriteTest() { this.setState({ writeTest: { running: false, done: false, report: [], passed: 0, total: 0, text: '' } }); }
  closeWriteTest() { this.setState({ writeTest: null }); }
  async runWriteSelfTest() {
    this.setState({ writeTest: { running: true, done: false, report: [], passed: 0, total: 0, text: '' } });
    const report = []; const add = (label, ok, detail) => report.push({ label, ok: !!ok, detail: detail || '' });
    try {
      const support = typeof window !== 'undefined' && ('showOpenFilePicker' in window || 'showDirectoryPicker' in window);
      add("Votre navigateur autorise l'écriture dans les fichiers", support, support ? 'Chrome ou Edge détecté (compatible)' : 'Ouvrez le tableau de bord dans Chrome ou Edge sur ordinateur');
      const blob = await this._buildTestWorkbook(); const buf = await blob.arrayBuffer();
      const wb0 = await this.readWorkbook(buf); const okRead = wb0.length > 0 && wb0[0].name === 'Test';
      add("Lire un fichier Excel", okRead, okRead ? 'feuille « Test » lue correctement' : 'lecture impossible');
      const fBefore = await this._countFormulas(buf);
      const loc = await this._locateAppendTarget(buf, 'Test', [0, 1, 2], 1);
      add("Trouver la première ligne vide", loc.excelRow === 3, 'ligne détectée : ' + loc.excelRow + ' (attendu : 3)');
      const edits = { Test: {} }; edits.Test[loc.previewIdx + ':0'] = '02/02/2026'; edits.Test[loc.previewIdx + ':1'] = 'Client TEST'; edits.Test[loc.previewIdx + ':2'] = 250;
      const patched = await this.patchXlsxFile(buf, edits); const pbuf = await patched.arrayBuffer();
      const wb1 = await this.readWorkbook(pbuf); const r3 = wb1[0].rows[2] || [];
      const wrote = r3[1] === 'Client TEST' && String(r3[2]) === '250';
      add("Écrire une ligne au bon endroit", wrote, 'ligne 3 écrite : ' + JSON.stringify(r3));
      const r2 = wb1[0].rows[1] || []; const intact = r2[1] === 'Client A' && String(r2[2]) === '100';
      add("Ne pas toucher aux lignes déjà remplies", intact, 'ligne 2 (existante) inchangée : ' + JSON.stringify(r2));
      const fAfter = await this._countFormulas(pbuf);
      add("Préserver vos formules Excel", fBefore > 0 && fAfter >= fBefore, 'formules avant : ' + fBefore + ', après : ' + fAfter);
      let safe = false; try { await this._locateAppendTarget(buf, 'FeuilleQuiNexistePas', [0], 1); } catch (e) { safe = true; }
      add("Sécurité : rien n'est écrit en cas d'erreur", safe, safe ? 'une erreur de feuille est bien bloquée' : 'à vérifier');
      const loc2 = await this._locateAppendTarget(pbuf, 'Test', [0, 1, 2], 1);
      const okAppend = loc2.mode === 'append';
      add("Ajouter une nouvelle ligne si le fichier est plein", okAppend, 'ligne suivante : ' + loc2.excelRow + ' (' + loc2.mode + ')');
      const app = await this._appendXlsxRow(pbuf, 'Test', loc2.excelRow, { 0: '03/03/2026', 1: 'Client 2', 2: 300 }); const abuf = await app.arrayBuffer();
      const wb2 = await this.readWorkbook(abuf); const rN = (wb2[0].rows[loc2.excelRow - 1]) || [];
      add("La nouvelle ligne ajoutée est correcte", rN[1] === 'Client 2', 'ligne ' + loc2.excelRow + ' : ' + JSON.stringify(rN));
    } catch (e) {
      add("Le test s'est interrompu", false, (e && e.message) || 'erreur inconnue');
    }
    const passed = report.filter(r => r.ok).length; const total = report.length;
    const n = new Date();
    const stamp = `${this.dd(n.getDate())}/${this.dd(n.getMonth() + 1)}/${n.getFullYear()} à ${this.dd(n.getHours())}:${this.dd(n.getMinutes())}`;
    let text = "RAPPORT DE TEST — Écriture dans les fichiers Excel\n";
    text += "Tableau de bord " + (this.entCfg().nom || '') + "\n";
    text += "Date : " + stamp + "\n";
    try { text += "Navigateur : " + navigator.userAgent + "\n"; } catch (e) {}
    text += "Résultat : " + passed + " / " + total + " vérifications réussies\n";
    text += "----------------------------------------\n";
    report.forEach((r, i) => { text += (r.ok ? '[OK] ' : '[ÉCHEC] ') + (i + 1) + '. ' + r.label + '\n      → ' + r.detail + '\n'; });
    text += "----------------------------------------\n";
    text += passed === total ? "CONCLUSION : tout fonctionne, l'écriture est fiable sur ce poste.\n" : "CONCLUSION : au moins une vérification a échoué — envoyez ce rapport pour diagnostic.\n";
    this.setState({ writeTest: { running: false, done: true, report, passed, total, text } });
  }
  downloadWriteReport() {
    const wt = this.state.writeTest; if (!wt || !wt.text) return;
    try {
      const n = new Date(); const name = `Rapport test écriture ${n.getFullYear()}-${this.dd(n.getMonth() + 1)}-${this.dd(n.getDate())} ${this.dd(n.getHours())}h${this.dd(n.getMinutes())}.txt`;
      const blob = new Blob([wt.text], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.setState({ msg: { kind: 'ok', text: 'Rapport téléchargé : ' + name + ' — vous pouvez l\'envoyer.' } });
    } catch (e) { this.setState({ msg: { kind: 'error', text: 'Téléchargement impossible.' } }); }
  }
  copyWriteReport() {
    const wt = this.state.writeTest; if (!wt || !wt.text) return;
    try { navigator.clipboard.writeText(wt.text); this.setState({ msg: { kind: 'ok', text: 'Rapport copié — collez-le dans un message pour l\'envoyer.' } }); }
    catch (e) { this.setState({ msg: { kind: 'error', text: 'Copie impossible — utilisez « Télécharger ».' } }); }
  }
  // ---------- Bilan de santé global du tableau de bord ----------
  async _writeEngineSelfCheck() {
    const blob = await this._buildTestWorkbook(); const buf = await blob.arrayBuffer();
    const loc = await this._locateAppendTarget(buf, 'Test', [0, 1, 2], 1);
    const edits = { Test: {} }; edits.Test[loc.previewIdx + ':0'] = 'x'; edits.Test[loc.previewIdx + ':2'] = 1;
    const patched = await this.patchXlsxFile(buf, edits); const pbuf = await patched.arrayBuffer();
    const wb = await this.readWorkbook(pbuf); const r = wb[0].rows[2] || [];
    const fB = await this._countFormulas(buf), fA = await this._countFormulas(pbuf);
    const ok = r[0] === 'x' && fA >= fB && fB > 0;
    return { ok, detail: ok ? 'écriture au bon endroit + formules préservées (test interne)' : 'anomalie — lancez « Tester (mode débutant) » pour le détail' };
  }
  openHealthCheck() { this.setState({ healthCheck: { running: false, done: false, sections: [], warns: 0, text: '' } }); }
  closeHealthCheck() { this.setState({ healthCheck: null }); }
  async runHealthCheck() {
    this.setState({ healthCheck: { running: true, done: false, sections: [], warns: 0, text: '' } });
    const S = []; const sec = t => { const o = { title: t, items: [] }; S.push(o); return o; };
    const add = (o, label, status, detail) => o.items.push({ label, status, detail: detail || '' });
    const V = v => this._vNum(v);
    try {
      const env = sec('Environnement');
      const sup = typeof window !== 'undefined' && ('showOpenFilePicker' in window);
      add(env, 'Navigateur compatible (écriture dans les fichiers)', sup ? 'ok' : 'warn', sup ? 'Chrome ou Edge détecté' : 'Ouvrez le tableau de bord dans Chrome ou Edge sur ordinateur');
      add(env, 'Mode démonstration', this.state.demoMode ? 'info' : 'ok', this.state.demoMode ? 'ACTIVÉ — les écrans affichent des données d\'exemple' : 'désactivé — vos données réelles');

      const fc = sec('Vos fichiers connectés');
      const watched = this._watched || {}; const byKind = {}; Object.keys(watched).forEach(k => { const w = watched[k]; if (w && w.kind) byKind[w.kind] = w; });
      const wbc = this._wbCache || {};
      [['ventes', 'Ventes (clients)', this.state.ventes], ['operations', 'Achat pêche', this.state.ops], ['factures', 'Factures fournisseur', this.state.factures], ['credits', 'Crédits & assurances', this.state.credits], ['banque', 'Relevé bancaire', this.state.banque], ['stock', 'Stock', this.state.stock]].forEach(([k, lbl, data]) => {
        const w = byKind[k] || wbc[k]; const conn = !!w; const has = !!data;
        add(fc, lbl, has ? 'ok' : (conn ? 'warn' : 'info'), has ? ('données chargées' + (byKind[k] ? ' · fichier connecté (' + byKind[k].name + ')' : (wbc[k] ? ' · importé (' + wbc[k].name + ')' : ' · reconnectez le fichier pour la synchro auto'))) : (conn ? 'fichier connecté mais aucune donnée lue' : 'non connecté'));
      });

      const dc = sec('Données saisies / suivies');
      add(dc, 'Suivi de paiement (factures clients)', this.payTrackRows().length ? 'ok' : 'info', this.payTrackRows().length + ' facture(s)');
      add(dc, 'Saisies achat pêcheur', 'info', this.achatSaisieRows().length + ' saisie(s)');
      add(dc, 'Saisies vente client', 'info', this.venteSaisieRows().length + ' saisie(s)');
      add(dc, 'Saisies facture fournisseur', 'info', this.fournSaisieRows().length + ' saisie(s)');
      add(dc, 'Heures — semaines pointées', 'info', Object.keys(this.state.heures || {}).length + ' semaine(s)');

      const we = sec('Écriture dans les fichiers Excel');
      this.writeableKinds().forEach(k => { const cfg = this.writeMapFor(k); const lbl = this.writeSourceLabel(k); if (!cfg) add(we, lbl, 'info', 'écriture non réglée'); else if (!cfg.enabled) add(we, lbl, 'warn', 'réglée mais EN PAUSE (rien ne s\'écrit)'); else add(we, lbl, 'ok', 'active'); });
      try { const st = await this._writeEngineSelfCheck(); add(we, 'Auto-test du moteur d\'écriture', st.ok ? 'ok' : 'warn', st.detail); } catch (e) { add(we, 'Auto-test du moteur d\'écriture', 'warn', (e && e.message) || 'échec'); }

      const co = sec('Cohérence des données');
      const inv = this.payTrackRows();
      const nums = {}; inv.forEach(r => { const n = String(r.num || '').trim(); if (n) nums[n] = (nums[n] || 0) + 1; });
      const dup = Object.keys(nums).filter(n => nums[n] > 1);
      add(co, 'Doublons de n° de facture (clients)', dup.length ? 'warn' : 'ok', dup.length ? (dup.length + ' : ' + dup.slice(0, 6).join(', ')) : 'aucun');
      const zero = inv.filter(r => !(V(r.ttc) > 0)).length;
      add(co, 'Factures clients à montant vide ou zéro', zero ? 'warn' : 'ok', zero ? (zero + ' facture(s)') : 'aucune');
      const noEtat = inv.filter(r => !String(r.etat || '').trim()).length;
      add(co, 'Factures clients sans statut', noEtat ? 'warn' : 'ok', noEtat ? (noEtat + ' facture(s)') : 'aucune');
      const allDated = inv.map(r => r.dateFac).concat(this.achatSaisieRows().map(r => r.date)).concat(this.fournSaisieRows().map(r => r.date));
      const badDate = allDated.filter(d => { const s = String(d || ''); const y = +s.slice(0, 4); return s && (y < 2015 || y > 2035); }).length;
      add(co, 'Dates suspectes (année aberrante)', badDate ? 'warn' : 'ok', badDate ? (badDate + ' ligne(s)') : 'aucune');
    } catch (e) { const o = sec('Bilan interrompu'); add(o, 'Une vérification a échoué', 'warn', (e && e.message) || 'erreur'); }

    let warns = 0; S.forEach(s => s.items.forEach(it => { if (it.status === 'warn') warns++; }));
    const n = new Date(); const stamp = `${this.dd(n.getDate())}/${this.dd(n.getMonth() + 1)}/${n.getFullYear()} à ${this.dd(n.getHours())}:${this.dd(n.getMinutes())}`;
    let text = "BILAN DE SANTÉ — Tableau de bord " + (this.entCfg().nom || '') + "\n";
    text += "Date : " + stamp + "\n";
    text += (warns === 0 ? "Résultat : tout est en ordre." : ("Résultat : " + warns + " point(s) à vérifier.")) + "\n";
    S.forEach(s => { text += "\n== " + s.title + " ==\n"; s.items.forEach(it => { const tag = it.status === 'ok' ? '[OK]  ' : it.status === 'warn' ? '[!]   ' : '[i]   '; text += tag + it.label + ' — ' + it.detail + '\n'; }); });
    text += "\n" + (warns === 0 ? "Aucune coquille détectée." : "Envoyez ce bilan pour corriger les points marqués [!].") + "\n";
    this.setState({ healthCheck: { running: false, done: true, sections: S, warns, text } });
  }
  downloadHealthReport() {
    const hc = this.state.healthCheck; if (!hc || !hc.text) return;
    try { const n = new Date(); const name = `Bilan de santé ${n.getFullYear()}-${this.dd(n.getMonth() + 1)}-${this.dd(n.getDate())} ${this.dd(n.getHours())}h${this.dd(n.getMinutes())}.txt`; const blob = new Blob([hc.text], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000); this.setState({ msg: { kind: 'ok', text: 'Bilan téléchargé : ' + name } }); } catch (e) { this.setState({ msg: { kind: 'error', text: 'Téléchargement impossible.' } }); }
  }
  copyHealthReport() { const hc = this.state.healthCheck; if (!hc || !hc.text) return; try { navigator.clipboard.writeText(hc.text); this.setState({ msg: { kind: 'ok', text: 'Bilan copié — collez-le dans un message.' } }); } catch (e) { this.setState({ msg: { kind: 'error', text: 'Copie impossible — utilisez « Télécharger ».' } }); } }
  _pwRenderVals() {
    const out = {};
    const accent = this.entCfg().accent;
    out.pwCardStyle = 'width:760px;max-width:100%;max-height:90vh;overflow:auto;background:#fff;border:1px solid #e2e8f1;border-radius:16px;box-shadow:0 30px 60px -24px rgba(14,27,46,.5);font-family:inherit;padding:22px';
    out.pwMiniStyle = 'padding:3px 11px;border-radius:7px;font-size:12px;font-weight:600;color:' + accent + ';background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    const wp = this.state.writePreview;
    const wpLocked = !!(wp && wp.status === 'error' && wp.locked); // RÈGLE 11 : fichier ouvert dans Excel → modale dédiée
    out.writePreviewOpen = !!wp && !wpLocked;
    out.fileLockedOpen = wpLocked;
    if (wpLocked) {
      out.flFileName = wp.fileName;
      out.flMessage = `Le fichier ${wp.fileName} est actuellement ouvert dans un autre programme. Fermez-le puis réessayez.`;
      out.onFlRetry = () => this.confirmAppendWrite();
      out.onFlLater = () => this.savePendingWriteLater();
      out.onFlCancel = () => this.cancelAppendWrite();
    }
    if (wp) {
      out.wpHeading = wp.kind === 'stock' ? `Remplir le stock de la semaine dans « ${wp.fileName} » ?` : wp.kind === 'cheque' ? `Compléter la ligne du chèque dans « ${wp.fileName} » ?` : wp.kind === 'annule' ? (wp.restore ? `Rétablir la ligne « ${wp.refLabel} » ?` : `Annuler la ligne « ${wp.refLabel} » ?`) : wp.kind === 'encaisse' ? `Marquer le chèque de la facture « ${wp.refLabel} » comme encaissé ?` : wp.kind === 'chqannule' ? `Annuler le chèque de la facture « ${wp.refLabel} » ?` : wp.kind === 'chqmodif' ? `Modifier le moyen de paiement de la facture « ${wp.refLabel} » ?` : wp.kind === 'paiement' ? `Enregistrer le paiement de la facture « ${wp.refLabel} » ?` : (wp.update ? `Mettre à jour le dossier ${wp.updateNum || ''} dans « ${wp.fileName} » ?` : `Ajouter cette ligne à « ${wp.fileName} » ?`);
      out.wpSubText = wp.kind === 'stock'
        ? `${wp.title || ''} — je remplis le poids et le prix par espèce/calibre. Le prix moyen se recalcule tout seul (formule non touchée). Sauvegarde datée avant l'écriture.`
        : wp.kind === 'cheque'
        ? `${wp.title || ''} — je remplis seulement les cases vides Date / Description / Montant de cette ligne déjà imprimée. Une copie de sauvegarde datée est faite avant l'écriture.`
        : wp.kind === 'annule'
        ? (wp.restore
          ? `La colonne « Annulé » de la feuille « ${wp.sheetName} » sera vidée pour cette ligne — elle redevient active et recompte dans vos totaux. Une copie de sauvegarde datée est faite avant l'écriture.`
          : `« Annulé » sera écrit dans la colonne dédiée de la feuille « ${wp.sheetName} », uniquement pour cette ligne. La ligne n'est PAS supprimée : elle reste dans votre fichier, marquée annulée, exclue de vos totaux tant qu'elle n'est pas rétablie. Une copie de sauvegarde datée est faite avant l'écriture.`)
        : wp.kind === 'encaisse'
        ? `Feuille(s) « ${wp.sheetName} » — écrit Paiement/État « PAYE » sur la ligne du chèque déjà imprimée, et solde la facture (Total payé = montant, Solde = 0). Une copie de sauvegarde datée est faite avant l'écriture.`
        : wp.kind === 'chqannule'
        ? `Feuille(s) « ${wp.sheetName} » — écrit « CANCELLED » sur la ligne du chèque (Date/Description/Montant/Paiement) et remet le fichier achat à zéro (Total payé = 0, Solde = montant initial). Une copie de sauvegarde datée est faite avant l'écriture.`
        : wp.kind === 'chqmodif'
        ? `Feuille « ${wp.sheetName} » — remplace le contenu de la colonne « Chèque » de cette ligne. Une copie de sauvegarde datée est faite avant l'écriture.`
        : wp.kind === 'paiement'
        ? `Feuille(s) « ${wp.sheetName} » — met à jour Total payé / Date de paiement / Solde de l'achat, et complète la ligne du chéquier si un chèque est utilisé. Une copie de sauvegarde datée est faite avant l'écriture.`
        : wp.update
        ? `Feuille « ${wp.sheetName} » — seules les cases du dossier sont modifiées (paiements, charges, statut). Une copie de sauvegarde datée est faite avant l'écriture.`
        : `Feuille « ${wp.sheetName} »${wp.excelRow != null ? ', ligne ' + wp.excelRow : ''}. Une copie de sauvegarde datée est faite avant l'écriture. Vos lignes existantes ne sont jamais touchées.`;
      out.wpFileName = wp.fileName; out.wpSheetName = wp.sheetName; out.wpExcelRow = wp.excelRow;
      out.wpRows = (wp.rows || []).map(r => ({ label: r.label, col: r.col, value: r.value }));
      out.wpStatus = wp.status || ''; out.wpError = wp.error || ''; out.wpBusy = wp.status === 'writing';
      out.wpBtnLabel = wp.status === 'writing' ? 'Écriture…' : (wpLocked ? '↻ Réessayer' : wp.kind === 'annule' ? (wp.restore ? 'Confirmer le rétablissement' : "Confirmer l'annulation") : wp.kind === 'encaisse' ? 'Confirmer « Encaissé »' : wp.kind === 'chqannule' ? "Confirmer l'annulation" : wp.kind === 'chqmodif' ? 'Confirmer la modification' : wp.kind === 'paiement' ? 'Confirmer le paiement' : 'Confirmer et écrire');
      out.wpConfirmStyle = wp.status === 'writing'
        ? "padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:#8ab89a;border:none;font-family:inherit;cursor:wait"
        : "padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:#15803d;border:none;cursor:pointer;font-family:inherit";
      out.onWpConfirm = () => this.confirmAppendWrite();
      out.onWpCancel = () => this.cancelAppendWrite();
    }
    const wt = this.state.writeTest;
    out.writeTestOpen = !!wt;
    if (wt) {
      const gg = '#15803d', rr = '#b91c1c';
      out.wtRunning = !!wt.running; out.wtDone = !!wt.done; out.wtHasResults = (wt.report || []).length > 0;
      out.wtReport = (wt.report || []).map(r => ({
        label: r.label, detail: r.detail, icon: r.ok ? '✓' : '✗',
        rowStyle: 'display:flex;gap:11px;align-items:flex-start;padding:9px 2px;border-top:1px solid #f1f4f8',
        iconStyle: `flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:#fff;background:${r.ok ? gg : rr}`,
      }));
      out.wtVerdict = wt.done ? (wt.passed === wt.total ? `Tout fonctionne — ${wt.passed}/${wt.total} vérifications réussies` : `${wt.passed}/${wt.total} réussies — envoyez-moi le rapport pour diagnostic`) : '';
      out.wtVerdictStyle = `padding:11px 14px;border-radius:10px;font-size:13px;font-weight:600;margin-top:14px;color:${wt.done && wt.passed === wt.total ? gg : '#b45309'};background:${wt.done && wt.passed === wt.total ? this.hexToRgba(gg, 0.1) : '#fff7ed'};border:1px solid ${wt.done && wt.passed === wt.total ? this.hexToRgba(gg, 0.25) : '#fbd9b4'}`;
      out.wtRunLabel = wt.running ? 'Test en cours…' : (wt.done ? '↻ Relancer le test' : '▶ Lancer le test');
      out.wtRunStyle = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${wt.running ? '#8aa0c8' : accent};border:none;cursor:${wt.running ? 'wait' : 'pointer'};font-family:inherit`;
      out.onWtRun = () => this.runWriteSelfTest();
      out.onWtClose = () => this.closeWriteTest();
      out.onWtDownload = () => this.downloadWriteReport();
      out.onWtCopy = () => this.copyWriteReport();
    }
    const hc = this.state.healthCheck;
    out.healthOpen = !!hc;
    if (hc) {
      const col = st => st === 'ok' ? '#15803d' : st === 'warn' ? '#b45309' : '#8291a5';
      const ic = st => st === 'ok' ? '✓' : st === 'warn' ? '!' : 'i';
      out.hcRunning = !!hc.running; out.hcDone = !!hc.done; out.hcHasResults = (hc.sections || []).length > 0;
      out.hcSections = (hc.sections || []).map(s => ({
        title: s.title,
        items: (s.items || []).map(it => ({
          label: it.label, detail: it.detail,
          icon: ic(it.status),
          iconStyle: `flex:0 0 auto;width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#fff;background:${col(it.status)}`,
          rowStyle: 'display:flex;gap:10px;align-items:flex-start;padding:7px 2px;border-top:1px solid #f4f6fa',
        })),
      }));
      out.hcVerdict = hc.done ? (hc.warns === 0 ? 'Tout est en ordre — aucune coquille détectée' : `${hc.warns} point(s) à vérifier — envoyez-moi le bilan`) : '';
      out.hcVerdictStyle = `padding:11px 14px;border-radius:10px;font-size:13px;font-weight:600;margin-top:14px;color:${hc.done && hc.warns === 0 ? '#15803d' : '#b45309'};background:${hc.done && hc.warns === 0 ? this.hexToRgba('#15803d', 0.1) : '#fff7ed'};border:1px solid ${hc.done && hc.warns === 0 ? this.hexToRgba('#15803d', 0.25) : '#fbd9b4'}`;
      out.hcRunLabel = hc.running ? 'Analyse en cours…' : (hc.done ? '↻ Relancer le bilan' : '▶ Lancer le bilan');
      out.hcRunStyle = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${hc.running ? '#8aa0c8' : accent};border:none;cursor:${hc.running ? 'wait' : 'pointer'};font-family:inherit`;
      out.onHcRun = () => this.runHealthCheck();
      out.onHcClose = () => this.closeHealthCheck();
      out.onHcDownload = () => this.downloadHealthReport();
      out.onHcCopy = () => this.copyHealthReport();
    }
    const pw = this.state.paramWrite;
    out.paramWriteOpen = !!pw;
    if (!pw) return out;
    const green = '#15803d';
    const clickHead = (pw.phase === 'mapping' || pw.phase === 'editField');
    const clickRow = (pw.phase === 'startrow' || pw.phase === 'editStart');
    const fieldLabel = k => { const f = pw.fields.find(x => x.key === k); return f ? f.label : ''; };
    out.pwHeaderCells = pw.headerCells.map(hc => {
      const mk = this._pwFieldOfCol(pw, hc.col); const isMapped = !!mk;
      let bg = '#fff', bd = '#e6ebf2', color = '#3a4a5e';
      if (isMapped) { bg = this.hexToRgba(green, 0.12); bd = '#bfe3c9'; color = green; }
      const style = `flex:0 0 auto;min-width:82px;max-width:150px;padding:7px 7px;border:1px solid ${bd};border-radius:8px;background:${bg};color:${color};font-size:11px;line-height:1.3;${clickHead ? 'cursor:pointer;' : ''}`;
      return { letter: hc.letter, label: hc.label || '(vide)', style, tag: isMapped ? fieldLabel(mk) : '', onPick: () => this.pwAssignCol(hc.col) };
    });
    out.pwSamples = pw.samples.map(sr => {
      const isStart = pw.firstDataIdx === sr.previewIdx;
      const style = `display:flex;gap:4px;align-items:center;padding:4px 5px;border:1px solid ${isStart ? green : '#eef1f6'};border-radius:8px;background:${isStart ? this.hexToRgba(green, 0.08) : '#fff'};${clickRow ? 'cursor:pointer;' : ''}`;
      return { excelRow: sr.excelRow, cells: sr.cells.map(v => ({ v: v || '' })), style, onPick: () => this.pwSetStartRow(sr.previewIdx) };
    });
    out.pwRecapWrite = pw.fields.map(f => {
      const col = this._pwColOfField(pw, f.key);
      const hdr = (col != null && pw.headerCells[col] && pw.headerCells[col].label) ? (' — ' + pw.headerCells[col].label) : '';
      return { label: f.label, mapping: col != null ? ('colonne ' + this._colLetter(col + 1) + hdr) : 'non utilisé', mapped: col != null, onEdit: () => this.pwEditField(f.key) };
    });
    out.pwStartRowLabel = pw.firstDataIdx != null ? ('ligne ' + (pw.firstDataIdx + 1)) : '—';
    out.onPwEditStart = () => this.pwEditStart();
    // bandeau invite
    if (pw.phase === 'mapping') { const f = pw.fields[pw.i]; out.pwBadge = String(pw.i + 1); out.pwPromptQ = 'Où va « ' + f.label + " » ?"; out.pwPromptSub = 'Cliquez sur la colonne de votre fichier où vous mettez cette information.'; out.pwStep = (pw.i + 1) + ' / ' + pw.fields.length; }
    else if (pw.phase === 'startrow') { out.pwBadge = '↓'; out.pwPromptQ = "À partir de quelle ligne dois-je écrire ?"; out.pwPromptSub = 'Cliquez sur la première ligne vide, sous vos en-têtes.'; out.pwStep = ''; }
    else if (pw.phase === 'editStart') { out.pwBadge = '✎'; out.pwPromptQ = "Nouvelle première ligne d'écriture ?"; out.pwPromptSub = 'Cliquez sur la bonne ligne.'; out.pwStep = ''; }
    else if (pw.phase === 'editField') { out.pwBadge = '✎'; out.pwPromptQ = 'Nouvelle colonne pour « ' + fieldLabel(pw.editKey) + " » ?"; out.pwPromptSub = 'Cliquez sur la bonne colonne. Le reste ne bouge pas.'; out.pwStep = ''; }
    else { out.pwBadge = '✓'; out.pwPromptQ = "C'est réglé — vérifiez et enregistrez."; out.pwPromptSub = 'Une erreur ? Cliquez « Modifier » sur la ligne concernée.'; out.pwStep = ''; }
    out.pwPhase = pw.phase;
    out.pwTitle = "Régler l'écriture — " + pw.label;
    out.pwFileName = pw.fileName || ''; out.pwSheetName = pw.sheetName;
    out.pwSheetOptions = (pw.sheetNames || []).map((n, i) => ({ idx: String(i), name: n }));
    out.pwSheetIdx = String(pw.sheetIdx);
    out.onPwSheet = e => this.pwSetSheet(+e.target.value);
    out.pwSelStyle = "padding:6px 10px;border:1px solid #dde3ec;border-radius:8px;font-size:12.5px;font-family:'IBM Plex Mono',monospace;color:#0e1b2e;background:#fff;max-width:260px";
    out.pwPromptDone = pw.phase === 'recap';
    out.pwShowRecap = pw.phase === 'recap';
    out.pwShowSkip = pw.phase === 'mapping';
    out.pwCanSave = pw.phase === 'recap' && pw.firstDataIdx != null;
    out.pwHeadHint = clickHead ? 'Cliquez une colonne ci-dessus' : (clickRow ? 'Cliquez une ligne ci-dessous' : '');
    out.onPwBack = () => this.pwBack(); out.onPwSkip = () => this.pwSkipField(); out.onPwRestart = () => this.pwRestart();
    out.onPwSave = () => this.pwSaveWrite(); out.onPwClose = () => this.closeParamWrite();
    out.pwPromptStyle = `display:flex;align-items:center;gap:14px;padding:13px 16px;border-radius:11px;background:${pw.phase === 'recap' ? this.hexToRgba(green, 0.1) : this.hexToRgba(accent, 0.09)};margin-bottom:14px`;
    out.pwBadgeStyle = `flex:0 0 auto;width:34px;height:34px;border-radius:9px;background:${pw.phase === 'recap' ? green : accent};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-family:'IBM Plex Mono',monospace`;
    out.pwSaveStyle = out.pwCanSave ? `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${green};border:none;cursor:pointer;font-family:inherit` : 'padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#9aa7b8;background:#eef1f6;border:none;font-family:inherit;cursor:not-allowed';
    out.pwStepStyle = "flex:0 0 auto;font-family:'IBM Plex Mono',monospace;font-size:12px;color:#69788c;background:#fff;border:1px solid #e6ebf2;border-radius:8px;padding:4px 10px";
    return out;
  }
  async confirmAppendWrite() {
    const pw = this._pendingWrite; if (!pw) { this.setState({ writePreview: null }); return; }
    console.log('[confirm] kind:', pw.kind, 'step:', pw.step);
    this.setState(s => s.writePreview ? { writePreview: { ...s.writePreview, status: 'writing' } } : {});
    try {
      // 1) CONTRÔLE DE CONCURRENCE : le fichier a-t-il changé depuis l'aperçu ? (travail à plusieurs)
      let buf = pw.buf;
      if (pw.fingerprint != null) {
        const f2 = await pw.handle.getFile();
        const fp2 = (f2.lastModified || 0) + '/' + (f2.size || 0);
        if (fp2 !== pw.fingerprint) { this._pendingWrite = null; this.setState({ writePreview: null, msg: { kind: 'error', text: `Le fichier « ${pw.name} » a été modifié depuis l'aperçu (peut-être par une autre personne). Rien n'a été écrit — actualisez (⟳ Rafraîchir) puis recommencez.` } }); return; }
        buf = await f2.arrayBuffer(); // on écrit sur la version fraîche, identique à l'aperçu
      }
      // 2) SAUVEGARDE OBLIGATOIRE avant écriture (RÈGLE 12 : pas de sauvegarde → pas d'écriture)
      const bak = await this._backupBeforeWrite(pw.name, buf);
      if (!bak || !bak.ok) throw new Error('sauvegarde de sécurité impossible — écriture annulée pour ne rien risquer');
      // 3) ÉCRITURE (garde anti-formule sur le chemin patch)
      let patched;
      if (pw.editsBySheet) patched = await this.patchXlsxFile(buf, pw.editsBySheet, { refuseFormula: pw.refuseFormula, markStyle: true, allowFormulaCols: pw.allowFormulaCols }); // écriture multi-feuilles (stock)
      else if (pw.mode === 'append') patched = await this._appendXlsxRow(buf, pw.sheetName, pw.excelRow, pw.colVals);
      else { const edits = {}; edits[pw.sheetName] = {}; Object.keys(pw.colVals).forEach(ci => { edits[pw.sheetName][pw.previewIdx + ':' + ci] = pw.colVals[ci]; }); patched = await this.patchXlsxFile(buf, edits, { refuseFormula: pw.refuseFormula, markStyle: true, allowFormulaCols: pw.allowFormulaCols }); }
      const patchedBuf = await patched.arrayBuffer();
      // 4) RELECTURE DE CONTRÔLE (avant même d'écrire le disque : on vérifie le blob produit)
      const wbChk = await this.readWorkbook(patchedBuf.slice(0));
      const mismatches = [];
      const skippedCols = patched._skippedFormulaCols || {}; // colonnes ignorées (formule) : exclues de la vérification
      if (pw.editsBySheet) {
        (pw.verifyTargets || []).forEach(t => { if (skippedCols[t.sheetName] && skippedCols[t.sheetName].has(t.col)) return; const sh = wbChk.find(s => s.name === t.sheetName); const got = (sh && sh.rows[t.rowIdx]) ? sh.rows[t.rowIdx][t.col] : ''; const exp = String(t.val); const g = String(got == null ? '' : got); if (exp !== g && !(this._vNum(exp) === this._vNum(g) && exp !== '' && g !== '')) mismatches.push(`${t.sheetName}!${this._colLetter(t.col + 1)}${t.rowIdx + 1} attendu ${exp} ≠ lu ${g}`); });
      } else {
        const shChk = wbChk.find(s => s.name === pw.sheetName);
        const rowChk = shChk ? (shChk.rows[pw.previewIdx] || []) : [];
        const skippedHere = skippedCols[pw.sheetName];
        Object.keys(pw.colVals).forEach(ci => { if (skippedHere && skippedHere.has(+ci)) return; const exp = String(pw.colVals[ci]); const got = String(rowChk[+ci] == null ? '' : rowChk[+ci]); if (exp !== got && !(this._vNum(exp) === this._vNum(got) && exp !== '' && got !== '')) mismatches.push(this._colLetter(+ci + 1) + ' attendu ' + exp + ' ≠ lu ' + got); });
      }
      if (mismatches.length) throw new Error('vérification échouée (' + mismatches.slice(0, 4).join(' ; ') + ')');
      // 5) ÉCRITURE DISQUE — RÈGLE 11 : si le fichier est ouvert/verrouillé dans Excel, on le signale
      let w; try { w = await pw.handle.createWritable(); await w.write(patched); await w.close(); }
      catch (we) { const err = new Error(`le fichier est peut-être ouvert dans Excel (${(we && we.message) || 'accès refusé'}) — fermez-le puis Réessayer`); err.locked = true; throw err; }
      // 6) le watcher relira le fichier écrit → la vue se met à jour depuis Excel (source de vérité)
      try { const wm = this._watched || {}; for (const k of Object.keys(wm)) if (wm[k] && wm[k].handle === pw.handle) wm[k].lastMod = 0; } catch (e) {}
      if (pw.step && this._achatSteps) this._achatSteps[pw.step] = 'ok'; // RÈGLE 8/13 : étape réussie
      if (pw.after) { try { await pw.after(patchedBuf); } catch (e) {} }
      this._pendingWrite = null;
      const bakMsg = bak && bak.ok ? ` — sauvegarde : ${bak.bakName}` : '';
      const okTxt = pw.excelRow == null ? `✓ « ${pw.name} » mis à jour (feuille « ${pw.sheetName} ») — relu et vérifié${bakMsg}.` : `✓ Écrit dans « ${pw.name} » (feuille « ${pw.sheetName} », ligne ${pw.excelRow}) — relu et vérifié${bakMsg}.`;
      this.setState({ writePreview: null, msg: { kind: 'ok', text: okTxt } });
      // Déclenché APRÈS la fermeture de cette modale (jamais de course sur writePreview avec un
      // aperçu ouvert par ce hook, ex. le stock après une vente) : ordre garanti par construction,
      // contrairement à un délai fixe (setTimeout) dont la durée ne serait jamais certaine.
      if (pw.afterClose) { try { pw.afterClose(); } catch (e) {} }
      this._maybeFinalizeAchat();
    } catch (e) {
      // RÈGLE 14 : erreur détaillée (fichier, feuille, ligne) ; RÈGLE 11 : garder la saisie prête si verrouillé.
      const locked = !!(e && e.locked);
      const where = `${pw.sheetName ? 'feuille « ' + pw.sheetName + ' »' : ''}${pw.excelRow != null ? ', ligne ' + pw.excelRow : ''}`;
      const detail = `Écriture impossible — « ${pw.name} »${where ? ' · ' + where : ''} : ${(e && e.message) || 'échec'}. Aucun fichier n'a été modifié.`;
      if (!locked) this._pendingWrite = null; // verrouillé → on conserve _pendingWrite pour « Réessayer »
      if (!locked && pw.step && this._achatSteps) { this._achatSteps[pw.step] = 'fail'; this._maybeFinalizeAchat(); } // RÈGLE 8/13 : étape en échec
      this.setState(s => s.writePreview ? { writePreview: { ...s.writePreview, status: 'error', locked, error: detail } } : { msg: { kind: 'error', text: detail } });
    }
  }

  editFpCell(r, c, val) {
    const fp = this.state.filePreview; if (!fp || !fp.wb || !fp.wb[fp.si]) return;
    const wb = fp.wb.map((s, i) => i !== fp.si ? s : { ...s, rows: s.rows.map((row, ri) => { if (ri !== r) return row; const nr = row.slice(); nr[c] = val; return nr; }) });
    // Suivi précis des cellules éditées, par NOM de feuille (l'index d'onglet n'est pas fiable :
    // les feuilles vides sont absentes de l'aperçu mais présentes dans le fichier).
    const sheetName = fp.wb[fp.si].name;
    const edits = { ...(fp.edits || {}) };
    edits[sheetName] = { ...(edits[sheetName] || {}), [r + ':' + c]: val };
    this.setState({ filePreview: { ...fp, wb, edits, dirty: true, closeWarn: false, saveState: this._previewHandle ? 'saving' : 'dirty' } });
    clearTimeout(this._fpTimer);
    this._fpTimer = setTimeout(() => this.saveFilePreview(), 600);
  }
  async saveFilePreview() {
    const fp = this.state.filePreview; if (!fp || !fp.dirty) return;
    if (!this._previewHandle) return; // pas d'accès en écriture : la personne doit cliquer « Télécharger » (voir onFpDownload)
    try {
      // Patch en place : le fichier original est conservé octet pour octet (formules, styles,
      // autres feuilles), seules les cellules éditées changent. En cas d'échec, RIEN n'est écrit —
      // jamais de réécriture destructive de repli.
      if (!this._previewBlob) throw new Error('fichier original indisponible — rouvrez le fichier');
      const orig = await this._previewBlob.arrayBuffer();
      const patched = await this.patchXlsxFile(orig, fp.edits || {});
      const w = await this._previewHandle.createWritable();
      await w.write(patched); await w.close();
      this._previewBlob = patched; // les éditions suivantes repartent de la version écrite
      const n = new Date();
      this.setState(s => s.filePreview ? { filePreview: { ...s.filePreview, dirty: false, edits: {}, saveState: 'saved', savedAt: `${this.dd(n.getHours())}:${this.dd(n.getMinutes())}:${this.dd(n.getSeconds())}` } } : {});
    } catch (e) {
      this.setState(s => s.filePreview ? { filePreview: { ...s.filePreview, saveState: 'error', saveError: ((e && e.message) || 'échec de la sauvegarde') + ' — le fichier n’a pas été modifié' } } : {});
    }
  }
  // ---------- sauvegarde complète (archive .zip : copie de l'appli + données + fichiers Excel) ----------
  async pickBackupFolder() {
    if (!('showDirectoryPicker' in window)) { this.setState({ msg: { kind: 'error', text: "La sauvegarde vers un dossier fonctionne sur Chrome ou Edge (ordinateur)." } }); return null; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this._backupDir = dir;
      this.idbSet('dir:backup', { type: 'dir', role: 'backup', handle: dir });
      this.setState({ backupFolderName: dir.name });
      return dir;
    } catch (e) { return null; }
  }
  async changeBackupFolder() { await this.pickBackupFolder(); }
  async runBackup() {
    let dir = this._backupDir;
    if (!dir) dir = await this.pickBackupFolder();
    if (!dir) return;
    this.setState({ backupStatus: 'saving', backupError: null });
    try {
      let perm = dir.queryPermission ? await dir.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (perm !== 'granted' && dir.requestPermission) perm = await dir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error("permission d'écriture refusée sur le dossier de sauvegarde");
      const blob = await this.buildBackupZip();
      const n = new Date();
      const entNomFichier = this.entCfg().nom.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Faustine';
      const name = `Sauvegarde Dashboard ${entNomFichier} - ${n.getFullYear()}-${this.dd(n.getMonth() + 1)}-${this.dd(n.getDate())} ${this.dd(n.getHours())}h${this.dd(n.getMinutes())}.zip`;
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      this.setState({ backupStatus: 'saved', backupLast: name });
    } catch (e) {
      this.setState({ backupStatus: 'error', backupError: (e && e.message) || 'échec de la sauvegarde' });
    }
  }
  async buildBackupZip() {
    const enc = new TextEncoder();
    const entries = [];
    try {
      const res = await fetch(location.href);
      entries.push({ name: 'Dashboard Achat-Vente.html', bytes: new Uint8Array(await res.arrayBuffer()) });
    } catch (e) {
      try { entries.push({ name: 'Dashboard Achat-Vente.html', bytes: enc.encode('<!doctype html>\n' + document.documentElement.outerHTML) }); } catch (e2) {}
    }
    const state = {};
    Object.keys(localStorage).filter(k => k.startsWith('av')).forEach(k => { state[k] = localStorage.getItem(k); });
    entries.push({ name: 'donnees/etat.json', bytes: enc.encode(JSON.stringify(state, null, 2)) });
    const seen = {};
    const addHandle = async (name, handle) => {
      if (!handle || !handle.getFile || !name || seen[name]) return; seen[name] = true;
      try { const file = await handle.getFile(); entries.push({ name: 'donnees/' + name, bytes: new Uint8Array(await file.arrayBuffer()) }); } catch (e) {}
    };
    for (const w of Object.values(this._watched || {})) await addHandle(w.name, w.handle);
    for (const [name, h] of Object.entries(this._stockHandles || {})) await addHandle(name, h);
    for (const [name, h] of Object.entries(this._blHandles || {})) await addHandle(name, h);
    for (const [name, h] of Object.entries(this._transpHandles || {})) await addHandle(name, h);
    for (const c of Object.values(this._wbCache || {})) {
      if (!c || !c.name || seen[c.name]) continue;
      try { const blob = await this.buildXlsxBlob(c.wb); entries.push({ name: 'donnees/' + c.name, bytes: new Uint8Array(await blob.arrayBuffer()) }); seen[c.name] = true; } catch (e) {}
    }
    const readme = `SAUVEGARDE — Dashboard Faustine\nCréée le ${new Date().toLocaleString('fr-FR')}\n\nContenu de cette archive :\n- Dashboard Achat-Vente.html : une copie complète du tableau de bord, prête à ouvrir sur n'importe quel ordinateur (double-clic, hors ligne).\n- donnees/etat.json : toutes vos données du tableau de bord (imports, crédits, observations, heures, catégories bancaires, réglages…).\n- donnees/*.xlsx : une copie de vos fichiers Excel connectés au moment de la sauvegarde.\n\nPour tout récupérer :\n1. Ouvrez « Dashboard Achat-Vente.html » (double-clic, dans Chrome ou Edge).\n2. Allez dans Paramètres → Sauvegarde complète → « Restaurer une sauvegarde… » et choisissez ce fichier .zip.\n3. Vos fichiers Excel sont aussi disponibles individuellement dans le dossier donnees/ si vous voulez juste les récupérer bruts.\n`;
    entries.push({ name: 'LISEZMOI.txt', bytes: enc.encode(readme) });
    return this.zipBuild(entries, 'application/zip');
  }
  // ---------- export de suivi : un seul tableau Excel cumulé, une ligne par période ----------
  // En-têtes des colonnes du fichier de suivi (l'ordre fait foi pour relire/réécrire).
  static SUIVI_COLS = ['Période', 'Clé', 'CA ventes (€)', 'Achats pêcheurs (€)', 'Marge brute (€)', 'Taux de marge (%)', 'Nb ventes', 'Nb achats', 'Stock valorisé (€)', 'Trésorerie nette (€)', 'On me doit (€)', 'Je dois (€)', 'En retard à relancer (€)', 'Mensualités crédit (€)', 'Capital restant dû (€)', 'Dernière mise à jour'];
  suiviFileName() { const n = this.entCfg().nom.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Faustine'; return `Suivi Dashboard ${n}.xlsx`; }
  async pickSuiviFolder() {
    if (!('showDirectoryPicker' in window)) { this.setState({ msg: { kind: 'error', text: "L'export de suivi vers un dossier fonctionne sur Chrome ou Edge (ordinateur)." } }); return null; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this._suiviDir = dir;
      this.idbSet('dir:suivi', { type: 'dir', role: 'suivi', handle: dir });
      this.setState({ suiviFolderName: dir.name });
      return dir;
    } catch (e) { return null; }
  }
  async changeSuiviFolder() { await this.pickSuiviFolder(); }
  // Relit le tableau de suivi existant → map { clé : ligne (tableau de cellules) }, en respectant l'ordre des colonnes.
  async readSuiviExisting(dir) {
    try {
      const fh = await dir.getFileHandle(this.suiviFileName(), { create: false });
      const file = await fh.getFile();
      const wb = await this.readWorkbook(await file.arrayBuffer());
      const rows = (wb && wb[0] && wb[0].rows) || [];
      if (!rows.length) return {};
      const head = rows[0].map(c => String(c == null ? '' : c).trim());
      const keyCol = head.indexOf('Clé');
      const map = {};
      for (let i = 1; i < rows.length; i++) { const r = rows[i]; if (!r) continue; const k = keyCol >= 0 ? String(r[keyCol] == null ? '' : r[keyCol]).trim() : ''; if (k) map[k] = r; }
      return map;
    } catch (e) { return {}; } // fichier absent ou illisible → on repart d'un tableau neuf
  }
  async runSuivi() {
    let dir = this._suiviDir;
    if (!dir) dir = await this.pickSuiviFolder();
    if (!dir) return;
    const d = this._suiviData;
    if (!d) { this.setState({ suiviStatus: 'error', suiviError: "aucune donnée à exporter pour le moment" }); return; }
    this.setState({ suiviStatus: 'saving', suiviError: null });
    try {
      let perm = dir.queryPermission ? await dir.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (perm !== 'granted' && dir.requestPermission) perm = await dir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error("permission d'écriture refusée sur le dossier de suivi");
      const map = await this.readSuiviExisting(dir);
      const n = new Date();
      const stamp = `${n.getFullYear()}-${this.dd(n.getMonth() + 1)}-${this.dd(n.getDate())} ${this.dd(n.getHours())}h${this.dd(n.getMinutes())}`;
      // La ligne de la période courante est créée ou remplacée (pas de doublon).
      map[d.periodSort] = [d.periodLabel, d.periodSort, d.ca, d.achats, d.marge, d.taux, d.nbV, d.nbA, d.stockValo, d.treso, d.onMeDoit, d.jeDois, d.enRetard, d.mensualites, d.capitalDu, stamp];
      const keys = Object.keys(map).sort();
      const rows = [Component.SUIVI_COLS.slice(), ...keys.map(k => map[k])];
      const blob = await this.buildXlsxBlob([{ name: 'Suivi', rows }]);
      const fh = await dir.getFileHandle(this.suiviFileName(), { create: true });
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      this.setState({ suiviStatus: 'saved', suiviLast: `${d.periodLabel} — ${keys.length} période${keys.length > 1 ? 's' : ''} suivie${keys.length > 1 ? 's' : ''}` });
    } catch (e) {
      this.setState({ suiviStatus: 'error', suiviError: (e && e.message) || "échec de l'export de suivi" });
    }
  }
  // ---------- restauration d'une sauvegarde ----------
  async pickRestoreFile() {
    let file = null;
    if (window.showOpenFilePicker) {
      try { const [h] = await window.showOpenFilePicker({ types: [{ description: 'Sauvegarde', accept: { 'application/zip': ['.zip'] } }] }); file = await h.getFile(); }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (!file) file = await new Promise(res => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip'; inp.onchange = () => res(inp.files && inp.files[0]); inp.click(); });
    if (!file) return;
    this.setState({ restoreStatus: 'reading', restoreError: null });
    try {
      const buf = await file.arrayBuffer();
      const files = await this.unzipAll(buf);
      const etatBytes = files['donnees/etat.json'];
      if (!etatBytes) throw new Error("fichier « donnees/etat.json » introuvable dans cette archive — ce n'est pas une sauvegarde valide.");
      const state = this.validateRestoreState(JSON.parse(new TextDecoder().decode(etatBytes)));
      const xlsxNames = Object.keys(files).filter(n => /\.(xlsx|xlsm)$/i.test(n) && n.startsWith('donnees/'));
      this._restoreFiles = files;
      this.setState({
        restoreStatus: null,
        restorePreview: { name: file.name, keyCount: Object.keys(state).length, xlsxFiles: xlsxNames.map(n => n.replace(/^donnees\//, '')), state },
      });
    } catch (e) {
      this.setState({ restoreStatus: 'error', restoreError: (e && e.message) || 'archive illisible' });
    }
  }
  cancelRestore() { this._restoreFiles = null; this.setState({ restorePreview: null, restoreStatus: null }); }
  validateRestoreState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('état de sauvegarde invalide');
    const entries = Object.entries(state);
    if (entries.length > Component.RESTORE_KEYS.size) throw new Error('trop de clés dans la sauvegarde');
    let total = 0;
    for (const [k, v] of entries) {
      if (!Component.RESTORE_KEYS.has(k)) throw new Error(`clé non autorisée dans la sauvegarde : ${k}`);
      if (typeof v !== 'string') throw new Error(`valeur invalide pour ${k}`);
      total += v.length;
      if (v.length > 10 * 1024 * 1024 || total > 30 * 1024 * 1024) throw new Error('données de sauvegarde trop volumineuses');
    }
    return Object.fromEntries(entries);
  }
  confirmRestore() {
    const rp = this.state.restorePreview; if (!rp) return;
    try {
      Object.keys(localStorage).filter(k => k.startsWith('av')).forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
      Object.entries(rp.state).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} });
    } catch (e) {}
    location.reload();
  }
  downloadRestoreFile(name) {
    const files = this._restoreFiles; if (!files) return;
    const bytes = files['donnees/' + name]; if (!bytes) return;
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async unzipXlsx(buf) {
    const b = new Uint8Array(buf); let eo = -1;
    for (let i = b.length - 22; i >= 0; i--) { if (b[i] === 80 && b[i + 1] === 75 && b[i + 2] === 5 && b[i + 3] === 6) { eo = i; break; } }
    if (eo < 0) throw new Error('archive illisible');
    const dv = new DataView(b.buffer); const n = dv.getUint16(eo + 10, true); let p = dv.getUint32(eo + 16, true); const ent = [];
    for (let i = 0; i < n; i++) { if (dv.getUint32(p, true) !== 0x02014b50) break; const meth = dv.getUint16(p + 10, true), cs = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true); const nm = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl)); ent.push({ nm, meth, cs, lho }); p += 46 + nl + el + cl; }
    const out = {};
    for (const e of ent) { if (!/sheet\d+\.xml$|sharedStrings\.xml$|workbook\.xml$|workbook\.xml\.rels$/.test(e.nm)) continue; const lp = e.lho; const nl = dv.getUint16(lp + 26, true), el = dv.getUint16(lp + 28, true); const st = lp + 30 + nl + el; const comp = b.subarray(st, st + e.cs); let raw; if (e.meth === 0) raw = comp; else if (e.meth === 8) raw = await this.inflate(comp); else continue; out[e.nm] = new TextDecoder().decode(raw); }
    return out;
  }
  // ---------- lecture ZIP générique (toutes les entrées, sans filtre — pour restaurer une sauvegarde) ----------
  async unzipAll(buf) {
    const b = new Uint8Array(buf); let eo = -1;
    if (b.length > 100 * 1024 * 1024) throw new Error('archive trop volumineuse (100 Mo maximum)');
    for (let i = b.length - 22; i >= 0; i--) { if (b[i] === 80 && b[i + 1] === 75 && b[i + 2] === 5 && b[i + 3] === 6) { eo = i; break; } }
    if (eo < 0) throw new Error('archive illisible');
    const dv = new DataView(b.buffer); const n = dv.getUint16(eo + 10, true); let p = dv.getUint32(eo + 16, true); const ent = [];
    if (n > 200) throw new Error('archive contenant trop de fichiers (200 maximum)');
    let totalRaw = 0;
    for (let i = 0; i < n; i++) {
      if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('table ZIP invalide');
      const meth = dv.getUint16(p + 10, true), cs = dv.getUint32(p + 20, true), us = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      if (p + 46 + nl + el + cl > b.length) throw new Error('entrée ZIP tronquée');
      const nm = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
      if (!nm || nm.startsWith('/') || nm.includes('..') || nm.includes('\\')) throw new Error('nom de fichier dangereux dans la sauvegarde');
      totalRaw += us;
      if (us > 100 * 1024 * 1024 || totalRaw > 250 * 1024 * 1024 || (cs > 0 && us / cs > 200)) throw new Error('contenu décompressé trop volumineux');
      ent.push({ nm, meth, cs, us, lho }); p += 46 + nl + el + cl;
    }
    const out = {};
    for (const e of ent) { if (/\/$/.test(e.nm)) continue; const lp = e.lho; if (lp + 30 > b.length || dv.getUint32(lp, true) !== 0x04034b50) throw new Error('entrée ZIP locale invalide'); const nl = dv.getUint16(lp + 26, true), el = dv.getUint16(lp + 28, true); const st = lp + 30 + nl + el; if (st + e.cs > b.length) throw new Error('données ZIP tronquées'); const comp = b.subarray(st, st + e.cs); let raw; if (e.meth === 0) raw = comp; else if (e.meth === 8) raw = await this.inflate(comp); else throw new Error('méthode de compression non prise en charge'); if (raw.length !== e.us) throw new Error('taille décompressée incohérente'); out[e.nm] = raw; }
    return out;
  }
  async xlsxToText(buf, opts) {
    opts = opts || {};
    const files = await this.unzipXlsx(buf); const ss = [];
    const ssx = files['xl/sharedStrings.xml'];
    if (ssx) { const re = /<si>([\s\S]*?)<\/si>/g; let m; while (m = re.exec(ssx)) { const t = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''); ss.push(this.unxml(t)); } }
    const coln = r => { const mm = r.match(/^([A-Z]+)/); let v = 0; for (const c of mm[1]) v = v * 26 + (c.charCodeAt(0) - 64); return v; };
    const sheetRows = xml => {
      const rows = []; const rr = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
      while (rm = rr.exec(xml)) {
        const cells = {}; let mx = 0;
        // Lire séparément les attributs et le contenu évite de perdre les valeurs calculées
        // des cellules de formule de type texte (t="str"), très utilisées dans le suivi des paiements.
        const cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
        while (cm = cr.exec(rm[1])) {
          const refM = cm[1].match(/\br="([A-Z]+\d+)"/); if (!refM) continue;
          const typeM = cm[1].match(/\bt="([^"]+)"/); const typ = typeM ? typeM[1] : '';
          const ci = coln(refM[1]); mx = Math.max(mx, ci);
          const body = cm[2] || ''; const vm = body.match(/<v>([\s\S]*?)<\/v>/); const im = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
          let val = '';
          if (im) val = this.unxml(im[1]);
          else if (vm) val = typ === 's' ? (ss[+vm[1]] || '') : this.unxml(vm[1]);
          cells[ci] = val;
        }
        const arr = []; for (let i = 1; i <= mx; i++) arr.push(cells[i] !== undefined ? cells[i] : ''); rows.push(arr);
      }
      return rows;
    };
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const KW = ['date', 'montant', 'fournisseur', 'client', 'facture', 'paiement', 'paiment', 'semaine', 'solde', 'denomination', 'mensualite', 'prix', 'poids', 'destinataire', 'bordereau', 'total'];
    // nom de chaque feuille (workbook.xml) -> fichier worksheet (via rels)
    const wb = files['xl/workbook.xml'] || ''; const relsx = files['xl/_rels/workbook.xml.rels'] || '';
    const relMap = this._relMapOf(relsx);
    const nameByKey = {};
    [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].forEach(m => { const tgt = relMap[m[2]]; if (tgt) nameByKey[tgt] = this.unxml(m[1]); });
    const keys = Object.keys(files).filter(k => /xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));
    const parsed = keys.map(k => {
      const rows = sheetRows(files[k]);
      let hi = 0, hsc = -1;
      for (let i = 0; i < Math.min(rows.length, 20); i++) { const sc = rows[i].map(norm).filter(c => c && KW.some(w => c.includes(w))).length; if (sc > hsc) { hsc = sc; hi = i; } }
      const sig = rows[hi] ? rows[hi].map(norm).filter(Boolean).join('|') : '';
      const dataCount = rows.slice(hi + 1).filter(r => r.some(c => String(c).trim())).length;
      return { rows, hi, hsc, sig, dataCount, name: norm(nameByKey[k] || '') };
    }).filter(p => p.hsc > 0);
    if (!parsed.length) throw new Error('aucune feuille exploitable');
    // 1) ciblage par NOM de feuille (déterministe pour tes classeurs)
    let pool = parsed;
    if (opts.prefer) { const named = parsed.filter(p => opts.prefer.test(p.name)); if (named.length) pool = named; }
    if (opts.avoid) { const kept = pool.filter(p => !opts.avoid.test(p.name)); if (kept.length) pool = kept; }
    // 2) si agrégation (ex : 12 onglets mensuels), concat toutes les feuilles du pool qui partagent l'en-tête le plus riche
    if (opts.aggregate && pool.length > 1) {
      const groups = {}; pool.forEach(p => (groups[p.sig] = groups[p.sig] || []).push(p));
      const grp = Object.values(groups).sort((a, b) => (b[0].hsc - a[0].hsc) || (b.length - a.length))[0];
      const hdr = grp[0].rows[grp[0].hi]; const data = [];
      grp.forEach(p => p.rows.slice(p.hi + 1).forEach(r => { if (r.some(c => String(c).trim())) data.push(r); }));
      return this.foldBlocks(hdr, data, norm);
    }
    // 3) sinon : la feuille la plus riche (en-tête le plus fourni, puis le plus de données)
    const best = pool.slice().sort((a, b) => (b.hsc - a.hsc) || (b.dataCount - a.dataCount))[0];
    return this.foldBlocks(best.rows[best.hi], best.rows.slice(best.hi + 1).filter(r => r.some(c => String(c).trim())), norm);
  }
  // déplie deux tableaux placés côte à côte (ex : FOURNISSEURS | FOURNISSEURS CRUSTACE) en une seule liste
  foldBlocks(hdr, data, norm) {
    const cells = hdr.map(norm);
    const nz = cells.map((c, i) => c ? i : -1).filter(i => i >= 0);
    let folded = null;
    if (nz.length >= 4 && nz.length % 2 === 0) {
      const half = nz.length / 2; const a = nz.slice(0, half), b = nz.slice(half);
      const sameLabels = a.every((idx, k) => cells[idx] === cells[b[k]]);
      const disjoint = b[0] > a[half - 1];
      if (sameLabels && disjoint) folded = { a, b };
    }
    if (!folded) { const out = [hdr.join('\t')]; data.forEach(r => out.push(r.join('\t'))); return out.join('\n'); }
    const pick = (r, idxs) => idxs.map(i => r[i] !== undefined ? r[i] : '');
    const out = [pick(hdr, folded.a).join('\t')];
    data.forEach(r => { const A = pick(r, folded.a), B = pick(r, folded.b); if (A.some(c => String(c).trim())) out.push(A.join('\t')); if (B.some(c => String(c).trim())) out.push(B.join('\t')); });
    return out.join('\n');
  }
  sheetOpts(kind) {
    if (kind === 'operations') return { prefer: /facturation|suivi|recap/, avoid: /^\d[\d\s]*$|graphique|bat/ };
    if (kind === 'stock') return { prefer: /recap|synth/ };
    if (kind === 'factures') return { prefer: /janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre/, avoid: /graphique|recap/, aggregate: true };
    if (kind === 'credits') return { prefer: /feuil|mensualit|credit|assur/ };
    if (kind === 'bordereaux') return { prefer: /border|livrais|recap|suivi/ };
    return {};
  }
  async fileToText(file, kind) { if (/\.(xlsx|xlsm)$/i.test(file.name)) { const buf = await file.arrayBuffer(); return await this.xlsxToText(buf, this.sheetOpts(kind)); } return await file.text(); }

  // ---------- crédits / assurances ----------
  mapCredits(text) {
    const { rows, find } = this.parseTable(text);
    const ci = { label: find('denomination', 'libelle', 'intitule', 'designation', 'nom'), type: find('type', 'nature'), ent: find('entreprise', 'organisme', 'banque'), total: find('montant total', 'total', 'capital'), mens: find('mensualite', 'echeance mensuelle', 'par mois'), rest: find('restant', 'reste', 'solde', 'du'), paid: find('paye', 'regle', 'rembourse') };
    if (ci.total < 0 && ci.mens < 0) return { list: [], error: 'colonnes « Montant total » ou « Mensualité » introuvables' };
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const list = rows.filter(f => (ci.label >= 0 && f[ci.label]) || (ci.total >= 0 && this.parseAmount(f[ci.total]))).map((f, i) => { const total = ci.total >= 0 ? (this.parseAmount(f[ci.total]) || 0) : 0; const rest = ci.rest >= 0 ? (this.parseAmount(f[ci.rest]) || 0) : 0; const paid = ci.paid >= 0 ? (this.parseAmount(f[ci.paid]) || 0) : Math.max(0, total - rest); const t = ci.type >= 0 ? norm(f[ci.type]) : norm((ci.label >= 0 && f[ci.label]) || ''); return { label: (ci.label >= 0 && f[ci.label]) || ('Engagement ' + (i + 1)), ent: (ci.ent >= 0 && f[ci.ent]) || '—', type: t.includes('assur') ? 'Assurance' : 'Crédit', mens: ci.mens >= 0 ? (this.parseAmount(f[ci.mens]) || 0) : 0, total, rest: ci.rest >= 0 ? rest : Math.max(0, total - paid), paid: Math.max(0, Math.min(total || paid, paid)), next: '2026-07-31' }; });
    return { list };
  }

  fallbackCopy(txt) { try { const ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok; } catch (e) { return false; } }
  removeObservation(id) { const list = (this.state.observations || []).filter(o => o.id !== id); this.setState({ observations: list }); this.saveJSON(Component.OBS_KEY, list); }
  // ---------- Assistant erreur (carnet de coquilles) : « j'ai … au lieu de … » ----------
  toggleErrPanel() { this.setState({ errPanelOpen: !this.state.errPanelOpen }); }
  addErrNote() {
    const a = String(this.state.errAvant || '').trim(); const b = String(this.state.errApres || '').trim();
    if (!a && !b) { this.setState({ msg: { kind: 'error', text: 'Remplissez au moins un des deux champs (« j\'ai … » ou « au lieu de … »).' } }); return; }
    const o = { id: Date.now(), avant: a, apres: b, where: this.state.view, when: `${this.dd(Component.TODAY.d)}/${this.dd(Component.TODAY.m)}/${Component.TODAY.y}` };
    const list = [o, ...(this.state.observations || [])];
    this.setState({ observations: list, errAvant: '', errApres: '' }); this.saveJSON(Component.OBS_KEY, list);
  }
  copyErrReport() {
    const list = this.state.observations || []; if (!list.length) return;
    const lines = list.map((o, i) => `${i + 1}. J'ai ${o.avant || '—'} au lieu de ${o.apres || '—'}   (page : ${o.where || '—'}${o.when ? ' · ' + o.when : ''})`);
    const txt = `CARNET D'ERREURS — ${this.entCfg().nom} (${list.length})\n\n${lines.join('\n')}`;
    const done = ok => { this.setState({ errCopied: ok ? 'ok' : 'err' }); clearTimeout(this._errCopyT); this._errCopyT = setTimeout(() => this.setState({ errCopied: null }), 2000); };
    try { navigator.clipboard.writeText(txt).then(() => done(true), () => done(this.fallbackCopy(txt))); } catch (e) { done(this.fallbackCopy(txt)); }
  }
  // Une écriture qui échoue (stockage plein/bloqué) est signalée une fois à l'utilisatrice —
  // sinon les données semblent enregistrées mais disparaissent au prochain rechargement.
  saveJSON(k, o) {
    try { localStorage.setItem(k, JSON.stringify(o)); }
    catch (e) {
      console.error('[saveJSON]', k, e);
      if (!this._quotaWarned) {
        this._quotaWarned = true;
        try { this.setState({ msg: { kind: 'error', text: `Impossible d'enregistrer (${k}) : le stockage du navigateur est plein ou bloqué. Vos modifications ne seront PAS conservées au prochain rechargement — faites une Sauvegarde complète (bouton en haut), puis réinitialisez les anciennes données depuis Paramètres.` } }); } catch (e2) {}
      }
    }
  }
  openUrl(u) { if (!u) return false; let url = String(u).trim(); if (!url) return false; if (!/^(https?:|mailto:|file:)/i.test(url)) url = 'https://' + url; try { window.open(url, '_blank', 'noopener'); return true; } catch (e) { return false; } }
  // Demande au serveur local (server.py) d'ouvrir un fichier dans son application par défaut
  // (Excel pour un .xlsx). Ne fonctionne que servi depuis ce serveur local — pas en file://.
  async openInExcel(path) {
    try {
      const res = await fetch('/open-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `échec (HTTP ${res.status})`);
      return true;
    } catch (e) {
      this.setState({ msg: { kind: 'error', text: `Impossible d'ouvrir « ${path} » dans Excel : ${(e && e.message) || 'erreur inconnue'}.` } });
      return false;
    }
  }
  saveFilePaths(m) { this.setState({ filePaths: m }); this.saveJSON(Component.FILEPATHS_KEY, m); }
  // Bouton « Ouvrir dans Excel » (Paramètres) : la File System Access API ne donne jamais le
  // chemin absolu d'un fichier (par sécurité navigateur) — on le demande une fois et on le
  // mémorise par source, pour les prochains clics.
  openSourceInExcel(kind, label) {
    const paths = this.state.filePaths || {};
    let path = paths[kind];
    if (!path) {
      path = (window.prompt(`Chemin complet du fichier « ${label} » sur cet ordinateur :`, '') || '').trim();
      if (!path) return;
      this.saveFilePaths({ ...paths, [kind]: path });
    }
    this.openInExcel(path);
  }
  setLink(key, val) { const links = { ...(this.state.links || {}) }; links[key] = val; this.setState({ links }); this.saveJSON(Component.LINKS_KEY, links); }
  setModel(key, val) { const models = { ...(this.state.models || {}) }; models[key] = val; this.setState({ models }); this.saveJSON(Component.MODELS_KEY, models); }
  setObj(key, val) { const obj = { ...(this.state.obj || {}) }; obj[key] = val; this.setState({ obj }); this.saveJSON(Component.OBJ_KEY, obj); }

  // ---------- parsing ----------
  parseTable(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return { header: [], rows: [], find: () => -1 };
    const probe = lines.slice(0, 15);
    const sepScore = s => probe.reduce((m, l) => Math.max(m, l.split(s).length), 0);
    const sep = [';', ',', '\t'].reduce((b, s) => sepScore(s) > sepScore(b) ? s : b, ';');
    const split = line => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(x => x.trim()); };
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const KW = ['date', 'montant', 'facture', 'client', 'fournisseur', 'paiement', 'paiment', 'semaine', 'statut', 'reference', 'numero', 'ttc', 'solde', 'echeance', 'poids', 'total', 'destinataire', 'transporteur', 'valo', 'mortalite', 'partenaire', 'categorie'];
    let hi = 0, hscore = -1;
    for (let i = 0; i < Math.min(lines.length, 15); i++) { const cs = split(lines[i]).map(norm); const sc = cs.filter(c => c && KW.some(k => c.includes(k))).length; if (sc > hscore) { hscore = sc; hi = i; } }
    const header = split(lines[hi]).map(norm);
    const rows = lines.slice(hi + 1).map(split);
    const find = (...keys) => { for (const k of keys) { const idx = header.findIndex(h => h.includes(k)); if (idx >= 0) return idx; } return -1; };
    return { header, rows, find };
  }
  parseDate(s) { return this.smartDate(s); }
  vDate(mo, d, y) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? { y, m: mo, d } : null;
  }
  iso(o) { return `${o.y}-${this.dd(o.m)}-${this.dd(o.d)}`; }
  parseAmount(v) { if (v == null) return null; let s = String(v).replace(/[€\s\u00a0\u202f'%]/g, '').replace('−', '-'); if (!s) return null; if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isNaN(n) ? null : n; }
  statusIsPaid(v) {
    const s = this._norm(String(v == null ? '' : v));
    // Tester les négations et le partiel AVANT le mot « payé » :
    // « non payée » et « partiellement payée » ne sont pas des règlements complets.
    if (/non\s*pay|not\s*paid|unpaid|impay|partiel|partial|partly|acompte|a\s*payer|en\s*attente|en\s*cours/.test(s)) return false;
    return /(^|\b)(payee?|reglee?|acquittee?|soldee?|cloturee?|encaissee?|paid|sold|settled|closed)(\b|$)/.test(s);
  }
  paymentStatusFromText(v) {
    const raw = String(v == null ? '' : v).trim(), s = this._norm(raw);
    if (!s) return null;
    if (/partiel|partial|partly|acompte/.test(s)) return 'Partiellement payée';
    if (/non\s*pay|not\s*paid|unpaid|impay|a\s*payer/.test(s)) return 'Non payée';
    if (this.statusIsPaid(raw)) return 'Payée';
    return null;
  }

  mapOperations(text) {
    const { rows, find } = this.parseTable(text);
    const ci = { date: find('date'), ref: find('ref', 'piece', 'numero', 'n°'), type: find('type', 'sens', 'nature'), partner: find('partenaire', 'tiers', 'client', 'fournisseur', 'libelle', 'nom'), cat: find('categorie', 'famille', 'rubrique'), amt: find('montant', 'total', 'somme', 'valeur', 'amount', 'prix'), paid: find('paye', 'regle', 'cheque'), solde: find('solde', 'restant', 'reste'), status: find('statut', 'status', 'etat', 'reglement'), chq: find('cheque') };
    if (ci.date < 0 || ci.amt < 0) return { list: [], error: 'colonnes « Date » et « Montant » introuvables' };
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const list = []; let skipped = 0;
    rows.forEach((f, i) => { const dt = this.parseDate(f[ci.date]); const amt = this.parseAmount(f[ci.amt]); if (!dt || amt === null) { skipped++; return; }
      let type = ''; if (ci.type >= 0) { const t = norm(f[ci.type]); if (t.startsWith('a') || t.includes('depense')) type = 'Achat'; else if (t.startsWith('v') || t.includes('recette')) type = 'Vente'; } if (!type) type = amt < 0 ? 'Achat' : 'Vente';
      const gross = Math.abs(amt);
      // Solde vide ≠ solde à 0 : une cellule vide ne veut PAS dire « payé »
      const soldeRaw = ci.solde >= 0 ? this.parseAmount(f[ci.solde]) : null;
      const solde = soldeRaw == null ? null : Math.max(0, soldeRaw);
      const paidRaw = ci.paid >= 0 ? this.parseAmount(f[ci.paid]) : null;
      let paid = paidRaw != null ? Math.max(0, paidRaw) : (solde != null ? Math.max(0, Math.round((gross - solde) * 100) / 100) : 0);
      const reste = solde != null ? solde : Math.max(0, Math.round((gross - paid) * 100) / 100);
      if (solde != null) paid = Math.max(0, Math.round((gross - reste) * 100) / 100);
      let status = reste > 0.005 ? 'Non payé' : 'Payé';
      if (ci.status >= 0) { const st = norm(f[ci.status]); if (st.includes('retard') || st.includes('impay')) status = 'Retard'; }
      const chq = ci.chq >= 0 ? String(f[ci.chq] == null ? '' : f[ci.chq]).trim() : '';
      const colA = String(f[0] == null ? '' : f[0]).trim();
      list.push({ y: dt.y, m: dt.m, d: dt.d, ref: (ci.ref >= 0 && f[ci.ref]) || 'OP-' + (i + 1), type, partner: (ci.partner >= 0 && f[ci.partner]) || '—', cat: (ci.cat >= 0 && f[ci.cat]) || 'Autre', amt: type === 'Achat' ? -gross : gross, paid, reste, status, chq, colA }); });
    list.sort((a, b) => (b.y * 12 + b.m) - (a.y * 12 + a.m) || b.d - a.d);
    return { list, skipped };
  }
  // Détecte ce que contient la colonne « Chèque » d'une facture pêcheur : un ou plusieurs numéros
  // purs (« 602407 » ou « 602407 / 516906 »), code virement (« BB »), observation libre, ou vide.
  _chequeKind(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'vide';
    if (this._chequeNumTokens(s)) return 'cheque_num';
    if (/bb/i.test(s)) return 'virement_bb';
    return 'texte';
  }
  // Découpe la colonne Chèque en numéros individuels (séparateur « / ») — renvoie null si un seul
  // jeton n'est pas un numéro pur (ex. observation libre mêlée à un numéro).
  _chequeNumTokens(raw) {
    const s = String(raw || '').trim(); if (!s) return null;
    const tokens = s.split('/').map(x => x.trim()).filter(Boolean);
    if (!tokens.length || !tokens.every(t => /^\d+$/.test(t))) return null;
    return tokens;
  }
  // Ligne annulée dans le fichier achat pêcheur : colonne A contient ANNULÉ/ANNULE/CANCELLED.
  _isAnnuleColA(raw) {
    const s = this._norm(raw);
    return s.includes('annule') || s.includes('cancelled');
  }
  // Texte de la colonne OBS du chéquier : « Chèque X/Y — Facture N°REF ».
  _chequeObsText(idx, total, ref) { return `Chèque ${idx}/${total} — Facture N°${ref}`; }
  mapFactures(text) {
    const { header, rows, find } = this.parseTable(text);
    const clientCol = find('nom du client', 'nom client', 'clients', 'client'), fournCol = find('fournisseur');
    const ci = {
      date: find('date facture', 'date de facture', 'date', 'emis'),
      due: find('date echeance', 'date prevue', 'echeance', 'echu', 'due'),
      ref: find('numero de facture', 'numero facture', 'n° de facture', 'numero', 'facture', 'ref', 'piece'),
      sens: find('sens', 'nature'),
      partner: find('nom du client', 'nom client', 'clients', 'client', 'fournisseur', 'partenaire', 'tiers', 'nom'),
      cat: find('categorie', 'famille', 'description'),
      ht: find('montant ht'),
      ttc: find('montant ttc', 'total ttc', 'ttc', 'montant', 'total'),
      paid: find('montant regle', 'montant paye', 'total paye', 'regle', 'encaisse', 'acompte', 'paiment', 'paiement', 'paye', 'cheque'),
      solde: find('solde restant', 'solde', 'reste'),
      status: find('etat', 'statut', 'status'),
      delai: find('delai de paiement', 'delai paiement', 'conditions de paiement', 'delai', 'conditions', 'terme'),
      payeLe: find('paye le', 'date du paiement', 'date de paiement', 'date paiement', 'regle le'),
    };
    if (ci.date < 0 || ci.ttc < 0) return { list: [], error: 'colonnes « Date » et « Montant TTC » introuvables' };
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // garde : une colonne « Date … » ne doit jamais servir de montant payé
    if (ci.paid >= 0 && /date/.test(norm(header[ci.paid] || ''))) ci.paid = -1;
    const defSens = clientCol >= 0 ? 'Client' : fournCol >= 0 ? 'Fournisseur' : 'Client';
    const list = []; let skipped = 0;
    rows.forEach((f, i) => {
      const dt = this.parseDate(f[ci.date]); const ttc = this.parseAmount(f[ci.ttc]); if (!dt || ttc === null) { skipped++; return; }
      let sens = defSens; if (ci.sens >= 0) { const s = norm(f[ci.sens]); if (s.startsWith('f') || s.includes('achat') || s.includes('fourni')) sens = 'Fournisseur'; else if (s.startsWith('c') || s.includes('vente')) sens = 'Client'; }
      // Réglé prioritaire ; sinon Solde (solde 0 = payé, solde vide = inconnu → 0 payé)
      const _paidRaw = ci.paid >= 0 ? this.parseAmount(f[ci.paid]) : null;
      const _soldeRaw = ci.solde >= 0 ? this.parseAmount(f[ci.solde]) : null;
      let paid = _paidRaw != null ? _paidRaw : (_soldeRaw != null ? Math.abs(ttc) - Math.max(0, _soldeRaw) : 0);
      const stTxt = ci.status >= 0 ? norm(f[ci.status]) : '';
      // payé si : statut le dit, OU une date de paiement est renseignée
      const payeLeOk = ci.payeLe >= 0 && f[ci.payeLe] && this.parseDate(f[ci.payeLe]);
      const amountSaysPaid = _soldeRaw != null ? Math.max(0, _soldeRaw) <= 0.005 : (_paidRaw != null ? _paidRaw >= Math.abs(ttc) - 0.005 : false);
      const dateSaysPaid = !!payeLeOk && ((_soldeRaw == null && _paidRaw == null) ? !/partiel|acompte/.test(stTxt) : amountSaysPaid);
      const paymentStatus = this.paymentStatusFromText(stTxt);
      const statusPaid = paymentStatus === 'Payée' || (!paymentStatus && dateSaysPaid);
      if (statusPaid) paid = Math.abs(ttc);
      let delaiJ = null; if (ci.delai >= 0) { const s = norm(f[ci.delai]); if (s) { if (/recept|comptant|immediat|livraison/.test(s)) delaiJ = 0; else { const dm = s.match(/(\d+)/); if (dm) delaiJ = +dm[1]; } } }
      const due = ci.due >= 0 && this.parseDate(f[ci.due]) ? this.parseDate(f[ci.due]) : this.addDays(dt, delaiJ != null ? delaiJ : 30);
      const htv = ci.ht >= 0 ? Math.abs(this.parseAmount(f[ci.ht]) || 0) : Math.abs(ttc);
      list.push({ d: this.iso(dt), due: this.iso(due), ref: (ci.ref >= 0 && f[ci.ref]) || 'FAC-' + (i + 1), sens, partner: (ci.partner >= 0 && f[ci.partner]) || '—', cat: (ci.cat >= 0 && f[ci.cat]) || 'Autre', ttc: Math.abs(ttc), ht: htv, paid: Math.max(0, Math.min(Math.abs(ttc), paid)), statusPaid: !!statusPaid, paymentStatus, stText: ci.status >= 0 ? (f[ci.status] || '') : '', delai: delaiJ });
    });
    return { list, skipped };
  }
  paymentIssueSignature(f, issue) {
    const i = issue || f.paymentIssue || {};
    return [this.invoiceKey(f.ref), Math.round((f.ttc || 0) * 100), Math.round((i.paid || 0) * 100), i.solde == null ? '' : Math.round(i.solde * 100), this._norm(i.status || ''), i.rowCount || 0].join('|');
  }
  applyPaymentDecision(f, decision, issue) {
    const i = issue || f.paymentIssue || {};
    if (decision === 'paid') return { ...f, paid: f.ttc, statusPaid: true, paymentCheck: null, paymentManual: 'Considérée comme payée' };
    if (decision === 'unpaid') return { ...f, paid: 0, statusPaid: false, paymentCheck: null, paymentManual: 'Considérée comme impayée' };
    if (decision === 'calculated') {
      const paid = i.solde != null ? Math.max(0, Math.min(f.ttc, Math.round((f.ttc - i.solde) * 100) / 100)) : Math.max(0, Math.min(f.ttc, i.paid || 0));
      return { ...f, paid, statusPaid: paid >= f.ttc - 0.005, paymentCheck: null, paymentManual: 'Montants calculés acceptés' };
    }
    return f;
  }
  resolvePayment(ref, decision) {
    const key = this.invoiceKey(ref); let chosen = null;
    const list = (this.state.ventes || []).map(f => {
      if (this.invoiceKey(f.ref) !== key) return f;
      const sig = this.paymentIssueSignature(f, f.paymentIssue); chosen = { decision, signature: sig, when: Date.now() };
      return this.applyPaymentDecision(f, decision, f.paymentIssue);
    });
    if (!chosen) return;
    const overrides = { ...(this.state.paymentOverrides || {}), [key]: chosen };
    this.setState({ ventes: list, paymentOverrides: overrides, payResolveRef: null, msg: { kind: 'success', text: `Décision enregistrée pour la facture ${ref}. Le fichier Excel n’a pas été modifié.` } });
    this.saveJSON(Component.PAY_OVERRIDE_KEY, overrides);
    this.saveJSON(Component.VEN_KEY, { name: this.state.ventesName || '', rows: list, v: 6 });
  }
  applySalesPayments(wb, name, importedSales) {
    const sh = (wb || []).find(s => /suivi\s+des\s+paiements|suivi\s+paiements/i.test(this._norm(s.name)));
    // setState est asynchrone : utiliser directement les lignes du nouvel import évite
    // de rapprocher la feuille de paiements avec l'ancienne liste encore en mémoire.
    const sales = Array.isArray(importedSales) ? importedSales : this.state.ventes;
    if (!sh || !sales) return;
    let hi = 0, best = -1;
    (sh.rows || []).slice(0, 15).forEach((r, i) => { const score = (r || []).map(x => this._norm(String(x == null ? '' : x))).filter(h => /facture|client|montant|solde|etat|statut|paiement/.test(h)).length; if (score > best) { best = score; hi = i; } });
    const hdr = (sh.rows[hi] || []).map(x => this._norm(String(x == null ? '' : x)));
    const col = (...keys) => hdr.findIndex(h => keys.some(k => h.includes(k)));
    const ci = {
      ref: col('numero facture', 'numero de facture', 'n° facture'), partner: col('nom client', 'client'),
      paid: col('montant regle', 'montant paye'), solde: col('solde restant', 'solde'),
      status: col('etat', 'statut'), paidDate: col('date du paiement', 'date paiement')
    };
    if (ci.ref < 0 || (ci.paid < 0 && ci.solde < 0 && ci.status < 0)) return;
    const groups = new Map();
    sh.rows.slice(hi + 1).forEach(r => {
      const ref = ci.ref >= 0 ? String(r[ci.ref] || '').trim() : ''; if (!ref) return;
      const k = this.invoiceKey(ref); const rec = {
        ref, partner: ci.partner >= 0 ? String(r[ci.partner] || '').trim() : '',
        paid: ci.paid >= 0 ? this.parseAmount(r[ci.paid]) : null,
        solde: ci.solde >= 0 ? this.parseAmount(r[ci.solde]) : null,
        status: ci.status >= 0 ? String(r[ci.status] || '').trim() : '',
        paidDate: ci.paidDate >= 0 ? this.parseDate(r[ci.paidDate]) : null
      };
      if (!groups.has(k)) groups.set(k, []); groups.get(k).push(rec);
    });
    let matched = 0, verify = 0;
    const list = sales.map(f => {
      const rows = groups.get(this.invoiceKey(f.ref)) || []; if (!rows.length) return f;
      const isGrenke = /grenke/i.test([f.partner, ...rows.map(r => r.partner)].join(' '));
      const paidVals = rows.map(r => r.paid).filter(v => v != null);
      const paid = paidVals.length ? Math.round(paidVals.reduce((s, v) => s + Math.max(0, v), 0) * 100) / 100 : null;
      const soldes = rows.map(r => r.solde).filter(v => v != null);
      const solde = soldes.length ? Math.max(0, soldes[soldes.length - 1]) : (paid != null ? Math.max(0, Math.round((f.ttc - paid) * 100) / 100) : null);
      const statusText = rows.map(r => this._norm(r.status)).join(' ');
      const textStatuses = rows.map(r => this.paymentStatusFromText(r.status)).filter(Boolean);
      const paymentStatus = textStatuses.length ? textStatuses[textStatuses.length - 1] : null;
      const conflictingTextStatuses = new Set(textStatuses).size > 1;
      const statusSaysPaid = rows.some(r => this.statusIsPaid(r.status)) || (rows.some(r => r.paidDate) && ((solde != null && solde <= 0.005) || (paid != null && paid >= f.ttc - 0.005)));
      // Les montants priment sur un libellé de statut imparfait : si un paiement
      // positif et un solde positif sont cohérents avec le TTC, la facture est
      // partiellement payée, même lorsque la cellule Excel indique « Payée ».
      const paidFromBalance = solde != null ? Math.max(0, Math.round((f.ttc - solde) * 100) / 100) : null;
      const numericPartial = solde != null && solde > 0.005 && solde < f.ttc - 0.005 &&
        ((paid != null && paid > 0.005 && paid < f.ttc - 0.005) || (paid == null && paidFromBalance > 0.005));
      let reason = '';
      if (conflictingTextStatuses && !isGrenke) reason = 'Plusieurs statuts différents dans Excel';
      else if (!paymentStatus && ((!isGrenke && rows.length > 1) || (isGrenke && rows.length > 2))) reason = 'Nombre de paiements inattendu';
      else if (!paymentStatus && ((paid != null && paid > f.ttc + 0.005 && !(statusSaysPaid && solde != null && solde <= 0.005)) || (statusSaysPaid && solde != null && solde > 0.005 && !numericPartial))) reason = 'Montants ou statut contradictoires';
      if (reason) {
        const issue = { reason, paid, solde, status: rows.map(r => r.status).filter(Boolean).join(' / '), rowCount: rows.length, source: sh.name };
        const sig = this.paymentIssueSignature(f, issue), ov = (this.state.paymentOverrides || {})[this.invoiceKey(f.ref)];
        if (ov && ov.signature === sig) { matched++; return { ...this.applyPaymentDecision({ ...f, paymentIssue: issue }, ov.decision, issue), paymentSource: 'Décision locale' }; }
        verify++;
        return { ...f, paymentCheck: ov ? 'Les données Excel ont changé depuis votre décision' : reason, paymentIssue: issue, paymentOverrideChanged: !!ov };
      }
      matched++;
      let paidEff = paidFromBalance != null ? paidFromBalance : Math.min(f.ttc, paid || 0);
      if (paymentStatus === 'Payée') paidEff = f.ttc;
      const paymentWarning = paymentStatus === 'Payée' && solde != null && solde > 0.005 ? 'Le statut indique « Payée », mais le solde Excel est positif.'
        : paymentStatus === 'Partiellement payée' && solde != null && solde <= 0.005 ? 'Le statut indique « Partiellement payée », mais le solde Excel est nul.'
        : paymentStatus === 'Non payée' && paid != null && paid > 0.005 ? 'Le statut indique « Non payée », mais un montant réglé est renseigné.'
        : paid != null && paid > f.ttc + 0.005 ? 'Le montant réglé dépasse le TTC.' : null;
      return { ...f, paid: paidEff, statusPaid: paymentStatus ? paymentStatus === 'Payée' : (solde != null ? solde <= 0.005 : statusSaysPaid), paymentStatus, paymentWarning, paymentPartial: paymentStatus === 'Partiellement payée' || (!paymentStatus && numericPartial), paymentSource: paymentStatus ? 'Statut du suivi des paiements' : 'Suivi des paiements' };
    });
    this.setState({ ventes: list, msg: verify ? { kind: 'error', text: `${verify} facture(s) marquée(s) « À vérifier » après rapprochement des paiements.` } : this.state.msg });
    this.saveJSON(Component.VEN_KEY, { name, rows: list });
    this._paymentReconcile = { matched, verify, sheet: sh.name };
  }
  mapBordereaux(text) {
    const { rows, find } = this.parseTable(text);
    const ci = { date: find('date'), ref: find('bordereau', 'bl', 'ref', 'numero', 'n°'), dest: find('destinataire', 'client', 'livraison', 'nom'), fac: find('facture', 'commande'), colis: find('colis', 'quantite', 'nb'), transp: find('transporteur', 'transport'), statut: find('statut', 'status', 'etat') };
    if (ci.date < 0 || ci.dest < 0) return { list: [], error: 'colonnes « Date » et « Destinataire » introuvables' };
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const list = []; let skipped = 0;
    rows.forEach((f, i) => { const dt = this.parseDate(f[ci.date]); if (!dt || !(ci.dest >= 0 && f[ci.dest])) { skipped++; return; }
      let statut = 'Préparé'; if (ci.statut >= 0) { const s = norm(f[ci.statut]); if (s.includes('livr')) statut = 'Livré'; else if (s.includes('transit')) statut = 'En transit'; else if (s.includes('exped') || s.includes('envoi')) statut = 'Expédié'; else if (s.includes('attente')) statut = 'En attente'; }
      list.push({ d: this.iso(dt), ref: (ci.ref >= 0 && f[ci.ref]) || 'BL-' + (i + 1), dest: f[ci.dest], fac: (ci.fac >= 0 && f[ci.fac]) || '—', colis: (ci.colis >= 0 && f[ci.colis]) || '—', transp: (ci.transp >= 0 && f[ci.transp]) || '—', statut }); });
    list.sort((a, b) => a.d < b.d ? 1 : -1);
    return { list, skipped };
  }
  mapComptable(text) {
    const { rows, find } = this.parseTable(text);
    const ci = { date: find('date'), ref: find('numero de facture', 'facture', 'piece', 'numero', 'reference', 'ref'), partner: find('partenaire', 'client', 'fournisseur', 'tiers', 'compte', 'nom'), montant: find('montant ttc', 'montant', 'ttc', 'total') };
    if (ci.ref < 0 && ci.montant < 0) return { list: [], error: 'colonnes « N° de facture » ou « Montant » introuvables' };
    const list = []; let skipped = 0;
    rows.forEach(f => { const ref = (ci.ref >= 0 && String(f[ci.ref]).trim()) || ''; const amount = ci.montant >= 0 ? Math.abs(this.parseAmount(f[ci.montant]) || 0) : 0; if (!ref && !amount) { skipped++; return; } const dt = ci.date >= 0 ? this.smartDate(f[ci.date]) : null; list.push({ ref, partner: (ci.partner >= 0 && String(f[ci.partner]).trim()) || '—', amount, d: dt ? this.iso(dt) : '' }); });
    if (!list.length) return { list: [], error: 'aucune ligne exploitable' };
    return { list, skipped };
  }
  mapStock(text, hint) {
    const { rows, find } = this.parseTable(text);
    const ci = { sem: find('semaine', 'periode', 'fichier'), poids: find('poids total', 'poids kg', 'poids', 'kg', 'quantite', 'total kg'), valo: find('total prix', 'prix total', 'valorisation', 'valo', 'valeur', 'total', 'montant') };
    if (ci.valo < 0 && ci.poids < 0) return { list: [], error: 'colonnes « Poids » ou « Total prix » introuvables' };
    // Feuille RECAP (une ligne par espèce, pas de colonne semaine) → un TOTAL par fichier
    if (ci.sem < 0) {
      let poids = 0, valo = 0;
      rows.forEach(f => { poids += ci.poids >= 0 ? (this.parseAmount(f[ci.poids]) || 0) : 0; valo += ci.valo >= 0 ? (this.parseAmount(f[ci.valo]) || 0) : 0; });
      const wk = hint ? String(hint).replace(/\.(xlsx|xlsm|xls|csv|txt)$/i, '') : 'Total';
      return { list: [{ file: hint || '', sem: wk, poids, valo }] };
    }
    const list = rows.map((f, i) => ({ file: '', sem: (ci.sem >= 0 && f[ci.sem]) || ('Semaine ' + (i + 1)), poids: ci.poids >= 0 ? (this.parseAmount(f[ci.poids]) || 0) : 0, valo: ci.valo >= 0 ? (this.parseAmount(f[ci.valo]) || 0) : 0 }));
    return { list };
  }
  setBlStatut(ref, val) { const ov = { ...(this.state.blOverrides || {}) }; ov[ref] = val; this.setState({ blOverrides: ov }); this.saveJSON(Component.BLOV_KEY, ov); }

  // ---------- date « intelligente » : texte jj/mm/aaaa, aaaa-mm-jj OU numéro de série Excel ----------
  smartDate(v) {
    if (v == null || v === '') return null; const s = String(v).trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); if (m) { const y = m[3].length <= 2 ? 2000 + +m[3] : +m[3]; return this.vDate(+m[2], +m[1], y); }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return this.vDate(+m[2], +m[3], +m[1]);
    const n = Number(s.replace(',', '.')); if (isFinite(n) && n >= 20000 && n <= 80000) { const t = new Date(Math.round((n - 25569) * 86400000)); return this.vDate(t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCFullYear()); }
    return null;
  }
  frDate(v) { const o = this.smartDate(v); return o ? `${this.dd(o.d)}/${this.dd(o.m)}/${o.y}` : ''; }

  // ---------- lecture d'un classeur : toutes les feuilles en tableaux de lignes ----------
  async readWorkbook(buf) {
    const files = await this.unzipXlsx(buf); const ss = [];
    const ssx = files['xl/sharedStrings.xml'];
    if (ssx) { const re = /<si>([\s\S]*?)<\/si>/g; let m; while (m = re.exec(ssx)) { const t = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''); ss.push(this.unxml(t)); } }
    const coln = r => { const mm = r.match(/^([A-Z]+)/); let v = 0; for (const c of mm[1]) v = v * 26 + (c.charCodeAt(0) - 64); return v; };
    const sheetRows = xml => {
      const rows = []; const rr = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
      while (rm = rr.exec(xml)) {
        const cells = {}; let mx = 0; const cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
        while (cm = cr.exec(rm[1])) {
          const refM = cm[1].match(/\br="([A-Z]+\d+)"/); if (!refM) continue;
          const typeM = cm[1].match(/\bt="([^"]+)"/); const typ = typeM ? typeM[1] : '';
          const ci = coln(refM[1]); mx = Math.max(mx, ci);
          const body = cm[2] || ''; const vm = body.match(/<v>([\s\S]*?)<\/v>/); const im = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
          let val = ''; if (im) val = this.unxml(im[1]); else if (vm) val = typ === 's' ? (ss[+vm[1]] || '') : this.unxml(vm[1]);
          cells[ci] = val;
        }
        const arr = []; for (let i = 1; i <= mx; i++) arr.push(cells[i] !== undefined ? cells[i] : ''); rows.push(arr);
      }
      return rows;
    };
    const wb = files['xl/workbook.xml'] || ''; const relsx = files['xl/_rels/workbook.xml.rels'] || '';
    const relMap = this._relMapOf(relsx);
    const defs = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)].map(m => ({ name: this.unxml(m[1]), key: relMap[m[2]] }));
    return defs.map(d => ({ name: d.name, rows: sheetRows(files[d.key] || '') })).filter(s => s.rows.length);
  }

  // ---------- spécifications d'import par source (colonnes attendues + rendu canonique) ----------
  importSpec(kind) {
    const P = s => this.parseAmount(s);
    if (kind === 'ventes') return {
      title: 'Ventes (clients)',
      headers: ['Date', 'Numero de facture', 'Nom du client', 'Montant TTC', 'Montant regle', 'Date echeance', 'Sens', 'Etat', 'Montant HT', 'Delai de paiement', 'Solde', 'Paye le'],
      sheetHints: /suivi des paiements|paiement|factur|vente/, combineable: false,
      forceSheetIndex: 0,
      note: 'TTC reconstitué = Montant HT + TVA France + TVA Irlande (fidèle à votre tableau).',
      fields: [
        { key: 'date', label: 'Date de facture', kw: ['date facture', 'date de facture', 'date'], req: true },
        { key: 'ref', label: 'N° de facture', kw: ['numero de facture', 'n° de facture', 'numero', 'facture'] },
        { key: 'partner', label: 'Client', kw: ['nom du client', 'client', 'nom'] },
        { key: 'ht', label: 'Montant HT', kw: ['montant ht', 'ht', 'montant'], req: true },
        { key: 'tvaFr', label: 'TVA France', kw: ['tva france'] },
        { key: 'tvaIr', label: 'TVA Irlande', kw: ['tva irlande'] },
        { key: 'paid', label: 'Montant réglé', w: 3, kw: ['montant regle', 'regle', 'total paye', 'paye', 'encaisse', 'paiement', 'paiment', 'cheque'] },
        { key: 'solde', label: 'Solde restant', w: 3, kw: ['solde restant', 'solde'] },
        { key: 'paidDate', label: 'Date du paiement', w: 3, kw: ['date du paiement', 'date de paiement', 'date paiement', 'paye le', 'regle le'] },
        { key: 'due', label: "Date d'échéance", kw: ['date echeance', 'echeance', 'date prevue'] },
        { key: 'delai', label: 'Délai de paiement', kw: ['delai de paiement', 'delai paiement', 'conditions de paiement', 'delai', 'conditions', 'terme'] },
        { key: 'status', label: 'Statut / relance', kw: ['etat', 'statut', 'relance', 'suivi'] },
      ],
      emit: (r, f) => { const d = this.frDate(r[f.date]); if (!d) return null; const ht = P(r[f.ht]) || 0, tf = P(r[f.tvaFr]) || 0, ti = P(r[f.tvaIr]) || 0; const ttc = Math.round((ht + tf + ti) * 100) / 100; if (!ttc) return null; return [d, r[f.ref] || '', r[f.partner] || '', ttc, (P(r[f.paid]) ?? ''), this.frDate(r[f.due]) || '', 'Client', r[f.status] || '', ht, f.delai >= 0 ? (r[f.delai] || '') : '', f.solde >= 0 ? (P(r[f.solde]) ?? '') : '', f.paidDate >= 0 ? (this.frDate(r[f.paidDate]) || '') : '']; },
    };
    if (kind === 'operations') return {
      title: 'Achat pêche',
      headers: ['Date', 'Type', 'Partenaire', 'Montant', 'Statut', 'Reference', 'Paye', 'Solde', 'Cheque'],
      sheetHints: /facturation|suivi|achat/, combineable: false,
      fields: [
        { key: 'date', label: 'Date', kw: ['date'], req: true },
        { key: 'ref', label: 'N° de facture', kw: ['numero de facture', 'n° de facture', 'numero', 'facture'] },
        { key: 'partner', label: 'Pêcheur', kw: ['nom du client', 'pecheur', 'fournisseur', 'client', 'nom'] },
        { key: 'amt', label: 'Montant', kw: ['montant'], req: true },
        { key: 'paid', label: 'Total payé', kw: ['total paye', 'montant paye', 'regle', 'paye', 'cheque'] },
        { key: 'solde', label: 'Solde (restant à payer)', kw: ['solde', 'restant', 'reste', 'du'] },
        { key: 'status', label: 'Statut', kw: ['etat', 'statut', 'reglement'] },
        { key: 'chq', label: 'N° de chèque / observation', kw: ['cheque'] },
      ],
      emit: (r, f) => { const d = this.frDate(r[f.date]); const amt = P(r[f.amt]); if (!d || amt == null) return null; return [d, 'Achat', r[f.partner] || '', Math.abs(amt), r[f.status] || '', r[f.ref] || '', f.paid >= 0 ? (P(r[f.paid]) ?? '') : '', f.solde >= 0 ? (P(r[f.solde]) ?? '') : '', f.chq >= 0 ? (r[f.chq] || '') : '']; },
    };
    if (kind === 'factures') return {
      title: 'Factures à payer (fournisseurs)',
      headers: ['Date', 'Fournisseur', 'Numero de facture', 'Montant TTC', 'Montant regle', 'Date paiement', 'Sens'],
      sheetHints: /janv|fevr|mars|avril|mai|juin|juil|aout|sept|octo|nov|dec/, combineable: true, combineByDefault: true, twinTables: true,
      note: 'Cochez « toutes les feuilles mensuelles » pour importer JANVIER→DÉCEMBRE d\'un coup. Les deux tableaux côte à côte (FOURNISSEURS et FOURNISSEURS CRUSTACÉS) sont lus tous les deux.',
      fields: [
        { key: 'date', label: 'Date', kw: ['date'], req: true },
        { key: 'partner', label: 'Fournisseur', kw: ['fournisseur', 'nom'] },
        { key: 'ref', label: 'N° / réf. facture', kw: ['factures', 'facture', 'numero', 'reference'] },
        { key: 'ttc', label: 'Montant', kw: ['montant'], req: true },
        { key: 'paid', label: 'Payé', kw: ['paiment', 'paiement', 'regle', 'paye'] },
        { key: 'due', label: 'Date paiement', kw: ['date paiement', 'date de paiement', 'echeance'] },
      ],
      emit: (r, f) => { const d = this.frDate(r[f.date]); const ttc = P(r[f.ttc]); if (!d || ttc == null) return null; return [d, r[f.partner] || '', r[f.ref] || '', Math.abs(ttc), (P(r[f.paid]) ?? ''), this.frDate(r[f.due]) || '', 'Fournisseur']; },
    };
    if (kind === 'credits') return {
      title: 'Crédits & assurances',
      headers: ['Denomination', 'Entreprise', 'Montant total', 'Mensualite', 'Restant'],
      sheetHints: /feuil|credit|assur|mensualit/, combineable: false,
      fields: [
        { key: 'label', label: 'Dénomination', kw: ['denomination', 'libelle', 'nom'], req: true },
        { key: 'ent', label: 'Entreprise / organisme', kw: ['entreprise', 'organisme', 'banque'] },
        { key: 'total', label: 'Montant total', kw: ['montant total', 'total', 'capital'] },
        { key: 'mens', label: 'Mensualité', kw: ['mensualite', 'par mois', 'echeance mensuelle'] },
        { key: 'rest', label: 'Restant', kw: ['restant', 'reste', 'solde'] },
      ],
      emit: (r, f) => { const label = r[f.label]; const total = P(r[f.total]); if (!label && total == null) return null; return [label || '', r[f.ent] || '', P(r[f.total]) || '', P(r[f.mens]) || '', P(r[f.rest]) || '']; },
    };
    if (kind === 'bordereaux') return {
      title: 'Bordereaux de livraison',
      headers: ['Date', 'Bordereau', 'Destinataire', 'Facture', 'Colis', 'Transporteur', 'Statut'],
      sheetHints: /border|livrais|suivi/, combineable: false,
      fields: [
        { key: 'date', label: 'Date', kw: ['date'], req: true },
        { key: 'ref', label: 'N° BL', kw: ['bordereau', 'bl', 'numero'] },
        { key: 'dest', label: 'Destinataire', kw: ['destinataire', 'client', 'livraison', 'nom'], req: true },
        { key: 'fac', label: 'Facture', kw: ['facture', 'commande'] },
        { key: 'colis', label: 'Colis', kw: ['colis', 'quantite', 'nb'] },
        { key: 'transp', label: 'Transporteur', kw: ['transporteur', 'transport'] },
        { key: 'status', label: 'Statut', kw: ['statut', 'etat'] },
      ],
      emit: (r, f) => { const d = this.frDate(r[f.date]); if (!d || !r[f.dest]) return null; return [d, r[f.ref] || '', r[f.dest] || '', r[f.fac] || '', r[f.colis] || '', r[f.transp] || '', r[f.status] || '']; },
    };
    if (kind === 'comptable') return {
      title: 'Export comptable',
      headers: ['Date', 'Numero de facture', 'Partenaire', 'Montant'],
      sheetHints: /export|compta|grand.?livre|ecritur|journal|factur|vente|achat/, combineable: false,
      note: 'Sert au rapprochement : le tableau compare vos factures internes à cet export.',
      fields: [
        { key: 'ref', label: 'N° de facture / pièce', kw: ['numero de facture', 'n° de facture', 'numero piece', 'piece', 'numero', 'facture', 'reference', 'ref'], req: true },
        { key: 'partner', label: 'Partenaire (client/fourn.)', kw: ['partenaire', 'client', 'fournisseur', 'tiers', 'compte', 'libelle', 'nom'] },
        { key: 'montant', label: 'Montant', kw: ['montant ttc', 'montant', 'ttc', 'total', 'debit', 'credit', 'solde'], req: true },
        { key: 'date', label: 'Date', kw: ['date ecriture', 'date facture', 'date'] },
      ],
      emit: (r, f) => { const ref = f.ref >= 0 ? String(r[f.ref] || '').trim() : ''; const amt = f.montant >= 0 ? P(r[f.montant]) : null; if (!ref && (amt === null || amt === 0)) return null; return [f.date >= 0 ? this.frDate(r[f.date]) : '', ref, f.partner >= 0 ? (r[f.partner] || '') : '', amt == null ? '' : amt]; },
    };
    if (kind === 'banque') return {
      title: 'banque',
      headers: ['Date', 'Libellé', 'Montant', 'Solde'],
      sheetHints: /banque|releve|compte|statement|transaction|mouvement/, combineable: false,
      note: 'Montant unique signé (+ entrée, − sortie) recommandé. Si votre relevé sépare Débit et Crédit, mappez ces deux colonnes à la place du Montant. La colonne « Solde » (solde du compte après opération) est facultative : le solde le plus récent alimente la trésorerie nette.',
      fields: [
        { key: 'date', label: 'Date', kw: ['date operation', 'date comptable', 'date de valeur', 'date'], req: true },
        { key: 'label', label: 'Libellé / description', kw: ['libelle operation', 'libelle', 'label', 'description', 'operation', 'detail', 'intitule', 'communication'], req: true },
        { key: 'montant', label: 'Montant (signé)', kw: ['montant eur', 'montant', 'amount'] },
        { key: 'debit', label: 'Débit (si séparé)', kw: ['debit'] },
        { key: 'credit', label: 'Crédit (si séparé)', kw: ['credit'] },
        { key: 'solde', label: 'Solde du compte (facultatif)', kw: ['solde courant', 'solde apres', 'nouveau solde', 'solde comptable', 'solde', 'balance'] },
      ],
      emit: (r, f) => {
        const label = f.label >= 0 ? String(r[f.label] || '').trim() : '';
        let amt = null;
        if (f.montant >= 0) { const v = P(r[f.montant]); if (v != null && !isNaN(v) && v !== 0) amt = v; }
        if (amt == null) { const dv = f.debit >= 0 ? Math.abs(P(r[f.debit]) || 0) : 0; const cv = f.credit >= 0 ? Math.abs(P(r[f.credit]) || 0) : 0; if (dv || cv) amt = cv - dv; }
        if (!label || amt == null) return null;
        const sv = f.solde >= 0 ? P(r[f.solde]) : null;
        return [f.date >= 0 ? this.frDate(r[f.date]) : '', label, Math.round(amt * 100) / 100, (sv == null || isNaN(sv)) ? '' : Math.round(sv * 100) / 100];
      },
    };
    return { title: kind, headers: [], fields: [], emit: () => null };
  }
  _norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
  // ---------- \u00e9tat "donn\u00e9e manquante" r\u00e9utilisable (cartes esp\u00e8ces Stock ET cat\u00e9gories bancaires) ----------
  // items: [{ key, label, reason }] d\u00e9j\u00e0 identifi\u00e9s comme manquants/invalides par l'appelant.
  buildMissingState(items) {
    const list = (items || []).filter(it => it && it.reason);
    if (!list.length) return { hasMissing: false, count: 0, bannerText: '', cardClass: '', items: [] };
    const bannerText = list.length === 1
      ? `Information manquante \u2014 ${list[0].label} : ${list[0].reason}`
      : `${list.length} informations manquantes : ${list.map(it => `${it.label} (${it.reason})`).join(' \u00b7 ')}`;
    return { hasMissing: true, count: list.length, bannerText, cardClass: 'missing-hatch', items: list };
  }
  guessHeader(rows) {
    const KW = ['date', 'montant', 'fournisseur', 'client', 'facture', 'paiement', 'paiment', 'denomination', 'mensualite', 'total', 'poids', 'destinataire', 'bordereau', 'solde', 'numero', 'ht', 'tva', 'entreprise'];
    let hi = 0, best = -1;
    for (let i = 0; i < Math.min(rows.length, 25); i++) { const sc = (rows[i] || []).map(c => this._norm(c)).filter(c => c && KW.some(k => c.includes(k))).length; if (sc > best) { best = sc; hi = i; } }
    return hi;
  }
  guessSheet(spec, wb) {
    if (spec.forceSheetIndex != null && wb[spec.forceSheetIndex]) return spec.forceSheetIndex;
    const scored = wb.map((s, i) => {
      const nameHit = spec.sheetHints && spec.sheetHints.test(this._norm(s.name)) ? 1 : 0;
      const hi = this.guessHeader(s.rows); const hdr = (s.rows[hi] || []).map(c => this._norm(c));
      const kwHit = spec.fields.reduce((a, f) => a + (f.kw.some(k => hdr.some(h => h.includes(this._norm(k)))) ? (f.w || 1) : 0), 0);
      const data = s.rows.slice(hi + 1).filter(r => r.some(c => String(c).trim())).length;
      return { i, score: nameHit * 100 + kwHit * 10 + Math.min(data, 50) / 50, data, kwHit };
    }).filter(x => x.kwHit > 0);
    // Une feuille au bon nom mais VIDE (modèle vierge) ne doit pas gagner contre une feuille
    // qui contient réellement des lignes — on ne garde les feuilles vides que faute de mieux.
    const withData = scored.filter(x => x.data > 0);
    const pool = withData.length ? withData : scored;
    pool.sort((a, b) => b.score - a.score);
    return pool.length ? pool[0].i : 0;
  }
  autoMap(spec, headerRow) {
    const H = (headerRow || []).map(c => this._norm(c)); const used = {}; const fields = {};
    spec.fields.forEach(f => {
      let idx = -1;
      for (const k of f.kw) { const kk = this._norm(k); idx = H.findIndex((h, i) => !used[i] && h === kk); if (idx >= 0) break; }
      if (idx < 0) for (const k of f.kw) { const kk = this._norm(k); idx = H.findIndex((h, i) => !used[i] && h.includes(kk)); if (idx >= 0) break; }
      if (idx >= 0) used[idx] = 1; fields[f.key] = idx;
    });
    return fields;
  }
  // complète un mapping enregistré : les champs ajoutés depuis (ex. Solde, Statut) sont auto-détectés au lieu d'être perdus
  mergeFields(spec, saved, headerRow) {
    const am = this.autoMap(spec, headerRow || []);
    const out = {};
    spec.fields.forEach(f => { const sv = saved ? saved[f.key] : undefined; out[f.key] = (sv == null || sv < 0) ? (am[f.key] != null ? am[f.key] : -1) : sv; });
    return out;
  }
  emitTSV(p) {
    const spec = p.spec; const out = [spec.headers.join('\t')];
    const sig = row => (row || []).map(c => this._norm(c)).join('|');
    const chosen = p.wb[p.sheetIdx]; const chosenSig = sig(chosen.rows[p.headerIdx]);
    const sheets = (p.combine && spec.combineable) ? p.wb : [chosen];
    // tableaux jumeaux côte à côte sur la même feuille (ex. FOURNISSEURS | FOURNISSEURS CRUSTACÉS) : on lit les deux
    const twinOf = headerRow => {
      if (!spec.twinTables) return null;
      const used = Object.values(p.fields || {}).filter(i => i >= 0);
      if (!used.length) return null;
      const maxCol = Math.max(...used);
      const masked = (headerRow || []).map((c, i) => (i <= maxCol ? '' : c));
      const f2 = this.autoMap(spec, masked);
      return spec.fields.filter(f => f.req).every(f => f2[f.key] >= 0) ? f2 : null;
    };
    sheets.forEach(sh => {
      let hi = p.headerIdx;
      if (p.combine && sh !== chosen) { hi = sh.rows.findIndex(r => sig(r) === chosenSig); if (hi < 0) return; }
      const passes = [p.fields]; const tw = twinOf(sh.rows[hi]); if (tw) passes.push(tw);
      sh.rows.slice(hi + 1).forEach(r => { if (!r.some(c => String(c).trim())) return; passes.forEach(flds => { const v = spec.emit(r, flds); if (v) out.push(v.map(x => String(x == null ? '' : x)).join('\t')); }); });
    });
    return out.join('\n');
  }
  buildPending(kind, name, handle, lastMod, wb) {
    const spec = this.importSpec(kind);
    const sheetIdx = this.guessSheet(spec, wb);
    const headerIdx = this.guessHeader(wb[sheetIdx].rows);
    const fields = this.autoMap(spec, wb[sheetIdx].rows[headerIdx]);
    return { kind, name, handle, lastMod, wb, sheetIdx, headerIdx, fields, combine: !!spec.combineByDefault, spec };
  }
  reopenMapping(kind) {
    const c = (this._wbCache || {})[kind];
    if (!c) { this.importFile(kind); return; }
    const spec = this.importSpec(kind); const m = (this.state.mappings || {})[kind];
    let sheetIdx = (m && spec.forceSheetIndex == null) ? c.wb.findIndex(s => s.name === m.sheetName) : -1; if (sheetIdx < 0) sheetIdx = this.guessSheet(spec, c.wb);
    const headerIdx = m ? m.headerIdx : this.guessHeader(c.wb[sheetIdx].rows);
    const fields = m ? this.mergeFields(spec, m.fields, c.wb[sheetIdx].rows[headerIdx]) : this.autoMap(spec, c.wb[sheetIdx].rows[headerIdx]);
    this.setState({ pending: { kind, name: c.name, handle: c.handle, lastMod: c.lastMod, wb: c.wb, sheetIdx, headerIdx, fields, combine: m ? !!m.combine : !!spec.combineByDefault, spec }, msg: null });
  }
  async pickFile(accept) {
    let file = null, handle = null;
    if (window.showOpenFilePicker) {
      try { const [h] = await window.showOpenFilePicker({ types: [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'] } }] }); handle = h; file = await h.getFile(); }
      catch (e) { console.error('showOpenFilePicker erreur:', e); if (e && e.name === 'AbortError') return { aborted: true }; }
    }
    if (!file) file = await new Promise(res => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept || '.xlsx,.xlsm'; inp.onchange = () => res(inp.files && inp.files[0]); inp.click(); });
    return { file, handle };
  }
  async importFile(kind) {
    if (kind === 'stock') return this.connectStockFolder();
    if (kind === 'bordereaux') return this.connectBordereauxFolder();
    const picked = await this.pickFile(); if (picked.aborted || !picked.file) return; const { file, handle } = picked;
    try {
      const buf = await file.arrayBuffer();
      const wb = await this.readWorkbook(buf); if (!wb.length) throw new Error('aucune feuille lisible');
      this._wbCache = this._wbCache || {}; this._wbCache[kind] = { wb, name: file.name, handle, lastMod: file.lastModified };
      this.setState({ pending: this.buildPending(kind, file.name, handle, file.lastModified, wb), msg: null });
    } catch (err) { this.setState({ msg: { kind: 'error', text: `Lecture de « ${file.name} » impossible : ${(err && err.message) || 'format non pris en charge'}.` } }); }
  }
  setPendingSheet(idx) { const p = this.state.pending; if (!p) return; idx = +idx; const headerIdx = this.guessHeader(p.wb[idx].rows); const fields = this.autoMap(p.spec, p.wb[idx].rows[headerIdx]); this.setState({ pending: { ...p, sheetIdx: idx, headerIdx, fields } }); }
  setPendingHeader(idx) { const p = this.state.pending; if (!p) return; idx = +idx; const fields = this.autoMap(p.spec, p.wb[p.sheetIdx].rows[idx]); this.setState({ pending: { ...p, headerIdx: idx, fields } }); }
  setPendingField(key, idx) { const p = this.state.pending; if (!p) return; this.setState({ pending: { ...p, fields: { ...p.fields, [key]: +idx } } }); }
  setPendingCombine(v) { const p = this.state.pending; if (!p) return; this.setState({ pending: { ...p, combine: !!v } }); }
  cancelImport() { this.setState({ pending: null }); }
  _buildReportHtml() {
    const d = this._reportData; if (!d) return;
    const optsDef = { synthese: true, tresorerie: true, relances: true, fournisseurs: true, credits: false, notes: true };
    const o = { ...optsDef, ...(this.state.reportOpts || {}) };
    const note = (this.state.reportNote || '').trim();
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const accent = this.entCfg().accent;
    const soft5 = this.hexToRgba(accent, 0.05), soft10 = this.hexToRgba(accent, 0.1);
    const n = new Date();
    const stamp = `${this.dd(n.getDate())}/${this.dd(n.getMonth() + 1)}/${n.getFullYear()} à ${this.dd(n.getHours())}:${this.dd(n.getMinutes())}`;
    let b = '';
    if (o.synthese && d.kpis.length) b += `<section><h2>Synthèse</h2><div class="cards">` + d.kpis.map(k => `<div class="card"><div class="cl">${esc(k.label)}</div><div class="cv">${esc(k.value)}</div>${k.note ? `<div class="cn">${esc(k.note)}</div>` : ''}</div>`).join('') + `</div></section>`;
    if (o.tresorerie) {
      b += `<section><h2>Trésorerie</h2><div class="cards">`;
      b += `<div class="card hl"><div class="cl">Trésorerie nette</div><div class="cv">${esc(d.tresoNette)}</div><div class="cn">solde compte + à encaisser − à régler</div></div>`;
      if (d.soldeCompte != null) b += `<div class="card"><div class="cl">Solde du compte</div><div class="cv">${esc(d.soldeCompte)}</div><div class="cn">${esc(d.soldeSource)}</div></div>`;
      b += `<div class="card"><div class="cl">On me doit (clients)</div><div class="cv">${esc(d.onMeDoit)}</div></div>`;
      b += `<div class="card"><div class="cl">Je dois (fournisseurs)</div><div class="cv">${esc(d.jeDois)}</div></div>`;
      b += `</div></section>`;
    }
    if (o.relances) {
      b += `<section><h2>Relances clients <span class="badge">${d.relance.length} · ${esc(d.relanceTotal)}</span></h2>`;
      b += d.relance.length ? `<table><thead><tr><th>Client</th><th>N°</th><th>Échéance</th><th>Délai</th><th class="r">Reste dû</th><th>Statut</th></tr></thead><tbody>` + d.relance.map(r => `<tr><td>${esc(r.partner)}</td><td class="mono">${esc(r.ref)}</td><td>${esc(r.due)}</td><td>${esc(r.delai)}</td><td class="r mono">${esc(r.reste)}</td><td>${esc(r.statut)}</td></tr>`).join('') + `</tbody></table>` : `<p class="empty">Aucune facture client à encaisser.</p>`;
      b += `</section>`;
    }
    if (o.fournisseurs) {
      b += `<section><h2>Échéances fournisseurs <span class="badge">${d.fourn.length} · ${esc(d.fournTotal)}</span></h2>`;
      b += d.fourn.length ? `<table><thead><tr><th>Fournisseur</th><th>N°</th><th>Échéance</th><th class="r">Reste à payer</th></tr></thead><tbody>` + d.fourn.map(r => `<tr><td>${esc(r.partner)}</td><td class="mono">${esc(r.ref)}</td><td>${esc(r.due)}</td><td class="r mono">${esc(r.reste)}</td></tr>`).join('') + `</tbody></table>` : `<p class="empty">Aucune facture fournisseur à régler.</p>`;
      b += `</section>`;
    }
    if (o.credits) {
      b += `<section><h2>Crédits &amp; assurances <span class="badge">${esc(d.mensTot)} / mois</span></h2>`;
      b += d.credits.length ? `<table><thead><tr><th>Engagement</th><th>Organisme</th><th class="r">Mensualité</th><th class="r">Capital restant</th></tr></thead><tbody>` + d.credits.map(c => `<tr><td>${esc(c.label)}</td><td>${esc(c.ent)}</td><td class="r mono">${esc(c.mens)}</td><td class="r mono">${esc(c.reste)}</td></tr>`).join('') + `</tbody></table>` : `<p class="empty">Aucun crédit enregistré.</p>`;
      b += `</section>`;
    }
    if (o.notes && note) b += `<section><h2>Notes</h2><div class="note">${esc(note).replace(/\n/g, '<br>')}</div></section>`;
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Compte rendu — ${esc(d.periodLabel)}</title><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0e1b2e;background:#f4f6fa}.sheet{max-width:820px;margin:24px auto;background:#fff;padding:38px 44px;box-shadow:0 2px 12px rgba(16,32,54,.08)}header.rh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${accent};padding-bottom:16px}header.rh .t{font-size:22px;font-weight:800}header.rh .s{font-size:13px;color:#5a6b80;margin-top:4px}header.rh .m{font-size:12px;color:#8291a5;text-align:right;line-height:1.5}section{margin-top:22px;page-break-inside:avoid}h2{font-size:15px;font-weight:700;margin:0 0 10px;display:flex;align-items:center;gap:10px}.badge{font-size:11.5px;font-weight:600;color:${accent};background:${soft10};padding:3px 9px;border-radius:20px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{border:1px solid #e6ebf2;border-radius:10px;padding:12px 14px}.card.hl{border-color:${accent};background:${soft5}}.cl{font-size:11.5px;color:#69788c;font-weight:500}.cv{font-size:19px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums}.cn{font-size:11px;color:#9aa7b8;margin-top:3px}table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#93a1b3;padding:7px 8px;border-bottom:1.5px solid #e6ebf2}td{padding:8px;border-bottom:1px solid #f1f4f8}.r{text-align:right}.mono{font-variant-numeric:tabular-nums;font-family:'SFMono-Regular',Consolas,monospace}.empty{font-size:12.5px;color:#9aa7b8;font-style:italic}.note{font-size:13px;line-height:1.55;white-space:pre-wrap;border:1px solid #e6ebf2;border-radius:10px;padding:14px 16px;background:#fbfcfe}footer{margin-top:26px;padding-top:14px;border-top:1px solid #eef1f6;font-size:11px;color:#aeb8c6;text-align:center}.bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #e6ebf2;padding:10px 16px;display:flex;gap:10px;justify-content:flex-end}.bar button{padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${accent};background:${accent};color:#fff}.bar button.sec{background:#fff;color:#475569;border-color:#d7dde6}@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none;padding:0}.bar{display:none}@page{margin:14mm}}</style></head><body><div class="bar"><button class="sec" onclick="window.close()">Fermer</button><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div><div class="sheet"><header class="rh"><div style="display:flex;gap:14px;align-items:flex-start">${this.entCfg().logo ? `<img src="${esc(this.entCfg().logo)}" alt="" style="width:46px;height:46px;border-radius:10px;object-fit:cover">` : ''}<div><div class="t">Compte rendu</div><div class="s">${esc(d.periodLabel)}</div></div></div><div class="m">${esc(d.header || this.entCfg().nom)}<br>édité le ${esc(stamp)}</div></header>${b || '<p class="empty">Aucune section sélectionnée.</p>'}<footer>Compte rendu généré depuis le tableau de bord — ${esc(d.periodLabel)}</footer></div></body></html>`;
    return html;
  }
  _reportSlug() { const d = this._reportData; const base = ((d && d.periodLabel) || 'compte-rendu').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); return 'compte-rendu-' + (base || 'periode'); }
  // ---------- fiche de pr\u00e9sence hebdomadaire imprimable (Heures) ----------
  _buildHeuresReportHtml() {
    const d = this._heuresReportData; if (!d) return '';
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const accent = this.entCfg().accent;
    const n = new Date();
    const stamp = `${this.dd(n.getDate())}/${this.dd(n.getMonth() + 1)}/${n.getFullYear()}`;
    const emps = d.employees.length ? d.employees : [{ name: '\u2014', days: [], weekTotal: '0h00' }];
    const monthly = d.mode === 'month';
    const sheets = emps.map((e, i) => `
      <div class="sheet${monthly ? ' monthly' : ''}${i < emps.length - 1 ? ' brk' : ''}">
        <header class="rh">
          <div><div class="t">Fiche de pr\u00e9sence ${monthly ? 'mensuelle' : 'hebdomadaire'}</div><div class="s">${monthly ? 'Mois de ' : 'Semaine du '}${esc(d.periodLabel)}</div></div>
          <div class="m">Suivi Achat / Vente<br>\u00e9dit\u00e9 le ${esc(stamp)}</div>
        </header>
        <div class="empname"><span>Nom du salari\u00e9</span><strong>${esc(e.name)}</strong></div>
        <table>
          <thead><tr><th>Jour</th><th>Date</th><th class="r">Arriv\u00e9e</th><th class="r">D\u00e9part</th><th class="r">Pause d\u00e9duite</th><th class="r">Total jour</th></tr></thead>
          <tbody>${e.days.map(r => `<tr><td>${esc(r.dow)}</td><td class="mono">${esc(r.date)}</td><td class="r mono">${esc(r.arr)}</td><td class="r mono">${esc(r.dep)}</td><td class="r mono">${esc(r.pause)}</td><td class="r mono tot">${esc(r.total)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="5">Total ${monthly ? 'du mois' : 'de la semaine'}</td><td class="r mono tot">${esc(e.weekTotal)}</td></tr></tfoot>
        </table>
        <div class="visas">
          <div class="visa"><div class="vl">Visa du salari\u00e9</div><div class="vline"></div><div class="vd">Fait \u00e0 _______________, le ____ / ____ / ______</div></div>
          <div class="visa"><div class="vl">Visa du responsable</div><div class="vline"></div><div class="vd">Fait \u00e0 _______________, le ____ / ____ / ______</div></div>
        </div>
      </div>`).join('');
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Fiche de pr\u00e9sence \u2014 ${esc(d.periodLabel)}</title><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0e1b2e;background:#f4f6fa}.sheet{max-width:820px;margin:24px auto;background:#fff;padding:38px 44px;box-shadow:0 2px 12px rgba(16,32,54,.08)}.sheet.brk{page-break-after:always}header.rh{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${accent};padding-bottom:16px}header.rh .t{font-size:20px;font-weight:800}header.rh .s{font-size:13px;color:#5a6b80;margin-top:4px}header.rh .m{font-size:12px;color:#8291a5;text-align:right;line-height:1.5}.empname{display:flex;align-items:baseline;gap:10px;margin-top:20px;padding:10px 14px;background:#f6f8fc;border:1px solid #eef1f6;border-radius:8px;font-size:13px}.empname span{color:#69788c}.empname strong{font-size:15px;color:#0e1b2e}table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:18px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#93a1b3;padding:7px 8px;border-bottom:1.5px solid #e6ebf2}td{padding:8px;border-bottom:1px solid #f1f4f8}tfoot td{border-top:2px solid #0e1b2e;border-bottom:none;font-weight:700;padding-top:10px}.monthly{padding-top:24px}.monthly header.rh{padding-bottom:10px}.monthly .empname{margin-top:10px;padding:7px 11px}.monthly table{margin-top:10px;font-size:10.5px}.monthly th{font-size:9px;padding:4px 6px}.monthly td{padding:3px 6px}.monthly .visas{margin-top:18px}.monthly .visa .vl{margin-bottom:20px}.r{text-align:right}.mono{font-variant-numeric:tabular-nums;font-family:'SFMono-Regular',Consolas,monospace}.tot{font-weight:700}.visas{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:44px}.visa .vl{font-size:12px;font-weight:700;color:#0e1b2e;margin-bottom:34px}.visa .vline{border-top:1px solid #b7c0cc}.visa .vd{font-size:11px;color:#8291a5;margin-top:8px}.bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #e6ebf2;padding:10px 16px;display:flex;gap:10px;justify-content:flex-end;z-index:1}.bar button{padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${accent};background:${accent};color:#fff}.bar button.sec{background:#fff;color:#475569;border-color:#d7dde6}@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none;padding:0}.bar{display:none}@page{size:A4 portrait;margin:12mm}}</style></head><body><div class="bar"><button class="sec" onclick="window.close()">Fermer</button><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>${sheets}</body></html>`;
  }
  generateHeuresReport() {
    const html = this._buildHeuresReportHtml();
    if (!html) return;
    const w = window.open('', '_blank');
    if (!w) { this.setState({ msg: { kind: 'error', text: 'Fen\u00eatre bloqu\u00e9e \u2014 autorisez les pop-ups pour imprimer la fiche de pr\u00e9sence.' } }); return; }
    try { w.opener = null; } catch (e) {}
    w.document.open(); w.document.write(html); w.document.close();
  }
  generateReport() {
    const html = this._buildReportHtml();
    const w = window.open('', '_blank');
    if (!w) { this.setState({ reportOpen: false, msg: { kind: 'error', text: 'Fenêtre bloquée — autorisez les pop-ups, ou utilisez « Enregistrer » pour télécharger le compte rendu.' } }); return; }
    w.document.open(); w.document.write(html); w.document.close();
    this.setState({ reportOpen: false });
  }
  saveReport() {
    const html = this._buildReportHtml();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = this._reportSlug() + '.html'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    this.setState({ reportOpen: false, msg: { kind: 'success', text: 'Compte rendu enregistré — ouvrez le fichier puis imprimez-le en PDF si besoin.' } });
  }
  _stashMapInfo(kind, wb, sheetIdx, headerIdx, fields) {
    try {
      const hdr = wb[sheetIdx].rows[headerIdx] || [];
      const lbl = k => fields[k] >= 0 ? (String(hdr[fields[k]] || '').trim() || ('col ' + (fields[k] + 1))) : '—';
      this._mapInfo = { kind, sheet: wb[sheetIdx].name, desc: `Réglé ← ${lbl('paid')} · Solde ← ${lbl('solde')} · État ← ${lbl('status')} · Payé le ← ${lbl('paidDate')}` };
    } catch (e) { this._mapInfo = null; }
  }
  confirmImport() {
    const p = this.state.pending; if (!p) return;
    this._stashMapInfo(p.kind, p.wb, p.sheetIdx, p.headerIdx, p.fields);
    const tsv = this.emitTSV(p);
    // Aucune ligne de données reconnue : on garde l'écran ouvert pour changer de feuille ou
    // d'en-tête, au lieu d'un message trompeur « colonnes introuvables » après coup.
    if (tsv.indexOf('\n') < 0) return;
    this.saveMapping(p.kind, { sheetName: p.wb[p.sheetIdx].name, headerIdx: p.headerIdx, fields: p.fields, combine: p.combine });
    const imported = this.applyImport(p.kind, tsv, p.name);
    if (p.kind === 'ventes') { this.applySalesPayments(p.wb, p.name, imported && imported.list); this.extractGrenke(p.wb, p.name); }
    if (p.kind === 'stock') this.applyStockEspeces(p.wb, p.name);
    if (p.handle) this.watch(p.kind, p.name, p.handle, p.lastMod);
    this.setState({ pending: null });
  }
  // Import manuel d'un seul fichier Stock (hors dossier surveillé) — même détail par espèce
  // que refreshStockFolder, fusionné par nom de fichier pour ne pas dupliquer une semaine déjà connue.
  applyStockEspeces(wb, name) {
    const esp = this.mapStockEspeces(wb);
    const prev = (this.state.stockEspeces || []).filter(s => s.file !== name);
    const merged = [{ file: name, sem: name, ...esp }, ...prev];
    this.setState({ stockEspeces: merged });
    this.saveJSON(Component.STKESP_KEY, { name, rows: merged });
  }
  extractGrenke(wb, name) {
    const gi = wb.findIndex(s => /grenke/i.test(s.name || ''));
    if (gi < 0) return;
    const rows = wb[gi].rows || [];
    let hi = -1; for (let i = 0; i < Math.min(rows.length, 12); i++) { const r = (rows[i] || []).map(c => this._norm(c)).join('|'); if (/invoice|payment|received|total ttc/.test(r)) { hi = i; break; } }
    if (hi < 0) return;
    const H = (rows[hi] || []).map(c => this._norm(c));
    const col = (...ks) => { for (const k of ks) { const idx = H.findIndex(h => h.includes(this._norm(k))); if (idx >= 0) return idx; } return -1; };
    const ci = { ref: col('invoice number', 'invoice', 'numero', 'facture'), cust: col('customer', 'client', 'nom'), ttc: col('total ttc', 'ttc'), p1: col('1er payment', '1st payment', 'premier', 'paiement 1', 'payment 1'), p2: col('2e payment', '2nd payment', 'deuxieme', 'paiement 2', 'payment 2'), rem: col('remains', 'restant', 'reste'), charge: col('charges', 'charge', 'fee'), recv: col('total received', 'received', 'recu'), st: col('statut', 'status') };
    if (ci.ref < 0 && ci.ttc < 0) return;
    const list = [];
    rows.slice(hi + 1).forEach(r => {
      const ref = ci.ref >= 0 ? String(r[ci.ref] || '').trim() : '';
      const ttc = ci.ttc >= 0 ? (this.parseAmount(r[ci.ttc]) || 0) : 0;
      if (!ref && !ttc) return;
      const p1 = ci.p1 >= 0 ? (this.parseAmount(r[ci.p1]) || 0) : 0;
      const p2 = ci.p2 >= 0 ? (this.parseAmount(r[ci.p2]) || 0) : 0;
      const charge = ci.charge >= 0 ? (this.parseAmount(r[ci.charge]) ?? 0) : 0;
      const _rv = ci.recv >= 0 ? this.parseAmount(r[ci.recv]) : null; const recv = (_rv != null && _rv !== 0) ? _rv : (p1 + p2);
      // restant = total − paiement 1 − paiement 2 − charges ; la valeur du fichier (Remains) prime quand elle existe
      const remRaw = ci.rem >= 0 ? this.parseAmount(r[ci.rem]) : null;
      const rem = remRaw != null ? remRaw : Math.round((ttc - p1 - p2 - charge) * 100) / 100;
      const statut = ci.st >= 0 ? String(r[ci.st] || '').trim() : '';
      list.push({ ref, cust: ci.cust >= 0 ? String(r[ci.cust] || '').trim() : '', ttc, p1, p2, recv, rem, charge, statut });
    });
    if (!list.length) return;
    this.setState({ grenke: list, grenkeName: name });
    this.saveJSON(Component.GRENKE_KEY, { name, rows: list });
  }
  saveMapping(kind, m) { const all = { ...(this.state.mappings || {}) }; all[kind] = m; this.setState({ mappings: all }); this.saveJSON(Component.MAP_KEY, all); }
  async reimportSilent(it) {
    const file = await it.handle.getFile();
    const buf = await file.arrayBuffer();
    const wb = await this.readWorkbook(buf); if (!wb.length) return;
    const spec = this.importSpec(it.kind); const m = (this.state.mappings || {})[it.kind];
    let sheetIdx = (m && spec.forceSheetIndex == null) ? wb.findIndex(s => s.name === m.sheetName) : -1; if (sheetIdx < 0) sheetIdx = this.guessSheet(spec, wb);
    const headerIdx = m ? m.headerIdx : this.guessHeader(wb[sheetIdx].rows);
    const fields = m ? this.mergeFields(spec, m.fields, wb[sheetIdx].rows[headerIdx]) : this.autoMap(spec, wb[sheetIdx].rows[headerIdx]);
    this._stashMapInfo(it.kind, wb, sheetIdx, headerIdx, fields);
    const tsv = this.emitTSV({ kind: it.kind, wb, sheetIdx, headerIdx, fields, combine: m ? m.combine : false, spec });
    if (tsv.indexOf('\n') < 0) return; // fichier momentanément vide : on garde les données déjà importées
    const imported = this.applyImport(it.kind, tsv, it.name, true);
    if (it.kind === 'ventes') { this.applySalesPayments(wb, it.name, imported && imported.list); this.extractGrenke(wb, it.name); }
    if (it.kind === 'stock') this.applyStockEspeces(wb, it.name);
  }
  // ---------- STOCK : dossier lu en continu ----------
  async connectStockFolder() {
    if (!('showDirectoryPicker' in window)) { this.setState({ msg: { kind: 'error', text: "La lecture de dossier fonctionne sur Chrome ou Edge (ordinateur). Ouvrez-y le tableau de bord pour connecter votre dossier Stock." } }); return; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this._pendingDir = dir;
      this.setState({ prefixAsk: { kind: 'stock', dirName: dir.name }, prefixAskValue: this.prefixOf('stock') });
    } catch (e) { if (e && e.name === 'AbortError') return; this.setState({ msg: { kind: 'error', text: "Connexion du dossier Stock refusée ou indisponible ici." } }); }
  }
  async connectBordereauxFolder() {
    if (!('showDirectoryPicker' in window)) { this.setState({ msg: { kind: 'error', text: "La lecture de dossier fonctionne sur Chrome ou Edge (ordinateur). Ouvrez-y le tableau de bord pour connecter votre dossier Bordereaux." } }); return; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this._pendingDir = dir;
      this.setState({ prefixAsk: { kind: 'livraison', dirName: dir.name }, prefixAskValue: this.prefixOf('livraison') });
    } catch (e) { if (e && e.name === 'AbortError') return; this.setState({ msg: { kind: 'error', text: "Connexion du dossier Bordereaux de livraison refusée ou indisponible ici." } }); }
  }
  async connectTransportFolder() {
    if (!('showDirectoryPicker' in window)) { this.setState({ msg: { kind: 'error', text: "La lecture de dossier fonctionne sur Chrome ou Edge (ordinateur)." } }); return; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this._pendingDir = dir;
      this.setState({ prefixAsk: { kind: 'transport', dirName: dir.name }, prefixAskValue: this.prefixOf('transport') });
    } catch (e) { if (e && e.name === 'AbortError') return; this.setState({ msg: { kind: 'error', text: "Connexion du dossier Bordereaux de transport refusée ou indisponible ici." } }); }
  }
  prefixOf(kind) { const p = (this.state.prefixes || {})[kind]; return (p != null && p !== '') ? p : (Component.DEFAULT_PREFIX[kind] || ''); }
  matchPrefix(name, prefix) { if (!prefix) return true; return this._norm(name).startsWith(this._norm(prefix)); }
  cancelPrefix() { this._pendingDir = null; this.setState({ prefixAsk: null }); }
  async confirmPrefix() {
    const ask = this.state.prefixAsk; const dir = this._pendingDir; if (!ask || !dir) { this.setState({ prefixAsk: null }); return; }
    const kind = ask.kind; const prefix = (this.state.prefixAskValue || '').trim();
    const prefixes = { ...(this.state.prefixes || {}), [kind]: prefix }; this.saveJSON(Component.PREFIX_KEY, prefixes);
    this.setState({ prefixes, prefixAsk: null });
    if (kind === 'stock') { this._stockDir = dir; this.idbSet('dir:stock', { type: 'dir', role: 'stock', name: dir.name, handle: dir }); await this.refreshStockFolder(dir, false); }
    else if (kind === 'transport') { this._transpDir = dir; this.idbSet('dir:transp', { type: 'dir', role: 'transp', name: dir.name, handle: dir }); await this.refreshTransportFolder(dir, false); }
    else { this._blDir = dir; this.idbSet('dir:bl', { type: 'dir', role: 'bl', name: dir.name, handle: dir }); await this.refreshLivraisonFolder(dir, false); }
    this.startWatching();
  }
  // parcourt un dossier + sous-dossiers (3 niveaux) et rend [nom, handle] pour chaque fichier
  async listFilesDeep(dir, maxDepth) {
    const out = [];
    const walk = async (handle, depth) => {
      for await (const [name, h] of handle.entries()) {
        if (name.startsWith('.') || name.startsWith('~$')) continue;
        if (h.kind === 'file') out.push([name, h]);
        else if (h.kind === 'directory' && depth < maxDepth) await walk(h, depth + 1);
      }
    };
    await walk(dir, 1);
    return out;
  }
  analyzeStockWorkbook(wb, fileName) {
    const summaries = [];
    (wb || []).forEach((sh, index) => {
      const res = this.mapStock((sh.rows || []).map(r => r.join('\t')).join('\n'), fileName);
      if (!res.list || !res.list.length) return;
      const poids = res.list.reduce((s, r) => s + (+r.poids || 0), 0);
      const valo = res.list.reduce((s, r) => s + (+r.valo || 0), 0);
      if (!poids && !valo) return;
      summaries.push({ index, name: sh.name || `Feuille ${index + 1}`, poids, valo });
    });
    const recapCandidates = summaries.filter(s => /(^|\b)(recap|recapitulatif|synthese|resume|total)(\b|$)/i.test(this._norm(s.name)));
    if (recapCandidates.length !== 1) return { total: summaries.reduce((a, s) => ({ poids: a.poids + s.poids, valo: a.valo + s.valo }), { poids: 0, valo: 0 }), check: { file: fileName, status: 'À vérifier', reason: recapCandidates.length ? 'Plusieurs feuilles récapitulatives détectées' : 'Aucune feuille récapitulative détectée', sheetsRead: (wb || []).length } };
    const recap = recapCandidates[0];
    const details = summaries.filter(s => s.index !== recap.index);
    const detailTotal = details.reduce((a, s) => ({ poids: a.poids + s.poids, valo: a.valo + s.valo }), { poids: 0, valo: 0 });
    const diffPoids = Math.round((recap.poids - detailTotal.poids) * 1000) / 1000;
    const diffValo = Math.round((recap.valo - detailTotal.valo) * 100) / 100;
    const ok = Math.abs(diffPoids) < 0.001 && Math.abs(diffValo) < 0.01;
    return { total: { poids: recap.poids, valo: recap.valo }, check: { file: fileName, status: ok ? 'Conforme' : 'Écart détecté', recap: recap.name, sheetsRead: (wb || []).length, detailSheets: details.length, diffPoids, diffValo } };
  }
  async refreshStockFolder(dir, silent) {
    const prefix = this.prefixOf('stock');
    const files = [];
    for (const [name, h] of await this.listFilesDeep(dir, 3)) { if (/\.(xlsx|xlsm)$/i.test(name) && this.matchPrefix(name, prefix)) files.push({ name, handle: h }); }
    if (!files.length) { if (!silent) this.setState({ msg: { kind: 'error', text: `Aucun fichier commençant par « ${prefix} » dans « ${dir.name} ».` } }); return; }
    const list = []; const listEspeces = []; const stockChecks = []; let maxMod = 0; this._stockHandles = {};
    for (const f of files) {
      try {
        const file = await f.handle.getFile(); maxMod = Math.max(maxMod, file.lastModified);
        const wb = await this.readWorkbook(await file.arrayBuffer());
        const analysis = this.analyzeStockWorkbook(wb, f.name);
        const sem = String(f.name).replace(/\.(xlsx|xlsm)$/i, '');
        const esp = this.mapStockEspeces(wb);
        // Total de la semaine = SOMME du détail par espèce corrigé (grand total pour un produit à
        // calibres, bloc par bloc pour les feuilles multi-produits). On n'utilise JAMAIS la feuille
        // RECAP VENTES pour ce total : elle est souvent cassée (#REF!) et donnait un total faux (ex. 81,70 €).
        const tot = this.stockTotalFromEspeces(esp);
        if (tot.poids || tot.valo) list.push({ file: f.name, sem, poids: tot.poids, valo: tot.valo });
        stockChecks.push(analysis.check);
        listEspeces.push({ file: f.name, sem, ...esp });
        this._stockHandles[f.name] = f.handle;
      }
      catch (e) { /* fichier verrouillé : on réessaiera */ }
    }
    list.sort((a, b) => (a.sem < b.sem ? 1 : -1));
    listEspeces.sort((a, b) => (a.sem < b.sem ? 1 : -1));
    this._stockDir = dir; this._stockMax = maxMod;
    const stockErrors = stockChecks.filter(c => c && c.status !== 'Conforme');
    const patchStock = { stock: list, stockName: dir.name, folderStock: { name: dir.name, count: files.length, prefix }, stockEspeces: listEspeces, stockChecks };
    if (!silent) patchStock.msg = stockErrors.length ? { kind: 'error', text: `${stockErrors.length} fichier(s) Stock présentent un écart ou un récapitulatif ambigu. Consultez l'alerte Stock.` } : { kind: 'success', text: `Dossier Stock « ${dir.name} » — ${list.length} inventaire(s), récapitulatifs conformes aux feuilles détaillées.` };
    this.setState(patchStock);
    this.saveJSON(Component.STK_KEY, { name: dir.name, rows: list });
    this.saveJSON(Component.STKESP_KEY, { name: dir.name, rows: listEspeces });
  }
  async openHandleFile(handle, name) { try { const file = typeof handle.getFile === 'function' ? await handle.getFile() : handle; const nm = name || file.name || 'document';
    this._previewHandle = (typeof handle.createWritable === 'function') ? handle : null;
    // Excel / CSV : TOUJOURS l'aperçu intégré — jamais de téléchargement, même si la lecture échoue
    if (/\.(xlsx|xlsm)$/i.test(nm)) {
      let wb = null; try { wb = await this.readWorkbook(await file.arrayBuffer()); } catch (e) { wb = null; }
      if (wb && wb.length) { this._previewBlob = file; this.setState({ filePreview: { name: nm, wb, si: 0, dirty: false, saveState: this._previewHandle ? 'writable' : 'readonly' } }); }
      else { this._previewBlob = file; this.setState({ filePreview: { name: nm, wb: [], si: 0, unreadable: true } }); }
      return true;
    }
    if (/\.csv$/i.test(nm)) {
      let rows = [];
      try { const txt = await file.text(); const lines = txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim()); const head = lines[0] || ''; const delim = [['\t', (head.match(/\t/g) || []).length], [';', (head.match(/;/g) || []).length], [',', (head.match(/,/g) || []).length]].sort((a, b) => b[1] - a[1])[0][0]; rows = lines.map(l => l.split(delim)); } catch (e) { rows = []; }
      this._previewBlob = file; this.setState({ filePreview: { name: nm, wb: rows.length ? [{ name: 'CSV', rows }] : [], si: 0, unreadable: !rows.length } });
      return true;
    }
    // PDF & images : le navigateur les affiche dans un onglet (pas de téléchargement)
    if (/\.(pdf|png|jpe?g|gif|webp|svg|bmp)$/i.test(nm)) {
      const url = URL.createObjectURL(file); const w = window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); return !!w;
    }
    // Word / PowerPoint / autres formats : le navigateur ne peut pas les afficher ni lancer l'application par défaut sur le fichier original (limite du navigateur, pas du tableau de bord) — on prévient avant de télécharger.
    this.setState({ msg: { kind: 'info', text: `« ${nm} » ne s'affiche pas dans le navigateur — téléchargement pour l'ouvrir avec votre application par défaut (Word, PowerPoint…).` } });
    const url2 = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url2; a.download = nm; a.click(); setTimeout(() => URL.revokeObjectURL(url2), 60000);
    return true;
    } catch (e) { return false; } }
  openStockFile(name) { const h = (this._stockHandles || {})[name]; if (h) { this.openHandleFile(h); return; } const l = (this.state.links || {}).stock; if (l) this.openUrl(l); else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Reconnectez le dossier Stock (ou ajoutez son lien) pour ouvrir les fichiers.' } }); }
  // « Modifier à la source » : ouvre l'aperçu ÉDITABLE du fichier Stock, positionné sur la feuille
  // de l'espèce. Les corrections s'enregistrent dans le vrai fichier (dossier connecté en écriture)
  // et le tableau de bord se met à jour automatiquement au cycle suivant.
  async openStockSpecies(file, species) {
    const h = (this._stockHandles || {})[file];
    if (!h) { this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Reconnectez le dossier Stock (en écriture) pour modifier les fichiers à la source.' } }); return; }
    await this.openHandleFile(h, file);
    const fp = this.state.filePreview;
    if (fp && Array.isArray(fp.wb)) { const idx = fp.wb.findIndex(s => this._norm(s.name) === this._norm(species)); if (idx >= 0) this.setState({ filePreview: { ...fp, si: idx } }); }
  }
  async refreshLivraisonFolder(dir, silent) {
    const prefix = this.prefixOf('livraison');
    const files = []; this._blHandles = this._blHandles || {};
    for (const [name, h] of await this.listFilesDeep(dir, 3)) { if (/\.(xlsx|xlsm|pdf|csv|jpg|jpeg|png)$/i.test(name) && this.matchPrefix(name, prefix)) { files.push({ name, type: 'Livraison', transporteur: '—' }); this._blHandles[name] = h; } }
    let maxMod = 0; for (const f of files) { try { const fl = await this._blHandles[f.name].getFile(); maxMod = Math.max(maxMod, fl.lastModified); } catch (e) {} }
    this._blDir = dir; this._blMax = maxMod;
    this.setState({ folderBl: { name: dir.name, count: files.length, prefix } });
    this._blLivraison = files;
    this.commitBlLibrary(`Dossier livraison « ${dir.name} » — ${files.length} fichier(s) « ${prefix}… ».`, silent);
  }
  async refreshTransportFolder(dir, silent) {
    const raw = (this.prefixOf('transport') || '').trim();
    const prefixes = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const files = []; this._transpHandles = this._transpHandles || {};
    for (const [name, h] of await this.listFilesDeep(dir, 3)) { if (!/\.(xlsx|xlsm|pdf|csv|jpg|jpeg|png)$/i.test(name)) continue; let tr = null; if (!prefixes.length) tr = '—'; else { for (const p of prefixes) { if (this.matchPrefix(name, p)) { tr = p; break; } } } if (tr == null) continue; files.push({ name, type: 'Transport', transporteur: tr }); this._transpHandles[name] = h; }
    let maxMod = 0; for (const f of files) { try { const fl = await this._transpHandles[f.name].getFile(); maxMod = Math.max(maxMod, fl.lastModified); } catch (e) {} }
    this._transpDir = dir; this._transpMax = maxMod;
    this.setState({ folderTransp: { name: dir.name, count: files.length, prefixes } });
    this._blTransport = files;
    this.commitBlLibrary(`Dossier transport « ${dir.name} » — ${files.length} fichier(s) (${prefixes.length || 'tous'} transporteur${prefixes.length > 1 ? 's' : ''}).`, silent);
  }
  commitBlLibrary(msgText, silent) {
    const lib = [...(this._blLivraison || []), ...(this._blTransport || [])];
    const patch = { blLibrary: lib };
    if (!silent) patch.msg = { kind: 'success', text: msgText };
    this.setState(patch);
    this.saveJSON(Component.BLLIB_KEY, { rows: lib.map(f => ({ name: f.name, type: f.type, transporteur: f.transporteur })) });
  }
  openBlFile(name) { const h = (this._blHandles || {})[name] || (this._transpHandles || {})[name]; if (h) { this.openHandleFile(h); return; } this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Reconnectez le dossier des bordereaux pour ouvrir les fichiers.' } }); }

  // ---------- détail Stock par espèce (comptabilité analytique) — lecteur défensif ----------
  // Lecteur du bloc « RESUME(E) BENEFICES ». DEUX structures réelles coexistent :
  //   • Type A — un seul produit réparti en calibres (ex. HOMARD : 4/6, 6/8…), TERMINÉ par des
  //     colonnes de GRAND TOTAL « POIDS TOTAL » / « PRIX TOTAL » / « PRIX MOYEN ». Le bon chiffre
  //     est le grand total — surtout PAS la somme des calibres (sinon on double/triple-compte,
  //     c'était le bug 61 041 € au lieu de 29 686,84 €).
  //   • Type B — plusieurs sous-produits côte à côte (ex. VEL-BQ-AR : Velvet-crab / Bouquet /
  //     Araignée), chacun sur un bloc de 3 colonnes (poids · prix/kg · prix total), sans grand total.
  //     Chaque bloc est lu séparément → un produit distinct.
  // Chaque valeur porte un ÉTAT : confirmé, recoupé, zéro (normal), référence invalide.
  // On distingue #DIV/0! (normal : division par un poids nul) de #REF! (référence réellement cassée).
  extractSpeciesBenefits(rows, speciesName) {
    const norm = c => this._norm(c).replace(/\s+/g, ' ').trim();
    const readNum = raw => {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) return { st: 'vide' };
      if (/^#div\/?0!?$/i.test(s)) return { st: 'divzero' };                 // normal : poids 0
      if (/^#ref!?$/i.test(s)) return { st: 'ref' };                          // référence cassée
      if (/^#(value|n\/a|name\??|num|null)!?$/i.test(s)) return { st: 'err' };
      const n = this.parseAmount(s);
      return isFinite(n) ? { st: 'ok', n } : { st: 'err' };
    };
    // 1) localiser le titre puis les lignes ACHAT / VENDU (libellé dans une colonne quelconque)
    const titleRe = /^resumee?\s+benefices?$/;
    let ti = -1;
    for (let i = 0; i < rows.length; i++) { if ((rows[i] || []).some(c => titleRe.test(norm(c)))) { ti = i; break; } }
    const findRow = re => {
      const scan = ti >= 0 ? rows.slice(ti, ti + 12).map((r, k) => [ti + k, r]) : rows.map((r, k) => [k, r]);
      for (const [idx, r] of scan) { if ((r || []).some(c => re.test(norm(c)))) return idx; }
      return -1;
    };
    const achatRi = findRow(/prix\s*achat/);
    const venduRi = findRow(/prix\s*vendu/);
    if (achatRi < 0 && venduRi < 0) return { species: speciesName, missing: true, reason: 'bloc bénéfices introuvable' };
    const headRi = Math.min(...[achatRi, venduRi].filter(x => x >= 0)) - 1;
    const header = rows[headRi] || [];
    const nc = header.length;
    // 2) repérer colonnes de grand total (structure A) et blocs nom/poids → prix total (A calibres & B produits)
    let gPoidsCol = -1, gValeurCol = -1;
    const blocks = [];
    for (let c = 0; c < nc; c++) {
      const h = norm(header[c]);
      if (!h) continue;
      if (h === 'poids total') { gPoidsCol = c; continue; }
      if (h === 'prix total') { gValeurCol = c; continue; }                   // grand total (sans suffixe)
      if (/^prix\b/.test(h) || /^poids\b/.test(h)) continue;                  // colonne mesure d'un bloc
      // sinon : NOM de bloc (calibre ou sous-produit) → colonne poids ; valeur = prochain « prix total … »
      let vcol = -1;
      for (let d = c + 1; d < nc; d++) { const hd = norm(header[d]); if (/^prix\s+total/.test(hd)) { vcol = d; break; } if (hd && !/^prix\b/.test(hd) && !/^poids\b/.test(hd)) break; }
      blocks.push({ name: String(header[c] == null ? '' : header[c]).trim() || ('bloc ' + (c + 1)), poidsCol: c, valeurCol: vcol });
    }
    const hasGrand = gPoidsCol >= 0 && gValeurCol >= 0;
    const val = (ri, col) => (ri < 0 || col < 0) ? { st: 'vide' } : readNum((rows[ri] || [])[col]);
    const buildProduct = (name, pcol, vcol, baseState) => {
      const aP = val(achatRi, pcol), aV = val(achatRi, vcol), vP = val(venduRi, pcol), vV = val(venduRi, vcol);
      const anyBad = [aP, aV, vP, vV].some(x => x.st === 'ref' || x.st === 'err');
      const n0 = x => x.st === 'ok' ? x.n : 0;
      const achatPoids = n0(aP), achatValeur = n0(aV), venduPoids = n0(vP), venduValeur = n0(vV);
      const allZero = !achatPoids && !achatValeur && !venduPoids && !venduValeur;
      const state = anyBad ? 'invalide' : (allZero ? 'zero' : (baseState || 'confirme'));
      const benefice = anyBad ? null : venduValeur - achatValeur;
      return {
        name, state,
        achatPoids: aP.st === 'ok' || aV.st === 'ok' ? achatPoids : (allZero ? 0 : null),
        achatValeur: anyBad ? null : achatValeur,
        achatPrix: achatPoids ? achatValeur / achatPoids : null,
        venduPoids: vP.st === 'ok' || vV.st === 'ok' ? venduPoids : (allZero ? 0 : null),
        venduValeur: anyBad ? null : venduValeur,
        venduPrix: venduPoids ? venduValeur / venduPoids : null,
        benefice,
      };
    };
    let products;
    if (hasGrand) {
      // recoupement : somme des calibres ≈ grand total ?
      const sumP = blocks.reduce((s, b) => { const v = val(achatRi, b.poidsCol); return s + (v.st === 'ok' ? v.n : 0); }, 0);
      const sumV = blocks.reduce((s, b) => { const v = val(achatRi, b.valeurCol); return s + (v.st === 'ok' ? v.n : 0); }, 0);
      const gp = val(achatRi, gPoidsCol), gv = val(achatRi, gValeurCol);
      const recoupe = gp.st === 'ok' && gv.st === 'ok' && Math.abs(sumP - gp.n) <= Math.max(0.5, Math.abs(gp.n) * 0.005) && Math.abs(sumV - gv.n) <= Math.max(1, Math.abs(gv.n) * 0.005);
      const main = buildProduct(speciesName, gPoidsCol, gValeurCol, recoupe ? 'recoupe' : 'confirme');
      // détail par calibre (4/6, 6/8…) — visible au clic sur « détail »
      main.calibres = blocks.filter(b => b.valeurCol >= 0).map(b => buildProduct(b.name, b.poidsCol, b.valeurCol, 'confirme'));
      products = [main];
    } else {
      products = blocks.filter(b => b.valeurCol >= 0).map(b => buildProduct(b.name, b.poidsCol, b.valeurCol, 'confirme'));
      if (!products.length) return { species: speciesName, missing: true, reason: 'aucun bloc produit lisible dans cette feuille' };
    }
    const sum = f => products.reduce((s, p) => s + (f(p) || 0), 0);
    const poidsAchete = sum(p => p.achatPoids), poidsVendu = sum(p => p.venduPoids);
    const valeurAchat = sum(p => p.achatValeur), valeurVendu = sum(p => p.venduValeur);
    const prixAchat = poidsAchete ? valeurAchat / poidsAchete : null;
    const prixVente = poidsVendu ? valeurVendu / poidsVendu : null;
    return {
      species: speciesName, missing: false, structure: hasGrand ? 'A' : 'B', products,
      poidsAchete, poidsVendu, valeurAchat, valeurVendu, prixAchat, prixVente,
      prixIncomplet: prixAchat == null || prixVente == null,
    };
  }
  // ---------- profil entreprise (Paramètres → Entreprise) ----------
  // Toutes les valeurs passent par ici avec repli sur les défauts : un profil absent ou
  // partiellement rempli ne casse jamais l'affichage.
  entCfg() {
    const e = this.state.entreprise || {};
    const d = Component.ENT_DEFAULTS;
    const nom = (typeof e.nom === 'string' && e.nom.trim()) ? e.nom.trim() : d.nom;
    const accent = /^#[0-9a-fA-F]{6}$/.test(e.accent || '') ? e.accent : d.accent;
    // Logo : validation STRICTE (sécurité, faille signalée par l'audit croisé). Un logo ne peut venir que
    // du recadrage canvas interne, MAIS il peut aussi provenir d'une sauvegarde restaurée (potentiellement
    // fabriquée). On n'accepte donc qu'un vrai data-URL image base64 — pas d'espaces, guillemets ni chevrons
    // qui permettraient d'injecter du HTML actif dans les rapports imprimés.
    const logo = (typeof e.logo === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(e.logo) && e.logo.length < 3_000_000) ? e.logo : '';
    const esp = Array.isArray(e.especes) ? e.especes.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
    return { nom, accent, logo, especes: esp.length ? esp : d.especes.slice() };
  }
  entInitials() {
    const words = this.entCfg().nom.split(/\s+/).filter(Boolean);
    return (words.length >= 2 ? words[0][0] + words[1][0] : this.entCfg().nom.slice(0, 2)).toUpperCase();
  }
  setEnt(patch) {
    const next = { ...(this.state.entreprise || {}), ...patch };
    this.setState({ entreprise: next });
    this.saveJSON(Component.ENT_KEY, next);
    this._applyEntTitle();
    // La liste des espèces alimente le détail Stock : si un dossier est connecté, on recalcule
    // tout de suite au lieu d'attendre le prochain cycle de surveillance.
    if ('especes' in patch && this._stockDir) this.refreshStockFolder(this._stockDir, true).catch(() => {});
  }
  _applyEntTitle() { try { document.title = 'Dashboard ' + this.entCfg().nom; } catch (e) {} }
  // ---------- profils d'utilisation (sans mot de passe : une aide, pas une sécurité) ----------
  // Un profil « admin » voit tout ; un profil « simplifié » ne voit que les pages cochées
  // pour lui dans Paramètres. Le dernier profil admin ne peut être ni supprimé ni rétrogradé.
  profCfg() {
    const raw = this.state.profils || {};
    const okViews = new Set(Component.PROFIL_VIEWS.map(v => v.view));
    let list = Array.isArray(raw.list) ? raw.list.filter(p => p && typeof p === 'object' && typeof p.id === 'string') : [];
    list = list.map(p => ({
      id: p.id,
      nom: (typeof p.nom === 'string' && p.nom.trim()) ? p.nom.trim() : 'Sans nom',
      role: p.role === 'admin' ? 'admin' : 'simple',
      views: Array.isArray(p.views) ? p.views.filter(v => okViews.has(v)) : Component.PROFIL_DEFAULT_VIEWS.slice(),
    }));
    if (!list.length) list = [{ id: 'admin', nom: this.entCfg().nom, role: 'admin', views: [] }];
    if (!list.some(p => p.role === 'admin')) list[0] = { ...list[0], role: 'admin' };
    const activeId = list.some(p => p.id === raw.activeId) ? raw.activeId : list.find(p => p.role === 'admin').id;
    return { list, activeId };
  }
  activeProfil() { const c = this.profCfg(); return c.list.find(p => p.id === c.activeId) || c.list[0]; }
  isAdminProfil() { return this.activeProfil().role === 'admin'; }
  profilAllowed(view) {
    if (view === 'Messages') return true; // le canal de communication est ouvert à tous les profils
    const p = this.activeProfil();
    if (p.role === 'admin') return true;
    const vs = p.views.length ? p.views : Component.PROFIL_DEFAULT_VIEWS;
    return vs.includes(view);
  }
  saveProfils(cfg) { this.setState({ profils: cfg }); this.saveJSON(Component.PROF_KEY, cfg); }
  setActiveProfil(id, greet) {
    const c = this.profCfg();
    if (!c.list.some(p => p.id === id)) return;
    const next = { ...c, activeId: id };
    const prof = c.list.find(p => p.id === id);
    const patch = { profils: next, profilMenuOpen: false };
    if (this.state.whoOpen) patch.whoOpen = false;
    if (prof.role !== 'admin') {
      const vs = prof.views.length ? prof.views : Component.PROFIL_DEFAULT_VIEWS;
      if (!vs.includes(this.state.view)) patch.view = vs[0] || 'Tableau de bord';
      // fermetures propres des surfaces réservées à l'admin
      patch.pending = null; patch.restorePreview = null;
    }
    patch.msg = greet
      ? { kind: 'success', text: `Bonjour ${prof.nom} !${prof.role === 'admin' ? '' : ' Affichage simplifié : seules vos pages sont visibles.'}` }
      : { kind: 'success', text: `Profil « ${prof.nom} » activé${prof.role === 'admin' ? '' : ' — affichage simplifié'}.` };
    this.setState(patch);
    this.saveJSON(Component.PROF_KEY, next);
  }
  addProfil() {
    const c = this.profCfg();
    const id = 'p' + Date.now().toString(36);
    const nom = 'Nouveau profil';
    this.saveProfils({ ...c, list: [...c.list, { id, nom, role: 'simple', views: Component.PROFIL_DEFAULT_VIEWS.slice() }] });
  }
  updateProfil(id, patch) {
    const c = this.profCfg();
    const target = c.list.find(p => p.id === id); if (!target) return;
    // dernier admin : impossible de le rétrograder
    if (patch.role === 'simple' && target.role === 'admin' && c.list.filter(p => p.role === 'admin').length <= 1) return;
    this.saveProfils({ ...c, list: c.list.map(p => p.id === id ? { ...p, ...patch } : p) });
  }
  deleteProfil(id) {
    const c = this.profCfg();
    const target = c.list.find(p => p.id === id); if (!target) return;
    if (target.role === 'admin' && c.list.filter(p => p.role === 'admin').length <= 1) return;
    const list = c.list.filter(p => p.id !== id);
    const activeId = c.activeId === id ? list.find(p => p.role === 'admin').id : c.activeId;
    this.saveProfils({ list, activeId });
  }
  // ---------- messages entre profils (mémorisés en local, comme le reste) ----------
  // Chaque message garde l'expéditeur (id + nom au moment de l'envoi), le destinataire
  // (« all » ou l'id d'un profil) et la liste des profils qui l'ont lu (badge non-lus).
  msgList() {
    const raw = this.state.messages;
    if (!Array.isArray(raw)) return [];
    return raw.filter(m => m && typeof m === 'object' && typeof m.text === 'string' && m.text.trim());
  }
  _saveMessages(list) {
    this.setState({ messages: list });
    this.saveJSON(Component.MSG_KEY, { list });
    try { this._msgLastRaw = localStorage.getItem(Component.MSG_KEY) || ''; } catch (e) {}
  }
  sendMessage() {
    const text = (this.state.msgText || '').trim();
    if (!text) return;
    const me = this.activeProfil();
    const to = this.state.msgTo === 'all' ? 'all' : this.state.msgTo;
    const m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from: me.id, fromNom: me.nom, to, text: text.slice(0, 2000), ts: Date.now(), readBy: [me.id] };
    this._saveMessages([...this.msgList(), m]);
    this.setState({ msgText: '' });
  }
  deleteMessage(id) {
    const me = this.activeProfil();
    const m = this.msgList().find(x => x.id === id); if (!m) return;
    if (m.from !== me.id && me.role !== 'admin') return; // seul l'auteur (ou un admin) supprime
    this._saveMessages(this.msgList().filter(x => x.id !== id));
  }
  markMessagesRead() {
    const me = this.activeProfil();
    const list = this.msgList();
    let changed = false;
    const next = list.map(m => {
      const forMe = m.to === 'all' || m.to === me.id || m.from === me.id;
      const rb = Array.isArray(m.readBy) ? m.readBy : [];
      if (forMe && !rb.includes(me.id)) { changed = true; return { ...m, readBy: [...rb, me.id] }; }
      return m;
    });
    if (changed) this._saveMessages(next);
  }
  msgUnreadCount() {
    const me = this.activeProfil();
    return this.msgList().filter(m => m.from !== me.id && (m.to === 'all' || m.to === me.id) && !(Array.isArray(m.readBy) ? m.readBy : []).includes(me.id)).length;
  }
  async pickEntLogo() {
    const file = await new Promise(res => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.onchange = () => res(inp.files && inp.files[0]); inp.click(); });
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
      const S = 64; const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
      const g = cv.getContext('2d');
      const r = Math.max(S / img.width, S / img.height); // recadrage couvrant, centré
      const w = img.width * r, h = img.height * r;
      g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      URL.revokeObjectURL(url);
      this.setEnt({ logo: cv.toDataURL('image/png') });
    } catch (e) { this.setState({ msg: { kind: 'error', text: "Image illisible — essayez un fichier PNG ou JPG." } }); }
  }
  // Total (poids + valorisation) d'un classeur Stock = somme du détail par espèce corrigé.
  // Sert à l'onglet Stock (inventaires par semaine) — évite la feuille RECAP VENTES cassée.
  stockTotalFromEspeces(esp) {
    let poids = 0, valo = 0;
    Object.values((esp && esp.bySpecies) || {}).forEach(d => { if (d && !d.missing) { poids += (+d.poidsAchete || 0); valo += (+d.valeurAchat || 0); } });
    return { poids: Math.round(poids * 10) / 10, valo: Math.round(valo * 100) / 100 };
  }
  mapStockEspeces(wb) {
    const EXPECTED = this.entCfg().especes;
    const byNorm = {}; wb.forEach(s => { byNorm[this._norm(s.name)] = s; });
    const bySpecies = {}; const missing = [];
    EXPECTED.forEach(name => {
      const sheet = byNorm[this._norm(name)];
      if (!sheet) { missing.push({ species: name, reason: 'feuille absente du fichier' }); return; }
      const res = this.extractSpeciesBenefits(sheet.rows, name);
      if (res.missing) missing.push({ species: name, reason: res.reason });
      bySpecies[name] = res;
    });
    return { bySpecies, missing };
  }
  applyImport(kind, text, name, silent) {
    let res, key, patch;
    if (kind === 'factures') { res = this.mapFactures(text); key = Component.FAC_KEY; }
    else if (kind === 'bordereaux') { res = this.mapBordereaux(text); key = Component.BL_KEY; }
    else if (kind === 'stock') { res = this.mapStock(text, name); key = Component.STK_KEY; }
    else if (kind === 'credits') { res = this.mapCredits(text); key = Component.CRED_KEY; }
    else if (kind === 'comptable') { res = this.mapComptable(text); key = Component.CMP_KEY; }
    else if (kind === 'banque') { res = this.mapBanque(text); key = Component.BNK_KEY; }
    else if (kind === 'ventes') { res = this.mapFactures(text); key = Component.VEN_KEY; }
    else { res = this.mapOperations(text); key = Component.OPS_KEY; }
    if (!res.list.length) { this.setState({ msg: { kind: 'error', text: `Import de « ${name} » impossible : ${res.error || 'aucune ligne valide'}.` } }); return; }
    let done = `${res.list.length} ligne${res.list.length > 1 ? 's' : ''} importée${res.list.length > 1 ? 's' : ''}${res.skipped ? ` (${res.skipped} ignorée${res.skipped > 1 ? 's' : ''})` : ''}`;
    if (kind === 'ventes' || kind === 'factures') { const nP = res.list.filter(r => r.statusPaid || (r.paid || 0) >= (r.ttc || 0) - 0.005).length; done += ` — ${nP} payée${nP > 1 ? 's' : ''}, ${res.list.length - nP} à suivre`; if (!nP && res.list.length > 3) { done += ' ⚠ aucune facture payée détectée : vérifiez le mappage des colonnes Réglé/Solde/État'; const mi = this._mapInfo; if (mi && mi.kind === kind) done += ` [feuille « ${mi.sheet} » — ${mi.desc}]`; } }
    if (kind === 'factures') patch = { factures: res.list, facturesName: name };
    else if (kind === 'bordereaux') patch = { bordereaux: res.list, bordereauxName: name };
    else if (kind === 'stock') { const prev = (this.state.stock || []).filter(s => s.file !== name); const merged = [...res.list, ...prev]; patch = { stock: merged, stockName: name }; this.saveJSON(key, { name, rows: merged }); }
    else if (kind === 'credits') patch = { credits: res.list, creditsName: name };
    else if (kind === 'comptable') patch = { comptable: res.list, comptableName: name };
    else if (kind === 'banque') patch = { banque: res.list, banqueName: name, view: 'Banque' };
    else if (kind === 'ventes') patch = { ventes: res.list, ventesName: name, cat: 'Toutes', anchor: null };
    else patch = { ops: res.list, opsName: name, cat: 'Toutes', anchor: null };
    if (kind !== 'stock') this.saveJSON(key, { name, rows: res.list, v: 6 });
    const hhmm = () => { const d = new Date(); return this.dd(d.getHours()) + ':' + this.dd(d.getMinutes()); };
    const checks = ['ventes', 'factures', 'operations'].includes(kind) ? this._checkCoherence(kind, res.list) : null;
    if (checks) { const bits = []; if (checks.dupCount) bits.push(`${checks.dupCount} doublon${checks.dupCount > 1 ? 's' : ''} de n°`); if (checks.badDateCount) bits.push(`${checks.badDateCount} date${checks.badDateCount > 1 ? 's' : ''} suspecte${checks.badDateCount > 1 ? 's' : ''}`); if (checks.badAmtCount) bits.push(`${checks.badAmtCount} montant${checks.badAmtCount > 1 ? 's' : ''} vide${checks.badAmtCount > 1 ? 's' : ''}`); done += ` ⚠ contrôle : ${bits.join(', ')}`; }
    const msgText = silent ? `↺ ${name} mis à jour automatiquement — ${hhmm()} (${done}).` : `${name} — ${done}.`;
    this.setState({ ...patch, msg: { kind: 'success', text: msgText }, importChecks: checks });
    return res;
  }
  // ---------- contrôle de cohérence à l'import (doublons, dates suspectes, montants vides) ----------
  _checkCoherence(kind, list) {
    const label = { ventes: 'Ventes', factures: 'Factures fournisseur', operations: 'Achat pêche' }[kind];
    if (!label) return null;
    const todayDays = this.days(Component.TODAY);
    const minDays = todayDays - 5 * 365, maxDays = todayDays + 400;
    const dupMap = {}; const badDates = []; const badAmts = [];
    list.forEach(r => {
      const ref = String(r.ref || '').trim();
      if (ref) { (dupMap[ref] = dupMap[ref] || []).push(r); }
      let o = null;
      if (kind === 'operations') o = (r.y && r.m) ? { y: r.y, m: r.m, d: r.d } : null;
      else o = r.d ? this.pIso(r.d) : null;
      if (o && o.y) { const dd = this.days(o); if (dd < minDays || dd > maxDays) badDates.push({ ref: ref || '—', date: `${this.dd(o.d)}/${this.dd(o.m)}/${o.y}` }); }
      const amt = kind === 'operations' ? r.amt : r.ttc;
      if (amt == null || Math.abs(amt) < 0.005) badAmts.push({ ref: ref || '—', partner: r.partner || '' });
    });
    const dup = Object.keys(dupMap).filter(ref => dupMap[ref].length > 1).map(ref => ({ ref, count: dupMap[ref].length }));
    if (!dup.length && !badDates.length && !badAmts.length) return null;
    return { kind, label, dup: dup.slice(0, 25), badDates: badDates.slice(0, 25), badAmts: badAmts.slice(0, 25), dupCount: dup.length, badDateCount: badDates.length, badAmtCount: badAmts.length };
  }
  unwatch(kind) {
    const w = this._watched || {}; let changed = false;
    for (const name of Object.keys(w)) { if (w[name].kind === kind) { this.idbDel('file:' + kind + ':' + name); delete w[name]; changed = true; } }
    if (changed) this.setState({ watchCount: Object.keys(w).length });
  }
  saveBlLib(lib) { if (lib && lib.length) this.saveJSON(Component.BLLIB_KEY, { rows: lib.map(f => ({ name: f.name, type: f.type, transporteur: f.transporteur })) }); else { try { localStorage.removeItem(Component.BLLIB_KEY); } catch (e) {} } }
  resetSource(kind) {
    const keyMap = { factures: Component.FAC_KEY, bordereaux: Component.BL_KEY, stock: Component.STK_KEY, credits: Component.CRED_KEY, comptable: Component.CMP_KEY, ventes: Component.VEN_KEY, operations: Component.OPS_KEY, banque: Component.BNK_KEY };
    const key = keyMap[kind]; if (key) { try { localStorage.removeItem(key); } catch (e) {} }
    this.unwatch(kind);
    if (kind === 'factures') this.setState({ factures: null, facturesName: null, msg: null });
    else if (kind === 'bordereaux') { this._blDir = null; this._blMax = 0; this.idbDel('dir:bl'); this.setState({ bordereaux: null, bordereauxName: null, folderBl: null, msg: null }); }
    else if (kind === 'livraison') { this._blDir = null; this._blMax = 0; this._blLivraison = []; this.idbDel('dir:bl'); const lib = [...(this._blTransport || [])]; this.saveBlLib(lib); this.setState({ folderBl: null, blLibrary: lib.length ? lib : null, msg: null }); }
    else if (kind === 'transport') { this._transpDir = null; this._transpMax = 0; this._blTransport = []; this.idbDel('dir:transp'); const lib = [...(this._blLivraison || [])]; this.saveBlLib(lib); this.setState({ folderTransp: null, blLibrary: lib.length ? lib : null, msg: null }); }
    else if (kind === 'stock') { this._stockDir = null; this._stockMax = 0; this._stockHandles = {}; this.idbDel('dir:stock'); try { localStorage.removeItem(Component.STKESP_KEY); } catch (e) {} this.setState({ stock: null, stockName: null, folderStock: null, stockEspeces: null, msg: null }); }
    else if (kind === 'credits') this.setState({ credits: null, creditsName: null, msg: null });
    else if (kind === 'comptable') this.setState({ comptable: null, comptableName: null, msg: null });
    else if (kind === 'banque') { try { localStorage.removeItem(Component.BLINK_KEY); localStorage.removeItem(Component.HIDE_BNK_KEY); localStorage.removeItem(Component.BCAT_KEY); localStorage.removeItem(Component.BRULE_KEY); localStorage.removeItem(Component.BCATLIST_KEY); } catch (e) {} this.setState({ banque: null, banqueName: null, bankLinks: {}, bankHidden: {}, bankCats: {}, bankCatRules: {}, bankCatList: null, msg: null }); }
    else if (kind === 'ventes') { try { localStorage.removeItem(Component.GRENKE_KEY); } catch (e) {} this.setState({ ventes: null, ventesName: null, grenke: null, grenkeName: null, msg: null }); }
    else if (kind === 'operations') this.setState({ ops: null, opsName: null, anchor: null, msg: null });
    else this.setState({ msg: null });
  }
  async connectFolder() {
    if (!('showDirectoryPicker' in window)) { this.setState({ msg: { kind: 'error', text: "Votre navigateur ne permet pas la connexion de dossier. Ouvrez le tableau de bord dans Chrome ou Edge sur ordinateur, ou importez chaque fichier depuis Paramètres." } }); return; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      this._libDir = dir;
      this.idbSet('dir:lib', { type: 'dir', role: 'lib', name: dir.name, handle: dir });
      await this.refreshLibFolder(dir, false);
      this.setState({ view: 'Bibliothèque' });
    } catch (e) { if (e && e.name === 'AbortError') return; this.setState({ msg: { kind: 'error', text: "Connexion du dossier refusée ou indisponible ici. Ouvrez le tableau de bord dans Chrome/Edge sur ordinateur." } }); }
  }
  async refreshLibFolder(dir, silent) {
    const files = [];
    const walk = async (handle, prefix, depth) => { if (depth > 7) return; for await (const [name, h] of handle.entries()) { if (name.startsWith('.') || name.startsWith('~$')) continue; if (h.kind === 'directory') { await walk(h, prefix ? prefix + ' / ' + name : name, depth + 1); } else if (/\.(csv|txt|xlsx|xlsm|xls|pdf|docx?|ods)$/i.test(name)) { files.push({ name, path: prefix, handle: h }); } } };
    await walk(dir, '', 0);
    files.sort((a, b) => (a.path || '').localeCompare(b.path || '') || a.name.localeCompare(b.name));
    const patch = { folder: { name: dir.name, files } };
    if (!silent) patch.msg = { kind: 'success', text: `Dossier « ${dir.name} » indexé — ${files.length} document(s) trouvé(s).` };
    this.setState(patch);
  }
  async openFolderDoc(f) { const ok = await this.openHandleFile(f.handle, f.name); if (!ok) this.setState({ msg: { kind: 'error', text: `Ouverture de « ${f.name} » impossible ici.` } }); }
  guessKind(name) { const n = (name || '').toLowerCase(); return /pecheur|pêcheur|facturation/.test(n) ? 'operations' : /vente/.test(n) ? 'operations' : /payer/.test(n) ? 'factures' : /stock|inventair|week/.test(n) ? 'stock' : /border|livrais|bl[-_ ]/.test(n) ? 'bordereaux' : /credit|assurance|mensualit/.test(n) ? 'credits' : /factur/.test(n) ? 'factures' : 'operations'; }

  // ---------- surveillance temps réel (hors ligne) ----------
  // Chaque fichier chargé est surveillé : dès qu'Excel enregistre, sa date de modif change, on relit.
  _idb() {
    if (this.__idbP) return this.__idbP;
    this.__idbP = new Promise((res, rej) => { try { const r = indexedDB.open('avHandles', 1); r.onupgradeneeded = () => { try { r.result.createObjectStore('h'); } catch (e) {} }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } });
    return this.__idbP;
  }
  async idbSet(key, val) { try { const db = await this._idb(); await new Promise((res, rej) => { const tx = db.transaction('h', 'readwrite'); tx.objectStore('h').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) {} }
  async idbGetAll() { try { const db = await this._idb(); return await new Promise((res) => { const out = []; const tx = db.transaction('h', 'readonly'); const rq = tx.objectStore('h').openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { out.push({ key: c.key, val: c.value }); c.continue(); } else res(out); }; rq.onerror = () => res(out); }); } catch (e) { return []; } }
  async idbDel(key) { try { const db = await this._idb(); await new Promise((res) => { const tx = db.transaction('h', 'readwrite'); tx.objectStore('h').delete(key); tx.oncomplete = res; tx.onerror = res; }); } catch (e) {} }
  _applyRestored(val) {
    if (!val || !val.handle) return;
    if (val.role === 'stockmodel') { this._stockModelFile = val.handle; this.setState({ stockModelName: val.name || 'modèle' }); return; }
    if (val.type === 'file') { this._watched = this._watched || {}; this._watched[val.name] = { kind: val.kind, name: val.name, handle: val.handle, lastMod: 0 }; this.setState({ watchCount: Object.keys(this._watched).length }); }
    else if (val.type === 'dir') {
      if (val.role === 'stock') this._stockDir = val.handle; else if (val.role === 'transp') this._transpDir = val.handle; else if (val.role === 'bl') this._blDir = val.handle; else if (val.role === 'lib') this._libDir = val.handle;
      else if (val.role === 'backup') { this._backupDir = val.handle; this.setState({ backupFolderName: val.handle.name }); }
      else if (val.role === 'suivi') { this._suiviDir = val.handle; this.setState({ suiviFolderName: val.handle.name }); }
    }
  }
  async restoreHandles() {
    if (!('indexedDB' in window)) return;
    const all = await this.idbGetAll(); this._restored = all;
    if (!all.length) return;
    let granted = 0, need = 0;
    for (const { val } of all) {
      if (!val || !val.handle) continue;
      const mode = (val.role === 'backup' || val.role === 'suivi') ? 'readwrite' : 'read';
      let perm = 'prompt';
      try {
        perm = val.handle.queryPermission ? await val.handle.queryPermission({ mode }) : 'granted';
        // Permission expirée (courant après redémarrage du navigateur) : on retente silencieusement
        // requestPermission() avant d'imposer une reconnexion manuelle — la resélection reste le
        // dernier recours, réservée aux handles invalides/introuvables (catch ci-dessous).
        if (perm !== 'granted' && val.handle.requestPermission) perm = await val.handle.requestPermission({ mode });
      } catch (e) { perm = 'prompt'; }
      if (perm === 'granted') { this._applyRestored(val); granted++; } else need++;
    }
    if (granted) { this.startWatching(); this.pollWatched(); this.refreshFolders(); this.setState({ lastSync: Date.now() }); }
    if (need) this.setState({ reconnectCount: need });
  }
  async reconnectHandles() {
    const all = this._restored || await this.idbGetAll(); let ok = 0;
    for (const { val } of all) {
      if (!val || !val.handle) continue;
      const mode = (val.role === 'backup' || val.role === 'suivi') ? 'readwrite' : 'read';
      try { let p = val.handle.queryPermission ? await val.handle.queryPermission({ mode }) : 'granted'; if (p !== 'granted' && val.handle.requestPermission) p = await val.handle.requestPermission({ mode }); if (p === 'granted') { this._applyRestored(val); ok++; } } catch (e) {}
    }
    this.setState({ reconnectCount: 0 });
    if (ok) { this.startWatching(); await this.refreshAll(); }
  }
  async refreshFolders() {
    try { if (this._stockDir) await this.refreshStockFolder(this._stockDir, true); } catch (e) {}
    try { if (this._blDir) await this.refreshLivraisonFolder(this._blDir, true); } catch (e) {}
    try { if (this._transpDir) await this.refreshTransportFolder(this._transpDir, true); } catch (e) {}
    try { if (this._libDir && !this.state.folder) await this.refreshLibFolder(this._libDir, true); } catch (e) {}
  }
  watch(kind, name, handle, lastMod) {
    if (!handle || !handle.getFile) return;
    this._watched = this._watched || {};
    this._watched[name] = { kind, name, handle, lastMod: lastMod || 0 };
    this.idbSet('file:' + kind + ':' + name, { type: 'file', kind, name, handle });
    if (this.state.autoRefresh) this.startWatching();
    this.setState({ watchCount: Object.keys(this._watched).length });
  }
  startWatching(force) {
    if (this._watchTimer) return;
    if (!force && !this.state.autoRefresh) return;
    if (document.hidden) return;
    this._watchTimer = setInterval(() => this.pollWatched(), 20000);
  }
  stopWatching() { if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; } }
  toggleAutoRefresh() {
    const on = !this.state.autoRefresh;
    this.setState({ autoRefresh: on });
    try { localStorage.setItem(Component.AUTO_KEY, on ? '1' : '0'); } catch (e) {}
    if (on) { this.startWatching(true); this.pollWatched(); } else this.stopWatching();
  }
  setDemoMode(on) { try { localStorage.setItem(Component.DEMO_KEY, on ? '1' : '0'); } catch (e) {} this.setState({ demoMode: !!on, msg: null }); }
  askHtTtc() { this.setState({ htTtcAsk: true, htTtcCheck: false }); }
  cancelHtTtc() { this.setState({ htTtcAsk: false, htTtcCheck: false }); }
  confirmHtTtc() { if (!this.state.htTtcCheck) return; this.setState({ amountMode: this.state.amountMode === 'HT' ? 'TTC' : 'HT', htTtcAsk: false, htTtcCheck: false }); }
  setGrenkeSort(key) { const s = this.state.grenkeSort || { key: 'date', dir: 'desc' }; this.setState({ grenkeSort: s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: (key === 'date' || key === 'num' || key === 'ttc' || key === 'rem') ? 'desc' : 'asc' } }); }
  dismissBanner(text) { this.setState({ bannerDismiss: text }); }
  // ---------- crédits & assurances : saisie 100% manuelle ----------
  _credits() { return this.state.credits ? this.state.credits.map(c => ({ ...c })) : (this.state.demoMode !== false ? Component.CREDITS.map(c => ({ ...c })) : []); }
  saveCredits(arr) { this.setState({ credits: arr }); this.saveJSON(Component.CRED_KEY, { name: 'Saisie manuelle', rows: arr }); }
  addMonthIso(iso) { const o = this.pIso(iso); if (!o || !o.y) return iso; let y = o.y, m = o.m + 1; if (m > 12) { m = 1; y++; } const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); const d = Math.min(o.d || 1, dim); return `${y}-${this.dd(m)}-${this.dd(d)}`; }
  payCredit(i) { const arr = this._credits(); const c = arr[i]; if (!c) return; const paid = Math.min(c.total || 0, Math.round(((c.paid || 0) + (c.mens || 0)) * 100) / 100); arr[i] = { ...c, paid, next: this.addMonthIso(c.next) }; this.saveCredits(arr); }
  openCredNew() { this.setState({ credEdit: { i: -1, label: '', ent: '', type: 'Crédit', total: '', paid: '', mens: '', next: '' } }); }
  openCredEdit(i) { const c = this._credits()[i]; if (!c) return; this.setState({ credEdit: { i, label: c.label || '', ent: c.ent || '', type: c.type || 'Crédit', total: c.total != null ? String(c.total) : '', paid: c.paid != null ? String(c.paid) : '', mens: c.mens != null ? String(c.mens) : '', next: c.next || '' } }); }
  closeCred() { this.setState({ credEdit: null }); }
  setCredField(k, v) { this.setState({ credEdit: { ...(this.state.credEdit || {}), [k]: v } }); }
  commitCred() { const e = this.state.credEdit; if (!e) return; const label = (e.label || '').trim(); if (!label) return; const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.').replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; }; const rec = { label, ent: (e.ent || '').trim(), type: e.type === 'Assurance' ? 'Assurance' : 'Crédit', total: num(e.total), paid: num(e.paid), mens: num(e.mens), next: e.next || '' }; const arr = this._credits(); if (e.i >= 0) arr[e.i] = { ...arr[e.i], ...rec }; else arr.push(rec); this.saveCredits(arr); this.setState({ credEdit: null }); }
  deleteCred(i) { const arr = this._credits(); if (i < 0 || i >= arr.length) { this.setState({ credEdit: null }); return; } arr.splice(i, 1); this.saveCredits(arr); this.setState({ credEdit: null }); }
  async refreshAll() {
    this.setState({ msg: { kind: 'info', text: 'Rafra\u00eechissement en cours\u2026' } });
    try { if (this._stockDir) await this.refreshStockFolder(this._stockDir, true); } catch (e) {}
    try { if (this._blDir) await this.refreshLivraisonFolder(this._blDir, true); } catch (e) {}
    try { if (this._transpDir) await this.refreshTransportFolder(this._transpDir, true); } catch (e) {}
    try { if (this._libDir) await this.refreshLibFolder(this._libDir, true); } catch (e) {}
    try { await this.pollWatched(); } catch (e) {}
    this.setState({ lastSync: Date.now(), msg: { kind: 'success', text: 'Donn\u00e9es rafra\u00eechies \u00e0 ' + new Date().toLocaleTimeString('fr-FR') + '.' } });
  }
  async pollWatched() {
    const w = this._watched; if (!w || this._polling) return; this._polling = true;
    try {
      for (const name of Object.keys(w)) {
        const it = w[name];
        try {
          if (it.handle.queryPermission) { const p = await it.handle.queryPermission({ mode: 'read' }); if (p === 'prompt' && it.handle.requestPermission) await it.handle.requestPermission({ mode: 'read' }); }
          const file = await it.handle.getFile();
          if (file.lastModified > it.lastMod) {
            it.lastMod = file.lastModified;
            await this.reimportSilent(it);
            this.setState({ lastSync: Date.now() });
          }
        } catch (e) { /* fichier momentanément verrouillé par Excel : on retentera au prochain tour */ }
      }
      // dossier Stock : relit tout si un fichier a changé ou si un nouveau est apparu
      if (this._stockDir) {
        try {
          const pfx = this.prefixOf('stock');
          let mx = 0, n = 0; for (const [nm, h] of await this.listFilesDeep(this._stockDir, 3)) { if (/\.(xlsx|xlsm)$/i.test(nm) && this.matchPrefix(nm, pfx)) { n++; const fl = await h.getFile(); mx = Math.max(mx, fl.lastModified); } }
          if (mx > (this._stockMax || 0) || n !== ((this.state.folderStock && this.state.folderStock.count) || 0)) { await this.refreshStockFolder(this._stockDir, true); this.setState({ lastSync: Date.now() }); }
        } catch (e) { /* dossier momentanément indisponible */ }
      }
      // dossier Bordereaux livraison
      if (this._blDir) {
        try {
          const pfx = this.prefixOf('livraison');
          let mx = 0, n = 0; for (const [nm, h] of await this.listFilesDeep(this._blDir, 3)) { if (/\.(xlsx|xlsm|pdf|csv|jpg|jpeg|png)$/i.test(nm) && this.matchPrefix(nm, pfx)) { n++; const fl = await h.getFile(); mx = Math.max(mx, fl.lastModified); } }
          if (mx > (this._blMax || 0) || n !== ((this.state.folderBl && this.state.folderBl.count) || 0)) { await this.refreshLivraisonFolder(this._blDir, true); this.setState({ lastSync: Date.now() }); }
        } catch (e) { /* dossier momentanément indisponible */ }
      }
      // dossier Bordereaux transport
      if (this._transpDir) {
        try {
          let mx = 0, n = 0; for (const [nm, h] of await this.listFilesDeep(this._transpDir, 3)) { if (/\.(xlsx|xlsm|pdf|csv|jpg|jpeg|png)$/i.test(nm)) { n++; const fl = await h.getFile(); mx = Math.max(mx, fl.lastModified); } }
          if (mx > (this._transpMax || 0)) { await this.refreshTransportFolder(this._transpDir, true); this.setState({ lastSync: Date.now() }); }
        } catch (e) { /* dossier momentanément indisponible */ }
      }
    } finally { this._polling = false; }
  }

  // Mémoïsation transparente : recalcule seulement si l'une des dépendances (comparées par référence)
  // a changé depuis le dernier appel. Comme setState conserve la référence des tranches d'état non
  // modifiées, taper dans une recherche ou changer de période ne réinvalide pas ces calculs lourds.
  _memo(key, deps, fn) {
    this.__memo = this.__memo || {};
    const prev = this.__memo[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) return prev.val;
    const val = fn(); this.__memo[key] = { deps, val }; return val;
  }
  computeFactures() {
    const vt = this.state.ventes || []; const fo = this.state.factures || [];
    const raw = (vt.length || fo.length) ? [...vt, ...fo] : (this.state.demoMode !== false ? Component.FACTURES : []); const T = this.days(Component.TODAY);
    return raw.map(f => { const em = this.pIso(f.d), due = this.pIso(f.due);
      // « Payée » dans le fichier source = clos, quel que soit le montant réglé mémorisé
      const paidEff = f.statusPaid ? f.ttc : f.paid;
      const reste = Math.max(0, Math.round((f.ttc - paidEff) * 100) / 100);
      // Une incohérence de paiement reste visible « À vérifier », sans être relancée comme impayée certaine.
      const over = !f.paymentCheck && reste > 0 && this.days(due) < T;
      // Quand Excel fournit un statut reconnu, son texte pilote l'affichage et
      // les filtres. L'échéance et les montants restent des contrôles distincts.
      let status; if (f.paymentCheck) status = 'À vérifier'; else if (f.paymentStatus) status = f.paymentStatus; else if (reste <= 0) status = 'Payée'; else if (over) status = (f.sens === 'Fournisseur' ? 'En retard' : 'À relancer'); else if (paidEff > 0) status = 'Partiellement payée'; else status = 'Non payée';
      return { ...f, em, dueO: due, paid: paidEff, reste, over, daysOver: T - this.days(due), status, ym: em.y * 12 + em.m - 1 }; });
  }
  reconcile(internal, external, key) {
    key = key || 'ref';
    const ext = external.map((e, i) => ({ ...e, _i: i, _used: false }));
    const byRef = {}; ext.forEach(e => { if (e.ref) byRef[this.nrm(e.ref)] = e; });
    const P = s => String(s || '').toUpperCase().replace(/\s+/g, '');
    const findMatch = inv => {
      if (key === 'ref') { const m = byRef[this.nrm(inv.ref)]; return (m && !m._used) ? m : null; }
      if (key === 'montant') return ext.find(e => !e._used && Math.abs(e.amount - inv.ttc) < 1) || null;
      if (key === 'pm') return ext.find(e => !e._used && P(e.partner) === P(inv.partner) && Math.abs(e.amount - inv.ttc) < 1) || null;
      const byr = byRef[this.nrm(inv.ref)]; if (byr && !byr._used) return byr;
      return ext.find(e => !e._used && P(e.partner) === P(inv.partner) && Math.abs(e.amount - inv.ttc) < 1 && e.ym === inv.ym) || null;
    };
    const rows = []; let ok = 0, ec = 0, miss = 0, extra = 0;
    internal.forEach(inv => { const m = findMatch(inv);
      if (m) { m._used = true; const d = Math.round(m.amount - inv.ttc); if (Math.abs(d) < 1) { ok++; rows.push({ ref: inv.ref, partner: inv.partner, int: inv.ttc, ext: m.amount, ecart: 0, status: 'Rapproché' }); } else { ec++; rows.push({ ref: inv.ref, partner: inv.partner, int: inv.ttc, ext: m.amount, ecart: d, status: 'Écart montant' }); } }
      else { miss++; rows.push({ ref: inv.ref, partner: inv.partner, int: inv.ttc, ext: null, ecart: null, status: 'Absent de l’export' }); } });
    ext.filter(e => !e._used).forEach(e => { extra++; rows.push({ ref: e.ref, partner: e.partner, int: null, ext: e.amount, ecart: null, status: 'Absent du registre' }); });
    const rankS = { 'Écart montant': 0, 'Absent de l’export': 1, 'Absent du registre': 2, 'Rapproché': 3 };
    rows.sort((a, b) => rankS[a.status] - rankS[b.status]);
    return { rows, ok, ec, miss, extra };
  }

  renderVals() {
    const C = Component;
    const demo = this.state.demoMode !== false;
    const amountMode = this.state.amountMode === 'HT' ? 'HT' : 'TTC';
    const accent = this.entCfg().accent;
    const soft = this.hexToRgba(accent, 0.12);
    // Profil actif : pilote ce qui est visible (navigation, boutons d'administration, recherche)
    const profActif = this.activeProfil();
    const isAdminUI = profActif.role === 'admin';
    const profilVoit = v => isAdminUI || this.profilAllowed(v);
    const compact = (this.props.density ?? 'Confortable') === 'Compact';
    const rowPad = compact ? '8px 4px' : '12px 4px';
    const stockPad = compact ? '10px 4px' : '14px 4px';
    const green = '#15803d', red = '#b91c1c', amber = '#b45309', gray = '#9aa7b8', slate = '#475569';
    const badge = 'display:inline-flex;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;';
    const av = `width:30px;height:30px;border-radius:8px;background:${soft};color:${accent};display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:600;flex-shrink:0`;
    const card = (label, value, valueColor, note, bar) => ({ label, value, valueColor: valueColor || '#0e1b2e', note: note || '', bar: bar || accent });
    const inputStyle = 'flex:1;min-width:0;padding:7px 10px;border:1px solid #dde3ec;border-radius:8px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff';

    // ---- recherche + pagination (une seule table visible à la fois) ----
    const q = this.state.q || '';
    const qN = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const matchTxt = (...vals) => !qN || vals.some(v => String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(qN));
    const pageSize = this.state.pageSize || 50;
    const curPage = Math.max(0, this.state.page || 0);
    const onSearch = e => this.setState({ q: e.target.value, page: 0 });
    const searchStyle = 'width:250px;max-width:46vw;padding:7px 11px;border:1px solid #dde3ec;border-radius:9px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff';
    const pagerBtn = on => `min-width:34px;padding:6px 11px;border-radius:8px;font-size:12px;font-weight:700;font-family:inherit;border:1px solid ${on ? this.hexToRgba(accent, 0.35) : '#e9edf4'};background:#fff;color:${on ? accent : '#c7cfdb'};cursor:${on ? 'pointer' : 'default'}`;
    const paginate = (arr) => {
      const total = arr.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const cur = Math.min(curPage, pages - 1);
      const from = total ? cur * pageSize : 0;
      const to = Math.min(total, from + pageSize);
      const hasPrev = cur > 0, hasNext = cur < pages - 1;
      return { slice: arr.slice(from, to), total, show: total > pageSize,
        info: `${total ? from + 1 : 0}\u2013${to} sur ${total}`,
        prevStyle: pagerBtn(hasPrev), nextStyle: pagerBtn(hasNext),
        onPrev: hasPrev ? () => this.setState({ page: cur - 1 }) : () => {},
        onNext: hasNext ? () => this.setState({ page: cur + 1 }) : () => {} };
    };
    const view = this.state.view;
    const isDash = ['Tableau de bord', 'Ventes', 'Achats'].includes(view);
    const isOverview = view === 'Tableau de bord';
    const isFactures = view === 'Factures';
    const isBordereaux = view === 'Bordereaux';
    const isStock = view === 'Stock';
    const isVehicles = view === 'Véhicules';
    const isTiers = view === 'Tiers';
    const isCredits = view === 'Crédits';
    const isSettings = view === 'Paramètres';
    const isBibliotheque = view === 'Bibliothèque';
    const isBanque = view === 'Banque';
    const isHeures = view === 'Heures';
    const isEmployes = view === 'Employés';
    const isAgenda = view === 'Agenda';
    const isComptaAnalytique = view === 'Comptabilité analytique';
    // Hub Stock : Stock actuel · Marges par espèce (= Comptabilité analytique) · Historique
    const stockTab = ['actuel', 'historique'].includes(this.state.stockTab) ? this.state.stockTab : 'actuel';
    const isStockHub = isStock || isComptaAnalytique;
    const stockIsActuel = isStock && stockTab === 'actuel';
    const stockIsHistorique = isStock && stockTab === 'historique';
    const stkHubTab = (label, on, patch) => ({ name: label, onClick: () => this.setState(patch), style: on ? `flex:0 0 auto;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : `flex:0 0 auto;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit` });
    const stockHubTabs = [
      stkHubTab('Stock actuel', stockIsActuel, { view: 'Stock', stockTab: 'actuel' }),
      stkHubTab('Marges par espèce', isComptaAnalytique, { view: 'Comptabilité analytique' }),
      stkHubTab('Historique', stockIsHistorique, { view: 'Stock', stockTab: 'historique' }),
    ];
    const isSaisieCompta = view === 'SaisieCompta';
    const compTab = ['Vente', 'Fournisseur', 'Paiement'].includes(this.state.compTab) ? this.state.compTab : 'Achat';
    const compIsAchat = compTab === 'Achat';
    const compIsVente = compTab === 'Vente';
    const compIsFourn = compTab === 'Fournisseur';
    const fournDraft = this.state.fournDraft || this.fournDefault();
    const fournTypeTabs = [
      { key: 'normal', name: 'Fournisseur' }, { key: 'crustace', name: 'Fournisseur crustacé' },
    ].map(t => ({ name: t.name, onClick: () => this.setFournField('type', t.key), style: (fournDraft.type === t.key ? `flex:1 1 0;padding:9px 12px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : 'flex:1 1 0;padding:9px 12px;border-radius:9px;font-size:12.5px;font-weight:600;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit') }));
    const fournEditing = !!fournDraft.editing;
    const onFournFourn = e => this.setFournField('fournisseur', e.target.value);
    const onFournNum = e => this.setFournField('num', e.target.value);
    const onFournDate = e => this.setFournField('date', e.target.value);
    const onFournMontant = e => this.setFournField('montant', e.target.value);
    const onFournCommit = () => this.commitFournSaisie();
    const onFournReset = () => this.resetFournDraft();
    const fournSaveLabel = fournEditing ? 'Enregistrer les modifications' : '＋ Enregistrer la facture';

    // ============ AGENDA (événements manuels + rappel visuel) ============
    const AG_MON = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const AG_DOW = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const agToday = this.agTodayIso();
    const agCatColor = c => this.agCatColor(c);
    const agAnchor = this.agMonthAnchor(); const agAP = agAnchor.split('-').map(Number); const agY = agAP[0], agM = agAP[1];
    const agMonthLabel = `${AG_MON[agM - 1]} ${agY}`;
    // Liste « à venir » (aujourd'hui → +60 j) — sert au rappel et à l'aperçu d'accueil.
    const agSoonTo = new Date(this.agParse(agToday).getTime() + 60 * 864e5);
    const agRel = iso => { const diff = Math.round((this.agParse(iso).getTime() - this.agParse(agToday).getTime()) / 864e5); return diff <= 0 ? "Aujourd'hui" : diff === 1 ? 'Demain' : diff < 7 ? `Dans ${diff} jours` : `${this.dd(this.agParse(iso).getDate())} ${AG_MON[this.agParse(iso).getMonth()]}`; };
    const agFmtOcc = (o, big) => { const d = this.agParse(o.iso); const isTdy = o.iso === agToday; const col = agCatColor(o.ev.cat); return { title: o.ev.title, time: o.ev.time || '', note: o.ev.note || '', cat: o.ev.cat, color: col, dateLabel: `${AG_DOW[(d.getDay() + 6) % 7]} ${this.dd(d.getDate())}/${this.dd(d.getMonth() + 1)}`, rel: agRel(o.iso), isToday: isTdy, dotStyle: `width:9px;height:9px;border-radius:50%;background:${col};flex-shrink:0`, relStyle: `${badge}background:${isTdy ? '#fdeaea' : this.hexToRgba(col, 0.1)};color:${isTdy ? red : col}`, recurLabel: o.ev.recur === 'weekly' ? '↻ chaque semaine' : o.ev.recur === 'monthly' ? '↻ chaque mois' : '', onOpen: () => this.openAgendaEdit(o.ev.id) }; };
    const agOccSoon = this.agendaOccurrences(agToday, this.agIso(agSoonTo));
    const agUpcoming = agOccSoon.map(o => agFmtOcc(o));
    const agTodayCount = agOccSoon.filter(o => o.iso === agToday).length;
    const agSoonHome = agUpcoming.slice(0, 5);
    const agHasAny = this.agendaList().length > 0;
    const agHomeReminderStyle = `${badge}background:#fdeaea;color:${red}`;
    // Grille du mois (6 semaines) — construite uniquement sur l'onglet Agenda.
    let agWeeks = [];
    if (isAgenda) {
      const first = new Date(agY, agM - 1, 1);
      const startOffset = (first.getDay() + 6) % 7;
      const gridStart = new Date(agY, agM - 1, 1 - startOffset);
      const occM = this.agendaOccurrences(this.agIso(gridStart), this.agIso(new Date(gridStart.getTime() + 41 * 864e5)));
      const occByIso = {}; occM.forEach(o => { (occByIso[o.iso] = occByIso[o.iso] || []).push(o); });
      for (let w = 0; w < 6; w++) {
        const days = [];
        for (let dd2 = 0; dd2 < 7; dd2++) {
          const cur = new Date(gridStart.getTime()); cur.setDate(gridStart.getDate() + w * 7 + dd2);
          const iso = this.agIso(cur); const evs = occByIso[iso] || [];
          const inMonth = cur.getMonth() === agM - 1; const isTdy = iso === agToday;
          days.push({
            dayNum: cur.getDate(), iso, isToday: isTdy,
            numStyle: `font-size:12px;font-weight:${isTdy ? 700 : 500};color:${isTdy ? '#fff' : inMonth ? '#0e1b2e' : '#c1cad6'};${isTdy ? `background:${accent};border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center` : ''}`,
            cellStyle: `min-height:82px;border:1px solid #eef1f6;border-radius:9px;padding:5px 6px;background:${isTdy ? this.hexToRgba(accent, 0.05) : inMonth ? '#fff' : '#f9fafc'};cursor:pointer;display:flex;flex-direction:column;gap:3px;overflow:hidden`,
            onAdd: () => this.openAgendaNew(iso),
            events: evs.slice(0, 3).map(o => ({ label: (o.ev.time ? o.ev.time + ' ' : '') + o.ev.title, style: `font-size:10.5px;line-height:1.25;padding:2px 5px;border-radius:4px;background:${this.hexToRgba(agCatColor(o.ev.cat), 0.14)};color:${agCatColor(o.ev.cat)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer`, onOpen: () => this.openAgendaEdit(o.ev.id) })),
            moreLabel: evs.length > 3 ? `+${evs.length - 3}` : '',
          });
        }
        agWeeks.push({ days });
      }
    }
    const agEmptyUpcoming = agUpcoming.length === 0;
    // Modale d'ajout / édition
    const ae = this.state.agendaEdit;
    const agEditOpen = !!ae;
    const agEditIsNew = !!(ae && !ae.id);
    const agEditCanDelete = !!(ae && ae.id);
    const agEditValues = ae || { date: '', time: '', title: '', cat: 'Rendez-vous', recur: 'none', note: '' };
    const agCatOptions = Component.AGENDA_CATS.map(c => ({ value: c.key, label: c.key }));
    const agRecurOptions = [{ value: 'none', label: 'Ponctuel (une seule fois)' }, { value: 'weekly', label: 'Chaque semaine' }, { value: 'monthly', label: 'Chaque mois' }];
    const onAgTitle = e => this.setAgendaField('title', e.target.value);
    const onAgDate = e => this.setAgendaField('date', e.target.value);
    const onAgTime = e => this.setAgendaField('time', e.target.value);
    const onAgCat = e => this.setAgendaField('cat', e.target.value);
    const onAgRecur = e => this.setAgendaField('recur', e.target.value);
    const onAgNote = e => this.setAgendaField('note', e.target.value);
    const onAgSave = () => this.commitAgenda();
    const onAgCancel = () => this.closeAgendaEdit();
    const onAgDeleteFromEdit = () => { if (ae && ae.id) this.askDeleteAgenda(ae.id); };
    const onAgNew = () => this.openAgendaNew();
    const onAgPrevMonth = () => this.agendaShiftMonth(-1);
    const onAgNextMonth = () => this.agendaShiftMonth(1);
    const onAgTodayBtn = () => this.agendaToday();
    const agInputStyle = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #dde3ec;border-radius:9px;font-size:13px;font-family:inherit;color:#0e1b2e;background:#fff';
    const agSelStyle = agInputStyle;
    const agBtnPrimary = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const agBtnGhost = `padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;
    const agAddBtnStyle = agBtnPrimary;
    const agNavBtnStyle = `width:32px;height:32px;border-radius:8px;border:1px solid #e2e8f1;background:#fff;color:${accent};font-size:14px;cursor:pointer;font-family:inherit`;
    const agTodayBtnStyle = agBtnGhost;
    const agLegend = Component.AGENDA_CATS.map(c => ({ label: c.key, dotStyle: `width:9px;height:9px;border-radius:50%;background:${c.color};flex-shrink:0` }));
    // Suppression d'un événement
    const agDel = this.state.agendaDelAsk;
    const agDelOpen = !!agDel;
    const agDelTitle = agDel ? agDel.title : '';
    const onAgDelConfirm = () => this.deleteAgendaEvent();
    const onAgDelCancel = () => this.setState({ agendaDelAsk: null });
    const onGoAgenda = () => this.setState({ view: 'Agenda' });
    const agHomeShow = view === 'Tableau de bord';

    const hiddenOps = this.state.hiddenOps || {};
    // Construction des opérations (ventes + achats) : mémoïsée sur ses sources — évite de reconstruire
    // et retrier toute la liste à chaque frappe de recherche ou changement de période.
    const opsMemo = this._memo('ops', [this.state.ventes, this.state.ops, this.state.hiddenOps, this.state.demoMode, this.state.ventesSaisie, this.state.achatsSaisie, this.state.payTrack], () => {
      const demoOps = C.DATA.map(a => ({ y: a[0], m: a[1], d: a[2], ref: a[3], type: a[4], partner: a[5], cat: a[6], amt: a[7], status: a[8] }));
      const venteOps = (this.state.ventes || []).map(f => { const o = this.pIso(f.d); const paid = f.paid || 0; const isPaid = f.statusPaid || paid >= f.ttc - 0.5; const dueD = f.due ? this.pIso(f.due) : null; const isLate = !isPaid && dueD && this.days(dueD) < this.days(Component.TODAY); return { y: o.y, m: o.m, d: o.d, ref: f.ref, type: 'Vente', partner: f.partner, cat: f.cat || 'Ventes', amt: Math.abs(f.ttc), ht: f.ht != null ? f.ht : Math.abs(f.ttc), paid, reste: Math.max(0, Math.abs(f.ttc) - paid), status: f.paymentCheck ? 'À vérifier' : (f.paymentStatus || (isPaid ? 'Payée' : isLate ? 'Retard' : 'Non payée')), paymentWarning: f.paymentWarning }; });
      const baseAll = (this.state.ops || this.state.ventes) ? [...venteOps, ...(this.state.ops || [])] : (demo ? demoOps : []);
      // --- Saisies manuelles (Saisie comptable) : injectées ici, dédoublonnées par n° de facture (priorité à la saisie manuelle) ---
      const isoYMD = iso => { const p = String(iso || '').split('-'); return { y: +p[0] || Component.TODAY.y, m: +p[1] || Component.TODAY.m, d: +p[2] || Component.TODAY.d }; };
      const ptById = {}; (this.state.payTrack || []).forEach(p => { ptById[String(p.id)] = p; });
      const vSai = (this.state.ventesSaisie || []).map(v => { const o = isoYMD(v.date); const pt = ptById[String(v.id)]; const regle = pt ? (+pt.regle || 0) : 0; const ttc = +v.ttc || 0; const et = pt ? String(pt.etat || '') : ''; const isPaid = /pay|sold/i.test(et) || regle >= ttc - 0.5; const isLate = !isPaid && /retard/i.test(et); return { y: o.y, m: o.m, d: o.d, ref: v.num || ('FV-' + v.id), type: 'Vente', partner: v.client, cat: 'Ventes', amt: ttc, ht: +v.ht || ttc, paid: regle, reste: Math.max(0, ttc - regle), status: isPaid ? 'Payée' : isLate ? 'Retard' : 'Non payée', manual: true }; });
      const aSai = (this.state.achatsSaisie || []).map(a => { const o = isoYMD(a.date); const total = +a.total || 0; const cat = (a.lignes && a.lignes[0] && a.lignes[0].espece) ? a.lignes[0].espece : 'Pêche'; return { y: o.y, m: o.m, d: o.d, ref: a.num || ('AP-' + a.id), type: 'Achat', partner: a.pecheur, cat, amt: -total, paid: total, reste: 0, status: 'Payé', manual: true }; });
      const manualRefs = new Set([...vSai, ...aSai].map(r => this.nrm(r.ref)).filter(Boolean));
      const opsAll = [...vSai, ...aSai, ...baseAll.filter(r => !(r.ref && manualRefs.has(this.nrm(r.ref))))];
      const ops = opsAll.filter(r => !hiddenOps[this.opHideKey(r)]);
      ops.sort((a, b) => (b.y * 10000 + b.m * 100 + b.d) - (a.y * 10000 + a.m * 100 + a.d));
      return { ops, opsAllLen: opsAll.length };
    });
    const ops = opsMemo.ops;
    const opsHiddenCount = opsMemo.opsAllLen - ops.length;
    const demoGrenke = [
      { ref: '02045', cust: '', ttc: 3840, p1: 3200, p2: 588.4, recv: 3788.4, rem: 51.6, charge: 51.6, statut: 'SOLD OUT' },
      { ref: '2041', cust: '', ttc: 4310, p1: 3663.5, p2: 0, recv: 3663.5, rem: 646.5, charge: 92.6, statut: 'EN COURS' },
      { ref: '2044', cust: '', ttc: 3200, p1: 2720, p2: 411.4, recv: 3131.4, rem: 68.6, charge: 68.6, statut: 'SOLD OUT' },
      { ref: '3861', cust: 'Client hors répertoire', ttc: 2587.54, p1: 2049.41, p2: 459.95, recv: 2509.36, rem: 78.18, charge: 78.18, statut: 'EN COURS' },
      { ref: '1069', cust: '', ttc: 5230, p1: 4500, p2: 600, recv: 5100, rem: 130, charge: 130, statut: 'EN COURS' },
    ];
    const grenkeHidden = this.state.grenkeHidden || {};
    const grenkeRowsAll = this.state.grenke || (demo ? demoGrenke : []);
    const grenkeRows = grenkeRowsAll.filter(g => !grenkeHidden[this.gHideKey(g)]);
    const grenkeHiddenCount = grenkeRowsAll.length - grenkeRows.length;
    const trashBtnStyle = 'width:26px;height:26px;border-radius:7px;border:1px solid #ecdcdc;background:#fff;color:#b91c1c;font-size:12px;cursor:pointer;line-height:1;padding:0';
    const cancelBtnStyle = 'width:26px;height:26px;border-radius:7px;border:1px solid #e0b85f;background:#fff;color:#b45309;font-size:12px;cursor:pointer;line-height:1;padding:0';
    const restoreBtnStyle = 'padding:4px 10px;border-radius:7px;border:1px solid #bfe3cc;background:#fff;color:#15803d;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;font-family:inherit;white-space:nowrap';
    const annuleBadgeStyle = 'padding:3px 9px;border-radius:6px;font-size:10.5px;font-weight:700;color:#b45309;background:#fff4e5;border:1px solid #f0dcae;white-space:nowrap';
    const F = this._memo('F', [this.state.ventes, this.state.factures, this.state.demoMode], () => this.computeFactures());
    // ---- Rapprochement Grenke ↔ factures internes (résolution partagée KPI + tableau) ----
    const gNum = s => this.gNumKey(s);
    const factByNum = {}, factByRef = {};
    F.forEach(f => { factByRef[this.nrm(f.ref)] = f; const k = gNum(f.ref); if (k && !(k in factByNum)) factByNum[k] = f; });
    const grenkeLinks = this.state.grenkeLinks || {};
    const resolveLink = g => {
      const has = Object.prototype.hasOwnProperty.call(grenkeLinks, g.ref);
      const ov = grenkeLinks[g.ref];
      const auto = gNum(g.ref) ? factByNum[gNum(g.ref)] : null;
      const ref = has ? (ov || null) : (auto ? auto.ref : null);
      return { ref, fact: ref ? factByRef[this.nrm(ref)] : null, manual: has && !!ov };
    };

    // période
    const ymOf = r => r.y * 12 + (r.m - 1);
    const dataMax = ops.reduce((mx, r) => Math.max(mx, ymOf(r)), 0);
    const dataMin = ops.reduce((mn, r) => Math.min(mn, ymOf(r)), dataMax);
    const anchor = this.state.anchor == null ? dataMax : this.state.anchor;
    const aM = anchor % 12 + 1, aY = Math.floor(anchor / 12);
    const yearRange = y => [y * 12, y * 12 + 11];
    const between = (a, b) => ops.filter(r => ymOf(r) >= a && ymOf(r) <= b);
    const isWeek = this.state.period === 'Cette semaine';
    const RANGES = { 'Ce mois': [anchor, anchor], 'Trimestre': [anchor - 2, anchor], 'Année': yearRange(aY) };
    const R = RANGES[this.state.period] || [anchor, anchor];
    const step = { 'Ce mois': 1, 'Trimestre': 3, 'Année': 12 }[this.state.period] || 1;
    const clamp = a => Math.max(dataMin, Math.min(dataMax, a));
    const arrowBase = 'width:26px;height:26px;border:none;background:transparent;border-radius:7px;font-size:11px;cursor:pointer;font-family:inherit;';
    let inPeriod, inPrev, periodLabel, vsNote, canPrev, canNext, onPrev, onNext, inSelPeriod, periodSort;
    if (isWeek) {
      const T = this.days(C.TODAY);
      const dow = (new Date(Date.UTC(C.TODAY.y, C.TODAY.m - 1, C.TODAY.d)).getUTCDay() + 6) % 7;
      const wo = this.state.weekOff || 0;
      const ws = T - dow + wo * 7, we = ws + 6;
      const dnum = r => this.days({ y: r.y, m: r.m, d: r.d });
      inPeriod = ops.filter(r => dnum(r) >= ws && dnum(r) <= we);
      inPrev = ops.filter(r => dnum(r) >= ws - 7 && dnum(r) <= we - 7);
      inSelPeriod = o => { const dn = this.days({ y: o.y, m: o.m, d: o.d }); return dn >= ws && dn <= we; };
      const sd = this.addDays(C.TODAY, ws - T), ed = this.addDays(C.TODAY, we - T);
      periodLabel = `Semaine ${this.isoWeek(sd)} · ${this.dd(sd.d)}/${this.dd(sd.m)} – ${this.dd(ed.d)}/${this.dd(ed.m)}`;
      periodSort = `${sd.y}-S${this.dd(this.isoWeek(sd))}`;
      vsNote = 'vs sem. préc.';
      const allD = ops.map(dnum); const minD = allD.length ? Math.min(...allD) : ws;
      canPrev = ws > minD - 6; canNext = wo < 0;
      onPrev = () => { if (canPrev) this.setState({ weekOff: wo - 1 }); };
      onNext = () => { if (canNext) this.setState({ weekOff: wo + 1 }); };
    } else {
      inPeriod = between(R[0], R[1]);
      inPrev = between(R[0] - step, R[1] - step);
      inSelPeriod = o => { const ym = o.y * 12 + (o.m - 1); return ym >= R[0] && ym <= R[1]; };
      const tsM = (anchor - 2) % 12 + 1, tsY = Math.floor((anchor - 2) / 12);
      periodLabel = { 'Ce mois': `${C.MONTHS[aM]} ${aY}`, 'Trimestre': `${C.MONTHS[tsM]}${tsY !== aY ? ' ' + tsY : ''} – ${C.MONTHS[aM]} ${aY}`, 'Année': `Année ${aY}` }[this.state.period];
      periodSort = { 'Ce mois': `${aY}-${this.dd(aM)}`, 'Trimestre': `${aY}-T${Math.ceil(aM / 3)}`, 'Année': `${aY}` }[this.state.period];
      const pvM = (anchor - 1) % 12 + 1;
      vsNote = { 'Ce mois': `vs ${C.MONTHS[pvM].toLowerCase()}`, 'Trimestre': 'vs trim. préc.', 'Année': `vs ${aY - 1}` }[this.state.period];
      canPrev = R[0] > dataMin; canNext = R[1] < dataMax;
      onPrev = () => { if (canPrev) this.setState({ anchor: clamp(anchor - step) }); };
      onNext = () => { if (canNext) this.setState({ anchor: clamp(anchor + step) }); };
    }
    const prevStyle = arrowBase + (canPrev ? `color:${accent}` : 'color:#c8d0dc;cursor:default');
    const nextStyle = arrowBase + (canNext ? `color:${accent}` : 'color:#c8d0dc;cursor:default');
    const periods = ['Cette semaine', 'Ce mois', 'Trimestre', 'Année'].map(name => ({ name, onClick: () => this.setState({ period: name, weekOff: 0 }), style: this.state.period === name ? `white-space:nowrap;padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : 'white-space:nowrap;padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit' }));

    // Lignes annulées (Excel) : gardées visibles dans les tableaux (grisées), mais exclues
    // de tous les totaux/KPI. inPeriod/inPrev restent complets pour l'affichage des listes.
    const isAnnule = r => !!(this.state.annule || {})[this.annuleKey(r.type === 'Vente' ? 'ventes' : 'operations', r.ref)];
    const inPeriodActive = inPeriod.filter(r => !isAnnule(r));
    const inPrevActive = inPrev.filter(r => !isAnnule(r));

    // stats
    const stats = rs => { const v = rs.filter(r => r.type === 'Vente'), a = rs.filter(r => r.type === 'Achat'); const ca = v.reduce((s, r) => s + r.amt, 0), ach = a.reduce((s, r) => s + Math.abs(r.amt), 0);
      return { ca, ach, marge: ca - ach, nbV: v.length, nbA: a.length, taux: ca ? (ca - ach) / ca * 100 : 0, panier: v.length ? ca / v.length : 0, avgA: a.length ? ach / a.length : 0 }; };
    const S = stats(inPeriodActive), Sp = stats(inPrevActive);
    const tauxStr = S.taux.toFixed(1).replace('.', ',');
    const kpi = (label, value, cur, prev, goodUp, isCount) => { let delta = '—', color = gray, note = 'pas de comparatif';
      if (inPrev.length && isFinite(prev) && prev !== 0) { const diff = isCount ? cur - prev : (cur - prev) / Math.abs(prev) * 100; const sign = diff >= 0 ? '+' : '−'; delta = isCount ? sign + Math.abs(diff) : sign + Math.abs(diff).toFixed(1).replace('.', ',') + ' %'; color = diff === 0 ? gray : (diff > 0) === goodUp ? green : red; note = vsNote; }
      return { label, value, delta, deltaColor: color, note, spark: accent }; };
    let kpis;
    if (view === 'Achats') { const aPaid = r => r.paid != null ? r.paid : (r.status === 'Payé' ? Math.abs(r.amt) : 0); const aReste = r => r.reste != null ? r.reste : (r.status === 'Payé' ? 0 : Math.abs(r.amt)); const aRows = inPeriodActive.filter(r => r.type === 'Achat'); const paidA = aRows.reduce((s, r) => s + aPaid(r), 0); const resteA = aRows.reduce((s, r) => s + aReste(r), 0); const paidAp = inPrevActive.filter(r => r.type === 'Achat').reduce((s, r) => s + aPaid(r), 0); kpis = [kpi('Total des achats', this.fmt(S.ach), S.ach, Sp.ach, false), kpi('Total payé', this.fmt(paidA), paidA, paidAp, true), kpi('Restant à payer', this.fmt(resteA), resteA, 0, false), kpi('Fournisseurs actifs', String(new Set(aRows.map(r => r.partner)).size), 0, 0, true)]; }
    else if (view === 'Ventes') {
      const vRows = inPeriodActive.filter(r => r.type === 'Vente');
      const caHT = vRows.reduce((s, r) => s + (r.ht != null ? r.ht : r.amt), 0);
      const caHTp = inPrevActive.filter(r => r.type === 'Vente').reduce((s, r) => s + (r.ht != null ? r.ht : r.amt), 0);
      const caTTC = vRows.reduce((s, r) => s + r.amt, 0);
      const caTTCp = inPrevActive.filter(r => r.type === 'Vente').reduce((s, r) => s + r.amt, 0);
      const caDisp = amountMode === 'HT' ? caHT : caTTC;
      const caDispP = amountMode === 'HT' ? caHTp : caTTCp;
      const gRecvOf = g => (g.recv != null && g.recv !== 0) ? g.recv : ((g.p1 || 0) + (g.p2 || 0));
      const gRemOf = g => (g.rem != null ? g.rem : Math.round(((g.ttc || 0) - (g.p1 || 0) - (g.p2 || 0) - (g.charge || 0)) * 100) / 100);
      // « À percevoir » = Total TTC − paiements − charges, TOUJOURS recalculé (jamais la colonne
      // « Remains » du fichier : elle est à signe inversé — négative quand il reste à recevoir —
      // ce qui faisait que -10 544 était pris pour 0). Borné à ≥ 0 (un trop-perçu ne se reçoit pas).
      const gDueOf = g => Math.max(0, Math.round(((g.ttc || 0) - (g.p1 || 0) - (g.p2 || 0) - (g.charge || 0)) * 100) / 100);
      const gDateOf = g => this.gGrenkePeriod(g, resolveLink(g).fact);
      // Une ligne sans date fiable reste en « période inconnue » et n'alimente aucun KPI périodique.
      const gScoped = grenkeRows.filter(g => { const d = gDateOf(g); return d ? inSelPeriod(d) : false; });
      const gRecv = gScoped.reduce((s, g) => s + gRecvOf(g), 0);
      const gRecevoir = gScoped.reduce((s, g) => s + gDueOf(g), 0);
      const paidHors = vRows.reduce((s, r) => s + (r.paid != null ? r.paid : (r.status === 'Payé' ? r.amt : 0)), 0);
      const recevHors = vRows.reduce((s, r) => s + Math.max(0, (r.reste != null ? r.reste : (r.status === 'Payé' ? 0 : r.amt))), 0);
      // total non soldé toutes périodes confondues (indépendant du filtre)
      const gRecevoirTotal = grenkeRows.reduce((s, g) => s + gDueOf(g), 0);
      const kpiGrenke = kpi('À recevoir Grenke', this.fmt(gRecevoir), gRecevoir, 0, false);
      kpiGrenke.note = 'non soldé total : ' + this.fmt(gRecevoirTotal);
      kpis = [
        kpi(`Chiffre d'affaires (${amountMode})`, this.fmt(caDisp), caDisp, caDispP, true),
        kpi('Total payé (avec Grenke)', this.fmt(paidHors + gRecv), paidHors + gRecv, 0, true),
        kpi('À recevoir (hors Grenke)', this.fmt(recevHors), recevHors, 0, false),
        kpiGrenke,
      ];
    }
    else { const encP = inPeriodActive.filter(r => r.type === 'Vente' && r.status === 'Payé').reduce((s, r) => s + r.amt, 0); const decP = inPeriodActive.filter(r => r.type === 'Achat' && r.status === 'Payé').reduce((s, r) => s + Math.abs(r.amt), 0); const encPp = inPrevActive.filter(r => r.type === 'Vente' && r.status === 'Payé').reduce((s, r) => s + r.amt, 0); const decPp = inPrevActive.filter(r => r.type === 'Achat' && r.status === 'Payé').reduce((s, r) => s + Math.abs(r.amt), 0);
      kpis = [kpi('CA ventes', this.fmt(S.ca), S.ca, Sp.ca, true), kpi('Achats pêcheurs', this.fmt(S.ach), S.ach, Sp.ach, false), kpi('Marge brute', this.fmt(S.marge), S.marge, Sp.marge, true), kpi('Flux net (période)', this.fmt(encP - decP), encP - decP, encPp - decPp, true)]; }

    // trésorerie
    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const isAnnuleF = f => !!(this.state.annule || {})[this.annuleKey(f.sens === 'Fournisseur' ? 'factures' : 'ventes', f.ref)];
    const FActive = F.filter(f => !isAnnuleF(f));
    const clientOpen = FActive.filter(f => f.sens === 'Client' && f.reste > 0);
    const fournOpen = FActive.filter(f => f.sens === 'Fournisseur' && f.reste > 0);
    // Une relance concerne uniquement une créance client. Les factures fournisseurs échues
    // restent dans « Je dois » / Factures et ne doivent jamais gonfler la carte des Ventes.
    const overdueAll = FActive.filter(f => f.sens === 'Client' && f.over);
    const onMeDoit = sum(clientOpen, f => f.reste), jeDois = sum(fournOpen, f => f.reste), enRelance = sum(overdueAll, f => f.reste), encaisse = sum(FActive.filter(f => f.sens === 'Client'), f => f.paid);
    const mensNow = (this.state.credits || (demo ? C.CREDITS : [])).reduce((s, c) => s + (c.mens || 0), 0);
    // Solde du compte = solde courant lu dans le relevé bancaire (ligne la plus récente qui porte un solde) ; à défaut, somme des mouvements du relevé.
    const bankForSolde = this.state.banque || (demo ? C.BANQUE.map(a => ({ y: a[0], m: a[1], d: a[2], label: a[3], amt: a[4], solde: a[5] != null ? a[5] : null })) : []);
    const bankSoldeRows = bankForSolde.map((r, i) => ({ r, i })).filter(x => x.r.solde != null && !isNaN(x.r.solde));
    let soldeBanqueNum = 0, soldeBanqueKnown = false, soldeBanqueSource = '';
    if (bankSoldeRows.length) { const L = bankSoldeRows.sort((a, b) => (this.days(b.r) - this.days(a.r)) || (b.i - a.i))[0]; soldeBanqueNum = L.r.solde; soldeBanqueKnown = true; soldeBanqueSource = `relevé — solde au ${this.dd(L.r.d)}/${this.dd(L.r.m)}/${L.r.y}`; }
    else if (bankForSolde.length) { soldeBanqueNum = Math.round(bankForSolde.reduce((s, r) => s + (r.amt || 0), 0) * 100) / 100; soldeBanqueKnown = true; soldeBanqueSource = 'relevé — somme des mouvements'; }
    const tresoNette = soldeBanqueNum + onMeDoit - jeDois;
    const treasury = [
      { ...card('Trésorerie nette', this.fmt(tresoNette), tresoNette >= 0 ? green : red, 'solde compte + on me doit − je dois', tresoNette >= 0 ? green : red), soldeLine: soldeBanqueKnown ? this.fmt(soldeBanqueNum) : '— (importez le relevé)', soldeSource: soldeBanqueKnown ? soldeBanqueSource : 'aucun relevé importé' },
      card('On me doit (clients)', this.fmt(onMeDoit), green, `${clientOpen.length} facture${clientOpen.length > 1 ? 's' : ''} en attente`, green),
      card('Je dois (fournisseurs)', this.fmt(jeDois), amber, `${fournOpen.length} facture${fournOpen.length > 1 ? 's' : ''} à régler`, amber),
      card('En retard — à relancer', this.fmt(enRelance), red, `${overdueAll.length} facture${overdueAll.length > 1 ? 's' : ''} échue${overdueAll.length > 1 ? 's' : ''}`, red),
      card('Mensualités crédit', this.fmt(mensNow), '#0e1b2e', 'crédits & assurances / mois', accent),
    ];

    // ---- Cockpit (accueil) : saisie rapide + points d'attention du jour ----
    const cockAct = (label, col, patch) => ({ label, onClick: () => this.setState(patch), style: `flex:1;min-width:150px;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 16px;border-radius:12px;font-size:13.5px;font-weight:600;color:#fff;background:${col};border:none;cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(16,32,54,.08)` });
    const cockpitActions = [
      { label: '🎣 Saisir un achat', onClick: () => { this.setState({ view: 'SaisieCompta' }); this.openCompForm('Achat'); }, style: `flex:1;min-width:150px;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 16px;border-radius:12px;font-size:13.5px;font-weight:600;color:#fff;background:#b45309;border:none;cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(16,32,54,.08)` },
      { label: '🏷️ Saisir une vente', onClick: () => { this.setState({ view: 'SaisieCompta' }); this.openCompForm('Vente'); }, style: `flex:1;min-width:150px;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 16px;border-radius:12px;font-size:13.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(16,32,54,.08)` },
      { label: '💳 Paiement pêcheur', onClick: () => { this.setState({ view: 'SaisieCompta' }); this.openCompForm('Paiement'); }, style: `flex:1;min-width:150px;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 16px;border-radius:12px;font-size:13.5px;font-weight:600;color:#fff;background:#0f766e;border:none;cursor:pointer;font-family:inherit;box-shadow:0 1px 2px rgba(16,32,54,.08)` },
      cockAct('💳 Enregistrer un paiement', '#1a56db', { view: 'Relance' }),
      cockAct('📅 Agenda', '#6d28d9', { view: 'Agenda' }),
    ];
    // Chaque alerte a une croix ✕ : masquée pour la session (revient à la prochaine ouverture).
    const alertsHidden = this.state.alertsHidden || {};
    const alertCard = (hideKey, icon, tone, bg, bd, text, sub, patch, cta) => ({ icon, tone, bg, bd, text, sub, cta, onClick: () => this.setState(patch), onHide: () => this.setState({ alertsHidden: { ...(this.state.alertsHidden || {}), [hideKey]: true } }) });
    const cockpitAlerts = [];
    if (overdueAll.length && !alertsHidden.retard) cockpitAlerts.push(alertCard('retard', '🔴', '#b91c1c', '#fdecec', '#f3cccc', `${overdueAll.length} facture${overdueAll.length > 1 ? 's' : ''} client${overdueAll.length > 1 ? 's' : ''} en retard`, `${this.fmt(enRelance)} à relancer`, { view: 'Relance' }, 'Relancer'));
    if (fournOpen.length && !alertsHidden.fourn) cockpitAlerts.push(alertCard('fourn', '📄', '#b45309', '#fff7ed', '#f0dcc0', `${fournOpen.length} facture${fournOpen.length > 1 ? 's' : ''} fournisseur à payer`, `${this.fmt(jeDois)} au total`, { view: 'Factures' }, 'Voir'));
    if (mensNow > 0 && !alertsHidden.credit) cockpitAlerts.push(alertCard('credit', '🏦', '#b45309', '#fff7ed', '#f0dcc0', 'Mensualités de crédit', `${this.fmt(mensNow)} ce mois`, { view: 'Crédits' }, 'Voir'));
    if (agTodayCount && !alertsHidden.agenda) cockpitAlerts.push(alertCard('agenda', '🔔', accent, soft, this.hexToRgba(accent, 0.25), `${agTodayCount} événement${agTodayCount > 1 ? 's' : ''} aujourd'hui`, 'à l\'agenda', { view: 'Agenda' }, 'Ouvrir'));
    const cockpitAlertsEmpty = cockpitAlerts.length === 0;

    // ---- Textes du mode aide (Helpeur) : d'où vient chaque chiffre, avec les vrais noms de fichiers/colonnes
    const hSrcVentes = this.state.ventesName ? `« ${this.state.ventesName} »` : 'votre fichier de ventes (démo tant qu’aucun n’est importé)';
    const hSrcOps = this.state.opsName ? `« ${this.state.opsName} »` : 'votre fichier pêcheur (démo tant qu’aucun n’est importé)';
    const hSrcFac = this.state.facturesName ? `« ${this.state.facturesName} »` : 'votre fichier FACTURES A PAYER (démo tant qu’aucun n’est importé)';
    const hSrcCred = this.state.creditsName ? `« ${this.state.creditsName} »` : 'votre fichier crédits/assurances (démo tant qu’aucun n’est importé)';
    const hSrcBank = this.state.banqueName ? `« ${this.state.banqueName} »` : 'bancaire (démo tant qu’aucun n’est importé)';
    const HELP = {
      'CA ventes': `Somme des ventes de la période affichée. Chaque vente = colonne « Montant HT » + « TVA France » + « TVA Irlande » de ${hSrcVentes} (feuille 1). En mode HT (bouton en haut), seule la colonne Montant HT est utilisée.`,
      'Achats pêcheurs': `Somme de la colonne « Montant » de ${hSrcOps} (feuille « Suivi de la facturation ») pour la période affichée.`,
      'Marge brute': `CA ventes − Achats pêcheurs, sur la même période. Les deux chiffres viennent de ${hSrcVentes} et ${hSrcOps}.`,
      'Flux net (période)': `Argent réellement encaissé (ventes marquées payées) − argent réellement décaissé (achats payés) sur la période affichée. Différent de la marge : ici seuls les paiements effectifs comptent.`,
      "Chiffre d'affaires (HT)": `Somme de la colonne « Montant HT » de ${hSrcVentes} pour la période affichée.`,
      'Total payé (avec Grenke)': `Colonne « Montant réglé » de ${hSrcVentes} + paiements reçus via Grenke (feuille « Grenke » : 1er + 2e paiement).`,
      'À recevoir (hors Grenke)': `Somme des soldes restants (colonne « Solde restant » ou Montant TTC − Montant réglé) des factures clients non soldées, hors financement Grenke.`,
      'À recevoir Grenke': `Feuille « Grenke » de ${hSrcVentes} : Total TTC − 1er paiement − 2e paiement − charges, pour les dossiers non soldés de la période.`,
      'Total des achats': `Somme de la colonne « Montant » de ${hSrcOps} pour la période affichée.`,
      'Total payé': `Somme de la colonne « Total payé » de ${hSrcOps} pour la période affichée.`,
      'Restant à payer': `Somme de la colonne « Solde » de ${hSrcOps} — c’est le fichier qui fait foi, pas un calcul.`,
      'Fournisseurs actifs': `Nombre de pêcheurs différents ayant au moins une facture sur la période (colonne « Nom du client » de ${hSrcOps}).`,
      'Trésorerie nette': `Solde du compte (dernière colonne « solde » du relevé ${hSrcBank}) + On me doit (clients) − Je dois (fournisseurs).`,
      'On me doit (clients)': `Somme des restes à payer des factures clients non soldées : Montant TTC − Montant réglé (ou colonne « Solde restant ») de ${hSrcVentes}.`,
      'Je dois (fournisseurs)': `Somme des factures fournisseurs non payées : colonne « Montant » − « Paiement » de ${hSrcFac} (blocs FOURNISSEURS + FOURNISSEURS CRUSTACÉS des feuilles mensuelles).`,
      'En retard — à relancer': `Factures clients dont la date d’échéance est dépassée ET qui ne sont pas payées. L’échéance vient de la colonne « Délai » / « Date prévue » de ${hSrcVentes}.`,
      'Mensualités crédit': `Somme de la colonne « MENSUALITE » de ${hSrcCred} — total dû chaque mois pour vos crédits et assurances.`,
      'Rapprochées': `Lignes du relevé ${hSrcBank} reliées à un achat, une vente ou une facture — automatiquement (même montant + date proche + libellé reconnu) ou validées par vous.`,
      'À confirmer': `Lignes du relevé pour lesquelles une correspondance probable a été trouvée mais pas certaine — cliquez ✓ pour valider ou « Lier » pour choisir vous-même.`,
      'Non rapprochées': `Lignes du relevé sans correspondance trouvée dans vos achats/ventes/factures — à lier manuellement ou à masquer (🗑) si hors sujet (frais bancaires, virement interne…).`,
      'Mouvements du relevé': `Somme de tous les mouvements (encaissements − décaissements) des lignes affichées du relevé ${hSrcBank}.`,
    };
    kpis.forEach(k => { if (HELP[k.label]) k.help = HELP[k.label]; });
    treasury.forEach(s => { if (HELP[s.label]) s.help = HELP[s.label]; });

    // table opérations
    const typeScoped = view === 'Achats' ? inPeriod.filter(r => r.type === 'Achat') : view === 'Ventes' ? inPeriod.filter(r => r.type === 'Vente') : inPeriod;
    const catList = ['Toutes', ...[...new Set(typeScoped.map(r => r.cat))]];
    const effCat = catList.includes(this.state.cat) ? this.state.cat : 'Toutes';
    const isGrenkeView = view === 'Grenke';
    const scoped = effCat === 'Toutes' ? typeScoped : typeScoped.filter(r => r.cat === effCat);
    const opStatus = { 'Payé': `${badge}background:#e7f5ec;color:${green}`, 'Payée': `${badge}background:#e7f5ec;color:${green}`, 'Partiellement payée': `${badge}background:#fff7df;color:#9a6700`, 'En attente': `${badge}background:#fef4e6;color:${amber}`, 'Non payé': `${badge}background:#fef4e6;color:${amber}`, 'Non payée': `${badge}background:#fef4e6;color:${amber}`, 'Retard': `${badge}background:#fdeaea;color:${red}` };
    const cap = compact ? 22 : 15;
    const scopedQ = scoped.filter(r => matchTxt(r.partner, r.ref, r.cat, r.type));
    // ---- filtres de statut par tableau (Tous / Payé / En attente / …) ----
    const stFAll = this.state.tblStatusF || {};
    const effStatus = (key, values) => (values.includes(stFAll[key]) ? stFAll[key] : 'Tous');
    const stChipBase = 'padding:6px 12px;border-radius:99px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;';
    const statusChipsFor = (key, values) => { const eff = effStatus(key, values); return ['Tous', ...values].map(name => ({ name, onClick: () => this.setTblStatus(key, name), style: stChipBase + (name === eff ? 'font-weight:600;color:#fff;background:#475569;border:1px solid #475569' : 'font-weight:500;color:#69788c;background:#fff;border:1px solid #dde4ee') })); };
    const opsStatusVals = [...new Set(scopedQ.map(r => r.status || '—'))];
    const opsStatusEff = effStatus('ops', opsStatusVals);
    const opsStatusChips = statusChipsFor('ops', opsStatusVals);
    const scopedQS = opsStatusEff === 'Tous' ? scopedQ : scopedQ.filter(r => (r.status || '—') === opsStatusEff);
    const txPager = paginate(scopedQS);
    const grenkeLinkedFactRefs = new Set(); const grenkeNumSet = new Set();
    grenkeRows.forEach(g => { const L = resolveLink(g); if (L.ref) { grenkeLinkedFactRefs.add(this.nrm(L.ref)); const k = gNum(L.ref); if (k) grenkeNumSet.add(k); } else { const k = gNum(g.ref); if (k) grenkeNumSet.add(k); } });
    const filtered = txPager.slice.map(r => {
      const isHt = amountMode === 'HT' && r.type === 'Vente' && r.ht != null; const dispAmt = isHt ? (r.amt < 0 ? -r.ht : r.ht) : r.amt; const isGrk = r.type === 'Vente' && r.ref && (grenkeLinkedFactRefs.has(this.nrm(r.ref)) || (gNum(r.ref) && grenkeNumSet.has(gNum(r.ref)))); const canResolve = r.type === 'Vente' && r.status === 'À vérifier'; const stStyle = opStatus[r.status] || `${badge}background:#eef1f5;color:${slate}`;
      const annulled = r.type === 'Vente' && isAnnule(r);
      return ({ ref: r.ref || '—', date: `${this.dd(r.d)}/${this.dd(r.m)}`, type: isGrk ? 'Grenke' : r.type, partner: (r.manual ? '✎ ' : '') + r.partner, cat: r.cat, amount: (dispAmt < 0 ? '−' : '+') + Math.abs(dispAmt).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' € ' + (isHt ? 'HT' : 'TTC'), amountColor: dispAmt < 0 ? red : green, status: r.status + (r.paymentWarning ? ' ⚠' : ''),
        statusStyle: stStyle, statusButtonStyle: `${stStyle};border:${canResolve || r.paymentWarning ? '1px solid #e0b85f' : 'none'};cursor:${canResolve ? 'pointer' : 'default'};font-family:inherit`, statusTitle: canResolve ? 'Cliquez pour comprendre et résoudre cette anomalie' : (r.paymentWarning || ''), onResolve: canResolve ? () => this.setState({ payResolveRef: r.ref }) : null,
        typeStyle: isGrk ? `${badge}background:#ede9fe;color:#6d28d9` : r.type === 'Vente' ? `${badge}background:${soft};color:${accent}` : `${badge}background:#eef1f5;color:${slate}`,
        canCancel: r.type === 'Vente', annulled, notAnnulled: r.type === 'Vente' && !annulled, rowOpacity: annulled ? '0.45' : '1', refDecoration: annulled ? 'line-through' : 'none',
        onCancel: r.type === 'Vente' ? () => this.requestCancelPreview('ventes', r.ref) : null, cancelStyle: cancelBtnStyle,
        onRestore: r.type === 'Vente' ? () => this.requestCancelPreview('ventes', r.ref, { restore: true }) : null, restoreStyle: restoreBtnStyle, annuleBadgeStyle });
    });
    const moreLabel = (view === 'Achats' && scoped.length > cap) ? `Affichage des ${cap} premières lignes sur ${scoped.length} — réduisez la période pour tout voir.` : '';
    const isAchatView = view === 'Achats';
    const isGenericTable = isDash && !isAchatView && !isGrenkeView;
    const grenkeStatusStyle = st => /sold|paye|regl|complet/i.test(st) ? `${badge}background:#e7f5ec;color:${green}` : `${badge}background:#fef4e6;color:${amber}`;
    // ---- Rapprochement Grenke ↔ factures internes (match sur la partie numérique) ----
    // (résolution Grenke↔factures déplacée plus haut, juste après computeFactures)
    const linkedChip = `display:inline-block;max-width:100%;box-sizing:border-box;padding:3px 8px;border-radius:6px;font-size:11.5px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:${accent};background:${soft};border:1px solid ${this.hexToRgba(accent, 0.28)};cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle`;
    const unlinkedChip = 'display:inline-block;box-sizing:border-box;padding:3px 11px;border-radius:6px;font-size:11.5px;font-weight:600;font-family:inherit;color:#8291a5;background:#fff;border:1px dashed #c5cede;cursor:pointer;white-space:nowrap;vertical-align:middle';
    const gSort = this.state.grenkeSort || { key: 'date', dir: 'desc' };
    // L'onglet Grenke est un SUIVI DE DOSSIERS, pas un journal : tous les dossiers restent
    // visibles quelle que soit la période (la feuille Grenke n'a pas de dates propres, et un
    // dossier masqué par un filtre de période « disparaît » aux yeux de l'utilisatrice).
    const gDateOfT = g => this.gGrenkeDate(g, resolveLink(g).fact);
    const gEnriched = (isGrenkeView ? grenkeRows.slice() : []).map(g => {
      const L = resolveLink(g);
      const recv = (g.recv != null && g.recv !== 0) ? g.recv : ((g.p1 || 0) + (g.p2 || 0));
      const fact = L.fact;
      const dateO = this.gGrenkeDate(g, resolveLink(g).fact);
      const dateNum = dateO ? this.days(dateO) : -Infinity;
      const dateStr = dateO ? `${this.dd(dateO.d)}/${this.dd(dateO.m)}/${String(dateO.y).slice(2)}` : '—';
      const cust = (g.cust && String(g.cust).trim()) ? g.cust : (fact ? fact.partner : '—');
      const rem = g.rem != null ? g.rem : Math.round(((g.ttc || 0) - (g.p1 || 0) - (g.p2 || 0) - (g.charge || 0)) * 100) / 100;
      return { g, L, recv, dateO, dateNum, dateStr, cust, rem };
    });
    const gdir = gSort.dir === 'asc' ? 1 : -1;
    const gnum = x => parseInt(this.gNumKey(x.g.ref) || '0', 10) || 0;
    gEnriched.sort((a, b) => {
      let r;
      switch (gSort.key) {
        case 'num': r = gnum(a) - gnum(b); break;
        case 'cust': r = String(a.cust).localeCompare(String(b.cust), 'fr'); break;
        case 'ttc': r = (a.g.ttc || 0) - (b.g.ttc || 0); break;
        case 'rem': r = (a.rem || 0) - (b.rem || 0); break;
        case 'statut': r = String(a.g.statut || '').localeCompare(String(b.g.statut || ''), 'fr'); break;
        default: r = a.dateNum - b.dateNum; break;
      }
      return (r || gnum(a) - gnum(b)) * gdir;
    });
    const gStatusVals = [...new Set(gEnriched.map(x => String(x.g.statut || '—').toUpperCase()))];
    const gStatusEff = effStatus('grenke', gStatusVals);
    const grenkeStatusChips = statusChipsFor('grenke', gStatusVals);
    const gFiltered = gEnriched.filter(x => matchTxt(x.g.ref, x.cust, (x.L && x.L.ref) || '', x.g.statut) && (gStatusEff === 'Tous' || String(x.g.statut || '—').toUpperCase() === gStatusEff));
    const grenkePager = paginate(gFiltered);
    const grenkeTableRows = grenkePager.slice.map(({ g, L, recv, dateStr, cust, rem }) => ({
      ref: g.ref || '—', date: dateStr,
      linked: !!L.ref, linkLabel: L.ref ? ('🔗 ' + L.ref) : 'Lier', linkStyle: L.ref ? linkedChip : unlinkedChip,
      linkTitle: L.ref ? (L.manual ? 'Lien manuel — cliquer pour modifier' : 'Rapproché automatiquement — cliquer pour modifier') : 'Lier à une facture interne',
      onLink: () => this.openGrenkeLink({ gref: g.ref, current: L.ref || '' }),
      cust, ttc: this.fmt(g.ttc), p1: g.p1 ? this.fmt(g.p1) : '—', p2: g.p2 ? this.fmt(g.p2) : '—',
      rem: this.fmt(rem), charge: g.charge ? this.fmt(g.charge) : '—', total: this.fmt(recv),
      statut: g.statut || '—', statutStyle: grenkeStatusStyle(g.statut || ''),
      onTrash: () => this.setState({ trashAsk: { kind: 'grenke', key: this.gHideKey(g), label: 'Ligne Grenke n° ' + (g.ref || '—') + ' · ' + this.fmt(g.ttc) } }), trashStyle: trashBtnStyle
    }));
    const grenkeEmpty = isGrenkeView && gFiltered.length === 0;
    // en-têtes triables (clic = tri réel)
    const gSortInd = k => gSort.key === k ? (gSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const gHdrBase = 'font-size:11px;font-weight:600;color:#93a1b3;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap;';
    const gh = (label, key, align) => ({ label: label + gSortInd(key), onClick: () => this.setGrenkeSort(key), style: `${gHdrBase}cursor:pointer;user-select:none;${gSort.key === key ? 'color:' + accent + ';' : ''}${align === 'r' ? 'text-align:right;' : ''}` });
    const ghStatic = (label, align) => ({ label, onClick: () => {}, style: `${gHdrBase}${align === 'r' ? 'text-align:right;' : ''}` });
    const grenkeHeaders = [ gh('N° facture', 'num'), ghStatic('Facture liée'), gh('Date', 'date'), gh('Client', 'cust'), gh('Total TTC', 'ttc', 'r'), ghStatic('1er paiement', 'r'), ghStatic('2e paiement', 'r'), gh('Restant', 'rem', 'r'), ghStatic('Charges', 'r'), ghStatic('Total reçu', 'r'), gh('Statut', 'statut'), ghStatic('') ];
    // ---- Modale de liaison manuelle Grenke ----
    const gl = this.state.grenkeLink;
    const grenkeLinkOpen = !!gl;
    const glRef = gl ? gl.gref : '';
    const grenkeLinkNum = glRef;
    const grenkeLinkCurrent = gl ? (gl.current || '') : '';
    const grenkeLinkHasCurrent = !!grenkeLinkCurrent;
    const grenkeLinkHasOverride = gl ? Object.prototype.hasOwnProperty.call(grenkeLinks, glRef) : false;
    const autoForModal = (gl && gNum(glRef)) ? factByNum[gNum(glRef)] : null;
    const grenkeLinkHelp = gl ? (autoForModal ? `Proposition automatique : ${autoForModal.ref} — ${autoForModal.partner || 'sans nom'}. Sélectionnez une autre facture ci-dessous pour corriger.` : 'Aucune facture trouvée automatiquement pour ce numéro. Sélectionnez la facture correspondante ci-dessous.') : '';
    const grenkeLinkQuery = this.state.grenkeLinkQuery || '';
    const glq = grenkeLinkQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const grenkeLinkList = (gl ? F.slice() : []).filter(f => { if (!glq) return true; const hay = (f.ref + ' ' + (f.partner || '')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return hay.includes(glq); })
      .sort((a, b) => (gNum(a.ref) === gNum(glRef) ? 0 : 1) - (gNum(b.ref) === gNum(glRef) ? 0 : 1))
      .slice(0, 80).map(f => {
        const isCur = grenkeLinkCurrent && this.nrm(f.ref) === this.nrm(grenkeLinkCurrent);
        const isAuto = autoForModal && f.ref === autoForModal.ref;
        return { ref: f.ref, partner: f.partner || '—', ttc: this.fmt(f.ttc), onPick: () => this.setGrenkeLink(glRef, f.ref),
          rowStyle: `display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid #f4f6fa;cursor:pointer;font-size:12.5px;${isCur ? `background:${soft}` : ''}`,
          tag: isCur ? `${badge}background:${soft};color:${accent}` : (isAuto ? `${badge}background:#e7f5ec;color:${green}` : 'display:none'),
          tagLabel: isCur ? 'Lié' : (isAuto ? 'Auto' : '') };
      });
    const grenkeLinkEmpty = grenkeLinkOpen && grenkeLinkList.length === 0;
    const onGrenkeLinkQuery = e => this.setState({ grenkeLinkQuery: e.target.value });
    const onGrenkeLinkCancel = () => this.closeGrenkeLink();
    const onGrenkeUnlink = () => this.setGrenkeLink(glRef, '');
    const onGrenkeAuto = () => this.clearGrenkeLink(glRef);
    const grenkeLinkCardStyle = 'width:560px;max-width:100%;max-height:88vh;overflow:auto;background:#fff;border:1px solid #e2e8f1;border-radius:16px;box-shadow:0 30px 60px -24px rgba(14,27,46,.5);font-family:inherit;padding:22px';
    const grenkeUnlinkStyle = 'padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#b91c1c;background:#fff;border:1px solid #f0c9c9;cursor:pointer;font-family:inherit';
    const grenkeAutoStyle = 'padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#69788c;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    const achatAll = (isAchatView ? scoped : []).map(r => { const gross = Math.abs(r.amt); const paid = r.paid != null ? r.paid : (r.status === 'Payé' ? gross : 0); const reste = r.reste != null ? r.reste : Math.max(0, gross - paid); const st = reste > 0.005 ? (r.status === 'Retard' ? 'Retard' : 'Non payé') : 'Payé'; const annulled = isAnnule(r); return { date: `${this.dd(r.d)}/${this.dd(r.m)}`, ref: r.ref, partner: (r.manual ? '✎ ' : '') + r.partner, paidStr: this.fmt(paid), resteStr: this.fmt(reste), resteColor: reste > 0.005 ? red : green, status: st, statusStyle: st === 'Payé' ? `${badge}background:#e7f5ec;color:${green}` : st === 'Retard' ? `${badge}background:#fdeaea;color:${red}` : `${badge}background:#fef4e6;color:${amber}`, statusButtonStyle: (st === 'Payé' ? `${badge}background:#e7f5ec;color:${green}` : st === 'Retard' ? `${badge}background:#fdeaea;color:${red}` : `${badge}background:#fef4e6;color:${amber}`) + ';border:none;cursor:default;font-family:inherit', onResolve: null, statusTitle: '', onTrash: () => this.setState({ trashAsk: { kind: 'op', key: this.opHideKey(r), label: 'Facture ' + (r.ref || '—') + ' · ' + (r.partner || '—') + ' · ' + this.fmt(gross) } }), trashStyle: trashBtnStyle, annulled, notAnnulled: !annulled, rowOpacity: annulled ? '0.45' : '1', refDecoration: annulled ? 'line-through' : 'none', onCancel: () => this.requestCancelPreview('operations', r.ref), cancelStyle: cancelBtnStyle, onRestore: () => this.requestCancelPreview('operations', r.ref, { restore: true }), restoreStyle: restoreBtnStyle, annuleBadgeStyle }; });
    const achatStatusVals = [...new Set(achatAll.map(t => t.status))];
    const achatStatusEff = effStatus('achat', achatStatusVals);
    const achatStatusChips = statusChipsFor('achat', achatStatusVals);
    const achatFilteredRows = achatStatusEff === 'Tous' ? achatAll : achatAll.filter(t => t.status === achatStatusEff);
    const achatRows = achatFilteredRows.slice(0, cap);
    const resultLabel = `${scoped.length} opération${scoped.length > 1 ? 's' : ''}` + (effCat === 'Toutes' ? '' : ' · ' + effCat);
    const tableTitle = view === 'Achats' ? 'Commandes fournisseurs' : view === 'Ventes' ? 'Ventes clients' : 'Transactions';
    const categories = catList.slice(0, 7).map(name => ({ name, onClick: () => this.setState({ cat: name, q: '', page: 0 }), style: effCat === name ? `padding:6px 12px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:6px 12px;border-radius:99px;font-size:12px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit' }));

    // side cards
    const barsItem = (label, right, pct, detail, rightColor) => ({ label, right, pct, detail, bar: accent, rightColor: rightColor || accent });
    const O = this.state.obj || {};
    const num = (v, d) => { const n = Number(v); return isFinite(n) && n > 0 ? n : d; };
    const tCAm = num(O.caM, this.props.objectifCAMensuel ?? 32000), tCAa = num(O.caA, this.props.objectifCAAnnuel ?? 260000), tTaux = num(O.taux, this.props.objectifTauxMarge ?? 25), tVm = num(O.vM, this.props.objectifVentesMensuel ?? 7);
    const targets = ({ 'Cette semaine': { ca: Math.round(tCAm / 4), ventes: Math.max(1, Math.round(tVm / 4)) }, 'Ce mois': { ca: tCAm, ventes: tVm }, 'Trimestre': { ca: Math.round(tCAa / 4), ventes: tVm * 3 }, 'Année': { ca: tCAa, ventes: tVm * 12 } })[this.state.period] || { ca: tCAm, ventes: tVm };
    const objectifs = { title: 'Objectifs — ' + periodLabel, isBars: true, isRank: false, items: [barsItem('Objectif CA', this.pctStr(S.ca / targets.ca * 100), this.pctStr(S.ca / targets.ca * 100), `${this.fmt(S.ca)} / ${this.fmt(targets.ca)}`), barsItem('Taux de marge', this.pctStr(S.taux / tTaux * 100), this.pctStr(S.taux / tTaux * 100), `${tauxStr} % / objectif ${tTaux} %`), barsItem('Ventes réalisées', this.pctStr(S.nbV / targets.ventes * 100), this.pctStr(S.nbV / targets.ventes * 100), `${S.nbV} / ${targets.ventes} ventes`)] };
    const byCat = {}; inPeriod.filter(r => r.type === 'Achat').forEach(r => { byCat[r.cat] = (byCat[r.cat] || 0) + Math.abs(r.amt); });
    const repartition = { title: 'Répartition des achats', isBars: true, isRank: false, items: Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, v]) => barsItem(c, this.fmt(v), this.pctStr(v / (S.ach || 1) * 100), `${Math.round(v / (S.ach || 1) * 100)} % des achats`, '#0e1b2e')) };
    const rank = type => { const by = {}; inPeriod.filter(r => r.type === type).forEach(r => { by[r.partner] = by[r.partner] || { n: 0, vol: 0 }; by[r.partner].n++; by[r.partner].vol += Math.abs(r.amt); }); return Object.entries(by).sort((a, b) => b[1].vol - a[1].vol).slice(0, 4).map(([name, x]) => ({ ini: name[0], av, name, sub: `${x.n} opération${x.n > 1 ? 's' : ''}`, val: this.fmt(x.vol) })); };
    let sideCards;
    const noteCard = { title: 'Notes', isNote: true, isBars: false, isRank: false, items: [] };
    if (view === 'Achats') sideCards = [noteCard, repartition, { title: 'Top fournisseurs', isBars: false, isRank: true, items: rank('Achat') }];
    else if (view === 'Ventes') sideCards = [noteCard, objectifs, { title: 'Top clients', isBars: false, isRank: true, items: rank('Vente') }];
    else sideCards = [noteCard, objectifs, repartition];
    const collapsedMap = this.state.sideCollapsed || {};
    const SIDEHELP = {
      'Notes': `Bloc-notes libre, enregistré automatiquement à chaque frappe sur cet ordinateur. Pratique pour un rappel ou une consigne.`,
      'Top fournisseurs': `Vos pêcheurs classés par montant d'achats sur la période affichée (colonne « Montant » de ${hSrcOps}).`,
      'Top clients': `Vos clients classés par chiffre d'affaires sur la période affichée (factures de ${hSrcVentes}).`,
    };
    sideCards = sideCards.map(c => { const isOpen = !collapsedMap[c.title]; return { ...c, help: c.help || SIDEHELP[c.title] || (String(c.title).startsWith('Objectifs') ? `Votre avancement par rapport aux objectifs fixés dans Paramètres : objectif de CA (mensuel ou annuel selon la période), taux de marge cible et nombre de ventes. La barre se remplit avec les chiffres réels de la période.` : `Répartition du chiffre d'affaires de la période par catégorie de vente.`), isNote: !!c.isNote && isOpen, isBars: !!c.isBars && isOpen, isRank: !!c.isRank && isOpen, headStyle: `display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:${isOpen ? 14 : 0}px`, toggleLabel: isOpen ? '▾' : '▸', onToggle: () => { const nc = { ...(this.state.sideCollapsed || {}), [c.title]: isOpen }; this.setState({ sideCollapsed: nc }); try { localStorage.setItem('avSideCollapsed', JSON.stringify(nc)); } catch (e) {} } }; });
    const noteText = this.state.sideNote || '';
    const onNoteChange = e => { const v = e.target.value; this.setState({ sideNote: v }); try { localStorage.setItem('avSideNote', v); } catch (e) {} };

    // FACTURES
    const statusStyle = st => (st === 'Payée' || st === 'Acquittée') ? `${badge}background:#e7f5ec;color:${green}` : (st === 'Partiellement payée' || st === 'Partiel') ? `${badge}background:${soft};color:${accent}` : (st === 'Non payée' || st === 'En attente') ? `${badge}background:#fef4e6;color:${amber}` : `${badge}background:#fdeaea;color:${red}`;
    const facTabDefs = [['Factures', 'Factures'], ['Rapprochement', 'Rapprochement']];
    const facTabs = facTabDefs.map(([key, label]) => ({ name: label, onClick: () => this.setState({ facTab: key, q: '', page: 0 }), style: this.state.facTab === key ? `white-space:nowrap;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : 'white-space:nowrap;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit' }));
    const effFacTab = this.state.facTab;
    const dashBody = isDash;
    const facIsList = effFacTab === 'Factures', facIsCredits = effFacTab === 'Crédits', facIsReco = effFacTab === 'Rapprochement';
    const enAttente = sum(FActive.filter(f => f.reste > 0 && !f.over), f => f.reste);
    const foF = F.filter(f => f.sens === 'Fournisseur'); // affichage : inclut les lignes annulées (grisées)
    const foFActive = FActive.filter(f => f.sens === 'Fournisseur'); // totaux uniquement
    const totalAchete = sum(foFActive, f => f.ttc);
    const resteFourn = sum(foFActive, f => f.reste);
    const TD = Component.TODAY; const Tdays = this.days(TD);
    const dowT = (new Date(Date.UTC(TD.y, TD.m - 1, TD.d)).getUTCDay() + 6) % 7; const wkStart = Tdays - dowT;
    const inWeek = f => { const d = this.days(f.em); return d >= wkStart && d <= wkStart + 6; };
    const inMonth = f => f.em.y === TD.y && f.em.m === TD.m;
    const inQuarter = f => f.em.y === TD.y && Math.floor((f.em.m - 1) / 3) === Math.floor((TD.m - 1) / 3);
    const inYear = f => f.em.y === TD.y;
    const foInPeriod = foFActive.filter(f => inSelPeriod(f.em));
    const facCards = [
      card('Achats — ' + periodLabel, this.fmt(sum(foInPeriod, f => f.ttc)), '#0e1b2e', `${foInPeriod.length} facture${foInPeriod.length > 1 ? 's' : ''} sur la période`, accent),
      card('Payé — ' + periodLabel, this.fmt(sum(foInPeriod, f => f.paid)), '#0e1b2e', 'réglé sur la période', slate),
      card('Reste à payer — total', this.fmt(resteFourn), amber, `${foFActive.filter(f => f.reste > 0).length} facture${foFActive.filter(f => f.reste > 0).length > 1 ? 's' : ''} à régler`, amber),
      card('Total acheté — tout', this.fmt(totalAchete), '#0e1b2e', `${foFActive.length} facture${foFActive.length > 1 ? 's' : ''} fournisseur`, slate),
    ];
    const facFilterList = ['Tous', 'Payée', 'Partiellement payée', 'Non payée', 'À vérifier', 'En retard', 'À relancer'];
    const facFilters = facFilterList.map(name => ({ name, onClick: () => this.setState({ facFilter: name, q: '', page: 0 }), style: this.state.facFilter === name ? `padding:6px 12px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:6px 12px;border-radius:99px;font-size:12px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit' }));
    const ff = this.state.facFilter;
    const facSorted = [...foF.filter(f => inSelPeriod(f.em) || f.reste > 0)].sort((a, b) => (a.reste > 0 ? 0 : 1) - (b.reste > 0 ? 0 : 1) || this.days(a.dueO) - this.days(b.dueO));
    const facMatch = f => ff === 'Tous' || ff === 'Client' || ff === 'Fournisseur' ? true : f.status === ff;
    const facList = facSorted.filter(facMatch);
    const facQ = facList.filter(f => matchTxt(f.ref, f.partner, f.status, f.typeLabel));
    const facPager = paginate(facQ);
    const facRows = facPager.slice.map(f => {
      const isGr = grenkeLinkedFactRefs.has(this.nrm(f.ref)), canResolve = f.status === 'À vérifier' && f.sens === 'Client';
      const annulled = isAnnuleF(f);
      return { date: `${this.dd(f.em.d)}/${this.dd(f.em.m)}`, due: `${this.dd(f.dueO.d)}/${this.dd(f.dueO.m)}`, dueColor: f.over ? red : '#69788c', ref: f.ref, partner: f.partner, typeLabel: isGr ? 'Grenke' : (f.sens === 'Client' ? 'Client' : 'Fourn.'), typeStyle: isGr ? `${badge}background:#e7f5ec;color:${green}` : (f.sens === 'Client' ? `${badge}background:${soft};color:${accent}` : `${badge}background:#eef1f5;color:${slate}`), ttc: this.fmt(f.ttc), paid: f.paid ? this.fmt(f.paid) : '—', reste: f.reste ? this.fmt(f.reste) : '—', resteColor: f.reste ? (f.over ? red : '#0e1b2e') : green, status: f.status + (f.paymentWarning ? ' ⚠' : ''),
        statusButtonStyle: `${statusStyle(f.status)};border:${canResolve || f.paymentWarning ? '1px solid #e0b85f' : 'none'};cursor:${canResolve ? 'pointer' : 'default'};font-family:inherit`,
        statusTitle: canResolve ? 'Cliquez pour comprendre et résoudre cette anomalie' : (f.paymentWarning || ''),
        onResolve: canResolve ? () => this.setState({ payResolveRef: f.ref }) : null,
        annulled, notAnnulled: !annulled, rowOpacity: annulled ? '0.45' : '1', refDecoration: annulled ? 'line-through' : 'none',
        onCancel: () => this.requestCancelPreview('factures', f.ref, { month: f.em.m }), cancelStyle: cancelBtnStyle,
        onRestore: () => this.requestCancelPreview('factures', f.ref, { restore: true, month: f.em.m }), restoreStyle: restoreBtnStyle, annuleBadgeStyle,
      };
    });

    const payResolveInvoice = this.state.payResolveRef ? F.find(f => this.invoiceKey(f.ref) === this.invoiceKey(this.state.payResolveRef)) : null;
    const payIssue = payResolveInvoice && payResolveInvoice.paymentIssue;
    const payResolveOpen = !!(payResolveInvoice && payIssue);
    const onPayResolveClose = () => this.setState({ payResolveRef: null });
    const payBtn = `width:100%;padding:10px 13px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:left`;
    const payResolve = payResolveOpen ? {
      ref: payResolveInvoice.ref || '—', partner: payResolveInvoice.partner || '—', reason: payResolveInvoice.paymentCheck || payIssue.reason,
      explanation: payIssue.reason === 'Nombre de paiements inattendu' ? `${payIssue.rowCount} lignes de paiement ont été trouvées pour cette facture.` : 'Le statut, le montant réglé et le solde restant ne racontent pas la même chose.',
      values: [
        { label: 'Montant TTC', value: this.fmt(payResolveInvoice.ttc) }, { label: 'Montant réglé', value: payIssue.paid == null ? 'Non renseigné' : this.fmt(payIssue.paid) },
        { label: 'Solde restant', value: payIssue.solde == null ? 'Non renseigné' : this.fmt(payIssue.solde) }, { label: 'Statut Excel', value: payIssue.status || 'Non renseigné' },
        { label: 'Lignes trouvées', value: String(payIssue.rowCount || 0) }, { label: 'Feuille source', value: payIssue.source || 'Suivi des paiements' },
      ],
      changed: !!payResolveInvoice.paymentOverrideChanged,
      onPaid: () => this.resolvePayment(payResolveInvoice.ref, 'paid'), onCalculated: () => this.resolvePayment(payResolveInvoice.ref, 'calculated'), onUnpaid: () => this.resolvePayment(payResolveInvoice.ref, 'unpaid'),
      primaryStyle: `${payBtn};background:${accent};color:#fff;border:1px solid ${accent}`, secondaryStyle: `${payBtn};background:#fff;color:#0e1b2e;border:1px solid #dbe2ec`, cancelStyle: `${payBtn};background:#f8fafc;color:#69788c;border:1px solid #e5eaf1`,
    } : null;
    const facCount = `${facList.length} facture${facList.length > 1 ? 's' : ''}`;

    // échéancier clients (utilisé par le Compte rendu imprimable)
    const clientsDue = F.filter(f => f.sens === 'Client' && f.reste > 0);
    const relanceRows = clientsDue.slice().sort((a, b) => this.days(a.dueO) - this.days(b.dueO)).map(f => { const em = this.pIso(f.d); const delaiJ = f.delai != null ? f.delai : Math.max(0, this.days(f.dueO) - this.days(em)); return { partner: f.partner, ref: f.ref, due: `${this.dd(f.dueO.d)}/${this.dd(f.dueO.m)}`, delaiTxt: `${delaiJ} j`, reste: this.fmt(f.reste), flag: f.status, flagStyle: statusStyle(f.status) }; });

    // ---- Suivi de paiement (saisie manuelle : ID · N° facture · Client · TTC · Avoir · dates · réglé · solde · état) ----
    const isSuivi = view === 'Relance';
    const ptRows0 = this.payTrackRows();
    const ptSolde = r => Math.round(((+r.ttc || 0) - (+r.avoir || 0) - (+r.regle || 0)) * 100) / 100;
    const ptFrDate = iso => { if (!iso) return '—'; const p = String(iso).split('-'); return p[2] && p[1] ? `${p[2]}/${p[1]}/${String(p[0]).slice(2)}` : iso; };
    const ptEtatStyle = e => {
      const s = String(e || '').toLowerCase();
      if (s.includes('pay') || s.includes('sold')) return `${badge}background:#e7f5ec;color:${green}`;
      if (s.includes('retard')) return `${badge}background:#fdeaea;color:${red}`;
      if (s.includes('partiel')) return `${badge}background:#fef3c7;color:${amber}`;
      if (s.includes('avoir')) return `${badge}background:#eef1f5;color:${slate}`;
      return `${badge}background:${soft};color:${accent}`;
    };
    const payNorm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const payQ = payNorm((this.state.q || '').trim());
    const ptRowsF = payQ ? ptRows0.filter(r => [r.num, r.client, r.etat, r.id].some(v => payNorm(v).includes(payQ))) : ptRows0;
    const payTrackList = ptRowsF.map(r => { const solde = ptSolde(r); return {
      id: r.id, num: r.num || '—', client: r.client,
      ttc: this.fmt(+r.ttc || 0), avoir: r.avoir ? this.fmt(+r.avoir) : '—',
      dateFac: ptFrDate(r.dateFac), dateEch: ptFrDate(r.dateEch),
      regle: r.regle ? this.fmt(+r.regle) : '—', solde: this.fmt(solde), soldeColor: solde <= 0.005 ? green : (r.regle ? amber : '#0e1b2e'),
      datePay: ptFrDate(r.datePay), etat: r.etat || 'En attente', etatStyle: ptEtatStyle(r.etat),
      onEdit: () => this.editPayRow(r.id), onDelete: () => this.askDeletePay(r.id),
    }; });
    // KPI de synthèse
    const ptTtcTot = sum(ptRows0, r => +r.ttc || 0), ptRegleTot = sum(ptRows0, r => +r.regle || 0);
    const ptSoldeTot = sum(ptRows0, r => Math.max(0, ptSolde(r)));
    const ptRetard = sum(ptRows0.filter(r => String(r.etat).toLowerCase().includes('retard')), r => Math.max(0, ptSolde(r)));
    const paySummary = [
      card('Facturé (TTC)', this.fmt(ptTtcTot), '#0e1b2e', `${ptRows0.length} facture${ptRows0.length > 1 ? 's' : ''}`, accent),
      card('Encaissé', this.fmt(ptRegleTot), green, 'montants réglés', green),
      card('Solde restant', this.fmt(ptSoldeTot), ptSoldeTot > 0 ? amber : green, 'à encaisser', amber),
      card('Dont en retard', this.fmt(ptRetard), ptRetard > 0 ? red : gray, 'échéance dépassée', ptRetard > 0 ? red : gray),
    ];
    // Carte de saisie (brouillon)
    const pd = this.state.payDraft || this.payDefault();
    const payDraftSolde = this.fmt(Math.round((((parseFloat(String(pd.ttc).replace(',', '.')) || 0) - (parseFloat(String(pd.avoir).replace(',', '.')) || 0) - (parseFloat(String(pd.regle).replace(',', '.')) || 0))) * 100) / 100);
    const payDraft = {
      id: pd.id, num: pd.num || '', client: pd.client || '', ttc: pd.ttc === 0 ? '0' : (pd.ttc || ''), avoir: pd.avoir === 0 ? '' : (pd.avoir || ''),
      dateFac: pd.dateFac || '', dateEch: pd.dateEch || '', regle: pd.regle === 0 ? '' : (pd.regle || ''), datePay: pd.datePay || '', etat: pd.etat || 'En attente',
    };
    const payEtatOptions = ['En attente', 'Partiellement réglée', 'Payée', 'En retard', 'Avoir'].map(e => ({ value: e, label: e }));
    const payEditing = !!(this.state.payDraft && this.state.payDraft.editing);
    const onPayNum = e => this.setPayField('num', e.target.value);
    const onPayClient = e => this.setPayField('client', e.target.value);
    const onPayTtc = e => this.setPayField('ttc', e.target.value);
    const onPayAvoir = e => this.setPayField('avoir', e.target.value);
    const onPayDateFac = e => this.setPayField('dateFac', e.target.value);
    const onPayDateEch = e => this.setPayField('dateEch', e.target.value);
    const onPayRegle = e => this.setPayField('regle', e.target.value);
    const onPayDatePay = e => this.setPayField('datePay', e.target.value);
    const onPayEtat = e => this.setPayField('etat', e.target.value);
    const onPayCommit = () => this.commitPay();
    const onPayReset = () => this.resetPayDraft();
    const paySaveLabel = payEditing ? 'Mettre à jour' : '＋ Ajouter la facture';
    const payEmpty = ptRows0.length === 0;
    const payListEmpty = payTrackList.length === 0;
    const payEmptyMsg = (payQ && ptRows0.length) ? 'Aucune facture ne correspond à votre recherche.' : 'Aucune facture suivie. Enregistrez un paiement dans la carte ci-dessus.';
    const payInput = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dde3ec;border-radius:8px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff';
    const payInputN = payInput + ";font-family:'IBM Plex Mono',monospace;text-align:right";
    const payLbl = 'font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;color:#93a1b3;margin-bottom:4px;display:block';
    const paySaveStyle = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const payResetStyle = `padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`;
    const payRowBtnStyle = `padding:5px 9px;border-radius:7px;font-size:11.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`;
    const payDelBtnStyle = 'padding:5px 8px;border-radius:7px;font-size:11.5px;color:#b91c1c;background:#fff;border:1px solid #f1d4d4;cursor:pointer;font-family:inherit';
    const payDelAsk = this.state.payDelAsk;
    const payDelOpen = !!payDelAsk;
    const payDelName = payDelAsk ? `${payDelAsk.client} — ${this.fmt(+payDelAsk.ttc || 0)}` : '';
    const onPayDelConfirm = () => this.deletePayRow();
    const onPayDelCancel = () => this.setState({ payDelAsk: null });

    // ==================== SAISIE COMPTABLE (portage fidèle de la maquette « Saisie par transaction ») ====================
    const kgN = n => (Math.round((+n || 0) * 10) / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' kg';
    const espKeys = Object.keys(Component.ESP);
    const espOptsAll = espKeys.map(e => ({ value: e, label: e }));
    const calOptsOf = e => (Component.ESP[e] || ['Standard']).map(c => ({ value: c, label: c }));
    const asRows0 = this.achatSaisieRows();
    const vsRows0 = this.venteSaisieRows();
    // cartes d'action + onglet actif
    const compModeTabs = [{ k: 'Achat', lbl: '🎣 Achat pêcheur', col: '#b45309' }, { k: 'Paiement', lbl: '💳 Paiement pêcheur', col: '#0f766e' }, { k: 'Vente', lbl: '🏷️ Vente client', col: accent }, { k: 'Fournisseur', lbl: '📄 Facture fournisseur', col: '#7c3aed' }].map(t => ({ name: t.lbl, onClick: () => this.openCompForm(t.k), style: compTab === t.k ? `flex:1;min-width:150px;padding:13px 18px;border-radius:10px;font-size:14px;font-weight:700;color:#fff;background:${t.col};border:none;cursor:pointer;font-family:inherit` : `flex:1;min-width:150px;padding:13px 18px;border-radius:10px;font-size:14px;font-weight:600;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit` }));
    const compIsPaiement = compTab === 'Paiement';
    // Achats pêcheurs (toutes périodes confondues) — source : fichier operations. Lignes annulées
    // (colonne A) toujours ignorées. Filtre + tri pilotés par l'utilisateur (state).
    const pmd = this.state.paiementDraft || this.paiementDefault();
    const chqEditDraft = this.state.chqEditDraft;
    const chqAddDraftState = this.state.chqAddDraft;
    const chqAnnuleConfirm = this.state.chqAnnuleConfirm;
    const chqAnnuleReplaceAsk = this.state.chqAnnuleReplaceAsk;
    const paiementFilters = this.state.paiementFilters || [];
    const paiementSort = this.state.paiementSort || { key: 'ref', dir: 'asc' };
    const chipOn = 'padding:7px 13px;border-radius:999px;font-size:12px;font-weight:700;color:#fff;background:#0f766e;border:none;cursor:pointer;font-family:inherit';
    const chipOff = 'padding:7px 13px;border-radius:999px;font-size:12px;font-weight:600;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    // Filtres cumulables (boutons toggle indépendants, combinés en ET) — « Toutes » = aucun filtre actif.
    const paiementFilterOpts = [
      { k: 'toutes', lbl: 'Toutes' }, { k: 'nonSoldees', lbl: 'Non soldées' }, { k: 'soldees', lbl: 'Soldées' },
      { k: 'sansPaiement', lbl: 'Sans paiement' }, { k: 'avecCheque', lbl: 'Avec chèque' }, { k: 'virement', lbl: 'Virement' },
    ].map(f => { const active = f.k === 'toutes' ? paiementFilters.length === 0 : paiementFilters.includes(f.k); return { name: f.lbl, onClick: () => this.setPaiementFilter(f.k), style: active ? chipOn : chipOff }; });
    const sortArrow = k => paiementSort.key === k ? (paiementSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const paiementSortOpts = [
      { k: 'ref', lbl: 'N° facture' }, { k: 'montant', lbl: 'Montant' }, { k: 'date', lbl: 'Date' },
    ].map(s => ({ name: s.lbl + sortArrow(s.k), onClick: () => this.setPaiementSort(s.k), style: paiementSort.key === s.k ? chipOn : chipOff }));
    const achatsAll = ops.filter(r => r.type === 'Achat' && !this._isAnnuleColA(r.colA));
    const matchFilter = (r, f) => {
      const reste = r.reste != null ? r.reste : Math.abs(r.amt);
      const kind = this._chequeKind(r.chq);
      if (f === 'nonSoldees') return reste > 0.005;
      if (f === 'soldees') return reste <= 0.005;
      if (f === 'sansPaiement') return kind === 'vide';
      if (f === 'avecCheque') return kind === 'cheque_num';
      if (f === 'virement') return kind === 'virement_bb';
      return true;
    };
    const achatsFiltered = achatsAll.filter(r => paiementFilters.every(f => matchFilter(r, f)));
    const sortVal = (r, key) => key === 'montant' ? Math.abs(r.amt) : key === 'date' ? ((r.y || 0) * 10000 + (r.m || 0) * 100 + (r.d || 0)) : (parseInt(String(r.ref).replace(/\D/g, ''), 10) || 0);
    const achatsSorted = achatsFiltered.slice().sort((a, b) => { const d = sortVal(a, paiementSort.key) - sortVal(b, paiementSort.key); return paiementSort.dir === 'desc' ? -d : d; });
    const impayesAchats = achatsSorted.map(r => {
      const reste = r.reste != null ? r.reste : Math.abs(r.amt);
      const paidAmt = r.paid || 0;
      const selected = pmd.ref === r.ref;
      const chequeKind = this._chequeKind(r.chq);
      const chequeLabel = chequeKind === 'cheque_num' ? `🧾 Chèque n°${r.chq}` : chequeKind === 'virement_bb' ? '🏦 Virement émis' : chequeKind === 'texte' ? `📝 ${r.chq}` : '—';
      const enAttente = chequeKind === 'vide' && paidAmt < 0.005;
      return { ref: r.ref || '—', partner: r.partner || '—', montant: this.fmt(Math.abs(r.amt)), paid: this.fmt(paidAmt), reste: this.fmt(reste), selected, chequeLabel, enAttente,
        rowStyle: `display:grid;grid-template-columns:90px 1fr 90px 90px 90px 190px;gap:8px;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;${selected ? `background:${soft};border:1px solid ${this.hexToRgba(accent, 0.35)}` : 'border:1px solid transparent'}`,
        onSelect: () => this.selectPaiementAchat({ ref: r.ref, partner: r.partner }) };
    });
    const paiementEmpty = impayesAchats.length === 0;
    // Facture sélectionnée : source de vérité pour la détection du moyen de paiement (colonne Chèque).
    const selOp = ops.find(r => r.type === 'Achat' && r.ref === pmd.ref);
    const selChequeKind = selOp ? this._chequeKind(selOp.chq) : 'vide';
    const selReste = selOp ? (selOp.reste != null ? selOp.reste : Math.abs(selOp.amt)) : 0;
    const paiementLocked = selChequeKind !== 'vide';
    const paiementFree = !paiementLocked;
    const paiementShowChqActions = selChequeKind === 'cheque_num';
    const paiementShowVirementActions = selChequeKind === 'virement_bb';
    const paiementShowTexte = selChequeKind === 'texte';
    const paiementShowEditRaw = paiementShowVirementActions || paiementShowTexte;
    const paiementChequeRaw = selOp ? String(selOp.chq || '') : '';
    const paiementSelectedLabel = pmd.ref ? `${pmd.ref} — ${pmd.pecheur}` : 'Aucune facture sélectionnée';
    // ─ Fiche détail : informations ─
    const paiementSelRef = pmd.ref || '—';
    const paiementSelPecheur = pmd.pecheur || '—';
    const paiementSelMontantTotal = this.fmt(selOp ? Math.abs(selOp.amt) : 0);
    const paiementSelPaye = this.fmt(selOp ? (selOp.paid || 0) : 0);
    const paiementSelSolde = this.fmt(selReste);
    // ─ Fiche détail : moyen de paiement — une ligne par chèque (item 10), montant et statut lus
    // RÉELLEMENT dans le chéquier (colonnes MONTANT et PAIEMENT), pas déduits du solde de la facture.
    const chqLiveStatus = this.state.chqLiveStatus;
    const chqLive = (chqLiveStatus && chqLiveStatus.ref === pmd.ref) ? chqLiveStatus : null;
    const chqActionActiveStyle = 'flex-shrink:0;border:1px solid #cfe8d8;background:#eaf7ef;color:#15803d;padding:6px 12px;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit';
    const chqActionGreyStyle = 'flex-shrink:0;border:1px solid #e9edf4;background:#f4f6f9;color:#b6bfcc;padding:6px 12px;border-radius:9px;font-size:12px;font-weight:700;cursor:not-allowed;font-family:inherit';
    const chqAnnulActiveStyle = 'flex-shrink:0;border:1px solid #ecc9c9;background:#fdeaea;color:#b91c1c;padding:6px 12px;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit';
    const paiementChqList = paiementShowChqActions ? (chqLive ? chqLive.cheques : []).map(c => {
      const statut = c.introuvable ? 'Introuvable' : (c.encaisse ? 'Encaissé' : 'Non encaissé');
      const statutStyle = c.introuvable ? 'color:#93a1b3;font-weight:700' : c.encaisse ? `color:${green};font-weight:700` : 'color:#b45309;font-weight:700';
      return {
        num: c.num, montant: c.montant != null ? this.fmt(c.montant) : '—', statut, statutStyle,
        showActions: !c.introuvable,
        encaisseStyle: c.encaisse ? chqActionGreyStyle : chqActionActiveStyle,
        annulerStyle: c.encaisse ? chqActionGreyStyle : chqAnnulActiveStyle,
        onEncaisse: c.encaisse ? () => {} : () => this.requestChequeEncaissePreview(pmd.ref, c.num),
        onAnnuler: c.encaisse ? () => {} : () => this.askChequeAnnule(pmd.ref, c.num),
      };
    }) : [];
    const paiementChqListLoading = paiementShowChqActions && !chqLive;
    const onChqVirementConfirm = () => this.requestVirementConfirmPreview(pmd.ref);
    const lockedBtnStyle = 'flex:1;min-width:100px;padding:10px 14px;border-radius:9px;font-size:13px;font-weight:600;color:#b6bfcc;background:#f4f6f9;border:1px solid #e9edf4;cursor:not-allowed;font-family:inherit';
    const paiementModeOpts = [{ k: 'cheque', lbl: 'Chèque' }, { k: 'virement', lbl: 'Virement' }, { k: 'liquide', lbl: 'Espèces' }, { k: 'autre', lbl: 'Autre' }, { k: 'comptant', lbl: 'Comptant' }, { k: 'partiel', lbl: 'Partiel' }].map(m => ({ name: m.lbl, onClick: paiementLocked ? () => {} : () => this.setPaiementField('mode', m.k), style: paiementLocked ? lockedBtnStyle : (pmd.mode === m.k ? `flex:1;min-width:100px;padding:10px 14px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:#0f766e;border:none;cursor:pointer;font-family:inherit` : `flex:1;min-width:100px;padding:10px 14px;border-radius:9px;font-size:13px;font-weight:600;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit`) }));
    const paiementIsPartiel = !paiementLocked && pmd.mode === 'partiel'; const paiementIsCheque = !paiementLocked && pmd.mode === 'cheque'; const paiementIsAutre = !paiementLocked && pmd.mode === 'autre'; const paiementIsComptant = !paiementLocked && pmd.mode === 'comptant';
    const paiementComptantSolde = this.fmt(selReste);
    const paiementChqEditing = !!(chqEditDraft && chqEditDraft.ref === pmd.ref);
    const paiementChqEditVal = paiementChqEditing ? (chqEditDraft.val || '') : '';
    // ✏️ Modifier : uniquement pour virement (BB) ou texte libre — un ou plusieurs vrais numéros
    // de chèque se gèrent désormais ligne par ligne (Encaisser/Annuler ci-dessus), plus par édition
    // de texte brut.
    const onChqEditOpen = () => this.openChqEdit(pmd.ref, selOp ? selOp.chq : '');
    const onChqEditVal = e => this.setChqEditVal(e.target.value);
    const onChqEditCancel = () => this.cancelChqEdit();
    const onChqEditCommit = () => this.commitChqEdit();
    // ─ Ajouter un moyen de paiement (item 9 — toujours disponible, encaissé ou non) ─
    const chqAddOpen = !!(chqAddDraftState && chqAddDraftState.ref === pmd.ref);
    const chqAddDraft = chqAddOpen ? chqAddDraftState : this.chqAddDefault();
    const onChqAddOpen = () => this.openChqAdd(pmd.ref);
    const onChqAddCancel = () => this.cancelChqAdd();
    const onChqAddCommit = () => this.commitChqAdd();
    const chqAddModeOpts = [{ k: 'cheque', lbl: 'Chèque' }, { k: 'virement', lbl: 'Virement' }, { k: 'liquide', lbl: 'Espèces' }, { k: 'autre', lbl: 'Autre' }].map(m => ({ name: m.lbl, onClick: () => this.setChqAddField('mode', m.k), style: chqAddDraft.mode === m.k ? `padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:#0f766e;border:none;cursor:pointer;font-family:inherit` : `padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:600;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit` }));
    const chqAddIsCheque = chqAddDraft.mode === 'cheque'; const chqAddIsAutre = chqAddDraft.mode === 'autre'; const chqAddNotCheque = !chqAddIsCheque;
    const onChqAddChequier = e => this.setChqAddField('chequier', e.target.value);
    const onChqAddChequeNum = e => this.setChqAddField('chequeNum', e.target.value);
    const onChqAddMontant = e => this.setChqAddField('montant', e.target.value);
    const onChqAddObservation = e => this.setChqAddField('observation', e.target.value);
    // ─ Modales d'annulation du chèque ─
    const chqAnnuleAskOpen = !!chqAnnuleConfirm;
    const chqAnnuleAskText = chqAnnuleConfirm ? `Confirmer l'annulation du chèque n°${chqAnnuleConfirm.chequeNum} ?` : '';
    const onChqAnnuleAskCancel = () => this.cancelChequeAnnuleAsk();
    const onChqAnnuleAskConfirm = () => this.confirmChequeAnnuleAsk();
    const chqReplaceAskOpen = !!chqAnnuleReplaceAsk;
    const onChqReplaceNo = () => this.dismissChqReplaceAsk(false);
    const onChqReplaceYes = () => this.dismissChqReplaceAsk(true);
    const onPaiementMontant = e => this.setPaiementField('montant', e.target.value);
    const onPaiementChequier = e => this.setPaiementField('chequier', e.target.value);
    const onPaiementChequeNum = e => this.setPaiementField('chequeNum', e.target.value);
    const onPaiementObservation = e => this.setPaiementField('observation', e.target.value);
    const onPaiementCommit = () => this.requestAchatPaiementPreview();
    const onPaiementReset = () => this.setState({ paiementDraft: null, chqEditDraft: null, chqAddDraft: null, chqLiveStatus: null });
    // confirmation « écrit dans… »
    const cf = this.state.compFan; const compFanShow = !!cf; const compFanBuy = !!(cf && cf.mode === 'achat'); const compFanTitle = cf ? cf.title : ''; const compFanCards = cf ? cf.cards : [];
    const compFanStyle = `border-radius:14px;padding:14px 18px;margin-bottom:16px;border:1px solid ${compFanBuy ? '#f0d9b8' : '#cadcfa'};background:${compFanBuy ? '#fdf6ec' : '#eef4fe'}`;
    // ---- transactions unifiées (lignes) → panneaux ----
    const CTX = [];
    asRows0.forEach(a => (a.lignes || []).forEach(l => CTX.push({ type: 'achat', qui: a.pecheur, esp: l.espece, cal: l.calibre, poids: +l.poids || 0, prix: +l.prixKg || 0, id: a.id, date: a.date, pay: { mode: a.paiement, chequier: a.chequier, num: a.chequeNum } })));
    vsRows0.forEach(v => (v.lignes || []).forEach(l => CTX.push({ type: 'vente', qui: v.client, esp: l.espece, cal: l.calibre, poids: +l.poids || 0, prix: +l.prixKg || 0, id: v.id, date: v.date, inv: { num: v.num, ttc: v.ttc, grenke: v.grenke } })));
    let achKg = 0, achE = 0, venKg = 0, venE = 0;
    CTX.forEach(t => { const m = t.poids * t.prix; if (t.type === 'achat') { achKg += t.poids; achE += m; } else { venKg += t.poids; venE += m; } });
    const compBen = Math.round((venE - achE) * 100) / 100, compStockKg = Math.round((achKg - venKg) * 10) / 10;
    const compKpis = [
      { cls: '#b45309', l: 'Acheté aux pêcheurs', v: this.fmt(achE), x: kgN(achKg), vcolor: '#0e1b2e' },
      { cls: accent, l: 'Vendu aux clients', v: this.fmt(venE), x: kgN(venKg), vcolor: '#0e1b2e' },
      { cls: compBen >= 0 ? green : '#b91c1c', l: 'Bénéfice', v: this.fmt(compBen), x: compBen >= 0 ? 'marge positive' : 'perte', vcolor: compBen >= 0 ? green : '#b91c1c' },
      { cls: '#6d28d9', l: 'Stock restant', v: kgN(compStockKg < 0 ? 0 : compStockKg), x: 'à écouler', vcolor: '#0e1b2e' },
    ];
    // stock actuel (espèce × calibre)
    const stkMap = {};
    CTX.forEach(t => { const e = stkMap[t.esp] || (stkMap[t.esp] = {}); const c = e[t.cal] || (e[t.cal] = { in: 0, out: 0, vin: 0 }); if (t.type === 'achat') { c.in += t.poids; c.vin += t.poids * t.prix; } else c.out += t.poids; });
    const compStockGroups = Object.keys(stkMap).map(esp => { const col = Component.ESP_PAL[esp] || '#475569'; return {
      esp, color: col, rows: Object.keys(stkMap[esp]).map(cal => { const c = stkMap[esp][cal]; const stk = Math.round((c.in - c.out) * 10) / 10; const pm = c.in ? c.vin / c.in : 0;
        return { cal, entre: c.in.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), sorti: c.out.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), stock: stk.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), stockColor: stk > 0 ? col : '#9aa7b8', valeur: this.fmt(stk * pm) }; }) }; });
    const compStockEmpty = compStockGroups.length === 0;
    // journal des mouvements
    const compJournal = CTX.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).slice(0, 16).map(t => { const buy = t.type === 'achat'; const tot = t.poids * t.prix;
      let pill = ''; if (buy && t.pay) { const PM = Component.PAYMODES[t.pay.mode] || { ic: '', lbl: t.pay.mode }; pill = `${PM.ic} ${t.pay.mode === 'cheque' ? 'chq ' + (t.pay.num || '') : PM.lbl}`; } else if (!buy && t.inv) { pill = `📄 ${t.inv.num || ''}${t.inv.grenke ? ' · 🏦' : ''}`; }
      return { tag: buy ? 'ACHAT' : 'VENTE', tagStyle: buy ? `font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:#fdf1e3;color:#b45309` : `font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:${soft};color:${accent}`, qui: t.qui, pill, det: `${t.esp} ${t.cal} · ${kgN(t.poids)} @ ${this.fmt(t.prix)}/kg`, amt: (buy ? '−' : '+') + this.fmt(tot), amtColor: buy ? '#b45309' : accent }; });
    const compJournalEmpty = CTX.length === 0; const compJcount = CTX.length + ' mouv.';
    // stats moyens de paiement
    const payTot = { virement: 0, cheque: 0, liquide: 0 };
    asRows0.forEach(a => { const mode = a.paiement || 'virement'; if (payTot[mode] == null) payTot[mode] = 0; payTot[mode] += (+a.total || 0); });
    const paySum = (payTot.virement + payTot.cheque + payTot.liquide) || 1;
    const compStatPay = ['virement', 'cheque', 'liquide'].map(k => { const PM = Component.PAYMODES[k]; const v = payTot[k] || 0; const p = v / paySum * 100; return { label: `${PM.ic} ${PM.lbl}`, val: `${this.fmt(v)} · ${Math.round(p)}%`, pct: Math.max(0, p) + '%', col: PM.col }; });
    // top pêcheurs
    const byPech = {}; asRows0.forEach(a => { byPech[a.pecheur] = (byPech[a.pecheur] || 0) + (+a.total || 0); });
    const pechArr = Object.entries(byPech).sort((a, b) => b[1] - a[1]); const pechMax = pechArr.length ? pechArr[0][1] : 1;
    const compStatPech = pechArr.slice(0, 6).map(([n, v]) => ({ name: n, val: this.fmt(v), pct: (v / pechMax * 100) + '%' }));
    const compStatPechEmpty = pechArr.length === 0;
    // chéquiers — lus automatiquement depuis les onglets du fichier operations (nom + prochain numéro).
    const compChqBody = this.chequierRows().map(c => ({ nom: c.nom, next: String(c.next || '') }));
    const compChqEmpty = this.chequierRows().length === 0;
    // suggestions
    const pecheurSuggest = [...new Set([...asRows0.map(r => r.pecheur), ...ops.filter(o => o.type === 'Achat').map(o => o.partner)].filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'fr')).slice(0, 60).map(n => ({ name: n }));
    const clientSuggest = [...new Set([...vsRows0.map(r => r.client), ...ptRows0.map(r => r.client)].filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'fr')).slice(0, 60).map(n => ({ name: n }));

    // ---- Formulaire ACHAT pêcheur ----
    const ad = this.state.achatDraft || this.achatDefault();
    const adLignes = (ad.lignes && ad.lignes.length ? ad.lignes : [this.compEmptyLigne()]);
    const achatDraftLignes = adLignes.map((l, i) => { const poids = this._vNum(l.poids), prix = this._vNum(l.prixKg); return {
      espece: l.espece || espKeys[0], calibre: l.calibre || '', especeOptions: espOptsAll, calibreOptions: calOptsOf(l.espece),
      poids: l.poids === 0 ? '0' : (l.poids || ''), prixKg: l.prixKg === 0 ? '0' : (l.prixKg || ''), montant: this.fmt(Math.round(poids * prix * 100) / 100),
      onEspece: e => this.setAchatLigne(i, 'espece', e.target.value), onCalibre: e => this.setAchatLigne(i, 'calibre', e.target.value),
      onPoids: e => this.setAchatLigne(i, 'poids', e.target.value), onPrix: e => this.setAchatLigne(i, 'prixKg', e.target.value), onRemove: () => this.removeAchatLigne(i) }; });
    const achatDraftTotal = this.fmt(Math.round(adLignes.reduce((s, l) => s + this._vNum(l.poids) * this._vNum(l.prixKg), 0) * 100) / 100);
    const achatDraft = { id: ad.id, num: ad.num || '', pecheur: ad.pecheur || '', date: ad.date || '', chequeNum: ad.chequeNum || '', chequier: ad.chequier || '', observation: ad.observation || '' };
    const achatPaiementImmediat = !!ad.paiementImmediat;
    const onAchatImmediatToggle = () => this.setAchatField('paiementImmediat', !ad.paiementImmediat);
    const achatNumHint = (ad.numFromFile && ad.num) ? `✓ prochaine facture du fichier${ad.numRow ? ' · ligne ' + ad.numRow : ''}` : '';
    const achatEditing = !!(this.state.achatDraft && this.state.achatDraft.editing);
    const onAchatNum = e => this.setAchatField('num', e.target.value);
    const onAchatPecheur = e => this.setAchatField('pecheur', e.target.value);
    const onAchatDate = e => this.setAchatField('date', e.target.value);
    const onAchatAddLigne = () => this.addAchatLigne();
    const onAchatCommit = () => this.commitAchatSaisie();
    const onAchatReset = () => this.resetAchatDraft();
    const achatSaveLabel = achatEditing ? "Enregistrer les modifications" : "Enregistrer l'achat";
    const compPayModes = ['virement', 'cheque', 'liquide', 'autre'].map(k => { const PM = Component.PAYMODES[k]; const on = (ad.paiement || 'virement') === k; return { name: `${PM.ic} ${PM.lbl}`, onClick: () => this.setAchatField('paiement', k), style: on ? `padding:9px 16px;border-radius:9px;font-size:12.5px;font-weight:600;color:#fff;background:#b45309;border:1px solid #b45309;cursor:pointer;font-family:inherit` : `padding:9px 16px;border-radius:9px;font-size:12.5px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit` }; });
    const achatIsCheque = (ad.paiement || 'virement') === 'cheque';
    const achatIsAutre = (ad.paiement || 'virement') === 'autre';
    const onAchatObservation = e => this.setAchatField('observation', e.target.value);
    const onAchatChequier = e => this.setAchatField('chequier', e.target.value);
    const onAchatChequeNum = e => this.setAchatField('chequeNum', e.target.value);
    const chequierOptions = this.chequierRows().length ? this.chequierRows().map(c => ({ value: c.nom, label: `${c.nom} — prochain n°${c.next}` })) : [{ value: '', label: '— aucun chéquier détecté dans le fichier —' }];
    const achatChqHint = (() => { const cq = this.chequierRows().find(c => c.nom === ad.chequier) || this.chequierRows()[0]; return cq ? `Prochain chèque du « ${cq.nom} » : n°${cq.next}. Le n° se remplira sur la feuille chéquier.` : 'Aucun onglet chéquier détecté (nom 100% numérique attendu, ex. « 516000 »).'; })();
    // ---- Formulaire VENTE client (facture) ----
    const vd = this.state.venteDraft || this.venteDefault();
    const vdLignes = (vd.lignes && vd.lignes.length ? vd.lignes : [this.compEmptyLigne()]);
    const venteDraftLignes = vdLignes.map((l, i) => { const poids = this._vNum(l.poids), prix = this._vNum(l.prixKg); return {
      espece: l.espece || espKeys[0], calibre: l.calibre || '', especeOptions: espOptsAll, calibreOptions: calOptsOf(l.espece),
      poids: l.poids === 0 ? '0' : (l.poids || ''), prixKg: l.prixKg === 0 ? '0' : (l.prixKg || ''), montant: this.fmt(Math.round(poids * prix * 100) / 100),
      onEspece: e => this.setVenteLigne(i, 'espece', e.target.value), onCalibre: e => this.setVenteLigne(i, 'calibre', e.target.value),
      onPoids: e => this.setVenteLigne(i, 'poids', e.target.value), onPrix: e => this.setVenteLigne(i, 'prixKg', e.target.value), onRemove: () => this.removeVenteLigne(i) }; });
    const vHt = Math.round(vdLignes.reduce((s, l) => s + this._vNum(l.poids) * this._vNum(l.prixKg), 0) * 100) / 100;
    const vTvaIrl = this._vNum(vd.tvaIrl), vTvaFr = this._vNum(vd.tvaFr);
    const vTtc = Math.round((vHt + vTvaIrl + vTvaFr) * 100) / 100;
    const vDelaiN = Math.max(0, Math.min(30, Math.round(this._vNum(vd.delai))));
    const vPrevIso = vd.datePrev || this._addDaysIso(vd.date, vDelaiN);
    const venteDraft = { id: vd.id, num: vd.num || '', client: vd.client || '', date: vd.date || '', delai: String(vDelaiN), datePrev: vPrevIso ? ptFrDate(vPrevIso) : '—', tvaIrl: vd.tvaIrl === 0 ? '' : (vd.tvaIrl || ''), tvaFr: vd.tvaFr === 0 ? '' : (vd.tvaFr || ''), avoir: vd.avoir === 0 ? '' : (vd.avoir || '') };
    const venteAvoirActif = !!vd.avoirActif;
    const venteNumHint = (vd.numFromFile && vd.num) ? `✓ prochaine facture du fichier${vd.numRow ? ' · ligne ' + vd.numRow : ''}` : '';
    const venteNumHintStyle = 'font-size:10.5px;font-weight:600;color:#0e7a46;text-transform:none;letter-spacing:0;margin-left:8px';
    const venteDraftHt = this.fmt(vHt); const venteDraftTtc = this.fmt(vTtc);
    const venteEditing = !!(this.state.venteDraft && this.state.venteDraft.editing);
    const onVSNum = e => this.setVenteField('num', e.target.value);
    const onVSClient = e => this.setVenteField('client', e.target.value);
    const onVSDate = e => this.setVenteField('date', e.target.value);
    const onVSDelai = e => this.setVenteField('delai', e.target.value);
    const onVSTvaIrl = e => this.setVenteField('tvaIrl', e.target.value);
    const onVSTvaFr = e => this.setVenteField('tvaFr', e.target.value);
    const onVSAvoirToggle = () => this.setVenteField('avoirActif', !venteAvoirActif);
    const onVSAvoir = e => this.setVenteField('avoir', e.target.value);
    const onVSCommit = () => this.commitVenteSaisie();
    const onVSReset = () => this.resetVenteDraft();
    const onVenteAddLigne = () => this.addVenteLigne();
    const vsSaveLabel = venteEditing ? 'Enregistrer les modifications' : 'Enregistrer la vente';
    const venteDelaiOptions = Array.from({ length: 31 }, (_, i) => ({ value: String(i), label: i + ' j' }));
    const venteGrenkeSet = !!(vd.grenke && this._vNum(vd.grenke.montant) > 0);
    const venteGrenkeBtnLabel = venteGrenkeSet ? `Grenke : ${this.fmt(vd.grenke.montant)} ✓` : 'Financement Grenke ▸';
    const venteGrenkeBtnStyle = `width:100%;border:1px ${venteGrenkeSet ? 'solid' : 'dashed'} ${venteGrenkeSet ? this.hexToRgba(accent, 0.5) : '#dde3ec'};background:${venteGrenkeSet ? soft : '#fff'};color:${accent};padding:9px 11px;border-radius:9px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit`;
    const onVenteGrenkeOpen = () => this.openVenteGrenke();
    // modale GRENKE
    const vg = this.state.venteGrenke; const venteGrenkeOpen = !!vg;
    const vgMontant = vg ? (vg.montant || '') : ''; const vgP1 = vg ? (vg.p1 || '') : ''; const vgP2 = vg ? (vg.p2 || '') : ''; const vgCharges = vg ? (vg.charges || '') : '';
    const vgRest = this.fmt(vg ? Math.round((this._vNum(vg.montant) - this._vNum(vg.p1) - this._vNum(vg.p2) - this._vNum(vg.charges)) * 100) / 100 : 0);
    const onVgMontant = e => this.setVenteGrenkeField('montant', e.target.value);
    const onVgP1 = e => this.setVenteGrenkeField('p1', e.target.value);
    const onVgP2 = e => this.setVenteGrenkeField('p2', e.target.value);
    const onVgCharges = e => this.setVenteGrenkeField('charges', e.target.value);
    const onVgSave = () => this.saveVenteGrenke(); const onVgCancel = () => this.closeVenteGrenke();

    // ---- Enregistrement des paiements Grenke (manuel, structure feuille « Grenke ») ----
    const gmRows0 = this.grenkeManRows();
    const gmStatutStyle = st => { const s = String(st || '').toLowerCase(); if (s.includes('sold') || s.includes('clot') || s.includes('termin') || s.includes('pay')) return `${badge}background:#e7f5ec;color:${green}`; if (s.includes('retard')) return `${badge}background:#fdeaea;color:${red}`; if (s.includes('partiel')) return `${badge}background:#fff7df;color:#9a6700`; return `${badge}background:${soft};color:${accent}`; };
    const gmList = gmRows0.map(r => { const rem = Math.round(((+r.ttc || 0) - (+r.p1 || 0) - (+r.p2 || 0) - (+r.charge || 0)) * 100) / 100; const recv = Math.round(((+r.p1 || 0) + (+r.p2 || 0)) * 100) / 100; return {
      id: r.id, num: r.num || '—', cust: r.cust, ttc: this.fmt(+r.ttc || 0),
      p1: r.p1 ? this.fmt(+r.p1) : '—', p2: r.p2 ? this.fmt(+r.p2) : '—',
      rem: this.fmt(rem), remColor: rem <= 0.005 ? green : '#b45309', charge: r.charge ? this.fmt(+r.charge) : '—',
      recv: this.fmt(recv), statut: r.statut || 'En cours', statutStyle: gmStatutStyle(r.statut),
      com: r.com || '—', srcBadge: r.fromVente ? 'auto' : '',
      onEdit: () => this.editGrkRow(r.id), onDelete: () => this.askDeleteGrk(r.id),
    }; });
    const gmRecvTot = sum(gmRows0, r => (+r.p1 || 0) + (+r.p2 || 0));
    const gmRemTot = sum(gmRows0, r => Math.max(0, (+r.ttc || 0) - (+r.p1 || 0) - (+r.p2 || 0) - (+r.charge || 0)));
    const gmSummary = [
      card('Dossiers Grenke', String(gmRows0.length), '#6d28d9', 'paiements enregistrés', '#6d28d9'),
      card('Total reçu', this.fmt(gmRecvTot), green, '1er + 2e paiement', green),
      card('Restant dû', this.fmt(gmRemTot), gmRemTot > 0 ? amber : green, 'TTC − paiements − charges', amber),
    ];
    const gd = this.state.grkDraft || this.grkDefault();
    const gTtc = this._vNum(gd.ttc), gP1 = this._vNum(gd.p1), gP2 = this._vNum(gd.p2), gCh = this._vNum(gd.charge);
    const grkDraft = { id: gd.id, num: gd.num || '', cust: gd.cust || '', ttc: gd.ttc === 0 ? '0' : (gd.ttc || ''),
      p1: gd.p1 === 0 ? '' : (gd.p1 || ''), p2: gd.p2 === 0 ? '' : (gd.p2 || ''), charge: gd.charge === 0 ? '' : (gd.charge || ''),
      statut: gd.statut || 'En cours', com: gd.com || '' };
    const grkDraftRem = this.fmt(Math.round((gTtc - gP1 - gP2 - gCh) * 100) / 100);
    const grkDraftRecv = this.fmt(Math.round((gP1 + gP2) * 100) / 100);
    const grkStatutOptions = ['En cours', 'Partiel', 'Soldé', 'En retard'].map(s => ({ value: s, label: s }));
    const grkEditing = !!(this.state.grkDraft && this.state.grkDraft.editing);
    const onGrkNum = e => this.setGrkField('num', e.target.value);
    const onGrkCust = e => this.setGrkField('cust', e.target.value);
    const onGrkTtc = e => this.setGrkField('ttc', e.target.value);
    const onGrkP1 = e => this.setGrkField('p1', e.target.value);
    const onGrkP2 = e => this.setGrkField('p2', e.target.value);
    const onGrkCharge = e => this.setGrkField('charge', e.target.value);
    const onGrkStatut = e => this.setGrkField('statut', e.target.value);
    const onGrkCom = e => this.setGrkField('com', e.target.value);
    const onGrkCommit = () => this.commitGrk();
    const onGrkReset = () => this.resetGrkDraft();
    const grkSaveLabel = grkEditing ? 'Mettre à jour' : '＋ Enregistrer le paiement';
    const gmEmpty = gmRows0.length === 0;
    const gmDelAsk = this.state.grkDelAsk;
    const gmDelOpen = !!gmDelAsk;
    const gmDelName = gmDelAsk ? `${gmDelAsk.cust} — ${this.fmt(+gmDelAsk.ttc || 0)}` : '';
    const onGrkDelConfirm = () => this.deleteGrkRow();
    const onGrkDelCancel = () => this.setState({ grkDelAsk: null });

    // crédits — les virements bancaires rattachés (rapprochement Banque → « Crédit ») réduisent le restant.
    const bankRowsForCred = this.state.banque || (demo ? C.BANQUE.map(a => ({ y: a[0], m: a[1], d: a[2], label: a[3], amt: a[4] })) : []);
    const bankLinksForCred = this.state.bankLinks || {};
    const credBankPaid = {}; // 'label — ent' -> { sum, count, dates:[] }
    bankRowsForCred.forEach(b => { const lk = bankLinksForCred[this.bankKey(b)]; if (lk && typeof lk === 'object' && lk.kind === 'Crédit' && lk.partner) { const e = credBankPaid[lk.partner] || (credBankPaid[lk.partner] = { sum: 0, count: 0, dates: [] }); e.sum += Math.abs(b.amt || 0); e.count++; e.dates.push(`${this.dd(b.d)}/${this.dd(b.m)}`); } });
    const credPartnerKey = c => `${c.label}${c.ent ? ' — ' + c.ent : ''}`;
    const credits = (this.state.credits || (demo ? C.CREDITS : [])).map(c => {
      const resteBase = (c.rest != null ? c.rest : c.total - c.paid);
      const bank = credBankPaid[credPartnerKey(c)] || { sum: 0, count: 0, dates: [] };
      const reste = Math.max(0, Math.round((resteBase - bank.sum) * 100) / 100);
      const paidEff = Math.max(0, (c.total || 0) - reste);
      return { ...c, resteBase, bankPaid: bank.sum, bankCount: bank.count, bankDates: bank.dates, paidEff, reste, pct: c.total ? paidEff / c.total * 100 : 0 };
    });
    const capitalDu = sum(credits, c => c.reste), mensTot = sum(credits, c => c.mens);
    const nd = credits.length ? this.pIso(credits.map(c => c.next).sort()[0]) : { d: 0, m: 0 };

    // ---- COMPTE RENDU (rapport imprimable de la période sélectionnée) ----
    const REPORT_SECTIONS = [
      { key: 'synthese', label: 'Synthèse (indicateurs clés)', desc: 'CA, achats, marge brute…' },
      { key: 'tresorerie', label: 'Trésorerie', desc: 'solde compte, à encaisser, à régler' },
      { key: 'relances', label: 'Relances clients', desc: 'factures clients à encaisser' },
      { key: 'fournisseurs', label: 'Échéances fournisseurs', desc: 'factures à régler' },
      { key: 'credits', label: 'Crédits & assurances', desc: 'mensualités et capital restant' },
      { key: 'notes', label: 'Notes libres', desc: 'commentaire ajouté au compte rendu' },
    ];
    const reportOptsDef = { synthese: true, tresorerie: true, relances: true, fournisseurs: true, credits: false, notes: true };
    const reportOptsCur = { ...reportOptsDef, ...(this.state.reportOpts || {}) };
    const reportSections = REPORT_SECTIONS.map(s => ({ key: s.key, label: s.label, desc: s.desc, checked: !!reportOptsCur[s.key], onToggle: () => { const cur = { ...reportOptsDef, ...(this.state.reportOpts || {}) }; cur[s.key] = !cur[s.key]; this.setState({ reportOpts: cur }); } }));
    const reportNote = this.state.reportNote || '';
    const onReportNote = e => this.setState({ reportNote: e.target.value });
    const reportStop = e => e.stopPropagation();
    const savedHeader = (() => { try { return localStorage.getItem('avReportHeader'); } catch (_) { return null; } })();
    const reportHeader = this.state.reportHeader != null ? this.state.reportHeader : (savedHeader || '');
    const reportHeaderSave = this.state.reportHeaderSave != null ? this.state.reportHeaderSave : !!savedHeader;
    const onReportHeader = e => { const v = e.target.value; this.setState({ reportHeader: v }); const on = this.state.reportHeaderSave != null ? this.state.reportHeaderSave : !!savedHeader; if (on) { try { localStorage.setItem('avReportHeader', v); } catch (_) {} } };
    const onToggleSaveHeader = () => { const cur = this.state.reportHeaderSave != null ? this.state.reportHeaderSave : !!savedHeader; const next = !cur; const val = this.state.reportHeader != null ? this.state.reportHeader : (savedHeader || ''); this.setState({ reportHeaderSave: next }); try { if (next) localStorage.setItem('avReportHeader', val); else localStorage.removeItem('avReportHeader'); } catch (_) {} };
    this._reportData = {
      periodLabel, header: (reportHeader || '').trim(),
      kpis: kpis.map(k => ({ label: k.label, value: k.value, note: k.note || '' })),
      tresoNette: this.fmt(tresoNette), onMeDoit: this.fmt(onMeDoit), jeDois: this.fmt(jeDois),
      soldeCompte: soldeBanqueKnown ? this.fmt(soldeBanqueNum) : null, soldeSource: soldeBanqueSource,
      relance: relanceRows.map(r => ({ partner: r.partner, ref: r.ref, due: r.due, delai: r.delaiTxt, reste: r.reste, statut: r.flag })),
      relanceTotal: this.fmt(sum(clientsDue, f => f.reste)),
      fourn: fournOpen.slice().sort((a, b) => this.days(a.dueO) - this.days(b.dueO)).map(f => ({ partner: f.partner, ref: f.ref, due: `${this.dd(f.dueO.d)}/${this.dd(f.dueO.m)}/${f.dueO.y}`, reste: this.fmt(f.reste) })),
      fournTotal: this.fmt(jeDois),
      credits: credits.map(c => ({ label: c.label, ent: c.ent || '', mens: this.fmt(c.mens), reste: this.fmt(c.reste) })),
      mensTot: this.fmt(mensTot), capitalDu: this.fmt(capitalDu),
    };
    // Instantané numérique de la période courante — sert à l'export de suivi (tableau Excel cumulé).
    const suiviStockValo = (() => { const st = this.state.stock || (demo ? C.STOCK : []); return st[0] ? (+st[0].valo || 0) : 0; })();
    const r2 = n => Math.round((+n || 0) * 100) / 100;
    this._suiviData = {
      periodType: this.state.period, periodLabel, periodSort: periodSort || periodLabel,
      ca: r2(S.ca), achats: r2(S.ach), marge: r2(S.marge), taux: r2(S.taux),
      nbV: S.nbV, nbA: S.nbA, stockValo: r2(suiviStockValo),
      treso: r2(tresoNette), onMeDoit: r2(onMeDoit), jeDois: r2(jeDois),
      enRetard: r2(enRelance), mensualites: r2(mensNow), capitalDu: r2(capitalDu),
    };
    const reportOpen = !!this.state.reportOpen;
    const onOpenReport = () => this.setState({ reportOpen: true });
    const onCloseReport = () => this.setState({ reportOpen: false });
    const onGenerateReport = () => this.generateReport();
    const onSaveReport = () => this.saveReport();
    const reportGhostStyle = `padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;
    const reportBtnStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit`;
    const showReport = isDash;
    const reportNotesOn = !!reportOptsCur.notes;
    const creditSummary = [card('Capital restant dû', this.fmt(capitalDu), '#0e1b2e', `${credits.length} engagements`, accent), card('Mensualités', this.fmt(mensTot), '#0e1b2e', 'total par mois', accent), card('Prochaine échéance', credits.length ? `${this.dd(nd.d)}/${this.dd(nd.m)}` : '—', '#0e1b2e', 'crédit/assurance', amber)];
    const creditsEmpty = credits.length === 0;
    const credPayStyle = on => `padding:6px 11px;border-radius:8px;font-size:11.5px;font-weight:700;color:#fff;background:${on ? green : '#c5cede'};border:none;cursor:${on ? 'pointer' : 'default'};font-family:inherit;white-space:nowrap`;
    const credEditBtnStyle = `padding:6px 11px;border-radius:8px;font-size:11.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`;
    const creditRows = credits.map((c, i) => ({ label: c.label, ent: c.ent || '—', typeLabel: c.type, typeStyle: c.type === 'Assurance' ? `${badge}background:#eef1f5;color:${slate}` : `${badge}background:${soft};color:${accent}`, mens: this.fmt(c.mens), pct: this.pctStr(c.pct), barColor: accent, paidLabel: `${this.fmt(c.paidEff)} / ${this.fmt(c.total)}`, reste: this.fmt(c.reste), next: c.next ? `${this.dd(this.pIso(c.next).d)}/${this.dd(this.pIso(c.next).m)}` : '—', onPay: () => this.setState({ credPayAsk: { i, label: c.label, mens: c.mens, bankCount: c.bankCount, bankPaid: c.bankPaid, reste: c.reste } }), onEdit: () => this.openCredEdit(i), payStyle: credPayStyle(c.reste > 0), payLabel: c.reste > 0 ? "✓ Régler l'échéance" : 'Soldé', editStyle: credEditBtnStyle,
      bankInfo: c.bankCount > 0 ? `🔗 ${c.bankCount} virement${c.bankCount > 1 ? 's' : ''} rattaché${c.bankCount > 1 ? 's' : ''} · −${this.fmt(c.bankPaid)}` : '', bankInfoShow: c.bankCount > 0, bankInfoStyle: `${badge}background:#e7f5ec;color:${green};margin-top:4px` }));
    // Confirmation du règlement manuel (aucun virement rattaché, ou avertissement si des virements existent).
    const cpa = this.state.credPayAsk;
    const credPayAskOpen = !!cpa;
    const credPayAskLabel = cpa ? cpa.label : '';
    const credPayAskMens = cpa ? this.fmt(cpa.mens) : '';
    const credPayAskHasBank = !!(cpa && cpa.bankCount > 0);
    const credPayAskMsg = cpa ? (cpa.bankCount > 0
      ? `⚠ ${cpa.bankCount} virement(s) bancaire(s) sont déjà rattaché(s) à ce crédit (le restant en tient compte). Un règlement manuel s'ajoutera par-dessus : à n'utiliser que pour une échéance réglée autrement que par ces virements, sinon vous compteriez deux fois.`
      : `Aucun virement bancaire n'est rattaché à ce crédit. Astuce : vous pouvez plutôt rattacher le virement depuis l'onglet Banque (« Lier »), le restant se mettra à jour automatiquement. Confirmez-vous le règlement manuel de cette échéance ?`) : '';
    const onCredPayConfirm = () => { if (cpa) { this.payCredit(cpa.i); this.setState({ credPayAsk: null }); } };
    const onCredPayCancel = () => this.setState({ credPayAsk: null });
    const onCredNew = () => this.openCredNew();
    const credAddStyle = `padding:8px 15px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const ce = this.state.credEdit; const credF = ce || {};
    const credEditOpen = !!ce;
    const credIsEdit = !!(ce && ce.i >= 0);
    const credEditTitle = credIsEdit ? 'Modifier le crédit / l’assurance' : 'Nouveau crédit / assurance';
    const credVals = { label: credF.label || '', ent: credF.ent || '', total: credF.total || '', paid: credF.paid || '', mens: credF.mens || '', next: credF.next || '' };
    const credTypeIsCredit = (credF.type || 'Crédit') !== 'Assurance';
    const credTypeCreditStyle = credTypeIsCredit ? `padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    const credTypeAssurStyle = !credTypeIsCredit ? `padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    const onCredLabel = e => this.setCredField('label', e.target.value);
    const onCredEnt = e => this.setCredField('ent', e.target.value);
    const onCredTotal = e => this.setCredField('total', e.target.value);
    const onCredPaid = e => this.setCredField('paid', e.target.value);
    const onCredMens = e => this.setCredField('mens', e.target.value);
    const onCredNext = e => this.setCredField('next', e.target.value);
    const onCredTypeCredit = () => this.setCredField('type', 'Crédit');
    const onCredTypeAssur = () => this.setCredField('type', 'Assurance');
    const onCredCommit = () => this.commitCred();
    const onCredCancel = () => this.closeCred();
    const onCredDelete = () => this.deleteCred(credF.i);
    const credCommitStyle = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const credDeleteStyle = 'padding:9px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#b91c1c;background:#fff;border:1px solid #f0c9c9;cursor:pointer;font-family:inherit';
    const credInputStyle = 'width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid #dde3ec;border-radius:9px;font-size:13px;font-family:inherit;color:#0e1b2e;background:#fff';
    const credLabelStyle = 'font-size:11px;font-weight:600;color:#93a1b3;text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px;display:block';

    // rapprochement
    const recoKey = this.state.recoKey || 'ref';
    const cmpRows = this.state.comptable;
    let external, recoSource, recoHasExt;
    if (cmpRows && cmpRows.length) { external = cmpRows.map(r => { const o = r.d ? this.pIso(r.d) : null; return { ref: r.ref, partner: r.partner, amount: Math.abs(r.amount || 0), ym: o ? o.y * 12 + o.m - 1 : dataMax }; }); recoSource = `export comptable « ${this.state.comptableName} »`; recoHasExt = true; }
    else if (this.state.ops) { external = this.state.ops.map(r => ({ ref: r.ref, partner: r.partner, amount: Math.abs(r.amt), ym: r.y * 12 + r.m - 1 })); recoSource = `export importé « ${this.state.opsName} »`; recoHasExt = true; }
    else if (demo) { external = F.map(f => ({ ref: f.ref, partner: f.partner, amount: f.ttc, ym: f.ym })).filter(e => e.ref !== 'FAC-2021').map(e => e.ref === 'FAC-2025' ? { ...e, amount: e.amount - 100 } : e); external.push({ ref: 'FAC-9002', partner: 'Client Comptoir', amount: 540, ym: F.length ? F[0].ym : dataMax }); recoSource = 'export comptable (démo)'; recoHasExt = true; }
    else { external = []; recoSource = null; recoHasExt = false; }
    const reco = this.reconcile(F.map(f => ({ ref: f.ref, partner: f.partner, ttc: f.ttc, ym: f.ym })), external, recoKey);
    const recoStats = [card('Rapprochés', String(reco.ok), green, 'lignes concordantes', green), card('Écarts de montant', String(reco.ec), amber, 'à vérifier', amber), card('Absents de l’export', String(reco.miss), red, 'dans le registre seul', red), card('Absents du registre', String(reco.extra), red, "dans l'export seul", red)];
    const recoStatusStyle = st => st === 'Rapproché' ? `${badge}background:#e7f5ec;color:${green}` : st === 'Écart montant' ? `${badge}background:#fff4e6;color:${amber}` : `${badge}background:#fdeaea;color:${red}`;
    const recoRows = reco.rows.map(r => ({ ref: r.ref, partner: r.partner, intAmount: r.int == null ? '—' : this.fmt(r.int), extAmount: r.ext == null ? '—' : this.fmt(r.ext), ecart: r.ecart == null ? '—' : (r.ecart > 0 ? '+' : '−') + Math.abs(r.ecart).toLocaleString('fr-FR') + ' €', ecartColor: r.ecart ? amber : gray, statusLabel: r.status, statusStyle: recoStatusStyle(r.status) }));
    const recoNote = recoSource ? `Registre interne ↔ ${recoSource}` : 'Importez votre export comptable dans Paramètres pour lancer le rapprochement.';
    const recoEmpty = !recoHasExt;
    const recoKeyDefs = [['ref', 'N° de facture'], ['montant', 'Montant'], ['pm', 'Partenaire + montant'], ['auto', 'Auto']];
    const recoKeyTabs = recoKeyDefs.map(([k, lbl]) => ({ name: lbl, onClick: () => { this.setState({ recoKey: k }); try { localStorage.setItem(Component.RECOKEY_KEY, k); } catch (e) {} }, style: recoKey === k ? `padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;white-space:nowrap` : 'padding:6px 12px;border-radius:8px;font-size:12px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit;white-space:nowrap' }));
    const recoKeyHint = { ref: 'Comparaison par n° de facture.', montant: 'Comparaison par montant (± 1 €).', pm: 'Comparaison par partenaire + montant.', auto: 'Comparaison auto : n° de facture, sinon partenaire + montant + mois.' }[recoKey];

    // BORDEREAUX
    const blRaw = this.state.bordereaux || (demo ? C.BORDEREAUX : []);
    const blOv = this.state.blOverrides || {};
    const stOf = b => blOv[b.ref] || b.statut;
    const blSelStyle = st => { const c = st === 'Livré' ? green : st === 'En transit' ? accent : st === 'Expédié' ? amber : st === 'En attente' ? red : slate; const bg = st === 'Livré' ? '#e7f5ec' : st === 'En transit' ? soft : st === 'Expédié' ? '#fff4e6' : st === 'En attente' ? '#fdeaea' : '#eef1f5'; return `padding:5px 8px;border-radius:7px;border:1px solid ${this.hexToRgba(c, 0.35)};background:${bg};color:${c};font-size:11.5px;font-weight:600;font-family:inherit;cursor:pointer;max-width:112px`; };
    const blSort = [...blRaw].sort((a, b) => a.d < b.d ? 1 : a.d > b.d ? -1 : 0);
    const blEff = this.state.blStatus;
    const blList = blEff === 'Tous' ? blSort : blSort.filter(b => stOf(b) === blEff);
    const blSelectStyle = 'padding:7px 12px;border:1px solid #e6ebf2;border-radius:10px;font-size:12.5px;font-weight:600;color:#0e1b2e;background:#fff;font-family:inherit;cursor:pointer';
    const onBlStatus = e => this.setState({ blStatus: e.target.value });
    const modelBtnStyle = `padding:7px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;
    const onOpenModel = () => { const m = (this.state.models || {}).bordereaux; if (m) { this.openUrl(m); } else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Renseignez le lien de votre modèle Excel de bordereaux dans Paramètres, puis « Modèle Excel ».' } }); };
    const blCount = `${blList.length} bordereau${blList.length > 1 ? 'x' : ''}`;
    const cnt = st => blSort.filter(b => stOf(b) === st).length;
    const blCards = [card('Total bordereaux', String(blRaw.length), '#0e1b2e', 'enregistrés', accent), card('Livrés', String(cnt('Livré')), green, 'réception confirmée', green), card('En transit', String(cnt('En transit') + cnt('Expédié')), accent, 'expédiés / en cours', accent), card('À traiter', String(cnt('Préparé') + cnt('En attente')), amber, 'préparés / en attente', amber)];
    const blRows = blList.map(b => { const st = stOf(b); return { date: `${this.dd(this.pIso(b.d).d)}/${this.dd(this.pIso(b.d).m)}`, ref: b.ref, dest: b.dest, fac: b.fac, colis: b.colis, transp: b.transp, statut: st, selStyle: blSelStyle(st), onStatut: e => this.setBlStatut(b.ref, e.target.value) }; });

    // BORDEREAUX — bibliothèque de fichiers (livraison + transport)
    const demoBlLib = [
      { name: 'BL-2026-0712.pdf', type: 'Livraison', transporteur: '—' },
      { name: 'BL-2026-0711.pdf', type: 'Livraison', transporteur: '—' },
      { name: 'Chronopost-45890.pdf', type: 'Transport', transporteur: 'Chronopost' },
      { name: 'Heppner-2026-118.pdf', type: 'Transport', transporteur: 'Heppner' },
    ];
    const blLib = this.state.blLibrary || (demo ? demoBlLib : []);
    const iconBl = nm => /\.pdf$/i.test(nm) ? '📕' : /\.(xlsx|xlsm|csv)$/i.test(nm) ? '📊' : /\.(jpe?g|png)$/i.test(nm) ? '🖼️' : '📄';
    const blFilter = this.state.blStatus;
    const blLibFiltered = blLib.filter(f => blFilter === 'Tous' || f.type === blFilter);
    const blLibRows = blLibFiltered.map(f => ({ name: f.name, icon: iconBl(f.name), typeLabel: f.type, typeStyle: f.type === 'Livraison' ? `${badge}background:${soft};color:${accent}` : `${badge}background:#eef1f5;color:${slate}`, transporteur: f.transporteur || '—', btnStyle: `padding:6px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`, onOpen: () => this.openBlFile(f.name) }));
    const blLibCount = `${blLibFiltered.length} fichier${blLibFiltered.length > 1 ? 's' : ''}`;
    const blLibEmpty = blLib.length === 0;
    const blTypeChips = ['Tous', 'Livraison', 'Transport'].map(name => ({ name, onClick: () => this.setState({ blStatus: name }), style: (blFilter === name || (name === 'Tous' && blFilter === 'Tous')) ? `padding:6px 12px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:6px 12px;border-radius:99px;font-size:12px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit' }));

    // ---- Recherche globale (ventes, achats, factures fournisseur, Grenke, bordereaux) ----
    const globalSearchStyle = `width:190px;padding:7px 11px;border:1px solid ${this.hexToRgba(accent, 0.3)};border-radius:9px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:${this.hexToRgba(accent, 0.06)}`;
    const globalQuery = this.state.globalQuery || '';
    const onGlobalQuery = e => this.setState({ globalQuery: e.target.value, globalOpen: true });
    const onGlobalFocus = () => { clearTimeout(this._globalBlurT); if (!this.state.globalOpen) this.setState({ globalOpen: true }); };
    const onGlobalBlur = () => { clearTimeout(this._globalBlurT); this._globalBlurT = setTimeout(() => this.setState({ globalOpen: false }), 180); };
    const gq = this._norm(globalQuery.trim());
    const globalGroups = [];
    if (gq.length >= 2) {
      const hit = s => this._norm(s).includes(gq);
      const goTo = extra => () => this.setState({ globalQuery: '', globalOpen: false, page: 0, cat: 'Toutes', q: '', ...extra });
      const ventesM = ops.filter(r => r.type === 'Vente' && (hit(r.ref) || hit(r.partner))).slice(0, 6)
        .map(r => ({ label: r.ref, sub: r.partner, onClick: goTo({ view: 'Ventes', q: r.ref }) }));
      if (ventesM.length) globalGroups.push({ name: 'Ventes', items: ventesM });
      const achatM = ops.filter(r => r.type === 'Achat' && (hit(r.ref) || hit(r.partner))).slice(0, 6)
        .map(r => ({ label: r.ref, sub: r.partner, onClick: goTo({ view: 'Achats', q: r.ref }) }));
      if (achatM.length) globalGroups.push({ name: 'Achat pêche', items: achatM });
      const facFournM = F.filter(f => f.sens === 'Fournisseur' && (hit(f.ref) || hit(f.partner))).slice(0, 6)
        .map(f => ({ label: f.ref, sub: f.partner, onClick: goTo({ view: 'Factures', facTab: 'Factures', q: f.ref }) }));
      if (facFournM.length) globalGroups.push({ name: 'Facture fournisseur', items: facFournM });
      const grenkeM = grenkeRows.filter(g => hit(g.ref) || hit(g.cust)).slice(0, 6)
        .map(g => ({ label: g.ref, sub: g.cust || '—', onClick: goTo({ view: 'Grenke', q: g.ref }) }));
      if (grenkeM.length) globalGroups.push({ name: 'Grenke', items: grenkeM });
      const blM = blLibRows.filter(b => hit(b.name) || hit(b.transporteur)).slice(0, 6)
        .map(b => ({ label: b.name, sub: b.transporteur, onClick: goTo({ view: 'Bordereaux' }) }));
      if (blM.length) globalGroups.push({ name: 'Bordereaux', items: blM });
    }
    // Profil simplifié : la recherche ne propose pas de résultats menant à des pages cachées
    if (!isAdminUI) {
      const GLOBAL_GROUP_VIEW = { 'Ventes': 'Ventes', 'Achat pêche': 'Achats', 'Facture fournisseur': 'Factures', 'Grenke': 'Ventes', 'Bordereaux': 'Bordereaux' };
      const keep = globalGroups.filter(g => profilVoit(GLOBAL_GROUP_VIEW[g.name] || g.name));
      globalGroups.length = 0;
      globalGroups.push(...keep);
    }
    const globalOpen = !!this.state.globalOpen && gq.length >= 2;
    const globalEmpty = globalOpen && globalGroups.length === 0;

    // STOCK (bibliothèque — poids total & valorisation)
    const stockRaw = this.state.stock || (demo ? C.STOCK : []);
    const kgFmt = n => Math.round(n).toLocaleString('fr-FR') + ' kg';
    const openStock = () => { const l = (this.state.links || {}).stock; if (l) this.openUrl(l); else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Ajoutez le lien du dossier/fichier Stock dans Paramètres pour ouvrir vos inventaires.' } }); };
    const stockRows = stockRaw.map((s, i) => ({ file: s.file || s.sem, sem: s.sem, poids: s.poids ? kgFmt(s.poids) : '—', valo: this.fmt(s.valo), btnStyle: `padding:6px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`, onOpen: () => this.openStockFile(s.file || s.sem) }));
    const stockCount = `${stockRaw.length} inventaire${stockRaw.length > 1 ? 's' : ''}`;
    const stockChecks = this.state.stockChecks || [];
    const stockBad = stockChecks.filter(c => c && c.status !== 'Conforme');
    const stockAlert = !stockChecks.length ? null : stockBad.length ? { text: `${stockBad.length} fichier(s) à vérifier : écart entre le récapitulatif et les feuilles détaillées, ou récapitulatif ambigu.`, color: '#8a3b00', bg: '#fff4e6', border: '#f0c78b' } : { text: `Contrôle effectué : ${stockChecks.length} récapitulatif(s) conforme(s) aux feuilles détaillées.`, color: '#166534', bg: '#ecfdf3', border: '#b7e4c7' };
    // ---- Compte rendu du stock (synthèse au-dessus de la liste) ----
    const stkLast = stockRaw[0] || null;
    const stkPrev = stockRaw[1] || null;
    const stkAvgValo = stockRaw.length ? stockRaw.reduce((s, x) => s + (+x.valo || 0), 0) / stockRaw.length : 0;
    const stkAvgPoids = stockRaw.length ? stockRaw.reduce((s, x) => s + (+x.poids || 0), 0) / stockRaw.length : 0;
    const stkDelta = (cur, prevRow, kg) => {
      if (!prevRow) return { txt: 'premier inventaire enregistré', color: '#9aa7b8' };
      const prev = kg ? (+prevRow.poids || 0) : (+prevRow.valo || 0);
      const d = cur - prev;
      const pct = prev ? Math.round((d / prev) * 1000) / 10 : null;
      const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '=';
      const mag = kg ? (Math.round(Math.abs(d)).toLocaleString('fr-FR') + ' kg') : this.fmt(Math.abs(d));
      return { txt: `${arrow} ${mag}${pct != null ? ` · ${pct > 0 ? '+' : ''}${pct} %` : ''} vs sem. préc.`, color: d > 0 ? green : d < 0 ? '#b45309' : '#9aa7b8' };
    };
    const stockReportShow = stockRaw.length > 0;
    const stkLastLabel = stkLast ? (stkLast.sem || stkLast.file || '—') : '—';
    const stockReportTiles = stkLast ? [
      { label: 'Poids total en stock', value: kgFmt(+stkLast.poids || 0), sub: stkDelta(+stkLast.poids || 0, stkPrev, true).txt, subColor: stkDelta(+stkLast.poids || 0, stkPrev, true).color, bar: accent, valueColor: '#0e1b2e' },
      { label: 'Valorisation', value: this.fmt(+stkLast.valo || 0), sub: stkDelta(+stkLast.valo || 0, stkPrev, false).txt, subColor: stkDelta(+stkLast.valo || 0, stkPrev, false).color, bar: green, valueColor: '#15803d' },
      { label: 'Valorisation moyenne', value: this.fmt(stkAvgValo), sub: `sur ${stockRaw.length} inventaire${stockRaw.length > 1 ? 's' : ''} · ${kgFmt(stkAvgPoids)} en moyenne`, subColor: '#9aa7b8', bar: slate, valueColor: '#0e1b2e' },
    ] : [];
    const stkEspLast = (this.state.stockEspeces && this.state.stockEspeces[0]) || null;
    let stockSpeciesRows = [];
    if (stkEspLast && stkEspLast.bySpecies) {
      const items = [];
      Object.entries(stkEspLast.bySpecies).forEach(([name, d]) => { if (d && !d.missing && ((+d.valeurAchat || 0) || (+d.poidsAchete || 0))) items.push({ name, poids: +d.poidsAchete || 0, valo: +d.valeurAchat || 0 }); });
      const totV = items.reduce((s, x) => s + x.valo, 0) || 1;
      items.sort((a, b) => b.valo - a.valo);
      stockSpeciesRows = items.slice(0, 8).map(x => ({ name: x.name, valo: this.fmt(x.valo), poids: kgFmt(x.poids), pct: Math.max(2, Math.round((x.valo / totV) * 100)) + '%', bar: accent }));
    }
    const stockSpeciesShow = stockSpeciesRows.length > 0;
    const asAllStk = this.achatSaisieRows();
    const asStockPoids = asAllStk.reduce((s, r) => s + (r.lignes || []).reduce((t, l) => t + (+l.poids || 0), 0), 0);
    const asStockValo = asAllStk.reduce((s, r) => s + (+r.total || 0), 0);
    const asStockEsp = new Set(asAllStk.flatMap(r => (r.lignes || []).map(l => l.espece).filter(Boolean))).size;
    const stockSaisieShow = asAllStk.length > 0;
    const stockSaisieNote = stockSaisieShow ? `${kgFmt(asStockPoids)} · ${this.fmt(asStockValo)} · ${asStockEsp} espèce${asStockEsp > 1 ? 's' : ''} (${asAllStk.length} achat${asAllStk.length > 1 ? 's' : ''} saisi${asAllStk.length > 1 ? 's' : ''})` : '';

    // VÉHICULES — saisie volontairement minimale : nom libre, liens banque manuels, pièces jointes locales.
    const vehicleSource = this.vehicleRows();
    const vehicleLinkStyle = `padding:7px 11px;border-radius:8px;border:1px solid ${this.hexToRgba(accent, .3)};background:#fff;color:${accent};font-size:12px;font-weight:600;cursor:pointer;font-family:inherit`;
    const vehicleRows = vehicleSource.map(v => ({ id: v.id, name: v.name || '', bankCount: (v.bankKeys || []).length, onName: e => this.updateVehicle(v.id, { name: e.target.value }), onBank: () => this.setState({ vehicleBankPick: v.id }), onAttach: () => this.pickVehicleAttachment(v.id), onDelete: () => this.deleteVehicle(v.id), linkStyle: vehicleLinkStyle, attachments: (v.attachments || []).map(a => ({ name: a.name, onOpen: () => this.openVehicleAttachment(v.id, a), style: 'padding:5px 9px;border-radius:7px;border:1px solid #e6ebf2;background:#f8fafc;color:#475569;font-size:11.5px;cursor:pointer;font-family:inherit' })) }));
    const onVehicleAdd = () => this.addVehicle();
    const vehicleBankOpen = !!this.state.vehicleBankPick;
    const pickedVehicle = vehicleSource.find(v => v.id === this.state.vehicleBankPick);
    const vehicleBankSource = this.state.banque || (demo ? C.BANQUE.map(a => ({ y: a[0], m: a[1], d: a[2], label: a[3], amt: a[4], solde: a[5] != null ? a[5] : null })) : []);
    const vehicleBankRows = vehicleBankSource.map(b => { const key = this.bankKey(b); return { key, checked: !!(pickedVehicle && (pickedVehicle.bankKeys || []).includes(key)), date: `${this.dd(b.d)}/${this.dd(b.m)}/${b.y}`, label: b.label, amount: this.fmt(b.amt), onToggle: () => this.linkVehicleBank(this.state.vehicleBankPick, key) }; });
    const onVehicleBankClose = () => this.setState({ vehicleBankPick: null });

    // TIERS
    const tiersMode = this.state.tiersPeriodMode === 'Mois' ? 'Mois' : 'Année';
    const tiersRange = tiersMode === 'Mois' ? [anchor, anchor] : yearRange(aY);
    const tiersScopeLabel = tiersMode === 'Mois' ? `${C.MONTHS[aM]} ${aY}` : `Année ${aY}`;
    const partnerType = this.state.tiers === 'Fournisseurs' ? 'Achat' : 'Vente';
    const byP = {};
    between(tiersRange[0], tiersRange[1]).filter(r => r.type === partnerType).forEach(r => { const p = byP[r.partner] = byP[r.partner] || { n: 0, vol: 0, enc: 0, last: null, cat: r.cat }; p.n++; p.vol += Math.abs(r.amt); if (r.status !== 'Payé') p.enc += (r.reste != null ? r.reste : Math.abs(r.amt)); if (!p.last) p.last = r; });
    const partnersRows = Object.entries(byP).sort((a, b) => b[1].vol - a[1].vol).slice(0, 20).map(([name, p]) => { const actif = ymOf(p.last) >= anchor - 1; return { ini: name[0], av, name, tag: this.state.tiers === 'Fournisseurs' ? p.cat : (C.SEGMENTS[name] || p.cat), ops: String(p.n), vol: this.fmt(p.vol), enc: p.enc ? this.fmt(p.enc) : '—', encColor: p.enc ? red : gray, last: `${this.dd(p.last.d)}/${this.dd(p.last.m)}`, status: actif ? 'Actif' : 'Veille', statusStyle: actif ? `${badge}background:#e7f5ec;color:${green}` : `${badge}background:#eef1f5;color:${slate}` }; });
    const partnerTagHeader = this.state.tiers === 'Fournisseurs' ? 'Catégorie' : 'Segment';
    const volHeader = `Volume ${tiersScopeLabel}`;
    const tiersPeriodTabs = ['Mois', 'Année'].map(name => ({ name, onClick: () => this.setState({ tiersPeriodMode: name }), style: tiersMode === name ? `padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : 'padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit' }));
    const tiersTabs = ['Clients', 'Fournisseurs'].map(name => ({ name, onClick: () => this.setState({ tiers: name }), style: this.state.tiers === name ? `padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : 'padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit' }));

    // ouvrir source
    const srcMap = { 'Tableau de bord': 'ventes', 'Ventes': 'ventes', 'Achats': 'operations', 'Factures': 'factures', 'Crédits': 'credits', 'Bordereaux': 'livraison', 'Stock': 'stock', 'Tiers': 'ventes' };
    const curKey = srcMap[view];
    const srcLabel = { operations: 'les achats pêcheurs', ventes: 'les ventes', factures: 'les factures à payer', credits: 'les crédits', bordereaux: 'les bordereaux', livraison: 'les bordereaux', stock: 'le stock' }[curKey];
    const showOpenSource = isDash || isFactures || isCredits || isBordereaux || isStock || isTiers;
    const openSourceLabel = '↗ Ouvrir ' + srcLabel;
    const openSourceStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const onOpenSource = () => { const l = (this.state.links || {})[curKey]; if (l) this.openUrl(l); else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: `Ajoutez le lien de ${srcLabel} (OneDrive, SharePoint, Google Drive…) dans Paramètres pour l'ouvrir en un clic.` } }); };

    // ---- lignes masquées (corbeille) + confirmation ----
    const trashAskS = this.state.trashAsk;
    const trashOpen = !!trashAskS;
    const trashLabel = trashAskS ? trashAskS.label : '';
    const onTrashCancel = () => this.setState({ trashAsk: null });
    const onTrashConfirm = () => this.confirmTrash();
    const trashConfirmStyle = 'padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#fff;background:#b91c1c;border:none;cursor:pointer;font-family:inherit';
    const hiddenChipStyle = 'padding:4px 10px;border-radius:99px;font-size:11.5px;font-weight:600;color:#8a5a00;background:#fff7e6;border:1px solid #f0dcae;cursor:pointer;font-family:inherit';
    const hiddenAchatsChip = { show: opsHiddenCount > 0, label: `${opsHiddenCount} ligne${opsHiddenCount > 1 ? 's' : ''} masquée${opsHiddenCount > 1 ? 's' : ''} · Rétablir`, onClick: () => this.restoreHidden('op'), style: hiddenChipStyle };
    const hiddenGrenkeChip = { show: grenkeHiddenCount > 0, label: `${grenkeHiddenCount} ligne${grenkeHiddenCount > 1 ? 's' : ''} masquée${grenkeHiddenCount > 1 ? 's' : ''} · Rétablir`, onClick: () => this.restoreHidden('grenke'), style: hiddenChipStyle };

    // ---- aperçu de fichier intégré (Stock / Bordereaux / Bibliothèque) ----
    const fp = this.state.filePreview;
    const filePreviewOpen = !!fp;
    const filePreviewName = fp ? fp.name : '';
    const fpWb = (fp && fp.wb) ? fp.wb : [];
    const fpSi = fp ? Math.min(fp.si || 0, Math.max(0, fpWb.length - 1)) : 0;
    const fpTabs = fpWb.map((s, i) => ({ name: s.name || `Feuille ${i + 1}`, onClick: () => this.setState({ filePreview: { ...fp, si: i } }), style: i === fpSi ? `white-space:nowrap;padding:5px 11px;border-radius:8px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit` : 'white-space:nowrap;padding:5px 11px;border-radius:8px;font-size:12px;font-weight:500;color:#69788c;background:#f2f5f9;border:none;cursor:pointer;font-family:inherit' }));
    const fpSheet = fpWb.length ? fpWb[fpSi] : null;
    const fpEditable = !!(fpSheet && !(fp && fp.unreadable) && /\.(xlsx|xlsm)$/i.test(filePreviewName));
    const fpBackStyle = `white-space:nowrap;padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    // Aperçu façon tableur : colonnes A/B/C…, numéros de ligne, quadrillage — au plus proche
    // d'Excel (la mise en forme couleur/formules du fichier n'est pas rendue, mais la structure
    // en grille rend l'aperçu bien plus lisible et fidèle qu'un simple tableau).
    let fpRows = [];
    let fpColHeaders = [];
    const fpRowNumStyle = 'flex:0 0 46px;width:46px;padding:7px 6px;border-right:1px solid #dde3ec;border-bottom:1px solid #eef1f6;font-size:11px;font-family:\'IBM Plex Mono\',monospace;color:#93a1b3;text-align:center;background:#f4f7fb;position:sticky;left:0;z-index:1';
    const fpCornerStyle = 'flex:0 0 46px;width:46px;padding:7px 6px;border-right:1px solid #dde3ec;border-bottom:1px solid #dde3ec;background:#eef2f7;position:sticky;left:0;z-index:3';
    if (fpSheet) {
      const rawR = (fpSheet.rows || []).slice(0, 200);
      const nc = Math.min(26, rawR.slice(0, 60).reduce((m2, r2) => Math.max(m2, (r2 || []).length), 1));
      const colName = n => { let s = '', m = n + 1; while (m > 0) { const r = (m - 1) % 26; s = String.fromCharCode(65 + r) + s; m = Math.floor((m - 1) / 26); } return s; };
      // Largeur AUTO par colonne : calée sur le contenu le plus long de la colonne. Les colonnes
      // vides se replient à ~30px (au lieu de 132px fixes) — l'aperçu ne pousse plus les données
      // loin à droite et ne fait plus de grands vides ; les colonnes pleines prennent la bonne taille.
      const colChars = Array.from({ length: nc }, () => 0);
      rawR.forEach(r2 => { for (let i = 0; i < nc; i++) { const s = String((r2 || [])[i] == null ? '' : (r2 || [])[i]); if (s.length > colChars[i]) colChars[i] = Math.min(s.length, 40); } });
      const colW = colChars.map(ch => ch === 0 ? 30 : Math.max(58, Math.min(300, Math.round(20 + ch * 7.4))));
      const headBase = 'padding:7px 8px;border-right:1px solid #dde3ec;border-bottom:1px solid #dde3ec;font-size:11px;font-weight:600;font-family:\'IBM Plex Mono\',monospace;color:#69788c;text-align:center;background:#eef2f7;overflow:hidden';
      fpColHeaders = Array.from({ length: nc }, (_, i) => ({ name: colName(i), style: `flex:0 0 ${colW[i]}px;width:${colW[i]}px;` + headBase }));
      const cellBaseCommon = "padding:7px 10px;border-right:1px solid #eef1f6;font-size:12px;font-family:'IBM Plex Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2a3a4e;";
      fpRows = rawR.map((r2, ri) => ({
        rowNum: ri + 1, rowNumStyle: fpRowNumStyle,
        cells: Array.from({ length: nc }, (_, i2) => {
          let v = String((r2 || [])[i2] == null ? '' : (r2 || [])[i2]).slice(0, 200);
          const isNum = /^-?\d[\d\s.,]*$/.test(v.trim());
          // Décimale longue issue d'une formule (ex. « 73.0999999999 ») → arrondi d'affichage à 2
          const flt = v.match(/^-?\d+\.\d{5,}$/);
          if (flt) { const n = Number(v); if (isFinite(n)) v = (Math.round(n * 100) / 100).toString().replace('.', ','); }
          const wStyle = `flex:0 0 ${colW[i2]}px;width:${colW[i2]}px;`;
          const cellBase = wStyle + cellBaseCommon;
          const cellInputStyle = cellBase + 'background:transparent;border:none;outline:none;font-family:inherit;';
          return { v, editable: fpEditable, style: cellBase + (isNum ? 'text-align:right;color:#0e1b2e;' : ''), inputStyle: cellInputStyle + (isNum ? 'text-align:right;' : ''), onEdit: e => this.editFpCell(ri, i2, e.target.value) };
        }),
      }));
    }
    const fpMore = (fp && fp.unreadable) ? "Impossible d'afficher le contenu de ce fichier ici. Utilisez « ⬇ Télécharger » si vous voulez l'ouvrir dans Excel." : (fpSheet && (fpSheet.rows || []).length > 200 ? `… ${fpSheet.rows.length - 200} lignes supplémentaires (ouvrez le fichier dans Excel pour tout voir)` : '');
    const fpInfo = fpSheet ? `${fpWb.length} feuille${fpWb.length > 1 ? 's' : ''} · ${(fpSheet.rows || []).length} ligne${(fpSheet.rows || []).length > 1 ? 's' : ''}` : '';
    const fpStatusMap = {
      writable: { text: '✎ Modifiable — enregistrement automatique dans le fichier', color: '#69788c' },
      readonly: { text: '👁 Lecture seule — modifiez puis téléchargez pour garder vos changements', color: '#9aa7b8' },
      dirty: { text: '● Modifié — cliquez « ⬇ Télécharger » pour garder vos changements', color: '#b45309' },
      saving: { text: '● Enregistrement en cours…', color: '#b45309' },
      saved: { text: `✓ Enregistré dans le fichier${fp && fp.savedAt ? ' — ' + fp.savedAt : ''}`, color: '#1a7f37' },
      error: { text: `⚠ Échec de l'enregistrement${fp && fp.saveError ? ' : ' + fp.saveError : ''} — téléchargez une copie`, color: '#b91c1c' },
    };
    let fpStatus = fp ? (fpStatusMap[fp.saveState] || null) : null;
    if (fp && fp.closeWarn && fp.dirty) fpStatus = { text: '⚠ Modifications non téléchargées — « ⬇ Télécharger » pour les garder, ou ✕ à nouveau pour fermer sans les garder', color: '#b91c1c' };
    const onFpClose = async () => {
      const fpNow = this.state.filePreview;
      clearTimeout(this._fpTimer);
      // Modification en attente + fichier ouvert en écriture : on enregistre AVANT de fermer
      // (sinon fermer dans la fenêtre de 0,6 s perdait la saisie sans prévenir).
      if (fpNow && fpNow.dirty && this._previewHandle) {
        await this.saveFilePreview();
        const after = this.state.filePreview;
        if (after && after.saveState === 'error') return; // échec : on reste ouvert, l'erreur est affichée
      } else if (fpNow && fpNow.dirty && !this._previewHandle && !fpNow.closeWarn) {
        // Lecture seule : les modifications ne vivent que dans l'aperçu. Premier clic = avertissement,
        // second clic = fermeture assumée.
        this.setState({ filePreview: { ...fpNow, closeWarn: true } });
        return;
      }
      this._previewBlob = null; this._previewHandle = null; this.setState({ filePreview: null });
    };
    const onFpDownload = async () => {
      let blob = this._previewBlob;
      // Copie fidèle : on repart du fichier original et on n'y remplace que les cellules
      // éditées (formules, styles et autres feuilles conservés). Si le patch échoue,
      // repli sur une reconstruction simple (valeurs seules) plutôt que rien.
      const pendingEdits = fp && fp.edits && Object.keys(fp.edits).length ? fp.edits : null;
      if (blob && pendingEdits) {
        try { blob = await this.patchXlsxFile(await blob.arrayBuffer(), pendingEdits); }
        catch (e) { console.error('[téléchargement] patch impossible, copie valeurs seules :', e); try { blob = await this.buildXlsxBlob(fpWb); } catch (e2) {} }
      } else if (!blob && fpEditable && fpWb.length) {
        try { blob = await this.buildXlsxBlob(fpWb); } catch (e) {}
      }
      if (!blob) return;
      const base = (filePreviewName || 'document.xlsx').replace(/\.(xlsx|xlsm)$/i, '');
      const dl = (fp && fp.dirty) ? `${base} (modifié).xlsx` : (filePreviewName || 'document.xlsx');
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = dl; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (fp && fp.dirty && !this._previewHandle) this.setState(s => s.filePreview ? { filePreview: { ...s.filePreview, dirty: false, closeWarn: false, saveState: 'saved', savedAt: 'copie téléchargée' } } : {});
    };
    const fpDownloadStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;

    // bandeau
    const anyImp = this.state.ventes || this.state.ops || this.state.factures || this.state.credits || this.state.comptable || this.state.bordereaux || this.state.stock;
    const bannerBase = 'display:flex;justify-content:space-between;align-items:center;gap:14px;padding:9px 24px;font-size:12.5px;border-bottom:1px solid #eef1f6;';
    const actBtn = `padding:5px 11px;border-radius:7px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    let bannerStyle, bannerText, bannerActions;
    if (this.state.msg && this.state.msg.kind === 'error') { bannerStyle = bannerBase + 'background:#fdeaea;color:#8a1c1c'; bannerText = this.state.msg.text; const isPayCheck = /À vérifier|paiement/i.test(bannerText); bannerActions = [isPayCheck ? { label: 'Résoudre les problèmes', onClick: () => this.setState({ view: 'Ventes', q: 'À vérifier', page: 0, msg: null }), style: actBtn } : { label: 'Paramètres', onClick: () => this.setState({ view: 'Paramètres', msg: null }), style: actBtn }, { label: 'Fermer', onClick: () => this.setState({ msg: null }), style: actBtn }]; }
    else if (anyImp) { const parts = []; if (this.state.ventes) parts.push(`ventes (${this.state.ventesName})`); if (this.state.ops) parts.push(`achats (${this.state.opsName})`); if (this.state.factures) parts.push(`factures à payer (${this.state.facturesName})`); if (this.state.credits) parts.push(`crédits (${this.state.creditsName})`); if (this.state.comptable) parts.push(`export comptable (${this.state.comptableName})`); if (this.state.bordereaux) parts.push(`bordereaux (${this.state.bordereauxName})`); if (this.state.banque) parts.push(`banque (${this.state.banqueName})`); if (this.state.stock) parts.push(`stock (${this.state.stockName})`); bannerStyle = bannerBase + 'background:#e7f5ec;color:#14532d'; bannerText = `Sources connectées : ${parts.join(' · ')}${this.state.msg ? ' — ' + this.state.msg.text : ''}`; bannerActions = [{ label: 'Gérer les sources', onClick: () => this.setState({ view: 'Paramètres', msg: null }), style: actBtn }, demo ? { label: 'Quitter le mode démo', onClick: () => this.setDemoMode(false), style: actBtn } : { label: 'Réactiver la démo', onClick: () => this.setDemoMode(true), style: actBtn }]; if (this.state.importChecks) bannerActions.unshift({ label: '⚠ Voir le contrôle', onClick: () => this.setState({ importChecksOpen: true }), style: `${actBtn}color:#8a5a00;border-color:#f0dcae;background:#fff7e6` }); }
    else if (demo) { bannerStyle = bannerBase + `background:${this.hexToRgba(accent, 0.07)};color:#3a4a5e`; bannerText = 'Données de démonstration. Importez vos fichiers Excel depuis Paramètres — un écran vous laisse confirmer les colonnes, puis tout se met à jour automatiquement.'; bannerActions = [{ label: 'Quitter le mode démo', onClick: () => this.setDemoMode(false), style: actBtn }, { label: 'Ouvrir les Paramètres', onClick: () => this.setState({ view: 'Paramètres' }), style: actBtn }]; }
    else { bannerStyle = bannerBase + 'background:#fff7ed;color:#9a3412'; bannerText = 'Mode démo désactivé — aucune donnée importée pour le moment. Reliez vos fichiers Excel depuis Paramètres ; chaque vue reste vide tant que son fichier n’est pas connecté.'; bannerActions = [{ label: 'Ouvrir les Paramètres', onClick: () => this.setState({ view: 'Paramètres' }), style: actBtn }, { label: 'Réactiver la démo', onClick: () => this.setDemoMode(true), style: actBtn }]; }
    // Profil simplifié : pas d'actions d'administration dans le bandeau (Paramètres, démo, contrôle)
    if (!isAdminUI) bannerActions = (bannerActions || []).filter(a => a && a.label === 'Fermer');
    const bannerVisible = this.state.bannerDismiss !== bannerText;
    const onDismissBanner = () => this.dismissBanner(bannerText);
    const bannerCloseStyle = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.5);color:inherit;cursor:pointer;font-size:12px;font-family:inherit;line-height:1;flex-shrink:0';
    // en-tête : HT/TTC + rafraîchir
    const htTtcLabel = amountMode + ' ▾';
    const htTtcStyle = `padding:8px 12px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`;
    const onToggleHtTtc = () => this.askHtTtc();
    // Pop-up de confirmation HT / TTC
    const htTtcAskOpen = !!this.state.htTtcAsk;
    const htTtcTarget = amountMode === 'HT' ? 'TTC' : 'HT';
    const htTtcTargetLong = htTtcTarget === 'HT' ? 'hors taxes (HT)' : 'toutes taxes comprises (TTC)';
    const htTtcExplain = htTtcTarget === 'HT' ? 'Les ventes seront affichées hors taxes (HT). Les montants sans HT connu (achats pêcheurs, factures fournisseurs, crédits…) restent en TTC — chaque ligne indique sa base.' : 'Tous les montants seront de nouveau affichés toutes taxes comprises (TTC).';
    const htTtcCheck = !!this.state.htTtcCheck;
    const onHtTtcCheck = e => this.setState({ htTtcCheck: e.target.checked });
    const onHtTtcConfirm = () => this.confirmHtTtc();
    const onHtTtcCancel = () => this.cancelHtTtc();
    const htTtcConfirmStyle = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${htTtcCheck ? accent : '#c5cede'};border:none;cursor:${htTtcCheck ? 'pointer' : 'not-allowed'};font-family:inherit`;
    const refreshStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const onRefreshAll = () => this.refreshAll();

    // ---- Sauvegarde complète (archive .zip) + Restauration ----
    const onBackup = () => this.runBackup();
    const backupBusy = this.state.backupStatus === 'saving';
    const backupBtnLabel = backupBusy ? '💾 Sauvegarde…' : '💾 Sauvegarde';
    const backupBtnStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:${backupBusy ? 'default' : 'pointer'};font-family:inherit;white-space:nowrap`;
    // ---- Mode aide (Helpeur)
    const helpMode = !!this.state.helpMode;
    const onHelpToggle = () => this.setState({ helpMode: !this.state.helpMode, helpTip: null });
    const helpBtnStyle = helpMode
      ? `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit;white-space:nowrap`
      : `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const helpRootClass = helpMode ? 'help-mode' : '';
    const helpTip = this.state.helpTip;
    const helpTipStyle = helpTip ? `position:fixed;left:${helpTip.x}px;top:${helpTip.y}px;width:360px;max-width:calc(100vw - 24px);background:#fff;border:1px solid ${this.hexToRgba(accent, 0.4)};border-radius:12px;box-shadow:0 18px 44px -12px rgba(14,27,46,.45);padding:14px 16px;z-index:9500;font-family:inherit` : 'display:none';
    const onHelpTipClose = () => this.setState({ helpTip: null });
    const helpHintOpen = helpMode && !helpTip;
    const backupFolderName = this.state.backupFolderName || '';
    const onChangeBackupFolder = () => this.changeBackupFolder();
    const backupStatusMap = {
      saving: { text: 'Sauvegarde en cours…', color: '#b45309' },
      saved: { text: `✓ Dernière sauvegarde : ${this.state.backupLast || ''}`, color: '#1a7f37' },
      error: { text: `⚠ ${this.state.backupError || 'échec de la sauvegarde'}`, color: '#b91c1c' },
    };
    const backupStatus = backupStatusMap[this.state.backupStatus] || null;
    // ---- Export de suivi (tableau Excel cumulé)
    const onSuivi = () => this.runSuivi();
    const suiviBusy = this.state.suiviStatus === 'saving';
    const suiviFolderName = this.state.suiviFolderName || '';
    const onChangeSuiviFolder = () => this.changeSuiviFolder();
    const suiviBtnLabel = suiviBusy ? 'Export en cours…' : '📈 Ajouter la période au suivi';
    const suiviBtnStyle = `padding:9px 15px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:1px solid ${accent};cursor:${suiviBusy ? 'default' : 'pointer'};font-family:inherit;white-space:nowrap`;
    const suiviStatusMap = {
      saving: { text: 'Export en cours…', color: '#b45309' },
      saved: { text: `✓ Enregistré — ${this.state.suiviLast || ''}`, color: '#1a7f37' },
      error: { text: `⚠ ${this.state.suiviError || "échec de l'export"}`, color: '#b91c1c' },
    };
    const suiviStatus = suiviStatusMap[this.state.suiviStatus] || null;
    const suiviPeriodLabel = (this._suiviData && this._suiviData.periodLabel) || periodLabel;
    const openBtnStyle = `padding:6px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`;
    const onRestorePick = () => this.pickRestoreFile();
    const restoreBusy = this.state.restoreStatus === 'reading';
    const restoreBtnLabel = restoreBusy ? 'Lecture…' : 'Restaurer une sauvegarde…';
    const restoreErrText = this.state.restoreStatus === 'error' ? this.state.restoreError : null;
    const rp = this.state.restorePreview;
    const restoreOpen = !!rp;
    const restorePreview = rp ? {
      name: rp.name, keyCount: rp.keyCount,
      xlsxFiles: (rp.xlsxFiles || []).map(n => ({ name: n, onDownload: () => this.downloadRestoreFile(n), style: openBtnStyle })),
    } : null;
    const onRestoreConfirm = () => this.confirmRestore();
    const onRestoreCancel = () => this.cancelRestore();

    // Profil entreprise (Paramètres → Entreprise)
    const entCfg = this.entCfg();
    const entNom = entCfg.nom;
    const entLogo = entCfg.logo;
    const entNoLogo = !entLogo;
    const entInitials = this.entInitials();
    const entNomValue = (this.state.entreprise && typeof this.state.entreprise.nom === 'string') ? this.state.entreprise.nom : entCfg.nom;
    const onEntNom = e => this.setEnt({ nom: e.target.value });
    const entAccentValue = entCfg.accent;
    const onEntAccent = e => this.setEnt({ accent: e.target.value });
    const ENT_PRESETS = ['#1a56db', '#0f766e', '#15803d', '#9d174d', '#b45309', '#475569'];
    const entAccentPresets = ENT_PRESETS.map(c => ({
      onClick: () => this.setEnt({ accent: c }),
      style: `width:26px;height:26px;border-radius:8px;background:${c};border:2px solid ${c === entCfg.accent ? '#0e1b2e' : 'transparent'};cursor:pointer;padding:0;flex-shrink:0`,
    }));
    const onEntLogoPick = () => this.pickEntLogo();
    const onEntLogoClear = () => this.setEnt({ logo: '' });
    const entEspecesText = entCfg.especes.join('\n');
    const onEntEspeces = e => {
      const lines = String(e.target.value || '').split('\n').map(x => x.trim()).filter(Boolean);
      this.setEnt({ especes: lines });
    };
    const entEspecesCount = entCfg.especes.length;

    // Sélecteur de profil (barre latérale) + carte de gestion (Paramètres)
    const profC = this.profCfg();
    const profilChipLabel = profActif.nom;
    const profilRoleLabel = isAdminUI ? 'Admin' : 'Affichage simplifié';
    const profilMenuOpen = !!this.state.profilMenuOpen;
    const onProfilToggle = () => this.setState({ profilMenuOpen: !this.state.profilMenuOpen });
    const profilChipStyle = `display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:8px 10px;border-radius:9px;font-size:12.5px;font-weight:600;color:#3a4a5e;background:${this.hexToRgba(accent, 0.06)};border:1px solid ${this.hexToRgba(accent, 0.18)};cursor:pointer;font-family:inherit`;
    const profilItems = profC.list.map(p => ({
      label: p.nom,
      roleLabel: p.role === 'admin' ? 'Admin' : 'Simplifié',
      active: p.id === profC.activeId,
      onClick: () => this.setActiveProfil(p.id),
      style: p.id === profC.activeId
        ? `display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:7px 10px;border-radius:8px;font-size:12.5px;font-weight:600;color:${accent};background:${this.hexToRgba(accent, 0.08)};border:none;cursor:pointer;font-family:inherit;margin-top:2px`
        : 'display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:7px 10px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit;margin-top:2px',
    }));
    // Gestion des profils (carte Paramètres — visible uniquement en admin puisque la page l'est)
    const nAdmins = profC.list.filter(p => p.role === 'admin').length;
    const profilRows = profC.list.map(p => {
      const lastAdmin = p.role === 'admin' && nAdmins <= 1;
      return {
        nomValue: p.nom,
        onNom: e => this.updateProfil(p.id, { nom: e.target.value }),
        roleValue: p.role,
        onRole: e => this.updateProfil(p.id, { role: e.target.value === 'admin' ? 'admin' : 'simple' }),
        roleLockedAttr: lastAdmin ? 'disabled' : null,
        isSimple: p.role !== 'admin',
        activeTag: p.id === profC.activeId,
        viewChecks: C.PROFIL_VIEWS.map(v => ({
          label: v.label,
          checked: (p.views.length ? p.views : C.PROFIL_DEFAULT_VIEWS).includes(v.view),
          onToggle: () => {
            const cur = p.views.length ? p.views.slice() : C.PROFIL_DEFAULT_VIEWS.slice();
            const idx = cur.indexOf(v.view);
            if (idx >= 0) cur.splice(idx, 1); else cur.push(v.view);
            this.updateProfil(p.id, { views: cur });
          },
        })),
        onDelete: () => this.deleteProfil(p.id),
        delDisabledAttr: lastAdmin ? 'disabled' : null,
        delStyle: lastAdmin
          ? 'padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;color:#b8c2d0;background:#fff;border:1px solid #e6ebf2;cursor:default;font-family:inherit'
          : 'padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;color:#b91c1c;background:#fff;border:1px solid #f0d9d9;cursor:pointer;font-family:inherit',
      };
    });
    const onProfilAdd = () => this.addProfil();

    // Programmation horaire Jour / Nuit (Paramètres) — pilote le calcul des Heures
    const hNuitOn = !!this.state.hNuit;
    const hNuitTabs = [
      { label: '☀ Journée', active: !hNuitOn, onClick: () => this.setHNuit(false) },
      { label: '🌙 Nuit (passe minuit)', active: hNuitOn, onClick: () => this.setHNuit(true) },
    ].map(t => ({
      ...t,
      style: t.active
        ? `padding:8px 16px;border-radius:8px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`
        : 'padding:8px 16px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit;white-space:nowrap',
    }));
    const hNuitStatus = hNuitOn
      ? 'Mode Nuit : un départ « avant » l’arrivée (ex. 22:00 → 06:00) compte comme un passage de minuit et donne 8h00.'
      : 'Mode Journée : un départ avant l’arrivée compte 0 et est signalé ⚠ dans la grille — rien n’est deviné à votre place.';

    // Écran d'accueil « Qui êtes-vous ? » — pastilles dans le style du sélecteur de période :
    // le dernier profil utilisé est pré-rempli (fond accent), les autres sont neutres.
    const whoOpen = !!this.state.whoOpen && profC.list.length >= 1;
    // Vue Messages — chat entre profils (ancré en bas : liste inversée + column-reverse)
    const isMessages = view === 'Messages';
    const msgMe = profActif;
    const msgProfNames = {}; profC.list.forEach(p => { msgProfNames[p.id] = p.nom; });
    const msgFmtTime = ts => { const d = new Date(ts || 0); return `${this.dd(d.getDate())}/${this.dd(d.getMonth() + 1)} ${this.dd(d.getHours())}:${this.dd(d.getMinutes())}`; };
    const msgVisible = this.msgList()
      .filter(m => m.to === 'all' || m.to === msgMe.id || m.from === msgMe.id)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const msgRows = msgVisible.slice(-200).reverse().map(m => {
      const mine = m.from === msgMe.id;
      const prive = m.to !== 'all';
      const toNom = m.to === msgMe.id ? 'vous' : (msgProfNames[m.to] || 'profil supprimé');
      return {
        meta: `${mine ? 'Vous' : (m.fromNom || msgProfNames[m.from] || '?')}${prive ? ` → ${toNom} · privé` : ''} — ${msgFmtTime(m.ts)}`,
        text: m.text,
        rowStyle: `display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};gap:2px;padding:3px 0`,
        metaStyle: 'font-size:10.5px;color:#9aa7b8;padding:0 4px',
        bubbleStyle: mine
          ? `max-width:72%;background:${accent};color:#fff;padding:9px 14px;border-radius:13px 13px 4px 13px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word`
          : 'max-width:72%;background:#fff;border:1px solid #e6ebf2;color:#0e1b2e;padding:9px 14px;border-radius:13px 13px 13px 4px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 2px rgba(16,32,54,.05)',
        canDelete: mine || isAdminUI,
        onDelete: () => this.deleteMessage(m.id),
        delStyle: 'border:none;background:transparent;color:#c4cdd8;font-size:11px;cursor:pointer;padding:2px 4px;font-family:inherit',
      };
    });
    const msgEmpty = msgRows.length === 0;
    const msgTextValue = this.state.msgText || '';
    const onMsgText = e => this.setState({ msgText: e.target.value });
    const onMsgKey = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); } };
    const onMsgSend = () => this.sendMessage();
    const msgToValue = (this.state.msgTo === 'all' || profC.list.some(p => p.id === this.state.msgTo && p.id !== msgMe.id)) ? this.state.msgTo : 'all';
    const msgToOptions = [{ value: 'all', label: '📢 À tout le monde' }, ...profC.list.filter(p => p.id !== msgMe.id).map(p => ({ value: p.id, label: `🔒 En privé à ${p.nom}` }))];
    const onMsgTo = e => this.setState({ msgTo: e.target.value });
    const msgSendStyle = `padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`;
    const msgMeLabel = `Vous écrivez en tant que ${msgMe.nom}`;
    const msgSoloHint = profC.list.length < 2;

    const whoItems = profC.list.map(p => ({
      label: p.nom,
      sub: p.role === 'admin' ? 'Admin — voit tout' : 'Affichage simplifié',
      onClick: () => this.setActiveProfil(p.id, true),
      style: p.id === profC.activeId
        ? `padding:10px 22px;border-radius:9px;font-size:14px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`
        : 'padding:10px 22px;border-radius:9px;font-size:14px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit;white-space:nowrap',
    }));

    // PARAMÈTRES
    const settingsIntro = "Vos fichiers Excel restent la source de vérité — le tableau de bord ne fait que les lire et les mettre en forme. Reliez ici chaque fichier : collez son lien pour l'ouvrir en un clic, ou importez-le (.xlsx) pour alimenter les vues. Tout se passe en local, hors ligne : aucune donnée n'est envoyée sur Internet. En cas de colonne manquante ou de fichier illisible, un bandeau rouge vous l'indique aussitôt.";
    const srcStatus = (on, name) => on ? { statusLabel: 'Connecté', statusStyle: `${badge}background:#e7f5ec;color:${green}`, detail: `📎 ${name}` } : { statusLabel: 'Démo', statusStyle: `${badge}background:#eef1f5;color:${slate}`, detail: 'Données de démonstration actives' };
    const impBtn = `padding:7px 13px;border-radius:8px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const ghost = `padding:7px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`;
    const openStyle = `padding:7px 11px;border-radius:8px;font-size:13px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;flex-shrink:0`;
    const EXCEL_OPEN_KINDS = ['ventes', 'operations', 'factures', 'credits', 'comptable', 'banque'];
    const mkSrc = (key, name, desc, columns, connected, cname) => ({ name, desc, columns, connected, ...srcStatus(connected, cname), importStyle: impBtn, ghostStyle: ghost, openStyle, remapStyle: ghost, canRemap: connected && !['stock', 'bordereaux', 'transport', 'livraison'].includes(key), onRemap: () => this.reopenMapping(key), importLabel: key === 'stock' ? '📁 Choisir le dossier Stock' : key === 'bordereaux' ? '📁 Choisir le dossier Bordereaux' : 'Importer le fichier', onImport: () => this.importFile(key), onReset: () => this.resetSource(key), linkValue: (this.state.links || {})[key] || '', onLinkChange: e => this.setLink(key, e.target.value), onOpen: () => { const l = (this.state.links || {})[key]; if (l) this.openUrl(l); else this.setState({ msg: { kind: 'error', text: `Renseignez d'abord le lien du fichier « ${name} » ci-dessus.` } }); }, canOpenExcel: connected && EXCEL_OPEN_KINDS.includes(key), onOpenExcel: () => this.openSourceInExcel(key, name), menuOpen: !!(this.state.srcMenuOpen || {})[key], onMenu: () => this.setState({ srcMenuOpen: { ...(this.state.srcMenuOpen || {}), [key]: !(this.state.srcMenuOpen || {})[key] } }), moreLabel: (this.state.srcMenuOpen || {})[key] ? '▴ Fermer' : '⋯ Réglages', ...(this.writeableKinds().indexOf(key) >= 0 ? this._srcWriteProps(key) : { canWrite: false }) });
    const mkModel = (key, label) => ({
      hasModel: true, modelLabel: label,
      modelValue: (this.state.models || {})[key] || '',
      onModelChange: e => this.setModel(key, e.target.value),
      onOpenModel: () => { const m = (this.state.models || {})[key]; if (m) this.openUrl(m); else this.setState({ msg: { kind: 'error', text: `Renseignez d'abord le lien du modèle « ${label} » ci-dessous.` } }); },
    });
    const openModelBtnStyle = `padding:7px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const onOpenModelStock = () => { const m = (this.state.models || {}).stock; if (m) this.openUrl(m); else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Renseignez le lien de votre modèle Excel de Stock dans Paramètres, puis « 📄 Modèle ».' } }); };
    const onOpenModelLivraison = () => { const m = (this.state.models || {}).livraison; if (m) this.openUrl(m); else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Renseignez le lien de votre modèle de bon de livraison dans Paramètres, puis « 📄 Modèle livraison ».' } }); };
    const onOpenModelTransport = () => { const m = (this.state.models || {}).transport; if (m) this.openUrl(m); else this.setState({ view: 'Paramètres', msg: { kind: 'error', text: 'Renseignez le lien de votre modèle de bon de transport dans Paramètres, puis « 📄 Modèle transport ».' } }); };
    const blMenuOpen = !!this.state.blMenuOpen;
    const onToggleBlMenu = () => this.setState({ blMenuOpen: !this.state.blMenuOpen });
    const onCloseBlMenu = () => this.setState({ blMenuOpen: false });
    const blMenuBtnStyle = `padding:7px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:${blMenuOpen ? soft : '#fff'};border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;
    const blMenuItemStyle = 'display:block;width:100%;text-align:left;padding:9px 12px;border-radius:8px;font-size:12.5px;font-weight:500;color:#2a3646;background:transparent;border:none;cursor:pointer;font-family:inherit;white-space:nowrap';
    const blMenuItems = [
      { label: '📁 Connecter les dossiers', onClick: () => this.setState({ blMenuOpen: false, view: 'Paramètres' }) },
      { label: '📄 Modèle bon de livraison', onClick: () => { this.setState({ blMenuOpen: false }); onOpenModelLivraison(); } },
      { label: '📄 Modèle bon de transport', onClick: () => { this.setState({ blMenuOpen: false }); onOpenModelTransport(); } },
    ].map(it => ({ ...it, style: blMenuItemStyle }));
    const sources = [
      mkSrc('ventes', 'Ventes (clients)', 'SUIVI FACTURES VENTE — onglet « Factures »', 'Date · Client · Montant HT · TVA France · TVA Irlande · Réglé', !!this.state.ventes, this.state.ventesName),
      mkSrc('operations', 'Achat pêche', 'SUIVI FACTURATION PECHEUR — onglet « Suivi de la facturation »', 'Date · Pêcheur · Montant · Total payé · Solde (restant)', !!this.state.ops, this.state.opsName),
      mkSrc('factures', 'Factures à payer', 'FACTURES A PAYER — fournisseurs, feuilles mensuelles', 'Date · Fournisseur · Factures · Montant · Paiement', !!this.state.factures, this.state.facturesName),
      mkSrc('credits', 'Crédits & assurances', 'SUIVIT MENSUALITE CREDIT-ASSURANCE', 'Dénomination · Entreprise · Montant total · Mensualité · Restant', !!this.state.credits, this.state.creditsName),
      mkSrc('comptable', 'Export comptable', 'Export du logiciel comptable — sert au rapprochement des factures', 'N° facture · Partenaire · Montant · Date', !!this.state.comptable, this.state.comptableName),
      mkSrc('banque', 'Relevé bancaire', 'Export CSV ou Excel de votre banque — rapprochement automatique avec achats, ventes, factures et crédits', 'Date · Libellé · Montant (ou Débit + Crédit)', !!this.state.banque, this.state.banqueName),
      { ...mkSrc('stock', 'Stock (dossier)', `Dossier d'inventaires — fichiers « ${this.prefixOf('stock')}… », lus en continu`, 'Semaine · Poids total · Valorisation', !!this.state.stock, this.state.stockName), ...mkModel('stock', 'Modèle Stock'),
        hasWeekly: true,
        weeklyStatus: this.state.stockModelName ? `Modèle hebdo : ${this.state.stockModelName} — chaque nouvelle semaine, le fichier stock est créé automatiquement à la première saisie d'achat.` : 'Aucun modèle hebdo choisi — désignez votre classeur vierge pour que le fichier de la semaine se crée tout seul.',
        weeklyBtnLabel: this.state.stockModelName ? '📄 Changer le modèle hebdo' : '📄 Choisir le modèle hebdo',
        weeklyBtnStyle: openModelBtnStyle, onPickWeekly: () => this.pickStockModelFile() },
      { ...mkSrc('livraison', 'Bordereaux de livraison (dossier)', `Dossier de bons de livraison — fichiers « ${this.prefixOf('livraison')}… »`, 'Fichiers ouvrables (Excel · PDF · scan)', !!this.state.folderBl, this.state.folderBl && this.state.folderBl.name), importLabel: '📁 Choisir le dossier livraison', onImport: () => this.connectBordereauxFolder(), ...mkModel('livraison', 'Modèle bon de livraison') },
      { ...mkSrc('transport', 'Bordereaux de transport (dossier)', 'Dossier de bordereaux transporteurs — un ou plusieurs débuts de noms (= transporteurs)', 'Fichiers ouvrables (Excel · PDF · scan)', !!this.state.folderTransp, this.state.folderTransp && this.state.folderTransp.name), importLabel: '📁 Choisir le dossier transport', onImport: () => this.connectTransportFolder(), ...mkModel('transport', 'Modèle bon de transport') },
    ];

    const objInputs = [
      { key: 'caM', label: 'Objectif CA mensuel', unit: '€', value: O.caM ?? (this.props.objectifCAMensuel ?? 32000), onChange: e => this.setObj('caM', e.target.value) },
      { key: 'caA', label: 'Objectif CA annuel', unit: '€', value: O.caA ?? (this.props.objectifCAAnnuel ?? 260000), onChange: e => this.setObj('caA', e.target.value) },
      { key: 'taux', label: 'Taux de marge cible', unit: '%', value: O.taux ?? (this.props.objectifTauxMarge ?? 25), onChange: e => this.setObj('taux', e.target.value) },
      { key: 'vM', label: 'Ventes par mois', unit: '', value: O.vM ?? (this.props.objectifVentesMensuel ?? 7), onChange: e => this.setObj('vM', e.target.value) },
    ];

    // ---------- Assistant de première connexion ----------
    const setupOpen = !!this.state.setupOpen;
    const setupBadge = ok => `display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:20px;color:${ok ? green : '#b45309'};background:${ok ? this.hexToRgba(green, 0.1) : '#fff7ed'};border:1px solid ${ok ? this.hexToRgba(green, 0.25) : '#fbd9b4'}`;
    const setupSteps = sources.map((s, i) => ({
      num: i + 1, name: s.name, desc: s.desc, columns: s.columns,
      connected: s.connected,
      statusLabel: s.connected ? '✓ Connecté' : 'À connecter',
      statusStyle: setupBadge(s.connected),
      importLabel: s.importLabel, importStyle: s.importStyle, onImport: s.onImport,
    }));
    const setupSrcDone = setupSteps.filter(s => s.connected).length;
    const setupEntDone = (entNomValue || '').trim().length > 0;
    const setupDoneCount = (setupEntDone ? 1 : 0) + setupSrcDone;
    const setupTotalCount = 1 + setupSteps.length;
    const setupPct = Math.round(setupDoneCount / setupTotalCount * 100) + '%';
    const setupCountLabel = `${setupDoneCount} / ${setupTotalCount} étapes prêtes`;
    const setupAllDone = setupDoneCount >= setupTotalCount;
    const onSetupClose = () => this.closeSetup();
    const onSetupOpen = () => this.openSetup();
    const setupEntBadgeStyle = setupBadge(setupEntDone);
    const setupEntStatusLabel = setupEntDone ? '✓ Renseigné' : 'À renseigner';

    const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    const folderConnected = !!this.state.folder;
    const folderName = this.state.folder ? this.state.folder.name : '';
    const folderCount = this.state.folder ? `${this.state.folder.files.length} fichier(s)` : '';
    const onConnectFolder = () => this.connectFolder();
    const onResyncFolder = () => { if (this._libDir) this.refreshLibFolder(this._libDir, false); else this.connectFolder(); };
    const folderBtnStyle = `padding:8px 15px;border-radius:9px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const folderResyncStyle = ghost;
    const folderBtnLabel = folderConnected ? 'Changer de dossier' : 'Connecter un dossier';
    const folderNote = folderSupported ? "Autorisez un dossier une fois : ses documents (PDF, Word, Excel) sont indexés dans la Bibliothèque et s'ouvrent en un clic. Les fichiers de données déjà importés ci-dessus sont surveillés et se mettent à jour automatiquement." : "La connexion de dossier fonctionne sur Chrome ou Edge (ordinateur). Sinon, importez chaque fichier via les cartes ci-dessus.";
    const folderFiles = (this.state.folder ? this.state.folder.files : []).slice(0, 12).map(f => { const icon = /\.pdf$/i.test(f.name) ? '📕' : /\.(docx?|odt)$/i.test(f.name) ? '📝' : /\.(xlsx|xlsm|xls|ods)$/i.test(f.name) ? '📊' : '📄'; return { name: f.name, icon, hint: f.path || '', action: 'Ouvrir', loadable: true, style: ghost, onLoad: () => this.openFolderDoc(f) }; });
    const capabilityNote = "Support : une page HTML autonome, 100 % hors ligne (aucune connexion Internet). — Mise à jour automatique : les fichiers Excel importés (et le dossier Stock) sont surveillés ; dès qu'Excel enregistre, le tableau se met à jour seul, sans rien recliquer. Le bouton « Temps réel » met la surveillance en pause. Chaque problème (colonne manquante, fichier illisible) est signalé par un bandeau rouge. Fonctionne sur Chrome/Edge (ordinateur).";

    // BIBLIOTHÈQUE (documents de travail)
    const libAll = this.state.folder ? this.state.folder.files : [];
    const classify = nm => { const n = (nm || '').toLowerCase(); if (/payer/.test(n)) return { tag: 'Factures à payer', color: accent }; if (/pecheur|pêcheur|facturation/.test(n)) return { tag: 'Achats pêcheurs', color: '#0f766e' }; if (/credit|assurance|mensualit/.test(n)) return { tag: 'Crédit / Assurance', color: '#7c3aed' }; if (/border|livrais|\bbl[-_ ]/.test(n)) return { tag: 'Bordereau', color: amber }; if (/stock|inventair|week/.test(n)) return { tag: 'Stock', color: '#b45309' }; if (/prestation|conditionn|facon|façon|langoust/.test(n)) return { tag: 'Prestation', color: accent }; if (/vente/.test(n)) return { tag: 'Ventes', color: green }; if (/factur/.test(n)) return { tag: 'Facture', color: accent }; return { tag: 'Document', color: slate }; };
    const iconOf = nm => /\.(xlsx|xlsm|xls|ods)$/i.test(nm) ? '📊' : /\.pdf$/i.test(nm) ? '📕' : /\.(csv|txt)$/i.test(nm) ? '📄' : /\.(docx?|odt)$/i.test(nm) ? '📝' : '📁';
    const typeOf = nm => /\.pdf$/i.test(nm) ? 'PDF' : /\.(xlsx|xlsm|xls|ods|csv|txt)$/i.test(nm) ? 'Excel' : /\.(docx?|odt)$/i.test(nm) ? 'Word' : 'Autre';
    const libTypes = ['Tous', 'PDF', 'Excel', 'Word'];
    const libType = libTypes.includes(this.state.libType) ? this.state.libType : 'Tous';
    const libSearch = this.state.libSearch || '';
    const libMatch = f => (libType === 'Tous' || typeOf(f.name) === libType) && (!libSearch || this._norm(f.name).includes(this._norm(libSearch)) || this._norm(f.path || '').includes(this._norm(libSearch)));
    const libFiles = libAll.filter(libMatch);
    const libraryRows = libFiles.map(f => { const c = classify(f.name); return { name: f.name, path: f.path || '—', icon: iconOf(f.name), type: typeOf(f.name), tag: c.tag, tagStyle: `${badge}background:${this.hexToRgba(c.color, 0.12)};color:${c.color}`, btnStyle: `padding:6px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit`, onOpen: () => this.openFolderDoc(f) }; });
    const libraryCount = libAll.length ? `${libFiles.length} / ${libAll.length} document${libAll.length > 1 ? 's' : ''}` : 'aucun document';
    const libraryFolderName = this.state.folder ? this.state.folder.name : 'Documents de travail';
    const libraryEmpty = libAll.length === 0;
    const hasLibrary = libAll.length > 0;
    const libTypeChips = libTypes.map(name => ({ name, onClick: () => this.setState({ libType: name }), style: libType === name ? `padding:6px 12px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:6px 12px;border-radius:99px;font-size:12px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit' }));
    const onLibSearch = e => this.setState({ libSearch: e.target.value });
    const libSearchStyle = 'flex:1;min-width:200px;padding:9px 12px;border:1px solid #dde3ec;border-radius:9px;font-size:13px;font-family:inherit;color:#0e1b2e;background:#fff';
    const libraryBtnStyle = folderBtnStyle;
    const libraryBtnLabel = this.state.folder ? 'Changer de dossier' : 'Connecter le dossier';
    const libraryHint = folderSupported ? "Choisissez le dossier où sont rangés vos documents (PDF, Word, Excel). Ils sont listés ici et s'ouvrent en un clic — utilisez la recherche pour retrouver un fichier. Tout reste en local, hors ligne." : "L'ouverture de dossier fonctionne sur Chrome ou Edge (ordinateur).";

    // MISE À JOUR TEMPS RÉEL (surveillance des fichiers)
    const watchCount = this.state.watchCount || 0;
    const autoRefresh = this.state.autoRefresh;
    const liveActive = autoRefresh && watchCount > 0;
    const liveDot = liveActive ? '#16a34a' : '#c0c9d6';
    const liveLabel = watchCount === 0 ? 'Aucun fichier surveillé' : autoRefresh ? `Temps réel actif · ${watchCount} fichier${watchCount > 1 ? 's' : ''} surveillé${watchCount > 1 ? 's' : ''}` : `En pause · ${watchCount} fichier${watchCount > 1 ? 's' : ''}`;
    const lastSyncLabel = this.state.lastSync ? `dernière maj ${this.dd(new Date(this.state.lastSync).getHours())}:${this.dd(new Date(this.state.lastSync).getMinutes())}` : '';
    const onToggleAuto = () => this.toggleAutoRefresh();
    const reconnectOpen = (this.state.reconnectCount || 0) > 0;
    const reconnectN = this.state.reconnectCount || 0;
    const reconnectLabel = `Reconnectez vos fichiers/dossiers pour reprendre la mise à jour automatique (${reconnectN} à ré-autoriser).`;
    const onReconnect = () => this.reconnectHandles();
    const reconnectBarStyle = 'display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 24px;background:#fff7ed;border-bottom:1px solid #fbd9b4;font-size:12.5px;color:#b45309;font-weight:500';
    const missingBannerStyle = 'display:flex;align-items:flex-start;gap:8px;padding:10px 14px;background:#fff7ed;border:1px solid #fbd9b4;border-radius:10px;font-size:12px;color:#b45309;font-weight:500;line-height:1.5;margin:10px 20px 0';
    const reconnectBtnStyle = `padding:7px 15px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`;
    const autoToggleStyle = `display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid ${autoRefresh ? this.hexToRgba('#16a34a', 0.4) : '#dbe2ec'};background:${autoRefresh ? '#eafaf0' : '#fff'};color:${autoRefresh ? '#15803d' : '#69788c'}`;
    const liveDotStyle = `width:8px;height:8px;border-radius:50%;background:${liveDot};flex-shrink:0;${liveActive ? 'box-shadow:0 0 0 3px ' + this.hexToRgba('#16a34a', 0.18) : ''}`;
    const liveBadgeStyle = `display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#69788c;font-family:inherit`;

    // OBSERVATIONS (clic droit)
    // ASSISTANT ERREUR (carnet de coquilles, mascotte flottante)
    const errList = this.state.observations || [];
    const errPhrase = o => o.avant != null || o.apres != null ? `J'ai ${o.avant || '—'} au lieu de ${o.apres || '—'}` : (o.text || '');
    const errNotes = errList.map(o => ({ text: errPhrase(o), meta: `page : ${o.where || '—'}${o.when ? ' · ' + o.when : ''}`, onDelete: () => this.removeObservation(o.id) }));
    const hasErr = errList.length > 0, noErr = errList.length === 0;
    const errPanelOpen = !!this.state.errPanelOpen;
    const errAvant = this.state.errAvant || '', errApres = this.state.errApres || '';
    const errWhere = this.state.view;
    const errCount = `${errList.length} erreur${errList.length > 1 ? 's' : ''} notée${errList.length > 1 ? 's' : ''}`;
    const onErrToggle = () => this.toggleErrPanel();
    const onErrAvant = e => this.setState({ errAvant: e.target.value });
    const onErrApres = e => this.setState({ errApres: e.target.value });
    const onErrAdd = () => this.addErrNote();
    const onErrCopy = () => this.copyErrReport();
    const errInputStyle = 'flex:1;min-width:0;box-sizing:border-box;padding:6px 9px;border:1px solid #dde3ec;border-radius:7px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff';
    const errAddStyle = `padding:6px 13px;border-radius:8px;font-size:12px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const errCopyLabel = this.state.errCopied === 'ok' ? '✓ Copié' : (this.state.errCopied === 'err' ? 'Échec' : '📋 Copier pour envoyer');
    const errCopyStyle = `padding:5px 11px;border-radius:8px;font-size:11px;font-weight:600;color:${this.state.errCopied === 'ok' ? '#0e7a46' : '#3a4a5e'};background:#fff;border:1px solid ${this.state.errCopied === 'ok' ? '#9fd6b8' : '#dde3ec'};cursor:pointer;font-family:inherit`;
    const errFabStyle = `position:fixed;right:18px;bottom:18px;width:46px;height:46px;border-radius:50%;border:1px solid #e2e8f1;background:#fff;box-shadow:0 6px 18px -6px rgba(14,27,46,.4);font-size:22px;line-height:1;cursor:pointer;z-index:70;display:flex;align-items:center;justify-content:center;padding:0`;
    const errBadge = errList.length > 9 ? '9+' : String(errList.length);
    const errBadgeStyle = `position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;border-radius:9px;background:#e5484d;color:#fff;font-size:9.5px;font-weight:700;display:flex;align-items:center;justify-content:center;font-family:inherit`;

    // IMPORT — écran de correspondance des colonnes
    const PImp = this.state.pending;
    const importOpen = !!PImp;
    let importTitle = '', importFileName = '', importSheets = [], importSheetValue = '0', importHeaderOptions = [], importHeaderValue = '0', importFieldRows = [], importPreviewHead = [], importPreviewRows = [], importNote = '', importCombine = false, importCombineable = false, importCount = 0, importReady = false;
    if (PImp) {
      const spec = PImp.spec; importTitle = spec.title; importFileName = PImp.name; importNote = spec.note || '';
      importSheets = PImp.wb.map((s, i) => ({ label: `${s.name} (${s.rows.length} lignes)`, value: String(i) }));
      importSheetValue = String(PImp.sheetIdx);
      const rows = PImp.wb[PImp.sheetIdx].rows;
      importHeaderOptions = rows.slice(0, Math.min(rows.length, 20)).map((r, i) => ({ label: `Ligne ${i + 1} : ${r.filter(c => String(c).trim()).slice(0, 5).join(' · ') || '(vide)'}`, value: String(i) }));
      importHeaderValue = String(PImp.headerIdx);
      const hdr = rows[PImp.headerIdx] || [];
      const colOpts = [{ label: '— (aucune) —', value: '-1' }, ...hdr.map((c, i) => ({ label: String(c).trim() || `Colonne ${i + 1}`, value: String(i) }))];
      importFieldRows = spec.fields.map(f => { const cur = PImp.fields[f.key]; const missing = f.req && !(cur >= 0); return { key: f.key, label: f.label + (f.req ? ' *' : ''), value: String(cur == null ? -1 : cur), options: colOpts, onChange: e => this.setPendingField(f.key, e.target.value), rowStyle: 'display:grid;grid-template-columns:190px 1fr;gap:10px;align-items:center;padding:6px 0', selStyle: `width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid ${missing ? '#e6a2a2' : '#dde3ec'};border-radius:8px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:${missing ? '#fdf3f3' : '#fff'}`, labelStyle: `font-size:12.5px;font-weight:${f.req ? 600 : 500};color:${missing ? '#b91c1c' : '#3a4a5e'}` }; });
      importCombineable = !!spec.combineable; importCombine = !!PImp.combine;
      const tsv = this.emitTSV(PImp); const lines = tsv.split('\n'); importPreviewHead = (lines[0] || '').split('\t'); importCount = Math.max(0, lines.length - 1); importPreviewRows = lines.slice(1, 4).map(l => l.split('\t'));
      importReady = spec.fields.filter(f => f.req).every(f => PImp.fields[f.key] >= 0) && importCount > 0;
    }
    const onImportSheet = e => this.setPendingSheet(e.target.value);
    const onImportHeader = e => this.setPendingHeader(e.target.value);
    const onImportCombine = e => this.setPendingCombine(e.target.checked);
    const onImportConfirm = () => this.confirmImport();
    const importZeroWarn = !!this.state.pending && importCount === 0;
    const onImportCancel = () => this.cancelImport();
    const importSelStyle = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #dde3ec;border-radius:8px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff';
    const importOverlayStyle = 'position:fixed;inset:0;z-index:70;background:rgba(14,27,46,.42);display:flex;align-items:center;justify-content:center;padding:24px';
    const importCardStyle = 'width:780px;max-width:100%;max-height:88vh;overflow:auto;background:#fff;border:1px solid #e2e8f1;border-radius:16px;box-shadow:0 30px 60px -24px rgba(14,27,46,.5);font-family:inherit';
    const importConfirmStyle = `padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;color:#fff;background:${importReady ? accent : '#b8c2d0'};border:none;cursor:${importReady ? 'pointer' : 'default'};font-family:inherit`;
    const importCancelStyle = 'padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;color:#69788c;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';

    // nav & titres (help = texte du mode aide pour chaque onglet)
    const NAVHELP = {
      'Tableau de bord': `Vue d'ensemble : chiffres clés de la période, trésorerie, dernières transactions, notes et objectifs.`,
      'Ventes': `Toutes vos factures clients, lues depuis ${hSrcVentes} : montants, statuts Payé/En attente/Retard, dossiers Grenke.`,
      'Relance': `Le suivi de vos paiements clients (comme votre feuille « Suivi des paiements ») : une ligne par facture (ID, n°, client, TTC, avoir, dates, réglé), avec le solde restant calculé et l'état. Saisie et mise à jour manuelles au fil des règlements.`,
      'Grenke': `Les dossiers financés par Grenke. En haut : enregistrement manuel des paiements (Total TTC, 1er et 2e paiement, charges — Restant et Total reçu calculés), alimenté aussi par les ventes Grenke saisies. En bas : les dossiers lus dans la feuille « Grenke » de votre fichier de ventes.`,
      'SaisieCompta': `Saisie des transactions par formulaire (au lieu de taper dans Excel). Deux volets : « Achat pêcheur » (panier multi-espèces, moyen de paiement, chéquier) et « Vente client » (facture complète : HT, TVA, TTC, délai). Chaque saisie remonte automatiquement dans les onglets Ventes / Achat pêche (dédoublonnée par n°), le Suivi de paiement et, si coché, Financement Grenke — sans jamais créer de double.`,
      'Tiers': `Vos clients et fournisseurs classés par volume d'affaires, avec encours (ce qu'ils vous doivent) et dernière opération.`,
      'Achats': `Vos achats aux pêcheurs, lus depuis ${hSrcOps} : montant, payé, et solde restant (le fichier fait foi).`,
      'Factures': `Ce que vous devez à vos fournisseurs, lu depuis ${hSrcFac} (blocs FOURNISSEURS + FOURNISSEURS CRUSTACÉS), avec l'onglet Rapprochement pour comparer à l'export comptable.`,
      'Crédits': `Vos crédits et assurances : capital restant, mensualités, prochaine échéance. C'est la seule page où l'on peut aussi saisir manuellement.`,
      'Banque': `Votre relevé bancaire, rapproché automatiquement de vos achats/ventes/factures, avec catégories de dépenses (camembert).`,
      'Comptabilité analytique': `Marge par espèce de crustacé (lue dans les fichiers Stock hebdomadaires, bloc « Bénéfices » de chaque feuille espèce) + charges fixes et variables que vous composez vous-même en cochant les dépenses du relevé bancaire.`,
      'Stock': `Vos inventaires hebdomadaires lus en continu depuis le dossier Stock connecté : poids total et valorisation par semaine, avec aperçu de chaque fichier.`,
      'Bordereaux': `Bons de livraison et de transport détectés automatiquement dans les dossiers connectés, prêts à ouvrir en un clic.`,
      'Bibliothèque': `Tous les documents (PDF, Word, Excel) de votre dossier de travail connecté, indexés et retrouvables par la recherche.`,
      'Véhicules': `Liste des véhicules, opérations bancaires associées manuellement et pièces jointes conservées localement.`,
      'Heures': `Pointage hebdomadaire de vos employés (saisie manuelle), totaux par semaine et par mois, fiche de présence imprimable avec visas.`,
      'Employés': `Un onglet par employé : heures cumulées par mois, salaire versé (rapproché depuis la banque), fiches de paie et feuilles d'heures signées (par l'employé et le responsable) en pièces jointes. Le salaire se renseigne depuis la Banque : « Lier » le virement de salaire puis « Rapprocher le salaire » (employé + mois).`,
      'Messages': `Messagerie interne entre les profils du tableau de bord : chacun écrit sous son nom, à tout le monde ou à une personne précise. Les messages restent sur cet ordinateur (rien ne part sur Internet) et le nombre de non-lus s'affiche dans le menu.`,
    };
    const NAVGROUPHELP = {
      piloter: `PILOTER — votre poste du matin : le tableau de bord (chiffres clés, trésorerie) et l'agenda de l'entreprise.`,
      saisir: `SAISIR — le point d'entrée unique : enregistrez vos achats pêcheurs et vos ventes. Tout le reste (Ventes, Achat pêche, Stock, Suivi de paiement, Grenke) se remplit à partir d'ici.`,
      ventes: `SUIVRE vos clients : liste des ventes, suivi de paiement, financement Grenke et classement des clients.`,
      achats: `SUIVRE vos fournisseurs et la marchandise : achats aux pêcheurs, factures fournisseurs à payer et le hub Stock (stock actuel · marges par espèce · historique).`,
      finances: `SUIVRE l'argent : rapprochement du relevé bancaire et crédits & assurances.`,
      gestion: `GÉRER l'entreprise : heures et fiches des employés, messagerie interne, bordereaux, bibliothèque de documents et véhicules.`,
    };
    const navGroupDefs = [
      { key: 'piloter', label: 'Piloter', items: [{ name: 'Tableau de bord', view: 'Tableau de bord' }, { name: 'Agenda', view: 'Agenda' }] },
      { key: 'saisir', label: 'Saisie', items: [{ name: 'Saisie comptable', view: 'SaisieCompta' }] },
      { key: 'ventes', label: 'Ventes & clients', items: [{ name: 'Ventes', view: 'Ventes' }, { name: 'Suivi de paiement', view: 'Relance' }, { name: 'Financement Grenke', view: 'Grenke' }, { name: 'Clients', view: 'Tiers' }] },
      { key: 'achats', label: 'Achats & stock', items: [{ name: 'Achat pêche', view: 'Achats' }, { name: 'Facture fournisseur', view: 'Factures' }, { name: 'Stock', view: 'Stock' }, { name: 'Comptabilité analytique', view: 'Comptabilité analytique', hidden: true }] },
      { key: 'finances', label: 'Finances', items: [{ name: 'Banque', view: 'Banque' }, { name: 'Crédits', view: 'Crédits' }] },
      { key: 'gestion', label: 'Gestion', items: [{ name: 'Heures', view: 'Heures' }, { name: 'Employés', view: 'Employés' }, { name: 'Messages', view: 'Messages' }, { name: 'Bordereaux', view: 'Bordereaux' }, { name: 'Bibliothèque', view: 'Bibliothèque' }, { name: 'Véhicules', view: 'Véhicules' }] },
      { key: 'settings', label: '⚙ Paramètres', items: [{ name: 'Paramètres', view: 'Paramètres' }] },
    ];
    // Profil simplifié : seules les pages autorisées apparaissent ; un groupe vidé disparaît.
    const navGroupDefsVisible = isAdminUI ? navGroupDefs
      : navGroupDefs.filter(g => g.key !== 'settings').map(g => ({ ...g, items: g.items.filter(it => profilVoit(it.view)) })).filter(g => g.items.length);
    const navGroupOfView = {};
    navGroupDefsVisible.forEach(g => g.items.forEach(it => { navGroupOfView[it.view] = g.key; }));
    const activeGroupKey = navGroupOfView[view] || 'piloter';
    const msgUnread = this.msgUnreadCount();
    const navGroups = navGroupDefsVisible.map(g => {
      const active = activeGroupKey === g.key;
      const visItems = g.items.filter(it => !it.hidden);
      const hasMessages = visItems.some(it => it.view === 'Messages');
      return {
        name: (hasMessages && msgUnread) ? `${g.label} 💬 ${msgUnread}` : g.label,
        help: NAVGROUPHELP[g.key] || '',
        onClick: () => { const first = visItems[0] || g.items[0]; this.setState({ view: first.view, cat: 'Toutes', q: '', page: 0 }); if (first.view === 'Messages') this.markMessagesRead(); if (first.view === 'SaisieCompta') this.openCompForm(this.state.compTab || 'Achat'); },
        tabStyle: active
          ? `display:block;width:100%;text-align:left;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:600;color:${accent};background:${soft};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`
          : 'display:block;width:100%;text-align:left;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:500;color:#4c5b6e;background:transparent;border:none;cursor:pointer;font-family:inherit;white-space:nowrap',
        subItems: (active && visItems.length > 1) ? visItems.map(it => ({
          name: (it.view === 'Messages' && msgUnread) ? `${it.name} (${msgUnread})` : it.name,
          help: NAVHELP[it.view] || '',
          onClick: () => { this.setState({ view: it.view, cat: 'Toutes', q: '', page: 0 }); if (it.view === 'Messages') this.markMessagesRead(); },
          tabStyle: (view === it.view || (it.view === 'Stock' && view === 'Comptabilité analytique'))
            ? `display:block;width:100%;text-align:left;padding:7px 12px 7px 26px;border-radius:8px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap;margin-top:2px`
            : `display:block;width:100%;text-align:left;padding:7px 12px 7px 26px;border-radius:8px;font-size:12.5px;font-weight:500;color:#8291a5;background:transparent;border:1px solid transparent;cursor:pointer;font-family:inherit;white-space:nowrap;margin-top:2px`,
        })) : [],
      };
    });
    // ---- Mode débutant (visite guidée) ----
    const guideSteps = [
      { title: 'Bienvenue !', text: "Ce tableau de bord lit vos fichiers Excel et les met en forme : rien n'est envoyé sur Internet, tout reste sur votre ordinateur.\nCe guide vous fait visiter chaque page — cliquez sur Suivant, la page change toute seule. Vous pourrez le relancer à tout moment avec le bouton « ? Guide » en haut à droite.", set: { view: 'Tableau de bord' } },
      { title: 'Le tableau de bord', text: "C'est la vue d'ensemble : chiffre d'affaires, achats, marge, puis la trésorerie — on me doit / je dois / en retard.\nChaque chiffre est calculé à partir de vos fichiers, sur la période affichée en haut à droite.", set: { view: 'Tableau de bord' } },
      { title: 'La période', text: "En haut à droite : Cette semaine / Ce mois / Trimestre / Année, et les flèches ◀ ▶ pour reculer ou avancer.\nTous les chiffres et tableaux de la page suivent la période choisie.", set: { view: 'Tableau de bord' } },
      { title: 'Notes et cartes latérales', text: "À droite : une carte Notes (écrivez librement, c'est enregistré automatiquement), vos Objectifs et la Répartition.\nLe petit bouton ▾ sur chaque carte la réduit si elle vous encombre.", set: { view: 'Tableau de bord' } },
      { title: 'Épingler une note sur un chiffre', text: "Sur n'importe quel écran, deux gestes au clic gauche pour laisser une note ou un point à corriger :\n• Clic gauche rapide sur un chiffre, une ligne, un titre → une petite fenêtre s'ouvre : écrivez, puis Enregistrer.\n• Clic gauche maintenu, puis glissez pour entourer une zone (un tableau, un total) — la note est rattachée à ce cadre.\n(Les boutons, onglets et champs restent cliquables normalement : la note ne se déclenche que sur le texte et les chiffres.)\nToutes vos notes se rassemblent dans « Observations & points à corriger », plus bas sur le tableau de bord. Le bouton Copier les exporte en un bloc, à envoyer par e-mail ou message.", set: { view: 'Tableau de bord' } },
      { title: 'Ventes', text: "Toutes vos factures clients : montant HT ou TTC, statut Payé / En attente / Retard.\nUne vente n'est « en retard » que si le délai de paiement du client (colonne de votre fichier) est dépassé.\nLes ventes financées Grenke portent un badge violet.", set: { view: 'Ventes', cat: 'Toutes' } },
      { title: 'Suivi de paiement', text: "L'onglet « Suivi de paiement » (groupe Ventes & clients) reprend votre feuille « Suivi des paiements » : une ligne par facture, avec le solde restant et l'état.\nSaisissez une facture en haut, puis mettez-la à jour au fil des règlements.", set: { view: 'Relance' } },
      { title: 'Financement Grenke', text: "L'onglet « Financement Grenke » (groupe Ventes & clients) regroupe les paiements du financeur : 1er / 2e paiement, reste dû, frais, total reçu.\nCliquez « Lier » sur une ligne pour la rattacher à la bonne facture si le n° ne correspond pas automatiquement.", set: { view: 'Grenke' } },
      { title: 'Achat pêche', text: "Vos achats aux pêcheurs : montant, payé, solde restant.\nLe fichier source est le même que celui que vous tenez déjà — le tableau ne fait que le lire.", set: { view: 'Achats', cat: 'Toutes' } },
      { title: 'Facture fournisseur', text: "Le suivi de ce que VOUS devez : échéances, reste à payer.\nL'onglet Rapprochement compare votre registre avec l'export comptable et signale les écarts ou les factures manquantes.", set: { view: 'Factures', facTab: 'Factures' } },
      { title: 'Crédits & assurances', text: "Vos engagements en cours : capital restant, mensualités, prochaine échéance.\nAjoutez ou modifiez un crédit directement ici — c'est la seule page où l'on saisit manuellement.", set: { view: 'Crédits' } },
      { title: 'Rapprochement bancaire', text: "Importez le relevé de votre banque (CSV ou Excel) : chaque ligne est comparée automatiquement à vos achats, ventes, factures et crédits — même montant, date proche, nom ou n° de facture dans le libellé.\nEn haut, les filtres (Toutes · À traiter · Rapprochées…) et la recherche affinent la liste.", set: { view: 'Banque' } },
      { title: 'Banque — les options de chaque ligne', text: "À droite de chaque ligne du relevé, trois boutons :\n• ✓ Valider — accepte la proposition automatique de rapprochement.\n• Lier — ouvre une fenêtre pour choisir vous-même la facture ou l'opération correspondante.\n• 🗑 — masque la ligne (frais bancaires, virement interne, doublon).\nCe qui est ambigu reste en « À confirmer » : vous ne traitez que ces quelques lignes, le reste se fait automatiquement.", set: { view: 'Banque' } },
      { title: 'Banque — changer les intitulés (catégories)', text: "Colonne Catégorie : cliquez sur l'étiquette d'une ligne (celle avec le ▾) pour la changer — Carburant, Salaires, Frais bancaires…\nDans la fenêtre : « Appliquer à cette ligne » ne modifie que celle-ci ; le bouton ⧉ « libellés identiques » mémorise « ce libellé → cette catégorie » et l'applique aussi aux prochains imports.\n« + Nouvelle catégorie » vous permet d'en créer une. Ces catégories alimentent le camembert « Dépenses par catégorie » en haut de la page.", set: { view: 'Banque' } },
      { title: 'Stock', text: "Connectez le dossier où vous déposez vos inventaires hebdomadaires (fichiers commençant par « Stock »).\nChaque nouveau fichier déposé dans le dossier apparaît automatiquement, avec le poids et la valorisation par semaine.", set: { view: 'Stock' } },
      { title: 'Bordereaux (BL & transport)', text: "Deux dossiers à connecter : bordereaux de livraison, et bordereaux transporteurs (Chronopost, Heppner…).\nLes fichiers déposés y sont détectés automatiquement et listés ici, prêts à ouvrir en un clic.", set: { view: 'Bordereaux' } },
      { title: 'Bibliothèque', text: "Connectez votre dossier de travail : tous vos documents (PDF, Word, Excel) y sont indexés et retrouvables par la recherche.\nUn nouveau document apparaît après un clic sur « Réindexer ».", set: { view: 'Bibliothèque' } },
      { title: 'Paramètres — où mettre vos fichiers', text: "LA page importante : reliez ici chaque fichier Excel (ventes, achats pêcheurs, factures, crédits…) et chaque dossier (stock, bordereaux).\nUne fois relié, le fichier est surveillé : vous enregistrez dans Excel → le tableau se met à jour en quelques secondes.\nLe mode démo se désactive ici quand vos vrais fichiers sont en place.", set: { view: 'Paramètres' } },
      { title: 'C\'est tout !', text: "Ordre conseillé pour démarrer :\n1. Paramètres → relier votre fichier de ventes\n2. Relier achats pêcheurs et factures fournisseurs\n3. Connecter les dossiers stock et bordereaux\n4. Désactiver le mode démo.\nRelancez ce guide quand vous voulez avec « ? Guide ».", set: { view: 'Tableau de bord' } },
    ];
    const gs = this.state.guideStep;
    const guideOn = gs != null && gs >= 0 && gs < guideSteps.length;
    const gCur = guideOn ? guideSteps[gs] : null;
    const applyStep = i => { const st = guideSteps[i]; this.setState({ guideStep: i, q: '', page: 0, ...st.set }); };
    const endGuide = () => { this.setState({ guideStep: null }); try { localStorage.setItem('avGuideSeen', '1'); } catch (e) {} };
    const onGuideStart = () => applyStep(0);
    const onGuideNext = () => { if (gs >= guideSteps.length - 1) endGuide(); else applyStep(gs + 1); };
    const onGuidePrev = () => { if (gs > 0) applyStep(gs - 1); };
    const onGuideClose = endGuide;
    const guideTitle = gCur ? gCur.title : '';
    const guideText = gCur ? gCur.text : '';
    const guideCount = guideOn ? `étape ${gs + 1} / ${guideSteps.length}` : '';
    const guidePct = guideOn ? Math.round((gs + 1) / guideSteps.length * 100) + '%' : '0%';
    const guideNextLabel = guideOn && gs >= guideSteps.length - 1 ? 'Terminer ✓' : 'Suivant ▶';
    const guidePrevStyle = `padding:8px 14px;border-radius:9px;font-size:12.5px;font-weight:600;color:${gs > 0 ? '#c6d2e2' : 'rgba(255,255,255,.25)'};background:transparent;border:1px solid rgba(255,255,255,${gs > 0 ? '.25' : '.1'});cursor:${gs > 0 ? 'pointer' : 'default'};font-family:inherit`;
    const guideBtnStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${guideOn ? '#fff' : accent};background:${guideOn ? accent : '#fff'};border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const onGear = () => this.setState({ view: 'Paramètres' });
    const onDisconnect = () => this.setState({ whoOpen: true, profilMenuOpen: false });
    const gearStyle = `padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:${isSettings ? '#fff' : accent};background:${isSettings ? accent : '#fff'};border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const facSub = { 'Factures': 'suivi & encours', 'Crédits': 'crédits & assurances', 'Rapprochement': 'contrôle registre ↔ export' }[this.state.facTab];

    const brandStyle = `width:36px;height:36px;border-radius:9px;background:${accent};color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;letter-spacing:-.5px;flex-shrink:0`;

    // MODE DÉMO, états vides & invite de préfixe
    const stockEmpty = stockRaw.length === 0;
    const blEmpty = blRaw.length === 0;
    const facturesEmpty = F.length === 0;
    const dashEmpty = filtered.length === 0;
    const emptyStyle = 'padding:40px 20px;text-align:center;color:#8a97a8;font-size:13px;line-height:1.7;border-top:1px solid #f1f4f8';
    const emptyBtnStyle = `margin-top:12px;padding:8px 16px;border-radius:9px;font-size:12.5px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const onGoImport = () => this.setState({ view: 'Paramètres' });

    // ---- RAPPROCHEMENT BANCAIRE ----
    const bankRaw = this.state.banque || (demo ? C.BANQUE.map(a => ({ y: a[0], m: a[1], d: a[2], label: a[3], amt: a[4], solde: a[5] != null ? a[5] : null })) : []);
    const bankHiddenM = this.state.bankHidden || {};
    const bankLinksM = this.state.bankLinks || {};
    const bankCatsM = this.state.bankCats || {};
    const bankCatRulesM = this.state.bankCatRules || {};
    const bankCatMerged = [...C.BANK_CATS, ...((this.state.bankCatList || []).filter(c => !C.BANK_CATS.includes(c)))];
    const bankCatPalette = ['#1a56db', '#0e7a46', '#b45309', '#7e22ce', '#0f766e', '#b91c1c', '#4338ca', '#a16207', '#be185d', '#334155', '#57534e', '#2563eb', '#94a3b8'];
    const catColor = c => { const i = bankCatMerged.indexOf(c); return i >= 0 ? bankCatPalette[i % bankCatPalette.length] : '#94a3b8'; };
    const bankCatOpts = [...bankCatMerged, '+ Nouvelle catégorie…'];
    // candidats internes + rapprochement (calcul O(lignes × candidats), le plus lourd de la page) :
    // mémoïsé sur les données sources — inchangé lors d'une frappe de recherche ou d'un changement de période.
    const bankMemo = this._memo('bank', [
      this.state.banque, this.state.ventes, this.state.ops, this.state.hiddenOps,
      this.state.factures, this.state.credits, this.state.bankLinks, this.state.bankHidden,
      this.state.bankCats, this.state.bankCatRules, this.state.demoMode,
    ], () => {
      const bankCands = []; const _seenRef = {};
      ops.forEach(r => { const signed = r.type === 'Achat' ? -Math.abs(r.amt) : Math.abs(r.amt); _seenRef[this.nrm(r.ref)] = 1; bankCands.push({ kind: r.type, ref: r.ref, partner: r.partner, signed, days: this.days(r), dLabel: `${this.dd(r.d)}/${this.dd(r.m)}/${r.y}` }); });
      F.forEach(f => { if (_seenRef[this.nrm(f.ref)]) return; const signed = f.sens === 'Fournisseur' ? -Math.abs(f.ttc) : Math.abs(f.ttc); const o = f.dueO || f.em; bankCands.push({ kind: 'Facture', ref: f.ref, partner: f.partner, signed, days: this.days(o), dLabel: `${this.dd(o.d)}/${this.dd(o.m)}/${o.y}` }); });
      credits.forEach(cr => { if (!cr.mens) return; const o = cr.next ? this.pIso(cr.next) : C.TODAY; bankCands.push({ kind: 'Crédit', ref: '', partner: `${cr.label}${cr.ent ? ' — ' + cr.ent : ''}`, signed: -Math.abs(cr.mens), days: this.days(o), dLabel: 'mensualité' }); });
      const bankMatchRows = bankRaw.map(b => {
        const key = this.bankKey(b);
        const hits = this.bankMatch(b, bankCands);
        const manual = bankLinksM[key];
        let status, match = null, ambiguous = false, sameAmt = hits.length;
        if (manual === 'none') status = 'none';
        else if (manual) { status = 'manual'; match = bankCands.find(c => c.ref === manual.ref && c.kind === manual.kind && (manual.ref || c.partner === manual.partner)) || { kind: manual.kind, ref: manual.ref, partner: manual.partner || '', dLabel: '' }; }
        else if (hits.length) {
          const top = hits[0];
          const strong = top.sc >= 4;                                   // nom OU n° de facture reconnu dans le libellé
          const clearGap = hits.length === 1 || (top.sc - hits[1].sc >= 2);
          // Montant unique dans vos écritures + date plausible (ou inconnue) ⇒ très probable : on
          // rapproche seul, même sans nom/n° dans le libellé (résout les lignes « à confirmer » à tort).
          const uniquePlausible = hits.length === 1 && (!isFinite(top.dd) || top.dd <= 60);
          if ((strong && clearGap) || uniquePlausible) { status = 'auto'; match = top.c; }
          else {
            // Plusieurs candidats au MÊME montant, sans nom/n° pour trancher : on NE devine pas
            // (c'est ce qui rattachait à la mauvaise facture). On signale l'ambiguïté et on force « Lier ».
            ambiguous = hits.length > 1 && !strong;
            status = 'confirm'; match = ambiguous ? null : top.c;
          }
        } else status = 'none';
        return { b, key, status, match, ambiguous, sameAmt, hidden: !!bankHiddenM[key], cat: this.resolveBankCat(b, match, bankCatRulesM, bankCatsM) };
      });
      return { bankCands, bankMatchRows };
    });
    const bankCands = bankMemo.bankCands, bankMatchRows = bankMemo.bankMatchRows;
    // ============ EMPLOYÉS : heures mensuelles + salaires issus du rapprochement bancaire + fiches de paie ============
    const EMP_MON = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const empMonLabel = ym => { const p = String(ym).split('-'); return p[1] ? `${EMP_MON[(+p[1]) - 1]} ${p[0]}` : ym; };
    // Bloc Employés : calculé uniquement quand l'onglet est ouvert (évite d'itérer roster × mois à chaque rendu ailleurs).
    let empCards = [], empEmpty = true, empGrandHours = this.hFmtH(0), empGrandSalaire = this.fmt(0);
    if (isEmployes) {
    const empHoursMap = this._memo('empHours', [this.state.heures], () => this.empHoursByMonth());
    const empDocsM = this.state.empDocs || {};
    // Salaires depuis la banque : chaque ligne rapprochée en « Salaire » alimente (employé, mois).
    const empSalaryMap = {}; // 'name|AAAA-MM' -> { montant, dates:[] }
    bankRaw.forEach(b => { const lk = bankLinksM[this.bankKey(b)]; if (lk && typeof lk === 'object' && lk.kind === 'Salaire' && lk.emp && lk.month) { const dk = String(lk.emp).trim() + '|' + lk.month; const e = empSalaryMap[dk] || (empSalaryMap[dk] = { montant: 0, dates: [] }); e.montant += Math.abs(b.amt || 0); e.dates.push(`${this.dd(b.d)}/${this.dd(b.m)}/${b.y}`); } });
    const empRoster = (this.state.hRoster && this.state.hRoster.length) ? this.state.hRoster.filter((n, i, a) => n && a.indexOf(n) === i) : [];
    empCards = empRoster.map(name => {
      const nm = String(name).trim();
      const months = {};
      Object.keys(empHoursMap).forEach(k => { const [n, mo] = k.split('|'); if (n === nm) months[mo] = 1; });
      Object.keys(empSalaryMap).forEach(k => { const [n, mo] = k.split('|'); if (n === nm) months[mo] = 1; });
      Object.keys(empDocsM).forEach(k => { const [n, mo] = k.split('|'); if (n === nm) months[mo] = 1; });
      const monthList = Object.keys(months).sort().reverse();
      let totH = 0, totS = 0;
      const rows = monthList.map(mo => {
        const dk = nm + '|' + mo;
        const h = empHoursMap[dk] || 0; totH += h;
        const sal = empSalaryMap[dk]; const salMontant = sal ? sal.montant : 0; totS += salMontant;
        const mkDoc = (a, color) => ({ id: a.id, name: a.name, style: `padding:5px 10px;border-radius:7px;font-size:11.5px;font-weight:600;color:${color};background:#fff;border:1px solid ${this.hexToRgba(color, 0.3)};cursor:pointer;font-family:inherit`, onOpen: () => this.openEmpDoc(nm, mo, a), delStyle: 'padding:5px 7px;border-radius:7px;font-size:11px;color:#b91c1c;background:#fff;border:1px solid #f1d4d4;cursor:pointer;font-family:inherit', onDel: () => this.setState({ empDelDoc: { name: nm, month: mo, att: a } }) });
        const allDocs = empDocsM[dk] || [];
        const docsPaie = allDocs.filter(a => a.kind !== 'heures').map(a => mkDoc(a, accent));
        const docsHeures = allDocs.filter(a => a.kind === 'heures').map(a => mkDoc(a, '#0f766e'));
        return {
          month: mo, monthLabel: empMonLabel(mo),
          hours: this.hFmtH(h), hoursZero: h < 1e-9,
          salaire: sal ? this.fmt(salMontant) : '—', salaireKnown: !!sal,
          paidLabel: sal ? `✓ Payé (${sal.dates.join(', ')})` : '○ En attente de rapprochement',
          paidStyle: sal ? `${badge}background:#e7f5ec;color:${green}` : `${badge}background:#fff4e5;color:#b45309`,
          docsPaie, docsHeures,
          onAttach: () => this.pickEmpDoc(nm, mo, 'paie'),
          onAttachHeures: () => this.pickEmpDoc(nm, mo, 'heures'),
          attachStyle: `padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap`,
          attachHeuresStyle: `padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;color:#0f766e;background:#fff;border:1px solid ${this.hexToRgba('#0f766e', 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap`,
        };
      });
      return { name: nm, initials: (nm.split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '·').toUpperCase(), rows, empty: rows.length === 0, totalHours: this.hFmtH(totH), totalSalaire: this.fmt(totS), monthsCount: `${rows.length} mois` };
    });
    empEmpty = empRoster.length === 0;
    empGrandHours = this.hFmtH(Object.values(empHoursMap).reduce((s, v) => s + v, 0));
    empGrandSalaire = this.fmt(Object.values(empSalaryMap).reduce((s, v) => s + (v.montant || 0), 0));
    }
    const empDelDoc = this.state.empDelDoc;
    const empDelDocOpen = !!empDelDoc;
    const empDelDocName = empDelDoc ? empDelDoc.att.name : '';
    const onEmpDelDocConfirm = () => { if (empDelDoc) this.deleteEmpDoc(empDelDoc.name, empDelDoc.month, empDelDoc.att); };
    const onEmpDelDocCancel = () => this.setState({ empDelDoc: null });
    const empAddNote = "Les employés proviennent de l'onglet Heures. Ajoutez-y une personne pour la voir apparaître ici.";
    const bankVisible = bankMatchRows.filter(r => !r.hidden);
    const bankHiddenCount = bankMatchRows.length - bankVisible.length;
    const bankAutoN = bankVisible.filter(r => r.status === 'auto').length;
    const bankManualN = bankVisible.filter(r => r.status === 'manual').length;
    const bankConfirmN = bankVisible.filter(r => r.status === 'confirm').length;
    const bankNoneN = bankVisible.filter(r => r.status === 'none').length;
    const bankTodoN = bankConfirmN + bankNoneN;
    const bankSolde = bankVisible.reduce((s, r) => s + r.b.amt, 0);
    const bankStats = [
      { label: 'Rapprochées', value: String(bankAutoN + bankManualN), sub: `${bankAutoN} auto · ${bankManualN} validée${bankManualN > 1 ? 's' : ''}`, color: green, bar: green },
      { label: 'À confirmer', value: String(bankConfirmN), sub: 'proposition à valider ✓', color: '#b45309', bar: '#d97706' },
      { label: 'Non rapprochées', value: String(bankNoneN), sub: 'à lier ou à masquer 🗑', color: bankNoneN ? red : gray, bar: bankNoneN ? red : '#c9d2de' },
      { label: 'Mouvements du relevé', value: this.fmt(bankSolde), sub: `${bankVisible.length} ligne${bankVisible.length > 1 ? 's' : ''} affichée${bankVisible.length > 1 ? 's' : ''}`, color: '#0e1b2e', bar: accent },
    ];
    bankStats.forEach(k => { if (HELP[k.label]) k.help = HELP[k.label]; });
    const bankFilterS = this.state.bankFilter || 'Toutes';
    const bankChips = ['Toutes', 'À traiter', 'Rapprochées', 'Encaissements', 'Décaissements'].map(name => ({ name, onClick: () => this.setState({ bankFilter: name, page: 0 }), style: bankFilterS === name ? `padding:6px 12px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:${accent};border:1px solid ${accent};cursor:pointer;font-family:inherit` : 'padding:6px 12px;border-radius:99px;font-size:12px;font-weight:500;color:#5b6b7f;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit' }));
    const bankQv = this.state.bankQ || '';
    const bankNorm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const bankFiltered = bankVisible.filter(r => {
      if (bankFilterS === 'À traiter' && r.status !== 'confirm' && r.status !== 'none') return false;
      if (bankFilterS === 'Rapprochées' && r.status !== 'auto' && r.status !== 'manual') return false;
      if (bankFilterS === 'Encaissements' && r.b.amt <= 0) return false;
      if (bankFilterS === 'Décaissements' && r.b.amt >= 0) return false;
      if (bankQv) { const q = bankNorm(bankQv); const hay = bankNorm(`${r.b.label} ${r.match ? r.match.ref + ' ' + r.match.partner : ''} ${r.b.amt}`); if (!hay.includes(q)) return false; }
      return true;
    });
    const kindBadge = k => k === 'Vente' ? `${badge}background:#e7f5ec;color:${green}` : k === 'Achat' ? `${badge}background:${this.hexToRgba(accent, 0.1)};color:${accent}` : k === 'Facture' ? `${badge}background:#f3e8ff;color:#7e22ce` : `${badge}background:#eef1f5;color:${slate}`;
    const bankBtn = `padding:5px 11px;border-radius:7px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const bankPager = paginate(bankFiltered);
    const bankTableRows = bankPager.slice.map(r => {
      const b = r.b, m = r.match;
      const stMap = {
        auto: { t: '✓ Auto', s: `${badge}background:#e7f5ec;color:${green}` },
        manual: { t: '✓ Validé', s: `${badge}background:${this.hexToRgba(accent, 0.12)};color:${accent}` },
        confirm: { t: '? À confirmer', s: `${badge}background:#fef3c7;color:#b45309` },
        none: { t: 'Non rapproché', s: `${badge}background:#fdeaea;color:${red}` },
      }[r.status];
      const st = r.ambiguous
        ? { t: `⚠ ${r.sameAmt} au même montant`, s: `${badge}background:#fdeaea;color:${red}` }
        : stMap;
      // Proposition affichée seulement si non ambiguë : sinon on invite à choisir via « Lier ».
      const showMatch = m && !r.ambiguous;
      return {
        date: `${this.dd(b.d)}/${this.dd(b.m)}/${String(b.y).slice(2)}`,
        label: b.label,
        amt: this.fmt(b.amt), amtColor: b.amt >= 0 ? green : '#0e1b2e',
        status: st.t, statusStyle: st.s,
        kind: showMatch ? m.kind : (r.ambiguous ? '' : '—'), kindStyle: showMatch ? kindBadge(m.kind) : 'color:#c1cad6;font-size:12px',
        mref: showMatch && m.ref ? m.ref : '', mrefStyle: showMatch && m.ref ? 'color:#0e1b2e' : 'display:none',
        mpartner: showMatch ? (m.partner || '') : (r.ambiguous ? 'plusieurs factures — cliquez « Lier » pour choisir' : ''),
        // Pas de validation en un clic quand c'est ambigu : on force le choix manuel via « Lier ».
        confirmStyle: (r.status === 'confirm' && !r.ambiguous) ? `padding:5px 11px;border-radius:7px;font-size:12px;font-weight:700;color:#fff;background:${green};border:none;cursor:pointer;font-family:inherit;white-space:nowrap` : 'display:none',
        onConfirm: () => this.setBankLink(r.key, { ref: m ? m.ref : '', kind: m ? m.kind : '', partner: m ? m.partner : '' }),
        linkLabel: r.status === 'auto' || r.status === 'manual' ? 'Modifier' : 'Lier',
        linkStyle: bankBtn,
        onLink: () => this.setState({ bankLink: { key: r.key, label: b.label, amt: b.amt, date: `${this.dd(b.d)}/${this.dd(b.m)}/${b.y}`, month: `${b.y}-${this.dd(b.m)}` }, bankLinkQuery: '', bankSalaryEmp: (this.state.hRoster || [])[0] || '', bankSalaryMonth: `${b.y}-${this.dd(b.m)}` }),
        trashStyle: 'padding:5px 9px;border-radius:7px;font-size:12px;color:#b91c1c;background:#fff;border:1px solid #f1d4d4;cursor:pointer;font-family:inherit',
        onTrash: () => this.setState({ trashAsk: { kind: 'bank', key: r.key, label: `${b.label} (${this.fmt(b.amt)})` } }),
        cat: r.cat,
        catDot: catColor(r.cat),
        catStyle: 'display:flex;align-items:center;gap:6px;max-width:160px;min-width:0;padding:5px 10px;border-radius:99px;font-size:11.5px;font-weight:500;font-family:inherit;color:#3a4a5e;background:#fff;border:1px solid #dde3ec;cursor:pointer',
        onCatOpen: () => this.setState({ bankCatPick: { key: r.key, label: b.label, sel: r.cat, date: `${this.dd(b.d)}/${this.dd(b.m)}/${b.y}`, amt: b.amt } }),
      };
    });
    const bankCount = `${bankFiltered.length} ligne${bankFiltered.length > 1 ? 's' : ''}${this.state.banqueName ? ' · ' + this.state.banqueName : demo && bankRaw.length ? ' · démo' : ''}`;
    const bankEmpty = bankRaw.length === 0;
    const bankNoResult = !bankEmpty && bankFiltered.length === 0;
    const bankSearchStyle = 'width:230px;padding:7px 11px;border:1px solid #dbe2ec;border-radius:9px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff';
    const onBankQ = e => this.setState({ bankQ: e.target.value, page: 0 });
    const hiddenBankChip = { show: bankHiddenCount > 0, label: `${bankHiddenCount} ligne${bankHiddenCount > 1 ? 's' : ''} masquée${bankHiddenCount > 1 ? 's' : ''} · Rétablir`, onClick: () => this.restoreHidden('bank'), style: hiddenChipStyle };
    // camembert des dépenses (repliable)
    const bankExp = bankVisible.filter(r => r.b.amt < 0);
    const expByCat = {}; bankExp.forEach(r => { expByCat[r.cat] = (expByCat[r.cat] || 0) + Math.abs(r.b.amt); });
    const expEntries = Object.entries(expByCat).sort((a, z) => z[1] - a[1]);
    // ============ COMPTABILITÉ ANALYTIQUE — Crustacés (branchée sur les vraies données) ============
    // Charges fixes / variables composables : l'utilisatrice coche elle-même, parmi les dépenses du
    // relevé bancaire, celles qui constituent chaque groupe. Le cochage se fait par LIBELLÉ normalisé
    // (bankLabelKey) : cocher « LOYER … » une fois couvre aussi tous les prélèvements suivants au même
    // libellé, sans re-cocher chaque mois. Détail Stock par espèce : les fichiers hebdomadaires sont
    // des photos ponctuelles — on affiche le dernier fichier connu comme un instantané daté.
    const chargeGroupsMap = {};
    bankExp.forEach(r => {
      const key = this.bankLabelKey(r.b.label) || '(sans libellé)';
      const g = chargeGroupsMap[key] = chargeGroupsMap[key] || { key, label: r.b.label, count: 0, totalAll: 0, totalPeriod: 0 };
      g.count++; g.totalAll += Math.abs(r.b.amt);
      if (inSelPeriod(r.b)) g.totalPeriod += Math.abs(r.b.amt);
    });
    const chargeGroups = Object.values(chargeGroupsMap).sort((a, b) => b.totalAll - a.totalAll);
    const chargesSel = this.state.chargesSel || (demo ? C.DEMO_CHARGES_SEL : { fixe: [], variable: [] });
    const chargeTotals = { fixe: 0, variable: 0 };
    ['fixe', 'variable'].forEach(gr => { (chargesSel[gr] || []).forEach(k => { const g = chargeGroupsMap[k]; if (g) chargeTotals[gr] += g.totalPeriod; }); });
    const caStockList = this.state.stockEspeces || (demo ? C.DEMO_STOCK_ESPECES : []);
    const caSnapshot = caStockList[0] || null;
    // Phase 2 — marge semaine par semaine + observations (tempête, etc.)
    const stockObs = (this.state.stockObs && typeof this.state.stockObs === 'object') ? this.state.stockObs : {};
    const caWeekly0 = caStockList.map(w => { let vca = 0, vcout = 0; Object.values(w.bySpecies || {}).forEach(d => { if (d && !d.missing) { vca += (+d.valeurVendu || 0); vcout += (+d.valeurAchat || 0); } }); const key = w.file || w.sem || ''; return { key, label: w.sem || w.file || '—', marge: Math.round((vca - vcout) * 100) / 100 }; });
    const caWkMax = Math.max(1, ...caWeekly0.map(w => Math.abs(w.marge)));
    const caWeekList = caWeekly0.map(w => ({ key: w.key, label: w.label, marge: this.fmt(w.marge), pct: Math.round(Math.abs(w.marge) / caWkMax * 100) + '%', color: w.marge >= 0 ? green : '#b91c1c', obs: stockObs[w.key] || '', onObs: e => this.setStockObs(w.key, e.target.value) }));
    const caWeeklyShow = caWeekList.length > 0;
    const caSpeciesOrder = entCfg.especes; // liste configurable dans Paramètres → Entreprise
    // « Tout le stock sur une page » : une ligne PAR PRODUIT (les feuilles multi-produits comme
    // VEL-BQ-AR sont éclatées en Velvet-crab / Bouquet / Araignée). Chaque ligne porte son ÉTAT.
    const stBadge = st => ({
      confirme: { t: 'Confirmé', c: '#15803d', bg: '#e7f5ec' },
      recoupe: { t: 'Recoupé', c: '#15803d', bg: '#e7f5ec' },
      zero: { t: 'Zéro', c: '#8291a5', bg: '#eef1f6' },
      invalide: { t: 'Réf. invalide', c: '#b91c1c', bg: '#fdecec' },
    })[st] || { t: '—', c: '#8291a5', bg: '#eef1f6' };
    const kg1 = n => (Math.round(n * 10) / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' kg'; // poids au 0,1 kg près (comme le fichier)
    const caDetail = this.state.caDetail || {};
    const nameStyleMain = 'font-weight:500;min-width:0;display:flex;flex-direction:column;gap:2px';
    const nameStyleCal = 'font-weight:400;min-width:0;padding-left:16px;color:#69788c;display:flex;flex-direction:column;gap:1px';
    const detailBtnStyle = `align-self:flex-start;margin-top:3px;padding:2px 9px;border-radius:20px;font-size:10.5px;font-weight:600;color:${accent};background:${this.hexToRgba(accent, 0.09)};border:1px solid ${this.hexToRgba(accent, 0.25)};cursor:pointer;font-family:inherit`;
    const editBtnStyle = 'align-self:flex-start;margin-top:3px;padding:2px 9px;border-radius:20px;font-size:10.5px;font-weight:600;color:#69788c;background:#f2f5f9;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    const caEditFile = (this.state.stockEspeces && caSnapshot) ? caSnapshot.file : null; // fichier Stock réel connecté (pas en démo)
    const caProductRows = [];
    if (caSnapshot) caSpeciesOrder.forEach(name => {
      const d = (caSnapshot.bySpecies || {})[name];
      if (!d || d.missing) {
        caProductRows.push({
          name, sheet: '', missing: true, isCalibre: false, hasDetail: false, badgeShown: true, nameStyle: nameStyleMain,
          reason: (d && d.reason) || 'donnée absente', cardClass: 'missing-hatch',
          acheteKg: '—', valAchat: '—', venduKg: '—', valVendu: '—', marge: '—', margeColor: slate,
          badgeText: 'Absent', badgeColor: '#8291a5', badgeBg: '#eef1f6',
          help: `Donnée manquante pour ${name} : ${(d && d.reason) || 'feuille absente'}. Lecture dans le bloc « RESUME BENEFICES » de la feuille « ${name} ».`,
        });
        return;
      }
      let prods = d.products;
      if (!prods) { // repli (démo / ancien format) : un seul produit reconstitué
        const av = d.valeurAchat != null ? d.valeurAchat : (d.poidsAchete != null && d.prixAchat != null ? d.poidsAchete * d.prixAchat : null);
        const vv = d.valeurVendu != null ? d.valeurVendu : (d.poidsVendu != null && d.prixVente != null ? d.poidsVendu * d.prixVente : null);
        prods = [{ name, achatPoids: d.poidsAchete, achatValeur: av, venduPoids: d.poidsVendu, venduValeur: vv, benefice: (av != null && vv != null) ? vv - av : null, state: 'confirme' }];
      }
      const multi = prods.length > 1;
      const fmtRow = (p, isCalibre) => {
        const b = stBadge(p.state);
        return {
          name: p.name, missing: false, isCalibre,
          acheteKg: p.achatPoids != null ? kg1(p.achatPoids) : '—',
          valAchat: p.achatValeur != null ? this.fmt(p.achatValeur) : '—',
          venduKg: p.venduPoids != null ? kg1(p.venduPoids) : '—',
          valVendu: p.venduValeur != null ? this.fmt(p.venduValeur) : '—',
          marge: p.benefice != null ? this.fmt(p.benefice) : '—',
          margeColor: p.benefice != null ? (p.benefice >= 0 ? green : red) : slate,
          badgeText: b.t, badgeColor: b.c, badgeBg: b.bg,
          cardClass: p.state === 'invalide' ? 'missing-hatch' : '',
        };
      };
      prods.forEach(p => {
        const cals = Array.isArray(p.calibres) ? p.calibres : [];
        const hasDetail = cals.length > 0;
        const open = !!caDetail[name];
        caProductRows.push({
          ...fmtRow(p, false),
          sheet: multi ? name : '', nameStyle: nameStyleMain, badgeShown: true,
          hasDetail, detailOpen: open, detailBtnStyle,
          detailLabel: open ? `▾ calibres` : `▸ ${cals.length} calibres`,
          onDetail: () => this.setState({ caDetail: { ...caDetail, [name]: !open } }),
          canEdit: !!caEditFile, editBtnStyle, onEditSource: caEditFile ? () => this.openStockSpecies(caEditFile, name) : null,
          help: `Feuille « ${name} »${multi ? ' · sous-produit ' + p.name : ''}, bloc « RESUME BENEFICES ». ` + (d.structure === 'A' ? 'Chiffres lus dans les colonnes de GRAND TOTAL (POIDS TOTAL / PRIX TOTAL) — jamais la somme des calibres. Cliquez « calibres » pour le détail.' : 'Sous-produits lus séparément (poids et prix total de chaque bloc).') + ' Marge = valeur vendue − valeur d’achat. « ✎ Modifier » ouvre le fichier Excel sur cette feuille.',
        });
        if (hasDetail && open) cals.forEach(cb => caProductRows.push({
          ...fmtRow(cb, true), sheet: '', nameStyle: nameStyleCal, hasDetail: false, badgeShown: false,
          canEdit: !!caEditFile, editBtnStyle, onEditSource: caEditFile ? () => this.openStockSpecies(caEditFile, name) : null,
          help: `Calibre « ${cb.name} » de ${name} (ligne du bloc RESUME BENEFICES). « ✎ Modifier » ouvre le fichier Excel sur la feuille ${name} pour corriger la valeur à la source.`,
        }));
      });
    });
    const caChargeCards = [
      { group: 'fixe', label: 'Charges fixes', desc: 'loyer, EDF, assurances, abonnements…' },
      { group: 'variable', label: 'Charges variables', desc: 'achats, transport, emballages…' },
    ].map(c => {
      const selKeys = chargesSel[c.group] || [];
      const missing = !selKeys.length ? 'aucune dépense cochée — cliquez sur Choisir' : (chargeTotals[c.group] <= 0 ? 'rien sur cette période pour les dépenses cochées' : null);
      return {
        ...c,
        value: missing ? '—' : this.fmt(chargeTotals[c.group]),
        note: missing || `${selKeys.length} libellé${selKeys.length > 1 ? 's' : ''} coché${selKeys.length > 1 ? 's' : ''} · ${periodLabel}`,
        cardClass: missing ? 'missing-hatch' : '',
        missing,
        onPick: () => this.setState({ chargesPickOpen: c.group, chargesPickQ: '' }),
        pickStyle: `padding:6px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.3)};cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0`,
        help: `Total, sur la période affichée, des dépenses bancaires que VOUS avez cochées comme « ${c.label} » (bouton Choisir). Le cochage se fait par libellé : cocher « LOYER » une fois compte automatiquement tous les prélèvements au même libellé, y compris les mois suivants.`,
      };
    });
    const chargesPickGroup = this.state.chargesPickOpen;
    const chargesPickTitle = chargesPickGroup === 'fixe' ? 'Choisir les charges fixes' : 'Choisir les charges variables';
    const chargesPickQ = this.state.chargesPickQ || '';
    const onChargesPickQ = e => this.setState({ chargesPickQ: e.target.value });
    const onChargesPickClose = () => this.setState({ chargesPickOpen: null });
    const chargesOtherGroup = chargesPickGroup === 'fixe' ? 'variable' : 'fixe';
    const chargesOtherLabel = chargesOtherGroup === 'fixe' ? 'Charges fixes' : 'Charges variables';
    const chargesPickItems = chargesPickGroup ? chargeGroups
      .filter(g => !chargesPickQ || this._norm(g.label).includes(this._norm(chargesPickQ)))
      .map(g => {
        const checked = (chargesSel[chargesPickGroup] || []).includes(g.key);
        const inOther = (chargesSel[chargesOtherGroup] || []).includes(g.key);
        return {
          label: g.label,
          count: `${g.count} ligne${g.count > 1 ? 's' : ''} · ${this.fmt(g.totalAll)} au total`,
          checked, otherNote: inOther ? `→ déjà dans ${chargesOtherLabel} (cocher ici l'y retire)` : '',
          onToggle: () => this.toggleChargeSel(chargesPickGroup, g.key),
          rowStyle: `display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:9px;cursor:pointer;border:1px solid ${checked ? this.hexToRgba(accent, 0.35) : 'transparent'};background:${checked ? this.hexToRgba(accent, 0.07) : 'transparent'}`,
        };
      }) : [];
    const chargesPickEmpty = !!chargesPickGroup && chargeGroups.length === 0;
    const chargesPickNoResult = !!chargesPickGroup && chargeGroups.length > 0 && chargesPickItems.length === 0;
    const caMissingItems = [
      ...caChargeCards.filter(c => c.missing).map(c => ({ key: 'chg-' + c.group, label: c.label, reason: c.missing })),
      ...caProductRows.filter(r => r.missing).map(r => ({ key: 'sp-' + r.name, label: r.name, reason: r.reason })),
      ...caProductRows.filter(r => !r.missing && r.badgeText === 'Réf. invalide').map(r => ({ key: 'sp2-' + r.name, label: r.name, reason: 'référence Excel invalide (#REF!) — chiffre non calculable' })),
    ];
    if (!caSnapshot) caMissingItems.unshift({ key: 'no-stock', label: 'Détail par espèce', reason: 'aucun fichier Stock connecté pour le moment' });
    const caMissingState = this.buildMissingState(caMissingItems);
    const caSnapshotLabel = caSnapshot ? (caSnapshot.file || caSnapshot.sem) : null;

    // ===================== CASCADE ANALYTIQUE (du CA au résultat net) =====================
    // Base : le stock est un instantané hebdomadaire, les saisies manuelles sont mensuelles,
    // l'amortissement est annuel. Tout est projeté à la période affichée (nb de mois dans la période).
    const caMoisP = ({ 'Cette semaine': 1 / 4, 'Ce mois': 1, 'Trimestre': 3, 'Année': 12 })[this.state.period] || 1;
    const caSemP = caMoisP * 4; // nb de semaines (base stock hebdo)
    const caPerLabel = ({ 'Cette semaine': 'la semaine', 'Ce mois': 'le mois', 'Trimestre': 'le trimestre', 'Année': "l'année" })[this.state.period] || 'la période';
    let caCA = 0, caCout = 0;
    if (caSnapshot) caSpeciesOrder.forEach(name => { const d = (caSnapshot.bySpecies || {})[name]; if (d && !d.missing) { caCA += (+d.valeurVendu || 0); caCout += (+d.valeurAchat || 0); } });
    caCA *= caSemP; caCout *= caSemP;
    const caMC = caCA - caCout;
    const caFixe = chargeTotals.fixe || 0, caVarB = chargeTotals.variable || 0; // déjà filtrées sur la période (Banque)
    const anaC = this.analyCfg();
    const caPersonnel = anaC.personnel * caMoisP, caTransport = anaC.transport * caMoisP, caFF = anaC.ff * caMoisP;
    const caAmortAn = anaC.amortVeh.reduce((s, v) => s + (+v.duree > 0 ? (+v.prix || 0) / +v.duree : 0), 0);
    const caAmort = caAmortAn * caMoisP / 12;
    const caMCV = caMC - caVarB - caTransport, caEBE = caMCV - caFixe - caPersonnel, caRES = caEBE - caAmort - caFF;
    const caTauxMCV = caCA > 0 ? caMCV / caCA : NaN;
    const caSeuilN = caTauxMCV > 0 ? (caFixe + caPersonnel + caAmort + caFF) / caTauxMCV : NaN;
    const caPp = v => caCA > 0 ? v / caCA * 100 : NaN;
    const pctF = n => isFinite(n) ? n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %' : '—';
    const caSrc = { vente: 'Ventes', stock: 'Stock', banque: 'Banque', veh: 'Véhicules', heure: 'Heures' };
    const caSrcCol = { vente: accent, stock: '#0f766e', banque: '#7c3aed', veh: '#b45309', heure: '#0369a1' };
    const caCascade = [
      { lab: 'Chiffre d\'affaires', dsc: 'total des ventes', src: 'vente', amt: caCA, sub: false },
      { lab: '− Coût d\'achat & import', dsc: 'pêcheur · transport · ferry', src: 'stock', amt: caCout, minus: true },
      { lab: '= Marge commerciale', dsc: 'sur la marchandise vendue', amt: caMC, sub: true },
      { lab: '− Charges variables', dsc: 'emballages, glace…', src: 'banque', amt: caVarB, minus: true },
      { lab: '− Transport & livraison', dsc: 'catégorie Transport', src: 'banque', amt: caTransport, minus: true },
      { lab: '= Marge sur coûts variables', dsc: 'couvre les charges fixes', amt: caMCV, sub: true },
      { lab: '− Charges fixes', dsc: 'loyer, EDF, assurances', src: 'banque', amt: caFixe, minus: true },
      { lab: '− Charges de personnel', dsc: 'main-d\'œuvre', src: 'heure', amt: caPersonnel, minus: true },
      { lab: '= Excédent brut d\'exploitation (EBE)', dsc: 'avant amortissements', amt: caEBE, sub: true },
      { lab: '− Amortissements', dsc: 'véhicules, viviers, matériel', src: 'veh', amt: caAmort, minus: true },
      { lab: '− Frais financiers', dsc: 'intérêts, charges Grenke', src: 'banque', amt: caFF, minus: true },
      { lab: '= Résultat net', dsc: 'bénéfice réel de ' + caPerLabel, amt: caRES, sub: true, final: true },
    ].map(r => ({
      rowStyle: `display:grid;grid-template-columns:1fr 150px 96px;gap:12px;align-items:center;padding:11px 14px;border-radius:10px;` + (r.final ? `background:linear-gradient(180deg,#f6f8fc,#fff);border:1.5px solid ${accent}` : r.sub ? 'background:#f6f8fc;border:1px solid #eef1f6' : ''),
      lab: r.lab, labStyle: 'font-weight:' + (r.sub ? '700' : '600') + ';font-size:' + (r.final ? '16px' : '14px'), dsc: r.dsc,
      srcName: r.src ? caSrc[r.src] : '', srcStyle: r.src ? `display:inline-flex;align-items:center;font-size:10px;font-weight:600;color:${caSrcCol[r.src]};border:1px solid ${caSrcCol[r.src]};border-radius:99px;padding:1px 7px` : '',
      amt: (r.minus ? '− ' : '') + this.fmt(r.minus ? Math.abs(r.amt) : r.amt), amtStyle: 'font-family:\'IBM Plex Mono\',monospace;text-align:right;font-weight:' + (r.sub ? '700' : '400') + ';font-size:' + (r.final ? '22px' : r.sub ? '16px' : '15px') + ';color:' + (r.minus ? red : (r.amt < 0 ? red : (r.final ? green : '#0e1b2e'))),
      pct: pctF(caPp(r.amt)),
    }));
    // marge par espèce (barres, projetée à la période)
    const caBars0 = [];
    if (caSnapshot) caSpeciesOrder.forEach(name => { const d = (caSnapshot.bySpecies || {})[name]; if (!d || d.missing) return; (d.products || []).forEach(p => { if (String(p.name || '').trim() && p.state !== 'invalide') caBars0.push({ name: p.name, marge: (p.benefice || 0) * caSemP, mkg: p.venduPoids ? (p.benefice || 0) / p.venduPoids : NaN }); }); });
    caBars0.sort((a, b) => b.marge - a.marge);
    const caBarMax = caBars0.reduce((m, r) => Math.max(m, Math.abs(r.marge)), 0) || 1;
    const caBars0Min = Math.min(0, ...caBars0.map(r => r.marge));
    const caBarRange = (Math.max(0, ...caBars0.map(r => r.marge)) - caBars0Min) || 1;
    const caBarZero = (0 - caBars0Min) / caBarRange * 100;
    const caMargeBars = caBars0.map(r => { const w = Math.abs(r.marge) / caBarRange * 100; return {
      name: r.name, marge: this.fmt(r.marge), mkg: isFinite(r.mkg) ? this.fmt(r.mkg) + '/kg' : '—',
      margeColor: r.marge >= 0 ? green : red,
      fillStyle: `position:absolute;top:3px;bottom:3px;border-radius:4px;min-width:2px;left:${(r.marge >= 0 ? caBarZero : caBarZero - w).toFixed(2)}%;width:${w.toFixed(2)}%;background:${r.marge >= 0 ? green : red}`,
      zeroStyle: `position:absolute;top:0;bottom:0;width:1px;background:#dde3ec;left:${caBarZero.toFixed(2)}%`,
    }; });
    // questions du dirigeant
    const caBest = caBars0[0], caWorst = caBars0[caBars0.length - 1];
    const caBuckets = [['l\'achat + import', caCout], ['le personnel', caPersonnel], ['les charges fixes', caFixe], ['le transport / livraison', caTransport], ['les charges variables', caVarB], ['l\'amortissement', caAmort], ['les frais financiers', caFF]].sort((a, b) => b[1] - a[1]);
    const caOver = caCA - caSeuilN;
    const caQPeriod = ({ 'Cette semaine': 'cette semaine', 'Ce mois': 'ce mois-ci', 'Trimestre': 'ce trimestre', 'Année': 'cette année' })[this.state.period] || 'sur la période';
    const caQuestions = [
      { rail: caRES >= 0 ? green : red, q: 'L\'activité est-elle rentable ' + caQPeriod + ' ?', a: this.fmt(caRES), aColor: caRES >= 0 ? green : red,
        exp: caCA <= 0 ? 'Connectez un dossier Stock pour lire le chiffre d\'affaires.' : (caRES >= 0 ? `Résultat net positif : ${this.fmt(caRES)} après coût d'achat, charges, personnel et amortissements.` : `Résultat net négatif : ${this.fmt(-caRES)} de perte une fois toutes les charges déduites.`) },
      { rail: '#0f766e', q: 'Quelle espèce est la plus rentable ?', a: caBest ? caBest.name : '—', aColor: '#0e1b2e',
        exp: caBest ? `${caBest.name} dégage ${this.fmt(caBest.marge)} de marge${isFinite(caBest.mkg) ? ' (' + this.fmt(caBest.mkg) + '/kg)' : ''}.${caWorst && caWorst !== caBest ? ' La plus faible : ' + caWorst.name + '.' : ''}` : 'Connectez un dossier Stock.' },
      { rail: caOver >= 0 ? green : '#b45309', q: 'Le volume de ventes couvre-t-il le seuil ?', a: caCA <= 0 ? '—' : (caOver >= 0 ? 'Oui' : 'Non'), aColor: caOver >= 0 ? green : red,
        exp: caCA <= 0 ? 'En attente des données de vente.' : (caOver >= 0 ? `CA supérieur de ${this.fmt(caOver)} au seuil de rentabilité (${this.fmt(caSeuilN)}).` : `CA inférieur de ${this.fmt(-caOver)} au seuil de rentabilité (${this.fmt(caSeuilN)}) — activité déficitaire.`) },
      { rail: '#b45309', q: 'Quel est le principal poste de coût ?', a: caBuckets[0] && caBuckets[0][1] > 0 ? caBuckets[0][0].replace(/^l(es|')?\s?/, '') : '—', aColor: '#0e1b2e',
        exp: caBuckets[0] && caBuckets[0][1] > 0 ? `Premier poste : ${caBuckets[0][0]} — ${this.fmt(caBuckets[0][1])} (${pctF(caPp(caBuckets[0][1]))} du CA).` : 'Renseignez vos charges pour situer vos postes.' },
    ].map(x => ({ ...x, cardStyle: `background:#fff;border:1px solid #e9edf4;border-left:4px solid ${x.rail};border-radius:16px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,32,54,.04)` }));
    // saisies manuelles (amortissement véhicules + personnel/transport/ff)
    const caInputStyle = 'width:120px;border:1px solid #dde3ec;background:#f6f8fc;color:#0e1b2e;font-family:\'IBM Plex Mono\',monospace;font-size:13px;text-align:right;padding:7px 9px;border-radius:8px';
    const caPersInput = anaC.personnel || '', caTransInput = anaC.transport || '', caFFInput = anaC.ff || '';
    const onCaPers = e => this.setAnaly({ personnel: this.parseAmount(e.target.value) || 0 });
    const onCaTrans = e => this.setAnaly({ transport: this.parseAmount(e.target.value) || 0 });
    const onCaFF = e => this.setAnaly({ ff: this.parseAmount(e.target.value) || 0 });
    const caAmortRows = anaC.amortVeh.map(v => { const an = +v.duree > 0 ? (+v.prix || 0) / +v.duree : 0; return {
      nom: v.nom || '', prix: v.prix || '', duree: v.duree || '', an: this.fmt(an), mois: this.fmt(an / 12),
      onNom: e => this.updateAnalyVeh(v.id, { nom: e.target.value }),
      onPrix: e => this.updateAnalyVeh(v.id, { prix: this.parseAmount(e.target.value) || 0 }),
      onDuree: e => this.updateAnalyVeh(v.id, { duree: this.parseAmount(e.target.value) || 0 }),
      onDel: () => this.deleteAnalyVeh(v.id), inStyle: caInputStyle,
    }; });
    const caAmortMoisTot = this.fmt(caAmortAn / 12), caAmortAnTot = this.fmt(caAmortAn);
    const onAddAmortVeh = () => this.addAnalyVeh();
    const caBtnStyle = `font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:9px;cursor:pointer;border:1px solid ${this.hexToRgba(accent, 0.3)};background:#fff;color:${accent};font-family:inherit;margin-top:10px`;
    const caResultColor = caRES >= 0 ? green : red;
    const caSeuilFmt = isFinite(caSeuilN) && caSeuilN > 0 ? this.fmt(caSeuilN) : '— (marge variable négative)';
    const caPeriodNote = this.state.period === 'Ce mois' ? '' : `Valeurs projetées sur ${caPerLabel} (l'amortissement et les charges sont ramenés à la période).`;

    const expTotal = expEntries.reduce((s, e) => s + e[1], 0);
    const expTop = expEntries.slice(0, 7);
    const expRest = expEntries.slice(7);
    if (expRest.length) expTop.push(['Autres catégories', expRest.reduce((s, e) => s + e[1], 0)]);
    let pieAcc = 0; const pieSegs = [];
    const pieLegend = expTop.map(([name, v]) => { const col = name === 'Autres catégories' ? '#94a3b8' : catColor(name); const p0 = pieAcc / (expTotal || 1) * 100; pieAcc += v; const p1 = pieAcc / (expTotal || 1) * 100; pieSegs.push(`${col} ${p0.toFixed(2)}% ${p1.toFixed(2)}%`); return { name, color: col, amt: this.fmt(v), pct: Math.round(v / (expTotal || 1) * 100) + '%' }; });
    const pieOpen = !collapsedMap['bankPie'];
    const onPieToggle = () => { const nc = { ...(this.state.sideCollapsed || {}), bankPie: pieOpen }; this.setState({ sideCollapsed: nc }); try { localStorage.setItem('avSideCollapsed', JSON.stringify(nc)); } catch (e) {} };
    const pieEmpty = expTotal <= 0;
    const pieHasData = pieOpen && !pieEmpty;
    const pieStyle = `width:150px;height:150px;border-radius:50%;background:${pieSegs.length ? `conic-gradient(${pieSegs.join(',')})` : '#eef1f5'};position:relative;flex-shrink:0`;
    const pieHoleStyle = 'position:absolute;inset:24%;background:#fff;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px';
    const pieTotal = this.fmt(expTotal);
    const pieSub = `${bankExp.length} dépense${bankExp.length > 1 ? 's' : ''} · ${expEntries.length} catégorie${expEntries.length > 1 ? 's' : ''}`;
    const pieHeadStyle = `display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:${pieOpen ? 14 : 0}px`;
    const pieToggleLabel = pieOpen ? '▾' : '▸';
    const pieToggleStyle = 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:7px;border:1px solid #e3e9f1;background:#fff;color:#69788c;cursor:pointer;font-size:12px;font-family:inherit;flex-shrink:0';
    // popup de choix de catégorie
    const pick = this.state.bankCatPick;
    const bankCatPickOpen = !!pick;
    let bankCatPickList = [], bankCatPickTitle = '', bankCatPickSub = '', bankCatPickAllLabel = '';
    const onBankCatPickCancel = () => this.setState({ bankCatPick: null });
    let onBankCatPickApply = () => {}, onBankCatPickApplyAll = () => {}, onBankCatPickNew = () => {};
    if (pick) {
      bankCatPickTitle = pick.label;
      bankCatPickSub = `Ligne du ${pick.date} · ${this.fmt(pick.amt)} — choisissez, puis appliquez à cette ligne ou à tous les libellés identiques.`;
      bankCatPickList = bankCatMerged.map(name => { const sel = name === pick.sel; return {
        name, dot: catColor(name),
        onPick: () => this.setState({ bankCatPick: { ...pick, sel: name } }),
        rowStyle: `display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:9px;font-size:12.5px;font-family:inherit;cursor:pointer;text-align:left;min-width:0;${sel ? `background:${this.hexToRgba(accent, 0.08)};border:1.5px solid ${accent};color:#0e1b2e;font-weight:600` : 'background:#fff;border:1px solid #e3e9f1;color:#3a4a5e'}`,
        checkStyle: `flex-shrink:0;font-size:11px;font-weight:700;color:${accent};${sel ? '' : 'visibility:hidden'}`,
      }; });
      const lk = this.bankLabelKey(pick.label);
      const same = bankRaw.filter(x => this.bankLabelKey(x.label) === lk).length;
      bankCatPickAllLabel = `⧉ Appliquer aux libellés identiques${same > 1 ? ` (${same})` : ''}`;
      onBankCatPickApply = () => { this.setBankCat(pick.key, pick.sel); this.setState({ bankCatPick: null }); };
      onBankCatPickApplyAll = () => { this.setBankCatRule(pick.label, pick.sel); this.setBankCat(pick.key, pick.sel); this.setState({ bankCatPick: null }); };
      onBankCatPickNew = () => this.setState({ bankCatPick: null, bankCatAsk: { key: pick.key }, bankCatAskValue: '' });
    }
    const bankCatPickApplyStyle = `padding:9px 15px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;
    const bankCatPickAllStyle = `padding:9px 15px;border-radius:9px;font-size:12.5px;font-weight:700;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const bankCatPickNewStyle = 'margin-top:10px;padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;color:#69788c;background:#f6f8fb;border:1px dashed #c9d2de;cursor:pointer;font-family:inherit;width:100%';
    // modal nouvelle catégorie
    const bankCatAskOpen = !!this.state.bankCatAsk;
    const onBankCatInput = e => this.setState({ bankCatAskValue: e.target.value });
    const onBankCatCancel = () => this.setState({ bankCatAsk: null, bankCatAskValue: '' });
    const onBankCatCommit = () => this.commitBankCat();
    const onBankCatKey = e => { if (e.key === 'Enter') this.commitBankCat(); else if (e.key === 'Escape') onBankCatCancel(); };
    const bankCatCommitStyle = `padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;color:#fff;background:${(this.state.bankCatAskValue || '').trim() ? accent : '#c5cede'};border:none;cursor:pointer;font-family:inherit`;
    // modal de liaison
    const bankLinkS = this.state.bankLink;
    const bankLinkOpen = !!bankLinkS;
    const bankLinkTitle = bankLinkS ? `${bankLinkS.label} — ${this.fmt(bankLinkS.amt)}` : '';
    const bankLinkHelp = bankLinkS ? `Ligne du ${bankLinkS.date}. Choisissez l'écriture interne (achat, vente, facture, crédit) qui correspond à ce mouvement — les montants identiques sont en tête de liste.` : '';
    const onBankLinkCancel = () => this.setState({ bankLink: null, bankLinkQuery: '' });
    const onBankLinkQuery = e => this.setState({ bankLinkQuery: e.target.value });
    const bankLinkManual = bankLinkS ? bankLinksM[bankLinkS.key] : null;
    const bankLinkHasCurrent = !!(bankLinkManual && bankLinkManual !== 'none');
    const bankLinkHasOverride = !!bankLinkManual;
    const onBankUnlink = () => { if (bankLinkS) this.setBankLink(bankLinkS.key, 'none'); };
    const onBankAuto = () => { if (bankLinkS) this.clearBankLink(bankLinkS.key); };
    // Rapprochement manuel sans écriture interne (frais bancaires, intérêts, virement interne… qui n'ont pas de facture).
    const onBankManualDone = () => { if (bankLinkS) this.setBankLink(bankLinkS.key, { ref: '', kind: 'Manuel', partner: (this.state.bankLinkQuery || '').trim() || 'Rapproché manuellement' }); };
    const bankManualBtnStyle = `padding:8px 14px;border-radius:8px;font-size:12.5px;font-weight:700;color:#fff;background:${green};border:none;cursor:pointer;font-family:inherit;white-space:nowrap`;
    // Rapprocher une ligne bancaire à un salaire d'employé (le montant devient le salaire du mois).
    const H_MON_S = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const monLabelOf = ym => { const p = String(ym).split('-'); return p[1] ? `${H_MON_S[(+p[1]) - 1]} ${p[0]}` : ym; };
    const salRoster = (this.state.hRoster && this.state.hRoster.length) ? this.state.hRoster : [];
    const salEmpSel = this.state.bankSalaryEmp || salRoster[0] || '';
    const salMonthSel = this.state.bankSalaryMonth || (bankLinkS ? bankLinkS.month : '');
    // Choix de mois : les 12 derniers mois autour de la ligne bancaire.
    const salMonthOpts = (() => { const out = []; if (!bankLinkS) return out; const p = String(bankLinkS.month || '').split('-'); let y = +p[0], m = +p[1]; for (let i = 0; i < 14; i++) { const ym = `${y}-${this.dd(m)}`; out.push({ value: ym, label: monLabelOf(ym), selected: ym === salMonthSel }); m--; if (m < 1) { m = 12; y--; } } return out; })();
    const salEmpOpts = salRoster.map(n => ({ value: n, label: n, selected: n === salEmpSel }));
    const onBankSalaryEmp = e => this.setState({ bankSalaryEmp: e.target.value });
    const onBankSalaryMonth = e => this.setState({ bankSalaryMonth: e.target.value });
    const onBankSalaryLink = () => { if (bankLinkS) this.linkBankSalary(bankLinkS.key, salEmpSel, salMonthSel, monLabelOf(salMonthSel)); };
    const bankSalaryBtnStyle = `padding:8px 14px;border-radius:8px;font-size:12.5px;font-weight:700;color:#fff;background:#7c3aed;border:none;cursor:pointer;font-family:inherit;white-space:nowrap`;
    const bankSalarySelStyle = 'padding:7px 10px;border:1px solid #dde3ec;border-radius:8px;font-size:12.5px;font-family:inherit;color:#0e1b2e;background:#fff;min-width:0';
    const bankSalaryHasRoster = salRoster.length > 0;
    let bankLinkList = [], bankLinkEmpty = false;
    if (bankLinkS) {
      const q = bankNorm(this.state.bankLinkQuery || '');
      const cds = bankCands.filter(c => !q || bankNorm(`${c.ref} ${c.partner} ${c.signed}`).includes(q));
      cds.sort((a, z) => { const sa = Math.abs(a.signed - bankLinkS.amt) < 0.01 ? 0 : 1, sz = Math.abs(z.signed - bankLinkS.amt) < 0.01 ? 0 : 1; return sa - sz || z.days - a.days; });
      bankLinkList = cds.slice(0, 40).map(c => { const same = Math.abs(c.signed - bankLinkS.amt) < 0.01; return {
        kind: c.kind, kindStyle: kindBadge(c.kind), ref: c.ref || '—', partner: c.partner, date: c.dLabel,
        amt: this.fmt(c.signed), amtColor: c.signed >= 0 ? green : '#0e1b2e',
        tag: same ? `${badge}background:#e7f5ec;color:${green};flex-shrink:0` : `${badge}background:#eef1f5;color:${slate};flex-shrink:0`, tagLabel: same ? '= montant' : '≠ montant',
        rowStyle: 'display:flex;align-items:center;gap:10px;padding:10px 13px;border-bottom:1px solid #f1f4f8;font-size:12.5px;cursor:pointer;background:#fff',
        onPick: () => this.setBankLink(bankLinkS.key, { ref: c.ref, kind: c.kind, partner: c.partner }),
      }; });
      bankLinkEmpty = bankLinkList.length === 0;
    }

    // ============ HEURES DE TRAVAIL ============
    const hMode = ['mois', 'annee', 'archives'].includes(this.state.hMode) ? this.state.hMode : 'semaine';
    const hIsSemaine = hMode === 'semaine';
    const hIsMonth = hMode === 'mois';
    const hIsYear = hMode === 'annee';
    const hIsCustomArchives = hMode === 'archives';
    const hIsArchives = !hIsSemaine;
    const H_DOW = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const H_MON = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const hFmt = h => this.hFmtH(h);
    const hNum = v => this.hNumVal(v);
    const hDayTot = d => this.hDayTotal(d);
    const hWeekDates = mk => { const m = this.hParse(mk); return H_DOW.map((_, i) => { const x = new Date(m); x.setDate(x.getDate() + i); return this.hISO(x); }); };
    const hEmpWeek = (emp, dates) => dates.reduce((s, iso) => s + hDayTot((emp.days || {})[iso]), 0);
    const hWeekTot = (wk, dates) => (((wk && wk.employees) || [])).reduce((s, e) => s + hEmpWeek(e, dates), 0);
    const hWeekLabel = mk => { const a = this.hParse(mk); const b = new Date(a); b.setDate(b.getDate() + 6); const sm = a.getMonth() === b.getMonth(); return sm ? (a.getDate() + ' – ' + b.getDate() + ' ' + H_MON[b.getMonth()] + ' ' + b.getFullYear()) : (a.getDate() + ' ' + H_MON[a.getMonth()] + ' – ' + b.getDate() + ' ' + H_MON[b.getMonth()] + ' ' + b.getFullYear()); };
    const hStore = this.state.heures || {};
    const hCol = this.state.hCollapse || {};
    const hKey = this.hFocusKey();
    const hDates = hWeekDates(hKey);
    const hWk = hStore[hKey] || { employees: [] };
    const hThisKey = this.hISO(this.hMonday(new Date()));
    const hIsThisWeek = hKey === hThisKey;
    const hThu = this.hParse(hKey); hThu.setDate(hThu.getDate() + 3);
    const hMonthI = hThu.getMonth(), hYearI = hThu.getFullYear();
    let hMonthTot = 0;
    Object.keys(hStore).forEach(k => { const wk = hStore[k]; hWeekDates(k).forEach(iso => { const dt = this.hParse(iso); if (dt.getMonth() === hMonthI && dt.getFullYear() === hYearI) (wk.employees || []).forEach(e => { hMonthTot += hDayTot((e.days || {})[iso]); }); }); });

    // Fiche mensuelle par personne : théorique 151,67h (35h × 52 / 12), réel recalculé par nom
    // (l'id d'employé n'est pas stable d'une semaine à l'autre — seul le nom l'est).
    const H_THEORIQUE_MENSUEL = 151.67;
    const hDecH = h => (Math.round((h || 0) * 100) / 100).toFixed(2) + 'h';
    const hMonthKeyStr = hYearI + '-' + this.dd(hMonthI + 1);
    const hEmpHoursMap = this.empHoursByMonth();
    const hMoisCardStyle = 'background:#fff;border:1px solid #e9edf4;border-radius:12px;box-shadow:0 1px 2px rgba(16,32,54,.04);padding:14px 16px';
    const hMoisInputStyle = 'width:120px;box-sizing:border-box;padding:7px 9px;border:1px solid #e4e9f1;border-radius:8px;font-size:13px;font-family:\'IBM Plex Mono\',monospace;color:#0e1b2e;background:#fff';
    const hRosterNames = (this.state.hRoster || []).filter((n, i, a) => n && a.indexOf(n) === i);
    const hMonthlyCards = hRosterNames.map(name => {
      const nm = String(name).trim();
      const reel = hEmpHoursMap[nm + '|' + hMonthKeyStr] || 0;
      const diff = Math.round((reel - H_THEORIQUE_MENSUEL) * 100) / 100;
      const positive = diff >= 0;
      const mois = this.hMoisRow(nm, hMonthKeyStr);
      return {
        name: nm,
        theoriqueLabel: hDecH(H_THEORIQUE_MENSUEL),
        reelLabel: hDecH(reel),
        diffLabel: (positive ? '+' : '') + hDecH(diff),
        badgeLabel: positive ? 'Heures supplémentaires' : 'Heures à rattraper',
        badgeStyle: positive
          ? 'padding:5px 12px;border-radius:20px;font-size:11.5px;font-weight:600;color:#166534;background:#e7f5ec;border:1px solid #bfe3cc;white-space:nowrap'
          : 'padding:5px 12px;border-radius:20px;font-size:11.5px;font-weight:600;color:#b45309;background:#fff4e5;border:1px solid #f0dcae;white-space:nowrap',
        paniersValue: mois.paniers == null ? '' : String(mois.paniers),
        onPaniers: e => this.hSetMois(nm, hMonthKeyStr, 'paniers', e.target.value),
        avantagesValue: mois.avantages == null ? '' : String(mois.avantages),
        onAvantages: e => this.hSetMois(nm, hMonthKeyStr, 'avantages', e.target.value),
        hsPayeesValue: mois.hsPayees == null ? '' : String(mois.hsPayees),
        onHsPayees: e => this.hSetMois(nm, hMonthKeyStr, 'hsPayees', e.target.value),
      };
    });

    const hEmpCardStyle = 'background:#fff;border:1px solid #e9edf4;border-radius:12px;box-shadow:0 1px 2px rgba(16,32,54,.04);overflow:hidden';
    const hChevStyle = 'width:26px;height:26px;flex-shrink:0;border:none;background:transparent;color:#8291a5;font-size:11px;cursor:pointer;font-family:inherit;border-radius:7px';
    const hNameStyle = 'font-size:14px;font-weight:600;color:#0e1b2e;border:1px solid #eef1f6;border-radius:8px;padding:6px 10px;font-family:inherit;background:#fff;min-width:150px;max-width:280px;flex:0 1 auto';
    const hCellStyle = 'width:100%;box-sizing:border-box;padding:7px 4px;border:1px solid #e4e9f1;border-radius:8px;font-size:13px;font-family:\'IBM Plex Mono\',monospace;color:#0e1b2e;background:#fff;text-align:center';
    const hTotCellStyle = 'text-align:right;font-family:\'IBM Plex Mono\',monospace;font-size:13.5px;font-weight:600;color:#0e1b2e;white-space:nowrap';
    const hDelStyle = 'width:32px;height:32px;flex-shrink:0;border-radius:8px;border:1px solid #f0c9c9;background:#fff;color:#b91c1c;font-size:14px;cursor:pointer;font-family:inherit';
    const hEmpTotStyle = `font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:${accent};background:${soft};padding:5px 12px;border-radius:8px;white-space:nowrap`;
    const hGridHeadStyle = 'display:grid;grid-template-columns:150px 1fr 1fr 1fr 96px;gap:8px;align-items:end;padding:12px 14px 8px;font-size:11px;font-weight:600;color:#93a1b3;text-transform:uppercase;letter-spacing:.3px;background:#fbfcfe;border-bottom:1px solid #f1f4f8';
    const hLegendStyle = 'font-size:12px;color:#8291a5;margin:0 2px 14px;line-height:1.5';
    const hEmptyStyle = 'padding:40px 24px;text-align:center;font-size:13px;color:#8291a5;background:#fff;border:1px dashed #dbe3ee;border-radius:12px;line-height:1.6';

    const hBuildEmp = (key, emp) => {
      const cid = 'emp_' + key + '_' + emp.id;
      const collapsed = !!hCol[cid];
      const rows = hDates.map((iso, i) => {
        const d = (emp.days || {})[iso] || {};
        const wknd = i >= 5;
        const rawRanges = this.hRanges(d); if (!rawRanges.length) rawRanges.push({ arr: '', dep: '', pse: '' });
        const ranges = rawRanges.map((pl, pi) => { const cell = f => ({ value: pl[f] == null ? '' : String(pl[f]), onInput: e => this.hSetRange(key, emp.id, iso, pi, f, e.target.value) }); return { arr: cell('arr'), dep: cell('dep'), pse: cell('pse'), label: pi === 0 ? '+' : '−', title: pi === 0 ? 'Ajouter une plage horaire' : 'Supprimer cette plage', onAction: () => pi === 0 ? this.hAddRange(key, emp.id, iso) : this.hRemoveRange(key, emp.id, iso, pi), btnStyle: `width:32px;height:32px;border-radius:8px;border:1px solid ${this.hexToRgba(accent, .3)};background:#fff;color:${pi === 0 ? accent : '#b91c1c'};font-size:16px;font-weight:700;cursor:pointer;font-family:inherit` }; });
        const dt = this.hParse(iso);
        // journée encore à l'ancien format (Matin/Après-midi…) : le total reste juste, on le signale
        const oldFmt = !(d.arr || d.dep) && !!(d.matin || d.aprem || d.repas || d.pause);
        return { key: emp.id + iso, dow: H_DOW[i], date: dt.getDate() + ' ' + H_MON[dt.getMonth()].slice(0, 4) + '.', ranges, oldFmt, negWarn: !!this.hRangeIssue(d), total: hFmt(hDayTot(d)), rowStyle: 'display:grid;grid-template-columns:150px 1fr 1fr 1fr 96px;gap:8px;align-items:center;padding:6px 14px;border-top:1px solid #f1f4f8;font-size:13px;background:' + (wknd ? '#f8fafc' : '#fff'), dayStyle: 'display:flex;flex-direction:column;gap:1px;' + (wknd ? 'color:#8291a5' : 'color:#0e1b2e') };
      });
      return { id: emp.id, name: emp.name, isOpen: !collapsed, chevron: collapsed ? '▸' : '▾', headStyle: 'display:flex;align-items:center;gap:10px;padding:12px 14px;' + (collapsed ? '' : 'border-bottom:1px solid #eef1f6'), onToggle: () => this.hToggleCollapse(cid), onName: e => this.hSetName(key, emp.id, e.target.value), onDelete: () => this.hAskDelete(key, emp.id, emp.name), weekTotal: hFmt(hEmpWeek(emp, hDates)), rows };
    };
    const hEmployees = (hWk.employees || []).map(e => hBuildEmp(hKey, e));
    const hEmpty = hEmployees.length === 0;
    const hWeekTotalLabel = hFmt(hWeekTot(hWk, hDates));
    const hMonthTotalLabel = hFmt(hMonthTot);
    const hMonthName = H_MON[hMonthI] + ' ' + hYearI;
    const hNavLabel = hWeekLabel(hKey);
    const onHPrev = () => this.hGoWeek(-1);
    const onHNext = () => this.hGoWeek(1);
    const onHToday = () => this.hGoWeek(hThisKey);
    const onHAddEmp = () => this.hAddEmployee(hKey);
    const hPrintDay = (e, iso, i) => { const d = (e && e.days || {})[iso] || {}; const dt = this.hParse(iso); const rr = this.hRanges(d).filter(x => x.arr || x.dep || x.pse); return { dow: H_DOW[i != null ? i : ((dt.getDay() + 6) % 7)], date: `${this.dd(dt.getDate())}/${this.dd(dt.getMonth() + 1)}`, arr: rr.length ? rr.map(x => x.arr || '—').join(' / ') : '—', dep: rr.length ? rr.map(x => x.dep || '—').join(' / ') : '—', pause: rr.length ? rr.map(x => x.pse || '0').join(' / ') : ((d.matin || d.aprem || d.repas || d.pause) ? 'ancien format' : '—'), total: hFmt(hDayTot(d)), totalNum: hDayTot(d) }; };
    this._heuresReportData = {
      mode: 'week', periodLabel: hNavLabel, weekTotalLabel: hWeekTotalLabel,
      employees: (hWk.employees || []).map(e => ({
        id: e.id, name: e.name || 'Employé',
        days: hDates.map((iso, i) => hPrintDay(e, iso, i)),
        weekTotal: hFmt(hEmpWeek(e, hDates)),
      })),
    };
    const hPrintOpen = !!this.state.hPrintOpen;
    const onPrintHeures = () => this.setState({ hPrintOpen: true, hPrintEmp: null });
    const onHPrintCancel = () => this.setState({ hPrintOpen: false, hPrintEmp: null });
    const hPrintItems = (this._heuresReportData.employees || []).map(emp => ({ label: emp.name, onClick: () => this.setState({ hPrintEmp: { id: emp.id, name: emp.name } }), style: `width:100%;text-align:left;padding:10px 13px;border-radius:9px;border:1px solid ${this.hexToRgba(accent, 0.28)};background:${soft};color:${accent};font-size:13px;font-weight:600;cursor:pointer;font-family:inherit` }));
    const hPrintEmp = this.state.hPrintEmp;
    const hPrintChooseEmployee = !hPrintEmp;
    const hPrintChoosePeriod = !!hPrintEmp;
    const hPrintEmployeeName = hPrintEmp ? hPrintEmp.name : '';
    const hPrintWeekLabel = hNavLabel;
    const hPrintMonthLabel = H_MON[hMonthI] + ' ' + hYearI;
    const findPrintEmp = (wk, sel) => ((wk && wk.employees) || []).find(e => e.id === sel.id) || ((wk && wk.employees) || []).find(e => this._norm(e.name) === this._norm(sel.name));
    const onHPrintWeek = () => {
      if (!hPrintEmp) return; const emp = (this._heuresReportData.employees || []).find(e => e.id === hPrintEmp.id) || (this._heuresReportData.employees || []).find(e => this._norm(e.name) === this._norm(hPrintEmp.name)); if (!emp) return;
      this._heuresReportData = { mode: 'week', periodLabel: hNavLabel, employees: [emp] }; this.setState({ hPrintOpen: false, hPrintEmp: null }); this.generateHeuresReport();
    };
    const onHPrintMonth = () => {
      if (!hPrintEmp) return; const days = []; let total = 0; const last = new Date(hYearI, hMonthI + 1, 0).getDate();
      for (let day = 1; day <= last; day++) { const dt = new Date(hYearI, hMonthI, day), iso = this.hISO(dt), key = this.hISO(this.hMonday(new Date(dt))), emp = findPrintEmp(hStore[key], hPrintEmp), row = hPrintDay(emp, iso); total += row.totalNum || 0; days.push(row); }
      this._heuresReportData = { mode: 'month', periodLabel: hPrintMonthLabel, employees: [{ id: hPrintEmp.id, name: hPrintEmp.name, days, weekTotal: hFmt(total) }] }; this.setState({ hPrintOpen: false, hPrintEmp: null }); this.generateHeuresReport();
    };
    const onHPrintBack = () => this.setState({ hPrintEmp: null });
    const hPrintPeriodStyle = `width:100%;text-align:left;padding:11px 13px;border-radius:9px;border:1px solid ${this.hexToRgba(accent, 0.3)};background:${soft};color:${accent};font-size:13px;font-weight:600;cursor:pointer;font-family:inherit`;
    const hPrintBackStyle = 'width:100%;text-align:left;padding:9px 12px;border-radius:9px;border:1px solid #e3e8f0;background:#fff;color:#69788c;font-size:12.5px;cursor:pointer;font-family:inherit';
    const printHeuresBtnStyle = `padding:7px 13px;border-radius:8px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;
    const hModeTabs = [['semaine', 'Semaine'], ['mois', 'Mois'], ['annee', 'Année'], ['archives', 'Archives']].map(([k, lbl]) => ({
      name: lbl,
      onClick: () => {
        const d = new Date();
        if (k === 'mois') this.setState({ hMode: k, hRange: { from: this.hISO(new Date(d.getFullYear(), d.getMonth(), 1)), to: this.hISO(new Date(d.getFullYear(), d.getMonth() + 1, 0)) } });
        else if (k === 'annee') this.setState({ hMode: k, hRange: { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` } });
        else this.setState({ hMode: k });
      },
      style: (hMode === k) ? `padding:7px 16px;border-radius:8px;font-size:12.5px;font-weight:600;color:${accent};background:${soft};border:none;cursor:pointer;font-family:inherit` : 'padding:7px 16px;border-radius:8px;font-size:12.5px;font-weight:500;color:#69788c;background:transparent;border:none;cursor:pointer;font-family:inherit'
    }));
    const hNavBtnStyle = 'width:32px;height:32px;border-radius:8px;border:1px solid #e6ebf2;background:#fff;color:#3a4a5e;font-size:12px;cursor:pointer;font-family:inherit;flex-shrink:0';
    const hTodayStyle = hIsThisWeek ? `padding:7px 13px;border-radius:8px;font-size:12.5px;font-weight:600;color:${accent};background:${soft};border:none;cursor:default;font-family:inherit;white-space:nowrap` : 'padding:7px 13px;border-radius:8px;font-size:12.5px;font-weight:600;color:#69788c;background:#fff;border:1px solid #e6ebf2;cursor:pointer;font-family:inherit;white-space:nowrap';
    const hAddStyle = `display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:10px;font-size:13px;font-weight:600;color:${accent};background:${soft};border:1px dashed ${this.hexToRgba(accent, 0.4)};cursor:pointer;font-family:inherit`;
    const hStatCardStyle = 'display:flex;flex-direction:column;gap:3px;padding:6px 10px;background:transparent;border:none;min-width:118px';
    const hStatLabelStyle = 'font-size:11px;font-weight:600;color:#93a1b3;text-transform:uppercase;letter-spacing:.3px';
    const hStatValStyle = 'font-family:\'IBM Plex Mono\',monospace;font-size:20px;font-weight:600;color:#0e1b2e;letter-spacing:-.3px';

    const hToday = new Date();
    const arFrom = (this.state.hRange && this.state.hRange.from) || this.hISO(new Date(hToday.getFullYear(), hToday.getMonth(), 1));
    const arTo = (this.state.hRange && this.state.hRange.to) || this.hISO(new Date(hToday.getFullYear(), hToday.getMonth() + 1, 0));
    const onArFrom = e => this.setState({ hRange: { from: e.target.value, to: arTo } });
    const onArTo = e => this.setState({ hRange: { from: arFrom, to: e.target.value } });
    const arBase = this.hParse(arFrom);
    const arMonthValue = String(arBase.getMonth() + 1);
    const arYearValue = String(arBase.getFullYear());
    const arMonthOptions = H_MON.map((m, i) => ({ value: String(i + 1), label: m.charAt(0).toUpperCase() + m.slice(1) }));
    const yearSet = new Set([hToday.getFullYear()]); Object.keys(hStore).forEach(k => yearSet.add(this.hParse(k).getFullYear()));
    const arYearOptions = [...yearSet].sort((a, b) => b - a).map(y => ({ value: String(y), label: String(y) }));
    const setArchiveMonth = (month, year) => { const y = +year, m = +month; this.setState({ hRange: { from: `${y}-${this.dd(m)}-01`, to: this.hISO(new Date(y, m, 0)) } }); };
    const onArMonth = e => setArchiveMonth(e.target.value, arYearValue);
    const onArYear = e => setArchiveMonth(arMonthValue, e.target.value);
    const arStart = this.hParse(arFrom), arEnd = this.hParse(arTo);
    const arKeys = Object.keys(hStore).filter(k => { const a = this.hParse(k); const b = new Date(a); b.setDate(b.getDate() + 6); return b >= arStart && a <= arEnd; }).sort().reverse();
    let arPeriodTot = 0;
    const arRows = arKeys.map(k => { const dates = hWeekDates(k); const wk = hStore[k]; const wt = hWeekTot(wk, dates); arPeriodTot += wt; const isOpen = !!hCol['ar_' + k]; const lines = (wk.employees || []).map(e => ({ key: e.id, name: e.name || '—', total: hFmt(hEmpWeek(e, dates)) })); const n = (wk.employees || []).length; return { key: k, label: hWeekLabel(k), weekTotal: hFmt(wt), isOpen, chevron: isOpen ? '▾' : '▸', onToggle: () => this.hToggleCollapse('ar_' + k), lines, onEdit: ev => { if (ev && ev.stopPropagation) ev.stopPropagation(); this.hGoWeek(k); }, empCount: n + ' personne' + (n > 1 ? 's' : '') }; });
    const arEmpty = arRows.length === 0;
    const arPeriodLabel = hFmt(arPeriodTot);
    const arCountLabel = arRows.length + ' semaine' + (arRows.length > 1 ? 's' : '');
    const hDateStyle = 'padding:8px 11px;border:1px solid #dde3ec;border-radius:9px;font-size:13px;font-family:inherit;color:#0e1b2e;background:#fff';
    const hArHeadStyle = 'display:flex;align-items:center;gap:12px;padding:13px 16px;cursor:pointer';
    const hArLineStyle = 'display:grid;grid-template-columns:1fr 120px;gap:10px;align-items:center;padding:9px 16px;border-top:1px solid #f1f4f8;font-size:13px';
    const hArChevStyle = 'width:22px;text-align:center;color:#8291a5;font-size:11px;flex-shrink:0';
    const hEditStyle = `padding:7px 13px;border-radius:8px;font-size:12px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit`;
    const hHeaderSub = hIsMonth ? `Vue mensuelle — ${H_MON[arBase.getMonth()]} ${arBase.getFullYear()}` : hIsYear ? `Vue annuelle — ${arBase.getFullYear()}` : hIsCustomArchives ? 'Archives — choisissez une période au calendrier' : ('Semaine du ' + hNavLabel + (hIsThisWeek ? ' · en cours' : ''));
    const hDelAsk = this.state.hDelAsk;
    const hDelOpen = !!hDelAsk;
    const hDelName = hDelAsk ? (hDelAsk.name || 'cette personne') : '';
    const onHDelCancel = () => this.setState({ hDelAsk: null });
    const onHDelConfirm = () => this.hConfirmDelete();
    // Récapitulatif de TOUTES ses heures + bouton d'archive PDF avant suppression
    const hDelArch = hDelOpen ? this.hEmpArchiveData(hDelName) : null;
    const hDelSummary = hDelArch
      ? (hDelArch.weeks.length
        ? `${hDelArch.totalLabel} enregistrées sur ${hDelArch.weeks.length} semaine${hDelArch.weeks.length > 1 ? 's' : ''} (${hDelArch.dayCount} jour${hDelArch.dayCount > 1 ? 's' : ''}).`
        : 'Aucune heure enregistrée pour cette personne.')
      : '';
    const hDelHasHours = !!(hDelArch && hDelArch.weeks.length);
    const onHDelArchive = () => this.generateEmpArchive(hDelName);
    const hDelArchiveStyle = `padding:9px 15px;border-radius:9px;font-size:12.5px;font-weight:600;color:${accent};background:#fff;border:1px solid ${this.hexToRgba(accent, 0.35)};cursor:pointer;font-family:inherit;white-space:nowrap`;

    const titles = {
      'Tableau de bord': ['Suivi Achat / Vente', `Vue d'ensemble — ${periodLabel}`],
      'Ventes': ['Ventes clients', `${S.nbV} vente${S.nbV > 1 ? 's' : ''} — ${periodLabel}`],
      'Relance': ['Suivi de paiement', payEmpty ? 'Enregistrez vos paiements et suivez les règlements' : `${payTrackList.length} facture${payTrackList.length > 1 ? 's' : ''} suivie${payTrackList.length > 1 ? 's' : ''}`],
      'Grenke': ['Financement Grenke', `${gmRows0.length} paiement${gmRows0.length > 1 ? 's' : ''} enregistré${gmRows0.length > 1 ? 's' : ''} · ${gFiltered.length} dossier${gFiltered.length > 1 ? 's' : ''} importé${gFiltered.length > 1 ? 's' : ''}`],
      'SaisieCompta': ['Saisie comptable', (asRows0.length + vsRows0.length) ? `${asRows0.length} achat${asRows0.length > 1 ? 's' : ''} · ${vsRows0.length} vente${vsRows0.length > 1 ? 's' : ''} saisi${(asRows0.length + vsRows0.length) > 1 ? 's' : ''}` : 'Saisissez vos achats pêcheurs et vos ventes'],
      'Achats': ['Achat pêche', `${S.nbA} achat${S.nbA > 1 ? 's' : ''} — ${periodLabel}`],
      'Factures': ['Facture fournisseur', `${facSub} — ${F.length} facture${F.length > 1 ? 's' : ''}`],
      'Crédits': ['Crédits & assurances', `${credits.length} engagement${credits.length > 1 ? 's' : ''} · ${this.fmt(mensTot)} / mois`],
      'Banque': ['Rapprochement bancaire', `${bankVisible.length} ligne${bankVisible.length > 1 ? 's' : ''} de relevé — ${bankAutoN + bankManualN} rapprochée${bankAutoN + bankManualN > 1 ? 's' : ''}, ${bankTodoN} à traiter`],
      'Comptabilité analytique': ['Comptabilité analytique', caSnapshot ? `Achat / vente de crustacés — instantané du ${caSnapshotLabel}` : 'Achat / vente de crustacés — par espèce'],
      'Bordereaux': ['Bordereaux — livraison & transport', `${blLib.length} fichier${blLib.length > 1 ? 's' : ''} dans la bibliothèque`],
      'Stock': ['Stock', `${stockRaw.length} inventaire${stockRaw.length > 1 ? 's' : ''} hebdomadaire${stockRaw.length > 1 ? 's' : ''}`],
      'Véhicules': ['Véhicules', `${vehicleRows.length} véhicule${vehicleRows.length > 1 ? 's' : ''}`],
      'Tiers': [this.state.tiers, `${partnersRows.length} ${this.state.tiers.toLowerCase()} — ${tiersScopeLabel}`],
      'Bibliothèque': ['Bibliothèque de documents', libFiles.length ? `${libFiles.length} document${libFiles.length > 1 ? 's' : ''}` : 'Connectez le dossier de vos documents'],
      'Paramètres': ['Paramètres', 'Sources de données, objectifs & observations'],
      'Heures': ['Heures de travail', hHeaderSub],
      'Employés': ['Employés', empEmpty ? 'Ajoutez vos employés dans l\'onglet Heures' : `${empCards.length} employé${empCards.length > 1 ? 's' : ''} · heures, salaires & fiches de paie`],
      'Agenda': ['Agenda', agHasAny ? `${agUpcoming.length} événement${agUpcoming.length > 1 ? 's' : ''} à venir` : 'Rendez-vous, ferries, congés, échéances — ajoutez votre premier événement'],
      'Messages': ['Messages', `Messagerie interne — connecté en tant que ${msgMe.nom}`],
    }[view] || [view, ''];
    const demoToggleLabel = demo ? 'Quitter le mode démo' : 'Réactiver la démo';
    const onToggleDemo = () => this.setDemoMode(!demo);
    const demoBtnStyle = `padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;color:#fff;background:${demo ? accent : '#15803d'};border:none;cursor:pointer;font-family:inherit`;
    const demoStatusLabel = demo ? 'Démo active' : 'Vos données uniquement';
    const demoStatusStyle = demo ? `${badge}background:${soft};color:${accent}` : `${badge}background:#e7f5ec;color:${green}`;
    const demoModeText = demo ? "Le tableau affiche des données de démonstration là où aucun fichier n'est encore relié. Quittez la démo pour n'afficher que vos propres données — chaque vue sans fichier connecté restera vide." : "Mode démo désactivé : seules vos données importées s'affichent. Les sections sans fichier relié restent vides.";
    const pfxAsk = this.state.prefixAsk;
    const prefixAskOpen = !!pfxAsk;
    const prefixAskKindLabel = pfxAsk ? (pfxAsk.kind === 'stock' ? 'Dossier Stock' : pfxAsk.kind === 'transport' ? 'Dossier Bordereaux de transport' : 'Dossier Bordereaux de livraison') : '';
    const prefixAskDir = pfxAsk ? pfxAsk.dirName : '';
    const prefixAskThing = pfxAsk ? (pfxAsk.kind === 'stock' ? 'inventaires de stock' : pfxAsk.kind === 'transport' ? 'bordereaux de transport' : 'bons de livraison') : '';
    const prefixAskHelp = pfxAsk ? (pfxAsk.kind === 'transport'
      ? 'Indiquez le début du nom des fichiers de chaque transporteur. Plusieurs transporteurs ? Séparez-les par une virgule (ex. « Chronopost, DHL, Heppner »). Laissez vide pour lister tous les fichiers.'
      : 'Ne lire que les ' + prefixAskThing + ' dont le nom commence par le texte ci-dessous. Laissez vide pour lister tous les fichiers du dossier.') : '';
    const prefixAskValue = this.state.prefixAskValue || '';
    const onPrefixInput = e => this.setState({ prefixAskValue: e.target.value });
    const onPrefixConfirm = () => this.confirmPrefix();
    const onPrefixCancel = () => this.cancelPrefix();
    const onPrefixKey = e => { if (e.key === 'Enter') { e.preventDefault(); this.confirmPrefix(); } else if (e.key === 'Escape') this.cancelPrefix(); };
    const prefixInputStyle = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #dde3ec;border-radius:9px;font-size:13px;font-family:\'IBM Plex Mono\',monospace;color:#0e1b2e';
    const prefixConfirmStyle = `padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#fff;background:${accent};border:none;cursor:pointer;font-family:inherit`;
    const prefixCancelStyle = 'padding:8px 15px;border-radius:9px;font-size:13px;font-weight:600;color:#69788c;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit';
    const prefixOverlayStyle = 'position:fixed;inset:0;z-index:72;background:rgba(14,27,46,.42);display:flex;align-items:center;justify-content:center;padding:24px';
    const prefixCardStyle = 'width:460px;max-width:100%;background:#fff;border:1px solid #e2e8f1;border-radius:16px;box-shadow:0 30px 60px -24px rgba(14,27,46,.5);font-family:inherit;padding:22px';
    const ctxStop = e => { if (e) e.stopPropagation(); };
    const pwv = this._pwRenderVals();

    return {
      ...pwv,
      ctxStop,
      isDash, isOverview, isFactures, isCredits, isBordereaux, isStock, isVehicles, isTiers, isSettings, isBibliotheque, isEmployes, isAgenda,
      empCards, empEmpty, empGrandHours, empGrandSalaire, empAddNote, empDelDocOpen, empDelDocName, onEmpDelDocConfirm, onEmpDelDocCancel, accentColor: accent,
      agWeeks, agMonthLabel, agUpcoming, agEmptyUpcoming, agTodayCount, agSoonHome, agHasAny, agHomeReminderStyle, agLegend,
      onAgNew, onAgPrevMonth, onAgNextMonth, onAgTodayBtn, agAddBtnStyle, agNavBtnStyle, agTodayBtnStyle, AG_DOW,
      agEditOpen, agEditIsNew, agEditCanDelete, agEditValues, agCatOptions, agRecurOptions, onAgTitle, onAgDate, onAgTime, onAgCat, onAgRecur, onAgNote, onAgSave, onAgCancel, onAgDeleteFromEdit, agInputStyle, agSelStyle, agBtnPrimary, agBtnGhost,
      agDelOpen, agDelTitle, onAgDelConfirm, onAgDelCancel, onGoAgenda, agHomeShow,
      navGroups, onGear, onDisconnect, gearStyle, brandStyle, appVersion: Component.APP_VERSION,
      advOpen: !!this.state.advOpen,
      onToggleAdv: () => this.setState({ advOpen: !this.state.advOpen }),
      advToggleLabel: this.state.advOpen ? "▴ Masquer les options avancées" : "▾ Plus d'options (objectifs, profils, entreprise, restauration…)",
      advToggleStyle: "align-self:flex-start;padding:9px 16px;border-radius:10px;font-size:13px;font-weight:600;color:#69788c;background:#fff;border:1px solid #dde3ec;cursor:pointer;font-family:inherit",
      guideOn, guideTitle, guideText, guideCount, guidePct, guideNextLabel, guidePrevStyle, guideBtnStyle, onGuideStart, onGuideNext, onGuidePrev, onGuideClose,
      bannerStyle, bannerText, bannerActions,
      bannerVisible, onDismissBanner, bannerCloseStyle,
      htTtcLabel, htTtcStyle, onToggleHtTtc, refreshStyle, onRefreshAll,
      onBackup, backupBusy, backupBtnLabel, backupBtnStyle, backupFolderName, onChangeBackupFolder, backupStatus,
      onSuivi, suiviBusy, suiviBtnLabel, suiviBtnStyle, suiviFolderName, onChangeSuiviFolder, suiviStatus, suiviPeriodLabel,
      helpMode, onHelpToggle, helpBtnStyle, helpRootClass, helpTip, helpTipStyle, onHelpTipClose, helpHintOpen,
      viewHelp: NAVHELP[view] || '',
      globalSearchStyle, globalQuery, onGlobalQuery, onGlobalFocus, onGlobalBlur, globalOpen, globalGroups, globalEmpty,
      importChecksOpen: !!(this.state.importChecksOpen && this.state.importChecks), importChecks: this.state.importChecks,
      onCloseImportChecks: () => this.setState({ importChecksOpen: false }),
      onRestorePick, restoreBusy, restoreBtnLabel, restoreErrText, restoreOpen, restorePreview, onRestoreConfirm, onRestoreCancel,
      entNom, entLogo, entNoLogo, entInitials, entNomValue, onEntNom, entAccentValue, onEntAccent, entAccentPresets, onEntLogoPick, onEntLogoClear, entEspecesText, onEntEspeces, entEspecesCount,
      isAdminUI, profilChipLabel, profilRoleLabel, profilMenuOpen, onProfilToggle, profilChipStyle, profilItems, profilRows, onProfilAdd, whoOpen, whoItems,
      isMessages, msgRows, msgEmpty, msgTextValue, onMsgText, onMsgKey, onMsgSend, msgToValue, msgToOptions, onMsgTo, msgSendStyle, msgMeLabel, msgSoloHint,
      htTtcAskOpen, htTtcTarget, htTtcTargetLong, htTtcExplain, htTtcCheck, onHtTtcCheck, onHtTtcConfirm, onHtTtcCancel, htTtcConfirmStyle,
      viewTitle: titles[0], viewSubtitle: titles[1],
      showPeriod: isDash || (isFactures && facIsList) || isComptaAnalytique, periodLabel, onPrev, onNext, prevStyle, nextStyle, periods,
      showReport, reportBtnStyle, onOpenReport, reportOpen, onCloseReport, onGenerateReport, reportSections, reportNote, onReportNote, reportStop, reportNotesOn, reportPeriodLabel: periodLabel,
      reportHeader, onReportHeader, reportHeaderSave, onToggleSaveHeader, onSaveReport, reportGhostStyle,
      showOpenSource, openSourceLabel, openSourceStyle, onOpenSource,
      kpis, treasury, cockpitActions, cockpitAlerts, cockpitAlertsEmpty, tableTitle, resultLabel, categories, filtered, moreLabel, rowPad, sideCards, dashEmpty, noteText, onNoteChange,
      q, onSearch, searchStyle, txPager,
      isAchatView, isGenericTable, achatRows,
      trashOpen, trashLabel, onTrashCancel, onTrashConfirm, trashConfirmStyle, hiddenAchatsChip, hiddenGrenkeChip,
      resetAskOpen: !!this.state.resetAsk,
      onResetAsk: () => this.setState({ resetAsk: true }),
      onResetCancel: () => this.setState({ resetAsk: null }),
      onResetConfirm: () => this.fullReset(),
      resetBtnStyle: 'padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;color:#b91c1c;background:#fff;border:1px solid #ecc9c9;cursor:pointer;font-family:inherit;white-space:nowrap',
      opsStatusChips, achatStatusChips, grenkeStatusChips,
      filePreviewOpen, filePreviewName, fpTabs, fpRows, fpColHeaders, fpCornerStyle, fpBackStyle, fpMore, fpInfo, onFpClose, onFpDownload, fpDownloadStyle, fpEditable, fpStatus,
      isGrenkeView, grenkeTableRows, grenkeHeaders, grenkeEmpty, grenkePager,
      emptyStyle, emptyBtnStyle, onGoImport,
      facTabs, facIsList, facIsCredits, facIsReco, facCards, facFilters, facRows, facCount, facturesEmpty,
      payResolveOpen, payResolve, onPayResolveClose,
      dashBody,
      facPager,
      relanceRows, creditSummary, creditRows, creditsEmpty,
      isSuivi, payTrackList, paySummary, payEmpty, payListEmpty, payEmptyMsg, payDraft, payEtatOptions, payEditing, onPayCommit, onPayReset, paySaveLabel,
      onPayNum, onPayClient, onPayTtc, onPayAvoir, onPayDateFac, onPayDateEch, onPayRegle, onPayDatePay, onPayEtat,
      payInput, payInputN, payLbl, paySaveStyle, payResetStyle, payRowBtnStyle, payDelBtnStyle, payDraftSolde,
      payDelOpen, payDelName, onPayDelConfirm, onPayDelCancel,
      onHealthOpen: () => this.openHealthCheck(),
      isSaisieCompta, compTab, compIsAchat, compIsVente, compIsFourn, compIsPaiement,
      impayesAchats, paiementEmpty, paiementModeOpts, paiementIsPartiel, paiementIsCheque, paiementIsAutre, paiementIsComptant, paiementComptantSolde, paiementSelectedLabel,
      paiementFilterOpts, paiementSortOpts,
      paiementSelRef, paiementSelPecheur, paiementSelMontantTotal, paiementSelPaye, paiementSelSolde,
      paiementChqList, paiementChqListLoading,
      paiementLocked, paiementFree, paiementShowChqActions, paiementShowVirementActions, paiementShowTexte, paiementShowEditRaw, paiementChequeRaw, paiementChqEditing, paiementChqEditVal,
      onChqEditOpen, onChqEditVal, onChqEditCancel, onChqEditCommit, onChqVirementConfirm,
      chqAddOpen, chqAddDraft, onChqAddOpen, onChqAddCancel, onChqAddCommit, chqAddModeOpts, chqAddIsCheque, chqAddNotCheque, chqAddIsAutre, onChqAddChequier, onChqAddChequeNum, onChqAddMontant, onChqAddObservation,
      chqAnnuleAskOpen, chqAnnuleAskText, onChqAnnuleAskCancel, onChqAnnuleAskConfirm, chqReplaceAskOpen, onChqReplaceNo, onChqReplaceYes,
      paiementDraft: pmd, onPaiementMontant, onPaiementChequier, onPaiementChequeNum, onPaiementObservation, onPaiementCommit, onPaiementReset, chequierOptions,
      fournDraft, fournTypeTabs, fournSaveLabel, onFournFourn, onFournNum, onFournDate, onFournMontant, onFournCommit, onFournReset,
      compModeTabs, compFanShow, compFanStyle, compFanTitle, compFanCards, onCompFanClose: () => this.setState({ compFan: null }),
      compKpis, compStockGroups, compStockEmpty, compJournal, compJournalEmpty, compJcount, compStatPay, compStatPech, compStatPechEmpty, compChqBody, compChqEmpty,
      pecheurSuggest, clientSuggest,
      achatDraft, achatNumHint, achatDraftLignes, achatDraftTotal, achatEditing, achatSaveLabel, onAchatNum, onAchatPecheur, onAchatDate, onAchatAddLigne, onAchatCommit, onAchatReset,
      achatPaiementImmediat, onAchatImmediatToggle,
      compPayModes, achatIsCheque, achatIsAutre, onAchatObservation, onAchatChequier, onAchatChequeNum, chequierOptions, achatChqHint,
      venteDraft, venteDraftLignes, venteDraftHt, venteDraftTtc, venteDelaiOptions, venteEditing, vsSaveLabel,
      onVSNum, onVSClient, onVSDate, onVSDelai, onVSTvaIrl, onVSTvaFr, onVSCommit, onVSReset, onVenteAddLigne, venteNumHint, venteNumHintStyle,
      venteAvoirActif, onVSAvoirToggle, onVSAvoir,
      venteGrenkeBtnLabel, venteGrenkeBtnStyle, onVenteGrenkeOpen,
      venteGrenkeOpen, vgMontant, vgP1, vgP2, vgCharges, vgRest, onVgMontant, onVgP1, onVgP2, onVgCharges, onVgSave, onVgCancel,
      gmList, gmSummary, gmEmpty, grkDraft, grkDraftRem, grkDraftRecv, grkStatutOptions, grkEditing, grkSaveLabel,
      onGrkNum, onGrkCust, onGrkTtc, onGrkP1, onGrkP2, onGrkCharge, onGrkStatut, onGrkCom, onGrkCommit, onGrkReset,
      gmDelOpen, gmDelName, onGrkDelConfirm, onGrkDelCancel,
      credPayAskOpen, credPayAskLabel, credPayAskMens, credPayAskHasBank, credPayAskMsg, onCredPayConfirm, onCredPayCancel,
      onCredNew, credAddStyle, credEditOpen, credIsEdit, credEditTitle, credVals, credTypeIsCredit, credTypeCreditStyle, credTypeAssurStyle, onCredLabel, onCredEnt, onCredTotal, onCredPaid, onCredMens, onCredNext, onCredTypeCredit, onCredTypeAssur, onCredCommit, onCredCancel, onCredDelete, credCommitStyle, credDeleteStyle, credInputStyle, credLabelStyle,
      recoStats, recoRows, recoNote, recoKeyTabs, recoKeyHint, recoEmpty,
      blCards, blRows, blCount, blStatus: this.state.blStatus, blSelectStyle, onBlStatus, modelBtnStyle, onOpenModel, blEmpty,
      blLibRows, blLibCount, blLibEmpty, blTypeChips,
      blMenuOpen, onToggleBlMenu, onCloseBlMenu, blMenuBtnStyle, blMenuItems,
      openModelBtnStyle, onOpenModelStock,
      stockRows, stockCount, stockAlert, stockPad, stockEmpty, openBtnStyle,
      stockReportShow, stkLastLabel, stockReportTiles, stockSpeciesShow, stockSpeciesRows, stockSaisieShow, stockSaisieNote,
      stockHubTabs, stockIsActuel, stockIsHistorique,
      vehicleRows, onVehicleAdd, vehicleBankOpen, vehicleBankRows, onVehicleBankClose,
      partnersRows, partnerTagHeader, volHeader, tiersTabs, tiersPeriodTabs,
      settingsIntro, sources, inputStyle, objInputs,
      setupOpen, setupSteps, setupPct, setupCountLabel, setupDoneCount, setupTotalCount, setupAllDone, onSetupClose, onSetupOpen, setupEntBadgeStyle, setupEntStatusLabel,
      demoMode: demo, demoToggleLabel, onToggleDemo, demoBtnStyle, demoStatusLabel, demoStatusStyle, demoModeText,
      prefixAskOpen, prefixAskKindLabel, prefixAskDir, prefixAskThing, prefixAskHelp, prefixAskValue, onPrefixInput, onPrefixConfirm, onPrefixCancel, onPrefixKey, prefixInputStyle, prefixConfirmStyle, prefixCancelStyle, prefixOverlayStyle, prefixCardStyle,
      grenkeLinkOpen, grenkeLinkNum, grenkeLinkHelp, grenkeLinkQuery, onGrenkeLinkQuery, onGrenkeLinkCancel, grenkeLinkList, grenkeLinkEmpty, grenkeLinkHasCurrent, grenkeLinkHasOverride, onGrenkeUnlink, onGrenkeAuto, grenkeLinkCardStyle, grenkeUnlinkStyle, grenkeAutoStyle,
      folderSupported, folderConnected, folderName, folderCount, folderFiles, onConnectFolder, onResyncFolder, folderBtnStyle, folderResyncStyle, folderBtnLabel, folderNote, capabilityNote,
      libraryRows, libraryCount, libraryFolderName, libraryEmpty, hasLibrary, libraryHint, libraryBtnStyle, libraryBtnLabel, libTypeChips, libSearch, onLibSearch, libSearchStyle,
      watchCount, autoRefresh, liveActive, liveLabel, lastSyncLabel, onToggleAuto, autoToggleStyle, liveDotStyle, liveBadgeStyle, hasWatch: watchCount > 0,
      reconnectOpen, reconnectLabel, onReconnect, reconnectBarStyle, reconnectBtnStyle, missingBannerStyle,
      errNotes, hasErr, noErr, errPanelOpen, errAvant, errApres, errWhere, errCount, onErrToggle, onErrAvant, onErrApres, onErrAdd, onErrCopy, errInputStyle, errAddStyle, errCopyLabel, errCopyStyle, errFabStyle, errBadge, errBadgeStyle,
      isBanque, bankStats, bankCount, bankChips, bankTableRows, bankPager, bankEmpty, bankNoResult, bankSearchStyle, bankQ: this.state.bankQ || '', onBankQ, hiddenBankChip,
      bankLinkOpen, bankLinkTitle, bankLinkHelp, bankLinkQuery: this.state.bankLinkQuery || '', onBankLinkQuery, bankLinkList, bankLinkEmpty, bankLinkHasCurrent, bankLinkHasOverride, onBankUnlink, onBankAuto, onBankLinkCancel, onBankManualDone, bankManualBtnStyle,
      salEmpOpts, salMonthOpts, salEmpValue: salEmpSel, salMonthValue: salMonthSel, onBankSalaryEmp, onBankSalaryMonth, onBankSalaryLink, bankSalaryBtnStyle, bankSalarySelStyle, bankSalaryHasRoster,
      bankCatOpts, pieOpen, pieHasData, pieEmpty, onPieToggle, pieToggleLabel, pieToggleStyle, pieHeadStyle, pieStyle, pieHoleStyle, pieTotal, pieSub, pieLegend,
      bankCatAskOpen, bankCatAskValue: this.state.bankCatAskValue || '', onBankCatInput, onBankCatCancel, onBankCatCommit, onBankCatKey, bankCatCommitStyle,
      bankCatPickOpen, bankCatPickTitle, bankCatPickSub, bankCatPickList, onBankCatPickCancel, onBankCatPickApply, onBankCatPickApplyAll, onBankCatPickNew, bankCatPickApplyStyle, bankCatPickAllStyle, bankCatPickAllLabel, bankCatPickNewStyle,
      isComptaAnalytique, caWeekList, caWeeklyShow, caChargeCards, caProductRows, caSnapshot, caSnapshotLabel, caMissingState,
      caCascade, caQuestions, caMargeBars, caSeuilFmt, caResultColor, caPeriodNote, caResult: this.fmt(caRES), caPerLabel,
      caPersInput, caTransInput, caFFInput, onCaPers, onCaTrans, onCaFF, caInputStyle,
      caAmortRows, caAmortMoisTot, caAmortAnTot, onAddAmortVeh, caBtnStyle, caHasStock: !!caSnapshot,
      chargesPickOpen: !!chargesPickGroup, chargesPickTitle, chargesPickItems, chargesPickEmpty, chargesPickNoResult, chargesPickQ, onChargesPickQ, onChargesPickClose,
      importOpen, importTitle, importFileName, importSheets, importSheetValue, onImportSheet, importHeaderOptions, importHeaderValue, onImportHeader, importFieldRows, importNote, importCombine, importCombineable, onImportCombine, importPreviewHead, importPreviewRows, importCount, importReady, importZeroWarn, onImportConfirm, onImportCancel, importSelStyle, importOverlayStyle, importCardStyle, importConfirmStyle, importCancelStyle,
      isHeures, hMode, hIsSemaine, hIsArchives, hModeTabs, hNavLabel, onHPrev, onHNext, hNavBtnStyle, onHToday, hTodayStyle,
      hWeekTotalLabel, hMonthTotalLabel, hMonthName, hStatCardStyle, hStatLabelStyle, hStatValStyle, onPrintHeures, printHeuresBtnStyle, hPrintOpen, hPrintItems, onHPrintCancel,
      hMonthlyCards, hMoisCardStyle, hMoisInputStyle,
      hPrintChooseEmployee, hPrintChoosePeriod, hPrintEmployeeName, hPrintWeekLabel, hPrintMonthLabel, onHPrintWeek, onHPrintMonth, onHPrintBack, hPrintPeriodStyle, hPrintBackStyle,
      hEmployees, hEmpty, onHAddEmp, hAddStyle, hEmpCardStyle, hChevStyle, hNameStyle, hCellStyle, hTotCellStyle, hDelStyle, hEmpTotStyle, hGridHeadStyle, hLegendStyle, hEmptyStyle,
      arFrom, arTo, onArFrom, onArTo, arMonthValue, arYearValue, arMonthOptions, arYearOptions, onArMonth, onArYear, hDateStyle, arRows, arEmpty, arPeriodLabel, arCountLabel, hArHeadStyle, hArLineStyle, hArChevStyle, hEditStyle,
      hDelOpen, hDelName, onHDelCancel, onHDelConfirm, hDelSummary, hDelHasHours, onHDelArchive, hDelArchiveStyle, hNuitTabs, hNuitStatus,
    };
  }
  setState(update, cb) {
    var patch = (typeof update === 'function') ? update(this.state) : update;
    this.state = Object.assign({}, this.state, patch);
    if (this.__scheduleRender) this.__scheduleRender();
    if (cb) cb();
  }
}
// ---------- montage + boucle de rendu ----------
var __app = document.getElementById('app');
var __tpl = document.getElementById('app-template');
stampTemplate(__tpl.content);
var __comp = new Component();
var __renderScheduled = false;

function __captureFocus() {
  var el = document.activeElement;
  if (!el || !__app.contains(el)) return null;
  var key = el.getAttribute('data-fkey') || el.id || null;
  if (!key) return null;
  var sel = null;
  try { if (typeof el.selectionStart === 'number') sel = [el.selectionStart, el.selectionEnd]; } catch (e) {}
  return { key: key, sel: sel };
}
function __restoreFocus(saved) {
  if (!saved) return;
  var el = __app.querySelector('[data-fkey="' + saved.key.replace(/"/g, '') + '"]') ||
    (saved.key ? document.getElementById(saved.key) : null);
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
    if (saved.sel && typeof el.setSelectionRange === 'function') el.setSelectionRange(saved.sel[0], saved.sel[1]);
  } catch (e) {}
}

// Si un rendu échoue APRÈS le premier affichage réussi, on garde l'écran précédent intact
// (rien n'est perdu) et on montre un bandeau d'erreur discret — au lieu d'effacer toute la page.
var __hasRendered = false;
var __errBar = null;
function __showRenderError(e) {
  if (!__errBar) {
    __errBar = document.createElement('div');
    __errBar.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:calc(100vw - 40px);background:#7f1d1d;color:#fff;font-size:12.5px;font-weight:500;padding:10px 14px;border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;gap:10px';
    var txt = document.createElement('span');
    var btn = document.createElement('button');
    btn.textContent = '✕';
    btn.style.cssText = 'border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;border-radius:6px;width:22px;height:22px;cursor:pointer;font-size:11px;padding:0;flex-shrink:0';
    btn.onclick = function () { __removeRenderError(); };
    __errBar.appendChild(txt); __errBar.appendChild(btn);
    document.body.appendChild(__errBar);
  }
  __errBar.firstChild.textContent = '⚠ Erreur d’affichage (l’écran précédent est conservé, rien n’est perdu) : ' + (e && e.message ? e.message : e);
  __errBar.style.display = 'flex';
}
function __removeRenderError() { if (__errBar) __errBar.style.display = 'none'; }
function __render() {
  var savedFocus = __captureFocus();
  var vals, res;
  try {
    vals = __comp.renderVals();
    res = interpretTemplate(__tpl, vals);
  } catch (e) {
    console.error('[render] échec:', e);
    if (!__hasRendered) { __app.textContent = 'Erreur de rendu : ' + (e && e.message ? e.message : e); return; }
    __showRenderError(e);
    return;
  }
  __app.replaceChildren(res.frag);
  __hasRendered = true;
  __removeRenderError();
  __restoreFocus(savedFocus);
  if (!savedFocus && res.toFocus.length) { try { res.toFocus[0].focus({ preventScroll: true }); } catch (e) {} }
}
function __scheduleRender() {
  if (__renderScheduled) return;
  __renderScheduled = true;
  Promise.resolve().then(function () { __renderScheduled = false; __render(); });
}
__comp.__scheduleRender = __scheduleRender;

window.addEventListener('error', function (e) {
  console.error('[app]', e.message, e.filename + ':' + e.lineno);
});

__render();
try { __comp.componentDidMount(); } catch (e) { console.error('[componentDidMount]', e); }
