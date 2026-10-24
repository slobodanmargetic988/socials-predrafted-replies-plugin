// Runs on x.com. Keeps lists of your followers and the people you follow, built only from
// what's on screen: as you scroll your own /followers and /following pages it reads each
// person shown, and any people list that shows "Follows you" or a Follow/Following button
// keeps the lists corrected. Next to every post author it shows how you're connected.
// It only reads the page: it never scrolls, clicks, follows or navigates.
(() => {
  if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) return;

  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const SCAN_DELAY_MS = 250;
  const SAVE_DELAY_MS = 1500;
  const BADGES = {
    mutual: { icon: "🤝", text: "Mutual: you follow each other" },
    following: { icon: "🔭", text: "You follow them; they don't follow you" },
    follower: { icon: "👋", text: "They follow you; you don't follow back" },
    new: { icon: "🎯", text: "Not in your network yet: someone new to connect with" },
  };

  let network = null; // from XStore.loadNetwork()
  let showBadges = true;
  let dead = false;
  let observer = null;
  // Changes seen on screen, saved in one go a moment later.
  let pending = { followers: {}, following: {}, notFollowing: new Set(), totals: null, me: null };
  let saveTimer = null;

  function alive() {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch {
      // The extension was reloaded; this tab needs a refresh.
    }
    dead = true;
    if (observer) observer.disconnect();
    document.querySelectorAll(".rd-rel").forEach((b) => b.remove());
    return false;
  }

  // { handle (lowercase), name } from a post's User-Name block or a UserCell: the link whose
  // text is "@handle", and the link to the same profile that shows the display name.
  function userFrom(container) {
    const links = [...container.querySelectorAll('a[href^="/"]')];
    const handleLink = links.find((a) => a.innerText.trim().startsWith("@") && HANDLE.test(a.getAttribute("href").slice(1)));
    if (!handleLink) return null;
    const href = handleLink.getAttribute("href");
    const nameLink = links.find((a) => a.getAttribute("href") === href && a.innerText.trim() && !a.innerText.trim().startsWith("@"));
    const handle = href.slice(1);
    return { handle: handle.toLowerCase(), name: nameLink ? nameLink.innerText.trim().split("\n")[0] : handle };
  }

  // Your handle, from X's Profile link in the side navigation.
  function detectMe() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const handle = link && link.getAttribute("href").slice(1);
    return handle && HANDLE.test(handle) ? handle.toLowerCase() : network.me;
  }

  // "followers" or "following" when this is one of your own lists, else null.
  function listPage(me) {
    const m = location.pathname.toLowerCase().match(/^\/([a-z0-9_]{1,15})\/(followers|verified_followers|following)\/?$/);
    if (!m || m[1] !== me) return null;
    return m[2] === "following" ? "following" : "followers";
  }

  function parseCount(text) {
    const m = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KM])?/i);
    if (!m) return null;
    const n = parseFloat(m[1]) * (m[2] ? (m[2].toUpperCase() === "K" ? 1e3 : 1e6) : 1);
    return Math.round(n);
  }

  // On your own profile page, the follower and following counts under your name.
  function scanTotals(me) {
    if (location.pathname.toLowerCase().replace(/\/$/, "") !== `/${me}`) return;
    const totals = {};
    for (const a of document.querySelectorAll('[data-testid="primaryColumn"] a[href]')) {
      const href = a.getAttribute("href").toLowerCase();
      const count = /\d/.test(a.innerText) ? parseCount(a.innerText) : null;
      if (count === null) continue;
      if (href === `/${me}/following`) totals.following = count;
      if (href === `/${me}/followers` || href === `/${me}/verified_followers`) totals.followers = count;
    }
    if (Object.keys(totals).length && JSON.stringify({ ...network.totals, ...totals }) !== JSON.stringify(network.totals)) {
      pending.totals = { ...(pending.totals || {}), ...totals };
    }
  }

  // People cards in the main column (not the "Who to follow" sidebar).
  function scanPeople(me) {
    const page = listPage(me);
    for (const cell of document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]')) {
      const user = userFrom(cell);
      if (!user || user.handle === me) continue;
      const { handle, name } = user;
      if (page === "followers") pending.followers[handle] = name;
      if (page === "following") pending.following[handle] = name;
      if (cell.querySelector('[data-testid="userFollowIndicator"]')) pending.followers[handle] = name;
      // The card's button says whether you follow them right now, wherever the card is.
      const button = cell.querySelector('button[data-testid$="-unfollow"], button[data-testid$="-follow"]');
      if (button) {
        if (button.getAttribute("data-testid").endsWith("-unfollow")) {
          pending.following[handle] = name;
          pending.notFollowing.delete(handle);
        } else {
          delete pending.following[handle];
          pending.notFollowing.add(handle);
        }
      }
    }
    // Drop what the stored lists already say, so nothing is written for no reason.
    for (const list of ["followers", "following"]) {
      for (const handle of Object.keys(pending[list])) {
        if (network[list][handle] === pending[list][handle]) delete pending[list][handle];
      }
    }
    for (const handle of [...pending.notFollowing]) if (!(handle in network.following)) pending.notFollowing.delete(handle);
  }

  function hasPending() {
    return (
      pending.me ||
      pending.totals ||
      Object.keys(pending.followers).length ||
      Object.keys(pending.following).length ||
      pending.notFollowing.size
    );
  }

  function scheduleSave() {
    if (!hasPending() || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const changes = { ...pending, notFollowing: [...pending.notFollowing] };
      pending = { followers: {}, following: {}, notFollowing: new Set(), totals: null, me: null };
      if (!alive()) return;
      try {
        network = await XStore.mergeNetwork(changes);
      } catch {
        alive();
      }
    }, SAVE_DELAY_MS);
  }

  function completeness() {
    const t = network.totals || {};
    const seen = (list) => Object.keys(network[list]).length;
    const part = (list) => (t[list] ? `${seen(list)} of ${t[list]} ${list}` : `${seen(list)} ${list}`);
    return ` (lists so far: ${part("followers")}, ${part("following")}. Scroll your followers and following pages to fill them.)`;
  }

  // A badge after the author's name on every post, including quoted posts.
  function renderBadges(me) {
    const names = document.querySelectorAll('article [data-testid="User-Name"]');
    if (!showBadges || !me) {
      document.querySelectorAll(".rd-rel").forEach((b) => b.remove());
      return;
    }
    const note = completeness();
    for (const nameEl of names) {
      const user = userFrom(nameEl);
      if (!user || user.handle === me) continue;
      const rel = XStore.relation(network, user.handle);
      let badge = nameEl.querySelector(":scope > .rd-rel");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "rd-rel";
        nameEl.appendChild(badge);
      }
      if (badge.dataset.rel !== rel) {
        badge.dataset.rel = rel;
        badge.textContent = BADGES[rel].icon;
      }
      const title = `@${user.handle}: ${BADGES[rel].text}${note}`;
      if (badge.title !== title) badge.title = title;
    }
  }

  function scan() {
    if (!alive() || !network) return;
    const me = detectMe();
    if (me && me !== network.me) {
      network.me = me;
      pending.me = me;
    }
    if (me) {
      scanTotals(me);
      scanPeople(me);
    }
    scheduleSave();
    renderBadges(me);
  }

  async function refresh() {
    try {
      network = await XStore.loadNetwork();
      showBadges = (await XStore.loadSettings()).networkBadges !== false;
    } catch {
      alive();
      return;
    }
    scan();
  }

  let scheduled = false;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scan();
    }, SCAN_DELAY_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[XStore.NETWORK_KEY] || changes[XStore.SETTINGS_KEY]) && alive()) refresh();
  });

  refresh();
})();
