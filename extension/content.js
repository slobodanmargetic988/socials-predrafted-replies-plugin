// Runs on x.com and facebook.com. It only reacts to focus in a reply box and to clicks
// on our own circles. It never clicks the site's buttons, never sends, and never navigates.
(() => {
  const BAR_ID = "reply-drafts-bar";
  const SHOW_DELAY_MS = 150;

  let activeBox = null;
  let hideTimer = null;
  let busy = false;
  let bar = null;
  let dead = false;

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

    for (const project of projects) {
      const remaining = counts[project.id] ? counts[project.id].active : 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rd-circle" + (remaining === 0 ? " rd-empty" : "");
      btn.style.background = XStore.iconFor(project.name).color;
      btn.appendChild(XStore.createIcon(project.name, 18));
      const badge = document.createElement("span");
      badge.className = "rd-badge";
      badge.textContent = String(remaining);
      btn.appendChild(badge);
      btn.title = `${project.name} (${remaining} left)`;
      btn.dataset.projectId = project.id;
      btn.addEventListener("click", () => onCircleClick(project));
      bar.appendChild(btn);
    }

    bar.style.display = "flex";
    positionBar(activeBox);
  });

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

  const onCircleClick = safely(async (project) => {
    if (!alive() || busy || !activeBox || !activeBox.isConnected) return;
    busy = true;
    try {
      const state = await XStore.load();
      const draft = XStore.nextActiveDraft(state, project.id);
      if (!draft) {
        flashTitle(project, "No drafts left for this project. Import more.");
        return;
      }
      const inserted = insertText(activeBox, draft.text);
      if (!inserted) {
        await navigator.clipboard.writeText(draft.text).catch(() => {});
        flashTitle(project, "Could not insert. Copied instead; draft kept.");
        return;
      }
      XStore.archiveDraft(state, project.id, draft);
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
      setTimeout(renderBar, SHOW_DELAY_MS);
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
})();
