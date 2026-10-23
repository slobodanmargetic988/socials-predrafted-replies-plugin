// Runs on x.com and facebook.com. It only reacts to focus in a reply box and to clicks
// on our own circles. It never clicks the site's buttons, never sends, and never navigates.
// On X it also reads the text of the post being replied to, so the background can ask
// SubQ which drafts fit it best.
(() => {
  const BAR_ID = "reply-drafts-bar";
  const SHOW_DELAY_MS = 150;

  let activeBox = null;
  let hideTimer = null;
  let busy = false;
  let bar = null;
  let dead = false;
  // The reply box the last draft went into; a click there again replaces instead of adding.
  let lastInsertBox = null;
  // SubQ rankings by post text, so reopening a post doesn't ask again:
  // { postText, status: "loading" | "ready" | "error" | "off",
  //   best: Map(text -> position), byProject: Map(lowercase project name -> Map(text -> position)),
  //   failed: [names that couldn't be ranked], error }
  const rankings = new Map();
  const MAX_RANKINGS = 30;
  // Stands in for a project when the "Best match" button is clicked.
  const BEST = { id: "best", name: "Best match" };
  const BEST_COLOR = "#e5a000";

  // After the extension is reloaded or updated, scripts already running in open tabs lose
  // access to it ("Extension context invalidated"). When that happens, remove the bar and
  // stay quiet until the tab is refreshed, which loads the new script.
  function alive() {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch {
      // Accessing chrome.runtime can itself throw once the context is gone.
    }
    dead = true;
    if (bar) bar.remove();
    bar = null;
    activeBox = null;
    return false;
  }

  // Runs an async step; errors are logged unless they come from a reloaded extension.
  function safely(fn) {
    return (...args) =>
      fn(...args).catch((err) => {
        if (alive()) console.error("Reply Drafts:", err);
      });
  }

  // Reply boxes on X (Draft.js) and Facebook (Lexical) are contenteditable textboxes.
  function findReplyBox(el) {
    if (!(el instanceof Element)) return null;
    const editable = el.closest('[contenteditable="true"]');
    if (!editable) return null;
    const isReplyBox =
      editable.closest('[data-testid^="tweetTextarea"]') ||
      editable.hasAttribute("data-lexical-editor") ||
      editable.getAttribute("role") === "textbox";
    return isReplyBox ? editable : null;
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = BAR_ID;
    // Keep focus in the reply box when a circle is pressed.
    bar.addEventListener("mousedown", (e) => e.preventDefault());
    document.documentElement.appendChild(bar);
    return bar;
  }

  function hideBar() {
    if (bar) bar.style.display = "none";
  }

  function positionBar(box) {
    const rect = box.getBoundingClientRect();
    const barHeight = 44;
    const above = rect.top > barHeight + 8;
    bar.style.top = (above ? rect.top - barHeight - 4 : rect.bottom + 4) + "px";
    bar.style.left = Math.max(8, rect.left) + "px";
  }

  const renderBar = safely(async () => {
    if (!alive()) return;
    if (!activeBox || !activeBox.isConnected) {
      hideBar();
      return;
    }
    const state = await XStore.load();
    const counts = XStore.counts(state);
    const projects = state.todayIds
      .map((id) => state.projects.find((p) => p.id === id))
      .filter(Boolean);

    ensureBar();
    bar.replaceChildren();

    if (projects.length === 0) {
      const hint = document.createElement("span");
      hint.className = "rd-hint";
      hint.textContent = "Pick today's projects in the Reply Drafts side panel.";
      bar.appendChild(hint);
    }

    const entry = currentRanking();
    const rankingHere = entry && entry.status !== "off" ? entry : null;
    const ranked = rankingHere && rankingHere.status === "ready" ? rankingHere : null;

    if (rankingHere && projects.length > 0) {
      const total = projects.reduce((sum, p) => sum + (counts[p.id] ? counts[p.id].active : 0), 0);
      const badgeText = { loading: "…", error: "!", ready: String(total) }[rankingHere.status];
      const post = rankingHere.postText.length > 140 ? `${rankingHere.postText.slice(0, 140)}…` : rankingHere.postText;
      const partly = ranked && ranked.failed.length ? ` Not ranked (normal order): ${ranked.failed.join(", ")}. ${ranked.error || ""}` : "";
      const title = {
        loading: `Ranking drafts with SubQ for: "${post}" (clicking now uses the normal order)`,
        error: `Couldn't rank: ${rankingHere.error} Clicking uses the normal order.`,
        ready: `Best match for: "${post}". Click again for the next best.${partly}`,
      }[rankingHere.status];
      bar.appendChild(circleButton(BEST, BEST_COLOR, badgeText, title, total === 0, rankingHere.status));
    }

    for (const project of projects) {
      const remaining = counts[project.id] ? counts[project.id].active : 0;
      const projectRanked = ranked && ranked.byProject.has(project.name.toLowerCase()) && !ranked.failed.includes(project.name);
      const title = `${project.name} (${remaining} left${projectRanked ? ", best match for this post first" : ""})`;
      bar.appendChild(circleButton(project, XStore.iconFor(project.name).color, String(remaining), title, remaining === 0));
    }

    bar.style.display = "flex";
    positionBar(activeBox);
  });

  function circleButton(target, color, badgeText, title, empty, status) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rd-circle" + (empty ? " rd-empty" : "") + (target === BEST ? " rd-best" : "") + (status === "loading" ? " rd-loading" : "");
    btn.style.background = color;
    btn.appendChild(XStore.createIcon(target === BEST ? "best match" : target.name, 18));
    const badge = document.createElement("span");
    badge.className = "rd-badge";
    badge.textContent = badgeText;
    btn.appendChild(badge);
    btn.title = title;
    btn.dataset.projectId = target.id;
    btn.addEventListener("click", () => onCircleClick(target));
    return btn;
  }

  // ---- Ranking with SubQ (X only) ----

  // The text of the post being replied to: the last post above the reply box, inside the
  // reply pop-up when there is one. In the pop-up that's its one <article data-testid="tweet">,
  // whose [data-testid="tweetText"] holds the post as a few spans (text, bold words, emoji);
  // innerText joins them as shown. Read from the page only; nothing is clicked.
  function postTextFor(box) {
    if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return "";
    const scope = box.closest('[role="dialog"]') || document;
    const before = [...scope.querySelectorAll('[data-testid="tweetText"]')].filter(
      (el) => el.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    const post = before[before.length - 1];
    return post ? post.innerText.replace(/\s+/g, " ").trim() : "";
  }

  const toPositions = (texts) => new Map(texts.map((text, i) => [XStore.normalize(text), i]));

  // Asks the background to rank today's drafts for a post, once per post. A failed or
  // switched-off ranking is tried again the next time the post is opened.
  function startRanking(postText) {
    if (!postText) return;
    const known = rankings.get(postText);
    if (known && (known.status === "loading" || known.status === "ready")) return;
    const entry = { postText, status: "loading" };
    rankings.delete(postText);
    rankings.set(postText, entry);
    if (rankings.size > MAX_RANKINGS) rankings.delete(rankings.keys().next().value);
    let request;
    try {
      request = chrome.runtime.sendMessage({ type: "rankDrafts", postText });
    } catch {
      alive();
      return;
    }
    request
      .then((result) => {
        if (!result || result.off) {
          entry.status = "off";
        } else if (!result.order) {
          entry.status = "error";
          entry.error = result.error;
        } else {
          entry.status = "ready";
          entry.best = toPositions(result.order);
          entry.byProject = new Map(Object.entries(result.projects || {}).map(([name, texts]) => [name.toLowerCase(), toPositions(texts)]));
          entry.failed = result.failed || [];
          entry.error = result.error;
        }
        renderBar();
      })
      .catch(() => alive());
  }

  // The ranking for the post the focused reply box answers, if any.
  function currentRanking() {
    if (!activeBox || !activeBox.isConnected) return null;
    return rankings.get(postTextFor(activeBox)) || null;
  }

  function currentRank() {
    const entry = currentRanking();
    return entry && entry.status === "ready" ? entry : null;
  }

  // Start ranking as soon as a reply pop-up shows its post, before the box is focused,
  // so the ranking is ready by the time the post has been read. Only reads the page.
  function watchForReplyPopups() {
    if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return;
    let scheduled = false;
    const scan = () => {
      scheduled = false;
      if (!alive()) return;
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        const editable = dialog.querySelector('[data-testid^="tweetTextarea"][contenteditable="true"], [data-testid^="tweetTextarea"] [contenteditable="true"]');
        const box = editable && findReplyBox(editable);
        if (box) startRanking(postTextFor(box));
      }
    };
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(scan, 100);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Unused drafts for a project button, or across today's projects for "Best match",
  // in ranked order when there is a ranking (unranked drafts keep their normal order after).
  // The star uses the overall order; a project button uses that project's own ranking.
  function candidatesFor(state, target) {
    const projects = target === BEST ? XStore.todayProjects(state) : [target];
    const list = [];
    for (const project of projects) {
      for (const draft of XStore.poolFor(state, project)) list.push({ ...draft, projectId: project.id });
    }
    const entry = currentRank();
    const rank = entry && (target === BEST ? entry.best : entry.byProject.get(target.name.toLowerCase()));
    if (rank) {
      const position = (d) => {
        const r = rank.get(XStore.normalize(d.text));
        return r === undefined ? Number.MAX_SAFE_INTEGER : r;
      };
      list.sort((a, b) => position(a) - position(b));
    }
    return list;
  }

  // X's reply box is a Draft.js editor.
  function isDraftEditor(box) {
    return box.classList.contains("public-DraftEditor-content") || !!box.closest('[data-testid^="tweetTextarea"]');
  }

  // Puts the caret at the end of the last text node inside the box. Only used when the
  // caret isn't already in the box: a caret on the box element itself makes the browser
  // insert a stray text node the editor doesn't know about (it shows as a ghost copy).
  function ensureCaretInside(box) {
    const sel = window.getSelection();
    if (sel.rangeCount && box.contains(sel.anchorNode)) return;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) last = walker.currentNode;
    if (!last) return;
    const range = document.createRange();
    range.setStart(last, last.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Draft.js handles paste events itself and updates its own state, so nothing is
  // added behind its back. Returns true if the editor took the paste.
  function pasteInto(box, text) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    return event.defaultPrevented;
  }

  // Inserts text where the caret is, the same way typing or pasting would.
  function insertText(box, text) {
    box.focus();
    ensureCaretInside(box);
    if (isDraftEditor(box) && pasteInto(box, text)) return true;
    return document.execCommand("insertText", false, text);
  }

  // Selects everything typed in the box, from the first text node to the last.
  // Returns false when there's no text to select.
  function selectAllText(box) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let first = null;
    let last = null;
    while (walker.nextNode()) {
      first = first || walker.currentNode;
      last = walker.currentNode;
    }
    if (!first) return false;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  // Editors (Draft.js, Lexical) track the selection through "selectionchange", which the
  // browser only sends on a later task. Send it now so they see the select-all before the
  // paste, then give them a moment to apply it.
  function announceSelection() {
    document.dispatchEvent(new Event("selectionchange"));
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Replaces everything in the box with text, the same way selecting all and pasting would.
  async function replaceText(box, text) {
    box.focus();
    if (!selectAllText(box)) return insertText(box, text);
    await announceSelection();
    if (isDraftEditor(box) && pasteInto(box, text)) return true;
    return document.execCommand("insertText", false, text);
  }

  // target is a project, or BEST for the "Best match" button.
  const onCircleClick = safely(async (target) => {
    if (!alive() || busy || !activeBox || !activeBox.isConnected) return;
    busy = true;
    try {
      const state = await XStore.load();
      const draft = candidatesFor(state, target)[0];
      if (!draft) {
        flashTitle(target, "No drafts left. Replenish the drafts file.");
        return;
      }
      // Clicking again while the last draft is still in this box swaps it for the next one.
      // Both count as used.
      const box = activeBox;
      const replacing = lastInsertBox === box && box.innerText.trim() !== "";
      const inserted = replacing ? await replaceText(box, draft.text) : insertText(box, draft.text);
      if (!inserted) {
        await navigator.clipboard.writeText(draft.text).catch(() => {});
        flashTitle(target, "Could not insert. Copied instead; draft kept.");
        return;
      }
      lastInsertBox = box;
      XStore.archiveDraft(state, draft.projectId, draft);
      await XStore.save(state);
    } finally {
      busy = false;
      renderBar();
    }
  });

  function flashTitle(project, message) {
    const btn = bar && bar.querySelector(`[data-project-id="${project.id}"]`);
    if (btn) {
      btn.title = message;
      btn.classList.add("rd-flash");
      setTimeout(() => btn.classList.remove("rd-flash"), 1200);
    }
  }

  // Ask the background to re-read the drafts file, so a freshly rebuilt file is used.
  // The bar re-renders through storage.onChanged if anything changed.
  function requestSync() {
    try {
      chrome.runtime.sendMessage({ type: "syncDrafts" }).catch(() => {});
    } catch {
      alive();
    }
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (!alive()) return;
      const box = findReplyBox(e.target);
      if (!box) return;
      clearTimeout(hideTimer);
      activeBox = box;
      requestSync();
      // Give X a moment to render the post in the reply pop-up, then rank for it.
      setTimeout(() => {
        if (activeBox === box) startRanking(postTextFor(box));
        renderBar();
      }, SHOW_DELAY_MS);
    },
    true
  );

  document.addEventListener(
    "focusout",
    (e) => {
      if (findReplyBox(e.target) !== activeBox) return;
      hideTimer = setTimeout(hideBar, 200);
    },
    true
  );

  window.addEventListener("scroll", () => activeBox && bar && bar.style.display !== "none" && positionBar(activeBox), true);
  window.addEventListener("resize", () => activeBox && bar && bar.style.display !== "none" && positionBar(activeBox));

  chrome.storage.onChanged.addListener((changes, area) => {
    const relevant = changes[XStore.KEY] || changes[XStore.FILE_KEY];
    if (area === "local" && relevant && alive() && bar && bar.style.display !== "none") {
      renderBar();
    }
  });

  watchForReplyPopups();
})();
