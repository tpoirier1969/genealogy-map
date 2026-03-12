const STORAGE_KEY = 'camping-map-local-edits-v5';
const CATEGORY_LABELS = {
  boondocking: 'Boondocking',
  public: 'State / County / Town',
  federal: 'Federal Lands',
  private: 'Private Campgrounds',
  info: 'Info / Reference'
};
const CATEGORY_COLORS = {
  boondocking: '#4f6b3c',
  public: '#c7ae72',
  federal: '#c97d32',
  private: '#8a5b35',
  info: '#d7bf3c'
};

let map;
let allSites = [];
let selectedSiteId = null;
let moveModeSiteId = null;
let pendingActionLatLng = null;
let clusterGroup;
let markerById = new Map();
let toastTimer = null;

const localEdits = loadLocalEdits();
const ui = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  grabUi();
  initMap();
  bindUi();
  if (window.innerWidth < 900) ui.menuPanel.classList.remove('open');
  const baseSites = await fetch('data/sites.json', { cache: 'no-cache' }).then(r => r.json());
  allSites = mergeSites(baseSites, localEdits);
  renderMap();
  closeActionMenu();
  updateEditCounts();
  registerServiceWorker();
}

function grabUi() {
  Object.assign(ui, {
    menuPanel: document.getElementById('menuPanel'),
    menuToggle: document.getElementById('menuToggle'),
    searchInput: document.getElementById('searchInput'),
    sitePanel: document.getElementById('sitePanel'),
    sitePanelContent: document.getElementById('sitePanelContent'),
    closeSitePanelBtn: document.getElementById('closeSitePanelBtn'),
    collapseSitePanelBtn: document.getElementById('collapseSitePanelBtn'),
    sitePanelHandle: document.getElementById('sitePanelHandle'),
    actionMenu: document.getElementById('actionMenu'),
    actionCoords: document.getElementById('actionCoords'),
    addSiteHereBtn: document.getElementById('addSiteHereBtn'),
    cancelActionMenuBtn: document.getElementById('cancelActionMenuBtn'),
    moveBanner: document.getElementById('moveBanner'),
    cancelMoveBtn: document.getElementById('cancelMoveBtn'),
    editModal: document.getElementById('editModal'),
    siteForm: document.getElementById('siteForm'),
    closeEditModalBtn: document.getElementById('closeEditModalBtn'),
    cancelSiteFormBtn: document.getElementById('cancelSiteFormBtn'),
    editsModal: document.getElementById('editsModal'),
    manageEditsBtn: document.getElementById('manageEditsBtn'),
    closeEditsModalBtn: document.getElementById('closeEditsModalBtn'),
    clearEditsBtn: document.getElementById('clearEditsBtn'),
    downloadEditsBtn: document.getElementById('downloadEditsBtn'),
    importEditsInput: document.getElementById('importEditsInput'),
    editCounts: document.getElementById('editCounts')
  });
}

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    doubleClickZoom: false,
    preferCanvas: true
  }).setView([44.9, -89.5], 5);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  addLocateControl();

  map.on('contextmenu', (e) => {
    pendingActionLatLng = e.latlng;
    openActionMenu(e.containerPoint, e.latlng);
  });

  map.on('dblclick', (e) => {
    pendingActionLatLng = e.latlng;
    openActionMenu(e.containerPoint, e.latlng);
  });

  map.on('click', async (e) => {
    closeActionMenu();
    if (moveModeSiteId) {
      const site = getSiteById(moveModeSiteId);
      if (!site) return cancelMoveMode();
      const ok = confirm(`Move "${site.name}" here?\n${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`);
      if (!ok) return;
      upsertOverride({ id: site.id, lat: e.latlng.lat, lng: e.latlng.lng });
      allSites = mergeSites(allSites.filter(s => !s.isLocalBase), localEdits, true);
      renderMap();
      openSiteDetails(getSiteById(site.id));
      cancelMoveMode();
      showToast('Site moved.');
    }
  });
}

function bindUi() {
  ui.menuToggle.addEventListener('click', () => ui.menuPanel.classList.toggle('open'));
  ui.closeSitePanelBtn.addEventListener('click', () => closeSitePanel());
  ui.collapseSitePanelBtn.addEventListener('click', () => ui.sitePanel.classList.toggle('collapsed'));
  ui.addSiteHereBtn.addEventListener('click', () => {
    if (!pendingActionLatLng) return;
    openSiteForm(pendingActionLatLng);
    closeActionMenu();
  });
  ui.cancelActionMenuBtn.addEventListener('click', closeActionMenu);
  ui.cancelMoveBtn.addEventListener('click', cancelMoveMode);
  ui.closeEditModalBtn.addEventListener('click', closeSiteForm);
  ui.cancelSiteFormBtn.addEventListener('click', closeSiteForm);
  ui.siteForm.addEventListener('submit', onSiteFormSubmit);
  ui.manageEditsBtn.addEventListener('click', () => ui.editsModal.classList.remove('hidden'));
  ui.closeEditsModalBtn.addEventListener('click', () => ui.editsModal.classList.add('hidden'));
  ui.clearEditsBtn.addEventListener('click', clearLocalEdits);
  ui.downloadEditsBtn.addEventListener('click', downloadEditsBackup);
  ui.importEditsInput.addEventListener('change', importEditsFile);

  document.querySelectorAll('[data-layer]').forEach(el => {
    el.addEventListener('change', renderMap);
  });
  ui.searchInput.addEventListener('input', renderMap);

  window.addEventListener('resize', () => {
    closeActionMenu();
    keepPanelInBounds();
  });

  makePanelDraggable(ui.sitePanel, ui.sitePanelHandle);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeActionMenu();
      cancelMoveMode();
      closeSiteForm();
      ui.editsModal.classList.add('hidden');
    }
  });
}

function renderMap() {
  if (clusterGroup) map.removeLayer(clusterGroup);
  markerById.clear();

  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 28,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 9,
    iconCreateFunction: createClusterIcon
  });

  const visibleCategories = new Set(
    [...document.querySelectorAll('[data-layer]:checked')].map(el => el.dataset.layer)
  );
  const q = ui.searchInput.value.trim().toLowerCase();

  const filtered = allSites.filter(site => {
    if (!visibleCategories.has(site.category)) return false;
    if (!q) return true;
    const haystack = `${site.name} ${site.description || ''} ${site.sourceFolder || ''} ${site.categoryLabel || ''}`.toLowerCase();
    return haystack.includes(q);
  });

  filtered.forEach(site => {
    const marker = L.marker([site.lat, site.lng], {
      icon: createSiteIcon(site.category),
      title: site.name
    });
    marker.siteId = site.id;
    marker.on('click', () => {
      selectedSiteId = site.id;
      openSiteDetails(site);
    });
    marker.bindPopup(buildPopupHtml(site), { className: 'custom-popup', offset: [0, -8] });
    clusterGroup.addLayer(marker);
    markerById.set(site.id, marker);
  });

  map.addLayer(clusterGroup);
}

function createSiteIcon(category) {
  return L.divIcon({
    html: `<div class="site-marker ${category}"></div>`,
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10]
  });
}

function createClusterIcon(cluster) {
  const childMarkers = cluster.getAllChildMarkers();
  const counts = {};
  childMarkers.forEach(m => {
    const site = getSiteById(m.siteId);
    const cat = site?.category || 'public';
    counts[cat] = (counts[cat] || 0) + 1;
  });
  const dominant = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]?.[0] || 'public';
  const count = cluster.getChildCount();
  const sizeClass = count < 10 ? 'cluster-small' : count < 50 ? 'cluster-medium' : 'cluster-large';
  const bg = CATEGORY_COLORS[dominant] || '#4f6b3c';
  return L.divIcon({
    html: `<div class="cluster-wrap" style="background:${bg}"><span>${count}</span></div>`,
    className: sizeClass,
    iconSize: count < 10 ? [34,34] : count < 50 ? [40,40] : [48,48]
  });
}

function buildPopupHtml(site) {
  const desc = (site.description || '').trim();
  const short = desc.length > 120 ? `${desc.slice(0, 117)}…` : desc;
  const nav = `https://www.google.com/maps?q=${encodeURIComponent(site.lat + ',' + site.lng)}`;
  return `
    <div class="popup-title">${escapeHtml(site.name)}</div>
    <div class="popup-meta">${escapeHtml(site.categoryLabel || CATEGORY_LABELS[site.category] || '')}</div>
    ${short ? `<div class="popup-meta">${escapeHtml(short)}</div>` : ''}
    <div class="popup-actions">
      ${site.website ? `<a class="popup-link" href="${escapeAttr(site.website)}" target="_blank" rel="noopener">Website</a>` : ''}
      <a class="popup-link" href="${nav}" target="_blank" rel="noopener">Navigate</a>
    </div>
  `;
}

function openSiteDetails(site) {
  if (!site) return;
  ui.sitePanel.classList.remove('hidden');
  const color = CATEGORY_COLORS[site.category] || '#4f6b3c';
  ui.sitePanelContent.innerHTML = `
    <div class="site-pill" style="background:${color}">${escapeHtml(site.categoryLabel || CATEGORY_LABELS[site.category])}</div>
    <h2 class="site-title">${escapeHtml(site.name)}</h2>
    <div class="site-meta">Source folder: ${escapeHtml(site.sourceFolder || 'Local edit')}</div>
    ${site.description ? `<div class="site-copy">${escapeHtml(site.description)}</div>` : '<div class="site-copy">No notes yet.</div>'}
    <div class="coords">${site.lat.toFixed(6)}, ${site.lng.toFixed(6)}</div>
    <div class="site-links">
      ${site.website ? `<a class="popup-link" href="${escapeAttr(site.website)}" target="_blank" rel="noopener">Website</a>` : ''}
      <a class="popup-link" href="https://www.google.com/maps?q=${encodeURIComponent(site.lat + ',' + site.lng)}" target="_blank" rel="noopener">Navigate</a>
    </div>
    <button id="moveSiteBtn" class="menu-btn action-primary">Move Site</button>
  `;
  ui.sitePanel.classList.remove('collapsed');
  document.getElementById('moveSiteBtn').addEventListener('click', () => startMoveMode(site.id));
  keepPanelInBounds();
}

function closeSitePanel() {
  ui.sitePanel.classList.add('hidden');
  ui.sitePanel.classList.add('collapsed');
}

function openActionMenu(containerPoint, latlng) {
  cancelMoveMode();
  ui.actionCoords.textContent = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
  ui.actionMenu.classList.remove('hidden');
  const padding = 14;
  const menuRect = { width: 280, height: 150 };
  const x = Math.min(window.innerWidth - menuRect.width - padding, Math.max(padding, containerPoint.x));
  const y = Math.min(window.innerHeight - menuRect.height - padding, Math.max(70, containerPoint.y + 58));
  ui.actionMenu.style.left = `${x}px`;
  ui.actionMenu.style.top = `${y}px`;
}

function closeActionMenu() {
  ui.actionMenu.classList.add('hidden');
  pendingActionLatLng = null;
}

function openSiteForm(latlng) {
  ui.siteForm.reset();
  ui.siteForm.elements.lat.value = latlng.lat.toFixed(6);
  ui.siteForm.elements.lng.value = latlng.lng.toFixed(6);
  ui.editModal.classList.remove('hidden');
}

function closeSiteForm() {
  ui.editModal.classList.add('hidden');
}

function onSiteFormSubmit(e) {
  e.preventDefault();
  const fd = new FormData(ui.siteForm);
  const site = {
    id: `local-${Date.now()}`,
    name: String(fd.get('name')).trim(),
    category: String(fd.get('category')),
    categoryLabel: CATEGORY_LABELS[String(fd.get('category'))],
    sourceFolder: 'Local edit',
    lat: Number(fd.get('lat')),
    lng: Number(fd.get('lng')),
    website: String(fd.get('website') || '').trim(),
    description: String(fd.get('description') || '').trim(),
    isLocal: true
  };
  localEdits.addedSites.push(site);
  persistLocalEdits();
  allSites = mergeSites(allSites.filter(s => !s.isLocalBase), localEdits, true);
  renderMap();
  closeSiteForm();
  showToast('Site added.');
}

function startMoveMode(siteId) {
  moveModeSiteId = siteId;
  ui.moveBanner.classList.remove('hidden');
  ui.moveBanner.querySelector('#moveBannerText').textContent = 'Tap the new location for this site.';
}

function cancelMoveMode() {
  moveModeSiteId = null;
  ui.moveBanner.classList.add('hidden');
}

function upsertOverride(override) {
  const idx = localEdits.overrides.findIndex(o => o.id === override.id);
  if (idx >= 0) localEdits.overrides[idx] = { ...localEdits.overrides[idx], ...override };
  else localEdits.overrides.push(override);
  persistLocalEdits();
  updateEditCounts();
}

function mergeSites(baseSites, edits, preserveExistingBase = false) {
  // preserveExistingBase true means incoming baseSites may already include local sites; strip them first above.
  const sites = preserveExistingBase ? [...baseSites] : [...baseSites.map(s => ({ ...s }))];
  const overrideMap = new Map((edits?.overrides || []).map(o => [o.id, o]));
  const merged = sites.map(site => {
    const override = overrideMap.get(site.id);
    return override ? { ...site, ...override } : site;
  });
  const added = (edits?.addedSites || []).map(site => ({ ...site, isLocalBase: true }));
  return [...merged, ...added];
}

function loadLocalEdits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { overrides: [], addedSites: [] };
    const parsed = JSON.parse(raw);
    return {
      overrides: Array.isArray(parsed.overrides) ? parsed.overrides : [],
      addedSites: Array.isArray(parsed.addedSites) ? parsed.addedSites : []
    };
  } catch {
    return { overrides: [], addedSites: [] };
  }
}

function persistLocalEdits() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(localEdits));
  updateEditCounts();
}

function getSiteById(id) {
  return allSites.find(site => site.id === id) || null;
}

function updateEditCounts() {
  ui.editCounts.innerHTML = `
    <p><strong>${localEdits.overrides.length}</strong> moved / corrected sites</p>
    <p><strong>${localEdits.addedSites.length}</strong> locally added sites</p>
  `;
}

function clearLocalEdits() {
  if (!confirm('Clear all local edits from this browser?')) return;
  localStorage.removeItem(STORAGE_KEY);
  localEdits.overrides = [];
  localEdits.addedSites = [];
  location.reload();
}

function downloadEditsBackup() {
  const blob = new Blob([JSON.stringify(localEdits, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'camping-map-local-edits.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importEditsFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.overrides) || !Array.isArray(parsed.addedSites)) {
      throw new Error('That file does not look like a camping-map edits backup.');
    }
    localEdits.overrides = parsed.overrides;
    localEdits.addedSites = parsed.addedSites;
    persistLocalEdits();
    location.reload();
  } catch (err) {
    alert(err.message || 'Could not import that edits file.');
  } finally {
    e.target.value = '';
  }
}

function addLocateControl() {
  const LocateControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const wrapper = L.DomUtil.create('div', 'leaflet-bar locate-control');
      const btn = L.DomUtil.create('button', '', wrapper);
      btn.type = 'button';
      btn.textContent = '◎';
      btn.title = 'Locate me';
      L.DomEvent.disableClickPropagation(wrapper);
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stop(e);
        map.locate({ setView: true, maxZoom: 12 });
      });
      return wrapper;
    }
  });
  map.addControl(new LocateControl());
  map.on('locationerror', () => showToast('Could not get your location.'));
}

function makePanelDraggable(panel, handle) {
  let dragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;
  const desktopOnly = () => window.innerWidth > 900;
  const pointerDown = (e) => {
    if (!desktopOnly()) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    startX = e.clientX ?? e.touches?.[0]?.clientX;
    startY = e.clientY ?? e.touches?.[0]?.clientY;
    origLeft = rect.left;
    origTop = rect.top;
    document.body.style.userSelect = 'none';
  };
  const pointerMove = (e) => {
    if (!dragging) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX;
    const y = e.clientY ?? e.touches?.[0]?.clientY;
    panel.style.left = `${origLeft + x - startX}px`;
    panel.style.top = `${origTop + y - startY}px`;
    keepPanelInBounds();
  };
  const pointerUp = () => {
    dragging = false;
    document.body.style.userSelect = '';
  };
  handle.addEventListener('pointerdown', pointerDown);
  window.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
}

function keepPanelInBounds() {
  if (ui.sitePanel.classList.contains('hidden')) return;
  if (window.innerWidth <= 900) {
    ui.sitePanel.style.left = '';
    ui.sitePanel.style.top = '';
    ui.sitePanel.style.right = '';
    ui.sitePanel.style.bottom = '';
    return;
  }
  const rect = ui.sitePanel.getBoundingClientRect();
  const minTop = 70;
  const minLeft = 8;
  const maxLeft = window.innerWidth - rect.width - 8;
  const maxTop = window.innerHeight - rect.height - 8;
  const nextLeft = Math.min(maxLeft, Math.max(minLeft, rect.left));
  const nextTop = Math.min(maxTop, Math.max(minTop, rect.top));
  ui.sitePanel.style.left = `${nextLeft}px`;
  ui.sitePanel.style.top = `${nextTop}px`;
}

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }
