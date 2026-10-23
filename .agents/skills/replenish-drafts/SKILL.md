---
name: replenish-drafts
description: Top up the Reply Drafts Chrome extension so every project has 50 unused reply drafts, following the user's drafting rules. Use when asked to replenish, refill, top up or write more reply drafts, to add drafts for a new project, or to check how many drafts are left.
---

# Replenish reply drafts

The Reply Drafts extension pastes pre-written replies into X and Facebook reply boxes. Drafts are plain text files in `drafts/`, built into `extension/drafts.json`, which the extension re-reads automatically. Your job: bring every project back up to 50 unused drafts without breaking any of the user's rules.

Run everything from the project root (the folder that contains `make-drafts.js`).

## 1. Read the rules and facts first

Read both files in full before writing a single draft, every time. They change.

- `extension/DRAFTING-RULES.md`: the user's DOs and DON'Ts, which they edit in the side panel. Follow them exactly. If a rule here conflicts with this skill, the rules file wins.
- `drafts/projects.md`: what each project is. Only claim facts written there or on the project's own site or repo.

If `drafts/projects.md` still describes the example projects (My App, Side Project) with placeholder links like example.com or `your-name`, stop and ask the user about their real projects first. Then replace the examples in `drafts/projects.md` and `drafts/`.

## 2. Find out what's been used

The extension records every draft the user posts. With the project folder connected in the side panel's Settings, it writes them to `drafts/used/used-from-extension.json` whenever the side panel is open.

```bash
node make-drafts.js --pull-archive --status
```

This lists the files in `drafts/used/` with their age, then shows how many drafts each project has unused and how many it needs to reach 50. (`--pull-archive` also picks up a manual export from `~/Downloads`, if there is one.)

If `drafts/used/` is empty or its newest file is more than a day old, ask the user to open the Reply Drafts side panel, which updates the file if the folder is connected. Otherwise ask them to connect the project folder under Settings, or use **Export used drafts**. Then run the command again. Without fresh data you can't tell which drafts were posted. Say so instead of guessing.

## 3. Write the missing drafts

For each project that "needs" drafts:

1. Read its whole text file in `drafts/`, including lines already posted. Every line is something the new drafts must not repeat or closely reword.
2. Append exactly the number of new drafts it needs, one per line, at the end of the file. Don't edit or delete existing lines: posted ones are history, and the builder skips them on its own.

A new project gets a new file, `drafts/<slug>.txt`, whose first line is `# Project Name`. Add its facts to `drafts/projects.md` too. Only do this when the user asks for a new project.

## 4. Build and check

```bash
node make-drafts.js
```

The builder refuses to write the JSON if a draft is an exact duplicate, over 8,000 characters, or too similar to another draft or to an already posted one. It lists each problem. Rewrite the flagged lines (don't just tweak a word) and run it again until it writes the file. If it warns that too many of a project's drafts are over 280 characters, shorten some of the ones you wrote: the rules file says how long drafts should be.

Then confirm with:

```bash
node make-drafts.js --status
```

Every project should say "full". Before finishing, also check your new drafts against the DON'T list in the rules file yourself. The builder can't check facts, hype words, hashtags or emoji counts.

## 5. Tell the user

Report how many drafts you added per project. Tell them nothing needs importing or reloading: the extension re-reads `extension/drafts.json` when the side panel opens, when they click into a reply box, every 5 minutes, and when Chrome starts. The sync button at the top of the side panel forces it.
