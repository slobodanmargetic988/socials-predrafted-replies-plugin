---
name: replenish-drafts
description: Top up the Reply Drafts Chrome extension so no project drops below 200 unused reply drafts (it refills them to 250), following the user's drafting rules. Use when asked to replenish, refill, top up or write more reply drafts, to add drafts for a new project, or to check how many drafts are left.
---

# Replenish reply drafts

The Reply Drafts extension pastes pre-written replies into X and Facebook reply boxes. Drafts are plain text files in `drafts/`, built into `extension/drafts.json`, which the extension re-reads automatically. Your job: when a project drops below 200 unused drafts, bring it back up to 250, without breaking any of the user's rules. Projects at 200 or more are left alone.

Run everything from the project root (the folder that contains `make-drafts.js`).

## 1. Read the rules, facts and voice first

Read these in full before writing a single draft, every time. They change.

- `extension/DRAFTING-RULES.md`: the user's DOs and DON'Ts, which they edit in the side panel. Follow them exactly. If a rule here conflicts with this skill or with the voice file, the rules file wins.
- `drafts/projects.md`: what each project is. Only claim facts written there or on the project's own site or repo.

If `drafts/projects.md` still describes the example projects (My App, Side Project) with placeholder links like example.com or `your-name`, stop and ask the user about their real projects first. Then replace the examples in `drafts/projects.md` and `drafts/`.
- `drafts/voice.md` (if it exists): replies the user wrote by hand, plus measured stats on their style. Drafts must sound like these. Match their tone, casing, punctuation, slang and humour; the "Measured style" section gives the numbers to aim for. Length and emoji use are the exception: they come from the rules file, because the user's own replies are mostly short. Use the replies for style only: they answer other people's conversations, so never copy their wording, topics or facts. Don't add deliberate misspellings.

## 2. Find out what's been used

The extension records every draft the user posts. With the project folder connected in the side panel's Settings, it writes them to `drafts/used/used-from-extension.json` whenever the side panel is open.

```bash
node make-drafts.js --pull-archive --status
```

This lists the files in `drafts/used/` with their age, then shows how many drafts each project has unused. Below 200 it says "needs N", the number to get back to 250. From 200 to 249 it says "ok", and at 250 or more "full"; leave both alone. (`--pull-archive` also picks up a manual export from `~/Downloads`, if there is one.)

If `drafts/used/` is empty or its newest file is more than a day old, ask the user to open the Reply Drafts side panel, which updates the file if the folder is connected. Otherwise ask them to connect the project folder under Settings, or use **Export used drafts**. Then run the command again. Without fresh data you can't tell which drafts were posted. Say so instead of guessing.

**Running unattended** (a scheduled run with no one to answer): don't ask anything, and add **at most 50 drafts per project per run**, even if it needs more; the next runs fill the rest. Smaller batches keep drafts varied. If no project says "needs", stop right there and report that nothing was needed. If the used-drafts data is stale, carry on with what's there and mention it in the report: stale data can only make you write too few drafts, never repeat a posted one, because the extension never offers a used draft again.

## 3. Write the missing drafts

For each project that "needs" drafts:

1. Read its whole text file in `drafts/`, including lines already posted. Every line is something the new drafts must not repeat or closely reword.
2. Check the project's `long` and `emoji` shares in the status output against the rules file (at the time of writing: about half the drafts over 280 characters, emojis in at most a third, never more than 2 in a draft). Write the new batch so the whole project moves toward that mix. If a project is 0% long, most of the new drafts should be long posts. Long posts are where the variety comes from: combine different facts from `drafts/projects.md`, take a different angle, but still one line each and nothing invented.
3. Append exactly the number of new drafts it needs, one per line, at the end of the file. Don't edit or delete existing lines: posted ones are history, and the builder skips them on its own.

A new project gets a new file, `drafts/<slug>.txt`, whose first line is `# Project Name`. Add its facts to `drafts/projects.md` too. Only do this when the user asks for a new project.

**Restyling** (only when the user asks to rewrite or restyle existing drafts, never in an unattended run): replace every line that isn't already posted with a new draft, keeping the count the same. Keep posted lines exactly as they are; `node make-drafts.js --status` counts them as "posted", and they're the lines that match the files in `drafts/used/`. The new drafts must not repeat or closely reword the posted lines.

## 4. Build and check

```bash
node make-drafts.js
```

The builder refuses to write the JSON if a draft is an exact duplicate, over 8,000 characters, has more than 2 emojis, or is too similar to another draft or to an already posted one. It lists each problem. Rewrite the flagged lines (don't just tweak a word) and run it again until it writes the file. If it warns that too many of a project's drafts have emojis, remove emojis from some of the ones you wrote.

Then confirm with:

```bash
node make-drafts.js --status
```

No project should say "needs" any more (or, in an unattended run, each one should have gone up by the batch you added), with `long` and `emoji` moving toward the rules. Before finishing, also check your new drafts against the DON'T list in the rules file yourself. The builder can't check facts, hype words or hashtags.

## 5. Tell the user

Report how many drafts you added per project. Tell them nothing needs importing or reloading: the extension re-reads `extension/drafts.json` when the side panel opens, when they click into a reply box, every 5 minutes, and when Chrome starts. The sync button at the top of the side panel forces it.
