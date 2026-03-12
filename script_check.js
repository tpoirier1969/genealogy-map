(async function(){
  const bootstrapLoadingText = document.getElementById('loadingText');
  const bootstrapLoadingMeta = document.getElementById('loadingMeta');
  const bootstrapOverlay = document.getElementById('loadingOverlay');
  function setBootstrapLoading(text, meta) {
    if (bootstrapLoadingText) bootstrapLoadingText.textContent = text;
    if (bootstrapLoadingMeta) bootstrapLoadingMeta.textContent = meta;
    if (bootstrapOverlay) bootstrapOverlay.classList.remove('hidden');
  }
  async function fetchJson(url) {
    const resp = await fetch(url, {cache: 'no-store'});
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
  }
  let __loaded;
  try {
    setBootstrapLoading('Loading family data…', 'Starting with the oldest century, then filling forward.');
    const [manifest, base] = await Promise.all([fetchJson('./data/manifest.json'), fetchJson('./data/base.json')]);
    const firstChunk = (manifest.chunks || [])[0];
    let firstEvents = [];
    if (firstChunk) {
      setBootstrapLoading(`Loading ${firstChunk.label} data…`, 'The first screen should appear after the oldest chunk is ready.');
      const chunkPayload = await fetchJson(`./data/${firstChunk.file}`);
      firstEvents = chunkPayload.events || [];
    }
    __loaded = {manifest, data:{DEFAULT_HOME_ID: base.DEFAULT_HOME_ID, PEOPLE: base.PEOPLE, EVENTS: firstEvents, MODERN_IDS: base.MODERN_IDS}, initialChunkId: firstChunk ? firstChunk.id : null, initialLoadedThroughYear: firstChunk ? firstChunk.maxYear : null};
  } catch (err) {
    console.error(err);
    setBootstrapLoading('Family data failed to load.', 'Check that index.html and the data folder were uploaded together.');
    throw err;
  }
  window.FAMILY_DATA = __loaded.data;
  window.FAMILY_DATA_MANIFEST = __loaded.manifest;
  window.FAMILY_DATA_PROGRESS = { loadedChunkIds: __loaded.initialChunkId ? [__loaded.initialChunkId] : [], loadedThroughYear: __loaded.initialLoadedThroughYear };
  const { DEFAULT_HOME_ID, PEOPLE, EVENTS, MODERN_IDS } = window.FAMILY_DATA;

if (!window.FAMILY_DATA) {
  document.getElementById('map').innerHTML = '<div style="padding:24px;font:14px Arial,sans-serif;color:#444;">Map data file is missing. Keep <strong>tod_family_viewer_split_part15.html</strong> and <strong>tod_family_viewer_data_part15.js</strong> in the same folder, or use the bundle zip and extract both files together.</div>';
  throw new Error('FAMILY_DATA missing');
}

const peopleById = new Map(PEOPLE.map(p => [p.id, p]));
const peopleByName = new Map();
for (const p of PEOPLE) { if (!peopleByName.has(p.name)) peopleByName.set(p.name, p.id); }

const eventsByPerson = new Map();
for (const ev of EVENTS) { if (!eventsByPerson.has(ev.pid)) eventsByPerson.set(ev.pid, []); eventsByPerson.get(ev.pid).push(ev); }

const childrenByParent = new Map();
const siblingsByPerson = new Map();
const parentKeyToChildren = new Map();
for (const p of PEOPLE) {
  if (p.father) { if (!childrenByParent.has(p.father)) childrenByParent.set(p.father, new Set()); childrenByParent.get(p.father).add(p.id); }
  if (p.mother) { if (!childrenByParent.has(p.mother)) childrenByParent.set(p.mother, new Set()); childrenByParent.get(p.mother).add(p.id); }
  const key = `${p.father||''}|${p.mother||''}`;
  if (!parentKeyToChildren.has(key)) parentKeyToChildren.set(key, []);
  parentKeyToChildren.get(key).push(p.id);
}
for (const [key, kids] of parentKeyToChildren.entries()) {
  for (const kid of kids) {
    if (!siblingsByPerson.has(kid)) siblingsByPerson.set(kid, new Set());
    for (const other of kids) if (other !== kid) siblingsByPerson.get(kid).add(other);
  }
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function eventMid(ev) { if (ev.y0 == null && ev.y1 == null) return null; if (ev.y0 == null) return ev.y1; if (ev.y1 == null) return ev.y0; return (ev.y0 + ev.y1) / 2; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function eventInRange(ev, yMin, yMax) { if (ev.y1 != null && ev.y1 < yMin) return false; if (ev.y0 != null && ev.y0 > yMax) return false; if (ev.y0 != null || ev.y1 != null) return true; const p = peopleById.get(ev.pid) || {}; if (p.maxYear != null && p.maxYear < yMin) return false; if (p.minYear != null && p.minYear > yMax) return false; return p.minYear != null || p.maxYear != null; }
function lifeYears(pid) { const p = peopleById.get(pid) || {}; const a = p.minYear ?? '?'; const b = p.maxYear ?? '?'; return `(${a}–${b})`; }

const state = { mode: 'historical', homeId: DEFAULT_HOME_ID, selectedBranches: new Set(), focusedPersonId: DEFAULT_HOME_ID, currentScope: null, initializedDates: false, selectedPersonId: null, detailCollapsed: false, lastScopeSig: null, statusTimer: null, loadingVisible: true, dataVersion: 1, loadedChunkIds: new Set((window.FAMILY_DATA_PROGRESS && window.FAMILY_DATA_PROGRESS.loadedChunkIds) || []), loadedThroughYear: (window.FAMILY_DATA_PROGRESS && window.FAMILY_DATA_PROGRESS.loadedThroughYear) || null, totalChunks: ((window.FAMILY_DATA_MANIFEST && window.FAMILY_DATA_MANIFEST.chunks) || []).length, progressiveLoading: false };

const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const loadingMeta = document.getElementById('loadingMeta');
const loadingDismissBtn = document.getElementById('loadingDismissBtn');
const statusBanner = document.getElementById('statusBanner');
const statusBannerText = document.getElementById('statusBannerText');
const statusBannerClose = document.getElementById('statusBannerClose');
let loadingTimeout = null, loadingDismissTimeout = null;
function showLoading(message = 'Getting the tree and map ready.', meta = 'Large views can take a moment on slower devices.') {
  if (!loadingOverlay) return;
  if (loadingTimeout) clearTimeout(loadingTimeout);
  if (loadingDismissTimeout) clearTimeout(loadingDismissTimeout);
  loadingText.textContent = message;
  loadingMeta.textContent = meta;
  loadingOverlay.classList.remove('hidden', 'show-dismiss');
  state.loadingVisible = true;
  loadingDismissTimeout = setTimeout(() => loadingOverlay.classList.add('show-dismiss'), 1800);
  loadingTimeout = setTimeout(() => {
    if (!state.loadingVisible) return;
    loadingMeta.textContent = 'Still working. This view is heavy, so the map is simplifying what it draws to stay responsive.';
    loadingOverlay.classList.add('show-dismiss');
  }, 9000);
}
function hideLoading() {
  if (!loadingOverlay) return;
  if (loadingTimeout) clearTimeout(loadingTimeout);
  if (loadingDismissTimeout) clearTimeout(loadingDismissTimeout);
  loadingOverlay.classList.add('hidden');
  loadingOverlay.classList.remove('show-dismiss');
  state.loadingVisible = false;
}
function showStatus(message, autoHideMs = 7000) {
  if (!statusBanner || !statusBannerText) return;
  statusBannerText.textContent = message;
  statusBanner.classList.add('show');
  if (state.statusTimer) clearTimeout(state.statusTimer);
  if (autoHideMs > 0) state.statusTimer = setTimeout(() => statusBanner.classList.remove('show'), autoHideMs);
}
function hideStatus() {
  if (state.statusTimer) clearTimeout(state.statusTimer);
  if (statusBanner) statusBanner.classList.remove('show');
}
if (loadingDismissBtn) loadingDismissBtn.addEventListener('click', hideLoading);
if (statusBannerClose) statusBannerClose.addEventListener('click', hideStatus);

function clearScopeCaches() {
  state.scopeEventsKey = null;
  state.scopeEventsCache = null;
}
function ingestEventRows(rows) {
  for (const ev of (rows || [])) {
    EVENTS.push(ev);
    if (!eventsByPerson.has(ev.pid)) eventsByPerson.set(ev.pid, []);
    eventsByPerson.get(ev.pid).push(ev);
  }
  state.dataVersion += 1;
  clearScopeCaches();
}

async function loadNextUnloadedChunk() {
  const manifest = window.FAMILY_DATA_MANIFEST || {chunks: []};
  for (const chunk of manifest.chunks) {
    if (state.loadedChunkIds.has(chunk.id)) continue;
    const resp = await fetch(`./data/${chunk.file}`, {cache: 'no-store'});
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${chunk.file}`);
    const payload = await resp.json();
    ingestEventRows(payload.events || []);
    state.loadedChunkIds.add(chunk.id);
    if (typeof chunk.maxYear === 'number') state.loadedThroughYear = chunk.maxYear;
    return chunk;
  }
  return null;
}
async function ensureDataForScope(scope) {
  if (state.progressiveLoading) return false;
  let scopeEvents = getScopeEvents(scope).rows;
  if (scopeEvents.length) return false;
  const manifest = window.FAMILY_DATA_MANIFEST || {chunks: []};
  if ((manifest.chunks || []).every(chunk => state.loadedChunkIds.has(chunk.id))) return false;
  state.progressiveLoading = true;
  showLoading('Loading more family data…', 'This home person has no mapped events in the chunks loaded so far.');
  try {
    while (!scopeEvents.length) {
      const chunk = await loadNextUnloadedChunk();
      if (!chunk) break;
      scopeEvents = getScopeEvents(scope).rows;
    }
  } catch (err) {
    console.error(err);
    showStatus('Could not load the next family-data chunk. The map is still using what is already loaded.', 0);
  } finally {
    state.progressiveLoading = false;
  }
  return !!scopeEvents.length;
}
async function loadRemainingChunksSequentially() {
  if (state.progressiveLoading) return;
  const manifest = window.FAMILY_DATA_MANIFEST || {chunks: []};
  state.progressiveLoading = true;
  for (const chunk of manifest.chunks) {
    if (state.loadedChunkIds.has(chunk.id)) continue;
    try {
      const dmax = document.getElementById('dateMax');
      const wasFollowingLatest = dmax && dmax.max !== '' && Number(dmax.value) >= Number(dmax.max) - 1;
      const resp = await fetch(`./data/${chunk.file}`, {cache: 'no-store'});
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${chunk.file}`);
      const payload = await resp.json();
      ingestEventRows(payload.events || []);
      state.loadedChunkIds.add(chunk.id);
      if (typeof chunk.maxYear === 'number') state.loadedThroughYear = chunk.maxYear;
      if (wasFollowingLatest) state.initializedDates = false;
      scheduleRender(false, 10);
      showStatus(`Loaded ${chunk.label} data. ${state.loadedChunkIds.size} of ${state.totalChunks} chunks ready.`, 1800);
      await new Promise(r => setTimeout(r, 40));
    } catch (err) {
      console.error(err);
      showStatus(`Could not load ${chunk.label} data. The map is still using the chunks already loaded.`, 0);
      break;
    }
  }
  state.progressiveLoading = false;
}
window.addEventListener('error', (e) => {
  console.error(e.error || e.message || e);
  hideLoading();
  showStatus('A redraw error occurred. The map kept the last successful view; try the change again or reload.', 0);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason || e);
  hideLoading();
  showStatus('A background map task failed. The map is still using the data already loaded.', 0);
});

function buildPeopleList() {
  const dl = document.getElementById('peopleList'); dl.innerHTML = '';
  const names = [...peopleByName.keys()].sort((a,b)=>a.localeCompare(b));
  for (const name of names) { const opt = document.createElement('option'); opt.value = name; dl.appendChild(opt); }
}


function cloneScopeMaps(base) {
  return {
    included: new Set(base.included || []),
    gen: new Map(base.gen || []),
    rel: new Map(base.rel || []),
    side: new Map([...(base.side || new Map()).entries()].map(([k,v]) => [k, new Set(v)])),
  };
}

function modernEligible(pid) {
  const p = peopleById.get(pid);
  if (!p) return false;
  if (pid === state.homeId) return true;
  const maxY = p.maxYear, minY = p.minYear;
  if (maxY == null && minY == null) return true;
  if (maxY != null && maxY >= 1850) return true;
  if (minY != null && minY >= 1850) return true;
  return false;
}


function ancestorLabel(gen, sex) {
  const male = sex === 'M', female = sex === 'F';
  if (gen === 2) return male ? 'Father' : female ? 'Mother' : 'Parent';
  if (gen === 3) return male ? 'Grandfather' : female ? 'Grandmother' : 'Grandparent';
  const greats = Math.max(1, gen - 3);
  const base = male ? 'grandfather' : female ? 'grandmother' : 'grandparent';
  return `${greats}× great-${base}`;
}
function avuncularLabel(gen, sex) {
  const male = sex === 'M', female = sex === 'F';
  if (gen === 2) return male ? 'Uncle' : female ? 'Aunt' : 'Aunt/uncle';
  if (gen === 3) return male ? 'Great-uncle' : female ? 'Great-aunt' : 'Great-aunt/uncle';
  const greats = Math.max(1, gen - 2);
  const base = male ? 'uncle' : female ? 'aunt' : 'aunt/uncle';
  return `${greats}× great-${base}`;
}
function descendantDistanceFromHome(pid) {
  if (pid === state.homeId) return 0;
  const q = [{id: state.homeId, d: 0}], seen = new Set([state.homeId]);
  while (q.length) {
    const cur = q.shift();
    const p = peopleById.get(cur.id); if (!p) continue;
    for (const child of (p.children || [])) {
      if (!peopleById.has(child) || seen.has(child)) continue;
      if (child === pid) return cur.d + 1;
      seen.add(child); q.push({id: child, d: cur.d + 1});
    }
  }
  return null;
}
function relationTextBase(pid) {
  const scope = state.currentScope; if (!scope) return '—';
  if (pid === state.homeId) return 'Home person';
  const rel = scope.rel.get(pid) || 'other';
  const g = scope.gen.get(pid) || null;
  const p = peopleById.get(pid) || {};
  if (rel === 'direct') return ancestorLabel(g || 2, p.sex);
  if (rel === 'sibling') return avuncularLabel(g || 2, p.sex);
  if (rel === 'blood') {
    const d = descendantDistanceFromHome(pid);
    if (d === 1) return p.sex === 'M' ? 'Son' : p.sex === 'F' ? 'Daughter' : 'Child';
    if (d === 2) return p.sex === 'M' ? 'Grandson' : p.sex === 'F' ? 'Granddaughter' : 'Grandchild';
    if (d && d > 2) return `${d-2}× great-${p.sex === 'M' ? 'grandson' : p.sex === 'F' ? 'granddaughter' : 'grandchild'}`;
    return 'Blood relative';
  }
  if (rel === 'spouse') {
    for (const spid of (p.spouses || [])) {
      const srel = scope.rel.get(spid) || 'other';
      if (spid === state.homeId) return 'Spouse';
      if (srel !== 'spouse' && srel !== 'other') return `Spouse of ${relationTextBase(spid).toLowerCase()}`;
    }
    return 'Spouse';
  }
  return 'Related person';
}
function relationText(pid) {
  const scope = state.currentScope; if (!scope) return '—';
  const sideSet = [...(scope.side.get(pid) || [])].filter(s => s !== 'home');
  const sideTxt = sideSet.length ? ` (${sideSet.join('/')})` : '';
  return `${relationTextBase(pid)}${sideTxt}`;
}

function computeAncestorScope(homeId) {
  const included = new Set([homeId]);
  const gen = new Map([[homeId, 1]]);
  const rel = new Map([[homeId, 'home']]);
  const side = new Map([[homeId, new Set(['home'])]]);
  const q = [];
  const hp = peopleById.get(homeId);
  if (hp?.father && peopleById.has(hp.father)) { included.add(hp.father); gen.set(hp.father, 2); rel.set(hp.father, 'direct'); side.set(hp.father, new Set(['paternal'])); q.push(hp.father); }
  if (hp?.mother && peopleById.has(hp.mother)) { included.add(hp.mother); gen.set(hp.mother, 2); rel.set(hp.mother, 'direct'); side.set(hp.mother, new Set(['maternal'])); q.push(hp.mother); }
  while (q.length) {
    const pid = q.shift(); const g = gen.get(pid) || 2; const pp = peopleById.get(pid);
    for (const par of [pp?.father, pp?.mother]) {
      if (!par || !peopleById.has(par)) continue; const newGen = g + 1; let changed = false;
      if (!included.has(par)) { included.add(par); changed = true; }
      if (!gen.has(par) || newGen < gen.get(par)) { gen.set(par, newGen); changed = true; }
      if (!rel.has(par)) { rel.set(par, 'direct'); changed = true; }
      const cur = side.get(par) || new Set(); const src = side.get(pid) || new Set(); const before = cur.size;
      for (const s of src) if (s !== 'home') cur.add(s);
      if (cur.size !== before) { side.set(par, cur); changed = true; }
      if (changed) q.push(par);
    }
  }
  return {included, gen, rel, side};
}

function computeHistoricalScope(homeId) {
  const base = computeAncestorScope(homeId);
  const included = new Set(base.included);
  const gen = new Map(base.gen);
  const rel = new Map(base.rel);
  const side = new Map();
  for (const [k,v] of base.side.entries()) side.set(k, new Set(v));

  for (const pid of [...base.included]) {
    if (pid === homeId) continue;
    const sibs = siblingsByPerson.get(pid); if (!sibs) continue;
    for (const sib of sibs) {
      if (!peopleById.has(sib)) continue;
      included.add(sib);
      if (!gen.has(sib)) gen.set(sib, gen.get(pid) || 1);
      if (!rel.has(sib)) rel.set(sib, 'sibling');
      const cur = side.get(sib) || new Set(); const src = side.get(pid) || new Set();
      if (pid === homeId && src.has('home')) { cur.add('paternal'); cur.add('maternal'); }
      else for (const s of src) if (s !== 'home') cur.add(s);
      if (cur.size) side.set(sib, cur);
    }
  }
  for (const pid of [...included]) {
    if (pid === homeId) continue;
    const p = peopleById.get(pid); const spouses = p?.spouses || [];
    for (const sp of spouses) {
      if (!peopleById.has(sp)) continue;
      included.add(sp);
      if (!gen.has(sp)) gen.set(sp, gen.get(pid) || 1);
      if (!rel.has(sp)) rel.set(sp, 'spouse');
      const cur = side.get(sp) || new Set(); const src = side.get(pid) || new Set();
      for (const s of src) if (s !== 'home') cur.add(s);
      if (cur.size) side.set(sp, cur);
    }
  }
  let genMax = 1; for (const v of gen.values()) genMax = Math.max(genMax, v);
  return {included, gen, rel, side, genMax};
}

function computeGedcomScope(homeId) {
  const included = new Set();
  const gen = new Map([[homeId, 1]]);
  const rel = new Map([[homeId, 'home']]);
  const side = new Map([[homeId, new Set(['home'])]]);
  for (const p of PEOPLE) {
    included.add(p.id);
    if (!gen.has(p.id)) gen.set(p.id, p.id === homeId ? 1 : 1);
    if (!rel.has(p.id)) rel.set(p.id, p.id === homeId ? 'home' : 'other');
    if (!side.has(p.id)) side.set(p.id, new Set());
  }
  return {included, gen, rel, side, genMax: Math.max(63, computeHistoricalScope(homeId).genMax || 1)};
}

function computeModernScope(homeId) {
  const anc = computeAncestorScope(homeId);
  const included = new Set();
  const gen = new Map();
  const rel = new Map();
  const side = new Map();

  // seed ancestors + home for traversal
  const q = [...anc.included];
  const seen = new Set(q);
  for (const pid of q) {
    gen.set(pid, anc.gen.get(pid) || 1);
    rel.set(pid, anc.rel.get(pid) || (pid === homeId ? 'home' : 'direct'));
    side.set(pid, new Set(anc.side.get(pid) || []));
    if (modernEligible(pid)) included.add(pid);
  }

  while (q.length) {
    const pid = q.shift();
    const p = peopleById.get(pid);
    if (!p) continue;
    const parentGen = gen.get(pid) || 1;
    const inherited = new Set(side.get(pid) || []);
    const nextSide = new Set([...inherited].filter(s => s !== 'home'));
    if (inherited.has('home')) { nextSide.add('paternal'); nextSide.add('maternal'); }

    for (const child of (p.children || [])) {
      if (!peopleById.has(child) || seen.has(child)) continue;
      seen.add(child);
      q.push(child);
      const childGen = Math.max(1, parentGen - 1);
      if (!gen.has(child)) gen.set(child, childGen);
      if (!rel.has(child)) rel.set(child, child === homeId ? 'home' : 'blood');
      if (!side.has(child)) side.set(child, new Set(nextSide));
      if (modernEligible(child)) included.add(child);
    }
  }

  // add spouses for visible blood relatives/direct relatives/home
  for (const pid of [...included]) {
    const p = peopleById.get(pid); if (!p) continue;
    const src = side.get(pid) || new Set();
    for (const sp of (p.spouses || [])) {
      if (!peopleById.has(sp)) continue;
      included.add(sp);
      if (!gen.has(sp)) gen.set(sp, gen.get(pid) || 1);
      if (!rel.has(sp)) rel.set(sp, 'spouse');
      const cur = side.get(sp) || new Set();
      for (const s of src) if (s !== 'home') cur.add(s);
      if (cur.size) side.set(sp, cur);
    }
  }

  let genMax = 1; for (const v of gen.values()) genMax = Math.max(genMax, v);
  return {included, gen, rel, side, genMax};
}

function computeScope(homeId) {
  if (state.mode === 'modern') return computeModernScope(homeId);
  if (state.mode === 'gedcom') return computeGedcomScope(homeId);
  return computeHistoricalScope(homeId);
}
function computeScopeCached(homeId) {
  const key = `${state.mode}|${homeId}`;
  if (!state.scopeCache) state.scopeCache = new Map();
  if (!state.scopeCache.has(key)) state.scopeCache.set(key, computeScope(homeId));
  return state.scopeCache.get(key);
}
function getScopeEvents(scope) {
  const key = `${state.mode}|${state.homeId}|${state.dataVersion}`;
  if (state.scopeEventsKey === key && state.scopeEventsCache) return state.scopeEventsCache;
  state.scopeEventsKey = key;
  const rows = EVENTS.filter(ev => scope.included.has(ev.pid) && ev.lat != null && ev.lon != null);
  const years = [];
  for (const ev of rows) { if (ev.y0 != null) years.push(ev.y0); if (ev.y1 != null && ev.y1 !== ev.y0) years.push(ev.y1); }
  state.scopeEventsCache = { rows, minYear: years.length ? Math.min(...years) : 58, maxYear: years.length ? Math.max(...years) : 2027 };
  return state.scopeEventsCache;
}

function getCurrentControls() {
  return { side: document.querySelector('input[name="side"]:checked')?.value || 'all', showDirect: document.getElementById('showDirect').checked, showSiblings: document.getElementById('showSiblings').checked, showSpouses: document.getElementById('showSpouses').checked, genDepth: Number(document.getElementById('genDepth').value), yMin: Number(document.getElementById('dateMin').value), yMax: Number(document.getElementById('dateMax').value), hideBroadOnly: false };
}


function personSideCategory(pid) {
  if (pid === state.homeId) return 'home';
  const set = (state.currentScope && state.currentScope.side.get(pid)) || new Set();
  if (set.has('paternal') && !set.has('maternal')) return 'paternal';
  if (set.has('maternal') && !set.has('paternal')) return 'maternal';
  if (set.has('paternal') && set.has('maternal')) return 'both';
  return 'unknown';
}

function hashString(str) {
  let h = 0;
  str = String(str || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function branchHue(branch, sideCat) {
  const h = hashString(branch);
  const warm = [8, 18, 28, 38, 48];
  const cool = [198, 210, 222, 234, 246];
  const both = [270, 285, 300, 315];
  if (sideCat === 'paternal') return warm[h % warm.length];
  if (sideCat === 'maternal') return cool[h % cool.length];
  if (sideCat === 'both') return both[h % both.length];
  return 0;
}

function colorForPerson(pid) {
  if (pid === state.homeId) return '#111827';
  const p = peopleById.get(pid) || {};
  const rel = (state.currentScope && state.currentScope.rel.get(pid)) || 'other';
  const cat = personSideCategory(pid);
  if (cat === 'unknown') return '#8a8f98';
  const hue = branchHue(p.branch || p.name || pid, cat);
  let sat = 68, light = 44;
  if (rel === 'sibling') { sat = 58; light = 58; }
  else if (rel === 'spouse') { sat = 54; light = 54; }
  else if (rel === 'other') { sat = 46; light = 63; }
  else if (rel === 'home') { sat = 0; light = 12; }
  if (cat === 'both') { sat = Math.max(34, sat - 18); light = Math.min(68, light + 6); }
  return hslToHex(hue, sat, light);
}

function lineColorForPerson(pid) {
  return colorForPerson(pid);
}



function scopeBranches(scope) {
  const out = new Set();
  for (const pid of scope.included || []) {
    const p = peopleById.get(pid);
    if (p?.branch) out.add(p.branch);
  }
  return out;
}

function refreshBranchList(scope, ctl) {
  const box = document.getElementById('branchBox'); const search = (document.getElementById('branchSearch').value || '').toLowerCase().trim(); const counts = new Map();
  for (const pid of scope.included) {
    const p = peopleById.get(pid); if (!p) continue; const rel = scope.rel.get(pid) || 'other';
    if (rel === 'direct' && !ctl.showDirect && pid !== state.homeId) continue;
    if (rel === 'sibling' && !ctl.showSiblings) continue;
    if (rel === 'spouse' && !ctl.showSpouses) continue;
    if (pid !== state.homeId) { const cat = personSideCategory(pid); if (ctl.side === 'paternal' && cat !== 'paternal') continue; if (ctl.side === 'maternal' && cat !== 'maternal') continue; }
    counts.set(p.branch, (counts.get(p.branch) || 0) + 1);
  }
  const branches = [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const branchSig = JSON.stringify([state.mode, state.homeId, ctl.side, ctl.showDirect, ctl.showSiblings, ctl.showSpouses, search, branches, [...state.selectedBranches].sort()]);
  if (state.branchUiSig === branchSig) return;
  state.branchUiSig = branchSig;
  if (!state.selectedBranches.size) { for (const [b,c] of branches) state.selectedBranches.add(b); }
  box.innerHTML = '';
  for (const [branch, count] of branches) {
    if (search && !branch.toLowerCase().includes(search)) continue;
    const sampleId = samplePersonByBranch.get(branch);
    const swatch = sampleId ? colorForPerson(sampleId) : '#888';
    const div = document.createElement('div'); div.className = 'branch-item';
    div.innerHTML = `<label style="display:flex;align-items:center;gap:8px;width:100%;font-weight:400;"><input type="checkbox" data-branch="${esc(branch)}" ${state.selectedBranches.has(branch)?'checked':''}/><span class="swatch" style="background:${swatch}"></span><span>${esc(branch)}</span><span class="count">${count}</span></label>`;
    box.appendChild(div);
  }
  box.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', () => { const branch = cb.getAttribute('data-branch'); if (cb.checked) state.selectedBranches.add(branch); else state.selectedBranches.delete(branch); state.branchUiSig = null; scheduleRender(false); }));
}

function isBroad(ev) { return ['country','province','state','region','historic-region'].includes(ev.precision) || ev.pointStyle === 'pale'; }

function visiblePeopleAndEvents(scope, ctl, scopeEvents) {
  const visiblePeople = new Set(), visibleEvents = [];
  for (const pid of scope.included) {
    const p = peopleById.get(pid); if (!p) continue; const rel = scope.rel.get(pid) || 'other';
    if (rel === 'direct' && !ctl.showDirect && pid !== state.homeId) continue;
    if (rel === 'sibling' && !ctl.showSiblings) continue;
    if (rel === 'spouse' && !ctl.showSpouses) continue;
    const gen = scope.gen.get(pid) || 1; if (rel !== 'other' && gen > ctl.genDepth) continue;
    if (pid !== state.homeId) { const cat = personSideCategory(pid); if (ctl.side === 'paternal' && cat !== 'paternal') continue; if (ctl.side === 'maternal' && cat !== 'maternal') continue; }
    if (!state.selectedBranches.has(p.branch) && pid !== state.homeId) continue;
    visiblePeople.add(pid);
  }
  for (const ev of scopeEvents) {
    if (!visiblePeople.has(ev.pid)) continue; if (ctl.hideBroadOnly && isBroad(ev)) continue; if (!eventInRange(ev, ctl.yMin, ctl.yMax)) continue; visibleEvents.push(ev);
  }
  return {visiblePeople, visibleEvents};
}

function renderSummary(visiblePeople, visibleEvents) {
  const scope = state.currentScope; let direct=0,siblings=0,spouses=0,other=0;
  for (const pid of visiblePeople) { const rel = scope.rel.get(pid) || 'other'; if (rel==='direct') direct++; else if (rel==='sibling') siblings++; else if (rel==='spouse') spouses++; else other++; }
  const otherLabel = state.mode === 'modern' ? 'Other modern' : (state.mode === 'gedcom' ? 'Other GEDCOM' : 'Other');
  document.getElementById('summary').innerHTML = `<strong>Visible now</strong><br/>${visiblePeople.size.toLocaleString()} people &middot; ${visibleEvents.length.toLocaleString()} mapped events<br/>Direct: ${direct.toLocaleString()} &middot; Siblings: ${siblings.toLocaleString()} &middot; Spouses: ${spouses.toLocaleString()}${state.mode === 'historical' ? '' : ` &middot; ${otherLabel}: ${other.toLocaleString()}`}<br/>Mode: ${esc(state.mode)} &middot; Home: ${esc(peopleById.get(state.homeId)?.name || '')}`;
}

function sortedIds(ids) { return [...new Set(ids || [])].filter(id => peopleById.has(id)).sort((a,b)=>(peopleById.get(a).name||'').localeCompare(peopleById.get(b).name||'')); }
function listHtml(label, ids) { const rows = sortedIds(ids); return `<div class="rel-section"><strong>${label}</strong><div class="rel-list">${rows.length ? rows.map(id => `<div><button onclick="selectPersonFromArea('${id}')">${esc(peopleById.get(id).name || id)}</button></div>`).join('') : '<div class="small">None listed.</div>'}</div></div>`; }

function showDetails(pid) {
  const p = peopleById.get(pid); if (!p) return; const ctl = getCurrentControls();
  const evs = (eventsByPerson.get(pid) || []).filter(ev => ev.lat != null && ev.lon != null && (!ctl.hideBroadOnly || !isBroad(ev)) && eventInRange(ev, ctl.yMin, ctl.yMax));
  evs.sort((a,b)=>(eventMid(a) ?? 99999) - (eventMid(b) ?? 99999));
  const scope = state.currentScope; const rel = scope.rel.get(pid) || 'other'; const sideSet = [...(scope.side.get(pid) || [])].filter(x=>x!=='home'); const side = sideSet.join(', ') || (pid===state.homeId ? 'home' : '—');
  const relationLabel = relationText(pid);
  const htmlEvents = evs.map(ev => `<div class="detail-event"><div><span class="pill">${esc(ev.type)}</span> <span class="detail-event-date">${esc(ev.date || (ev.y0===ev.y1 ? ev.y0 : `${ev.y0 ?? '?'}–${ev.y1 ?? '?'}`))}</span></div><div class="detail-event-place">${esc(ev.placeOrig || ev.placeStd || 'Unknown place')}</div><div class="note">${esc(ev.note || '')}</div></div>`).join('');
  const siblings = [...(siblingsByPerson.get(pid) || [])];
  const html = `<div class="panel-head"><div class="panel-title">Selected person</div><button id="collapseDetailBtnInner" class="collapse-btn" title="${state.detailCollapsed ? 'Expand' : 'Collapse'}">${state.detailCollapsed ? '+' : '−'}</button></div><div class="detail-body"><div><strong>${esc(p.name)}</strong></div><div class="small">${esc(p.branch)} &middot; ${esc(relationLabel)} &middot; ${esc(side)}</div><div class="small">${esc(p.birthDate || '')} ${p.birthPlace ? '— ' + esc(p.birthPlace) : ''}</div><div class="small">${esc(p.deathDate || '')} ${p.deathPlace ? '— ' + esc(p.deathPlace) : ''}</div><hr/><div><strong>Visible events</strong></div>${htmlEvents || '<div class="small">No visible events in the current filters.</div>'}${listHtml('Parents', [p.father, p.mother].filter(Boolean))}${listHtml('Siblings', siblings)}${listHtml('Spouses', p.spouses || [])}${listHtml('Children', p.children || [])}</div>`;
  const fd = document.getElementById('floatingDetail'); fd.innerHTML = html; fd.classList.toggle('collapsed', !!state.detailCollapsed); wireCollapseButtons(); document.querySelectorAll('#collapseDetailBtn, #collapseDetailBtnInner').forEach(b => { if (b) { b.textContent = state.detailCollapsed ? '+' : '−'; b.title = state.detailCollapsed ? 'Expand' : 'Collapse'; } });
}

function popupHtmlForArea(rows) {
  const names = []; const seen = new Set();
  for (const row of rows) { if (seen.has(row.pid)) continue; seen.add(row.pid); const n = peopleById.get(row.pid)?.name || row.name; names.push(`<button onclick="selectPersonFromArea('${row.pid}')">${esc(n)} ${esc(lifeYears(row.pid))}</button>`); }
  const first = rows[0];
  return `<div><strong>${esc(first.areaKey || first.placeStd || first.placeOrig || 'Mapped area')}</strong></div><div class="small">${seen.size.toLocaleString()} people &middot; ${rows.length.toLocaleString()} visible events at this mapped area</div><div class="same-area-list"><strong>People at this mapped area</strong>${names.join('') || '<div class="small">None.</div>'}</div>`;
}


function eventSpecificityScore(ev) {
  const prec = String(ev.precision || '');
  const order = {site:0, address:0, town:1, county:2, medium:2, province:3, state:4, region:5, 'historic-region':5, country:6, unknown:7, none:9};
  return order.hasOwnProperty(prec) ? order[prec] : 8;
}
function bestEventForPerson(pid, applyCurrentFilters) {
  const ctl = getCurrentControls();
  let rows = (eventsByPerson.get(pid) || []).filter(ev => ev.lat != null && ev.lon != null);
  if (applyCurrentFilters) rows = rows.filter(ev => (!ctl.hideBroadOnly || !isBroad(ev)) && eventInRange(ev, ctl.yMin, ctl.yMax));
  rows = rows.slice().sort((a,b) => {
    const sa = eventSpecificityScore(a), sb = eventSpecificityScore(b);
    if (sa !== sb) return sa - sb;
    const ya = eventMid(a), yb = eventMid(b);
    if (ya != null && yb != null && ya !== yb) return yb - ya;
    if (ya != null && yb == null) return -1;
    if (ya == null && yb != null) return 1;
    return 0;
  });
  return rows[0] || null;
}
window.selectPersonFromArea = function(pid) {
  state.focusedPersonId = pid; state.selectedPersonId = pid; showDetails(pid);
  const marker = currentMarkerRefs.get(pid);
  if (marker) { marker.openPopup(); map.panTo(marker.getLatLng()); }
};

const map = L.map('map', { preferCanvas: true, zoomSnap: 0.25 }).setView([46.5, -87.6], 3);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
const eventLayer = L.layerGroup().addTo(map), pathLayer = L.layerGroup().addTo(map), connectorLayer = L.layerGroup().addTo(map), bubbleLayer = L.layerGroup().addTo(map);
let currentMarkerRefs = new Map();

function addArrowHead(from, to, color, opacity = 0.7, weight = 2) {
  if (!from || !to) return;
  const p1 = map.latLngToLayerPoint(L.latLng(from[0], from[1]));
  const p2 = map.latLngToLayerPoint(L.latLng(to[0], to[1]));
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (!isFinite(len) || len < 12) return;
  const ux = dx / len, uy = dy / len;
  const size = Math.min(12, Math.max(8, len * 0.32));
  const backX = p2.x - ux * size, backY = p2.y - uy * size;
  const wing = size * 0.58;
  const left = L.point(backX - uy * wing, backY + ux * wing);
  const right = L.point(backX + uy * wing, backY - ux * wing);
  L.polyline(
    [
      map.layerPointToLatLng(left),
      map.layerPointToLatLng(p2),
      map.layerPointToLatLng(right)
    ],
    { color, weight, opacity, lineCap: 'round', lineJoin: 'round' }
  ).addTo(connectorLayer);
}

function drawArrowedPolyline(latlngs, opts = {}) {
  L.polyline(latlngs, opts).addTo(pathLayer);
  for (let i = 1; i < latlngs.length; i++) {
    addArrowHead(latlngs[i - 1], latlngs[i], opts.color || '#333', Math.min(0.95, (opts.opacity ?? 0.75) + 0.12), Math.max(2, (opts.weight ?? 2) - 0.2));
  }
}

function drawArrowedConnector(from, to, opts = {}) {
  L.polyline([from, to], opts).addTo(connectorLayer);
  addArrowHead(from, to, opts.color || '#333', Math.min(0.9, (opts.opacity ?? 0.45) + 0.16), Math.max(1.8, (opts.weight ?? 1.4)));
}

function render(fitToData) {
  state.currentScope = computeScopeCached(state.homeId); const scope = state.currentScope;
  if (!getScopeEvents(scope).rows.length && !state.progressiveLoading) { ensureDataForScope(scope).then(found => { if (found) scheduleRender(fitToData, 0); else hideLoading(); }); }
  if (!state.selectedBranches.size) { for (const pid of scope.included) { const p = peopleById.get(pid); if (p?.branch) state.selectedBranches.add(p.branch); } }
  const genDepthEl = document.getElementById('genDepth');
  const scopeSig = `${state.mode}|${state.homeId}|${scope.genMax}`;
  genDepthEl.max = scope.genMax;
  if (state.lastScopeSig !== scopeSig) {
    genDepthEl.value = scope.genMax;
    state.lastScopeSig = scopeSig;
  } else if (Number(genDepthEl.value) > scope.genMax) {
    genDepthEl.value = scope.genMax;
  }
  document.getElementById('genVal').textContent = genDepthEl.value;
  document.getElementById('genMaxVal').textContent = scope.genMax;
  const ctl = getCurrentControls();
  refreshBranchList(scope, ctl);
  const scopeEventsObj = getScopeEvents(scope);
  const scopeEvents = scopeEventsObj.rows;
  const minAll = scopeEventsObj.minYear; const maxAll = scopeEventsObj.maxYear;
  const dmin = document.getElementById('dateMin'); const dmax = document.getElementById('dateMax');
  const prevMinBound = Number.isFinite(Number(dmin.min)) ? Number(dmin.min) : minAll;
  const prevMaxBound = Number.isFinite(Number(dmax.max)) ? Number(dmax.max) : maxAll;
  const followEarliest = !state.initializedDates || Number(dmin.value || prevMinBound) <= prevMinBound + 1;
  const followLatest = !state.initializedDates || Number(dmax.value || prevMaxBound) >= prevMaxBound - 1;
  dmin.min = minAll; dmin.max = maxAll; dmax.min = minAll; dmax.max = maxAll;
  if (!state.initializedDates) { dmin.value = minAll; dmax.value = maxAll; state.initializedDates = true; } else { dmin.value = clamp(Number(dmin.value), minAll, maxAll); dmax.value = clamp(Number(dmax.value), minAll, maxAll); if (followEarliest) dmin.value = minAll; if (followLatest) dmax.value = maxAll; if (Number(dmin.value) > Number(dmax.value)) dmin.value = dmax.value; }
  document.getElementById('dateMinVal').textContent = dmin.value; document.getElementById('dateMaxVal').textContent = dmax.value;

  const {visiblePeople, visibleEvents} = visiblePeopleAndEvents(scope, ctl, scopeEvents); renderSummary(visiblePeople, visibleEvents);
  eventLayer.clearLayers(); pathLayer.clearLayers(); connectorLayer.clearLayers(); bubbleLayer.clearLayers(); currentMarkerRefs = new Map();

  const renderBounds = map.getBounds().pad(0.18);
  const forceIds = new Set([state.homeId, state.selectedPersonId, state.focusedPersonId].filter(Boolean));
  const heavyViewportMode = visibleEvents.length > 900;
  let renderEvents = heavyViewportMode
    ? visibleEvents.filter(ev => forceIds.has(ev.pid) || renderBounds.contains([ev.lat, ev.lon]))
    : visibleEvents.slice();
  if (heavyViewportMode && renderEvents.length > 1600) {
    const forced = [];
    const byPerson = new Map();
    for (const ev of renderEvents) {
      if (forceIds.has(ev.pid)) { forced.push(ev); continue; }
      const cur = byPerson.get(ev.pid);
      if (!cur) { byPerson.set(ev.pid, ev); continue; }
      const scEv = eventSpecificityScore(ev), scCur = eventSpecificityScore(cur);
      const midEv = eventMid(ev), midCur = eventMid(cur);
      if (scEv < scCur || (scEv === scCur && (midEv ?? 99999) < (midCur ?? 99999))) byPerson.set(ev.pid, ev);
    }
    renderEvents = forced.concat([...byPerson.values()]);
  }

  const pointMap = new Map();
  const firstVisibleEventByPerson = new Map();
  for (const ev of renderEvents) {
    const key = `${ev.areaKey || ev.placeStd || ev.placeOrig}|${ev.lat}|${ev.lon}`;
    if (!pointMap.has(key)) pointMap.set(key, []);
    pointMap.get(key).push(ev);
    const cur = firstVisibleEventByPerson.get(ev.pid);
    if (!cur) { firstVisibleEventByPerson.set(ev.pid, ev); continue; }
    const scEv = eventSpecificityScore(ev), scCur = eventSpecificityScore(cur);
    const midEv = eventMid(ev), midCur = eventMid(cur);
    if (scEv < scCur || (scEv === scCur && (midEv ?? 99999) < (midCur ?? 99999))) firstVisibleEventByPerson.set(ev.pid, ev);
  }
  const zoom = map.getZoom();
  const aggregateDeg = zoom < 4 ? 1.2 : zoom < 5 ? 0.7 : zoom < 6 ? 0.35 : zoom < 7 ? 0.18 : 0;
  const areaGroups = new Map();
  for (const rows of pointMap.values()) {
    const first = rows[0];
    let groupKey;
    if (aggregateDeg > 0) {
      const glat = Math.round(first.lat / aggregateDeg);
      const glon = Math.round(first.lon / aggregateDeg);
      groupKey = `${glat}|${glon}`;
    } else {
      groupKey = `${first.lat}|${first.lon}`;
    }
    if (!areaGroups.has(groupKey)) areaGroups.set(groupKey, []);
    areaGroups.get(groupKey).push(...rows);
  }

  if (state.selectedPersonId) {
    const pid = state.selectedPersonId;
    const evs = visibleEvents.filter(ev => ev.pid === pid).slice().sort((a,b)=>(eventMid(a) ?? 99999) - (eventMid(b) ?? 99999)).filter(ev=>ev.lat!=null&&ev.lon!=null);
    const dedupedPts = [];
    for (const ev of evs) {
      const ll = [ev.lat, ev.lon];
      const prev = dedupedPts[dedupedPts.length - 1];
      if (!prev || prev[0] !== ll[0] || prev[1] !== ll[1]) dedupedPts.push(ll);
    }
    if (dedupedPts.length > 1) {
      const color = lineColorForPerson(pid); const pale = evs.every(isBroad);
      drawArrowedPolyline(dedupedPts, {color, weight: 3.1, opacity: pale ? 0.22 : 0.82, lineCap:'round', lineJoin:'round'});
    }

    const selected = peopleById.get(pid);
    const selectedEv = firstVisibleEventByPerson.get(pid);
    if (selected && selectedEv) {
      const color = lineColorForPerson(pid);

      for (const par of [selected.father, selected.mother]) {
        if (!par || !visiblePeople.has(par)) continue;
        const parentEv = firstVisibleEventByPerson.get(par); if (!parentEv) continue;
        const pale = isBroad(selectedEv) || isBroad(parentEv);
        drawArrowedConnector([parentEv.lat, parentEv.lon], [selectedEv.lat, selectedEv.lon], {color, weight: 1.6, opacity: pale ? 0.2 : 0.42, dashArray:'4,4'});
      }

      for (const childId of (selected.children || [])) {
        if (!visiblePeople.has(childId)) continue;
        const childEv = firstVisibleEventByPerson.get(childId); if (!childEv) continue;
        const pale = isBroad(selectedEv) || isBroad(childEv);
        drawArrowedConnector([selectedEv.lat, selectedEv.lon], [childEv.lat, childEv.lon], {color, weight: 1.6, opacity: pale ? 0.2 : 0.42, dashArray:'4,4'});
      }
    }
  }

  for (const rows of areaGroups.values()) {
    const first = rows[0]; const uniquePeople = new Set(rows.map(r => r.pid));
    if (rows.length > 1) {
      const avgLat = rows.reduce((s,r)=>s+r.lat,0) / rows.length;
      const avgLon = rows.reduce((s,r)=>s+r.lon,0) / rows.length;
      const bubbleSize = uniquePeople.size >= 100 ? 42 : uniquePeople.size >= 25 ? 36 : 30;
      const icon = L.divIcon({className:'', html:`<div class="area-bubble" style="width:${bubbleSize}px;height:${bubbleSize}px;">${uniquePeople.size}</div>`, iconSize:[bubbleSize,bubbleSize], iconAnchor:[bubbleSize/2,bubbleSize/2]});
      const m = L.marker([avgLat, avgLon], {icon}).addTo(bubbleLayer); m.bindPopup(popupHtmlForArea(rows));
    } else {
      const pid = first.pid; const color = colorForPerson(pid); const pale = isBroad(first);
      const marker = L.circleMarker([first.lat, first.lon], {radius: pid===state.homeId?7:5.5, color:'#000', fillColor: color, fillOpacity: pale ? 0.22 : 0.72, opacity: 0.95, weight: 1.25});
      marker.addTo(eventLayer).bindPopup(`<div><strong>${esc(first.name)}</strong></div><div>${esc(first.type)} &middot; ${esc(first.date || (first.y0===first.y1 ? first.y0 : `${first.y0 ?? '?'}–${first.y1 ?? '?'}`))}</div><div>${esc(first.placeOrig || first.placeStd || 'Unknown place')}</div><div class="note">${esc(first.note || '')}</div>`);
      marker.on('click', ()=>{ state.focusedPersonId = pid; state.selectedPersonId = pid; showDetails(pid); scheduleRender(false, 20); });
      currentMarkerRefs.set(pid, marker);
    }
  }

  if (fitToData && visibleEvents.length) { map.fitBounds(L.latLngBounds(visibleEvents.map(ev=>[ev.lat, ev.lon])).pad(0.18), {maxZoom: 8}); }
  if (heavyViewportMode) { document.getElementById('detailHint').setAttribute('data-rendered', `${renderEvents.length}/${visibleEvents.length}`); } else { document.getElementById('detailHint').removeAttribute('data-rendered'); }
  if (state.focusedPersonId) showDetails(state.focusedPersonId);
  hideLoading();
}

function wireCollapseButtons() {
  const btns = [document.getElementById('collapseDetailBtn'), document.getElementById('collapseDetailBtnInner')].filter(Boolean);
  btns.forEach(btn => btn.onclick = () => {
    const fd = document.getElementById('floatingDetail');
    fd.classList.toggle('collapsed');
    const collapsed = fd.classList.contains('collapsed');
    state.detailCollapsed = collapsed;
    document.querySelectorAll('#collapseDetailBtn, #collapseDetailBtnInner').forEach(b => {
      if (b) {
        b.textContent = collapsed ? '+' : '−';
        b.title = collapsed ? 'Expand' : 'Collapse';
      }
    });
  });
}
function setHomeFromInput() { const val = document.getElementById('homeInput').value.trim(); const id = peopleByName.get(val); if (!id) return; state.homeId = id; state.focusedPersonId = id; state.selectedPersonId = null; state.selectedBranches = new Set(); state.initializedDates = false; state.branchUiSig = null; applyImmediateFilterChange(true, 'Rebuilding the map around a new home person.', 'Refreshing the scope for the new home person.'); }
function focusPerson() { const val = document.getElementById('focusInput').value.trim(); const id = peopleByName.get(val); if (!id) return; state.focusedPersonId = id; state.selectedPersonId = id; showDetails(id); scheduleRender(false, 20); const ev = bestEventForPerson(id, true) || bestEventForPerson(id, false); if (ev) map.setView([ev.lat, ev.lon], Math.max(map.getZoom(), 8)); }


let renderQueued = false, pendingFitToData = false, renderTimer = null, rerenderRequested = false, renderSerial = 0;
function scheduleRender(fitToData, debounceMs = 0) {
  pendingFitToData = pendingFitToData || !!fitToData;
  renderSerial += 1;
  const serial = renderSerial;
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  if (renderQueued) { rerenderRequested = true; return; }
  const fire = () => {
    if (serial !== renderSerial) return;
    if (renderQueued) { rerenderRequested = true; return; }
    renderQueued = true;
    requestAnimationFrame(() => {
      if (serial !== renderSerial) { renderQueued = false; return; }
      const fit = pendingFitToData;
      pendingFitToData = false;
      try {
        map.invalidateSize(false);
        render(fit);
      } catch (err) {
        console.error(err);
        hideLoading();
        showStatus('A redraw error occurred. The map kept the last successful view; try the change again or reload.', 0);
      } finally {
        renderQueued = false;
        const again = rerenderRequested;
        rerenderRequested = false;
        if (again) scheduleRender(false, 0);
      }
    });
  };
  if (debounceMs > 0) renderTimer = setTimeout(fire, debounceMs); else fire();
}

function applyImmediateFilterChange(fitToData = false, loadingMessage = '', loadingMeta = '') {
  if (loadingMessage) showLoading(loadingMessage, loadingMeta || 'Refreshing the visible family data.');
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  rerenderRequested = false;
  scheduleRender(fitToData, 0);
}


buildPeopleList(); wireCollapseButtons();
document.getElementById('setHomeBtn').addEventListener('click', setHomeFromInput);
document.getElementById('focusBtn').addEventListener('click', focusPerson);
document.getElementById('branchSearch').addEventListener('input', ()=>{ state.branchUiSig = null; refreshBranchList(state.currentScope || computeScopeCached(state.homeId), getCurrentControls()); });
document.getElementById('allBranchesBtn').addEventListener('click', ()=>{ state.selectedBranches = new Set([...scopeBranches(state.currentScope || computeScopeCached(state.homeId))]); state.branchUiSig = null; scheduleRender(false); });
document.getElementById('clearBranchesBtn').addEventListener('click', ()=>{ state.selectedBranches = new Set(); state.branchUiSig = null; scheduleRender(false); });
document.getElementById('modeSelect').addEventListener('change', e=>{ state.mode = e.target.value; state.selectedBranches = new Set(); state.initializedDates = false; state.branchUiSig = null; applyImmediateFilterChange(true, 'Updating map scope…', 'Switching scope and recalculating the visible family.'); });
['showDirect','showSiblings','showSpouses'].forEach(id=>document.getElementById(id).addEventListener('input', ()=>applyImmediateFilterChange(false)));
document.getElementById('genDepth').addEventListener('input', ()=>applyImmediateFilterChange(false));
document.querySelectorAll('input[name="side"]').forEach(el=>el.addEventListener('change', ()=>{ state.branchUiSig = null; applyImmediateFilterChange(false, 'Updating family side…', 'Redrawing the visible family lines and points.'); }));
document.getElementById('genDepth').addEventListener('input', ()=>{ document.getElementById('genVal').textContent = document.getElementById('genDepth').value; });
document.getElementById('dateMin').addEventListener('input', ()=>{ if (Number(dateMin.value) > Number(dateMax.value)) dateMin.value = dateMax.value; document.getElementById('dateMinVal').textContent = dateMin.value; applyImmediateFilterChange(false); });
document.getElementById('dateMax').addEventListener('input', ()=>{ if (Number(dateMax.value) < Number(dateMin.value)) dateMax.value = dateMin.value; document.getElementById('dateMaxVal').textContent = dateMax.value; applyImmediateFilterChange(false); });

map.on('moveend zoomend', ()=>scheduleRender(false, 60));
showLoading('Loading family data…', 'Starting with the oldest century, then filling forward.');
requestAnimationFrame(() => setTimeout(() => { scheduleRender(true, 0); loadRemainingChunksSequentially(); }, 0));

const mobileControlsBtn = document.getElementById('mobileControlsBtn');
const mobileCloseBtn = document.getElementById('mobileCloseBtn');
const mobileScrim = document.getElementById('mobileScrim');
const mobileMenuFab = document.getElementById('mobileMenuFab');
function setMobileSidebarOpen(open){
  document.body.classList.toggle('mobile-sidebar-open', !!open);
  if (mobileMenuFab) mobileMenuFab.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeMobileSidebar(){ setMobileSidebarOpen(false); }
function openMobileSidebar(){ if (window.innerWidth <= 900) setMobileSidebarOpen(true); }
if (mobileControlsBtn) mobileControlsBtn.addEventListener('click', openMobileSidebar);
if (mobileMenuFab) mobileMenuFab.addEventListener('click', openMobileSidebar);
if (mobileCloseBtn) mobileCloseBtn.addEventListener('click', closeMobileSidebar);
if (mobileScrim) mobileScrim.addEventListener('click', closeMobileSidebar);
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeMobileSidebar(); });
window.addEventListener('resize', ()=>{ if (window.innerWidth > 900) closeMobileSidebar(); });
window.addEventListener('orientationchange', ()=>{ setTimeout(()=> map.invalidateSize(), 120); closeMobileSidebar(); });
map.on('popupopen', ()=>{ if (window.innerWidth <= 900) closeMobileSidebar(); });
map.on('click', ()=>{ if (window.innerWidth <= 900 && document.body.classList.contains('mobile-sidebar-open')) closeMobileSidebar(); });
})();