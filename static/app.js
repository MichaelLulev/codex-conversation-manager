const MODES = {
  main: {
    label: "Main",
    listUrl: "/api/main-threads",
    detailUrl: (id) => `/api/main-threads/${encodeURIComponent(id)}`,
    searchPlaceholder: "Search main conversations",
    notice: "Main conversations are read from saved Codex rollout transcripts.",
    empty: "Select a main conversation to read it.",
    exportPrefix: "codex-main"
  },
  side: {
    label: "Side",
    listUrl: "/api/threads",
    detailUrl: (id) => `/api/threads/${encodeURIComponent(id)}`,
    searchPlaceholder: "Search recovered side chats",
    notice: "Recovered from diagnostic logs and prompt history. These are not normal resumable Codex sessions.",
    empty: "Select a side conversation to read it.",
    exportPrefix: "codex-side"
  }
};

const MAIN_FILTER_LABELS = {
  all: "conversations",
  with_side: "with side conversations",
  with_forks: "with forks",
  forked: "forked conversations"
};

const MESSAGE_RENDER_BATCH_SIZE = 20;
const MAX_FORMATTED_TEXT_LENGTH = 60000;
const CONVERSATION_SEARCH_DEBOUNCE_MS = 140;
const COLLAPSED_MESSAGE_ROLES = new Set(["thinking", "tool", "event"]);
const SEARCH_TEXT_CACHE = new WeakMap();
const MESSAGE_FILTER_STORAGE_KEY = "codex-reader-message-filters";
const MESSAGE_FILTER_DESCRIPTIONS = {
  user: "Your prompts and messages.",
  assistant: "Codex replies and progress updates.",
  thinking: "Visible reasoning summaries saved by Codex.",
  tool: "Tool calls and outputs, including shell, MCP, custom tools, and image viewing.",
  important: "Errors, aborted turns, and rollbacks.",
  compaction: "Context-compaction events and replacement summaries.",
  patch: "Patch summaries and changed-file metadata.",
  search: "Saved web-search call and completion metadata.",
  image: "Image-generation metadata, prompts, and saved image paths.",
  response: "Response status, model, token usage, and error/incomplete details.",
  thread: "Thread source, model provider, sandbox/approval mode, git info, and rollout path.",
  session: "Session startup metadata such as thread ID, cwd, CLI version, and base instructions.",
  context: "Raw developer, environment, AGENTS, permissions, and runtime context messages.",
  turn: "Turn start/completion timing, context window, and time-to-first-token.",
  usage: "Token counts, rate limits, and credit metadata.",
  otherEvent: "Recognized saved events that do not fit another category."
};
const MESSAGE_FILTERS = [
  { key: "user", label: "User", defaultEnabled: true },
  { key: "assistant", label: "Assistant", defaultEnabled: true },
  { key: "thinking", label: "Thinking", defaultEnabled: true },
  { key: "tool", label: "Tools", defaultEnabled: true },
  { key: "important", label: "Important events", defaultEnabled: true },
  { key: "compaction", label: "Compactions", defaultEnabled: true },
  { key: "patch", label: "Patches", defaultEnabled: false },
  { key: "search", label: "Search events", defaultEnabled: false },
  { key: "image", label: "Images", defaultEnabled: false },
  { key: "response", label: "Response stats", defaultEnabled: false },
  { key: "thread", label: "Thread metadata", defaultEnabled: false },
  { key: "session", label: "Session", defaultEnabled: false },
  { key: "context", label: "Context", defaultEnabled: false },
  { key: "turn", label: "Turn stats", defaultEnabled: false },
  { key: "usage", label: "Usage", defaultEnabled: false },
  { key: "otherEvent", label: "Other events", defaultEnabled: false }
];

const state = {
  mode: "main",
  mainFilter: "all",
  threads: [],
  selectedId: null,
  currentThread: null,
  pendingBranchId: null,
  scrollAnimationFrame: null,
  listRequestId: 0,
  detailRequestId: 0,
  detailAbortController: null,
  renderRequestId: 0,
  conversationSearch: {
    matches: [],
    activeIndex: -1,
    lowerQuery: "",
    queryLength: 0,
    timer: null
  },
  messageFilters: loadMessageFilters(),
  filter: ""
};

const els = {
  addressLine: document.getElementById("address-line"),
  sourceLine: document.getElementById("source-line"),
  refreshButton: document.getElementById("refresh-button"),
  exportButton: document.getElementById("export-button"),
  copyIdButton: document.getElementById("copy-id-button"),
  mainModeButton: document.getElementById("main-mode-button"),
  sideModeButton: document.getElementById("side-mode-button"),
  searchInput: document.getElementById("search-input"),
  mainFilterRow: document.getElementById("main-filter-row"),
  mainFilterSelect: document.getElementById("main-filter-select"),
  threadStats: document.getElementById("thread-stats"),
  threadList: document.getElementById("thread-list"),
  notice: document.getElementById("notice"),
  emptyState: document.getElementById("empty-state"),
  emptyStateMessage: document.getElementById("empty-state-message"),
  conversationView: document.getElementById("conversation-view"),
  conversationTitle: document.getElementById("conversation-title"),
  conversationMeta: document.getElementById("conversation-meta"),
  metaId: document.getElementById("meta-id"),
  metaCount: document.getElementById("meta-count"),
  metaModel: document.getElementById("meta-model"),
  metaCwd: document.getElementById("meta-cwd"),
  relatedPanel: document.getElementById("related-panel"),
  conversationSearchInput: document.getElementById("conversation-search-input"),
  conversationSearchCount: document.getElementById("conversation-search-count"),
  conversationSearchPrev: document.getElementById("conversation-search-prev"),
  conversationSearchNext: document.getElementById("conversation-search-next"),
  conversationSearchClear: document.getElementById("conversation-search-clear"),
  messageFilterOptions: document.getElementById("message-filter-options"),
  messageFilterDefaults: document.getElementById("message-filter-defaults"),
  messageFilterAll: document.getElementById("message-filter-all"),
  messages: document.getElementById("messages")
};

function modeConfig() {
  return MODES[state.mode];
}

function listUrl() {
  if (state.mode !== "main") {
    return modeConfig().listUrl;
  }
  return `${modeConfig().listUrl}?filter=${encodeURIComponent(state.mainFilter)}`;
}

function text(value) {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function defaultMessageFilters() {
  const defaults = {};
  for (const filter of MESSAGE_FILTERS) {
    defaults[filter.key] = filter.defaultEnabled;
  }
  return defaults;
}

function loadMessageFilters() {
  const defaults = defaultMessageFilters();
  try {
    const stored = JSON.parse(localStorage.getItem(MESSAGE_FILTER_STORAGE_KEY) || "{}");
    for (const filter of MESSAGE_FILTERS) {
      if (typeof stored[filter.key] === "boolean") {
        defaults[filter.key] = stored[filter.key];
      }
    }
  } catch {
    return defaults;
  }
  return defaults;
}

function saveMessageFilters() {
  try {
    localStorage.setItem(MESSAGE_FILTER_STORAGE_KEY, JSON.stringify(state.messageFilters));
  } catch {
    // Ignore private browsing or storage quota failures.
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function isAbortError(error) {
  return error && error.name === "AbortError";
}

function cancelDetailRequest() {
  state.detailRequestId += 1;
  if (state.detailAbortController) {
    state.detailAbortController.abort();
    state.detailAbortController = null;
  }
}

function cancelMessageRender() {
  state.renderRequestId += 1;
}

function cancelScheduledConversationSearch() {
  if (state.conversationSearch.timer !== null) {
    window.clearTimeout(state.conversationSearch.timer);
    state.conversationSearch.timer = null;
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function loadStatus() {
  const status = await fetchJson("/api/status");
  const address = status.server_url || `${window.location.origin}/`;
  if (els.addressLine) {
    els.addressLine.textContent = `Address ${address}`;
    els.sourceLine.textContent = `Reading ${status.state_db}`;
  } else {
    els.sourceLine.textContent = `Address ${address} | Reading ${status.state_db}`;
  }
}

async function loadThreads({ preserveSelection = true } = {}) {
  const requestId = state.listRequestId + 1;
  state.listRequestId = requestId;
  const threads = await fetchJson(listUrl());
  if (requestId !== state.listRequestId) {
    return;
  }
  state.threads = threads;
  await ensureVisibleSelection({ preserveSelection });
}

async function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.selectedId = null;
  state.currentThread = null;
  state.filter = "";
  els.searchInput.value = "";
  renderMode();
  await loadThreads({ preserveSelection: false });
}

async function openThread(kind, threadId, options = {}) {
  try {
    state.pendingBranchId = options.branchId || null;
    if (state.mode !== kind) {
      cancelDetailRequest();
      state.mode = kind;
      state.selectedId = null;
      state.currentThread = null;
      state.filter = "";
      els.searchInput.value = "";
      renderMode();
      state.threads = await fetchJson(listUrl());
      renderThreadList();
    }
    state.filter = "";
    els.searchInput.value = "";
    await selectThread(threadId, { preservePendingBranch: true });
  } catch (error) {
    if (!isAbortError(error)) {
      showConversationError(error);
    }
  }
}

function renderMode() {
  const config = modeConfig();
  els.mainModeButton.classList.toggle("active", state.mode === "main");
  els.sideModeButton.classList.toggle("active", state.mode === "side");
  els.mainFilterRow.classList.toggle("hidden", state.mode !== "main");
  els.mainFilterSelect.value = state.mainFilter;
  els.searchInput.placeholder = config.searchPlaceholder;
  els.notice.textContent = config.notice;
  els.emptyStateMessage.textContent = config.empty;
}

function renderMessageFilterControls() {
  els.messageFilterOptions.replaceChildren();
  for (const filter of MESSAGE_FILTERS) {
    const label = document.createElement("label");
    label.className = "message-filter";
    const description = MESSAGE_FILTER_DESCRIPTIONS[filter.key];
    if (description) {
      label.title = description;
      label.setAttribute("aria-label", `${filter.label}: ${description}`);
    }

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.messageFilters[filter.key] !== false;
    input.dataset.filterKey = filter.key;
    input.addEventListener("change", () => {
      state.messageFilters[filter.key] = input.checked;
      saveMessageFilters();
      applyMessageFilters();
      scheduleConversationSearch();
    });

    const textNode = document.createElement("span");
    textNode.textContent = filter.label;
    label.append(input, textNode);
    els.messageFilterOptions.appendChild(label);
  }
}

function setMessageFilters(filters) {
  state.messageFilters = { ...state.messageFilters, ...filters };
  saveMessageFilters();
  renderMessageFilterControls();
  applyMessageFilters();
  scheduleConversationSearch();
}

async function ensureVisibleSelection({ preserveSelection = true } = {}) {
  const threads = filteredThreads();
  renderThreadList();
  if (threads.length === 0) {
    clearConversation();
  } else if (preserveSelection && state.selectedId && threads.some((item) => item.id === state.selectedId)) {
    const currentId = state.currentThread && state.currentThread.summary && state.currentThread.summary.id;
    if (currentId !== state.selectedId) {
      await selectThread(state.selectedId);
    }
  } else {
    await selectThread(threads[0].id);
  }
}

function filteredThreads() {
  const query = state.filter.trim().toLowerCase();
  if (!query) return state.threads;
  return state.threads.filter((thread) => {
    const haystack = [
      thread.id,
      thread.preview,
      thread.started,
      thread.updated,
      thread.cwd,
      thread.model,
      thread.app_version,
      thread.source,
      thread.meta_label
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderThreadList() {
  const threads = filteredThreads();
  const noun = state.mode === "main" ? MAIN_FILTER_LABELS[state.mainFilter] : "recovered";
  els.threadStats.textContent = `${threads.length} shown, ${state.threads.length} ${noun}`;
  els.threadList.replaceChildren();

  for (const thread of threads) {
    const previewText = thread.preview || "(no title)";
    const metaText = thread.meta_label || `${thread.user_count || 0} user, ${thread.assistant_count || 0} assistant`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${thread.id === state.selectedId ? " active" : ""}`;
    button.addEventListener("click", () => selectThread(thread.id));

    const time = document.createElement("div");
    time.className = "thread-time";
    time.dir = "ltr";
    time.textContent = thread.updated || thread.started || "unknown time";

    const preview = document.createElement("div");
    preview.className = "thread-preview";
    setAutoDirection(preview, previewText);
    preview.textContent = previewText;

    const meta = document.createElement("div");
    meta.className = "thread-meta";
    setAutoDirection(meta, metaText);
    meta.textContent = metaText;

    button.append(time, preview, meta);
    els.threadList.appendChild(button);
  }
}

async function selectThread(threadId, options = {}) {
  if (!options.preservePendingBranch) {
    state.pendingBranchId = null;
  }
  if (state.detailAbortController) {
    state.detailAbortController.abort();
  }
  const requestId = state.detailRequestId + 1;
  const controller = new AbortController();
  state.detailRequestId = requestId;
  state.detailAbortController = controller;
  state.selectedId = threadId;
  renderThreadList();
  els.exportButton.disabled = true;
  els.copyIdButton.disabled = true;
  try {
    const detail = await fetchJson(modeConfig().detailUrl(threadId), { signal: controller.signal });
    if (requestId !== state.detailRequestId) {
      return;
    }
    state.currentThread = detail;
    renderConversation(detail);
  } catch (error) {
    if (requestId === state.detailRequestId && !isAbortError(error)) {
      showConversationError(error);
    }
  } finally {
    if (requestId === state.detailRequestId) {
      state.detailAbortController = null;
    }
  }
}

function clearConversation() {
  cancelDetailRequest();
  cancelMessageRender();
  state.selectedId = null;
  state.currentThread = null;
  resetConversationSearch();
  els.emptyState.classList.remove("hidden");
  els.conversationView.classList.add("hidden");
  els.relatedPanel.classList.add("hidden");
  els.relatedPanel.replaceChildren();
  els.exportButton.disabled = true;
  els.copyIdButton.disabled = true;
}

function renderConversation(detail) {
  cancelScrollAnimation();
  clearConversationHighlights();
  const renderRequestId = state.renderRequestId + 1;
  state.renderRequestId = renderRequestId;
  const summary = detail.summary;
  els.emptyState.classList.add("hidden");
  els.conversationView.classList.remove("hidden");
  els.exportButton.disabled = false;
  els.copyIdButton.disabled = false;
  els.conversationSearchInput.disabled = false;
  els.conversationSearchClear.disabled = els.conversationSearchInput.value.trim() === "";

  els.conversationTitle.textContent = summary.preview || "Conversation";
  els.conversationMeta.textContent = `${text(summary.started)} to ${text(summary.ended || summary.updated)}`;
  els.metaId.textContent = summary.id;
  els.metaCount.textContent = `${summary.message_count} shown`;
  els.metaModel.textContent = text(summary.model);
  els.metaCwd.textContent = text(summary.cwd);
  renderRelated(detail.related || {}, summary);

  els.messages.replaceChildren();
  const branchGroups = branchGroupsFor(detail);
  renderMessages(detail, branchGroups, renderRequestId);
}

async function renderMessages(detail, branchGroups, renderRequestId) {
  appendBranchMarkerGroup(branchGroups.get("-1"));
  for (const [index, message] of detail.messages.entries()) {
    if (renderRequestId !== state.renderRequestId) {
      return;
    }
    els.messages.appendChild(renderMessage(message, index));
    appendBranchMarkerGroup(branchGroups.get(String(index)));
    if ((index + 1) % MESSAGE_RENDER_BATCH_SIZE === 0) {
      await nextFrame();
    }
  }
  if (renderRequestId !== state.renderRequestId) {
    return;
  }
  applyMessageFilters();
  scheduleConversationSearch({ immediate: true });
  scrollToPendingBranch();
}

function renderRelated(related, summary) {
  const sections = [
    { title: "Parent conversation", items: related.parents || [], fallbackKind: "main", isParent: true },
    { title: "Forked conversations", items: related.forks || [], fallbackKind: "main", isParent: false },
    { title: "Side conversations", items: related.side || [], fallbackKind: "side", isParent: false }
  ].filter(({ items }) => items.length > 0);

  els.relatedPanel.replaceChildren();
  if (sections.length === 0) {
    els.relatedPanel.classList.add("hidden");
    return;
  }

  for (const [sectionIndex, { title, items, fallbackKind, isParent }] of sections.entries()) {
    const startsCollapsed = !isParent;
    const section = document.createElement("section");
    section.className = `related-section${startsCollapsed ? " collapsed" : ""}`;

    const heading = document.createElement("h3");
    const toggle = document.createElement("button");
    const listId = `related-list-${sectionIndex}`;
    toggle.type = "button";
    toggle.className = "related-heading";
    toggle.setAttribute("aria-controls", listId);
    toggle.setAttribute("aria-expanded", String(!startsCollapsed));
    toggle.textContent = `${title} (${items.length})`;
    heading.appendChild(toggle);
    section.appendChild(heading);

    const list = document.createElement("div");
    list.id = listId;
    list.className = "related-list";
    list.hidden = startsCollapsed;
    toggle.addEventListener("click", () => {
      const collapsed = section.classList.toggle("collapsed");
      list.hidden = collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
    });
    for (const item of items) {
      const options = isParent ? { branchId: summary.id } : { jumpToBranch: true };
      list.appendChild(renderRelatedItem(item, item.kind || fallbackKind, options));
    }
    section.appendChild(list);
    els.relatedPanel.appendChild(section);
  }
  els.relatedPanel.classList.remove("hidden");
}

function renderRelatedItem(item, kind, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "related-item";
  button.addEventListener("click", () => {
    if (options.jumpToBranch) {
      jumpToBranch(item.id);
      return;
    }
    openThread(kind, item.id, options);
  });

  const title = document.createElement("span");
  title.className = "related-title";
  setAutoDirection(title, item.preview || item.id);
  title.textContent = item.preview || item.id;

  const meta = document.createElement("span");
  meta.className = "related-meta";
  const metaText = [item.updated || item.started, item.meta_label].filter(Boolean).join(" | ");
  setAutoDirection(meta, metaText);
  meta.textContent = metaText;

  button.append(title, meta);
  return button;
}

function branchGroupsFor(detail) {
  if (state.mode !== "main") {
    return new Map();
  }

  const messages = detail.messages || [];
  const related = detail.related || {};
  const branches = [
    ...(related.forks || []).map((item) => ({ item, kind: "main", branchType: "fork" })),
    ...(related.side || []).map((item) => ({ item, kind: "side", branchType: "side" }))
  ];
  const groups = new Map();

  for (const branch of branches) {
    const anchor = branchAnchorIndex(messages, branch.item.started_at);
    const key = String(anchor);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(branch);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aTime = Number(a.item.started_at || 0);
      const bTime = Number(b.item.started_at || 0);
      if (aTime !== bTime) return aTime - bTime;
      return (a.item.preview || a.item.id).localeCompare(b.item.preview || b.item.id);
    });
  }

  return groups;
}

function branchAnchorIndex(messages, startedAt) {
  const started = Number(startedAt);
  if (!Number.isFinite(started)) {
    return messages.length - 1;
  }

  let anchor = -1;
  let sawTimestamp = false;
  for (const [index, message] of messages.entries()) {
    const timestamp = Number(message.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    sawTimestamp = true;
    if (timestamp <= started) {
      anchor = index;
    }
  }

  if (!sawTimestamp) {
    return messages.length - 1;
  }
  return anchor;
}

function appendBranchMarkerGroup(branches) {
  if (!branches || branches.length === 0) {
    return;
  }
  els.messages.appendChild(renderBranchMarker(branches));
}

function renderBranchMarker(branches) {
  const marker = document.createElement("section");
  marker.className = "branch-marker";

  const heading = document.createElement("div");
  heading.className = "branch-marker-heading";
  heading.textContent = branchMarkerHeading(branches);
  marker.appendChild(heading);

  const list = document.createElement("div");
  list.className = "branch-marker-list";
  for (const branch of branches) {
    list.appendChild(renderBranchLink(branch));
  }
  marker.appendChild(list);
  return marker;
}

function branchMarkerHeading(branches) {
  const sideCount = branches.filter((branch) => branch.branchType === "side").length;
  const forkCount = branches.length - sideCount;
  if (branches.length === 1) {
    return sideCount === 1 ? "Side conversation opened here" : "Forked conversation opened here";
  }
  const parts = [];
  if (forkCount > 0) parts.push(`${forkCount} forked`);
  if (sideCount > 0) parts.push(`${sideCount} side`);
  return `${parts.join(", ")} conversations opened here`;
}

function renderBranchLink(branch) {
  const item = branch.item;
  const row = document.createElement("button");
  row.type = "button";
  row.className = `branch-link ${branch.branchType}`;
  row.id = branchMarkerId(item.id);
  row.addEventListener("click", () => openThread(branch.kind, item.id));

  const kind = document.createElement("span");
  kind.className = "branch-kind";
  kind.textContent = branch.branchType === "side" ? "Side" : "Fork";

  const body = document.createElement("span");
  body.className = "branch-link-body";

  const title = document.createElement("span");
  title.className = "branch-link-title";
  setAutoDirection(title, item.preview || item.id);
  title.textContent = item.preview || item.id;

  const meta = document.createElement("span");
  meta.className = "branch-link-meta";
  const metaText = [item.started || item.updated, item.meta_label].filter(Boolean).join(" | ");
  setAutoDirection(meta, metaText);
  meta.textContent = metaText;

  body.append(title, meta);

  const action = document.createElement("span");
  action.className = "branch-link-action";
  action.textContent = "Open";

  row.append(kind, body, action);
  return row;
}

function branchMarkerId(threadId) {
  return `branch-${threadId}`;
}

function scrollToPendingBranch() {
  const branchId = state.pendingBranchId;
  if (!branchId) {
    return;
  }
  state.pendingBranchId = null;
  window.requestAnimationFrame(() => jumpToBranch(branchId));
}

function jumpToBranch(branchId) {
  const marker = document.getElementById(branchMarkerId(branchId));
  if (!marker) {
    return;
  }
  const markerRect = marker.getBoundingClientRect();
  const messagesRect = els.messages.getBoundingClientRect();
  const target = els.messages.scrollTop
    + markerRect.top
    - messagesRect.top
    - ((els.messages.clientHeight - markerRect.height) / 2);
  const maxScroll = els.messages.scrollHeight - els.messages.clientHeight;
  const duration = scrollMessagesTo(Math.max(0, Math.min(target, maxScroll)));
  marker.classList.add("branch-link-focus");
  window.setTimeout(() => marker.classList.remove("branch-link-focus"), duration + 1200);
}

function scrollMessagesTo(target) {
  cancelScrollAnimation();
  const start = els.messages.scrollTop;
  const distance = target - start;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (Math.abs(distance) < 1 || reduceMotion) {
    els.messages.scrollTop = target;
    return 0;
  }

  const duration = Math.min(900, Math.max(280, Math.abs(distance) / 24));
  let startedAt = null;

  const step = (timestamp) => {
    if (startedAt === null) {
      startedAt = timestamp;
    }
    const progress = Math.min((timestamp - startedAt) / duration, 1);
    const eased = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;

    els.messages.scrollTop = start + (distance * eased);
    if (progress < 1) {
      state.scrollAnimationFrame = window.requestAnimationFrame(step);
      return;
    }
    els.messages.scrollTop = target;
    state.scrollAnimationFrame = null;
  };

  state.scrollAnimationFrame = window.requestAnimationFrame(step);
  return duration;
}

function cancelScrollAnimation() {
  if (state.scrollAnimationFrame === null) {
    return;
  }
  window.cancelAnimationFrame(state.scrollAnimationFrame);
  state.scrollAnimationFrame = null;
}

function resetConversationSearch() {
  cancelScheduledConversationSearch();
  clearConversationHighlights();
  state.conversationSearch.matches = [];
  state.conversationSearch.activeIndex = -1;
  state.conversationSearch.lowerQuery = "";
  state.conversationSearch.queryLength = 0;
  els.conversationSearchInput.value = "";
  els.conversationSearchInput.disabled = true;
  updateConversationSearchControls();
}

function scheduleConversationSearch({ immediate = false } = {}) {
  cancelScheduledConversationSearch();
  const query = els.conversationSearchInput.value.trim();
  els.conversationSearchClear.disabled = query === "";
  if (!query || immediate) {
    applyConversationSearch();
    return;
  }
  els.conversationSearchCount.textContent = "Searching...";
  state.conversationSearch.timer = window.setTimeout(() => {
    state.conversationSearch.timer = null;
    applyConversationSearch();
  }, CONVERSATION_SEARCH_DEBOUNCE_MS);
}

function applyConversationSearch() {
  cancelScheduledConversationSearch();
  clearConversationHighlights();
  state.conversationSearch.matches = [];
  state.conversationSearch.activeIndex = -1;
  state.conversationSearch.lowerQuery = "";
  state.conversationSearch.queryLength = 0;

  const query = els.conversationSearchInput.value.trim();
  els.conversationSearchClear.disabled = query === "";
  if (!query) {
    updateConversationSearchControls();
    return;
  }

  const lowerQuery = query.toLocaleLowerCase();
  state.conversationSearch.lowerQuery = lowerQuery;
  state.conversationSearch.queryLength = query.length;
  const messages = state.currentThread?.messages || [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!isMessageSearchVisible(message)) {
      continue;
    }
    const lowerText = cachedLowerSearchText(message);
    let occurrenceIndex = 0;
    let matchIndex = lowerText.indexOf(lowerQuery);
    while (matchIndex !== -1) {
      state.conversationSearch.matches.push({
        messageIndex,
        occurrenceIndex
      });
      occurrenceIndex += 1;
      matchIndex = lowerText.indexOf(lowerQuery, matchIndex + lowerQuery.length);
    }
  }

  if (state.conversationSearch.matches.length > 0) {
    setActiveConversationMatch(0, { scroll: false });
    return;
  }
  updateConversationSearchControls();
}

function isMessageSearchVisible(message) {
  const key = messageFilterKey(message);
  return state.messageFilters[key] !== false;
}

function cachedLowerSearchText(message) {
  const textValue = message?.text || "";
  const cached = SEARCH_TEXT_CACHE.get(message);
  if (cached && cached.text === textValue) {
    return cached.lowerText;
  }
  const lowerText = textValue.toLocaleLowerCase();
  SEARCH_TEXT_CACHE.set(message, { text: textValue, lowerText });
  return lowerText;
}

function highlightNthSearchInElement(element, lowerQuery, queryLength, targetOccurrence) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest(".search-match")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let seenOccurrences = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue;
    const lowerValue = value.toLocaleLowerCase();
    let matchIndex = lowerValue.indexOf(lowerQuery);
    while (matchIndex !== -1) {
      if (seenOccurrences === targetOccurrence) {
        const fragment = document.createDocumentFragment();
        if (matchIndex > 0) {
          fragment.appendChild(document.createTextNode(value.slice(0, matchIndex)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-match active";
        mark.textContent = value.slice(matchIndex, matchIndex + queryLength);
        fragment.appendChild(mark);
        if (matchIndex + queryLength < value.length) {
          fragment.appendChild(document.createTextNode(value.slice(matchIndex + queryLength)));
        }
        node.replaceWith(fragment);
        return mark;
      }
      seenOccurrences += 1;
      matchIndex = lowerValue.indexOf(lowerQuery, matchIndex + lowerQuery.length);
    }
  }
  if (targetOccurrence > 0) {
    return highlightNthSearchInElement(element, lowerQuery, queryLength, 0);
  }
  return null;
}

function clearConversationHighlights() {
  const marks = [...els.messages.querySelectorAll(".search-match")];
  for (const mark of marks) {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent));
    parent?.normalize();
  }
}

function updateConversationSearchControls() {
  const query = els.conversationSearchInput.value.trim();
  const total = state.conversationSearch.matches.length;
  const active = state.conversationSearch.activeIndex;
  if (!query) {
    els.conversationSearchCount.textContent = "No search";
  } else if (total === 0) {
    els.conversationSearchCount.textContent = "0 matches";
  } else {
    els.conversationSearchCount.textContent = `${active + 1} / ${total}`;
  }
  els.conversationSearchPrev.disabled = total === 0;
  els.conversationSearchNext.disabled = total === 0;
  els.conversationSearchClear.disabled = query === "";
}

function setActiveConversationMatch(index, { scroll = true } = {}) {
  const matches = state.conversationSearch.matches;
  if (matches.length === 0) {
    state.conversationSearch.activeIndex = -1;
    updateConversationSearchControls();
    return;
  }

  const normalizedIndex = (index + matches.length) % matches.length;
  clearConversationHighlights();
  const active = matches[normalizedIndex];
  const wrapper = els.messages.querySelector(`.message[data-message-index="${active.messageIndex}"]`);
  let activeElement = wrapper;
  if (wrapper) {
    if (wrapper.classList.contains("collapsed")) {
      expandCollapsedMessage(wrapper);
    }
    const body = wrapper.querySelector(".message-body");
    const mark = body
      ? highlightNthSearchInElement(
        body,
        state.conversationSearch.lowerQuery,
        state.conversationSearch.queryLength,
        active.occurrenceIndex
      )
      : null;
    activeElement = mark || wrapper;
  }
  state.conversationSearch.activeIndex = normalizedIndex;
  updateConversationSearchControls();

  if (scroll && activeElement) {
    scrollElementIntoMessages(activeElement);
  }
}

function stepConversationSearch(direction) {
  if (state.conversationSearch.matches.length === 0) {
    return;
  }
  setActiveConversationMatch(state.conversationSearch.activeIndex + direction);
}

function scrollElementIntoMessages(element) {
  const elementRect = element.getBoundingClientRect();
  const messagesRect = els.messages.getBoundingClientRect();
  const target = els.messages.scrollTop
    + elementRect.top
    - messagesRect.top
    - ((els.messages.clientHeight - elementRect.height) / 2);
  const maxScroll = els.messages.scrollHeight - els.messages.clientHeight;
  scrollMessagesTo(Math.max(0, Math.min(target, maxScroll)));
}

function renderMessage(message, index = 0) {
  const wrapper = document.createElement("section");
  wrapper.className = `message ${message.role}`;
  wrapper.dataset.filterKey = messageFilterKey(message);
  wrapper.dataset.messageIndex = String(index);
  const isCollapsible = COLLAPSED_MESSAGE_ROLES.has(message.role);
  if (isCollapsible) {
    wrapper.classList.add("collapsed");
  }

  const header = document.createElement("div");
  header.className = "message-header";

  let roleElement;
  const bodyId = isCollapsible ? `${message.role}-body-${index}` : "";
  if (isCollapsible) {
    roleElement = document.createElement("button");
    roleElement.type = "button";
    roleElement.className = "message-toggle";
    roleElement.setAttribute("aria-expanded", "false");
    roleElement.setAttribute("aria-controls", bodyId);

    const icon = document.createElement("span");
    icon.className = "message-toggle-icon";
    icon.textContent = "+";

    const role = document.createElement("span");
    role.className = "role";
    role.textContent = roleLabel(message.role);
    roleElement.append(icon, role);

    const headingText = collapsedMessageHeading(message.text || "");
    if (headingText) {
      const heading = document.createElement("span");
      heading.className = "message-heading-preview";
      setAutoDirection(heading, headingText);
      heading.textContent = headingText;
      roleElement.appendChild(heading);
    }
  } else {
    roleElement = document.createElement("span");
    roleElement.className = "role";
    roleElement.textContent = roleLabel(message.role);
  }

  const phase = message.phase ? ` | ${message.phase}` : "";
  const source = document.createElement("span");
  source.textContent = `${text(message.time)} | ${text(message.source)}${phase}`;

  header.append(roleElement, source);

  const body = document.createElement("div");
  body.className = "message-body";
  if (isCollapsible) {
    body.id = bodyId;
    body.hidden = true;
    if (message.role === "tool" || message.role === "event") {
      body.dataset.rendered = "false";
      body.__messageText = message.text || "";
    }
    roleElement.addEventListener("click", () => {
      setCollapsedMessageExpanded(
        wrapper,
        body,
        roleElement,
        wrapper.classList.contains("collapsed"),
      );
    });
  }
  setAutoDirection(body, message.text || "");
  if (message.role !== "tool" && message.role !== "event") {
    body.appendChild(renderFormattedText(message.text || ""));
  }

  wrapper.append(header, body);
  return wrapper;
}

function messageFilterKey(message) {
  if (message.role === "user" || message.role === "assistant" || message.role === "thinking" || message.role === "tool") {
    return message.role;
  }
  if (message.role !== "event") {
    return "otherEvent";
  }
  const phase = message.phase || "";
  if (phase === "compaction") return "compaction";
  if (phase === "rollback" || phase === "aborted" || phase === "error") return "important";
  if (phase === "patch") return "patch";
  if (phase === "search") return "search";
  if (phase === "image") return "image";
  if (phase === "response") return "response";
  if (phase === "thread") return "thread";
  if (phase === "session") return "session";
  if (phase === "context") return "context";
  if (phase === "turn") return "turn";
  if (phase === "usage") return "usage";
  return "otherEvent";
}

function applyMessageFilters() {
  const messageElements = [...els.messages.querySelectorAll(".message")];
  let visible = 0;
  for (const element of messageElements) {
    const key = element.dataset.filterKey || "otherEvent";
    const shown = state.messageFilters[key] !== false;
    element.classList.toggle("filtered-out", !shown);
    if (shown) {
      visible += 1;
    }
  }
  const total = messageElements.length;
  if (state.currentThread && state.currentThread.summary) {
    els.metaCount.textContent = `${visible} of ${total} shown`;
  }
}

function expandCollapsedMessage(wrapper) {
  const body = wrapper.querySelector(".message-body");
  const toggle = wrapper.querySelector(".message-toggle");
  if (!body || !toggle) {
    return;
  }
  setCollapsedMessageExpanded(wrapper, body, toggle, true);
}

function setCollapsedMessageExpanded(wrapper, body, toggle, expanded) {
  wrapper.classList.toggle("collapsed", !expanded);
  if (expanded) {
    ensureMessageBodyRendered(body);
  }
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  const icon = toggle.querySelector(".message-toggle-icon");
  if (icon) {
    icon.textContent = expanded ? "-" : "+";
  }
}

function ensureMessageBodyRendered(body) {
  if (body.dataset.rendered !== "false") {
    return;
  }
  body.replaceChildren(renderFormattedText(body.__messageText || ""));
  body.dataset.rendered = "true";
}

function collapsedMessageHeading(value) {
  const lines = String(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return "";
  }
  const firstLine = lines[0];
  const heading = firstLine.match(/^#{1,6}\s+(.+)$/)
    || firstLine.match(/^\*\*(.+?)\*\*$/)
    || firstLine.match(/^__(.+?)__$/);
  const textValue = heading ? heading[1] : firstLine;
  return compactInlineText(stripInlineMarkup(textValue), 90);
}

function stripInlineMarkup(value) {
  return String(value)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function compactInlineText(value, limit) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trim()}...`;
}

function roleLabel(role) {
  if (role === "assistant") return "Assistant";
  if (role === "thinking") return "Thinking";
  if (role === "tool") return "Tool";
  if (role === "event") return "Event";
  return "You";
}

function renderFormattedText(value) {
  if (String(value).length > MAX_FORMATTED_TEXT_LENGTH) {
    return renderLongPlainText(value);
  }
  const fragment = document.createDocumentFragment();
  const lines = String(value).replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_.+-]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      fragment.appendChild(renderCodeBlock(codeLines.join("\n"), fence[1]));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const element = document.createElement("h4");
      element.className = `md-heading level-${heading[1].length}`;
      setAutoDirection(element, heading[2]);
      element.appendChild(renderInline(heading[2]));
      fragment.appendChild(element);
      index += 1;
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      const list = document.createElement("ul");
      list.dir = "auto";
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        const li = document.createElement("li");
        setAutoDirection(li, item[1]);
        li.appendChild(renderInline(item[1]));
        list.appendChild(li);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const list = document.createElement("ol");
      list.dir = "auto";
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        const li = document.createElement("li");
        setAutoDirection(li, item[1]);
        li.appendChild(renderInline(item[1]));
        list.appendChild(li);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*>\s?(.*)$/);
        if (!item) break;
        quoteLines.push(item[1]);
        index += 1;
      }
      setAutoDirection(quote, quoteLines.join(" "));
      quote.appendChild(renderInline(quoteLines.join(" ")));
      fragment.appendChild(quote);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      const rule = document.createElement("hr");
      rule.className = "md-rule";
      fragment.appendChild(rule);
      index += 1;
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    setAutoDirection(paragraph, paragraphLines.join("\n"));
    appendFormattedLines(paragraph, paragraphLines);
    fragment.appendChild(paragraph);
  }

  if (!fragment.childNodes.length) {
    fragment.appendChild(document.createTextNode(""));
  }
  return fragment;
}

function renderLongPlainText(value) {
  const wrapper = document.createElement("div");
  wrapper.className = "long-message-text";
  wrapper.textContent = String(value);
  return wrapper;
}

function appendFormattedLines(parent, lines) {
  for (const line of lines) {
    const span = document.createElement("span");
    span.className = "bidi-line";
    setAutoDirection(span, line);
    span.appendChild(renderInline(line));
    parent.appendChild(span);
  }
}

function isBlockStart(line) {
  return /^```/.test(line)
    || /^(#{1,4})\s+/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*---+\s*$/.test(line);
}

function renderCodeBlock(codeText, language) {
  const pre = document.createElement("pre");
  pre.dir = "ltr";
  const code = document.createElement("code");
  code.dir = "ltr";
  if (language) {
    code.dataset.language = language;
  }
  code.textContent = codeText;
  pre.appendChild(code);
  return pre;
}

function setAutoDirection(element, value) {
  element.dir = "auto";
  element.dataset.hasRtl = hasRtlText(value) ? "true" : "false";
}

function hasRtlText(value) {
  return /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(String(value));
}

function renderInline(value) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) {
      fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    }

    if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      fragment.appendChild(code);
    } else if (match[4] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[4];
      fragment.appendChild(strong);
    } else if (match[6] !== undefined) {
      const emphasis = document.createElement("em");
      emphasis.textContent = match[6];
      fragment.appendChild(emphasis);
    } else if (match[8] !== undefined && match[9] !== undefined) {
      fragment.appendChild(renderSafeLink(match[8], match[9]));
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < value.length) {
    fragment.appendChild(document.createTextNode(value.slice(cursor)));
  }
  return fragment;
}

function renderSafeLink(label, href) {
  if (/^(https?:\/\/|mailto:|#)/i.test(href)) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    link.target = "_blank";
    link.rel = "noreferrer";
    return link;
  }
  const span = document.createElement("span");
  span.textContent = `${label} (${href})`;
  return span;
}

function exportCurrentThread() {
  if (!state.currentThread) return;
  const blob = new Blob([JSON.stringify(state.currentThread, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${modeConfig().exportPrefix}-${state.currentThread.summary.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyCurrentId() {
  if (!state.selectedId) return;
  await navigator.clipboard.writeText(state.selectedId);
  const original = els.copyIdButton.textContent;
  els.copyIdButton.textContent = "Copied";
  window.setTimeout(() => {
    els.copyIdButton.textContent = original;
  }, 1200);
}

function showError(error) {
  cancelDetailRequest();
  cancelMessageRender();
  els.threadList.replaceChildren();
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = error.message || String(error);
  els.threadList.appendChild(box);
  els.threadStats.textContent = "Load failed";
}

function showConversationError(error) {
  cancelMessageRender();
  state.currentThread = null;
  resetConversationSearch();
  els.emptyStateMessage.textContent = error.message || String(error);
  els.emptyState.classList.remove("hidden");
  els.conversationView.classList.add("hidden");
  els.relatedPanel.classList.add("hidden");
  els.relatedPanel.replaceChildren();
  els.exportButton.disabled = true;
  els.copyIdButton.disabled = true;
}

async function init() {
  els.refreshButton.addEventListener("click", async () => {
    try {
      await loadStatus();
      await loadThreads();
    } catch (error) {
      showError(error);
    }
  });
  els.mainModeButton.addEventListener("click", async () => {
    try {
      await setMode("main");
    } catch (error) {
      showError(error);
    }
  });
  els.sideModeButton.addEventListener("click", async () => {
    try {
      await setMode("side");
    } catch (error) {
      showError(error);
    }
  });
  els.mainFilterSelect.addEventListener("change", async () => {
    state.mainFilter = els.mainFilterSelect.value;
    state.selectedId = null;
    state.currentThread = null;
    try {
      await loadThreads({ preserveSelection: false });
    } catch (error) {
      showError(error);
    }
  });
  els.exportButton.addEventListener("click", exportCurrentThread);
  els.copyIdButton.addEventListener("click", copyCurrentId);
  els.searchInput.addEventListener("input", async () => {
    state.filter = els.searchInput.value;
    try {
      await ensureVisibleSelection();
    } catch (error) {
      showError(error);
    }
  });
  els.conversationSearchInput.addEventListener("input", () => {
    scheduleConversationSearch();
  });
  els.conversationSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    stepConversationSearch(event.shiftKey ? -1 : 1);
  });
  els.conversationSearchPrev.addEventListener("click", () => stepConversationSearch(-1));
  els.conversationSearchNext.addEventListener("click", () => stepConversationSearch(1));
  els.conversationSearchClear.addEventListener("click", () => {
    els.conversationSearchInput.value = "";
    scheduleConversationSearch({ immediate: true });
    els.conversationSearchInput.focus();
  });
  els.messageFilterDefaults.addEventListener("click", () => {
    setMessageFilters(defaultMessageFilters());
  });
  els.messageFilterAll.addEventListener("click", () => {
    const allFilters = {};
    for (const filter of MESSAGE_FILTERS) {
      allFilters[filter.key] = true;
    }
    setMessageFilters(allFilters);
  });

  try {
    renderMessageFilterControls();
    renderMode();
    await loadStatus();
    await loadThreads({ preserveSelection: false });
  } catch (error) {
    showError(error);
  }
}

init();
