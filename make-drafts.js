// Builds extension/drafts.json from the text files in drafts/.
// Each file starts with "# Project name", then one draft per line.
//
// Files in drafts/used/ list drafts already posted. The side panel keeps
// used-from-extension.json there current when the project folder is connected; archive
// exports work too.
// Drafts that exactly match one are left out of the JSON (the text files keep them as
// history). New drafts that closely resemble an already posted one are refused.
//
// Refuses to write the JSON if any draft is duplicated, over 8,000 characters, or too similar
// to another draft in the same project, and lists what to fix. Warns (without refusing)
// when more than a third of a project's drafts have emojis.
//
//   node make-drafts.js                  build the JSON
//   node make-drafts.js --status         show unused drafts per project (refill below 200, up to 250), write nothing
//   node make-drafts.js --pull-archive   first copy the newest archive export from ~/Downloads
//                                        into drafts/used/ (combine with either of the above)
const fs = require("fs");
const os = require("os");
const path = require("path");

// Hard limit: Facebook comments stop at 8,000 characters (X Premium allows 25,000).
const MAX_LENGTH = 8000;
// Drafts over this count as long posts (X Premium). --status shows each project's share,
// so the skill can steer toward the mix in the rules.
const SHORT_LENGTH = 280;
// Hard limit from the rules: at most this many emojis in one draft.
const MAX_EMOJIS = 2;
// The rules allow emojis in at most this share of a project's drafts; more gets a warning.
const EMOJI_SHARE = 1 / 3;
const emojiCount = (text) => (text.match(/\p{Extended_Pictographic}/gu) || []).length;
const pct = (n, total) => `${total ? Math.round((n / total) * 100) : 0}%`;
// Matches the extension's TARGET_PER_PROJECT: 250 fits one SubQ ranking request (max 255).
const TARGET = 250;
// A project is only refilled once it drops below this, then back up to TARGET.
const REFILL_BELOW = 200;
// Share of meaningful words two drafts can have in common before they count as near-duplicates.
const SIMILARITY_LIMIT = 0.6;
const EXPORT_PREFIX = "reply-drafts-archive-";

const args = new Set(process.argv.slice(2));
const draftsDir = path.join(__dirname, "drafts");
const usedDir = path.join(draftsDir, "used");
const outPath = path.join(__dirname, "extension", "drafts.json");

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Links don't count toward similarity: the same repo link in every draft is fine.
function words(text, ignore) {
  return new Set(
    text
      .replace(/https?:\/\/\S+/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !ignore.has(w))
  );
}

// Long drafts are cut down in messages so the problem list stays readable.
function clip(text) {
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function similarity(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const total = a.size + b.size - shared;
  return total === 0 ? 1 : shared / total;
}

// Copies the newest side panel export from ~/Downloads into drafts/used/.
// The archive only ever grows, so the newest export contains every older one.
function pullArchive() {
  const downloads = path.join(os.homedir(), "Downloads");
  const exports = fs.existsSync(downloads)
    ? fs
        .readdirSync(downloads)
        .filter((f) => f.startsWith(EXPORT_PREFIX) && f.endsWith(".json"))
        .map((f) => ({ f, mtime: fs.statSync(path.join(downloads, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  if (exports.length === 0) {
    console.log(`No archive export found in ${downloads}. Click "Export archive" in the side panel first.`);
    return;
  }
  const newest = exports[0];
  // Chrome names repeat downloads "name (1).json"; store by date only.
  const target = newest.f.replace(/ \(\d+\)(?=\.json$)/, "");
  fs.mkdirSync(usedDir, { recursive: true });
  fs.copyFileSync(path.join(downloads, newest.f), path.join(usedDir, target));
  const age = Math.round((Date.now() - newest.mtime) / 3600e3);
  console.log(`Copied ${newest.f} (exported ${age}h ago) to drafts/used/${target}`);
}

function readUsed() {
  const used = [];
  if (!fs.existsSync(usedDir)) return used;
  for (const file of fs.readdirSync(usedDir).filter((f) => f.endsWith(".json"))) {
    for (const item of JSON.parse(fs.readFileSync(path.join(usedDir, file), "utf8"))) {
      if (item && typeof item.text === "string") used.push({ project: String(item.project || ""), text: item.text });
    }
  }
  return used;
}

function readProjects() {
  const projects = [];
  for (const file of fs.readdirSync(draftsDir).filter((f) => f.endsWith(".txt")).sort()) {
    const lines = fs
      .readFileSync(path.join(draftsDir, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const header = lines.shift() || "";
    projects.push({ file, header, name: header.startsWith("# ") ? header.slice(2).trim() : null, lines });
  }
  return projects;
}

if (args.has("--pull-archive")) pullArchive();

const used = readUsed();
const usedKeys = new Set(used.map((u) => normalize(u.text)));
const projects = readProjects();

if (args.has("--status")) {
  console.log(`Refill below ${REFILL_BELOW} unused drafts per project, up to ${TARGET}. Already posted (from drafts/used): ${used.length}`);
  const usedFiles = fs.existsSync(usedDir) ? fs.readdirSync(usedDir).filter((f) => f.endsWith(".json")) : [];
  if (usedFiles.length === 0) console.log("No used-drafts files yet in drafts/used/.");
  for (const f of usedFiles) {
    const hours = (Date.now() - fs.statSync(path.join(usedDir, f)).mtimeMs) / 3600e3;
    console.log(`  drafts/used/${f}: updated ${hours < 1 ? "less than an hour" : `${Math.round(hours)}h`} ago`);
  }
  console.log("");
  for (const p of projects) {
    if (!p.name) {
      console.log(`${p.file}: missing "# Project name" header`);
      continue;
    }
    const posted = p.lines.filter((l) => usedKeys.has(normalize(l))).length;
    const unused = p.lines.length - posted;
    // "needs N" only below the refill line; between it and the target a project is "ok".
    const needed = unused < REFILL_BELOW ? TARGET - unused : 0;
    const label = needed ? `needs ${needed}` : unused >= TARGET ? "full" : "ok";
    const open = p.lines.filter((l) => !usedKeys.has(normalize(l)));
    const long = pct(open.filter((l) => l.length > SHORT_LENGTH).length, open.length);
    const emoji = pct(open.filter((l) => emojiCount(l) > 0).length, open.length);
    console.log(`${p.name.padEnd(22)} ${String(unused).padStart(3)} unused  ${String(posted).padStart(3)} posted  ${label.padEnd(10)} long ${long.padStart(4)}  emoji ${emoji.padStart(4)}   drafts/${p.file}`);
  }
  process.exit(0);
}

const drafts = [];
const problems = [];
const warnings = [];
const seen = new Map();
const summary = [];

for (const p of projects) {
  if (!p.name) {
    problems.push(`${p.file}: first line must be "# Project name"`);
    continue;
  }
  const ignore = words(p.name, new Set());
  const projectWords = [];
  const usedWords = used
    .filter((u) => u.project.toLowerCase() === p.name.toLowerCase())
    .map((u) => ({ text: u.text, words: words(u.text, ignore) }));
  let unused = 0;
  let withEmoji = 0;

  for (const text of p.lines) {
    const key = normalize(text);
    if (seen.has(key)) {
      problems.push(`${p.name}: exact duplicate (also in ${seen.get(key)}): ${clip(text)}`);
    }
    seen.set(key, p.name);

    // Already posted: keep as history in the text file, leave out of the JSON.
    if (usedKeys.has(key)) continue;

    if (text.length > MAX_LENGTH) {
      problems.push(`${p.name}: over ${MAX_LENGTH} characters: ${clip(text)}`);
    }
    const emojis = emojiCount(text);
    if (emojis > MAX_EMOJIS) problems.push(`${p.name}: ${emojis} emojis (max ${MAX_EMOJIS}): ${clip(text)}`);
    if (emojis > 0) withEmoji += 1;
    const own = words(text, ignore);
    for (const old of usedWords) {
      if (similarity(own, old.words) > SIMILARITY_LIMIT) {
        problems.push(`${p.name}: too similar to an already posted draft:\n    ${clip(old.text)}\n    ${clip(text)}`);
      }
    }
    for (const other of projectWords) {
      if (similarity(own, other.words) > SIMILARITY_LIMIT) {
        problems.push(`${p.name}: too similar:\n    ${clip(other.text)}\n    ${clip(text)}`);
      }
    }
    projectWords.push({ text, words: own });

    drafts.push({ project: p.name, text });
    unused += 1;
  }
  summary.push(`  ${p.name}: ${unused} unused` + (unused < REFILL_BELOW ? ` (needs ${TARGET - unused})` : ""));
  if (withEmoji > unused * EMOJI_SHARE) {
    warnings.push(`${p.name}: ${withEmoji} of ${unused} drafts have emojis; the rules allow at most a third.`);
  }
}

if (problems.length) {
  console.error(`Not written. ${problems.length} problem(s):\n`);
  for (const p of problems) console.error("- " + p);
  process.exit(1);
}

fs.writeFileSync(outPath, JSON.stringify(drafts, null, 2) + "\n");
console.log(`Wrote ${drafts.length} drafts to ${outPath}` + (used.length ? ` (skipped ${used.length} already posted)` : ""));
for (const line of summary) console.log(line);
for (const w of warnings) console.log(`Warning: ${w}`);
