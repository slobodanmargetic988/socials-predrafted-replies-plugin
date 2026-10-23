const $ = (id) => document.getElementById(id);

const RULES_FILE = "DRAFTING-RULES.md";
const AUTOSAVE_DELAY_MS = 800;
// Where the panel keeps the list of used drafts for make-drafts.js and the replenish skill.
const USED_PATH = ["drafts", "used", "used-from-extension.json"];

let state = null;
let toastTimer = null;
let rules = null; // { intro, dos: [], donts: [] }
let rulesDirty = false;
let usedWrittenFor = null; // archive length last written to the project folder

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

async function mutate(fn) {
  state = await XStore.load();
  const result = fn(state);
  await XStore.save(state);
  render();
  return result;
}

function avatar(project, remaining, tag = "span") {
  const el = document.createElement(tag);
  el.className = "avatar" + (remaining === 0 ? " empty" : "");
  el.style.background = XStore.iconFor(project.name).color;
  el.appendChild(XStore.createIcon(project.name, 18));
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = String(remaining);
  el.appendChild(badge);
  return el;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderSummary(counts) {
  let ready = 0;
  for (const c of Object.values(counts)) ready += c.active;
  $("summary").textContent = `${ready} ready · ${state.archive.length} used · ${state.projects.length} projects`;
  $("synced").textContent = state.fileSyncedAt ? `Drafts file changed ${formatDate(state.fileSyncedAt)}` : "Drafts file not loaded yet";
}

function renderToday(counts) {
  $("todayCount").textContent = `${state.todayIds.length}/${XStore.MAX_TODAY}`;
  const preview = $("todayPreview");
  preview.replaceChildren();

  for (const id of state.todayIds) {
    const project = state.projects.find((p) => p.id === id);
    if (!project) continue;
    const btn = avatar(project, counts[id].active, "button");
    btn.type = "button";
    btn.title = `${project.name}: ${counts[id].active} left. Click to remove from today.`;
    btn.addEventListener("click", () => mutate((s) => XStore.toggleToday(s, id)));
    preview.appendChild(btn);
  }
  for (let i = state.todayIds.length; i < XStore.MAX_TODAY; i++) {
    const slot = document.createElement("span");
    slot.className = "slot";
    preview.appendChild(slot);
  }
}

function renderProjects(counts) {
  const list = $("projectList");
  list.replaceChildren();

  if (state.projects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No projects yet. Build the drafts file or add one below.";
    list.appendChild(empty);
    return;
  }

  const atLimit = state.todayIds.length >= XStore.MAX_TODAY;
  for (const project of state.projects) {
    const { active, archived } = counts[project.id];
    const total = active + archived;
    const color = XStore.iconFor(project.name).color;
    const isToday = state.todayIds.includes(project.id);

    const row = document.createElement("li");
    row.className = "project";

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = project.name;
    const bar = document.createElement("div");
    bar.className = "bar";
    // Fill rate against the target, so you can see which projects need topping up.
    const target = XStore.TARGET_PER_PROJECT;
    const fill = document.createElement("span");
    fill.style.width = `${Math.min(1, active / target) * 100}%`;
    fill.style.background = color;
    bar.appendChild(fill);
    bar.title = `${Math.round(Math.min(1, active / target) * 100)}% full`;
    const stats = document.createElement("div");
    stats.className = "stats";
    stats.textContent = total === 0 ? "No drafts yet" : `${active} of ${target} ready · ${archived} used`;
    meta.append(name, bar, stats);

    const toggle = document.createElement("label");
    toggle.className = "switch";
    toggle.title = isToday ? "Shown today" : atLimit ? `Only ${XStore.MAX_TODAY} projects per day` : "Show today";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = isToday;
    box.disabled = !isToday && atLimit;
    box.setAttribute("aria-label", `Show ${project.name} today`);
    box.addEventListener("change", () => mutate((s) => XStore.toggleToday(s, project.id)));
    toggle.append(box, document.createElement("span"));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.title = `Delete ${project.name}`;
    remove.appendChild($("trashIcon").content.cloneNode(true));
    remove.addEventListener("click", () => {
      const what = active ? ` and its ${active} unused drafts` : "";
      if (!confirm(`Delete "${project.name}"${what}? Drafts you've used are kept, so they're never offered again.`)) return;
      mutate((s) => XStore.removeProject(s, project.id));
      toast(`Deleted ${project.name}.`);
    });

    row.append(avatar(project, active), meta, toggle, remove);
    list.appendChild(row);
  }
}

function renderImported() {
  const count = XStore.importedUnused(state).length;
  $("importedRow").hidden = count === 0;
  $("importedStatus").textContent = `${count} unused drafts imported by hand, on top of the drafts file`;
}

function render() {
  const counts = XStore.counts(state);
  renderSummary(counts);
  renderToday(counts);
  renderProjects(counts);
  renderImported();
}

$("clearImported").addEventListener("click", async () => {
  const count = XStore.importedUnused(state).length;
  if (!confirm(`Remove the ${count} unused drafts you imported by hand? Only the drafts file will be left. Drafts you've used stay recorded.`)) return;
  await mutate((s) => XStore.clearImported(s));
  toast(`Removed ${count} imported drafts.`);
});

// ---- Drafting rules (extension/DRAFTING-RULES.md) ----

// The file is an intro, then "## DO" and "## DON'T" sections of "- " bullet lines.
function parseRules(md) {
  const parsed = { intro: [], dos: [], donts: [] };
  let section = "intro";
  for (const line of md.split("\n")) {
    if (/^##\s+DON'?T\b/i.test(line)) section = "donts";
    else if (/^##\s+DO\b/i.test(line)) section = "dos";
    else if (section === "intro") parsed.intro.push(line);
    else if (line.startsWith("- ")) parsed[section].push(line.slice(2).trim());
  }
  return parsed;
}

function buildRules() {
  const list = (items) => items.filter((t) => t.trim()).map((t) => `- ${t.trim()}`).join("\n");
  return `${rules.intro.join("\n").trimEnd()}\n\n## DO\n\n${list(rules.dos)}\n\n## DON'T\n\n${list(rules.donts)}\n`;
}

async function readRulesFile() {
  const response = await fetch(chrome.runtime.getURL(RULES_FILE), { cache: "no-store" });
  if (!response.ok) throw new Error(`${RULES_FILE} isn't in the extension folder`);
  return response.text();
}

async function loadRules() {
  rules = parseRules(await readRulesFile());
  rulesDirty = false;
  renderRules();
  setRulesStatus(IDLE_STATUS);
}

function autosize(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

const IDLE_STATUS = `Saves automatically to ${RULES_FILE}`;

function setRulesStatus(text, { error = false, button = "Retry" } = {}) {
  $("rulesState").textContent = text;
  $("rulesState").classList.toggle("error", error);
  $("retrySave").hidden = !error;
  $("retrySave").textContent = button;
}

// Saves run one at a time, in order.
let saveQueue = Promise.resolve();
let saveTimer = null;

// Saves the rules to extension/DRAFTING-RULES.md. Interactive saves come straight from a
// click or Enter, so Chrome lets them ask for folder access; saves from typing stay quiet
// and say what's missing instead.
function saveRules({ interactive }) {
  clearTimeout(saveTimer);
  saveQueue = saveQueue.then(() => writeRules(interactive));
  return saveQueue;
}

async function writeRules(interactive) {
  if (!rulesDirty) return;
  const text = buildRules();
  setRulesStatus("Saving…");
  try {
    let dir = await projectFolder({ ask: interactive });
    const saved = await savedFolder();
    if (!dir && interactive && !saved) dir = await connectFolder();
    if (!dir) {
      if (saved) {
        setRulesStatus("Not saved: Chrome needs your OK to write to the project folder again.", { error: true, button: "Allow" });
      } else {
        setRulesStatus('Not saved yet: Chrome needs permission once. Click "Connect folder" and choose the "X plugin" folder (the one with make-drafts.js in it).', { error: true, button: "Connect folder" });
      }
      return;
    }
    await writeFile(dir, ["extension", RULES_FILE], text);
    // Read back through the extension to make sure the connected folder is this extension's.
    if ((await readRulesFile()) !== text) {
      setRulesStatus("Not saved here: the connected folder isn't the one this extension runs from", { error: true });
      return;
    }
    // Edits made while saving stay unsaved; their own timer saves them.
    if (buildRules() === text) rulesDirty = false;
    setRulesStatus(rulesDirty ? "Saving…" : `Saved to ${RULES_FILE}`);
  } catch (err) {
    console.error("Reply Drafts: couldn't save rules", err);
    setRulesStatus(`Not saved: ${err.name ? `${err.name}: ` : ""}${err.message}`, { error: true });
  }
}

function changed({ interactive }) {
  rulesDirty = true;
  if (interactive) {
    saveRules({ interactive: true });
  } else {
    setRulesStatus("Editing…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveRules({ interactive: false }), AUTOSAVE_DELAY_MS);
  }
}

function renderRules() {
  for (const [key, listId] of [["dos", "doList"], ["donts", "dontList"]]) {
    const list = $(listId);
    list.replaceChildren();
    rules[key].forEach((text, i) => {
      const li = document.createElement("li");
      const area = document.createElement("textarea");
      area.className = "rule-text";
      area.rows = 1;
      area.value = text;
      area.setAttribute("aria-label", key === "dos" ? "DO rule" : "DON'T rule");
      area.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.preventDefault(); // one rule per line
      });
      area.addEventListener("input", () => {
        rules[key][i] = area.value.replace(/\s*\n\s*/g, " ");
        autosize(area);
        changed({ interactive: false });
      });
      // Leaving the field saves right away instead of waiting for the timer.
      area.addEventListener("blur", () => {
        if (rulesDirty) saveRules({ interactive: false });
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn";
      remove.title = "Remove rule";
      remove.appendChild($("closeIcon").content.cloneNode(true));
      remove.addEventListener("click", () => {
        rules[key].splice(i, 1);
        renderRules();
        changed({ interactive: true });
      });
      li.append(area, remove);
      list.appendChild(li);
      requestAnimationFrame(() => autosize(area));
    });
  }
}

for (const [formId, inputId, key] of [["doForm", "doInput", "dos"], ["dontForm", "dontInput", "donts"]]) {
  $(formId).addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $(inputId);
    const text = input.value.trim();
    if (!text || !rules) return;
    rules[key].push(text);
    input.value = "";
    renderRules();
    changed({ interactive: true });
  });
}

$("retrySave").addEventListener("click", () => saveRules({ interactive: true }));

// Click handlers that write to disk can fail in ways Chrome reports only as an exception
// (permission prompts, folder access). Show the reason instead of failing silently.
function reportErrors(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error("Reply Drafts:", err);
      toast(`Failed: ${err.name ? `${err.name}: ` : ""}${err.message}`);
    }
  };
}

// ---- Project folder (File System Access, remembered in IndexedDB) ----

function handleStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("reply-drafts", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const request = fn(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

const savedFolder = () => handleStore("readonly", (s) => s.get("projectFolder")).catch(() => null);

// The connected project folder, or null. Chrome usually drops the permission when it
// restarts; with ask it prompts again, which only works from a click.
async function projectFolder({ ask = false } = {}) {
  const dir = await savedFolder();
  if (!dir) return null;
  let permission = await dir.queryPermission({ mode: "readwrite" });
  if (permission === "prompt" && ask) permission = await dir.requestPermission({ mode: "readwrite" });
  return permission === "granted" ? dir : null;
}

async function connectFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    toast("This Chrome doesn't allow folder access here.");
    return null;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: "reply-drafts-project", mode: "readwrite" });
  } catch (err) {
    if (err.name !== "AbortError") toast("Couldn't open the folder: " + err.message);
    return null;
  }
  try {
    await dir.getFileHandle("make-drafts.js");
    await (await dir.getDirectoryHandle("extension")).getFileHandle(RULES_FILE);
  } catch {
    toast(`"${dir.name}" isn't it. Choose the "X plugin" folder: the one with make-drafts.js, drafts and extension inside.`);
    return null;
  }
  await handleStore("readwrite", (s) => s.put(dir, "projectFolder"));
  usedWrittenFor = null;
  await renderFolder();
  await writeUsed();
  toast(`Connected ${dir.name}.`);
  return dir;
}

async function writeFile(dir, parts, text) {
  let folder = dir;
  for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
  const file = await folder.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

async function renderFolder() {
  const saved = await savedFolder();
  const dir = await projectFolder();
  $("folderStatus").textContent = dir ? `Connected: ${dir.name}` : saved ? "Needs permission again" : "Not connected";
  $("connectFolder").textContent = dir ? "Change" : saved ? "Allow" : "Connect";
}

$("connectFolder").addEventListener("click", reportErrors(async () => {
  const saved = await savedFolder();
  if (saved && !(await projectFolder())) {
    const dir = await projectFolder({ ask: true });
    if (dir) {
      await renderFolder();
      await writeUsed();
      toast(`Connected ${dir.name}.`);
      return;
    }
  }
  await connectFolder();
}));

function usedJson() {
  const data = state.archive.map(({ project, text, usedAt }) => ({
    project,
    text,
    usedAt: usedAt ? new Date(usedAt).toISOString() : null,
  }));
  return JSON.stringify(data, null, 2) + "\n";
}

// Keeps drafts/used/used-from-extension.json current while the folder is connected,
// so make-drafts.js and the replenish skill know what's been posted.
async function writeUsed() {
  if (!state || state.archive.length === usedWrittenFor) return;
  const dir = await projectFolder();
  if (!dir) return;
  try {
    await writeFile(dir, USED_PATH, usedJson());
    usedWrittenFor = state.archive.length;
  } catch (err) {
    console.error("Reply Drafts: couldn't write used drafts", err);
    toast(`Couldn't update drafts/used: ${err.message}`);
  }
}

function downloadFile(name, text, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$("exportArchive").addEventListener("click", () => {
  downloadFile(`reply-drafts-archive-${new Date().toISOString().slice(0, 10)}.json`, usedJson(), "application/json");
  toast(`Exported ${state.archive.length} used drafts.`);
});

// ---- SubQ ranking ----
// The key is only ever written to storage and sent by the background; the panel shows
// its last 4 characters so you can tell which one is saved.

async function renderSubq() {
  const settings = await XStore.loadSettings();
  $("rankOnX").checked = settings.rankOnX;
  $("subqModel").value = settings.subqModel;
  $("subqRemove").hidden = !settings.subqApiKey;
  $("subqTest").disabled = !settings.subqApiKey;
  const key = settings.subqApiKey;
  $("subqStatus").textContent = key
    ? `SubQ key saved: ${key.slice(0, 3)}…${key.slice(-4)}, ${key.length} characters${settings.rankOnX ? "" : " · switched off"}`
    : "Needs a SubQ API key";
}

// Cleans up common copy-paste extras: surrounding quotes, a leading "Bearer ",
// "SUBQ_API_KEY=", spaces and line breaks.
function cleanKey(raw) {
  return raw
    .trim()
    .replace(/^SUBQ_API_KEY\s*=\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
}

// Problems you can spot without asking SubQ.
function keyWarning(key) {
  if (/…|\.\.\.|\*{2,}|•/.test(key)) return "This looks like a shortened key (it has … or ***). Copy the full key, usually shown only once when you create it.";
  // SubQ also accepts Auth0 tokens, which are JWTs starting with "eyJ".
  if (!key.startsWith("sk-") && !key.startsWith("eyJ")) return `SubQ keys start with "sk-", and this one starts with "${key.slice(0, 3)}". It may be the key's name or ID rather than the key itself.`;
  if (key.length < 20) return `This key is only ${key.length} characters long, which is shorter than a real key.`;
  return "";
}

$("subqForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = cleanKey($("subqKey").value);
  if (!key) return;
  const warning = keyWarning(key);
  if (warning && !confirm(`${warning}\n\nSave it anyway?`)) return;
  await XStore.saveSettings({ subqApiKey: key });
  $("subqKey").value = "";
  await renderSubq();
  toast("SubQ key saved. Click Test to check it.");
});

$("rankOnX").addEventListener("change", async () => {
  await XStore.saveSettings({ rankOnX: $("rankOnX").checked });
  await renderSubq();
});

$("subqModel").addEventListener("change", async () => {
  const model = $("subqModel").value.trim() || "subq-snap-1.1";
  await XStore.saveSettings({ subqModel: model });
  await renderSubq();
  toast(`Model set to ${model}.`);
});

$("subqRemove").addEventListener("click", async () => {
  if (!confirm("Remove the saved SubQ API key from this browser?")) return;
  await XStore.saveSettings({ subqApiKey: "" });
  await renderSubq();
  toast("SubQ key removed.");
});

$("subqTest").addEventListener("click", async () => {
  $("subqTest").disabled = true;
  toast("Testing SubQ…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "testSubq" });
    if (result && result.ok) {
      await renderSubq();
      toast(result.switchedFrom ? `Your key can't use ${result.switchedFrom}, so I switched to ${result.model}. SubQ works.` : `SubQ works with ${result.model}.`);
    } else if (result && result.models) {
      toast(`SubQ test failed: ${result.error}`);
      $("subqStatus").textContent = `Test failed. Models your key lists: ${result.models.join(", ")}`;
    } else {
      // Errors can be long; keep them on screen long enough to read.
      toast(`SubQ test failed: ${result && result.error}`);
      $("subqStatus").textContent = `Test failed: ${result && result.error}`;
    }
  } finally {
    $("subqTest").disabled = false;
  }
});

// ---- Import a one-off file ----

async function importItems(items) {
  if (!Array.isArray(items)) {
    toast("Import failed: the JSON must be a list of drafts.");
    return false;
  }
  const result = await mutate((s) => XStore.importDrafts(s, items));
  const parts = [`Added ${result.added} drafts.`];
  if (result.alreadyUsed) parts.push(`Skipped ${result.alreadyUsed} already used.`);
  if (result.duplicates) parts.push(`Skipped ${result.duplicates} you already had.`);
  if (result.invalid) parts.push(`Skipped ${result.invalid} invalid.`);
  toast(parts.join(" "));
  return true;
}

$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("newProject");
  const name = input.value.trim();
  if (!name) return;
  mutate((s) => XStore.addProject(s, name));
  input.value = "";
  toast(`Added ${name}.`);
});

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    await importItems(JSON.parse(await file.text()));
  } catch (err) {
    toast("Import failed: " + err.message);
  }
});

$("importBtn").addEventListener("click", async () => {
  const text = $("importText").value.trim();
  if (!text) {
    toast("Paste JSON first.");
    return;
  }
  try {
    if (await importItems(JSON.parse(text))) $("importText").value = "";
  } catch (err) {
    toast("Import failed: " + err.message);
  }
});

// ---- Sync ----

// Loads state, adds any new projects from the drafts file, renders, and keeps the
// used-drafts file in the project folder current.
async function refresh() {
  state = await XStore.load();
  if (XStore.addFileProjects(state)) await XStore.save(state);
  render();
  writeUsed();
}

async function syncAndRefresh() {
  try {
    const result = await XStore.syncBundledFile();
    await refresh();
    return result;
  } catch (err) {
    await refresh();
    toast("Couldn't read the drafts file: " + err.message);
    return null;
  }
}

$("syncNow").addEventListener("click", async () => {
  const btn = $("syncNow");
  btn.classList.add("spinning");
  const started = Date.now();
  const result = await syncAndRefresh();
  // Pick up rule edits made on disk too, unless there are unsaved edits here.
  if (!rulesDirty) await loadRules().catch(() => {});
  setTimeout(() => btn.classList.remove("spinning"), Math.max(0, 500 - (Date.now() - started)));
  if (result) toast(result.changed ? `Loaded ${result.count} drafts from the file.` : "Everything is up to date.");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[XStore.KEY] || changes[XStore.FILE_KEY])) refresh();
});

(async () => {
  await syncAndRefresh();
  await loadRules().catch((err) => toast("Couldn't read the rules: " + err.message));
  await renderFolder();
  await renderSubq();
})();
