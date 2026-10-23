# Socials Pre-drafted Replies

A local-only Chrome extension for answering "What are you working on?" posts on X and Facebook. You keep a pool of pre-written replies per project. When you click into a reply box, a small bar of buttons appears, one per project you picked for today. Click one and the next unused draft for that project is pasted into the box. You review it and press Send yourself.

Every draft is used once. Used drafts are recorded and never offered again, because X penalizes duplicate posting.

**What it doesn't do:** it never clicks the site's buttons, never sends, never navigates, and never moves the mouse. It only inserts text into the reply box you're already in, when you click one of its buttons. Nothing is sent anywhere; all data stays in your Chrome profile and this folder.

## Install

1. Clone this repo.
2. Build the drafts file: `node make-drafts.js` (Node 18+, no dependencies).
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension` folder.
4. Click the extension's toolbar icon to open the side panel.
5. Under **Settings → Project folder**, click **Connect** and choose this repo's folder (the one with `make-drafts.js`). Chrome asks once whether the extension may edit files there; allow it. This lets the side panel save your rules and record used drafts.

## Use

1. In the side panel, switch on up to 5 projects. They show under **Today**.
2. On X or Facebook, click into a reply box. The buttons appear above or below it, each with the number of drafts left.
3. Click a button. The draft is pasted and recorded as used. Review it and press Send.
4. A button greys out when its project has no drafts left.

After changing the extension's code, click the reload arrow on its card in `chrome://extensions`, then reload your X and Facebook tabs.

## Make it yours

The repo comes with three example projects. Replace them with your own:

- **`drafts/projects.md`**: the facts about each project that drafts may claim. One heading per project.
- **`drafts/<project>.txt`**: one file per project. The first line is `# Project Name`, then one draft per line.
- **`extension/DRAFTING-RULES.md`**: your DOs and DON'Ts for every draft. You can also edit these in the side panel's **Drafting rules** card, which saves automatically.
- **`ICONS` in `extension/store.js`**: an icon and color per project, matched by lowercase project name. Projects without an entry get a generic icon.

Then rebuild:

```bash
node make-drafts.js
```

It writes `extension/drafts.json`, which the extension reads by itself: when the side panel opens, when you click into a reply box, every 5 minutes, when Chrome starts, and when you click the sync button in the side panel header. No import or reload needed.

The builder refuses to write the file if a draft is an exact duplicate, over 8,000 characters (Facebook's comment limit), too similar to another draft in the same project, or too similar to one you've already posted. It warns when more than half of a project's drafts are over 280 characters.

```bash
node make-drafts.js --status         # unused drafts per project, and how many each needs to reach 50
node make-drafts.js --pull-archive   # also pick up a manual "Export used drafts" file from ~/Downloads
```

## Writing drafts with Claude Code or Codex

The `replenish-drafts` skill does the whole loop. It reads your rules and project facts, works out which projects have fewer than 50 unused drafts, writes the missing ones, and rebuilds until the checks pass.

- **Codex** loads it from `.agents/skills/replenish-drafts/`.
- **Claude Code** loads it from `.claude/skills/replenish-drafts/`, a link to the same folder.

Start either tool in this folder and ask it to replenish the drafts. Open the side panel first so the used-drafts list in `drafts/used/` is current.

## How it fits together

| Path | What it is |
| --- | --- |
| `extension/` | The Chrome extension (Manifest V3, no build step) |
| `extension/content.js` | Finds reply boxes on X and Facebook and shows the buttons |
| `extension/store.js` | Storage, drafts file sync, icons |
| `extension/sidepanel.*` | The side panel |
| `extension/DRAFTING-RULES.md` | Your DOs and DON'Ts |
| `drafts/` | Draft text files and project facts |
| `drafts/used/` | Drafts you've posted, written by the side panel (not committed) |
| `make-drafts.js` | Builds `extension/drafts.json` and checks the drafts |
| `make-icons.js` | Draws the toolbar icon PNGs |
| `.agents/skills/`, `.claude/skills/` | The `replenish-drafts` skill |

If the buttons stop appearing after a site update, the reply box detection is `findReplyBox` in `extension/content.js`.

## License

MIT
