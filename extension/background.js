// Opens the side panel from the toolbar icon, and keeps the extension's copy of the drafts
// file current. Nothing here touches X or Facebook pages.
importScripts("store.js");

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("Reply Drafts: could not set panel behavior", err));

const SYNC_ALARM = "syncDrafts";

function sync() {
  return XStore.syncBundledFile().catch((err) => {
    console.error("Reply Drafts: could not read the drafts file", err);
    return { changed: false, error: String(err) };
  });
}

// Re-read the drafts file at install/reload, at Chrome startup, every few minutes,
// and whenever a reply box or the side panel asks.
chrome.alarms.get(SYNC_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
});
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) sync();
});

// ---- Ranking drafts for a post with SubQ ----
// The content script sends the text of the post being replied to. This asks SubQ's
// Decisions API (a decision model, not a text generator) choice questions with drafts as
// the options; SubQ returns a probability for each, and sorting by it gives the order.
//   Round 1: one request per project (in batches of 255), all in parallel.
//   Round 2: the top 50 of every project (fewer with 6+ projects) in one request, for the star.
// The API key never leaves here.

const SUBQ_DECISIONS_URL = "https://api.subq.ai/v1/systemone";
const SUBQ_MODELS_URL = "https://api.subq.ai/v1/models";
const SUBQ_TIMEOUT_MS = 30000;
// A choice question takes 2 to 255 options.
const MAX_OPTIONS = 255;
// How many of each project's best go into the star's round. With 5 projects, 50 each is
// 250, just under the 255 limit; more projects get fewer each so it always fits.
const TOP_PER_PROJECT = 50;
const QUESTION = "best_reply";

const FIT =
  "it should respond to what the post asks or talks about and sound natural in that conversation. " +
  "Replies that would read as off-topic or spammy here are worst.";
const PROJECT_INSTRUCTIONS =
  "The state is a social media post someone is replying to. Each option is a pre-written reply. " +
  `Pick the reply that fits this post best: ${FIT}`;
const BEST_INSTRUCTIONS =
  "The state is a social media post someone is replying to. Each option is a pre-written reply, " +
  "labelled with the project it is about. Pick the single best reply to this post, whichever project " +
  `it is about: ${FIT}`;

// Includes SubQ's own explanation, so problems can be told apart.
function subqError(status, body) {
  const info = (body && (body.detail || body.error)) || {};
  const detail = typeof info === "string" ? info : info.message || info.error_type || info.code;
  const said = detail ? ` SubQ said: "${detail}"` : "";
  if (status === 401) return `SubQ didn't accept the API key (401).${said} Paste the full key again in the side panel's Settings.`;
  if (status === 403) return `Your SubQ key can't use this model (403).${said} Click Test in Settings to switch to a model your key can use.`;
  if (status === 402) return `Your SubQ account is out of credits (402).${said}`;
  if (status === 422) return `SubQ couldn't use the request (422).${said} The model must be a decision model such as subq-snap-1.1.`;
  if (status === 429) return `SubQ is rate limiting requests (429). Try again in a moment.${said}`;
  if (status === 503) return `SubQ is temporarily unavailable (503).${said}`;
  return `SubQ error ${status}.${said}`;
}

// One call to the Decisions API. questions is an object keyed by question name, e.g.
// { best_reply: { type: "choice", instructions, criteria } }. Returns the answers object,
// keyed by the same names.
async function decide(settings, stateValue, questions) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBQ_TIMEOUT_MS);
  try {
    const response = await fetch(SUBQ_DECISIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.subqApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.subqModel, state: stateValue, questions }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(subqError(response.status, body));
    if (!body || !body.answers) throw new Error("SubQ's answer had no decisions in it.");
    return body.answers;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("SubQ took too long to answer.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Asks one choice question over up to 255 texts. Returns [{ text, p }] sorted best first,
// with SubQ's pick on top. Texts SubQ leaves out keep their order at the end.
async function rankChoice(settings, postText, texts, labelFor, instructions) {
  if (texts.length < 2) return texts.map((text) => ({ text, p: 1 }));
  const options = {};
  texts.forEach((text, i) => (options[`d${i + 1}`] = labelFor(text)));
  const answers = await decide(settings, postText, {
    [QUESTION]: { type: "choice", instructions, criteria: options },
  });
  const answer = answers[QUESTION] || {};
  const probabilities = answer.probabilities || {};
  const ids = Object.keys(options);
  const p = (id) => (id === answer.choice ? Infinity : Number(probabilities[id]) || 0);
  // Stable sort: ties (and anything SubQ didn't score) keep their original order.
  return ids
    .map((id, i) => ({ id, i, score: p(id) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ id, score }) => ({ text: texts[Number(id.slice(1)) - 1], p: score === Infinity ? 1 : score }));
}

// Ranks every draft of one project. Over 255 drafts, they're ranked in batches of 255 at
// once. Probabilities only compare within one request, so the best of each batch then go
// into a playoff request, and the rest follow round-robin by their batch rank.
async function rankProject(settings, postText, project, texts) {
  const instructions = `${PROJECT_INSTRUCTIONS} All options are about ${project.name}.`;
  const batches = [];
  for (let i = 0; i < texts.length; i += MAX_OPTIONS) batches.push(texts.slice(i, i + MAX_OPTIONS));
  const ranked = (await Promise.all(batches.map((batch) => rankChoice(settings, postText, batch, (t) => t, instructions)))).map(
    (list) => list.map((r) => r.text)
  );
  if (ranked.length === 1) return ranked[0];

  const perBatch = Math.floor(MAX_OPTIONS / ranked.length);
  const playoff = (await rankChoice(settings, postText, ranked.flatMap((list) => list.slice(0, perBatch)), (t) => t, instructions)).map(
    (r) => r.text
  );
  const placed = new Set(playoff);
  return [...playoff, ...roundRobin(ranked.map((list) => list.filter((t) => !placed.has(t))))];
}

// Returns { order, projects, failed } with every list best first, { off: true } when ranking
// isn't set up, or { error } when nothing could be ranked.
//   projects: { [project name]: [draft text, ...] }  each project's own drafts, ranked
//   order:    [draft text, ...]                      for the star: the top 50 of each project
//                                                     ranked against each other, then the rest
//                                                     round-robin by their project rank
async function rankDrafts(postText) {
  const settings = await XStore.loadSettings();
  if (!settings.rankOnX || !settings.subqApiKey) return { off: true };

  const state = await XStore.load();
  const pools = XStore.todayProjects(state)
    .map((project) => ({ project, texts: XStore.poolFor(state, project).map((d) => d.text) }))
    .filter((p) => p.texts.length > 0);
  if (pools.length === 0) return { order: [], projects: {}, failed: [] };

  // Round 1: every project at once. A failed project keeps its normal order.
  const failed = [];
  let firstError = null;
  const projects = {};
  await Promise.all(
    pools.map(async ({ project, texts }) => {
      try {
        projects[project.name] = await rankProject(settings, postText, project, texts);
      } catch (err) {
        firstError = firstError || err;
        failed.push(project.name);
        projects[project.name] = texts;
      }
    })
  );
  if (failed.length === pools.length) throw firstError;

  // Round 2: the best few of each project against each other, for the star.
  const projectOf = new Map();
  for (const { project } of pools) for (const t of projects[project.name]) projectOf.set(t, project.name);
  const perProject = Math.min(TOP_PER_PROJECT, Math.floor(MAX_OPTIONS / pools.length));
  const finalists = pools.flatMap(({ project }) => projects[project.name].slice(0, perProject));
  let best;
  try {
    best = (await rankChoice(settings, postText, finalists, (t) => `${projectOf.get(t)}: ${t}`, BEST_INSTRUCTIONS)).map((r) => r.text);
  } catch (err) {
    failed.push("best match");
    best = roundRobin(pools.map(({ project }) => projects[project.name].slice(0, perProject)));
  }
  const inBest = new Set(best);
  const rest = roundRobin(pools.map(({ project }) => projects[project.name].filter((t) => !inBest.has(t))));
  return { order: [...best, ...rest], projects, failed, error: failed.length ? firstError && firstError.message : undefined };
}

// [[a1, a2], [b1, b2]] -> [a1, b1, a2, b2]
function roundRobin(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// The model ids this key may use, from SubQ's /v1/models. Null if it can't tell.
async function allowedModels(settings) {
  try {
    const response = await fetch(SUBQ_MODELS_URL, { headers: { Authorization: `Bearer ${settings.subqApiKey}` } });
    if (!response.ok) return null;
    const body = await response.json();
    const list = Array.isArray(body && body.data) ? body.data : Array.isArray(body) ? body : [];
    const ids = list.map((m) => (typeof m === "string" ? m : m && m.id)).filter(Boolean);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

// Checks the key and model from the side panel with one tiny yes/no decision. If the saved
// model doesn't work for this key, switches to the first one that does and says so.
async function testSubq() {
  const settings = await XStore.loadSettings();
  if (!settings.subqApiKey) return { error: "No API key saved." };
  const models = await allowedModels(settings);
  const tryOrder = [settings.subqModel, ...(models || []).filter((m) => m !== settings.subqModel)];
  let lastError = null;
  for (const model of tryOrder) {
    try {
      await decide({ ...settings, subqModel: model }, "What are you building?", {
        is_question: { type: "noul", instructions: "Is this text a question?" },
      });
      if (model !== settings.subqModel) await XStore.saveSettings({ subqModel: model });
      return { ok: true, model, switchedFrom: model !== settings.subqModel ? settings.subqModel : null, models };
    } catch (err) {
      lastError = err;
      // Only a model problem is worth trying the next model for: 403 (not allowed) or a 422
      // that's about the model rather than the request format.
      if (!/\(403\)/.test(err.message) && !/\(422\).*model/i.test(err.message.replace(/The model must be.*$/, ""))) break;
    }
  }
  return { error: lastError ? lastError.message : "SubQ didn't answer.", models };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  const handlers = {
    syncDrafts: () => sync(),
    rankDrafts: () => rankDrafts(String(message.postText || "")),
    testSubq: () => testSubq(),
  };
  const handler = handlers[message.type];
  if (!handler) return;
  handler()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message || String(err) }));
  return true;
});
