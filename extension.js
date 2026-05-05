// Sidebar Wayfinder — replaces Roam's "Shortcuts" sidebar header with a row of icon tabs.
// Each tab swaps the page list shown beneath the header. We don't re-render Roam's own
// shortcuts list; we insert sibling lists next to it and toggle visibility. A
// MutationObserver re-injects after Roam rebuilds the sidebar (e.g. graph switch).

let activeTab = "shortcuts";
let observer = null;
let extensionAPI = null;

// Tab definitions (order matters for display)
// Icons from Blueprint, but have mapping to Feather with Roam Studio
const TABS = [
  { id: "shortcuts", icon: "bp3-icon-star", label: "Shortcuts" },
  { id: "recent", icon: "bp3-icon-time", label: "Recent" },
  { id: "random", icon: "bp3-icon-random", label: "Random" },
  { id: "on-this-day", icon: "bp3-icon-timeline-events", label: "On This Day" },
  { id: "mentions", icon: "bp3-icon-horizontal-bar-chart-desc", label: "Most Mentions" },
  { id: "system", icon: "bp3-icon-asterisk", label: "System" }
];

// --- Settings helpers ---

function getSetting(key, fallback) {
  const val = extensionAPI?.settings.get(key);
  return val === undefined || val === null ? fallback : val;
}

function isTabEnabled(tabId) {
  if (tabId === "shortcuts") return true; // always on
  return getSetting(`show-${tabId}`, true);
}

function getRecentCount() {
  return parseInt(getSetting("recent-count", 10), 10) || 10;
}

function getRandomCount() {
  return parseInt(getSetting("random-count", 10), 10) || 10;
}

function getMentionsCount() {
  return parseInt(getSetting("mentions-count", 10), 10) || 10;
}

// --- DOM helpers ---

function findWrapper() {
  return document.querySelector(".starred-pages-wrapper");
}

function findHeader(wrapper) {
  return wrapper?.querySelector(".flex-h-box.title");
}

function findStarredPages(wrapper) {
  // :scope > avoids matching our injected per-tab lists, which reuse
  // the .starred-pages class so they inherit Roam's built-in styling.
  return wrapper?.querySelector(":scope > .starred-pages");
}

function renderPageList(container, pages) {
  container.innerHTML = "";
  if (!pages || pages.length === 0) {
    container.innerHTML = '<div class="sidebar-tabs-empty">No pages found</div>';
    return;
  }
  const graphName = window.roamAlphaAPI.graph.name;
  pages.forEach(({ title, uid, subtitle }) => {
    const link = document.createElement("a");
    link.href = `/#/app/${graphName}/page/${uid}`;
    link.draggable = false;
    link.style.textDecoration = "none";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.roamAlphaAPI.ui.mainWindow.openPage({ page: { uid } });
    });
    const pageDiv = document.createElement("div");
    pageDiv.draggable = true;
    pageDiv.className = "page";
    pageDiv.textContent = title;
    if (subtitle) {
      const sub = document.createElement("span");
      sub.className = "sidebar-tabs-subtitle";
      sub.textContent = subtitle;
      pageDiv.appendChild(sub);
    }
    link.appendChild(pageDiv);
    container.appendChild(link);
  });
}

// --- Tab data loaders ---

function loadRecent() {
  const count = getRecentCount();

  let results = window.roamAlphaAPI.q(`
    [:find ?title ?uid ?time
     :where
     [?page :node/title ?title]
     [?page :block/uid ?uid]
     [?page :edit/time ?time]]
  `);

  // Older graphs (or pages only ever touched via blocks) may have no :edit/time
  // on the page entity itself — fall back to the max edit-time across its blocks.
  if (!results || results.length === 0) {
    results = window.roamAlphaAPI.q(`
      [:find ?title ?uid (max ?time)
       :where
       [?block :block/page ?page]
       [?block :edit/time ?time]
       [?page :node/title ?title]
       [?page :block/uid ?uid]]
    `);
  }

  if (!results) return [];
  results.sort((a, b) => b[2] - a[2]);
  return results.slice(0, count).map(([title, uid]) => ({ title, uid }));
}

function loadSystem() {
  const results = window.roamAlphaAPI.q(`
    [:find ?title ?uid
     :where
     [?page :node/title ?title]
     [?page :block/uid ?uid]
     (or [(clojure.string/starts-with? ?title "roam/")]
         [(clojure.string/starts-with? ?title "queries/")])]
  `);
  if (!results) return [];
  results.sort((a, b) => a[0].localeCompare(b[0]));
  return results.map(([title, uid]) => ({ title, uid }));
}

// Matches Roam's canonical daily note title format (e.g. "April 24th, 2025").
function isDailyNotePage(title) {
  return /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/.test(title);
}

function isSystemPage(title) {
  return title.startsWith("roam/") || title.startsWith("queries/");
}

// "API Token" pages are credential pages we don't want to surface randomly.
function isApiTokenPage(title) {
  return title.includes("API Token");
}

// Roam display-name pages are titled with a leading "# " by convention.
function isDisplayNamePage(title) {
  return title.startsWith("# ");
}

function loadRandom() {
  const count = getRandomCount();
  const showDaily = getSetting("random-show-daily", true);

  const results = window.roamAlphaAPI.q(`
    [:find ?title ?uid
     :where
     [?page :node/title ?title]
     [?page :block/uid ?uid]]
  `);
  if (!results || results.length === 0) return [];

  // Skip system, credential, and display-name pages — never appropriate for random surfacing.
  let filtered = results.filter(([title]) =>
    !isSystemPage(title) && !isApiTokenPage(title) && !isDisplayNamePage(title)
  );

  // Optionally exclude daily notes (they otherwise dominate randoms in active graphs).
  if (!showDaily) filtered = filtered.filter(([title]) => !isDailyNotePage(title));

  // Fisher-Yates shuffle, take first N
  const shuffled = [...filtered];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count).map(([title, uid]) => ({ title, uid }));
}

// Merges three sources for "today in prior years":
//   1. Daily notes whose title matches today's month/day in any past year
//   2. Pages created on this date in prior years
//   3. Pages edited on this date in prior years
// This year's entries are excluded. Dedup precedence: daily > created > edited.
function loadOnThisDay() {
  const today = new Date();
  const month = today.getMonth(); // 0-indexed
  const day = today.getDate();
  const thisYear = today.getFullYear();

  // Build the daily-note title prefix for today, e.g. "April 24th,"
  const months = ["January","February","March","April","May","June",
    "July","August","September","October","November","December"];
  const monthName = months[month];
  const suffix = (day % 10 === 1 && day !== 11) ? "st"
    : (day % 10 === 2 && day !== 12) ? "nd"
    : (day % 10 === 3 && day !== 13) ? "rd" : "th";
  const dailyNotePattern = `${monthName} ${day}${suffix},`;

  const dailyNotes = window.roamAlphaAPI.q(`
    [:find ?title ?uid
     :where
     [?page :node/title ?title]
     [?page :block/uid ?uid]
     [(clojure.string/starts-with? ?title "${dailyNotePattern}")]]
  `) || [];

  const pastDailyNotes = dailyNotes.filter(([title]) => {
    const yearMatch = title.match(/(\d{4})$/);
    return yearMatch && parseInt(yearMatch[1]) !== thisYear;
  });

  const created = window.roamAlphaAPI.q(`
    [:find ?title ?uid ?time
     :where
     [?page :node/title ?title]
     [?page :block/uid ?uid]
     [?page :create/time ?time]]
  `) || [];

  const createdOnDay = created.filter(([, , time]) => {
    const d = new Date(time);
    return d.getMonth() === month && d.getDate() === day && d.getFullYear() !== thisYear;
  });

  const edited = window.roamAlphaAPI.q(`
    [:find ?title ?uid ?time
     :where
     [?page :node/title ?title]
     [?page :block/uid ?uid]
     [?page :edit/time ?time]]
  `) || [];

  const editedOnDay = edited.filter(([, , time]) => {
    const d = new Date(time);
    return d.getMonth() === month && d.getDate() === day && d.getFullYear() !== thisYear;
  });

  // Dedup by uid; insertion order encodes the daily > created > edited precedence.
  const seen = new Map();

  pastDailyNotes.forEach(([title, uid]) => {
    const yearMatch = title.match(/(\d{4})$/);
    const year = yearMatch ? yearMatch[1] : "";
    seen.set(uid, { title, uid, year: parseInt(year), type: "daily" });
  });

  createdOnDay.forEach(([title, uid, time]) => {
    if (!seen.has(uid)) {
      seen.set(uid, { title, uid, year: new Date(time).getFullYear(), type: "created" });
    }
  });

  editedOnDay.forEach(([title, uid, time]) => {
    if (!seen.has(uid)) {
      seen.set(uid, { title, uid, year: new Date(time).getFullYear(), type: "edited" });
    }
  });

  const results = [...seen.values()];
  results.sort((a, b) => b.year - a.year);

  return results.map(({ title, uid }) => ({ title, uid }));
}

function loadMentions() {
  const count = getMentionsCount();
  // Count backlinks per page
  const results = window.roamAlphaAPI.q(`
    [:find ?title ?uid (count ?ref)
     :where
     [?ref :block/refs ?page]
     [?page :node/title ?title]
     [?page :block/uid ?uid]]
  `);
  if (!results) return [];

  results.sort((a, b) => b[2] - a[2]);
  return results.slice(0, count).map(([title, uid, refs]) => ({
    title,
    uid,
    subtitle: ` (${refs})`,
  }));
}

// No loader for "shortcuts" — Roam manages that list itself.
const TAB_LOADERS = {
  recent: loadRecent,
  system: loadSystem,
  random: loadRandom,
  "on-this-day": loadOnThisDay,
  mentions: loadMentions,
};

// --- Injection and tab state ---

function injectTabs() {
  const wrapper = findWrapper();
  if (!wrapper || wrapper.hasAttribute("data-sidebar-tabs-injected")) return;

  const header = findHeader(wrapper);
  const starredPages = findStarredPages(wrapper);
  if (!header || !starredPages) return;

  // Hide the original header
  header.classList.add("sidebar-tabs-hidden");

  // Create our own tab header
  const tabHeader = document.createElement("div");
  tabHeader.className = "sidebar-tabs-header title";

  TABS.forEach(({ id, icon, label }) => {
    const btn = document.createElement("div");
    btn.className = "sidebar-tab-btn";
    btn.dataset.tab = id;
    btn.addEventListener("click", () => switchTab(id));

    const tooltip = document.createElement("div");
    tooltip.className = "sidebar-tab-tooltip";
    tooltip.textContent = label;
    btn.appendChild(tooltip);

    const iconEl = document.createElement("span");
    iconEl.className = `bp3-icon ${icon} sidebar-tab-icon`;
    iconEl.dataset.tab = id;
    if (id === activeTab) iconEl.classList.add("sidebar-tab-active");
    btn.appendChild(iconEl);
    tabHeader.appendChild(btn);
  });

  header.parentElement.insertBefore(tabHeader, header);

  // Some Roam themes (e.g. Roam Studio) render Blueprint icons via CSS mask images
  // instead of a font glyph. Tag those so the stylesheet can color them correctly.
  requestAnimationFrame(() => {
    tabHeader.querySelectorAll(".sidebar-tab-icon").forEach((icon) => {
      const s = getComputedStyle(icon);
      const mask = s.mask || s.webkitMask;
      if (mask && mask !== "none") {
        icon.classList.add("sidebar-tab-icon-masked");
      }
    });
  });

  // Create list containers for non-shortcut tabs
  let lastInserted = starredPages;
  TABS.forEach(({ id }) => {
    if (id === "shortcuts") return;
    const list = document.createElement("div");
    list.className = `starred-pages ${id}-pages-list sidebar-tabs-hidden`;
    lastInserted.parentElement.insertBefore(list, lastInserted.nextSibling);
    lastInserted = list;
  });

  applyTabState(wrapper);
  wrapper.setAttribute("data-sidebar-tabs-injected", "true");
}

function applyTabState(wrapper) {
  const starredPages = findStarredPages(wrapper);
  if (!starredPages) return;

  // Show/hide tab buttons based on settings
  wrapper.querySelectorAll(".sidebar-tab-btn").forEach((btn) => {
    const tab = btn.dataset.tab;
    if (tab !== "shortcuts") {
      btn.classList.toggle("sidebar-tabs-hidden", !isTabEnabled(tab));
    }
  });

  // Fall back to shortcuts if active tab got disabled
  if (activeTab !== "shortcuts" && !isTabEnabled(activeTab)) {
    activeTab = "shortcuts";
  }

  // Toggle active state on icons and buttons
  wrapper.querySelectorAll(".sidebar-tab-icon").forEach((icon) => {
    const isActive = icon.dataset.tab === activeTab;
    icon.classList.toggle("sidebar-tab-active", isActive);
    icon.closest(".sidebar-tab-btn")?.classList.toggle("sidebar-tab-btn-active", isActive);
  });

  // Show/hide lists
  starredPages.classList.toggle("sidebar-tabs-hidden", activeTab !== "shortcuts");
  TABS.forEach(({ id }) => {
    if (id === "shortcuts") return;
    const list = wrapper.querySelector(`.${id}-pages-list`);
    if (list) list.classList.toggle("sidebar-tabs-hidden", id !== activeTab);
  });
}

function switchTab(tabId) {
  if (tabId !== "shortcuts" && !isTabEnabled(tabId)) return;
  // Random reshuffles on re-click; other tabs no-op when already active.
  if (tabId === activeTab && tabId !== "random") return;
  activeTab = tabId;

  const wrapper = findWrapper();
  if (!wrapper) return;

  applyTabState(wrapper);

  const loader = TAB_LOADERS[tabId];
  if (loader) {
    const list = wrapper.querySelector(`.${tabId}-pages-list`);
    if (list) renderPageList(list, loader());
  }
}

function refreshTabVisibility() {
  const wrapper = findWrapper();
  if (wrapper) applyTabState(wrapper);
}

// --- Observer: re-inject when Roam rebuilds the sidebar ---
// Roam can wipe and re-render the sidebar on graph switch, sidebar collapse/expand,
// or other internal state changes. Watch the sidebar root and re-run injectTabs()
// any time the .starred-pages-wrapper appears without our injection marker.

function startObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  const sidebarContent = document.querySelector(".roam-sidebar-content");
  if (!sidebarContent) return;

  observer = new MutationObserver(() => {
    const wrapper = findWrapper();
    if (wrapper && !wrapper.hasAttribute("data-sidebar-tabs-injected")) {
      injectTabs();
    }
  });

  observer.observe(sidebarContent, { childList: true, subtree: true });
}

// --- Cleanup: tear down injections on extension unload ---
// Disconnect the observer, remove every DOM element and class we added, and
// restore Roam's original header and starred-pages list to their visible state.
// Called by Roam when the user disables the extension or reloads the graph.

function cleanup() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  const wrapper = findWrapper();
  if (wrapper) {
    // Remove all injected lists
    TABS.forEach(({ id }) => {
      if (id === "shortcuts") return;
      const list = wrapper.querySelector(`.${id}-pages-list`);
      if (list) list.remove();
    });

    const tabHeader = wrapper.querySelector(".sidebar-tabs-header");
    if (tabHeader) tabHeader.remove();

    const header = findHeader(wrapper);
    if (header) header.classList.remove("sidebar-tabs-hidden");

    const starredPages = findStarredPages(wrapper);
    if (starredPages) starredPages.classList.remove("sidebar-tabs-hidden");

    wrapper.removeAttribute("data-sidebar-tabs-injected");
  }

  activeTab = "shortcuts";
  extensionAPI = null;
}

// --- Entry point ---

export default {
  onload: async ({ extensionAPI: api }) => {
    extensionAPI = api;

    // First-run defaults so all tab toggles read as "on" before the user opens settings.
    for (const { id } of TABS) {
      if (id === "shortcuts") continue;
      if (api.settings.get(`show-${id}`) === undefined) {
        await api.settings.set(`show-${id}`, true);
      }
    }
    if (api.settings.get("random-show-daily") === undefined) {
      await api.settings.set("random-show-daily", true);
    }

    api.settings.panel.create({
      tabTitle: "Sidebar Wayfinder",
      settings: [
        {
          id: "show-recent",
          name: "Show Recent tab",
          description: "Show the Recent tab in the sidebar",
          action: {
            type: "switch",
            onChange: async (evt) => {
              await api.settings.set("show-recent", evt.target.checked);
              refreshTabVisibility();
            },
          },
        },
        {
          id: "recent-count",
          name: "Number of recent items",
          description: "How many recently-edited pages to show in the Recent tab",
          action: { type: "input", placeholder: "10" },
        },
        {
          id: "show-system",
          name: "Show System tab",
          description: "Show the System tab in the sidebar",
          action: {
            type: "switch",
            onChange: async (evt) => {
              await api.settings.set("show-system", evt.target.checked);
              refreshTabVisibility();
            },
          },
        },
        {
          id: "show-random",
          name: "Show Random tab",
          description: "Show the Random tab in the sidebar (click again to reshuffle)",
          action: {
            type: "switch",
            onChange: async (evt) => {
              await api.settings.set("show-random", evt.target.checked);
              refreshTabVisibility();
            },
          },
        },
        {
          id: "random-count",
          name: "Number of random items",
          description: "How many random pages to show",
          action: { type: "input", placeholder: "10" },
        },
        {
          id: "random-show-daily",
          name: "Include daily notes in Random",
          description: "Show daily note pages in Random results",
          action: {
            type: "switch",
            onChange: async (evt) => {
              await api.settings.set("random-show-daily", evt.target.checked);
            },
          },
        },
        {
          id: "show-on-this-day",
          name: "Show On This Day tab",
          description: "Show pages created on today's date in previous years",
          action: {
            type: "switch",
            onChange: async (evt) => {
              await api.settings.set("show-on-this-day", evt.target.checked);
              refreshTabVisibility();
            },
          },
        },
        {
          id: "show-mentions",
          name: "Show Most Mentions tab",
          description: "Show pages ranked by number of backlinks",
          action: {
            type: "switch",
            onChange: async (evt) => {
              await api.settings.set("show-mentions", evt.target.checked);
              refreshTabVisibility();
            },
          },
        },
        {
          id: "mentions-count",
          name: "Number of Most Mentions items",
          description: "How many top-mentioned pages to show",
          action: { type: "input", placeholder: "10" },
        },
      ],
    });

    injectTabs();
    startObserver();
  },

  onunload: () => {
    cleanup();
  },
};
