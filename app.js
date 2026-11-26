/* ======================================================
   CONFIGURATION GITHUB (facultative, utile en local)
   ====================================================== */
const MANUAL_GITHUB_USER = '';
const MANUAL_GITHUB_REPO = '';
const MANUAL_GITHUB_BRANCH = ''; // vide = branche par défaut détectée
const DECKS_ROOT = 'decks';

/* ======================================================
   ÉTAT
   ====================================================== */
let cards = [];
let currentIndex = 0;
let isFlipped = false;
let isNavigating = false;

// Arbre : racine { folders: Map, files: [] }
let treeRoot = null;
let ghInfo = null;                 // { user, repo, branch }
const checkedFiles = new Set();    // chemins complets (decks/xx/yy.csv)

/* ======================================================
   ÉLÉMENTS UI
   ====================================================== */
const $ = (id) => document.getElementById(id);

const setupView = $('setup-view');
const appView = $('app-view');
const csvInput = $('csv-input');
const startBtn = $('start-btn');
const editBtn = $('edit-btn');
const clearInputBtn = $('clear-input-btn');
const cardElement = $('card');
const cardScene = $('card-scene');
const rectoText = $('recto-text');
const versoText = $('verso-text');
const prevBtn = $('prev-btn');
const nextBtn = $('next-btn');
const flipBtn = $('flip-btn');
const shuffleBtn = $('shuffle-btn');
const projectionBtn = $('projection-btn');
const counter = $('counter');
const progressFill = $('progress-fill');
const progressTrack = $('progress-track');
const delimiterSelect = $('delimiter');
const toast = $('toast');
const themeToggleBtn = $('theme-toggle');
const themeIcon = $('theme-icon');

const deckTreeEl = $('deck-tree');
const treeFilter = $('tree-filter');
const treeSummary = $('tree-summary');
const expandAllBtn = $('expand-all-btn');
const collapseAllBtn = $('collapse-all-btn');
const uncheckAllBtn = $('uncheck-all-btn');
const loadSelectedBtn = $('load-selected-btn');

/* ======================================================
   THÈME
   ====================================================== */
function initTheme() {
  const saved = localStorage.getItem('fc_theme');
  if (saved) return setTheme(saved);
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  setTheme(prefersLight ? 'light' : 'dark');
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('fc_theme', theme);
  themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

initTheme();

/* ======================================================
   MODE TABLEAU / PROJECTION
   ====================================================== */
function toggleProjectionMode() {
  const active = document.body.classList.toggle('projection-mode');
  projectionBtn.classList.toggle('active', active);
  projectionBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  showToast(active ? 'Mode tableau activé 🖥️' : 'Mode tableau désactivé');
}

projectionBtn.addEventListener('click', toggleProjectionMode);

/* ======================================================
   TOAST
   ====================================================== */
let toastTimeout;
function showToast(message) {
  toast.innerText = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2000);
}

/* ======================================================
   UTILITAIRES
   ====================================================== */
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function displayName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

function normalize(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/* ======================================================
   ARBORESCENCE GITHUB (récursive)
   ====================================================== */
function detectRepo() {
  let user = MANUAL_GITHUB_USER;
  let repo = MANUAL_GITHUB_REPO;

  if (!user || !repo) {
    const host = window.location.hostname;
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    if (host.endsWith('.github.io') && pathParts.length > 0) {
      user = host.replace('.github.io', '');
      repo = pathParts[0];
    }
  }
  return (user && repo) ? { user, repo } : null;
}

function buildTree(filePaths) {
  const root = { name: '', path: DECKS_ROOT, folders: new Map(), files: [] };
  const prefix = DECKS_ROOT + '/';

  for (const fullPath of filePaths) {
    const rel = fullPath.slice(prefix.length);
    const parts = rel.split('/');
    const filename = parts.pop();

    let node = root;
    let acc = DECKS_ROOT;
    for (const part of parts) {
      acc += '/' + part;
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, path: acc, folders: new Map(), files: [] });
      }
      node = node.folders.get(part);
    }
    node.files.push({ name: filename, path: fullPath });
  }
  return root;
}

function setTreeMessage(msg) {
  deckTreeEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'tree-message';
  div.textContent = msg;
  deckTreeEl.appendChild(div);
  expandAllBtn.disabled = collapseAllBtn.disabled = uncheckAllBtn.disabled = true;
  treeFilter.disabled = true;
}

async function loadGitHubDecks() {
  const detected = detectRepo();
  if (!detected) {
    setTreeMessage('(Détection active sur GitHub Pages — ou renseignez MANUAL_GITHUB_USER / REPO dans le script)');
    return;
  }

  try {
    let branch = MANUAL_GITHUB_BRANCH;
    if (!branch) {
      const repoRes = await fetch(`https://api.github.com/repos/${detected.user}/${detected.repo}`);
      if (!repoRes.ok) throw new Error('repo');
      branch = (await repoRes.json()).default_branch;
    }

    ghInfo = { user: detected.user, repo: detected.repo, branch };

    // Un seul appel pour tout l'arbre (récursif)
    const treeRes = await fetch(
      `https://api.github.com/repos/${ghInfo.user}/${ghInfo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    if (!treeRes.ok) throw new Error('tree');
    const data = await treeRes.json();

    if (data.truncated) {
      console.warn('Arborescence tronquée par GitHub : certains decks peuvent manquer.');
    }

    const prefix = DECKS_ROOT + '/';
    const csvPaths = data.tree
      .filter(n => n.type === 'blob' && n.path.startsWith(prefix) && n.path.toLowerCase().endsWith('.csv'))
      .map(n => n.path);

    if (csvPaths.length === 0) {
      setTreeMessage('(Aucun fichier .csv trouvé dans /decks)');
      return;
    }

    treeRoot = buildTree(csvPaths);
    renderTree();
  } catch (err) {
    console.error(err);
    setTreeMessage('(Impossible de charger les fichiers du dépôt)');
  }
}

/* ======================================================
   ARBRE : RENDU, SÉLECTION, FILTRE
   ====================================================== */
function collectFiles(node, out = []) {
  node.files.forEach(f => out.push(f.path));
  node.folders.forEach(sub => collectFiles(sub, out));
  return out;
}

function sortedFolders(node) {
  return [...node.folders.values()].sort((a, b) => collator.compare(a.name, b.name));
}

function sortedFiles(node) {
  return [...node.files].sort((a, b) => collator.compare(a.name, b.name));
}

// Retourne true si le noeud (ou un descendant) correspond au filtre
function nodeMatches(node, query) {
  if (!query) return true;
  if (normalize(node.name || '').includes(query)) return true;
  if (node.files.some(f => normalize(f.path).includes(query))) return true;
  for (const sub of node.folders.values()) {
    if (nodeMatches(sub, query)) return true;
  }
  return false;
}

function renderTree() {
  const query = normalize(treeFilter.value.trim());
  const openState = captureOpenState();

  deckTreeEl.innerHTML = '';
  expandAllBtn.disabled = collapseAllBtn.disabled = uncheckAllBtn.disabled = false;
  treeFilter.disabled = false;

  const rootUl = document.createElement('ul');
  rootUl.style.listStyle = 'none';
  renderChildren(treeRoot, rootUl, query, openState, 0);

  if (!rootUl.children.length) {
    setTreeMessage('Aucun deck ne correspond au filtre.');
    treeFilter.disabled = false;
    expandAllBtn.disabled = collapseAllBtn.disabled = false;
    return;
  }

  deckTreeEl.appendChild(rootUl);
  refreshCheckStates();
}

function captureOpenState() {
  const state = new Set();
  deckTreeEl.querySelectorAll('.tree-node[data-folder]').forEach(li => {
    const ch = li.querySelector(':scope > .tree-children');
    if (ch && !ch.classList.contains('collapsed')) state.add(li.dataset.folder);
  });
  return state;
}

function renderChildren(node, ul, query, openState, depth) {
  for (const folder of sortedFolders(node)) {
    if (!nodeMatches(folder, query)) continue;
    ul.appendChild(renderFolder(folder, query, openState, depth));
  }
  for (const file of sortedFiles(node)) {
    if (query && !normalize(file.path).includes(query) && !folderNameMatchesPath(file.path, query)) continue;
    ul.appendChild(renderFile(file));
  }
}

function folderNameMatchesPath(path, query) {
  return normalize(path).includes(query);
}

function renderFolder(folder, query, openState, depth) {
  const li = document.createElement('li');
  li.className = 'tree-node';
  li.dataset.folder = folder.path;

  const row = document.createElement('div');
  row.className = 'tree-row';

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  toggle.textContent = '▶';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.folderCb = folder.path;

  const label = document.createElement('span');
  label.className = 'tree-label folder';
  label.textContent = '📁 ' + folder.name;

  const total = collectFiles(folder).length;
  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = total;

  row.append(toggle, cb, label, count);

  const childrenUl = document.createElement('ul');
  childrenUl.className = 'tree-children';
  childrenUl.style.listStyle = 'none';
  renderChildren(folder, childrenUl, query, openState, depth + 1);

  // Ouvert si : filtre actif, ou déjà ouvert avant re-rendu
  const shouldOpen = !!query || openState.has(folder.path);
  if (!shouldOpen) childrenUl.classList.add('collapsed');
  toggle.classList.toggle('open', shouldOpen);

  const toggleOpen = () => {
    const collapsed = childrenUl.classList.toggle('collapsed');
    toggle.classList.toggle('open', !collapsed);
  };

  toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });
  label.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });
  count.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });

  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    const files = collectFiles(folder);
    files.forEach(p => cb.checked ? checkedFiles.add(p) : checkedFiles.delete(p));
    refreshCheckStates();
  });

  row.addEventListener('click', toggleOpen);

  li.append(row, childrenUl);
  return li;
}

function renderFile(file) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';

  const spacer = document.createElement('span');
  spacer.className = 'tree-toggle leaf';
  spacer.textContent = '▶';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.filePath = file.path;
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => {
    cb.checked ? checkedFiles.add(file.path) : checkedFiles.delete(file.path);
    refreshCheckStates();
  });

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = '📄 ' + displayName(file.name);
  label.title = file.path;

  row.addEventListener('click', () => cb.click());

  row.append(spacer, cb, label);
  li.appendChild(row);
  return li;
}

// Met à jour les cases (état coché / indéterminé) et le résumé
function refreshCheckStates() {
  deckTreeEl.querySelectorAll('input[data-file-path]').forEach(cb => {
    cb.checked = checkedFiles.has(cb.dataset.filePath);
  });

  deckTreeEl.querySelectorAll('input[data-folder-cb]').forEach(cb => {
    const folder = findFolder(treeRoot, cb.dataset.folderCb);
    if (!folder) return;
    const files = collectFiles(folder);
    const n = files.filter(p => checkedFiles.has(p)).length;
    cb.checked = n > 0 && n === files.length;
    cb.indeterminate = n > 0 && n < files.length;
  });

  const n = checkedFiles.size;
  treeSummary.textContent = n === 0
    ? 'Aucun deck sélectionné.'
    : `${n} deck${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}.`;
  loadSelectedBtn.disabled = n === 0;
}

function findFolder(node, path) {
  if (node.path === path) return node;
  for (const sub of node.folders.values()) {
    const found = findFolder(sub, path);
    if (found) return found;
  }
  return null;
}

function setAllOpen(open) {
  deckTreeEl.querySelectorAll('.tree-children').forEach(ul => ul.classList.toggle('collapsed', !open));
  deckTreeEl.querySelectorAll('.tree-toggle:not(.leaf)').forEach(t => t.classList.toggle('open', open));
}

treeFilter.addEventListener('input', () => { if (treeRoot) renderTree(); });
expandAllBtn.addEventListener('click', () => setAllOpen(true));
collapseAllBtn.addEventListener('click', () => setAllOpen(false));
uncheckAllBtn.addEventListener('click', () => {
  checkedFiles.clear();
  refreshCheckStates();
});

// Charge tous les fichiers cochés et les fusionne dans la zone de texte
loadSelectedBtn.addEventListener('click', async () => {
  if (!ghInfo || checkedFiles.size === 0) return;

  const paths = [...checkedFiles].sort(collator.compare);
  loadSelectedBtn.disabled = true;
  csvInput.value = 'Chargement en cours...';

  try {
    const texts = await Promise.all(paths.map(async (p) => {
      const url = `https://raw.githubusercontent.com/${ghInfo.user}/${ghInfo.repo}/${encodeURIComponent(ghInfo.branch)}/${encodePath(p)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(p);
      let t = await res.text();
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);   // BOM
      return t.replace(/\r\n?/g, '\n').trim();
    }));

    csvInput.value = texts.filter(Boolean).join('\n');
    showToast(`${paths.length} deck${paths.length > 1 ? 's' : ''} chargé${paths.length > 1 ? 's' : ''} ✓`);
  } catch (e) {
    alert('Erreur lors du téléchargement de : ' + e.message);
    csvInput.value = '';
  } finally {
    loadSelectedBtn.disabled = checkedFiles.size === 0;
  }
});

loadGitHubDecks();

/* ======================================================
   PARSEUR CSV (guillemets, séparateurs dans les cellules,
   retours à la ligne dans les cellules, "" échappés)
   ====================================================== */
function detectDelimiter(text) {
  if (delimiterSelect.value !== 'auto') {
    return delimiterSelect.value === '\\t' ? '\t' : delimiterSelect.value;
  }

  // Choisir le séparateur qui produit le plus de lignes cohérentes,
  // en laissant parseCSV ignorer les séparateurs dans les champs cités.
  const candidates = [';', '\t', ',', '/'];
  let best = ';';
  let bestScore = null;

  for (const candidate of candidates) {
    const rows = parseCSV(text, candidate);
    if (rows.length === 0) continue;

    const widths = new Map();
    for (const row of rows) {
      if (row.length >= 2) widths.set(row.length, (widths.get(row.length) || 0) + 1);
    }
    if (widths.size === 0) continue;

    // En cas d'égalité de fréquence, préférer le plus petit nombre de
    // colonnes (moins de risques de prendre un séparateur de contenu).
    let modalWidth = Infinity;
    let matchingRows = 0;
    for (const [width, count] of widths) {
      if (count > matchingRows || (count === matchingRows && width < modalWidth)) {
        modalWidth = width;
        matchingRows = count;
      }
    }

    const score = [matchingRows / rows.length, matchingRows, -modalWidth];
    if (bestScore === null || score.some((value, i) =>
      value > bestScore[i] && score.slice(0, i).every((v, j) => v === bestScore[j]))) {
      best = candidate;
      bestScore = score;
    }
  }

  // Semicolon is the deterministic fallback for no evidence or a tie.
  return best;
}

// Retourne un tableau de lignes, chaque ligne = tableau de cellules
function parseCSV(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let wasQuoted = false;

  const endCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some(c => c !== '')) rows.push(row);
    row = [];
  };

  text = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.trim() === '') {
      // Début de cellule entre guillemets
      inQuotes = true;
      wasQuoted = true;
      cell = '';
    } else if (ch === delim) {
      endCell();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
    }
  }

  // Dernière ligne sans saut de ligne final
  if (cell !== '' || row.length > 0 || wasQuoted) endRow();

  return rows;
}

/* ======================================================
   CARTES
   ====================================================== */
clearInputBtn.addEventListener('click', () => {
  if (confirm('Voulez-vous effacer le contenu actuel ?')) {
    csvInput.value = '';
    checkedFiles.clear();
    if (treeRoot) refreshCheckStates();
    cards = [];
  }
});

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function shuffleCurrentDeck() {
  if (cards.length <= 1) return;
  shuffleArray(cards);
  currentIndex = 0;
  showCard();
  showToast('Cartes mélangées ! 🔀');
}

function startFromText() {
  const text = csvInput.value.trim();
  if (!text) return alert('Veuillez coller des données ou sélectionner un fichier.');

  const delim = detectDelimiter(text);
  const rows = parseCSV(text, delim);
  cards = [];

  for (const parts of rows) {
    if (parts.length < 2) continue;
    const front = parts[0];
    const back = parts.slice(1).join(delim === '\t' ? ' ' : delim + ' ').trim();
    if (front && back) cards.push({ front, back });
  }

  if (cards.length === 0) {
    return alert('Aucune carte valide trouvée. Vérifiez que votre séparateur correspond bien.');
  }

  currentIndex = 0;
  showCard();
  setupView.style.display = 'none';
  appView.style.display = 'flex';
}

function resetCardToFrontInstantly() {
  if (!isFlipped && !cardElement.classList.contains('is-flipped')) return;

  // La navigation change le contenu : revenir au recto sans laisser la
  // transition 3D afficher l'ancien verso (ou le verso de la nouvelle carte).
  cardElement.style.transition = 'none';
  cardElement.classList.remove('is-flipped');
  isFlipped = false;
  void cardElement.offsetWidth;
  cardElement.style.removeProperty('transition');
}

function showCard() {
  resetCardToFrontInstantly();

  const card = cards[currentIndex];
  rectoText.innerText = card.front;
  versoText.innerText = card.back;
  counter.innerText = `Carte ${currentIndex + 1} / ${cards.length}`;

  // Barre de progression
  const pct = cards.length > 0 ? ((currentIndex + 1) / cards.length) * 100 : 0;
  progressFill.style.width = pct + '%';
  progressTrack.setAttribute('aria-valuenow', Math.round(pct));

  prevBtn.disabled = currentIndex === 0;
  nextBtn.disabled = currentIndex === cards.length - 1;
}

function toggleFlip() {
  isFlipped = !isFlipped;
  cardElement.classList.toggle('is-flipped', isFlipped);
}

function animateCardChange(direction, updateIndex) {
  if (isNavigating) return;
  isNavigating = true;
  const exitClass = direction === 'left' ? 'is-exiting-left' : 'is-exiting-right';
  const enterClass = direction === 'left' ? 'is-entering-right' : 'is-entering-left';
  const animationClasses = [
    'is-exiting-left', 'is-exiting-right', 'is-entering-left', 'is-entering-right'
  ];

  const runAnimation = (className, onComplete) => {
    cardScene.classList.remove(...animationClasses);
    // Force le recalcul pour pouvoir rejouer proprement la même animation.
    void cardScene.offsetWidth;
    let finished = false;
    let fallbackTimer;
    const finish = (event) => {
      if (finished || (event && event.target !== cardScene)) return;
      finished = true;
      clearTimeout(fallbackTimer);
      cardScene.removeEventListener('animationend', finish);
      cardScene.classList.remove(className);
      onComplete();
    };
    cardScene.addEventListener('animationend', finish);
    cardScene.classList.add(className);
    // Secours pour les navigateurs qui n'émettent pas animationend.
    fallbackTimer = setTimeout(() => finish(), 350);
  };

  runAnimation(exitClass, () => {
    updateIndex();
    showCard();
    runAnimation(enterClass, () => { isNavigating = false; });
  });
}

function nextCard() {
  if (currentIndex < cards.length - 1) {
    animateCardChange('left', () => { currentIndex++; });
  }
}

function prevCard() {
  if (currentIndex > 0) {
    animateCardChange('right', () => { currentIndex--; });
  }
}

startBtn.addEventListener('click', startFromText);
shuffleBtn.addEventListener('click', shuffleCurrentDeck);

editBtn.addEventListener('click', () => {
  appView.style.display = 'none';
  setupView.style.display = 'flex';
});

flipBtn.addEventListener('click', toggleFlip);
nextBtn.addEventListener('click', nextCard);
prevBtn.addEventListener('click', prevCard);

/* ======================================================
   GESTES TACTILES (swipe)
   - gauche/droite : navigation
   - haut/bas : retourner
   - simple tap : retourner
   ====================================================== */
const SWIPE_MIN = 40;      // distance minimale (px)
const TAP_MAX = 10;        // déplacement max pour un "tap"
let touchStart = null;
let swipeHandled = false;

cardScene.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touchStart = null; return; }
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
}, { passive: true });

cardScene.addEventListener('touchmove', (e) => {
  if (!touchStart) return;
  const t = e.touches[0];
  const dx = Math.abs(t.clientX - touchStart.x);
  const dy = Math.abs(t.clientY - touchStart.y);
  // Empêche le scroll de la page pendant un swipe vertical franc
  if (dy > dx && dy > 15 && e.cancelable) e.preventDefault();
}, { passive: false });

cardScene.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  touchStart = null;

  if (absX < TAP_MAX && absY < TAP_MAX) {
    // Tap : géré ici pour éviter le double déclenchement avec "click"
    swipeHandled = true;
    toggleFlip();
    return;
  }

  if (Math.max(absX, absY) < SWIPE_MIN) return;

  swipeHandled = true;
  if (absX > absY) {
    dx < 0 ? nextCard() : prevCard();
  } else {
    toggleFlip();
  }
}, { passive: true });

cardScene.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });

// Clic souris (ignoré si le toucher vient d'être traité)
cardScene.addEventListener('click', () => {
  if (swipeHandled) { swipeHandled = false; return; }
  toggleFlip();
});

/* ======================================================
   CLAVIER
   ====================================================== */
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (appView.style.display !== 'flex') return;

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.code === 'Space') {
    e.preventDefault();
    toggleFlip();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    nextCard();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    prevCard();
  }
});
