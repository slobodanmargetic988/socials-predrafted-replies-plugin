// Shared data layer. Loaded by the side panel and by the X content script.
// Everything lives in chrome.storage.local on this computer only.
//
// State shape:
//   projects: [{ id, name }]         your projects, in display order
//   todayIds: [projectId, ...]       up to 5 projects shown as circles today
//   drafts:   [{ id, projectId, text, createdAt }]     drafts imported by hand in the side panel
//   archive:  [{ project, text, usedAt }]               every draft ever used; never deleted
//   hidden:   [lowercase name, ...]                     deleted projects the drafts file shouldn't re-add
//
// The main source of drafts is drafts.json in the extension folder. It's synced into
// its own storage key (FILE_KEY) and matched to projects by name.
//
// The archive stores the project by name, so it survives deleting or re-importing projects.
// Anything in the archive is never offered again, so a reply is never posted twice.

const XStore = (() => {
  const KEY = "replyDrafts";
  const FILE_KEY = "replyDraftsFile";
  // SubQ ranking settings, including the API key. Only the side panel and the background read it.
  const SETTINGS_KEY = "replyDraftsSettings";
  const DEFAULT_SETTINGS = { rankOnX: true, subqApiKey: "", subqModel: "subq-snap-1.1" };
  // Built by make-drafts.js. Re-read automatically; see syncBundledFile().
  const DRAFTS_FILE = "drafts.json";
  const MAX_TODAY = 5;
  // How many unused drafts a project should have: 250 fits one SubQ ranking request (max 255).
  // make-drafts.js and the replenish skill top up to the same number.
  const TARGET_PER_PROJECT = 250;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Icons are 24x24 line drawings stored as [tag, attributes] pairs, so they can be
  // built with createElementNS (no innerHTML on x.com). Matched by project name.
  const DOT = { fill: "currentColor", stroke: "none" };
  const ICONS = {
    "my app": {
      color: "#ea580c",
      shapes: [["path", { d: "M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z" }]],
    },
    "side project": {
      color: "#7c3aed",
      shapes: [
        ["circle", { cx: 12, cy: 12, r: 3 }],
        ["circle", { cx: 5, cy: 5, r: 2 }],
        ["circle", { cx: 19, cy: 5, r: 2 }],
        ["circle", { cx: 12, cy: 20, r: 2 }],
        ["path", { d: "M6.4 6.4l3.5 3.5M17.6 6.4l-3.5 3.5M12 15v3" }],
      ],
    },
    connect: {
      color: "#0284c7",
      shapes: [
        ["path", { d: "M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5z" }],
        ["circle", { cx: 9, cy: 11.5, r: 1, ...DOT }],
        ["circle", { cx: 12.5, cy: 11.5, r: 1, ...DOT }],
        ["circle", { cx: 16, cy: 11.5, r: 1, ...DOT }],
      ],
    },
  };
  // The "Best match" button in the reply bar.
  ICONS["best match"] = {
    color: "#e5a000",
    shapes: [["path", { d: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z", fill: "currentColor" }]],
  };

  const FALLBACK_COLORS = ["#9333ea", "#0f766e", "#b45309", "#be185d", "#1d4ed8", "#4d7c0f"];
  const FALLBACK_SHAPES = [
    ["path", { d: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" }],
  ];

  function iconFor(name) {
    const key = name.trim().toLowerCase();
    if (ICONS[key]) return ICONS[key];
    // Unknown project: generic icon, color picked from the name so it stays stable.
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return { color: FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length], shapes: FALLBACK_SHAPES };
  }

  function createIcon(name, size = 18) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs = {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, shapeAttrs] of iconFor(name).shapes) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(shapeAttrs)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    }
    return svg;
  }

  function emptyState() {
    return { projects: [], todayIds: [], drafts: [], archive: [], hidden: [] };
  }

  // Returns the main state plus fileDrafts: the drafts read from the bundled drafts file
  // by the last sync. Those live under their own key and only syncBundledFile() writes it,
  // so a sync can never overwrite an archive entry being saved at the same moment.
  async function load() {
    const result = await chrome.storage.local.get([KEY, FILE_KEY]);
    const state = migrate({ ...emptyState(), ...(result[KEY] || {}) });
    const file = result[FILE_KEY] || {};
    state.fileDrafts = file.drafts || [];
    state.fileSyncedAt = file.syncedAt || null;
    return state;
  }

  // Earlier versions kept used drafts in the drafts list with status "archived".
  // Move them into the archive. The change is stored on the next save.
  function migrate(state) {
    const used = state.drafts.filter((d) => d.status === "archived");
    if (used.length === 0) return state;
    const names = new Map(state.projects.map((p) => [p.id, p.name]));
    for (const d of used) {
      state.archive.push({ project: names.get(d.projectId) || "Unknown", text: d.text, usedAt: d.usedAt || null });
    }
    state.drafts = state.drafts
      .filter((d) => d.status !== "archived")
      .map(({ id, projectId, text, createdAt }) => ({ id, projectId, text, createdAt }));
    return state;
  }

  async function save(state) {
    const { fileDrafts, fileSyncedAt, ...main } = state;
    await chrome.storage.local.set({ [KEY]: main });
  }

  async function loadSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
  }

  async function saveSettings(changes) {
    const settings = { ...(await loadSettings()), ...changes };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return settings;
  }

  // The projects switched on for today, in button order.
  function todayProjects(state) {
    return state.todayIds.map((id) => state.projects.find((p) => p.id === id)).filter(Boolean);
  }

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${h.toString(36)}:${text.length}`;
  }

  // Reads the drafts file in the extension folder. Chrome serves an unpacked extension's
  // files straight from disk, so a rebuilt file is picked up without reloading the extension.
  // Only writes storage when the file actually changed.
  async function syncBundledFile() {
    const response = await fetch(chrome.runtime.getURL(DRAFTS_FILE), { cache: "no-store" });
    if (!response.ok) return { changed: false, count: 0 };
    const raw = await response.text();
    const hash = hashText(raw);
    const stored = (await chrome.storage.local.get(FILE_KEY))[FILE_KEY];
    if (stored && stored.hash === hash) return { changed: false, count: stored.drafts.length };
    const items = JSON.parse(raw);
    const { valid } = validItems(Array.isArray(items) ? items : []);
    await chrome.storage.local.set({ [FILE_KEY]: { hash, drafts: valid, syncedAt: Date.now() } });
    return { changed: true, count: valid.length };
  }

  // Adds a project for every name in the drafts file, except ones you deleted.
  // Returns true if anything was added (the caller saves).
  function addFileProjects(state) {
    const hidden = new Set(state.hidden);
    let added = false;
    for (const { project } of state.fileDrafts) {
      if (hidden.has(project.toLowerCase()) || findProjectByName(state, project)) continue;
      addProject(state, project);
      added = true;
    }
    return added;
  }

  function newId() {
    return crypto.randomUUID();
  }

  function normalize(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function findProjectByName(state, name) {
    const wanted = name.trim().toLowerCase();
    return state.projects.find((p) => p.name.toLowerCase() === wanted) || null;
  }

  function addProject(state, name) {
    const clean = name.trim();
    if (!clean) return null;
    state.hidden = state.hidden.filter((h) => h !== clean.toLowerCase());
    const existing = findProjectByName(state, clean);
    if (existing) return existing;
    const project = { id: newId(), name: clean };
    state.projects.push(project);
    return project;
  }

  // Removes the project and its imported drafts. Its archived drafts stay in the archive.
  // It's remembered as deleted so the drafts file doesn't bring it back.
  function removeProject(state, projectId) {
    const project = state.projects.find((p) => p.id === projectId);
    if (project && !state.hidden.includes(project.name.toLowerCase())) state.hidden.push(project.name.toLowerCase());
    state.projects = state.projects.filter((p) => p.id !== projectId);
    state.todayIds = state.todayIds.filter((id) => id !== projectId);
    state.drafts = state.drafts.filter((d) => d.projectId !== projectId);
  }

  function toggleToday(state, projectId) {
    if (state.todayIds.includes(projectId)) {
      state.todayIds = state.todayIds.filter((id) => id !== projectId);
      return true;
    }
    if (state.todayIds.length >= MAX_TODAY) return false;
    state.todayIds.push(projectId);
    return true;
  }

  function validItems(items) {
    const valid = [];
    let invalid = 0;
    for (const item of items) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      const project = typeof item.project === "string" ? item.project.trim() : "";
      if (text && project) valid.push({ project, text });
      else invalid += 1;
    }
    return { valid, invalid };
  }

  function usedSet(state) {
    return new Set(state.archive.map((a) => normalize(a.text)));
  }

  // items: [{ project: "Name", text: "..." }]. Adds one-off drafts on top of the drafts file.
  // Unknown project names are created. A draft whose text is already in the drafts file,
  // already imported, or in the archive is skipped, so imports never create duplicates or
  // bring back used replies.
  function importDrafts(state, items) {
    const { valid, invalid } = validItems(items);

    const unused = new Set([...state.fileDrafts, ...state.drafts].map((d) => normalize(d.text)));
    const used = usedSet(state);
    let added = 0;
    let duplicates = 0;
    let alreadyUsed = 0;
    for (const { project: projectName, text } of valid) {
      const key = normalize(text);
      if (used.has(key)) {
        alreadyUsed += 1;
        continue;
      }
      if (unused.has(key)) {
        duplicates += 1;
        continue;
      }
      unused.add(key);
      const project = addProject(state, projectName);
      state.drafts.push({ id: newId(), projectId: project.id, text, createdAt: Date.now() });
      added += 1;
    }
    return { added, duplicates, alreadyUsed, invalid };
  }

  // Unused drafts for a project, in order: drafts file first, then imported ones.
  // Anything in the archive is left out, and a draft in both places counts once.
  // Imported drafts carry their id so archiving can remove them from the list.
  function poolFor(state, project, used = usedSet(state)) {
    const name = project.name.toLowerCase();
    const seen = new Set();
    const pool = [];
    const consider = (text, id) => {
      const key = normalize(text);
      if (used.has(key) || seen.has(key)) return;
      seen.add(key);
      pool.push(id ? { id, text } : { text });
    };
    for (const d of state.fileDrafts) if (d.project.toLowerCase() === name) consider(d.text);
    for (const d of state.drafts) if (d.projectId === project.id) consider(d.text, d.id);
    return pool;
  }

  // Imported drafts that are unused and not also in the drafts file.
  function importedUnused(state) {
    const used = usedSet(state);
    const inFile = new Set(state.fileDrafts.map((d) => normalize(d.text)));
    return state.drafts.filter((d) => !used.has(normalize(d.text)) && !inFile.has(normalize(d.text)));
  }

  // Drops every hand-imported draft, leaving only the drafts file. Used drafts stay recorded.
  function clearImported(state) {
    const count = importedUnused(state).length;
    state.drafts = [];
    return count;
  }

  function nextActiveDraft(state, projectId) {
    const project = state.projects.find((p) => p.id === projectId);
    return project ? poolFor(state, project)[0] || null : null;
  }

  // Records a draft as used. File drafts are skipped from then on because of the archive;
  // imported drafts are also removed from the drafts list.
  function archiveDraft(state, projectId, draft) {
    const project = state.projects.find((p) => p.id === projectId);
    if (draft.id) state.drafts = state.drafts.filter((d) => d.id !== draft.id);
    state.archive.push({ project: project ? project.name : "Unknown", text: draft.text, usedAt: Date.now() });
  }

  // Map of projectId -> { active, archived }. Archived counts match the archive by project name.
  function counts(state) {
    const result = {};
    const byName = new Map();
    const used = usedSet(state);
    for (const p of state.projects) {
      result[p.id] = { active: poolFor(state, p, used).length, archived: 0 };
      byName.set(p.name.toLowerCase(), result[p.id]);
    }
    for (const a of state.archive) {
      const c = byName.get(a.project.toLowerCase());
      if (c) c.archived += 1;
    }
    return result;
  }

  return {
    KEY,
    FILE_KEY,
    SETTINGS_KEY,
    DRAFTS_FILE,
    MAX_TODAY,
    TARGET_PER_PROJECT,
    normalize,
    loadSettings,
    saveSettings,
    todayProjects,
    poolFor,
    iconFor,
    createIcon,
    load,
    save,
    syncBundledFile,
    addFileProjects,
    addProject,
    removeProject,
    toggleToday,
    importDrafts,
    importedUnused,
    clearImported,
    nextActiveDraft,
    archiveDraft,
    counts,
  };
})();
