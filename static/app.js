const MODES = {
  main: {
    label: "Main",
    listUrl: "/api/main-threads",
    detailUrl: (id) => `/api/main-threads/${encodeURIComponent(id)}`,
    searchPlaceholder: "Search main conversations",
    empty: "Select a main conversation to read it.",
    exportPrefix: "codex-main"
  },
  side: {
    label: "Side",
    listUrl: "/api/threads",
    detailUrl: (id) => `/api/threads/${encodeURIComponent(id)}`,
    searchPlaceholder: "Search recovered side chats",
    empty: "Select a side conversation to read it.",
    exportPrefix: "codex-side"
  }
};

const MAIN_FILTER_LABELS = {
  all: "conversations",
  with_side: "with side conversations",
  with_forks: "with forks",
  forked: "forked conversations",
  with_rollback: "with rollbacks",
  archived: "archived conversations"
};

const VIRTUAL_TRANSCRIPT_OVERSCAN_VIEWPORTS = 2.5;
const VIRTUAL_TRANSCRIPT_MIN_OVERSCAN_PX = 1200;
const VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT = 148;
const VIRTUAL_TRANSCRIPT_GAP_PX = 8;
const VIRTUAL_TRANSCRIPT_MEASURE_TOLERANCE_PX = 1;
const VIRTUAL_TRANSCRIPT_RESOLVE_DELAY_MS = 80;
const TOOL_RUN_GROUP_MIN_SIZE = 2;
const MAX_FORMATTED_TEXT_LENGTH = 60000;
const MAX_INTRALINE_DIFF_CELLS = 120000;
const MAX_COMBINED_DIFF_TOKEN_CELLS = 80000;
const MAX_PAIR_SIMILARITY_CELLS = 20000;
const MIN_INTRALINE_PAIR_SCORE = 0.62;
const CONVERSATION_SEARCH_DEBOUNCE_MS = 900;
const CONVERSATION_SEARCH_TIME_BUDGET_MS = 10;
const THREAD_FULL_TEXT_SEARCH_DEBOUNCE_MS = 450;
const SEARCH_WORKER_URL = "/static/search-worker.js";
const COLLAPSED_MESSAGE_ROLES = new Set(["thinking", "tool", "event"]);
const SEARCH_TEXT_CACHE = new WeakMap();
const MESSAGE_FILTER_STORAGE_KEY = "codex-reader-message-filters";
const THREAD_PANEL_WIDTH_STORAGE_KEY = "codex-reader-thread-panel-width";
const THREAD_PANEL_COLLAPSED_STORAGE_KEY = "codex-reader-thread-panel-collapsed";
const THREAD_PANEL_DEFAULT_WIDTH = 380;
const THREAD_PANEL_MIN_WIDTH = 260;
const THREAD_PANEL_MAX_WIDTH = 640;
const THREAD_PANEL_RESIZER_WIDTH = 8;
const THREAD_PANEL_MIN_READER_WIDTH = 640;
const THREAD_PANEL_KEYBOARD_STEP = 24;
const THREAD_PANEL_STACKED_BREAKPOINT = THREAD_PANEL_MIN_WIDTH
  + THREAD_PANEL_RESIZER_WIDTH
  + THREAD_PANEL_MIN_READER_WIDTH;
const DIFF_BLOCK_PATTERN = /^`{3,}(diff|patch)\s*$/im;
const MESSAGE_FILTER_DESCRIPTIONS = {
  user: "Your prompts and messages.",
  assistant: "The final assistant message in each reply.",
  assistantInterim: "Assistant messages before the final assistant message in each reply.",
  thinking: "Visible reasoning summaries saved by Codex.",
  tool: "Tool calls and outputs, including shell, MCP, custom tools, and image viewing.",
  rolledBack: "Messages from turns removed with Esc Esc rollback/undo. Codex still keeps them in the raw transcript.",
  important: "Errors, aborted turns, and rollback markers.",
  compaction: "Context-compaction events and replacement summaries.",
  patch: "Patch summaries and changed-file metadata.",
  diff: "Messages containing rendered diff blocks. Use None, then Diffs, to show only diffs.",
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
  { key: "assistant", label: "Assistant final", defaultEnabled: true },
  { key: "assistantInterim", label: "Assistant interim", defaultEnabled: true },
  { key: "thinking", label: "Thinking", defaultEnabled: true },
  { key: "tool", label: "Tools", defaultEnabled: true },
  { key: "rolledBack", label: "Rolled back", defaultEnabled: true },
  { key: "important", label: "Important events", defaultEnabled: true },
  { key: "compaction", label: "Compactions", defaultEnabled: true },
  { key: "patch", label: "Patches", defaultEnabled: false },
  { key: "diff", label: "Diffs", defaultEnabled: false },
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
  pendingScrollTarget: null,
  scrollAnimationFrame: null,
  listRequestId: 0,
  listAbortController: null,
  detailRequestId: 0,
  detailAbortController: null,
  renderRequestId: 0,
  fullTextSearch: false,
  serverSearchActive: false,
  threadSearchTimer: null,
  messagesFrameResizeObserver: null,
  messagesFrameSyncTimers: [],
  messagesFrameSyncPending: false,
  messagesFrameScrollbarWidth: null,
  virtualTranscript: emptyVirtualTranscriptState(),
  expandedMessages: new Set(),
  expandedToolRuns: new Set(),
  toolRunByMessageIndex: new Map(),
  confirmDialog: {
    resolve: null,
    previousFocus: null
  },
  askCodex: {
    requestId: 0,
    serverRequestId: null,
    abortController: null,
    selectedText: "",
    selectedMessageIndex: null,
    activeMarks: [],
    turns: []
  },
  conversationSearch: {
    matchGroups: [],
    totalMatches: 0,
    activeIndex: -1,
    lowerQuery: "",
    queryLength: 0,
    timer: null,
    inputFrame: null,
    abortController: null,
    requestId: 0,
    worker: null,
    workerReady: false,
    workerRevision: 0,
    workerIndexing: false,
    pendingWorkerSearch: false,
    activeMarks: []
  },
  messageFilters: loadMessageFilters(),
  threadPanel: {
    width: loadThreadPanelWidth(),
    collapsed: loadThreadPanelCollapsed(),
    dragging: false
  },
  filter: ""
};

const els = {
  layout: document.getElementById("layout"),
  threadPanel: document.getElementById("thread-panel"),
  threadPanelToggle: document.getElementById("thread-panel-toggle"),
  threadPanelResizer: document.getElementById("thread-panel-resizer"),
  addressLine: document.getElementById("address-line"),
  sourceLine: document.getElementById("source-line"),
  refreshButton: document.getElementById("refresh-button"),
  exportButton: document.getElementById("export-button"),
  exportFormatSelect: document.getElementById("export-format-select"),
  copyIdButton: document.getElementById("copy-id-button"),
  archiveButton: document.getElementById("archive-button"),
  mainModeButton: document.getElementById("main-mode-button"),
  sideModeButton: document.getElementById("side-mode-button"),
  searchInput: document.getElementById("search-input"),
  fullTextSearchInput: document.getElementById("full-text-search-input"),
  mainFilterRow: document.getElementById("main-filter-row"),
  mainFilterSelect: document.getElementById("main-filter-select"),
  threadStats: document.getElementById("thread-stats"),
  threadList: document.getElementById("thread-list"),
  emptyState: document.getElementById("empty-state"),
  emptyStateMessage: document.getElementById("empty-state-message"),
  conversationView: document.getElementById("conversation-view"),
  conversationHeader: document.querySelector(".conversation-header"),
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
  messageFilters: document.getElementById("message-filters"),
  askCodexPanel: document.getElementById("ask-codex-panel"),
  askCodexQuestion: document.getElementById("ask-codex-question"),
  askSelectedButton: document.getElementById("ask-selected-button"),
  askCodexButton: document.getElementById("ask-codex-button"),
  askCodexStopButton: document.getElementById("ask-codex-stop-button"),
  askCodexStatus: document.getElementById("ask-codex-status"),
  askCodexAnswer: document.getElementById("ask-codex-answer"),
  messageFilterDefaults: document.getElementById("message-filter-defaults"),
  messageFilterAll: document.getElementById("message-filter-all"),
  messageFilterNone: document.getElementById("message-filter-none"),
  messageFilterCustom: document.getElementById("message-filter-custom"),
  confirmModal: document.getElementById("confirm-modal"),
  confirmModalTitle: document.getElementById("confirm-modal-title"),
  confirmModalBody: document.getElementById("confirm-modal-body"),
  confirmModalDetails: document.getElementById("confirm-modal-details"),
  confirmCancelButton: document.getElementById("confirm-cancel-button"),
  confirmConfirmButton: document.getElementById("confirm-confirm-button"),
  messagesFrame: document.getElementById("messages-frame"),
  messagesDocument: null,
  messages: null
};

function setupConfirmModal() {
  els.confirmCancelButton.addEventListener("click", () => settleConfirmDialog(false));
  els.confirmConfirmButton.addEventListener("click", () => settleConfirmDialog(true));
  els.confirmModal.addEventListener("click", (event) => {
    if (event.target?.dataset?.confirmCancel !== undefined) {
      settleConfirmDialog(false);
    }
  });
  els.confirmModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      settleConfirmDialog(false);
      return;
    }
    if (event.key === "Tab") {
      keepFocusInConfirmDialog(event);
    }
  });
}

function confirmWriteAction({
  title,
  body,
  details = [],
  confirmLabel = "Confirm",
  opener = null
}) {
  if (state.confirmDialog.resolve) {
    return Promise.resolve(false);
  }
  state.confirmDialog.previousFocus = opener || document.activeElement;
  els.confirmModalTitle.textContent = title;
  els.confirmModalBody.textContent = body;
  els.confirmConfirmButton.textContent = confirmLabel;
  renderConfirmDetails(details);
  els.confirmModal.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    els.confirmConfirmButton.focus({ preventScroll: true });
  });
  return new Promise((resolve) => {
    state.confirmDialog.resolve = resolve;
  });
}

function renderConfirmDetails(details) {
  const fragment = document.createDocumentFragment();
  for (const detail of details) {
    if (!detail || detail.value === undefined || detail.value === null || detail.value === "") {
      continue;
    }
    const row = document.createElement("div");
    row.className = "confirm-detail-row";

    const term = document.createElement("dt");
    term.textContent = detail.label;

    const value = document.createElement("dd");
    const textValue = String(detail.value);
    setAutoDirection(value, textValue);
    value.textContent = textValue;

    row.append(term, value);
    fragment.appendChild(row);
  }
  els.confirmModalDetails.replaceChildren(fragment);
}

function settleConfirmDialog(confirmed) {
  const resolve = state.confirmDialog.resolve;
  if (!resolve) {
    return;
  }
  const previousFocus = state.confirmDialog.previousFocus;
  state.confirmDialog.resolve = null;
  state.confirmDialog.previousFocus = null;
  els.confirmModal.classList.add("hidden");
  els.confirmModalDetails.replaceChildren();
  resolve(confirmed);
  if (previousFocus && typeof previousFocus.focus === "function" && previousFocus.isConnected) {
    window.requestAnimationFrame(() => {
      previousFocus.focus({ preventScroll: true });
    });
  }
}

function keepFocusInConfirmDialog(event) {
  const focusable = [els.confirmCancelButton, els.confirmConfirmButton].filter(
    (element) => element && !element.disabled
  );
  if (focusable.length === 0) {
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function setupMessagesFrame() {
  const frame = els.messagesFrame;
  const doc = frame?.contentDocument || frame?.contentWindow?.document;
  if (!frame || !doc) {
    throw new Error("Conversation message frame is unavailable");
  }
  doc.open();
  doc.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <base href="${window.location.origin}/">
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      html {
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }
      body {
        width: 100%;
        max-width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: scroll;
        overscroll-behavior: contain;
      }
    </style>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body id="messages-root" class="messages messages-frame-body" aria-hidden="true"></body>
</html>`);
  doc.close();
  els.messagesDocument = doc;
  els.messages = doc.getElementById("messages-root");
  if (!els.messages) {
    throw new Error("Conversation message root is unavailable");
  }
  setupVirtualTranscriptDom();
  installVirtualTranscriptScroll();
  installMessagesSelectionTracking();
  installMessagesFrameResizeSync();
  scheduleMessagesFrameSync({ frames: 6, delays: [40, 120, 300, 800], force: true });
}

function emptyVirtualTranscriptState() {
  return {
    units: [],
    range: { start: 0, end: 0 },
    heights: new Map(),
    estimates: [],
    offsets: [0],
    totalHeight: 0,
    averageHeight: VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT,
    messageIndexToUnitIndex: new Map(),
    anchorIdToUnitIndex: new Map(),
    unitIdToIndex: new Map(),
    topSpacer: null,
    windowElement: null,
    bottomSpacer: null,
    renderFrame: null,
    measureFrame: null,
    resizeObserver: null,
    resolveTimer: null
  };
}

function resetVirtualTranscriptState({ clearDom = false } = {}) {
  disconnectVirtualTranscriptObservers();
  state.virtualTranscript = emptyVirtualTranscriptState();
  if (clearDom && els.messages) {
    els.messages.replaceChildren();
  }
}

function disconnectVirtualTranscriptObservers() {
  const transcript = state.virtualTranscript;
  if (!transcript) {
    return;
  }
  if (transcript.renderFrame !== null) {
    window.cancelAnimationFrame(transcript.renderFrame);
  }
  if (transcript.measureFrame !== null) {
    window.cancelAnimationFrame(transcript.measureFrame);
  }
  if (transcript.resolveTimer !== null) {
    window.clearTimeout(transcript.resolveTimer);
  }
  if (transcript.resizeObserver) {
    transcript.resizeObserver.disconnect();
  }
}

function setupVirtualTranscriptDom() {
  resetVirtualTranscriptState();
  const doc = els.messagesDocument || document;
  const topSpacer = doc.createElement("div");
  topSpacer.className = "virtual-transcript-spacer";
  topSpacer.setAttribute("aria-hidden", "true");

  const windowElement = doc.createElement("div");
  windowElement.className = "virtual-transcript-window";

  const bottomSpacer = doc.createElement("div");
  bottomSpacer.className = "virtual-transcript-spacer";
  bottomSpacer.setAttribute("aria-hidden", "true");

  els.messages.replaceChildren(topSpacer, windowElement, bottomSpacer);
  state.virtualTranscript.topSpacer = topSpacer;
  state.virtualTranscript.windowElement = windowElement;
  state.virtualTranscript.bottomSpacer = bottomSpacer;
}

function installVirtualTranscriptScroll() {
  if (!els.messages) {
    return;
  }
  els.messages.addEventListener("scroll", () => {
    scheduleVirtualTranscriptRender();
  }, { passive: true });
}

function installMessagesSelectionTracking() {
  const doc = els.messagesDocument;
  if (!doc) {
    return;
  }
  const update = () => updateSelectedTranscriptText();
  doc.addEventListener("selectionchange", update);
  doc.addEventListener("mouseup", update);
  doc.addEventListener("keyup", update);
}

function installMessagesFrameResizeSync() {
  if (state.messagesFrameResizeObserver || !els.messagesFrame) {
    return;
  }
  if ("ResizeObserver" in window) {
    state.messagesFrameResizeObserver = new ResizeObserver(() => {
      syncAskCodexLayout();
      scheduleMessagesFrameSync({ frames: 3, delays: [40, 120] });
    });
    for (const element of [
      els.messagesFrame,
      els.conversationView,
      els.conversationHeader,
      els.relatedPanel,
      els.messageFilters,
      els.askCodexPanel,
      els.askCodexQuestion
    ]) {
      if (element) {
        state.messagesFrameResizeObserver.observe(element);
      }
    }
  }
  window.addEventListener("resize", () => scheduleMessagesFrameSync({ frames: 3, delays: [100, 300] }));
  window.addEventListener("focus", () => scheduleMessagesFrameSync({ frames: 3, delays: [80] }));
  window.addEventListener("blur", () => syncMessagesFrameViewport());
}

function scheduleMessagesFrameSync({ frames = 2, delays = [], force = false, afterPaint = false } = {}) {
  if (state.messagesFrameSyncPending && !force) {
    return;
  }
  clearMessagesFrameSyncTimers();
  state.messagesFrameSyncPending = true;

  const runSync = () => {
    let pendingCallbacks = 0;
    const finishCallback = () => {
      pendingCallbacks -= 1;
      if (pendingCallbacks <= 0) {
        state.messagesFrameSyncPending = false;
        state.messagesFrameSyncTimers = [];
      }
    };
    const queueFrame = (remaining) => {
      pendingCallbacks += 1;
      const id = window.requestAnimationFrame(() => {
        syncMessagesFrameViewport();
        if (remaining > 0) {
          queueFrame(remaining - 1);
        }
        finishCallback();
      });
      state.messagesFrameSyncTimers.push({ type: "frame", id });
    };
    queueFrame(frames);
    for (const delay of delays) {
      pendingCallbacks += 1;
      const id = window.setTimeout(() => {
        syncMessagesFrameViewport();
        finishCallback();
      }, delay);
      state.messagesFrameSyncTimers.push({ type: "timeout", id });
    }
  };

  if (afterPaint) {
    const frameId = window.requestAnimationFrame(() => {
      const timeoutId = window.setTimeout(runSync, 0);
      state.messagesFrameSyncTimers.push({ type: "timeout", id: timeoutId });
    });
    state.messagesFrameSyncTimers.push({ type: "frame", id: frameId });
    return;
  }

  runSync();
}

function clearMessagesFrameSyncTimers() {
  for (const item of state.messagesFrameSyncTimers) {
    if (item.type === "frame") {
      window.cancelAnimationFrame(item.id);
    } else {
      window.clearTimeout(item.id);
    }
  }
  state.messagesFrameSyncTimers = [];
  state.messagesFrameSyncPending = false;
}

function syncMessagesFrameViewport(options = {}) {
  const syncDocument = options.syncDocument !== false;
  const materialize = options.materialize !== false;
  const frame = els.messagesFrame;
  const root = els.messages;
  const doc = els.messagesDocument;
  if (!frame || !root || !doc || els.conversationView.classList.contains("hidden")) {
    return false;
  }
  const frameRect = frame.getBoundingClientRect();
  const viewRect = els.conversationView.getBoundingClientRect();
  const contentWidth = Math.max(1, Math.round(viewRect.width));
  const scrollbarWidth = measureMessagesFrameScrollbarWidth(doc);
  const width = contentWidth + scrollbarWidth;
  const height = Math.max(1, Math.round(viewRect.bottom - frameRect.top));
  if (width <= 1 || height <= 1) {
    return false;
  }
  const widthPx = `${width}px`;
  const heightPx = `${height}px`;
  let changed = false;
  if (frame.getAttribute("width") !== String(width)) {
    frame.setAttribute("width", String(width));
    changed = true;
  }
  if (frame.getAttribute("height") !== String(height)) {
    frame.setAttribute("height", String(height));
    changed = true;
  }
  const sizedElements = syncDocument
    ? [frame, doc.documentElement, doc.body, root]
    : [frame];
  for (const element of sizedElements) {
    if (element.style.width !== widthPx) {
      element.style.width = widthPx;
      changed = true;
    }
    if (element.style.height !== heightPx) {
      element.style.height = heightPx;
      changed = true;
    }
  }
  if (changed && materialize) {
    // Force WebKitGTK to materialize the iframe viewport before the next paint.
    void frame.offsetWidth;
    void root.offsetWidth;
  }
  if (changed) {
    scheduleVirtualTranscriptRender();
  }
  return changed;
}

function measureMessagesFrameScrollbarWidth(doc) {
  if (state.messagesFrameScrollbarWidth !== null) {
    return state.messagesFrameScrollbarWidth;
  }
  const probe = doc.createElement("div");
  probe.style.cssText = [
    "position:absolute",
    "top:-9999px",
    "left:-9999px",
    "width:100px",
    "height:100px",
    "overflow:scroll",
    "visibility:hidden"
  ].join(";");
  const child = doc.createElement("div");
  child.style.width = "200px";
  child.style.height = "200px";
  probe.appendChild(child);
  doc.body.appendChild(probe);
  state.messagesFrameScrollbarWidth = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return state.messagesFrameScrollbarWidth;
}

function modeConfig() {
  return MODES[state.mode];
}

function listUrl() {
  const url = new URL(modeConfig().listUrl, window.location.origin);
  if (state.mode === "main") {
    url.searchParams.set("filter", state.mainFilter);
  }
  if (threadSearchUsesServer()) {
    url.searchParams.set("q", state.filter.trim());
    url.searchParams.set("full_text", "1");
  }
  return `${url.pathname}${url.search}`;
}

function threadSearchUsesServer() {
  return state.fullTextSearch && state.filter.trim().length > 0;
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

function loadThreadPanelWidth() {
  try {
    const storedValue = localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY);
    const stored = storedValue === null ? NaN : Number(storedValue);
    return clampThreadPanelWidth(Number.isFinite(stored) ? stored : THREAD_PANEL_DEFAULT_WIDTH);
  } catch {
    return THREAD_PANEL_DEFAULT_WIDTH;
  }
}

function saveThreadPanelWidth() {
  try {
    localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(Math.round(state.threadPanel.width)));
  } catch {
    // Ignore private browsing or storage quota failures.
  }
}

function loadThreadPanelCollapsed() {
  try {
    return localStorage.getItem(THREAD_PANEL_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveThreadPanelCollapsed() {
  try {
    localStorage.setItem(THREAD_PANEL_COLLAPSED_STORAGE_KEY, state.threadPanel.collapsed ? "1" : "0");
  } catch {
    // Ignore private browsing or storage quota failures.
  }
}

function threadPanelMaxWidth() {
  const viewportWidth = window.innerWidth || (THREAD_PANEL_DEFAULT_WIDTH + THREAD_PANEL_MIN_READER_WIDTH);
  if (viewportWidth <= THREAD_PANEL_STACKED_BREAKPOINT) {
    return THREAD_PANEL_MAX_WIDTH;
  }
  return Math.max(
    THREAD_PANEL_MIN_WIDTH,
    Math.min(THREAD_PANEL_MAX_WIDTH, viewportWidth - THREAD_PANEL_MIN_READER_WIDTH - THREAD_PANEL_RESIZER_WIDTH)
  );
}

function clampThreadPanelWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) {
    return THREAD_PANEL_DEFAULT_WIDTH;
  }
  return Math.max(THREAD_PANEL_MIN_WIDTH, Math.min(threadPanelMaxWidth(), width));
}

function applyThreadPanelLayout(options = {}) {
  const width = clampThreadPanelWidth(state.threadPanel.width);
  document.documentElement.style.setProperty("--thread-panel-width", `${Math.round(width)}px`);
  els.layout.classList.toggle("thread-panel-collapsed", state.threadPanel.collapsed);
  els.threadPanelToggle.textContent = state.threadPanel.collapsed ? ">" : "<";
  const action = state.threadPanel.collapsed ? "Expand conversations list" : "Collapse conversations list";
  els.threadPanelToggle.setAttribute("aria-expanded", String(!state.threadPanel.collapsed));
  els.threadPanelToggle.setAttribute("aria-label", action);
  els.threadPanelToggle.title = action;
  els.threadPanelResizer.setAttribute("aria-valuemin", String(THREAD_PANEL_MIN_WIDTH));
  els.threadPanelResizer.setAttribute("aria-valuemax", String(threadPanelMaxWidth()));
  els.threadPanelResizer.setAttribute("aria-valuenow", String(Math.round(width)));
  if (options.sync !== false) {
    scheduleMessagesFrameSync({
      frames: options.frames ?? 2,
      delays: options.delays ?? (state.threadPanel.dragging ? [] : [80, 240]),
      force: options.force === true
    });
  }
}

function setThreadPanelWidth(width, options = {}) {
  state.threadPanel.width = clampThreadPanelWidth(width);
  if (options.save !== false) {
    saveThreadPanelWidth();
  }
  applyThreadPanelLayout(options);
}

function setThreadPanelCollapsed(collapsed) {
  state.threadPanel.collapsed = Boolean(collapsed);
  saveThreadPanelCollapsed();
  applyThreadPanelLayout({ force: true });
  if (state.threadPanel.collapsed && els.threadPanel.contains(document.activeElement)) {
    els.threadPanelToggle.focus();
  }
  if (!state.threadPanel.collapsed) {
    window.setTimeout(() => scrollSelectedThreadIntoView({ behavior: "auto" }), 80);
  }
}

function installThreadPanelControls() {
  applyThreadPanelLayout();
  els.threadPanelToggle.addEventListener("click", () => {
    setThreadPanelCollapsed(!state.threadPanel.collapsed);
  });
  els.threadPanelResizer.addEventListener("pointerdown", startThreadPanelResize);
  els.threadPanelResizer.addEventListener("keydown", handleThreadPanelResizerKeydown);
  window.addEventListener("resize", () => {
    applyThreadPanelLayout();
  });
}

function startThreadPanelResize(event) {
  if (event.button !== 0 || state.threadPanel.collapsed) {
    return;
  }
  event.preventDefault();
  state.threadPanel.dragging = true;
  els.threadPanelResizer.classList.add("dragging");
  document.body.classList.add("resizing-thread-panel");
  updateThreadPanelWidthFromPointer(event, { save: false, sync: false });

  const pointerId = event.pointerId;
  try {
    els.threadPanelResizer.setPointerCapture(pointerId);
  } catch {
    // Older WebKitGTK builds can throw if pointer capture is unavailable.
  }

  const onMove = (moveEvent) => {
    if (moveEvent.pointerId === pointerId) {
      updateThreadPanelWidthFromPointer(moveEvent, { save: false, sync: false });
    }
  };
  let ended = false;
  const onEnd = (endEvent) => {
    if (ended || (endEvent.pointerId !== undefined && endEvent.pointerId !== pointerId)) {
      return;
    }
    ended = true;
    state.threadPanel.dragging = false;
    els.threadPanelResizer.classList.remove("dragging");
    document.body.classList.remove("resizing-thread-panel");
    saveThreadPanelWidth();
    applyThreadPanelLayout({ force: true, frames: 3, delays: [80] });
    try {
      if (els.threadPanelResizer.hasPointerCapture(pointerId)) {
        els.threadPanelResizer.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore pointer capture cleanup failures.
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    els.threadPanelResizer.removeEventListener("lostpointercapture", onEnd);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  els.threadPanelResizer.addEventListener("lostpointercapture", onEnd);
}

function updateThreadPanelWidthFromPointer(event, options = {}) {
  const rect = els.layout.getBoundingClientRect();
  setThreadPanelWidth(event.clientX - rect.left, options);
}

function handleThreadPanelResizerKeydown(event) {
  if (state.threadPanel.collapsed) {
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setThreadPanelWidth(state.threadPanel.width - THREAD_PANEL_KEYBOARD_STEP);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setThreadPanelWidth(state.threadPanel.width + THREAD_PANEL_KEYBOARD_STEP);
  } else if (event.key === "Home") {
    event.preventDefault();
    setThreadPanelWidth(THREAD_PANEL_MIN_WIDTH);
  } else if (event.key === "End") {
    event.preventDefault();
    setThreadPanelWidth(threadPanelMaxWidth());
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

function newAskCodexServerRequestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  state.pendingScrollTarget = null;
  resetVirtualTranscriptState({ clearDom: true });
}

function cancelScheduledConversationSearch() {
  if (state.conversationSearch.timer !== null) {
    window.clearTimeout(state.conversationSearch.timer);
    state.conversationSearch.timer = null;
  }
  if (state.conversationSearch.inputFrame !== null) {
    window.cancelAnimationFrame(state.conversationSearch.inputFrame);
    state.conversationSearch.inputFrame = null;
  }
}

function cancelConversationSearchWork() {
  state.conversationSearch.requestId += 1;
  state.conversationSearch.pendingWorkerSearch = false;
  if (state.conversationSearch.abortController) {
    state.conversationSearch.abortController.abort();
    state.conversationSearch.abortController = null;
  }
  if (state.conversationSearch.worker) {
    state.conversationSearch.worker.postMessage({
      type: "cancel",
      revision: state.conversationSearch.workerRevision
    });
  }
}

function setAskCodexRunning(running) {
  els.askCodexButton.textContent = running ? "Asking..." : "Ask";
  els.askCodexButton.disabled = running || els.askCodexQuestion.value.trim() === "" || !state.currentThread;
  els.askCodexStopButton.disabled = !running;
  els.askSelectedButton.disabled = running || !state.askCodex.selectedText || !state.currentThread;
}

function cancelAskCodexServerRequest(requestId) {
  if (!requestId) {
    return Promise.resolve(null);
  }
  return fetchJson("/api/ask-codex/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId })
  }).catch(() => null);
}

function cancelAskCodexRequest() {
  state.askCodex.requestId += 1;
  const serverRequestId = state.askCodex.serverRequestId;
  state.askCodex.serverRequestId = null;
  if (state.askCodex.abortController) {
    state.askCodex.abortController.abort();
    state.askCodex.abortController = null;
  }
  if (serverRequestId) {
    void cancelAskCodexServerRequest(serverRequestId);
  }
  setAskCodexRunning(false);
}

function stopAskCodexRequest() {
  const serverRequestId = state.askCodex.serverRequestId;
  if (!serverRequestId) {
    return;
  }
  const revision = state.askCodex.requestId + 1;
  state.askCodex.requestId = revision;
  state.askCodex.serverRequestId = null;
  if (state.askCodex.abortController) {
    state.askCodex.abortController.abort();
    state.askCodex.abortController = null;
  }
  setAskCodexRunning(false);
  els.askCodexStopButton.disabled = true;
  els.askCodexStatus.textContent = "Stopping Codex...";
  void cancelAskCodexServerRequest(serverRequestId).finally(() => {
    if (state.askCodex.requestId === revision && !state.askCodex.serverRequestId) {
      els.askCodexStatus.textContent = "Ask Codex stopped.";
    }
  });
}

function resetAskCodex() {
  cancelAskCodexRequest();
  clearAskCodexNavigationHighlights();
  state.askCodex.selectedText = "";
  state.askCodex.selectedMessageIndex = null;
  state.askCodex.turns = [];
  els.askCodexQuestion.value = "";
  els.askCodexButton.disabled = true;
  els.askSelectedButton.disabled = true;
  els.askCodexStatus.textContent = "Uses a compact filtered export.";
  els.askCodexAnswer.classList.add("hidden");
  els.askCodexPanel.classList.remove("has-answer");
  els.askCodexAnswer.replaceChildren();
  syncAskCodexLayout();
}

function updateSelectedTranscriptText() {
  const selection = els.messagesDocument?.getSelection?.();
  const textValue = collapseWhitespace(selection ? selection.toString() : "");
  state.askCodex.selectedText = textValue;
  state.askCodex.selectedMessageIndex = selectedMessageIndex(selection);
  els.askSelectedButton.disabled = Boolean(state.askCodex.serverRequestId) || !textValue || !state.currentThread;
  if (textValue) {
    const source = Number.isInteger(state.askCodex.selectedMessageIndex)
      ? ` in message ${state.askCodex.selectedMessageIndex + 1}`
      : "";
    els.askSelectedButton.title = `Ask about selected text${source}: ${trimForPrompt(textValue, 120)}`;
  } else {
    els.askSelectedButton.title = "Select text in the conversation transcript first.";
  }
}

function selectedMessageIndex(selection) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const startMessage = closestMessageElement(range.startContainer);
  const endMessage = closestMessageElement(range.endContainer);
  if (!startMessage || startMessage !== endMessage) {
    return null;
  }
  const index = Number(startMessage.dataset.messageIndex);
  return Number.isInteger(index) ? index : null;
}

function closestMessageElement(node) {
  let element = node && node.nodeType === 1 ? node : node?.parentElement;
  while (element && !element.classList?.contains("message")) {
    element = element.parentElement;
  }
  return element && element.classList?.contains("message") ? element : null;
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trimForPrompt(value, maxChars) {
  const textValue = String(value || "");
  if (textValue.length <= maxChars) {
    return textValue;
  }
  return `${textValue.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function yieldToBrowser() {
  if (window.scheduler?.yield) {
    return window.scheduler.yield();
  }
  return new Promise((resolve) => window.setTimeout(resolve, 0));
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

async function loadThreads({ preserveSelection = true, preserveHiddenSelection = false } = {}) {
  const requestId = state.listRequestId + 1;
  const usesServerSearch = threadSearchUsesServer();
  if (state.listAbortController) {
    state.listAbortController.abort();
  }
  const controller = new AbortController();
  state.listRequestId = requestId;
  state.listAbortController = controller;
  let threads;
  try {
    threads = await fetchJson(listUrl(), { signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    if (state.listAbortController === controller) {
      state.listAbortController = null;
    }
  }
  if (requestId !== state.listRequestId) return;
  state.serverSearchActive = usesServerSearch;
  state.threads = threads;
  await ensureVisibleSelection({ preserveSelection, preserveHiddenSelection });
}

async function setMode(mode) {
  if (state.mode === mode) return;
  cancelThreadSearchTimer();
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
    cancelThreadSearchTimer();
    state.pendingBranchId = options.branchId || null;
    const clearingServerSearch = state.mode === kind && state.serverSearchActive;
    if (state.mode !== kind) {
      cancelDetailRequest();
      state.mode = kind;
      state.selectedId = null;
      state.currentThread = null;
      state.filter = "";
      els.searchInput.value = "";
      renderMode();
      state.threads = await fetchJson(listUrl());
      state.serverSearchActive = false;
      renderThreadList();
    }
    state.filter = "";
    els.searchInput.value = "";
    if (clearingServerSearch && state.mode === kind) {
      await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    }
    await selectThread(threadId, { preservePendingBranch: true, scrollListBehavior: "smooth" });
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
  els.emptyStateMessage.textContent = config.empty;
  updateArchiveButton();
}

function updateArchiveButton() {
  const summary = state.currentThread?.summary;
  const canArchive = state.mode === "main" && summary && !summary.archived;
  els.archiveButton.disabled = !canArchive;
  els.archiveButton.textContent = summary?.archived ? "Archived" : "Archive";
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
      updateMessageFilterPresetState();
      rerenderMessagesForCurrentFilters();
    });

    const textNode = document.createElement("span");
    textNode.textContent = filter.label;
    label.append(input, textNode);
    els.messageFilterOptions.appendChild(label);
  }
  updateMessageFilterPresetState();
}

function setMessageFilters(filters) {
  state.messageFilters = { ...state.messageFilters, ...filters };
  saveMessageFilters();
  renderMessageFilterControls();
  rerenderMessagesForCurrentFilters();
}

function messageFiltersEqual(a, b) {
  return MESSAGE_FILTERS.every((filter) => a[filter.key] === b[filter.key]);
}

function currentMessageFilterPreset() {
  if (messageFiltersEqual(state.messageFilters, defaultMessageFilters())) {
    return "defaults";
  }
  if (messageFiltersEqual(state.messageFilters, allMessageFilters(true))) {
    return "all";
  }
  if (messageFiltersEqual(state.messageFilters, allMessageFilters(false))) {
    return "none";
  }
  return "custom";
}

function updateMessageFilterPresetState() {
  const activePreset = currentMessageFilterPreset();
  const buttons = {
    defaults: els.messageFilterDefaults,
    all: els.messageFilterAll,
    none: els.messageFilterNone,
    custom: els.messageFilterCustom
  };
  for (const [preset, button] of Object.entries(buttons)) {
    const active = preset === activePreset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function allMessageFilters(enabled) {
  const filters = {};
  for (const filter of MESSAGE_FILTERS) {
    filters[filter.key] = enabled;
  }
  return filters;
}

async function ensureVisibleSelection({ preserveSelection = true, preserveHiddenSelection = false } = {}) {
  const threads = filteredThreads();
  renderThreadList();
  const currentId = state.currentThread && state.currentThread.summary && state.currentThread.summary.id;
  const hasCurrentSelection = preserveSelection && state.selectedId && currentId === state.selectedId;
  if (threads.length === 0) {
    if (preserveHiddenSelection && hasCurrentSelection) {
      return;
    }
    clearConversation();
  } else if (preserveSelection && state.selectedId && threads.some((item) => item.id === state.selectedId)) {
    if (currentId !== state.selectedId) {
      await selectThread(state.selectedId);
    } else {
      scrollSelectedThreadIntoView();
    }
  } else if (preserveHiddenSelection && hasCurrentSelection) {
    return;
  } else {
    await selectThread(threads[0].id);
  }
}

function cancelThreadSearchTimer() {
  if (state.threadSearchTimer !== null) {
    window.clearTimeout(state.threadSearchTimer);
    state.threadSearchTimer = null;
  }
}

function scheduleThreadSearch({ immediate = false } = {}) {
  cancelThreadSearchTimer();
  if (threadSearchUsesServer() && !immediate) {
    els.threadStats.textContent = "Searching full text...";
    state.threadSearchTimer = window.setTimeout(() => {
      state.threadSearchTimer = null;
      applyThreadSearch().catch(showError);
    }, THREAD_FULL_TEXT_SEARCH_DEBOUNCE_MS);
    return;
  }
  applyThreadSearch().catch(showError);
}

async function applyThreadSearch() {
  if (threadSearchUsesServer()) {
    els.threadStats.textContent = "Searching full text...";
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    return;
  }
  if (state.serverSearchActive) {
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    return;
  }
  await ensureVisibleSelection();
}

function filteredThreads() {
  const query = state.filter.trim().toLowerCase();
  if (state.serverSearchActive && query) return state.threads;
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
      thread.meta_label,
      thread.search_match
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderThreadList() {
  const threads = filteredThreads();
  const noun = state.mode === "main" ? MAIN_FILTER_LABELS[state.mainFilter] : "recovered";
  els.threadStats.textContent = state.serverSearchActive && state.filter.trim()
    ? `${threads.length} full-text ${threads.length === 1 ? "match" : "matches"}`
    : `${threads.length} shown, ${state.threads.length} ${noun}`;
  els.threadList.replaceChildren();

  for (const thread of threads) {
    const previewText = thread.preview || "(no title)";
    const metaText = thread.meta_label || `${thread.user_count || 0} user, ${thread.assistant_count || 0} assistant`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${thread.id === state.selectedId ? " active" : ""}`;
    button.dataset.threadId = thread.id;
    button.tabIndex = -1;
    button.addEventListener("click", () => selectThread(thread.id));

    const time = document.createElement("div");
    time.className = "thread-time";
    time.dir = "ltr";
    time.textContent = thread.updated || thread.started || "unknown time";

    const preview = document.createElement("div");
    preview.className = "thread-preview";
    setAutoDirection(preview, previewText);
    preview.textContent = previewText;

    const searchMatch = document.createElement("div");
    searchMatch.className = "thread-search-match";
    if (thread.search_match) {
      setAutoDirection(searchMatch, thread.search_match);
      searchMatch.textContent = thread.search_match;
    }

    const meta = document.createElement("div");
    meta.className = "thread-meta";
    setAutoDirection(meta, metaText);
    meta.textContent = metaText;

    if (thread.search_match) {
      button.append(time, preview, searchMatch, meta);
    } else {
      button.append(time, preview, meta);
    }
    els.threadList.appendChild(button);
  }
}

function scrollSelectedThreadIntoView({ behavior = "auto" } = {}) {
  if (!state.selectedId) {
    return;
  }
  const selected = els.threadList.querySelector(".thread-item.active");
  if (!selected) {
    return;
  }
  selected.scrollIntoView({
    behavior,
    block: "center",
    inline: "nearest"
  });
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
  scrollSelectedThreadIntoView({ behavior: options.scrollListBehavior || "auto" });
  els.exportButton.disabled = true;
  els.exportFormatSelect.disabled = true;
  els.copyIdButton.disabled = true;
  updateArchiveButton();
  resetAskCodex();
  try {
    const detail = await fetchJson(modeConfig().detailUrl(threadId), { signal: controller.signal });
    if (requestId !== state.detailRequestId) {
      return;
    }
    state.currentThread = detail;
    await renderConversation(detail);
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
  state.expandedMessages = new Set();
  state.expandedToolRuns = new Set();
  state.toolRunByMessageIndex = new Map();
  resetConversationSearch();
  resetAskCodex();
  els.emptyState.classList.remove("hidden");
  els.conversationView.classList.add("hidden");
  els.relatedPanel.classList.add("hidden");
  els.relatedPanel.replaceChildren();
  els.exportButton.disabled = true;
  els.exportFormatSelect.disabled = true;
  els.copyIdButton.disabled = true;
  updateArchiveButton();
}

async function renderConversation(detail) {
  cancelScrollAnimation();
  cancelConversationSearchWork();
  clearConversationHighlights();
  markFinalAssistantReplies(detail.messages || []);
  state.expandedMessages = new Set();
  state.expandedToolRuns = new Set();
  state.toolRunByMessageIndex = new Map();
  const renderRequestId = state.renderRequestId + 1;
  state.renderRequestId = renderRequestId;
  const summary = detail.summary;
  els.emptyState.classList.add("hidden");
  els.conversationView.classList.remove("hidden");
  els.exportButton.disabled = false;
  els.exportFormatSelect.disabled = false;
  els.copyIdButton.disabled = false;
  updateArchiveButton();
  els.conversationSearchInput.disabled = false;
  els.conversationSearchClear.disabled = els.conversationSearchInput.value.trim() === "";
  resetAskCodex();
  setAskCodexRunning(false);

  els.conversationTitle.textContent = summary.preview || "Conversation";
  els.conversationMeta.textContent = `${text(summary.started)} to ${text(summary.ended || summary.updated)}`;
  els.metaId.textContent = summary.id;
  els.metaCount.textContent = `${summary.message_count} shown`;
  els.metaModel.textContent = text(summary.model);
  els.metaCwd.textContent = text(summary.cwd);
  renderRelated(
    detail.related || {},
    summary,
    detail.compactions || [],
    rollbackLinksFor(detail.messages || [], detail.rollbacks || [])
  );

  await nextFrame();
  if (renderRequestId !== state.renderRequestId) {
    return;
  }
  setupMessagesFrame();
  syncMessagesFrameViewport();
  await nextFrame();
  if (renderRequestId !== state.renderRequestId) {
    return;
  }
  syncMessagesFrameViewport();
  setupVirtualTranscriptDom();
  const branchGroups = branchGroupsFor(detail);
  await renderMessages(detail, branchGroups, renderRequestId);
}

function markFinalAssistantReplies(messages) {
  for (const message of messages) {
    Object.defineProperty(message, "__finalAssistantReply", {
      value: false,
      writable: true,
      configurable: true
    });
  }

  let lastAssistantIndex = null;
  const markLastAssistant = () => {
    if (lastAssistantIndex !== null && messages[lastAssistantIndex]) {
      messages[lastAssistantIndex].__finalAssistantReply = true;
    }
    lastAssistantIndex = null;
  };

  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      markLastAssistant();
      continue;
    }
    if (message.role === "assistant") {
      lastAssistantIndex = index;
    }
  }
  markLastAssistant();
}

async function renderMessages(detail, branchGroups, renderRequestId) {
  if (renderRequestId !== state.renderRequestId) {
    return;
  }
  state.toolRunByMessageIndex = new Map();
  const { units, renderedMessages } = buildMessageUnits(detail, branchGroups, renderRequestId);
  if (renderRequestId !== state.renderRequestId) {
    return;
  }
  await renderMessageUnits(units, renderRequestId);
  updateMessageCount(renderedMessages, detail.messages.length);
  scheduleMessagesFrameSync({ frames: 4, delays: [80, 240, 700], force: true });
  scheduleConversationSearch({ immediate: true });
  scrollToPendingBranch();
}

function buildMessageUnits(detail, branchGroups, renderRequestId) {
  const units = [];
  let renderedMessages = 0;
  let pendingToolRun = [];
  const rollbackGroups = collectRollbackGroups(detail.messages || []);
  const jumpMarkers = jumpMarkersFor(detail, rollbackGroups);
  const flushToolRun = () => {
    if (pendingToolRun.length === 0) {
      return;
    }
    if (pendingToolRun.length >= TOOL_RUN_GROUP_MIN_SIZE) {
      units.push(toolRunUnit(pendingToolRun));
    } else {
      for (const item of pendingToolRun) {
        units.push(messageUnit(item.message, item.index));
      }
    }
    pendingToolRun = [];
  };

  const startBranches = branchGroups.get("-1");
  if (startBranches && startBranches.length > 0) {
    units.push(branchUnit(startBranches, -1));
  }

  for (const [index, message] of detail.messages.entries()) {
    if (renderRequestId !== state.renderRequestId) {
      break;
    }
    if (isMessageVisibleByFilter(message)) {
      if (rollbackGroups.groupedIndexes.has(index)) {
        flushToolRun();
        const group = rollbackGroups.firstIndexToGroup.get(index);
        if (group) {
          units.push(rollbackGroupUnit(group));
          renderedMessages += group.length;
        }
      } else if (message.role === "tool" && !shouldUseDiffOnlyView(message)) {
        pendingToolRun.push({ message, index });
        renderedMessages += 1;
      } else {
        flushToolRun();
        units.push(messageUnit(message, index));
        renderedMessages += 1;
      }
    }
    const branches = branchGroups.get(String(index));
    if (branches && branches.length > 0) {
      flushToolRun();
      units.push(branchUnit(branches, index));
    }
    const markers = jumpMarkers.get(String(index));
    if (markers && markers.length > 0) {
      flushToolRun();
      units.push(jumpMarkerUnit(markers, index));
    }
  }
  flushToolRun();
  return { units, renderedMessages };
}

function collectRollbackGroups(messages, options = {}) {
  const respectFilters = options.respectFilters !== false;
  const groupsByKey = new Map();
  for (const [index, message] of messages.entries()) {
    if (!message.rolled_back || (respectFilters && !isMessageVisibleByFilter(message))) {
      continue;
    }
    const item = { message, index };
    const key = rollbackGroupKey(item);
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, []);
    }
    groupsByKey.get(key).push(item);
  }

  const groups = [];
  const firstIndexToGroup = new Map();
  const groupedIndexes = new Set();
  for (const group of groupsByKey.values()) {
    if (group.length === 0) {
      continue;
    }
    const rollbackTimestamp = group.find((item) => item.message?.rolled_back_by_timestamp)?.message?.rolled_back_by_timestamp;
    const firstRolledIndex = group[0].index;
    const rollbackEventIndex = rollbackEventIndexForGroup(messages, rollbackTimestamp, firstRolledIndex);
    const eventEndIndex = rollbackEventIndex ?? group[group.length - 1].index;
    for (let index = firstRolledIndex; index <= eventEndIndex; index += 1) {
      const message = messages[index];
      if (!message || message.rolled_back || message.role !== "event" || (respectFilters && !isMessageVisibleByFilter(message))) {
        continue;
      }
      group.push({ message, index });
    }
    group.sort((left, right) => left.index - right.index);
    firstIndexToGroup.set(group[0].index, group);
    for (const item of group) {
      groupedIndexes.add(item.index);
    }
    groups.push(group);
  }
  return { firstIndexToGroup, groupedIndexes, groups };
}

function rollbackEventIndexForGroup(messages, rollbackTimestamp, startIndex) {
  if (rollbackTimestamp === undefined || rollbackTimestamp === null) {
    return null;
  }
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "event" && message.phase === "rollback" && message.timestamp === rollbackTimestamp) {
      return index;
    }
  }
  return null;
}

function rollbackGroupKey(item) {
  return item.message?.rollback_group
    || item.message?.rolled_back_by_timestamp
    || item.message?.rolled_back_at
    || item.index;
}

function messageUnit(message, index) {
  return {
    type: "message",
    message,
    index,
    startIndex: index,
    endIndex: index,
    messageCount: 1
  };
}

function toolRunUnit(run) {
  const first = run[0];
  const last = run[run.length - 1];
  return {
    type: "toolRun",
    run,
    startIndex: first.index,
    endIndex: last.index,
    messageCount: run.length
  };
}

function rollbackGroupUnit(group) {
  const first = group[0];
  const last = group[group.length - 1];
  return {
    type: "rollbackGroup",
    group,
    startIndex: first.index,
    endIndex: last.index,
    messageCount: group.length
  };
}

function jumpMarkerUnit(markers, index) {
  return {
    type: "jumpMarker",
    markers,
    startIndex: index,
    endIndex: index,
    messageCount: 0
  };
}

function rollbackLinksFor(messages, rollbackCheckpoints = []) {
  const rollbackGroups = collectRollbackGroups(messages, { respectFilters: false });
  if (rollbackCheckpoints.length === 0) {
    return rollbackGroups.groups.map((group, index) => rollbackLinkForGroup(group, { ordinal: index + 1 }));
  }
  return rollbackCheckpoints.map((checkpoint) => rollbackLinkForCheckpoint(checkpoint, rollbackGroups.groups, messages));
}

function rollbackLinkForGroup(group, fallback = {}) {
  const first = group[0];
  const last = group[group.length - 1];
  const rollbackEvent = group.find((item) => item.message?.role === "event" && item.message?.phase === "rollback");
  const fallbackEventIndex = Number.isInteger(fallback.message_index)
    ? fallback.message_index
    : (Number.isInteger(fallback.eventIndex) ? fallback.eventIndex : null);
  return {
    ordinal: fallback.ordinal ?? null,
    groupId: rollbackGroupId(first.index, last.index),
    messageIndex: first.index,
    eventIndex: fallbackEventIndex ?? rollbackEvent?.index ?? null,
    lineNumber: fallback.line_number ?? fallback.lineNumber ?? null,
    startIndex: first.index,
    endIndex: last.index,
    time: fallback.time || rollbackEvent?.message?.time || first.message?.rolled_back_at || "",
    summary: rollbackLinkSummary(fallback.summary, rollbackLinkPreview(group))
  };
}

function rollbackLinkForCheckpoint(checkpoint, groups, messages) {
  const eventIndex = rollbackEventIndexForCheckpoint(checkpoint, messages);
  const group = groups.find((candidate) => candidate.some((item) => item.index === eventIndex))
    || groups.find((candidate) => candidate.some((item) => (
      item.message?.rolled_back_by_timestamp !== undefined
      && item.message?.rolled_back_by_timestamp !== null
      && String(item.message.rolled_back_by_timestamp) === String(checkpoint.timestamp)
    )));
  if (group) {
    return rollbackLinkForGroup(group, checkpoint);
  }
  return {
    ordinal: checkpoint.ordinal ?? null,
    groupId: null,
    messageIndex: Number.isInteger(eventIndex) ? eventIndex : checkpoint.message_index,
    eventIndex: Number.isInteger(eventIndex) ? eventIndex : checkpoint.message_index,
    lineNumber: checkpoint.line_number ?? null,
    startIndex: null,
    endIndex: null,
    time: checkpoint.time || "",
    summary: checkpoint.summary || "Rollback marker"
  };
}

function rollbackEventIndexForCheckpoint(checkpoint, messages) {
  if (Number.isInteger(checkpoint?.message_index)) {
    return checkpoint.message_index;
  }
  if (checkpoint?.timestamp === undefined || checkpoint?.timestamp === null) {
    return null;
  }
  const index = messages.findIndex((message) => (
    message?.role === "event"
    && message.phase === "rollback"
    && message.timestamp !== undefined
    && message.timestamp !== null
    && String(message.timestamp) === String(checkpoint.timestamp)
  ));
  return index >= 0 ? index : null;
}

function rollbackLinkSummary(checkpointSummary, groupSummary) {
  if (!checkpointSummary) {
    return groupSummary || "";
  }
  if (!groupSummary || groupSummary === checkpointSummary) {
    return checkpointSummary;
  }
  return `${checkpointSummary} | ${groupSummary}`;
}

function branchUnit(branches, anchorIndex = null) {
  return {
    type: "branch",
    branches,
    startIndex: Number.isInteger(anchorIndex) ? anchorIndex : null,
    endIndex: Number.isInteger(anchorIndex) ? anchorIndex : null,
    messageCount: 0
  };
}

async function renderMessageUnits(units, renderRequestId) {
  if (renderRequestId !== state.renderRequestId) {
    return;
  }
  prepareVirtualTranscript(units);
  renderVirtualTranscriptWindow({ force: true });
  await nextFrame();
  if (renderRequestId === state.renderRequestId) {
    measureRenderedVirtualUnits({ resolve: true });
  }
}

function renderUnit(unit) {
  if (unit.type === "message") {
    return renderMessage(unit.message, unit.index);
  }
  if (unit.type === "toolRun") {
    return renderToolRun(unit.run);
  }
  if (unit.type === "rollbackGroup") {
    return renderRollbackGroup(unit.group);
  }
  if (unit.type === "jumpMarker") {
    return renderJumpMarker(unit.markers);
  }
  return renderBranchMarker(unit.branches);
}

function prepareVirtualTranscript(units) {
  disconnectVirtualTranscriptObservers();
  if (
    !state.virtualTranscript.topSpacer
    || !state.virtualTranscript.windowElement
    || !state.virtualTranscript.bottomSpacer
    || !state.virtualTranscript.windowElement.isConnected
  ) {
    setupVirtualTranscriptDom();
  }
  const transcript = state.virtualTranscript;
  transcript.units = units.map((unit, index) => ({
    ...unit,
    id: virtualUnitId(unit, index)
  }));
  transcript.range = { start: 0, end: 0 };
  transcript.heights = new Map();
  transcript.estimates = transcript.units.map(estimateVirtualUnitHeight);
  transcript.averageHeight = averageVirtualUnitHeight(transcript.estimates);
  transcript.messageIndexToUnitIndex = new Map();
  transcript.anchorIdToUnitIndex = new Map();
  transcript.unitIdToIndex = new Map();
  indexVirtualTranscriptUnits();
  rebuildVirtualTranscriptOffsets();
  updateVirtualTranscriptSpacers(0, 0);
}

function virtualUnitId(unit, index) {
  if (unit.type === "message") {
    return `message-${unit.index}`;
  }
  if (unit.type === "toolRun") {
    return toolRunId(unit.startIndex, unit.endIndex);
  }
  if (unit.type === "rollbackGroup") {
    return rollbackGroupId(unit.startIndex, unit.endIndex);
  }
  if (unit.type === "jumpMarker") {
    return `jump-${unit.startIndex}-${unit.markers.map((marker) => marker.id).join("-")}`;
  }
  if (unit.type === "branch") {
    return `branch-${unit.startIndex ?? "start"}-${unit.branches.map((branch) => branch.item?.id || "").join("-")}`;
  }
  return `${unit.type || "unit"}-${index}`;
}

function indexVirtualTranscriptUnits() {
  const transcript = state.virtualTranscript;
  transcript.unitIdToIndex.clear();
  transcript.messageIndexToUnitIndex.clear();
  transcript.anchorIdToUnitIndex.clear();
  state.toolRunByMessageIndex = new Map();
  for (const [unitIndex, unit] of transcript.units.entries()) {
    transcript.unitIdToIndex.set(unit.id, unitIndex);
    if (unit.type === "message") {
      transcript.messageIndexToUnitIndex.set(unit.index, unitIndex);
      continue;
    }
    if (unit.type === "toolRun") {
      const runId = toolRunId(unit.startIndex, unit.endIndex);
      for (const item of unit.run || []) {
        transcript.messageIndexToUnitIndex.set(item.index, unitIndex);
        state.toolRunByMessageIndex.set(item.index, runId);
      }
      continue;
    }
    if (unit.type === "rollbackGroup") {
      const groupId = rollbackGroupId(unit.startIndex, unit.endIndex);
      for (const item of unit.group || []) {
        transcript.messageIndexToUnitIndex.set(item.index, unitIndex);
        state.toolRunByMessageIndex.set(item.index, groupId);
      }
      continue;
    }
    if (unit.type === "jumpMarker") {
      if (Number.isInteger(unit.startIndex)) {
        transcript.messageIndexToUnitIndex.set(unit.startIndex, unitIndex);
      }
      for (const marker of unit.markers || []) {
        if (marker.id) {
          transcript.anchorIdToUnitIndex.set(marker.id, unitIndex);
        }
      }
      continue;
    }
    if (unit.type === "branch") {
      for (const branch of unit.branches || []) {
        if (branch.item?.id) {
          transcript.anchorIdToUnitIndex.set(branchMarkerId(branch.item.id), unitIndex);
        }
      }
    }
  }
}

function estimateVirtualUnitHeight(unit) {
  if (unit.type === "message") {
    return estimateVirtualMessageHeight(unit.message, unit.index);
  }
  if (unit.type === "toolRun") {
    const runId = toolRunId(unit.startIndex, unit.endIndex);
    if (!state.expandedToolRuns.has(runId)) {
      return 52;
    }
    return 60 + estimateVirtualChildItemsHeight(unit.run || []);
  }
  if (unit.type === "rollbackGroup") {
    const groupId = rollbackGroupId(unit.startIndex, unit.endIndex);
    if (!state.expandedToolRuns.has(groupId)) {
      return 58;
    }
    return 66 + estimateVirtualChildItemsHeight(unit.group || []);
  }
  if (unit.type === "branch") {
    return 50 + ((unit.branches || []).length * 58);
  }
  if (unit.type === "jumpMarker") {
    return 50 + ((unit.markers || []).length * 58);
  }
  return VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT;
}

function estimateVirtualChildItemsHeight(items) {
  let total = 0;
  for (const item of items) {
    total += estimateVirtualMessageHeight(item.message, item.index);
  }
  if (items.length > 1) {
    total += (items.length - 1) * VIRTUAL_TRANSCRIPT_GAP_PX;
  }
  return total;
}

function estimateVirtualMessageHeight(message, index = null) {
  if (!message) {
    return VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT;
  }
  const collapsed = COLLAPSED_MESSAGE_ROLES.has(message.role) || message.rolled_back;
  if (collapsed && !state.expandedMessages.has(index)) {
    return 48;
  }
  const textValue = messageViewText(message);
  const lineCount = String(textValue || "").split(/\r\n|\r|\n/).length;
  const wrappedLines = Math.ceil(String(textValue || "").length / 92);
  const estimatedBodyLines = Math.max(lineCount, wrappedLines);
  const bodyHeight = Math.min(900, Math.max(26, estimatedBodyLines * 22));
  return 46 + bodyHeight + 18;
}

function averageVirtualUnitHeight(heights) {
  if (!heights.length) {
    return VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT;
  }
  const total = heights.reduce((sum, height) => sum + height, 0);
  return Math.max(48, Math.round(total / heights.length));
}

function virtualUnitHeight(index) {
  const transcript = state.virtualTranscript;
  const unit = transcript.units[index];
  if (!unit) {
    return transcript.averageHeight || VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT;
  }
  return transcript.heights.get(unit.id) || transcript.estimates[index] || transcript.averageHeight || VIRTUAL_TRANSCRIPT_DEFAULT_UNIT_HEIGHT;
}

function rebuildVirtualTranscriptOffsets() {
  const transcript = state.virtualTranscript;
  const offsets = [0];
  let total = 0;
  for (let index = 0; index < transcript.units.length; index += 1) {
    if (index > 0) {
      total += VIRTUAL_TRANSCRIPT_GAP_PX;
    }
    offsets[index] = total;
    total += virtualUnitHeight(index);
  }
  offsets[transcript.units.length] = total;
  transcript.offsets = offsets;
  transcript.totalHeight = total;
}

function scheduleVirtualTranscriptRender(options = {}) {
  const transcript = state.virtualTranscript;
  if (!els.messages || !transcript.windowElement || transcript.units.length === 0) {
    return;
  }
  if (options.force) {
    renderVirtualTranscriptWindow({ force: true });
    return;
  }
  if (transcript.renderFrame !== null) {
    return;
  }
  transcript.renderFrame = window.requestAnimationFrame(() => {
    transcript.renderFrame = null;
    renderVirtualTranscriptWindow();
  });
}

function renderVirtualTranscriptWindow(options = {}) {
  const transcript = state.virtualTranscript;
  if (!els.messages || !transcript.windowElement) {
    return;
  }
  if (transcript.units.length === 0) {
    transcript.windowElement.replaceChildren();
    updateVirtualTranscriptSpacers(0, 0);
    transcript.range = { start: 0, end: 0 };
    return;
  }
  const range = virtualRangeForViewport();
  if (!options.force && range.start === transcript.range.start && range.end === transcript.range.end) {
    updateVirtualTranscriptSpacers(range.start, range.end);
    return;
  }

  clearVirtualTranscriptObserver();
  const fragment = document.createDocumentFragment();
  for (let index = range.start; index < range.end; index += 1) {
    const unit = transcript.units[index];
    const element = renderUnit(unit);
    element.dataset.virtualUnitIndex = String(index);
    element.dataset.virtualUnitId = unit.id;
    fragment.appendChild(element);
  }
  transcript.windowElement.replaceChildren(fragment);
  transcript.range = range;
  updateVirtualTranscriptSpacers(range.start, range.end);
  restoreActiveConversationSearchHighlight();
  observeRenderedVirtualUnits();
  scheduleVirtualTranscriptMeasure({ resolve: true });
}

function virtualRangeForViewport() {
  const transcript = state.virtualTranscript;
  const viewportHeight = Math.max(1, els.messages.clientHeight || 1);
  const overscan = Math.max(VIRTUAL_TRANSCRIPT_MIN_OVERSCAN_PX, viewportHeight * VIRTUAL_TRANSCRIPT_OVERSCAN_VIEWPORTS);
  const startOffset = Math.max(0, els.messages.scrollTop - overscan);
  const endOffset = Math.min(transcript.totalHeight, els.messages.scrollTop + viewportHeight + overscan);
  const start = Math.max(0, virtualUnitIndexAtOffset(startOffset) - 1);
  const end = Math.min(transcript.units.length, virtualUnitIndexAtOffset(endOffset) + 2);
  return { start, end: Math.max(start + 1, end) };
}

function virtualUnitIndexAtOffset(offset) {
  const offsets = state.virtualTranscript.offsets;
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const next = offsets[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < offsets[mid]) {
      high = mid - 1;
    } else if (offset >= next) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(offsets.length - 2, low));
}

function updateVirtualTranscriptSpacers(start, end) {
  const transcript = state.virtualTranscript;
  if (!transcript.topSpacer || !transcript.bottomSpacer) {
    return;
  }
  const top = Math.max(0, transcript.offsets[start] || 0);
  const bottom = Math.max(0, transcript.totalHeight - (transcript.offsets[end] || transcript.totalHeight));
  transcript.topSpacer.style.height = `${Math.round(top)}px`;
  transcript.bottomSpacer.style.height = `${Math.round(bottom)}px`;
}

function clearVirtualTranscriptObserver() {
  const transcript = state.virtualTranscript;
  if (transcript.resizeObserver) {
    transcript.resizeObserver.disconnect();
    transcript.resizeObserver = null;
  }
}

function observeRenderedVirtualUnits() {
  const transcript = state.virtualTranscript;
  if (!("ResizeObserver" in window) || !transcript.windowElement) {
    return;
  }
  transcript.resizeObserver = new ResizeObserver(() => {
    scheduleVirtualTranscriptMeasure();
  });
  for (const element of transcript.windowElement.children) {
    transcript.resizeObserver.observe(element);
  }
}

function scheduleVirtualTranscriptMeasure(options = {}) {
  const transcript = state.virtualTranscript;
  if (transcript.measureFrame !== null) {
    return;
  }
  transcript.measureFrame = window.requestAnimationFrame(() => {
    transcript.measureFrame = null;
    measureRenderedVirtualUnits(options);
  });
}

function measureRenderedVirtualUnits(options = {}) {
  const transcript = state.virtualTranscript;
  if (!transcript.windowElement) {
    return;
  }
  let changed = false;
  let measuredTotal = 0;
  let measuredCount = 0;
  for (const element of transcript.windowElement.children) {
    const unitId = element.dataset.virtualUnitId;
    if (!unitId) {
      continue;
    }
    const height = Math.ceil(element.getBoundingClientRect().height);
    if (height <= 0) {
      continue;
    }
    measuredTotal += height;
    measuredCount += 1;
    const previous = transcript.heights.get(unitId);
    if (!previous || Math.abs(previous - height) > VIRTUAL_TRANSCRIPT_MEASURE_TOLERANCE_PX) {
      transcript.heights.set(unitId, height);
      changed = true;
    }
  }
  if (measuredCount > 0) {
    transcript.averageHeight = Math.max(48, Math.round(measuredTotal / measuredCount));
  }
  if (changed) {
    rebuildVirtualTranscriptOffsets();
    updateVirtualTranscriptSpacers(transcript.range.start, transcript.range.end);
    scheduleVirtualTranscriptRender();
    if (options.resolve) {
      schedulePendingScrollResolution(0);
      return;
    }
  }
  if (options.resolve) {
    resolvePendingScrollTarget();
  }
}

function restoreActiveConversationSearchHighlight() {
  if (
    state.conversationSearch.activeIndex < 0
    || state.conversationSearch.totalMatches === 0
    || !state.conversationSearch.lowerQuery
  ) {
    return false;
  }
  const active = searchMatchAtIndex(state.conversationSearch.activeIndex);
  if (!active) {
    return false;
  }
  const wrapper = findRenderedMessageWrapper(active.messageIndex);
  if (!wrapper) {
    return false;
  }
  if (wrapper.classList.contains("collapsed")) {
    expandCollapsedMessage(wrapper);
  }
  const body = wrapper.querySelector(".message-body") || ensureLazyMessageBody(wrapper);
  ensureMessageBodyRendered(body);
  body.hidden = false;
  const mark = highlightNthSearchInElement(
    body,
    state.conversationSearch.lowerQuery,
    state.conversationSearch.queryLength,
    active.occurrenceIndex
  );
  if (!mark) {
    return false;
  }
  state.conversationSearch.activeMarks = [mark];
  return true;
}

function rerenderMessagesForCurrentFilters() {
  if (!state.currentThread) {
    return;
  }
  cancelScrollAnimation();
  cancelConversationSearchWork();
  clearConversationHighlights();
  clearAskCodexNavigationHighlights();
  const renderRequestId = state.renderRequestId + 1;
  state.renderRequestId = renderRequestId;
  state.toolRunByMessageIndex = new Map();
  setupVirtualTranscriptDom();
  renderMessages(state.currentThread, branchGroupsFor(state.currentThread), renderRequestId);
}

function renderRelated(related, summary, compactions = [], rollbacks = []) {
  const sections = [
    { title: "Parent conversation", items: related.parents || [], fallbackKind: "main", isParent: true },
    { title: "Forked conversations", items: related.forks || [], fallbackKind: "main", isParent: false },
    { title: "Side conversations", items: related.side || [], fallbackKind: "side", isParent: false }
  ].filter(({ items }) => items.length > 0);

  els.relatedPanel.replaceChildren();
  if (sections.length === 0 && compactions.length === 0 && rollbacks.length === 0) {
    els.relatedPanel.classList.add("hidden");
    return;
  }

  if (rollbacks.length > 0) {
    els.relatedPanel.appendChild(renderRollbackSection(rollbacks));
  }

  if (compactions.length > 0) {
    els.relatedPanel.appendChild(renderCompactionSection(compactions, summary));
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
      toggleRelatedSection(section, list, toggle);
    });
    for (const item of items) {
      list.appendChild(renderRelatedItem(item, item.kind || fallbackKind, { jumpToBranch: true }));
    }
    section.appendChild(list);
    els.relatedPanel.appendChild(section);
  }
  els.relatedPanel.classList.remove("hidden");
}

function renderRollbackSection(rollbacks) {
  const section = document.createElement("section");
  section.className = "related-section collapsed";

  const heading = document.createElement("h3");
  const toggle = document.createElement("button");
  const listId = "related-list-rollbacks";
  toggle.type = "button";
  toggle.className = "related-heading";
  toggle.setAttribute("aria-controls", listId);
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = `Rollbacks (${rollbacks.length})`;
  heading.appendChild(toggle);
  section.appendChild(heading);

  const list = document.createElement("div");
  list.id = listId;
  list.className = "related-list";
  list.hidden = true;
  toggle.addEventListener("click", () => {
    toggleRelatedSection(section, list, toggle);
  });

  for (const rollback of rollbacks) {
    list.appendChild(renderRollbackLink(rollback));
  }
  section.appendChild(list);
  return section;
}

function renderRollbackLink(rollback) {
  const wrapper = document.createElement("button");
  wrapper.type = "button";
  wrapper.className = "related-item rollback-item";
  wrapper.title = "Scroll to this rollback in the conversation";
  wrapper.addEventListener("click", () => scrollToRollbackLink(rollback));

  const title = document.createElement("span");
  title.className = "related-title";
  title.textContent = `${rollback.ordinal}. Rollback`;

  const meta = document.createElement("span");
  meta.className = "related-meta";
  const metaText = [rollback.time, rollback.summary].filter(Boolean).join(" | ");
  setAutoDirection(meta, metaText);
  meta.textContent = metaText;

  wrapper.append(title, meta);
  return wrapper;
}

function renderCompactionSection(compactions, summary) {
  const section = document.createElement("section");
  section.className = "related-section collapsed";

  const heading = document.createElement("h3");
  const toggle = document.createElement("button");
  const listId = "related-list-compactions";
  toggle.type = "button";
  toggle.className = "related-heading";
  toggle.setAttribute("aria-controls", listId);
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = `Compaction checkpoints (${compactions.length})`;
  heading.appendChild(toggle);
  section.appendChild(heading);

  const list = document.createElement("div");
  list.id = listId;
  list.className = "related-list";
  list.hidden = true;
  toggle.addEventListener("click", () => {
    toggleRelatedSection(section, list, toggle);
  });

  for (const checkpoint of compactions) {
    list.appendChild(renderCompactionItem(checkpoint, summary));
  }
  section.appendChild(list);
  return section;
}

function toggleRelatedSection(section, list, toggle) {
  const collapsed = section.classList.toggle("collapsed");
  list.hidden = collapsed;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  syncConversationChromeResize();
}

function syncConversationChromeResize() {
  syncAskCodexLayout();
  syncMessagesFrameViewport({ syncDocument: false, materialize: false });
  scheduleMessagesFrameSync({ frames: 3, delays: [80, 240], force: true, afterPaint: true });
}

function syncAskCodexLayout() {
  const content = els.askCodexPanel?.querySelector(".ask-codex-content");
  if (!content) {
    return false;
  }
  content.style.height = "";
  content.style.maxHeight = "";
  content.style.minHeight = "";
  return false;
}

function installControlledDetailsToggle(details, onToggle) {
  const summary = details?.querySelector("summary");
  if (!details || !summary) {
    return;
  }
  let suppressNativeToggle = false;
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    suppressNativeToggle = true;
    details.open = !details.open;
    onToggle();
  });
  details.addEventListener("toggle", () => {
    if (suppressNativeToggle) {
      suppressNativeToggle = false;
      return;
    }
    onToggle();
  });
}

function renderCompactionItem(checkpoint, summary) {
  const wrapper = document.createElement("button");
  wrapper.type = "button";
  wrapper.className = "related-item compaction-item";
  wrapper.title = "Scroll to this compaction in the conversation";
  wrapper.addEventListener("click", () => scrollToMessageIndex(
    checkpoint.message_index,
    { defer: true, anchorId: compactionAnchorId(checkpoint) }
  ));

  const title = document.createElement("span");
  title.className = "related-title";
  title.textContent = `${checkpoint.ordinal}. ${checkpoint.label}`;

  const meta = document.createElement("span");
  meta.className = "related-meta";
  const metaText = [checkpoint.time, checkpoint.summary].filter(Boolean).join(" | ");
  setAutoDirection(meta, metaText);
  meta.textContent = metaText;

  wrapper.append(title, meta);
  return wrapper;
}

function renderRelatedItem(item, kind, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "related-item";
  button.addEventListener("click", () => {
    if (options.jumpToBranch) {
      jumpToBranch(item.id, { defer: true });
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

async function createForkBeforeCompaction(checkpoint, summary, button) {
  if (!summary?.id || !checkpoint?.line_number) {
    return;
  }
  const confirmed = await confirmWriteAction({
    title: "Create fork before compaction?",
    body: "This writes a new Codex conversation fork from the point before this compaction. The original conversation is left unchanged.",
    details: [
      { label: "Checkpoint", value: checkpoint.label || (checkpoint.ordinal ? `#${checkpoint.ordinal}` : "Compaction") },
      { label: "Time", value: checkpoint.time },
      { label: "Summary", value: checkpoint.summary },
      { label: "Fork point", value: "Immediately before this compaction marker" }
    ],
    confirmLabel: "Create fork",
    opener: button
  });
  if (!confirmed) {
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await fetchJson(
      `/api/main-threads/${encodeURIComponent(summary.id)}/fork-before-compaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_number: checkpoint.line_number })
      }
    );
    els.sourceLine.textContent = `Created ${result.resume_command}`;
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    await openThread("main", result.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    els.sourceLine.textContent = error.message || String(error);
  }
}

async function createForkBeforeRollback(rollback, summary, button) {
  if (!summary?.id || !Number.isInteger(rollback?.lineNumber)) {
    return;
  }
  const rollbackLabel = rollback.ordinal ? `rollback #${rollback.ordinal}` : "this rollback";
  const confirmed = await confirmWriteAction({
    title: `Undo ${rollbackLabel} as a fork?`,
    body: "This writes a new Codex conversation fork from the point before the rollback marker. The original conversation is left unchanged.",
    details: [
      { label: "Rollback", value: rollback.ordinal ? `#${rollback.ordinal}` : "Selected rollback" },
      { label: "Time", value: rollback.time },
      { label: "Summary", value: rollback.summary },
      { label: "Fork point", value: "Immediately before this rollback marker" }
    ],
    confirmLabel: "Create fork",
    opener: button
  });
  if (!confirmed) {
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await fetchJson(
      `/api/main-threads/${encodeURIComponent(summary.id)}/fork-before-rollback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_number: rollback.lineNumber })
      }
    );
    els.sourceLine.textContent = `Created ${result.resume_command}`;
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    await openThread("main", result.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    els.sourceLine.textContent = error.message || String(error);
  }
}

async function createForkFromMessage(message, index, button) {
  const summary = state.currentThread?.summary;
  const lineNumber = message?.line_number;
  if (!summary?.id || !Number.isInteger(lineNumber)) {
    return;
  }
  const confirmed = await confirmWriteAction({
    title: "Create fork from this message?",
    body: "This writes a new Codex conversation containing the history through this user message. Later messages are not copied. The original conversation is left unchanged.",
    details: [
      { label: "Target", value: collapsedMessageHeading(message.text || "") || "Selected user message" },
      { label: "Fork point", value: "Immediately after this user message" },
      { label: "Change", value: "Creates a new resumable Codex conversation" }
    ],
    confirmLabel: "Create fork",
    opener: button
  });
  if (!confirmed) {
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await fetchJson(
      `/api/main-threads/${encodeURIComponent(summary.id)}/fork-from-message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_number: lineNumber })
      }
    );
    els.sourceLine.textContent = `Created ${result.resume_command}`;
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    await openThread("main", result.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    els.sourceLine.textContent = error.message || String(error);
  }
}

async function createForkBeforeMessage(message, index, button) {
  const summary = state.currentThread?.summary;
  const lineNumber = message?.line_number;
  if (!summary?.id || !Number.isInteger(lineNumber)) {
    return;
  }
  const confirmed = await confirmWriteAction({
    title: "Create fork before this message?",
    body: "This writes a new Codex conversation containing the history before this user message. The selected message and later messages are not copied, so resuming the fork continues from the previous conversation state.",
    details: [
      { label: "Target", value: collapsedMessageHeading(message.text || "") || "Selected user message" },
      { label: "Fork point", value: "Immediately before this user message" },
      { label: "Change", value: "Creates a new resumable Codex conversation" }
    ],
    confirmLabel: "Create fork",
    opener: button
  });
  if (!confirmed) {
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await fetchJson(
      `/api/main-threads/${encodeURIComponent(summary.id)}/fork-before-message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_number: lineNumber })
      }
    );
    els.sourceLine.textContent = `Created ${result.resume_command}`;
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    await openThread("main", result.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    els.sourceLine.textContent = error.message || String(error);
  }
}

function findRenderedMessageWrapper(messageIndex, { expandGroups = true } = {}) {
  if (!Number.isInteger(messageIndex) || !els.messages) {
    return null;
  }
  let wrapper = els.messages.querySelector(`.message[data-message-index="${messageIndex}"]`);
  if (!wrapper && expandGroups) {
    wrapper = expandToolRunForMessage(messageIndex);
  }
  return wrapper;
}

function focusElementInMessages(element, { className = "branch-link-focus", duration = 1600 } = {}) {
  if (!element) {
    return 0;
  }
  scrollElementIntoMessages(element);
  element.classList.add(className);
  window.setTimeout(() => element.classList.remove(className), duration);
  return duration;
}

function virtualUnitIndexForMessage(messageIndex) {
  return state.virtualTranscript.messageIndexToUnitIndex.get(messageIndex);
}

function scrollToVirtualUnitIndex(unitIndex, options = {}) {
  const transcript = state.virtualTranscript;
  if (!Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex >= transcript.units.length || !els.messages) {
    return false;
  }
  rebuildVirtualTranscriptOffsets();
  const unitHeight = virtualUnitHeight(unitIndex);
  const offset = transcript.offsets[unitIndex] || 0;
  const target = offset - ((els.messages.clientHeight - unitHeight) / 2);
  const maxScroll = Math.max(0, els.messages.scrollHeight - els.messages.clientHeight);
  const clamped = Math.max(0, Math.min(target, maxScroll));
  const duration = options.animate === false
    ? setMessagesScrollTop(clamped)
    : scrollMessagesTo(clamped);
  scheduleVirtualTranscriptRender({ force: true });
  schedulePendingScrollResolution(duration + VIRTUAL_TRANSCRIPT_RESOLVE_DELAY_MS);
  return true;
}

function setMessagesScrollTop(target) {
  cancelScrollAnimation();
  els.messages.scrollTop = target;
  return 0;
}

function schedulePendingScrollResolution(delay = VIRTUAL_TRANSCRIPT_RESOLVE_DELAY_MS) {
  const transcript = state.virtualTranscript;
  if (transcript.resolveTimer !== null) {
    window.clearTimeout(transcript.resolveTimer);
  }
  transcript.resolveTimer = window.setTimeout(() => {
    transcript.resolveTimer = null;
    renderVirtualTranscriptWindow({ force: true });
    measureRenderedVirtualUnits({ resolve: true });
  }, Math.max(0, delay));
}

function scrollToMessageIndex(messageIndex, { defer = false, anchorId = null } = {}) {
  if (!Number.isInteger(messageIndex)) {
    return false;
  }
  let wrapper = findRenderedMessageWrapper(messageIndex);
  if (!wrapper) {
    if (scrollToAnchor(anchorId)) {
      return true;
    }
    const unitIndex = virtualUnitIndexForMessage(messageIndex);
    if (Number.isInteger(unitIndex)) {
      state.pendingScrollTarget = { type: "message", messageIndex, anchorId };
      return scrollToVirtualUnitIndex(unitIndex);
    }
    if (defer) {
      state.pendingScrollTarget = { type: "message", messageIndex, anchorId };
    }
    return false;
  }
  state.pendingScrollTarget = null;
  if (wrapper.classList.contains("collapsed")) {
    expandCollapsedMessage(wrapper);
  }
  focusElementInMessages(wrapper);
  return true;
}

function scrollToRollbackLink(rollback) {
  if (!rollback) {
    return;
  }
  const anchorId = rollbackAnchorId(rollback);
  if (Number.isInteger(rollback.eventIndex)) {
    if (scrollToMessageIndex(rollback.eventIndex, { defer: true, anchorId })) {
      return;
    }
  }
  let wrapper = els.messages.querySelector(
    `.rollback-group[data-rollback-group-id="${rollback.groupId}"]`
  );
  if (!wrapper && Number.isInteger(rollback.startIndex)) {
    wrapper = els.messages.querySelector(
      `.rollback-group[data-rollback-group-start="${rollback.startIndex}"]`
    );
  }
  if (wrapper) {
    scrollElementIntoMessages(wrapper);
    wrapper.classList.add("branch-link-focus");
    window.setTimeout(() => wrapper.classList.remove("branch-link-focus"), 1600);
    return;
  }
  if (scrollToAnchor(anchorId)) {
    return;
  }
  scrollToMessageIndex(rollback.messageIndex, { defer: true, anchorId });
}

function scrollToAnchor(anchorId) {
  if (!anchorId || !els.messagesDocument) {
    return false;
  }
  const anchor = els.messagesDocument.getElementById(anchorId);
  if (!anchor) {
    const unitIndex = state.virtualTranscript.anchorIdToUnitIndex.get(anchorId);
    if (Number.isInteger(unitIndex)) {
      state.pendingScrollTarget = { type: "anchor", anchorId };
      return scrollToVirtualUnitIndex(unitIndex);
    }
    return false;
  }
  focusElementInMessages(anchor);
  state.pendingScrollTarget = null;
  return true;
}

function branchGroupsFor(detail) {
  const messages = detail.messages || [];
  const related = detail.related || {};
  const groups = new Map();
  const addBranch = (anchor, branch) => {
    const key = String(anchor);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(branch);
  };

  for (const item of related.parents || []) {
    addBranch(-1, {
      item,
      kind: item.kind || "main",
      branchType: "parent",
      openOptions: detail.summary?.id ? { branchId: detail.summary.id } : {}
    });
  }

  if (state.mode === "main") {
    const branches = [
      ...(related.forks || []).map((item) => ({ item, kind: "main", branchType: "fork" })),
      ...(related.side || []).map((item) => ({ item, kind: "side", branchType: "side" }))
    ];

    for (const branch of branches) {
      addBranch(branchAnchorIndex(messages, branch.item.started_at), branch);
    }
  }

  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.branchType !== b.branchType) return branchTypeSort(a.branchType) - branchTypeSort(b.branchType);
      const aTime = Number(a.item.started_at || 0);
      const bTime = Number(b.item.started_at || 0);
      if (aTime !== bTime) return aTime - bTime;
      return (a.item.preview || a.item.id).localeCompare(b.item.preview || b.item.id);
    });
  }

  return groups;
}

function branchTypeSort(branchType) {
  if (branchType === "parent") return 0;
  if (branchType === "fork") return 1;
  if (branchType === "side") return 2;
  return 3;
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

function appendBranchMarkerGroup(branches, parent = els.messages) {
  if (!branches || branches.length === 0) {
    return;
  }
  parent.appendChild(renderBranchMarker(branches));
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

function renderJumpMarker(markers) {
  const marker = document.createElement("section");
  marker.className = "branch-marker jump-marker";

  const heading = document.createElement("div");
  heading.className = "branch-marker-heading";
  heading.textContent = markers.length === 1
    ? "Filtered scroll target here"
    : `${markers.length} filtered scroll targets here`;
  marker.appendChild(heading);

  const list = document.createElement("div");
  list.className = "branch-marker-list";
  for (const item of markers) {
    list.appendChild(renderJumpMarkerItem(item));
  }
  marker.appendChild(list);
  return marker;
}

function renderJumpMarkerItem(item) {
  const row = document.createElement("button");
  row.type = "button";
  row.id = item.id;
  row.className = `branch-link jump-link ${item.kind}`;
  row.tabIndex = -1;
  row.title = item.title;
  row.addEventListener("click", () => scrollElementIntoMessages(row));

  const kind = document.createElement("span");
  kind.className = "branch-kind";
  kind.textContent = item.kindLabel;

  const body = document.createElement("span");
  body.className = "branch-link-body";

  const title = document.createElement("span");
  title.className = "branch-link-title";
  setAutoDirection(title, item.label);
  title.textContent = item.label;

  const meta = document.createElement("span");
  meta.className = "branch-link-meta";
  setAutoDirection(meta, item.meta);
  meta.textContent = item.meta;

  body.append(title, meta);

  const action = document.createElement("span");
  action.className = "branch-link-action";
  action.textContent = "Hidden";

  row.append(kind, body, action);
  return row;
}

function jumpMarkersFor(detail, rollbackGroups) {
  const messages = detail.messages || [];
  const markers = new Map();
  const addMarker = (index, item) => {
    if (!Number.isInteger(index)) {
      return;
    }
    const key = String(index);
    if (!markers.has(key)) {
      markers.set(key, []);
    }
    markers.get(key).push(item);
  };

  for (const checkpoint of detail.compactions || []) {
    const index = checkpoint.message_index;
    if (!Number.isInteger(index) || messageHasVisibleScrollTarget(messages, rollbackGroups, index)) {
      continue;
    }
    addMarker(index, {
      id: compactionAnchorId(checkpoint),
      kind: "compaction",
      kindLabel: "Compaction",
      label: `${checkpoint.ordinal}. ${checkpoint.label || "Compaction checkpoint"}`,
      meta: [checkpoint.time, checkpoint.summary, "hidden by filters"].filter(Boolean).join(" | "),
      title: "This compaction is hidden by the message filters."
    });
  }

  for (const rollback of rollbackLinksFor(messages, detail.rollbacks || [])) {
    if (rollbackHasVisibleScrollTarget(messages, rollbackGroups, rollback)) {
      continue;
    }
    const index = firstInteger(rollback.eventIndex, rollback.startIndex, rollback.messageIndex);
    addMarker(index, {
      id: rollbackAnchorId(rollback),
      kind: "rollback",
      kindLabel: "Rollback",
      label: `${rollback.ordinal || "?"}. Rollback`,
      meta: [rollback.time, rollback.summary, "hidden by filters"].filter(Boolean).join(" | "),
      title: "This rollback target is hidden by the message filters."
    });
  }

  for (const group of markers.values()) {
    group.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      return left.label.localeCompare(right.label);
    });
  }
  return markers;
}

function messageHasVisibleScrollTarget(messages, rollbackGroups, index) {
  if (!Number.isInteger(index)) {
    return false;
  }
  const message = messages[index];
  return Boolean(message && isMessageVisibleByFilter(message) && (
    !rollbackGroups.groupedIndexes.has(index)
    || rollbackGroups.firstIndexToGroup.has(index)
    || [...rollbackGroups.groups].some((group) => group.some((item) => item.index === index))
  ));
}

function rollbackHasVisibleScrollTarget(messages, rollbackGroups, rollback) {
  if (messageHasVisibleScrollTarget(messages, rollbackGroups, rollback.eventIndex)) {
    return true;
  }
  if (Number.isInteger(rollback.startIndex) && rollbackGroups.firstIndexToGroup.has(rollback.startIndex)) {
    return true;
  }
  return messageHasVisibleScrollTarget(messages, rollbackGroups, rollback.messageIndex);
}

function firstInteger(...values) {
  return values.find((value) => Number.isInteger(value));
}

function compactionAnchorId(checkpoint) {
  return `jump-compaction-${checkpoint.line_number ?? checkpoint.message_index ?? checkpoint.ordinal}`;
}

function rollbackAnchorId(rollback) {
  return `jump-rollback-${rollback.lineNumber ?? rollback.eventIndex ?? rollback.messageIndex ?? rollback.ordinal}`;
}

function branchMarkerHeading(branches) {
  const parentCount = branches.filter((branch) => branch.branchType === "parent").length;
  const sideCount = branches.filter((branch) => branch.branchType === "side").length;
  const forkCount = branches.filter((branch) => branch.branchType === "fork").length;
  if (branches.length === 1) {
    if (parentCount === 1) return "Parent conversation";
    if (sideCount === 1) return "Side conversation opened here";
    return "Forked conversation opened here";
  }
  const parts = [];
  if (parentCount > 0) parts.push(`${parentCount} parent`);
  if (forkCount > 0) parts.push(`${forkCount} forked`);
  if (sideCount > 0) parts.push(`${sideCount} side`);
  return `${parts.join(", ")} conversation links here`;
}

function renderBranchLink(branch) {
  const item = branch.item;
  const row = document.createElement("button");
  row.type = "button";
  row.className = `branch-link ${branch.branchType}`;
  row.tabIndex = -1;
  row.id = branchMarkerId(item.id);
  row.addEventListener("click", () => openThread(branch.kind, item.id, branch.openOptions || {}));

  const kind = document.createElement("span");
  kind.className = "branch-kind";
  kind.textContent = branchKindLabel(branch.branchType);

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

function branchKindLabel(branchType) {
  if (branchType === "parent") return "Parent";
  if (branchType === "side") return "Side";
  return "Fork";
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

function jumpToBranch(branchId, { defer = false } = {}) {
  const marker = els.messagesDocument?.getElementById(branchMarkerId(branchId));
  if (!marker) {
    const unitIndex = state.virtualTranscript.anchorIdToUnitIndex.get(branchMarkerId(branchId));
    if (Number.isInteger(unitIndex)) {
      state.pendingScrollTarget = { type: "branch", branchId };
      return scrollToVirtualUnitIndex(unitIndex);
    }
    if (defer) {
      state.pendingScrollTarget = { type: "branch", branchId };
    }
    return false;
  }
  state.pendingScrollTarget = null;
  const duration = focusElementInMessages(marker, { duration: 1600 });
  return true;
}

function resolvePendingScrollTarget({ final = false } = {}) {
  const target = state.pendingScrollTarget;
  if (!target) {
    return;
  }
  let resolved = false;
  if (target.type === "message") {
    resolved = focusRenderedMessageTarget(target);
  } else if (target.type === "branch") {
    resolved = focusRenderedAnchor(branchMarkerId(target.branchId));
  } else if (target.type === "anchor") {
    resolved = focusRenderedAnchor(target.anchorId);
  } else if (target.type === "search") {
    resolved = focusRenderedSearchTarget(target);
  } else if (target.type === "conversationNavigation") {
    resolved = focusRenderedConversationNavigationTarget(target);
  }
  if ((resolved || final) && state.pendingScrollTarget === target) {
    state.pendingScrollTarget = null;
  }
}

function focusRenderedAnchor(anchorId) {
  if (!anchorId || !els.messagesDocument) {
    return false;
  }
  const anchor = els.messagesDocument.getElementById(anchorId);
  if (!anchor) {
    return false;
  }
  focusElementInMessages(anchor);
  return true;
}

function focusRenderedMessageTarget(target) {
  const wrapper = findRenderedMessageWrapper(target.messageIndex);
  if (!wrapper) {
    return false;
  }
  if (wrapper.classList.contains("collapsed")) {
    expandCollapsedMessage(wrapper);
  }
  focusElementInMessages(wrapper);
  return true;
}

function focusRenderedSearchTarget(target) {
  const wrapper = findRenderedMessageWrapper(target.messageIndex);
  if (!wrapper) {
    return false;
  }
  if (wrapper.classList.contains("collapsed")) {
    expandCollapsedMessage(wrapper);
  }
  const body = wrapper.querySelector(".message-body") || ensureLazyMessageBody(wrapper);
  ensureMessageBodyRendered(body);
  body.hidden = false;
  const mark = highlightNthSearchInElement(
    body,
    state.conversationSearch.lowerQuery,
    state.conversationSearch.queryLength,
    target.occurrenceIndex
  );
  if (mark) {
    state.conversationSearch.activeMarks = [mark];
  }
  state.conversationSearch.activeIndex = target.activeIndex;
  updateConversationSearchControls();
  focusElementInMessages(mark || wrapper);
  return true;
}

function focusRenderedConversationNavigationTarget(target) {
  const wrapper = findRenderedMessageWrapper(target.messageIndex);
  if (!wrapper) {
    return false;
  }
  if (wrapper.classList.contains("collapsed")) {
    expandCollapsedMessage(wrapper);
  }
  if (target.quote) {
    const body = wrapper.querySelector(".message-body") || ensureLazyMessageBody(wrapper);
    ensureMessageBodyRendered(body);
    body.hidden = false;
    const mark = highlightAskCodexTargetInElement(body, target.quote);
    if (mark) {
      state.askCodex.activeMarks = [mark];
      focusElementInMessages(mark);
      wrapper.classList.add("branch-link-focus");
      window.setTimeout(() => wrapper.classList.remove("branch-link-focus"), 1600);
      els.askCodexStatus.textContent = `Scrolled to text in message ${target.messageIndex + 1}.`;
      return true;
    }
    els.askCodexStatus.textContent = `Text not found in message ${target.messageIndex + 1}; scrolled to the message.`;
  } else {
    els.askCodexStatus.textContent = `Scrolled to message ${target.messageIndex + 1}.`;
  }
  focusElementInMessages(wrapper);
  return true;
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
  cancelConversationSearchWork();
  clearConversationHighlights();
  clearAskCodexNavigationHighlights();
  state.conversationSearch.matchGroups = [];
  state.conversationSearch.totalMatches = 0;
  state.conversationSearch.activeIndex = -1;
  state.conversationSearch.lowerQuery = "";
  state.conversationSearch.queryLength = 0;
  state.conversationSearch.workerReady = false;
  state.conversationSearch.workerIndexing = false;
  state.conversationSearch.workerRevision += 1;
  els.conversationSearchInput.value = "";
  els.conversationSearchInput.disabled = true;
  updateConversationSearchControls();
}

function scheduleConversationSearch({ immediate = false } = {}) {
  cancelScheduledConversationSearch();
  cancelConversationSearchWork();
  const query = els.conversationSearchInput.value.trim();
  els.conversationSearchClear.disabled = query === "";
  if (!query || immediate) {
    void applyConversationSearch();
    return;
  }
  state.conversationSearch.timer = window.setTimeout(() => {
    state.conversationSearch.timer = null;
    els.conversationSearchCount.textContent = "Searching...";
    void applyConversationSearch();
  }, CONVERSATION_SEARCH_DEBOUNCE_MS);
}

function scheduleConversationSearchAfterPaint() {
  cancelScheduledConversationSearch();
  cancelConversationSearchWork();
  const query = els.conversationSearchInput.value.trim();
  els.conversationSearchClear.disabled = query === "";
  state.conversationSearch.inputFrame = window.requestAnimationFrame(() => {
    state.conversationSearch.inputFrame = null;
    scheduleConversationSearch();
  });
}

async function applyConversationSearch() {
  cancelScheduledConversationSearch();
  clearConversationHighlights();
  clearAskCodexNavigationHighlights();
  if (state.conversationSearch.abortController) {
    state.conversationSearch.abortController.abort();
    state.conversationSearch.abortController = null;
  }
  const requestId = state.conversationSearch.requestId + 1;
  state.conversationSearch.requestId = requestId;
  state.conversationSearch.matchGroups = [];
  state.conversationSearch.totalMatches = 0;
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
  els.conversationSearchCount.textContent = "Searching...";
  updateConversationSearchButtons();
  const controller = new AbortController();
  state.conversationSearch.abortController = controller;
  try {
    const result = await fetchJson(conversationSearchUrl(query), { signal: controller.signal });
    if (requestId !== state.conversationSearch.requestId) {
      return;
    }
    const visibleResult = filterSearchResultToVisibleMessages(result);
    state.conversationSearch.matchGroups = visibleResult.matchGroups;
    state.conversationSearch.totalMatches = visibleResult.totalMatches;
    if (state.conversationSearch.totalMatches > 0) {
      state.conversationSearch.activeIndex = -1;
      updateConversationSearchControls();
      return;
    }
    updateConversationSearchControls();
  } catch (error) {
    if (requestId === state.conversationSearch.requestId && !isAbortError(error)) {
      state.conversationSearch.activeIndex = -1;
      state.conversationSearch.matchGroups = [];
      state.conversationSearch.totalMatches = 0;
      els.conversationSearchCount.textContent = "Search failed";
      updateConversationSearchButtons();
    }
  } finally {
    if (state.conversationSearch.abortController === controller) {
      state.conversationSearch.abortController = null;
    }
  }
}

function conversationSearchUrl(query) {
  const params = new URLSearchParams({
    kind: state.mode,
    thread_id: state.currentThread?.summary?.id || "",
    q: query,
    filters: enabledServerMessageFilterKeys().join(",")
  });
  return `/api/search?${params.toString()}`;
}

function enabledMessageFilterKeys() {
  return MESSAGE_FILTERS
    .filter((filter) => state.messageFilters[filter.key] !== false)
    .map((filter) => filter.key);
}

function enabledServerMessageFilterKeys() {
  const keys = enabledMessageFilterKeys().filter((key) => key !== "assistantInterim");
  const assistantVisible = state.messageFilters.assistant !== false || state.messageFilters.assistantInterim !== false;
  if (assistantVisible && !keys.includes("assistant")) {
    keys.push("assistant");
  }
  return keys;
}

function filterSearchResultToVisibleMessages(result) {
  const messages = state.currentThread?.messages || [];
  const matchGroups = [];
  let totalMatches = 0;
  for (const group of result.matchGroups || []) {
    const message = messages[group.messageIndex];
    if (!message || !isMessageSearchVisible(message)) {
      continue;
    }
    matchGroups.push(group);
    totalMatches += group.count || 0;
  }
  return { matchGroups, totalMatches };
}

async function applyConversationSearchOnMainThread(requestId, query, lowerQuery) {
  const messages = state.currentThread?.messages || [];
  const matchGroups = [];
  let totalMatches = 0;
  let lastYield = performance.now();
  for (const [messageIndex, message] of messages.entries()) {
    if (requestId !== state.conversationSearch.requestId) {
      return;
    }
    if (!isMessageSearchVisible(message)) {
      continue;
    }
    const lowerText = cachedLowerSearchText(message, messageViewText(message));
    const count = countSearchOccurrences(lowerText, lowerQuery);
    if (count > 0) {
      matchGroups.push({ messageIndex, count });
      totalMatches += count;
    }
    if (performance.now() - lastYield >= CONVERSATION_SEARCH_TIME_BUDGET_MS) {
      els.conversationSearchCount.textContent = totalMatches > 0
        ? `${totalMatches} found...`
        : "Searching...";
      await nextFrame();
      lastYield = performance.now();
    }
  }

  if (requestId !== state.conversationSearch.requestId) {
    return;
  }
  state.conversationSearch.matchGroups = matchGroups;
  state.conversationSearch.totalMatches = totalMatches;
  if (totalMatches > 0) {
    state.conversationSearch.activeIndex = -1;
    updateConversationSearchControls();
    return;
  }
  updateConversationSearchControls();
}

function countSearchOccurrences(lowerText, lowerQuery) {
  if (!lowerQuery) {
    return 0;
  }
  let count = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);
  while (matchIndex !== -1) {
    count += 1;
    matchIndex = lowerText.indexOf(lowerQuery, matchIndex + lowerQuery.length);
  }
  return count;
}

function ensureSearchWorker() {
  if (!("Worker" in window)) {
    return null;
  }
  if (state.conversationSearch.worker) {
    return state.conversationSearch.worker;
  }
  try {
    const worker = new Worker(SEARCH_WORKER_URL);
    worker.addEventListener("message", handleSearchWorkerMessage);
    worker.addEventListener("error", () => {
      state.conversationSearch.worker?.terminate();
      state.conversationSearch.worker = null;
      state.conversationSearch.workerReady = false;
    });
    state.conversationSearch.worker = worker;
    return worker;
  } catch {
    state.conversationSearch.worker = null;
    return null;
  }
}

async function rebuildSearchWorkerIndex() {
  const worker = ensureSearchWorker();
  if (!worker || !state.currentThread) {
    return;
  }
  const revision = state.conversationSearch.workerRevision + 1;
  state.conversationSearch.workerRevision = revision;
  state.conversationSearch.workerReady = false;
  state.conversationSearch.workerIndexing = true;
  state.conversationSearch.pendingWorkerSearch = false;
  worker.postMessage({ type: "reset", revision });
  let records = [];
  for (const [messageIndex, message] of state.currentThread.messages.entries()) {
    if (revision !== state.conversationSearch.workerRevision) {
      return;
    }
    if (!isMessageSearchVisible(message)) {
      continue;
    }
    records.push({
      messageIndex,
      text: messageViewText(message)
    });
    if (records.length >= 80) {
      worker.postMessage({ type: "append", revision, records });
      records = [];
      await yieldToBrowser();
    }
  }
  if (revision !== state.conversationSearch.workerRevision) {
    return;
  }
  if (records.length > 0) {
    worker.postMessage({ type: "append", revision, records });
  }
  worker.postMessage({ type: "finish", revision });
}

function handleSearchWorkerMessage(event) {
  const data = event.data || {};
  if (data.revision !== state.conversationSearch.workerRevision) {
    return;
  }
  if (data.type === "ready") {
    state.conversationSearch.workerReady = true;
    state.conversationSearch.workerIndexing = false;
    if (state.conversationSearch.pendingWorkerSearch && els.conversationSearchInput.value.trim()) {
      state.conversationSearch.pendingWorkerSearch = false;
      void applyConversationSearch();
    }
    return;
  }
  if (data.type === "progress") {
    if (data.requestId !== state.conversationSearch.requestId) {
      return;
    }
    els.conversationSearchCount.textContent = data.totalMatches > 0
      ? `${data.totalMatches} found...`
      : "Searching...";
    return;
  }
  if (data.type !== "result" || data.requestId !== state.conversationSearch.requestId) {
    return;
  }
  state.conversationSearch.matchGroups = data.matchGroups || [];
  state.conversationSearch.totalMatches = data.totalMatches || 0;
  if (state.conversationSearch.totalMatches > 0) {
    state.conversationSearch.activeIndex = -1;
    updateConversationSearchControls();
    return;
  }
  state.conversationSearch.activeIndex = -1;
  updateConversationSearchControls();
}

function isMessageVisibleByFilter(message) {
  return isPrimaryMessageVisibleByFilter(message)
    || (messageContainsDiff(message) && state.messageFilters.diff !== false);
}

function isPrimaryMessageVisibleByFilter(message) {
  const key = messageFilterKey(message);
  if (message?.role === "assistant") {
    if (key !== "assistant" && state.messageFilters[key] === false) {
      return false;
    }
    const stageKey = message.__finalAssistantReply ? "assistant" : "assistantInterim";
    return state.messageFilters[stageKey] !== false;
  }
  if (state.messageFilters[key] === false) {
    return false;
  }
  return true;
}

function isMessageSearchVisible(message) {
  return isMessageVisibleByFilter(message);
}

function messageViewText(message) {
  if (shouldUseDiffOnlyView(message)) {
    return diffOnlyMarkdown(message?.text || "");
  }
  return message?.text || "";
}

function shouldUseDiffOnlyView(message) {
  return messageContainsDiff(message)
    && state.messageFilters.diff !== false
    && !isPrimaryMessageVisibleByFilter(message);
}

function cachedLowerSearchText(message, textValue = message?.text || "") {
  const cached = SEARCH_TEXT_CACHE.get(message);
  if (cached && cached.text === textValue) {
    return cached.lowerText;
  }
  const lowerText = textValue.toLocaleLowerCase();
  SEARCH_TEXT_CACHE.set(message, { text: textValue, lowerText });
  return lowerText;
}

function highlightNthSearchInElement(element, lowerQuery, queryLength, targetOccurrence) {
  const doc = element.ownerDocument || document;
  const nodeFilter = doc.defaultView?.NodeFilter || NodeFilter;
  const walker = doc.createTreeWalker(
    element,
    nodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return nodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest(".search-match")) {
          return nodeFilter.FILTER_REJECT;
        }
        return nodeFilter.FILTER_ACCEPT;
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
        const fragment = doc.createDocumentFragment();
        if (matchIndex > 0) {
          fragment.appendChild(doc.createTextNode(value.slice(0, matchIndex)));
        }
        const mark = doc.createElement("mark");
        mark.className = "search-match active";
        mark.textContent = value.slice(matchIndex, matchIndex + queryLength);
        fragment.appendChild(mark);
        if (matchIndex + queryLength < value.length) {
          fragment.appendChild(doc.createTextNode(value.slice(matchIndex + queryLength)));
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
  const marks = state.conversationSearch.activeMarks;
  state.conversationSearch.activeMarks = [];
  for (const mark of marks) {
    if (!mark.isConnected) {
      continue;
    }
    const parent = mark.parentNode;
    mark.replaceWith(mark.ownerDocument.createTextNode(mark.textContent));
    parent?.normalize();
  }
}

function clearAskCodexNavigationHighlights() {
  const marks = state.askCodex.activeMarks;
  state.askCodex.activeMarks = [];
  for (const mark of marks) {
    if (!mark.isConnected) {
      continue;
    }
    const parent = mark.parentNode;
    mark.replaceWith(mark.ownerDocument.createTextNode(mark.textContent));
    parent?.normalize();
  }
}

function updateConversationSearchControls() {
  const query = els.conversationSearchInput.value.trim();
  const total = state.conversationSearch.totalMatches;
  const active = state.conversationSearch.activeIndex;
  if (!query) {
    els.conversationSearchCount.textContent = "No search";
  } else if (total === 0) {
    els.conversationSearchCount.textContent = "0 matches";
  } else if (active < 0) {
    els.conversationSearchCount.textContent = `${total} matches`;
  } else {
    els.conversationSearchCount.textContent = `${active + 1} / ${total}`;
  }
  updateConversationSearchButtons();
}

function updateConversationSearchButtons() {
  const query = els.conversationSearchInput.value.trim();
  const total = state.conversationSearch.totalMatches;
  els.conversationSearchPrev.disabled = total === 0;
  els.conversationSearchNext.disabled = total === 0;
  els.conversationSearchClear.disabled = query === "";
}

function setActiveConversationMatch(index, { scroll = true, expandCollapsed = true } = {}) {
  const total = state.conversationSearch.totalMatches;
  if (total === 0) {
    state.conversationSearch.activeIndex = -1;
    updateConversationSearchControls();
    return;
  }

  const normalizedIndex = (index + total) % total;
  clearConversationHighlights();
  const active = searchMatchAtIndex(normalizedIndex);
  if (!active) {
    state.conversationSearch.activeIndex = -1;
    updateConversationSearchControls();
    return;
  }
  let wrapper = findRenderedMessageWrapper(active.messageIndex, { expandGroups: expandCollapsed });
  let activeElement = wrapper;
  if (!wrapper) {
    state.conversationSearch.activeIndex = normalizedIndex;
    updateConversationSearchControls();
    if (scroll) {
      const unitIndex = virtualUnitIndexForMessage(active.messageIndex);
      if (Number.isInteger(unitIndex)) {
        state.pendingScrollTarget = {
          type: "search",
          activeIndex: normalizedIndex,
          messageIndex: active.messageIndex,
          occurrenceIndex: active.occurrenceIndex
        };
        scrollToVirtualUnitIndex(unitIndex);
      }
    }
    return;
  }
  if (wrapper.classList.contains("collapsed") && expandCollapsed) {
    expandCollapsedMessage(wrapper);
  }
  const body = wrapper.querySelector(".message-body");
  if (body && body.dataset.rendered === "false") {
    ensureMessageBodyRendered(body);
  }
  const mark = body && !body.hidden
    ? highlightNthSearchInElement(
      body,
      state.conversationSearch.lowerQuery,
      state.conversationSearch.queryLength,
      active.occurrenceIndex
    )
    : null;
  if (mark) {
    state.conversationSearch.activeMarks = [mark];
  }
  activeElement = mark || wrapper;
  state.conversationSearch.activeIndex = normalizedIndex;
  updateConversationSearchControls();

  if (scroll && activeElement) {
    scrollElementIntoMessages(activeElement);
  }
}

function stepConversationSearch(direction) {
  if (state.conversationSearch.totalMatches === 0) {
    return;
  }
  const activeIndex = state.conversationSearch.activeIndex;
  if (activeIndex < 0) {
    setActiveConversationMatch(direction > 0 ? 0 : state.conversationSearch.totalMatches - 1);
    return;
  }
  setActiveConversationMatch(activeIndex + direction);
}

function searchMatchAtIndex(index) {
  let cursor = 0;
  for (const group of state.conversationSearch.matchGroups) {
    const next = cursor + group.count;
    if (index < next) {
      return {
        messageIndex: group.messageIndex,
        occurrenceIndex: index - cursor
      };
    }
    cursor = next;
  }
  return null;
}

function scrollElementIntoMessages(element) {
  scrollElementHorizontallyIntoView(element);
  const elementRect = element.getBoundingClientRect();
  const messagesRect = els.messages.getBoundingClientRect();
  const target = els.messages.scrollTop
    + elementRect.top
    - messagesRect.top
    - ((els.messages.clientHeight - elementRect.height) / 2);
  const maxScroll = els.messages.scrollHeight - els.messages.clientHeight;
  scrollMessagesTo(Math.max(0, Math.min(target, maxScroll)));
}

function scrollElementHorizontallyIntoView(element) {
  let current = element.parentElement;
  while (current && current !== els.messages) {
    if (current.scrollWidth > current.clientWidth) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.overflowX === "auto" || style.overflowX === "scroll") {
        const elementRect = element.getBoundingClientRect();
        const currentRect = current.getBoundingClientRect();
        const target = current.scrollLeft
          + elementRect.left
          - currentRect.left
          - ((current.clientWidth - elementRect.width) / 2);
        const maxScroll = current.scrollWidth - current.clientWidth;
        current.scrollLeft = Math.max(0, Math.min(target, maxScroll));
      }
    }
    current = current.parentElement;
  }
}

function renderMessage(message, index = 0, options = {}) {
  const wrapper = document.createElement("section");
  wrapper.className = `message ${message.role}${message.rolled_back ? " rolled-back" : ""}`;
  wrapper.dataset.filterKey = messageFilterKeys(message).join(" ");
  wrapper.dataset.messageIndex = String(index);
  const bodyRenderMode = shouldUseDiffOnlyView(message) ? "diffs" : "full";
  const collapseRolledBack = message.rolled_back && !options.insideRollbackGroup;
  const isCollapsible = bodyRenderMode !== "diffs" && (COLLAPSED_MESSAGE_ROLES.has(message.role) || collapseRolledBack);
  const shouldLazyRenderBody = isCollapsible;
  const isExpanded = isCollapsible && state.expandedMessages.has(index);
  if (isCollapsible && !isExpanded) {
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
    roleElement.tabIndex = -1;
    roleElement.setAttribute("aria-expanded", String(isExpanded));
    roleElement.setAttribute("aria-controls", bodyId);

    const icon = document.createElement("span");
    icon.className = "message-toggle-icon";
    icon.textContent = isExpanded ? "-" : "+";

    const role = renderRoleLabel(message);
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
    roleElement = renderRoleLabel(message);
  }

  const phase = message.phase ? ` | ${message.phase}` : "";
  const rollback = message.rolled_back
    ? ` | rolled back${message.rolled_back_at ? ` at ${message.rolled_back_at}` : ""}`
    : "";
  const source = document.createElement("span");
  source.className = "message-source";
  source.textContent = `${text(message.time)} | ${text(message.source)}${phase}${rollback}`;

  const actions = renderMessageActions(message, index);
  header.append(roleElement, source);
  header.appendChild(actions);

  let body = null;
  if (isCollapsible) {
    if (shouldLazyRenderBody) {
      wrapper.dataset.bodyId = bodyId;
      wrapper.__messageText = message.text || "";
      wrapper.__messageRenderMode = bodyRenderMode;
    }
    roleElement.addEventListener("click", () => {
      body = body || ensureLazyMessageBody(wrapper);
      setCollapsedMessageExpanded(
        wrapper,
        body,
        roleElement,
        wrapper.classList.contains("collapsed"),
      );
    });
  }
  if (shouldLazyRenderBody && !isExpanded) {
    body = null;
  } else {
    body = document.createElement("div");
    body.className = "message-body";
    if (isCollapsible) {
      body.id = bodyId;
      body.dataset.rendered = "false";
      body.__messageText = message.text || "";
      body.__messageRenderMode = bodyRenderMode;
      ensureMessageBodyRendered(body);
      body.hidden = !isExpanded;
    } else {
      renderMessageBodyContent(body, message.text || "", bodyRenderMode);
    }
  }

  if (body) {
    wrapper.append(header, body);
  } else {
    wrapper.append(header);
  }
  return wrapper;
}

function renderMessageActions(message, index) {
  const compaction = compactionCheckpointForMessage(index);
  const canFork = canForkFromMessage(message);
  const canRollback = canRollbackToMessage(message, index);
  const rollbackCheckpoint = rollbackCheckpointForMessage(message, index);
  const actions = document.createElement("div");
  actions.className = "message-actions";

  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "message-action";
  ask.textContent = "Ask";
  ask.title = "Ask Codex about this specific message.";
  ask.addEventListener("click", () => askCodexAboutMessage(message, index));
  actions.appendChild(ask);

  if (canFork) {
    const forkBefore = document.createElement("button");
    forkBefore.type = "button";
    forkBefore.className = "message-action";
    forkBefore.textContent = "Fork before";
    forkBefore.title = "Create a new fork from the conversation state before this user message.";
    forkBefore.addEventListener("click", () => createForkBeforeMessage(message, index, forkBefore));
    actions.appendChild(forkBefore);

    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "message-action primary";
    fork.textContent = "Fork here";
    fork.title = "Create a new fork from the conversation state immediately after this user message.";
    fork.addEventListener("click", () => createForkFromMessage(message, index, fork));
    actions.appendChild(fork);
  }

  if (compaction) {
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "message-action primary";
    fork.textContent = "Fork before";
    fork.title = "Create a new fork from the conversation state before this compaction.";
    fork.addEventListener("click", () => createForkBeforeCompaction(compaction, state.currentThread?.summary, fork));
    actions.appendChild(fork);
  }

  if (rollbackCheckpoint) {
    actions.appendChild(createRollbackUndoButton(rollbackCheckpoint));
  }

  if (canRollback) {
    const rollback = document.createElement("button");
    rollback.type = "button";
    rollback.className = "message-action rollback-create-action";
    rollback.textContent = "Rollback to here";
    rollback.title = "Append a Codex rollback marker that keeps this user turn and rolls back later active user turns.";
    rollback.addEventListener("click", () => createRollbackToMessage(message, index, rollback));
    actions.appendChild(rollback);
  }
  return actions;
}

function createRollbackUndoButton(rollback, label = "Undo as fork") {
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "message-action primary";
  undo.textContent = label;
  undo.title = rollbackUndoTitle(rollback);
  undo.disabled = !Number.isInteger(rollback.lineNumber);
  undo.addEventListener("click", () => createForkBeforeRollback(rollback, state.currentThread?.summary, undo));
  return undo;
}

function rollbackUndoTitle(rollback) {
  const parts = ["Create a new fork from the conversation state before this rollback marker."];
  const detail = [rollback.time, rollback.summary].filter(Boolean).join(" | ");
  if (detail) {
    parts.push(detail);
  }
  return parts.join(" ");
}

function compactionCheckpointForMessage(index) {
  return (state.currentThread?.compactions || []).find(
    (checkpoint) => checkpoint.message_index === index && Number.isInteger(checkpoint.line_number)
  ) || null;
}

function rollbackCheckpointForMessage(message, index) {
  if (message?.role !== "event" || message.phase !== "rollback") {
    return null;
  }
  const checkpoint = (state.currentThread?.rollbacks || []).find(
    (item) => item.message_index === index && Number.isInteger(item.line_number)
  ) || (state.currentThread?.rollbacks || []).find((item) => (
    message.timestamp !== undefined
    && message.timestamp !== null
    && item.timestamp !== undefined
    && item.timestamp !== null
    && String(item.timestamp) === String(message.timestamp)
  ));
  return normalizeRollbackCheckpoint(checkpoint, message, index);
}

function normalizeRollbackCheckpoint(checkpoint, fallbackMessage = null, fallbackIndex = null) {
  if (!checkpoint) {
    return null;
  }
  return {
    ordinal: checkpoint.ordinal ?? null,
    lineNumber: checkpoint.line_number,
    messageIndex: Number.isInteger(checkpoint.message_index) ? checkpoint.message_index : fallbackIndex,
    eventIndex: Number.isInteger(checkpoint.message_index) ? checkpoint.message_index : fallbackIndex,
    timestamp: checkpoint.timestamp ?? fallbackMessage?.timestamp ?? null,
    time: checkpoint.time || fallbackMessage?.time || "",
    summary: checkpoint.summary || "Rollback marker"
  };
}

function canForkFromMessage(message) {
  return (
    state.mode === "main"
    && state.currentThread?.summary?.id
    && message?.role === "user"
    && Number.isInteger(message.line_number)
  );
}

function canRollbackToMessage(message, index) {
  return (
    state.mode === "main"
    && state.currentThread?.summary?.id
    && message?.role === "user"
    && !message.rolled_back
    && Number.isInteger(message.line_number)
    && activeUserTurnsAfter(index) > 0
  );
}

function activeUserTurnsAfter(index) {
  const messages = state.currentThread?.messages || [];
  let count = 0;
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const message = messages[cursor];
    if (message?.role === "user" && !message.rolled_back && Number.isInteger(message.line_number)) {
      count += 1;
    }
  }
  return count;
}

async function createRollbackToMessage(message, index, button) {
  const summary = state.currentThread?.summary;
  const lineNumber = message?.line_number;
  if (!summary?.id || !Number.isInteger(lineNumber)) {
    return;
  }
  const turnCount = activeUserTurnsAfter(index);
  if (turnCount <= 0) {
    els.sourceLine.textContent = "No later active user turns to roll back.";
    return;
  }
  const label = turnCount === 1 ? "1 later user turn" : `${turnCount} later user turns`;
  const confirmed = await confirmWriteAction({
    title: "Create rollback to this message?",
    body: `This appends a Codex rollback marker and marks ${label} as rolled back. The original messages stay preserved.`,
    details: [
      { label: "Target", value: collapsedMessageHeading(message.text || "") || "Selected user message" },
      { label: "Turns affected", value: label },
      { label: "Change", value: "Appends a rollback marker to the current conversation" }
    ],
    confirmLabel: "Create rollback",
    opener: button
  });
  if (!confirmed) {
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await fetchJson(
      `/api/main-threads/${encodeURIComponent(summary.id)}/rollback-to-message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_number: lineNumber })
      }
    );
    const warning = result.state_update_error ? ` State timestamp update failed: ${result.state_update_error}` : "";
    els.sourceLine.textContent = `Created rollback for ${result.rollback_turns} turn(s).${warning}`;
    await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    await openThread("main", summary.id);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    els.sourceLine.textContent = error.message || String(error);
  }
}

function renderToolRun(run) {
  const first = run[0];
  const last = run[run.length - 1];
  const runId = toolRunId(first.index, last.index);
  const isExpanded = state.expandedToolRuns.has(runId);
  const hasRolledBackMessages = run.some((item) => item.message?.rolled_back);
  const wrapper = document.createElement("section");
  wrapper.className = `tool-run${isExpanded ? "" : " collapsed"}${hasRolledBackMessages ? " rolled-back" : ""}`;
  wrapper.dataset.toolRunId = runId;
  wrapper.dataset.toolRunStart = String(first.index);
  wrapper.dataset.toolRunEnd = String(last.index);
  wrapper.__toolRunItems = run;
  for (const item of run) {
    state.toolRunByMessageIndex.set(item.index, runId);
  }

  const header = document.createElement("div");
  header.className = "message-header tool-run-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "message-toggle tool-run-toggle";
  toggle.tabIndex = -1;
  toggle.setAttribute("aria-expanded", String(isExpanded));

  const icon = document.createElement("span");
  icon.className = "message-toggle-icon";
  icon.textContent = isExpanded ? "-" : "+";

  const role = document.createElement("span");
  role.className = "role";
  role.textContent = "Tools";

  const preview = document.createElement("span");
  preview.className = "message-heading-preview";
  preview.textContent = toolRunPreview(run);

  toggle.append(icon, role, preview);

  const source = document.createElement("span");
  source.textContent = toolRunMeta(run);
  header.append(toggle, source);
  wrapper.appendChild(header);

  let body = null;
  toggle.addEventListener("click", () => {
    body = body || ensureToolRunBody(wrapper);
    setToolRunExpanded(wrapper, body, toggle, wrapper.classList.contains("collapsed"));
  });

  if (isExpanded) {
    body = ensureToolRunBody(wrapper);
    setToolRunExpanded(wrapper, body, toggle, true);
  }

  return wrapper;
}

function renderRollbackGroup(group) {
  const first = group[0];
  const last = group[group.length - 1];
  const groupId = rollbackGroupId(first.index, last.index);
  const isExpanded = state.expandedToolRuns.has(groupId);
  const wrapper = document.createElement("section");
  wrapper.className = `rollback-group${isExpanded ? "" : " collapsed"}`;
  wrapper.dataset.rollbackGroupId = groupId;
  wrapper.dataset.rollbackGroupStart = String(first.index);
  wrapper.dataset.rollbackGroupEnd = String(last.index);
  wrapper.__rollbackGroupItems = group;
  for (const item of group) {
    state.toolRunByMessageIndex.set(item.index, groupId);
  }

  const header = document.createElement("div");
  header.className = "message-header rollback-group-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "message-toggle rollback-group-toggle";
  toggle.tabIndex = -1;
  toggle.setAttribute("aria-expanded", String(isExpanded));

  const icon = document.createElement("span");
  icon.className = "message-toggle-icon";
  icon.textContent = isExpanded ? "-" : "+";

  const role = document.createElement("span");
  role.className = "role";
  role.textContent = "Rollback";

  const preview = document.createElement("span");
  preview.className = "message-heading-preview";
  const headingText = rollbackGroupPreview(group);
  setAutoDirection(preview, headingText);
  preview.textContent = headingText;

  toggle.append(icon, role, preview);

  const source = document.createElement("span");
  source.className = "message-source";
  source.textContent = rollbackGroupMeta(group);
  header.append(toggle, source);
  const actions = renderRollbackGroupActions(group);
  if (actions) {
    header.appendChild(actions);
  }
  wrapper.appendChild(header);

  let body = null;
  toggle.addEventListener("click", () => {
    body = body || ensureRollbackGroupBody(wrapper);
    setRollbackGroupExpanded(wrapper, body, toggle, wrapper.classList.contains("collapsed"));
  });

  if (isExpanded) {
    body = ensureRollbackGroupBody(wrapper);
    setRollbackGroupExpanded(wrapper, body, toggle, true);
  }

  return wrapper;
}

function renderRollbackGroupActions(group) {
  const rollbacks = rollbackCheckpointsForGroup(group);
  if (rollbacks.length === 0) {
    return null;
  }
  const actions = document.createElement("div");
  actions.className = "message-actions";

  for (const rollback of rollbacks) {
    const label = rollbacks.length === 1
      ? "Undo as fork"
      : `Undo #${rollback.ordinal || "?"} as fork`;
    actions.appendChild(createRollbackUndoButton(rollback, label));
  }
  return actions;
}

function rollbackCheckpointsForGroup(group) {
  const matches = [];
  const seen = new Set();
  const add = (rollback) => {
    if (!rollback) {
      return;
    }
    const key = rollback.lineNumber ?? rollback.timestamp ?? rollback.eventIndex ?? rollback.ordinal;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    matches.push(rollback);
  };

  for (const item of group) {
    add(rollbackCheckpointForMessage(item.message, item.index));
  }

  const timestamps = new Set(
    group
      .map((item) => item.message?.rolled_back_by_timestamp)
      .filter((timestamp) => timestamp !== undefined && timestamp !== null)
      .map((timestamp) => String(timestamp))
  );
  const checkpoints = state.currentThread?.rollbacks || [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.timestamp !== undefined && checkpoint.timestamp !== null && timestamps.has(String(checkpoint.timestamp))) {
      add(normalizeRollbackCheckpoint(checkpoint, null, checkpoint.message_index));
    }
  }

  matches.sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
  return matches;
}

function rollbackGroupId(start, end) {
  return `rollback-group-${start}-${end}`;
}

function rollbackGroupPreview(group) {
  const firstText = group.find((item) => item.message?.rolled_back && item.message?.text)?.message?.text
    || group.find((item) => item.message?.text)?.message?.text
    || "";
  const heading = collapsedMessageHeading(firstText);
  const rolledBackCount = group.filter((item) => item.message?.rolled_back).length;
  const eventCount = group.filter((item) => item.message?.role === "event" && !item.message?.rolled_back).length;
  const parts = [
    `${rolledBackCount} rolled-back ${rolledBackCount === 1 ? "message" : "messages"}`
  ];
  if (eventCount > 0) {
    parts.push(`${eventCount} ${eventCount === 1 ? "event" : "events"}`);
  }
  const suffix = parts.join(", ");
  return heading ? `${suffix} | ${heading}` : suffix;
}

function rollbackLinkPreview(group) {
  const firstText = group.find((item) => item.message?.rolled_back && item.message?.text)?.message?.text
    || group.find((item) => item.message?.text)?.message?.text
    || "";
  const heading = collapsedMessageHeading(firstText);
  const rolledBackCount = group.filter((item) => item.message?.rolled_back).length;
  const suffix = `${rolledBackCount} rolled-back ${rolledBackCount === 1 ? "message" : "messages"}`;
  return heading ? `${suffix} | ${heading}` : suffix;
}

function rollbackGroupMeta(group) {
  const first = group.find((item) => item.message?.rolled_back)?.message || group[0]?.message;
  const rollbackAt = first?.rolled_back_at;
  return rollbackAt ? `rolled back at ${rollbackAt}` : "rolled back";
}

function ensureRollbackGroupBody(wrapper) {
  let body = wrapper.querySelector(".rollback-group-body");
  if (body) {
    return body;
  }
  body = document.createElement("div");
  body.className = "rollback-group-body";
  const units = rollbackGroupChildUnits(wrapper.__rollbackGroupItems || []);
  for (const unit of units) {
    if (unit.type === "toolRun") {
      body.appendChild(renderToolRun(unit.run));
    } else {
      body.appendChild(renderMessage(unit.message, unit.index, { insideRollbackGroup: true }));
    }
  }
  body.hidden = true;
  wrapper.appendChild(body);
  return body;
}

function rollbackGroupChildUnits(items) {
  const units = [];
  let pendingToolRun = [];
  const flushToolRun = () => {
    if (pendingToolRun.length === 0) {
      return;
    }
    if (pendingToolRun.length >= TOOL_RUN_GROUP_MIN_SIZE) {
      units.push(toolRunUnit(pendingToolRun));
    } else {
      for (const item of pendingToolRun) {
        units.push(messageUnit(item.message, item.index));
      }
    }
    pendingToolRun = [];
  };
  for (const item of items) {
    if (item.message?.role === "tool") {
      pendingToolRun.push(item);
    } else {
      flushToolRun();
      units.push(messageUnit(item.message, item.index));
    }
  }
  flushToolRun();
  return units;
}

function setRollbackGroupExpanded(wrapper, body, toggle, expanded) {
  const groupId = wrapper.dataset.rollbackGroupId;
  wrapper.classList.toggle("collapsed", !expanded);
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  const icon = toggle.querySelector(".message-toggle-icon");
  if (icon) {
    icon.textContent = expanded ? "-" : "+";
  }
  if (groupId) {
    if (expanded) {
      state.expandedToolRuns.add(groupId);
    } else {
      state.expandedToolRuns.delete(groupId);
    }
  }
  scheduleVirtualTranscriptMeasure();
}

function toolRunId(start, end) {
  return `tool-run-${start}-${end}`;
}

function toolRunPreview(run) {
  const firstHeading = collapsedMessageHeading(run[0]?.message?.text || "");
  if (!firstHeading) {
    return `${run.length} tool entries`;
  }
  return `${run.length} tool entries | ${firstHeading}`;
}

function toolRunMeta(run) {
  const first = run[0]?.message;
  const last = run[run.length - 1]?.message;
  const start = text(first?.time);
  const end = last && last.time && last.time !== first?.time ? ` to ${last.time}` : "";
  const rolledBack = run.some((item) => item.message?.rolled_back);
  const rollbackAt = run.find((item) => item.message?.rolled_back_at)?.message?.rolled_back_at;
  const rollback = rolledBack ? ` | rolled back${rollbackAt ? ` at ${rollbackAt}` : ""}` : "";
  return `${start}${end}${rollback}`;
}

function ensureToolRunBody(wrapper) {
  let body = wrapper.querySelector(".tool-run-body");
  if (body) {
    return body;
  }
  body = document.createElement("div");
  body.className = "tool-run-body";
  for (const item of wrapper.__toolRunItems || []) {
    body.appendChild(renderMessage(item.message, item.index));
  }
  body.hidden = true;
  wrapper.appendChild(body);
  return body;
}

function setToolRunExpanded(wrapper, body, toggle, expanded) {
  const runId = wrapper.dataset.toolRunId;
  wrapper.classList.toggle("collapsed", !expanded);
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  const icon = toggle.querySelector(".message-toggle-icon");
  if (icon) {
    icon.textContent = expanded ? "-" : "+";
  }
  if (runId) {
    if (expanded) {
      state.expandedToolRuns.add(runId);
    } else {
      state.expandedToolRuns.delete(runId);
    }
  }
  scheduleVirtualTranscriptMeasure();
}

function expandToolRunForMessage(messageIndex) {
  const runId = state.toolRunByMessageIndex.get(messageIndex);
  if (!runId) {
    return null;
  }
  if (runId.startsWith("rollback-group-")) {
    return expandRollbackGroupForMessage(messageIndex, runId);
  }
  const wrapper = els.messages.querySelector(`.tool-run[data-tool-run-id="${runId}"]`);
  if (!wrapper) {
    return null;
  }
  expandContainingRollbackGroup(wrapper);
  const toggle = wrapper.querySelector(".tool-run-toggle");
  const body = ensureToolRunBody(wrapper);
  if (toggle && wrapper.classList.contains("collapsed")) {
    setToolRunExpanded(wrapper, body, toggle, true);
  }
  return wrapper.querySelector(`.message[data-message-index="${messageIndex}"]`);
}

function expandRollbackGroupForMessage(messageIndex, groupId) {
  const wrapper = els.messages.querySelector(`.rollback-group[data-rollback-group-id="${groupId}"]`);
  if (!wrapper) {
    return null;
  }
  const toggle = wrapper.querySelector(".rollback-group-toggle");
  const body = ensureRollbackGroupBody(wrapper);
  if (toggle && wrapper.classList.contains("collapsed")) {
    setRollbackGroupExpanded(wrapper, body, toggle, true);
  }
  let message = wrapper.querySelector(`.message[data-message-index="${messageIndex}"]`);
  if (!message) {
    message = expandToolRunForMessage(messageIndex);
  }
  return message;
}

function expandContainingRollbackGroup(element) {
  const group = element.closest(".rollback-group");
  if (!group || !group.classList.contains("collapsed")) {
    return;
  }
  const toggle = group.querySelector(".rollback-group-toggle");
  const body = ensureRollbackGroupBody(group);
  if (toggle) {
    setRollbackGroupExpanded(group, body, toggle, true);
  }
}

function messageFilterKey(message) {
  if (message.rolled_back) {
    return "rolledBack";
  }
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

function messageFilterKeys(message) {
  const keys = [messageFilterKey(message)];
  if (messageContainsDiff(message)) {
    keys.push("diff");
  }
  return [...new Set(keys)];
}

function messageContainsDiff(message) {
  return DIFF_BLOCK_PATTERN.test(String(message?.text || ""));
}

function updateMessageCount(visible, total) {
  if (state.currentThread && state.currentThread.summary) {
    els.metaCount.textContent = `${visible} of ${total} shown`;
  }
}

function expandCollapsedMessage(wrapper) {
  const toggle = wrapper.querySelector(".message-toggle");
  if (!toggle) {
    return;
  }
  const body = wrapper.querySelector(".message-body") || ensureLazyMessageBody(wrapper);
  setCollapsedMessageExpanded(wrapper, body, toggle, true);
}

function ensureLazyMessageBody(wrapper) {
  let body = wrapper.querySelector(".message-body");
  if (body) {
    return body;
  }
  body = document.createElement("div");
  body.className = "message-body";
  body.id = wrapper.dataset.bodyId || `message-body-${wrapper.dataset.messageIndex || "unknown"}`;
  body.hidden = true;
  body.dataset.rendered = "false";
  body.__messageText = wrapper.__messageText || "";
  body.__messageRenderMode = wrapper.__messageRenderMode || "full";
  wrapper.appendChild(body);
  return body;
}

function setCollapsedMessageExpanded(wrapper, body, toggle, expanded) {
  wrapper.classList.toggle("collapsed", !expanded);
  const messageIndex = Number(wrapper.dataset.messageIndex);
  if (Number.isInteger(messageIndex)) {
    if (expanded) {
      state.expandedMessages.add(messageIndex);
    } else {
      state.expandedMessages.delete(messageIndex);
    }
  }
  if (expanded) {
    ensureMessageBodyRendered(body);
  }
  body.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  const icon = toggle.querySelector(".message-toggle-icon");
  if (icon) {
    icon.textContent = expanded ? "-" : "+";
  }
  scheduleVirtualTranscriptMeasure();
}

function ensureMessageBodyRendered(body) {
  if (body.dataset.rendered !== "false") {
    return;
  }
  const value = body.__messageText || "";
  renderMessageBodyContent(body, value, body.__messageRenderMode || "full");
  body.dataset.rendered = "true";
}

function renderMessageBodyContent(body, value, renderMode = "full") {
  const textValue = String(value || "");
  const visibleValue = renderMode === "diffs" ? diffOnlyMarkdown(textValue) : textValue;
  setAutoDirection(body, visibleValue);
  body.replaceChildren(
    renderMode === "diffs"
      ? renderDiffOnlyText(textValue)
      : renderFormattedText(textValue)
  );
}

function collapsedMessageHeading(value) {
  const firstLine = firstNonEmptyLine(value, 1200);
  if (!firstLine) return "";
  const heading = firstLine.match(/^#{1,6}\s+(.+)$/)
    || firstLine.match(/^\*\*(.+?)\*\*$/)
    || firstLine.match(/^__(.+?)__$/);
  const textValue = heading ? heading[1] : firstLine;
  return compactInlineText(stripInlineMarkup(textValue), 90);
}

function firstNonEmptyLine(value, limit) {
  const textValue = String(value);
  const scanLength = Math.min(textValue.length, limit);
  let start = 0;
  for (let index = 0; index <= scanLength; index += 1) {
    if (index < scanLength && textValue[index] !== "\n" && textValue[index] !== "\r") {
      continue;
    }
    const line = textValue.slice(start, index).trim();
    if (line) {
      return line;
    }
    if (textValue[index] === "\r" && textValue[index + 1] === "\n") {
      index += 1;
    }
    start = index + 1;
  }
  return textValue.slice(0, scanLength).trim();
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

function renderRoleLabel(message) {
  const wrapper = document.createElement("span");
  wrapper.className = "role";
  if (message?.role !== "assistant") {
    wrapper.textContent = roleLabel(message?.role);
    return wrapper;
  }

  const role = document.createElement("span");
  role.className = "role-word";
  role.textContent = "Assistant";

  const stage = document.createElement("span");
  stage.className = `role-stage ${message.__finalAssistantReply ? "final" : "interim"}`;
  stage.textContent = message.__finalAssistantReply ? "final" : "interim";

  wrapper.append(role, stage);
  return wrapper;
}

function renderFormattedText(value, options = {}) {
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

    const fence = line.match(/^(`{3,})([A-Za-z0-9_.+-]*)\s*$/);
    if (fence) {
      const codeLines = [];
      const closeFence = new RegExp(`^\`{${fence[1].length},}\\s*$`);
      index += 1;
      while (index < lines.length && !closeFence.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      fragment.appendChild(renderCodeBlock(codeLines.join("\n"), fence[2]));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const element = document.createElement("h4");
      element.className = `md-heading level-${heading[1].length}`;
      setAutoDirection(element, heading[2]);
      element.appendChild(renderInline(heading[2], options));
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
        li.appendChild(renderInline(item[1], options));
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
        li.appendChild(renderInline(item[1], options));
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
      quote.appendChild(renderInline(quoteLines.join(" "), options));
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

    const table = parseMarkdownTable(lines, index);
    if (table) {
      fragment.appendChild(renderMarkdownTable(table, options));
      index = table.nextIndex;
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines[index], lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    setAutoDirection(paragraph, paragraphLines.join("\n"));
    appendFormattedLines(paragraph, paragraphLines, options);
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

function renderDiffOnlyText(value) {
  const fragment = document.createDocumentFragment();
  for (const block of extractDiffCodeBlocks(value)) {
    fragment.appendChild(renderDiffBlock(block.code, block.language));
  }
  if (!fragment.childNodes.length) {
    fragment.appendChild(document.createTextNode(""));
  }
  return fragment;
}

function diffOnlyMarkdown(value) {
  return extractDiffCodeBlocks(value)
    .map((block) => markdownCodeBlock(block.code, block.language))
    .join("\n\n");
}

function extractDiffCodeBlocks(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const fence = lines[index].match(/^(`{3,})([A-Za-z0-9_.+-]*)\s*$/);
    if (!fence) {
      index += 1;
      continue;
    }
    const language = fence[2] || "";
    const codeLines = [];
    const closeFence = new RegExp(`^\`{${fence[1].length},}\\s*$`);
    index += 1;
    while (index < lines.length && !closeFence.test(lines[index])) {
      codeLines.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }
    if (isDiffLanguage(language)) {
      blocks.push({ code: codeLines.join("\n"), language });
    }
  }
  return blocks;
}

function markdownCodeBlock(value, language = "") {
  const textValue = String(value || "");
  const fence = markdownCodeFence(textValue);
  return `${fence}${language || ""}\n${textValue}\n${fence}`;
}

function markdownCodeFence(value) {
  const runs = String(value || "").match(/`+/g) || [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

function appendFormattedLines(parent, lines, options = {}) {
  for (const line of lines) {
    const span = document.createElement("span");
    span.className = "bidi-line";
    setAutoDirection(span, line);
    span.appendChild(renderInline(line, options));
    parent.appendChild(span);
  }
}

function isBlockStart(line, lines = [], index = 0) {
  return /^`{3,}[A-Za-z0-9_.+-]*\s*$/.test(line)
    || /^(#{1,4})\s+/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*---+\s*$/.test(line)
    || Boolean(parseMarkdownTable(lines, index));
}

function renderCodeBlock(codeText, language) {
  if (isDiffLanguage(language)) {
    return renderDiffBlock(codeText, language);
  }

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

function isDiffLanguage(language) {
  const normalized = String(language || "").toLowerCase();
  return normalized === "diff" || normalized === "patch";
}

function renderDiffBlock(codeText, language) {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-view";

  const pre = document.createElement("pre");
  pre.dir = "ltr";
  const code = document.createElement("code");
  code.dir = "ltr";
  code.className = "diff-code";
  if (language) {
    code.dataset.language = language;
  }
  renderDiffCodeLines(code, codeText);
  pre.appendChild(code);
  wrapper.appendChild(pre);

  const raw = renderRawDiffDetails(codeText);
  if (raw) {
    wrapper.appendChild(raw);
  }
  return wrapper;
}

function renderRawDiffDetails(codeText) {
  const normalized = String(codeText || "");
  if (!normalized.trim()) {
    return null;
  }

  const details = document.createElement("details");
  details.className = "diff-raw";
  const summary = document.createElement("summary");
  summary.textContent = "Raw diff";
  const pre = document.createElement("pre");
  pre.dir = "ltr";
  const code = document.createElement("code");
  code.dir = "ltr";
  code.textContent = normalized;
  pre.appendChild(code);
  details.append(summary, pre);
  return details;
}

function renderDiffCodeLines(code, codeText) {
  const normalized = String(codeText).replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const entries = [];
  let oldLineNumber = null;
  let newLineNumber = null;
  let previousFileLabel = "";
  let pendingOldFilePath = "";
  for (const line of lines) {
    const lineClass = diffLineClass(line);
    if (lineClass === "diff-line-file") {
      if (line.startsWith("--- ")) {
        pendingOldFilePath = cleanDiffPath(line.slice(4));
      } else if (line.startsWith("+++ ")) {
        const newFilePath = cleanDiffPath(line.slice(4));
        const filePath = newFilePath === "/dev/null" ? pendingOldFilePath : newFilePath;
        previousFileLabel = appendDiffFileLabel(entries, filePath, previousFileLabel);
      }
    } else if (lineClass === "diff-line-header") {
      previousFileLabel = appendDiffFileLabel(
        entries,
        diffHeaderFilePath(line),
        previousFileLabel
      );
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    let lineNumber = "";
    if (hunk) {
      oldLineNumber = Number(hunk[1]);
      newLineNumber = Number(hunk[2]);
    } else if (oldLineNumber !== null && newLineNumber !== null) {
      if (lineClass === "diff-line-add") {
        lineNumber = String(newLineNumber);
        newLineNumber += 1;
      } else if (lineClass === "diff-line-del") {
        lineNumber = String(oldLineNumber);
        oldLineNumber += 1;
      } else if (lineClass === "diff-line-context") {
        lineNumber = String(newLineNumber);
        oldLineNumber += 1;
        newLineNumber += 1;
      }
    }
    entries.push({
      line,
      text: cleanDiffLineText(line, lineClass),
      lineClass,
      lineNumber,
      ranges: []
    });
  }
  annotateIntralineDiffs(entries);
  let previousPosition = null;
  for (const entry of entries) {
    if (entry.skip) {
      continue;
    }
    if (entry.lineClass === "diff-file-gap" || entry.lineClass === "diff-file-label") {
      code.appendChild(renderDiffLine(entry.text, entry.lineClass, entry.lineNumber, entry.ranges));
      previousPosition = null;
      continue;
    }
    if (entry.combined) {
      previousPosition = appendDiffEntryWithGap(
        code,
        renderCombinedDiffLine(entry.combined),
        combinedDiffPosition(entry.combined),
        previousPosition
      );
      continue;
    }
    if (!shouldRenderCleanDiffEntry(entry)) {
      continue;
    }
    previousPosition = appendDiffEntryWithGap(
      code,
      renderDiffLine(entry.text, entry.lineClass, entry.lineNumber, entry.ranges),
      diffEntryPosition(entry),
      previousPosition
    );
  }
}

function appendDiffEntryWithGap(code, element, position, previousPosition) {
  if (shouldInsertDiffGap(previousPosition, position)) {
    code.appendChild(renderDiffGap());
  }
  code.appendChild(element);
  return position || previousPosition;
}

function shouldInsertDiffGap(previousPosition, position) {
  if (!previousPosition || !position) {
    return false;
  }
  const oldGap = lineGap(previousPosition.oldLine, position.oldLine);
  const newGap = lineGap(previousPosition.newLine, position.newLine);
  return oldGap > 1 || newGap > 1;
}

function lineGap(previousLine, currentLine) {
  if (!Number.isInteger(previousLine) || !Number.isInteger(currentLine)) {
    return 0;
  }
  return currentLine - previousLine;
}

function diffEntryPosition(entry) {
  const lineNumber = Number(entry.lineNumber);
  if (!Number.isInteger(lineNumber)) {
    return null;
  }
  if (entry.lineClass === "diff-line-del") {
    return { oldLine: lineNumber, newLine: null };
  }
  if (entry.lineClass === "diff-line-add") {
    return { oldLine: null, newLine: lineNumber };
  }
  if (entry.lineClass === "diff-line-context") {
    return { oldLine: lineNumber, newLine: lineNumber };
  }
  return null;
}

function combinedDiffPosition(change) {
  return {
    oldLine: numericDiffLine(change.oldLineNumber),
    newLine: numericDiffLine(change.newLineNumber)
  };
}

function numericDiffLine(value) {
  const line = Number(value);
  return Number.isInteger(line) ? line : null;
}

function appendDiffFileLabel(entries, filePath, previousFileLabel) {
  const label = cleanDiffPath(filePath);
  if (!label || label === "/dev/null" || label === previousFileLabel) {
    return previousFileLabel;
  }
  if (previousFileLabel) {
    entries.push({
      line: "",
      text: "",
      lineClass: "diff-file-gap",
      lineNumber: "",
      ranges: []
    });
  }
  entries.push({
    line: label,
    text: label,
    lineClass: "diff-file-label",
    lineNumber: "",
    ranges: []
  });
  return label;
}

function diffHeaderFilePath(line) {
  const match = line.match(/^diff --git\s+a\/(.+)\s+b\/(.+)$/);
  return match ? match[2] : "";
}

function cleanDiffPath(value) {
  const path = String(value || "").trim().split(/\t/)[0];
  if ((path.startsWith("a/") || path.startsWith("b/")) && path.length > 2) {
    return path.slice(2);
  }
  return path;
}

function cleanDiffLineText(line, lineClass) {
  if (
    (lineClass === "diff-line-add" || lineClass === "diff-line-del")
    && (line.startsWith("+") || line.startsWith("-"))
  ) {
    return line.slice(1);
  }
  if (lineClass === "diff-line-context" && line.startsWith(" ")) {
    return line.slice(1);
  }
  return line;
}

function shouldRenderCleanDiffEntry(entry) {
  return ![
    "diff-line-header",
    "diff-line-meta",
    "diff-line-note",
    "diff-line-hunk",
    "diff-line-file"
  ].includes(entry.lineClass);
}

function annotateIntralineDiffs(entries) {
  let index = 0;
  while (index < entries.length) {
    if (entries[index].lineClass !== "diff-line-del") {
      index += 1;
      continue;
    }
    const deleteStart = index;
    while (index < entries.length && entries[index].lineClass === "diff-line-del") {
      index += 1;
    }
    const addStart = index;
    while (index < entries.length && entries[index].lineClass === "diff-line-add") {
      index += 1;
    }
    const pairs = similarDiffLinePairs(
      entries.slice(deleteStart, addStart),
      entries.slice(addStart, index)
    );
    for (const [deleted, added] of pairs) {
      const oldText = deleted.text;
      const newText = added.text;
      const combinedParts = combinedDiffParts(oldText, newText);
      if (combinedParts) {
        deleted.skip = true;
        added.combined = {
          oldLineNumber: deleted.lineNumber,
          newLineNumber: added.lineNumber,
          parts: combinedParts
        };
      } else {
        const ranges = intralineDiffRanges(oldText, newText);
        deleted.ranges = ranges.oldRanges;
        added.ranges = ranges.newRanges;
      }
    }
  }
}

function similarDiffLinePairs(deletedLines, addedLines) {
  const candidates = [];
  for (const deleted of deletedLines) {
    for (const added of addedLines) {
      const score = diffLineSimilarity(deleted.text, added.text);
      if (score >= MIN_INTRALINE_PAIR_SCORE) {
        candidates.push({ deleted, added, score });
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score);

  const usedDeleted = new Set();
  const usedAdded = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (usedDeleted.has(candidate.deleted) || usedAdded.has(candidate.added)) {
      continue;
    }
    usedDeleted.add(candidate.deleted);
    usedAdded.add(candidate.added);
    pairs.push([candidate.deleted, candidate.added]);
  }
  return pairs;
}

function diffLineSimilarity(oldText, newText) {
  const oldTrimmed = oldText.trim();
  const newTrimmed = newText.trim();
  if (!oldTrimmed || !newTrimmed) {
    return oldTrimmed === newTrimmed ? 1 : 0;
  }
  if (oldTrimmed === newTrimmed) {
    return 1;
  }
  if (
    Math.min(oldTrimmed.length, newTrimmed.length) >= 6
    && (oldTrimmed.includes(newTrimmed) || newTrimmed.includes(oldTrimmed))
  ) {
    return 0.95;
  }

  const tokenScore = tokenSimilarity(oldTrimmed, newTrimmed);
  if (tokenScore >= MIN_INTRALINE_PAIR_SCORE) {
    return tokenScore;
  }

  const edgeScore = commonPrefixSuffixLength(oldTrimmed, newTrimmed)
    / Math.min(oldTrimmed.length, newTrimmed.length);
  if (edgeScore >= MIN_INTRALINE_PAIR_SCORE) {
    return edgeScore;
  }

  if (oldTrimmed.length * newTrimmed.length > MAX_PAIR_SIMILARITY_CELLS) {
    return Math.max(tokenScore, edgeScore);
  }

  const charScore = commonSubsequenceRatio(oldTrimmed, newTrimmed);
  return Math.max(charScore, tokenScore, edgeScore);
}

function commonSubsequenceRatio(oldText, newText) {
  const commonLength = commonSubsequenceLength(oldText, newText);
  return commonLength / Math.min(oldText.length, newText.length);
}

function tokenSimilarity(oldText, newText) {
  const oldTokens = diffTokens(oldText);
  const newTokens = diffTokens(newText);
  if (!oldTokens.length || !newTokens.length) {
    return 0;
  }
  const counts = new Map();
  for (const token of oldTokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  let shared = 0;
  for (const token of newTokens) {
    const count = counts.get(token) || 0;
    if (count > 0) {
      shared += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * shared) / (oldTokens.length + newTokens.length);
}

function diffTokens(value) {
  return String(value).match(/[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu) || [];
}

function combinedDiffParts(oldText, newText) {
  if (!oldText && !newText) {
    return [];
  }
  const oldTokens = diffTextTokens(oldText);
  const newTokens = diffTextTokens(newText);
  if (oldTokens.length * newTokens.length > MAX_COMBINED_DIFF_TOKEN_CELLS) {
    return null;
  }

  const table = commonTokenSubsequenceTable(oldTokens, newTokens);
  const parts = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      appendCombinedDiffPart(parts, "equal", oldTokens[oldIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      appendCombinedDiffPart(parts, "delete", oldTokens[oldIndex]);
      oldIndex += 1;
    } else {
      appendCombinedDiffPart(parts, "add", newTokens[newIndex]);
      newIndex += 1;
    }
  }

  while (oldIndex < oldTokens.length) {
    appendCombinedDiffPart(parts, "delete", oldTokens[oldIndex]);
    oldIndex += 1;
  }
  while (newIndex < newTokens.length) {
    appendCombinedDiffPart(parts, "add", newTokens[newIndex]);
    newIndex += 1;
  }

  return parts;
}

function diffTextTokens(value) {
  return String(value).match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu) || [];
}

function commonTokenSubsequenceTable(oldTokens, newTokens) {
  const table = Array.from(
    { length: oldTokens.length + 1 },
    () => new Uint16Array(newTokens.length + 1)
  );
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldTokens[oldIndex] === newTokens[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  return table;
}

function appendCombinedDiffPart(parts, type, text) {
  if (!text) {
    return;
  }
  const last = parts[parts.length - 1];
  if (last?.type === type) {
    last.text += text;
  } else {
    parts.push({ type, text });
  }
}

function intralineDiffRanges(oldText, newText) {
  if (!oldText && !newText) {
    return { oldRanges: [], newRanges: [] };
  }
  if (oldText.length * newText.length > MAX_INTRALINE_DIFF_CELLS) {
    return prefixSuffixDiffRanges(oldText, newText);
  }

  const oldLength = oldText.length;
  const newLength = newText.length;
  const table = commonSubsequenceTable(oldText, newText);
  if (!table) {
    return prefixSuffixDiffRanges(oldText, newText);
  }

  const oldUnchanged = new Array(oldLength).fill(false);
  const newUnchanged = new Array(newLength).fill(false);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldText[oldIndex] === newText[newIndex]) {
      oldUnchanged[oldIndex] = true;
      newUnchanged[newIndex] = true;
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }

  const lcsRanges = {
    oldRanges: changedRanges(oldUnchanged),
    newRanges: changedRanges(newUnchanged)
  };
  const prefixSuffixRanges = prefixSuffixDiffRanges(oldText, newText);
  const selectedRanges = diffRangeCount(prefixSuffixRanges) <= diffRangeCount(lcsRanges)
    ? prefixSuffixRanges
    : lcsRanges;
  return expandLeadingWordReplacementRanges(oldText, newText, selectedRanges);
}

function commonSubsequenceLength(oldText, newText) {
  if (oldText.length * newText.length > MAX_INTRALINE_DIFF_CELLS) {
    return commonPrefixSuffixLength(oldText, newText);
  }
  const table = commonSubsequenceTable(oldText, newText);
  return table ? table[0][0] : commonPrefixSuffixLength(oldText, newText);
}

function commonSubsequenceTable(oldText, newText) {
  const oldLength = oldText.length;
  const newLength = newText.length;
  if (oldLength * newLength > MAX_INTRALINE_DIFF_CELLS) {
    return null;
  }
  const table = Array.from({ length: oldLength + 1 }, () => new Uint16Array(newLength + 1));
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldText[oldIndex] === newText[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  return table;
}

function commonPrefixSuffixLength(oldText, newText) {
  let prefixLength = 0;
  while (
    prefixLength < oldText.length
    && prefixLength < newText.length
    && oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldText.length - prefixLength
    && suffixLength < newText.length - prefixLength
    && oldText[oldText.length - suffixLength - 1] === newText[newText.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return prefixLength + suffixLength;
}

function prefixSuffixDiffRanges(oldText, newText) {
  let prefixLength = 0;
  while (
    prefixLength < oldText.length
    && prefixLength < newText.length
    && oldText[prefixLength] === newText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldText.length - prefixLength
    && suffixLength < newText.length - prefixLength
    && oldText[oldText.length - suffixLength - 1] === newText[newText.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return {
    oldRanges: prefixLength < oldText.length - suffixLength
      ? [[prefixLength, oldText.length - suffixLength]]
      : [],
    newRanges: prefixLength < newText.length - suffixLength
      ? [[prefixLength, newText.length - suffixLength]]
      : []
  };
}

function diffRangeCount(result) {
  return result.oldRanges.length + result.newRanges.length;
}

function expandLeadingWordReplacementRanges(oldText, newText, ranges) {
  if (ranges.oldRanges.length !== 1 || ranges.newRanges.length !== 1) {
    return ranges;
  }
  const [oldStart, oldEnd] = ranges.oldRanges[0];
  const [newStart, newEnd] = ranges.newRanges[0];
  if (oldEnd - oldStart <= 2 && newEnd - newStart <= 2) {
    return ranges;
  }

  const oldToken = wordTokenContainingRange(oldText, oldStart, oldEnd);
  const newToken = wordTokenContainingRange(newText, newStart, newEnd);
  if (!oldToken || !newToken) {
    return ranges;
  }

  if (
    oldStart === oldToken.start
    && newStart === newToken.start
    && oldEnd < oldToken.end
    && newEnd < newToken.end
  ) {
    return {
      oldRanges: [[oldToken.start, oldToken.end]],
      newRanges: [[newToken.start, newToken.end]]
    };
  }
  return ranges;
}

function wordTokenContainingRange(text, start, end) {
  if (start >= end) {
    return null;
  }
  const matcher = /[\p{L}\p{N}_$]+/gu;
  let match;
  while ((match = matcher.exec(text))) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    if (start >= tokenStart && end <= tokenEnd) {
      return { start: tokenStart, end: tokenEnd };
    }
  }
  return null;
}

function changedRanges(unchanged) {
  const ranges = [];
  let index = 0;
  while (index < unchanged.length) {
    while (index < unchanged.length && unchanged[index]) {
      index += 1;
    }
    const start = index;
    while (index < unchanged.length && !unchanged[index]) {
      index += 1;
    }
    if (start < index) {
      ranges.push([start, index]);
    }
  }
  return ranges;
}

function renderCombinedDiffLine(change) {
  const span = document.createElement("span");
  span.className = "diff-line diff-line-change";
  span.dataset.line = combinedDiffLineNumber(change.oldLineNumber, change.newLineNumber);
  if (change.oldLineNumber && change.newLineNumber) {
    span.title = `Old line ${change.oldLineNumber}, new line ${change.newLineNumber}`;
  }

  const text = document.createElement("span");
  text.className = "diff-line-text";
  appendCombinedDiffText(text, change.parts);
  span.appendChild(text);
  return span;
}

function combinedDiffLineNumber(oldLineNumber, newLineNumber) {
  if (oldLineNumber && newLineNumber && oldLineNumber !== newLineNumber) {
    return `${oldLineNumber}/${newLineNumber}`;
  }
  return newLineNumber || oldLineNumber || "";
}

function appendCombinedDiffText(parent, parts) {
  for (const part of parts) {
    if (part.type === "equal") {
      parent.appendChild(document.createTextNode(part.text));
      continue;
    }
    const mark = document.createElement("span");
    mark.className = part.type === "delete" ? "diff-word-del" : "diff-word-add";
    mark.textContent = part.text;
    parent.appendChild(mark);
  }
}

function renderDiffGap() {
  const span = document.createElement("span");
  span.className = "diff-line diff-gap";
  span.dataset.line = "";
  const text = document.createElement("span");
  text.className = "diff-line-text";
  text.textContent = "";
  span.appendChild(text);
  return span;
}

function renderDiffLine(line, lineClass, lineNumber, ranges = []) {
  const span = document.createElement("span");
  span.className = `diff-line ${lineClass}`;
  span.dataset.line = lineNumber;
  const text = document.createElement("span");
  text.className = "diff-line-text";
  appendDiffLineText(text, line || " ", ranges);
  span.appendChild(text);
  return span;
}

function appendDiffLineText(parent, text, ranges) {
  if (!ranges.length) {
    parent.textContent = text;
    return;
  }

  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, start)));
    }
    if (end > start) {
      const mark = document.createElement("span");
      mark.className = "diff-inline-change";
      mark.textContent = text.slice(start, end);
      parent.appendChild(mark);
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function diffLineClass(line) {
  if (/^diff --git /.test(line)) return "diff-line-header";
  if (/^(index |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/.test(line)) {
    return "diff-line-meta";
  }
  if (/^@@ /.test(line)) return "diff-line-hunk";
  if (/^(\+\+\+|---) /.test(line)) return "diff-line-file";
  if (/^\+/.test(line)) return "diff-line-add";
  if (/^-/.test(line)) return "diff-line-del";
  if (/^\\ No newline/.test(line)) return "diff-line-note";
  return "diff-line-context";
}

function parseMarkdownTable(lines, startIndex) {
  if (!Array.isArray(lines) || startIndex + 1 >= lines.length) {
    return null;
  }
  const header = parseMarkdownTableRow(lines[startIndex]);
  const alignments = parseMarkdownTableSeparator(lines[startIndex + 1]);
  if (!header || !alignments || header.length < 2 || header.length !== alignments.length) {
    return null;
  }

  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    if (lines[index].trim() === "") {
      break;
    }
    const row = parseMarkdownTableRow(lines[index]);
    if (!row) {
      break;
    }
    rows.push(normalizeTableRow(row, header.length));
    index += 1;
  }

  return {
    header: normalizeTableRow(header, header.length),
    alignments,
    rows,
    nextIndex: index
  };
}

function parseMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  if (!cells || cells.length < 2) {
    return null;
  }
  const alignments = [];
  for (const cell of cells) {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) {
      return null;
    }
    const starts = value.startsWith(":");
    const ends = value.endsWith(":");
    alignments.push(starts && ends ? "center" : ends ? "right" : starts ? "left" : "");
  }
  return alignments;
}

function parseMarkdownTableRow(line) {
  const cells = splitMarkdownTableRow(line);
  return cells && cells.length >= 2 ? cells : null;
}

function splitMarkdownTableRow(line) {
  const value = String(line);
  if (!value.includes("|")) {
    return null;
  }
  const cells = [];
  let current = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) {
    current += "\\";
  }
  cells.push(current.trim());

  if (cells[0] === "") {
    cells.shift();
  }
  if (cells[cells.length - 1] === "") {
    cells.pop();
  }
  return cells.length >= 2 ? cells : null;
}

function normalizeTableRow(row, columnCount) {
  const normalized = row.slice(0, columnCount);
  while (normalized.length < columnCount) {
    normalized.push("");
  }
  return normalized;
}

function renderMarkdownTable(table, options = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "md-table-wrap";
  const element = document.createElement("table");
  element.className = "md-table";
  element.dir = tableDirection(table);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const [cellIndex, cellText] of table.header.entries()) {
    const th = document.createElement("th");
    setAutoDirection(th, cellText);
    applyTableAlignment(th, table.alignments[cellIndex]);
    th.appendChild(renderInline(cellText, options));
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  element.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    for (const [cellIndex, cellText] of row.entries()) {
      const td = document.createElement("td");
      setAutoDirection(td, cellText);
      applyTableAlignment(td, table.alignments[cellIndex]);
      td.appendChild(renderInline(cellText, options));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  element.appendChild(tbody);
  wrapper.appendChild(element);
  return wrapper;
}

function tableDirection(table) {
  const text = [
    ...(table.header || []),
    ...(table.rows || []).flat()
  ].join(" ");
  return dominantTextDirection(text);
}

function dominantTextDirection(value) {
  const textValue = String(value);
  const rtlCount = (textValue.match(/[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/g) || []).length;
  const ltrCount = (textValue.match(/[A-Za-z]/g) || []).length;
  return rtlCount > ltrCount ? "rtl" : "ltr";
}

function applyTableAlignment(element, alignment) {
  if (alignment) {
    element.classList.add(`align-${alignment}`);
  }
}

function setAutoDirection(element, value) {
  element.dir = "auto";
  element.dataset.hasRtl = hasRtlText(value) ? "true" : "false";
}

function hasRtlText(value) {
  return /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(String(value));
}

function renderInline(value, options = {}) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) {
      appendInlineText(fragment, value.slice(cursor, match.index), options);
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
    appendInlineText(fragment, value.slice(cursor), options);
  }
  return fragment;
}

function appendInlineText(fragment, value, options = {}) {
  if (!options.autoLinkMessageRefs) {
    fragment.appendChild(document.createTextNode(value));
    return;
  }
  const pattern = /\b[Mm]essages?\s+(\d+)\b/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) {
      fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    }
    const messageNumber = Number(match[1]);
    if (isValidConversationMessageNumber(messageNumber)) {
      fragment.appendChild(createConversationNavigationLink(match[0], {
        messageIndex: messageNumber - 1,
        quote: ""
      }));
    } else {
      fragment.appendChild(document.createTextNode(match[0]));
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < value.length) {
    fragment.appendChild(document.createTextNode(value.slice(cursor)));
  }
}

function renderSafeLink(label, href) {
  const conversationTarget = parseConversationNavigationHref(href);
  if (conversationTarget) {
    return createConversationNavigationLink(label, conversationTarget);
  }
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

function parseConversationNavigationHref(href) {
  const value = String(href || "").trim();
  const match = value.match(/^codex-message:(\d+)(?:\?(.*))?$/i);
  if (!match) {
    return null;
  }
  const messageNumber = Number(match[1]);
  if (!Number.isInteger(messageNumber) || messageNumber < 1) {
    return null;
  }
  const target = {
    messageIndex: messageNumber - 1,
    quote: ""
  };
  if (match[2]) {
    const params = new URLSearchParams(match[2]);
    target.quote = params.get("text") || params.get("quote") || params.get("q") || "";
  }
  return target;
}

function createConversationNavigationLink(label, target) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "conversation-nav-link";
  button.textContent = label;
  button.title = target.quote
    ? `Scroll to this text in message ${target.messageIndex + 1}`
    : `Scroll to message ${target.messageIndex + 1}`;
  button.addEventListener("click", () => scrollToConversationNavigationTarget(target));
  return button;
}

function scrollToConversationNavigationTarget(target) {
  if (!target || !Number.isInteger(target.messageIndex)) {
    return false;
  }
  const message = state.currentThread?.messages?.[target.messageIndex];
  if (!message) {
    els.askCodexStatus.textContent = `Message ${target.messageIndex + 1} is not in this conversation.`;
    return false;
  }

  clearConversationHighlights();
  clearAskCodexNavigationHighlights();

  let wrapper = findRenderedMessageWrapper(target.messageIndex);
  if (!wrapper) {
    const unitIndex = virtualUnitIndexForMessage(target.messageIndex);
    const deferred = Number.isInteger(unitIndex) && scrollToVirtualUnitIndex(unitIndex);
    if (deferred) {
      state.pendingScrollTarget = { type: "conversationNavigation", ...target };
    }
    els.askCodexStatus.textContent = deferred
      ? `Scrolled to message ${target.messageIndex + 1}.`
      : `Message ${target.messageIndex + 1} is hidden by the current filters.`;
    return deferred;
  }
  if (wrapper.classList.contains("collapsed")) {
    expandCollapsedMessage(wrapper);
  }

  if (target.quote) {
    const body = wrapper.querySelector(".message-body") || ensureLazyMessageBody(wrapper);
    ensureMessageBodyRendered(body);
    body.hidden = false;
    const mark = highlightAskCodexTargetInElement(body, target.quote);
    if (mark) {
      state.askCodex.activeMarks = [mark];
      scrollElementIntoMessages(mark);
      wrapper.classList.add("branch-link-focus");
      window.setTimeout(() => wrapper.classList.remove("branch-link-focus"), 1600);
      els.askCodexStatus.textContent = `Scrolled to text in message ${target.messageIndex + 1}.`;
      return true;
    }
    els.askCodexStatus.textContent = `Text not found in message ${target.messageIndex + 1}; scrolled to the message.`;
  } else {
    els.askCodexStatus.textContent = `Scrolled to message ${target.messageIndex + 1}.`;
  }
  return scrollToMessageIndex(target.messageIndex, { defer: true });
}

function highlightAskCodexTargetInElement(element, quote) {
  const candidates = askCodexTargetCandidates(quote);
  for (const candidate of candidates) {
    const mark = highlightNthSearchInElement(
      element,
      candidate.toLocaleLowerCase(),
      candidate.length,
      0
    );
    if (mark) {
      mark.classList.add("ask-target-match");
      return mark;
    }
  }
  return null;
}

function askCodexTargetCandidates(quote) {
  const raw = String(quote || "").trim();
  const collapsed = collapseWhitespace(raw);
  const base = [
    raw,
    collapsed,
    stripInlineMarkup(raw),
    stripInlineMarkup(collapsed)
  ].filter(Boolean);
  return [...new Set([
    ...base,
    ...base.flatMap(askCodexQuoteSegments)
  ].filter(Boolean))];
}

function askCodexQuoteSegments(value) {
  const words = collapseWhitespace(value).split(/\s+/).filter((word) => word.length > 0);
  const segments = [];
  const maxWords = Math.min(8, words.length);
  for (let size = maxWords; size >= 3; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const segment = words.slice(start, start + size).join(" ");
      if (segment.length >= 12) {
        segments.push(segment);
      }
    }
  }
  return segments;
}

function askCodexAboutMessage(message, index) {
  if (!message) {
    return;
  }
  const label = `${index + 1}. ${exportRoleLabel(message)}`;
  const preview = trimForPrompt(collapseWhitespace(message.text || ""), 500);
  const stage = message.role === "assistant" ? `Assistant stage: ${assistantStage(message)}` : "";
  const question = [
    `Explain this specific message: ${label}.`,
    stage,
    preview ? `Message text: "${preview}"` : "",
    "Use the surrounding conversation context where helpful."
  ].filter(Boolean).join("\n");
  prepareAskCodexQuestion(question, `Prepared question for ${label}.`);
  scrollToMessageIndex(index, { defer: true });
}

function askCodexAboutSelectedText() {
  const selectedText = state.askCodex.selectedText || collapseWhitespace(
    els.messagesDocument?.getSelection?.()?.toString() || ""
  );
  if (!selectedText) {
    els.askCodexStatus.textContent = "Select text in the conversation first.";
    return;
  }
  state.askCodex.selectedText = selectedText;
  const selectedMessageIndex = state.askCodex.selectedMessageIndex;
  const selectedMessageNumber = Number.isInteger(selectedMessageIndex) ? selectedMessageIndex + 1 : null;
  const selectedLink = selectedMessageNumber
    ? `codex-message:${selectedMessageNumber}?text=${encodeURIComponent(trimForPrompt(selectedText, 240))}`
    : "";
  const question = [
    "Explain this selected text from the conversation:",
    `"${trimForPrompt(selectedText, 1200)}"`,
    selectedMessageNumber ? `It comes from message ${selectedMessageNumber}.` : "",
    selectedLink ? `If you refer to the selected text, link to it as [selected text](${selectedLink}).` : "",
    "Use the surrounding conversation context where helpful."
  ].filter(Boolean).join("\n");
  prepareAskCodexQuestion(question, "Prepared question for selected text.");
}

function prepareAskCodexQuestion(question, statusText) {
  if (!state.currentThread) {
    return;
  }
  els.askCodexPanel.open = true;
  els.askCodexQuestion.value = question;
  setAskCodexRunning(false);
  els.askCodexStatus.textContent = statusText;
  els.askCodexAnswer.classList.add("hidden");
  els.askCodexPanel.classList.remove("has-answer");
  els.askCodexAnswer.replaceChildren();
  window.requestAnimationFrame(() => {
    els.askCodexQuestion.focus({ preventScroll: true });
    syncConversationChromeResize();
  });
}

async function askCodexAboutCurrentThread() {
  const question = els.askCodexQuestion.value.trim();
  if (!state.currentThread || !question) {
    return;
  }
  cancelAskCodexRequest();
  const requestId = state.askCodex.requestId + 1;
  const serverRequestId = newAskCodexServerRequestId();
  const controller = new AbortController();
  state.askCodex.requestId = requestId;
  state.askCodex.serverRequestId = serverRequestId;
  state.askCodex.abortController = controller;

  const askContext = currentAskCodexContext();
  const askHistory = askCodexHistoryText();
  setAskCodexRunning(true);
  els.askCodexStatus.textContent = `Sending compact filtered export (${askContext.messageCount} messages, ${formatCount(askContext.context.length)} chars) to Codex...`;
  renderAskCodexAnswer();
  clearAskCodexNavigationHighlights();
  try {
    const result = await fetchJson("/api/ask-codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: serverRequestId,
        question,
        ask_history: askHistory,
        context: askContext.context,
        context_truncated: askContext.truncated,
        kind: state.mode,
        thread_id: state.currentThread.summary?.id || "",
        title: state.currentThread.summary?.preview || ""
      }),
      signal: controller.signal
    });
    if (requestId !== state.askCodex.requestId) {
      return;
    }
    const answer = result.answer || "";
    state.askCodex.turns.push({ question, answer });
    renderAskCodexAnswer();
    els.askCodexQuestion.value = "";
    els.askCodexStatus.textContent = [
      "Answer from Codex.",
      result.context_truncated ? "Context was truncated." : "",
      result.history_truncated ? "Ask history was truncated." : "",
      result.question_truncated ? "Question was truncated." : ""
    ].filter(Boolean).join(" ");
  } catch (error) {
    if (requestId === state.askCodex.requestId && !isAbortError(error)) {
      if (state.askCodex.turns.length === 0) {
        renderAskCodexAnswer(error.message || String(error));
      }
      els.askCodexStatus.textContent = "Ask Codex failed.";
    }
  } finally {
    if (state.askCodex.abortController === controller) {
      state.askCodex.abortController = null;
    }
    if (requestId === state.askCodex.requestId) {
      state.askCodex.serverRequestId = null;
      setAskCodexRunning(false);
    }
    syncConversationChromeResize();
  }
}

function askCodexHistoryText() {
  return state.askCodex.turns
    .map((turn, index) => `Turn ${index + 1}\nQuestion: ${turn.question}\nAnswer: ${turn.answer}`)
    .join("\n\n");
}

function renderAskCodexAnswer(answer = "") {
  const textValue = state.askCodex.turns.length ? askCodexHistoryText() : String(answer || "");
  els.askCodexAnswer.replaceChildren(renderFormattedText(textValue, { autoLinkMessageRefs: true }));
  els.askCodexAnswer.classList.toggle("hidden", textValue === "");
  els.askCodexPanel.classList.toggle("has-answer", textValue !== "");
  syncAskCodexLayout();
}

function isValidConversationMessageNumber(messageNumber) {
  return (
    Number.isInteger(messageNumber)
    && messageNumber >= 1
    && messageNumber <= (state.currentThread?.messages || []).length
  );
}

function currentAskCodexContext() {
  const exportThread = currentFilteredExportThread({ includeNavigationRefs: true });
  const context = conversationAsCompactAskExport(exportThread);
  return {
    context,
    truncated: false,
    messageCount: exportThread.messages.length
  };
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}

function conversationAsCompactAskExport(detail) {
  const summary = detail.summary || {};
  const messages = detail.messages || [];
  const lines = [
    "CODEX_COMPACT_EXPORT v=1",
    "FORMAT MSG headers use original message numbers; nav values are clickable GUI targets.",
    compactObjectLine("SUMMARY", summary, [
      "id",
      "kind",
      "preview",
      "started",
      "ended",
      "updated",
      "model",
      "cwd",
      "app_version",
      "parent_thread_id",
      "message_count"
    ]),
    compactObjectLine("COUNTS", summary, [
      "user_count",
      "assistant_count",
      "message_count",
      "log_rows"
    ])
  ].filter(Boolean);

  if (detail.metadata) {
    lines.push(compactObjectLine("META", detail.metadata, Object.keys(detail.metadata).sort()));
  }
  if (detail.recovery_note) {
    lines.push(compactObjectLine("NOTE", { recovery: detail.recovery_note }, ["recovery"]));
  }

  appendCompactRelated(lines, detail.related || {});
  appendCompactCheckpoints(lines, "COMPACTION", detail.compactions || []);
  appendCompactCheckpoints(lines, "ROLLBACK", detail.rollbacks || []);

  lines.push(`MESSAGES count=${messages.length}`);
  for (const [index, message] of messages.entries()) {
    const messageNumber = Number.isInteger(message.message_number) ? message.message_number : index + 1;
    lines.push(compactObjectLine(`MSG ${messageNumber}`, message, [
      "role",
      "assistant_stage",
      "navigation_href",
      "time",
      "phase",
      "line_number",
      "rolled_back",
      "rolled_back_at",
      "rollback_group",
      "rollback_turns"
    ]));
    lines.push("TEXT", message.text || "", "ENDMSG");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendCompactRelated(lines, related) {
  for (const key of ["parents", "forks", "side"]) {
    const items = Array.isArray(related[key]) ? related[key] : [];
    if (items.length === 0) {
      continue;
    }
    lines.push(`RELATED ${key} count=${items.length}`);
    for (const item of items) {
      lines.push(compactObjectLine(`REL ${key}`, item, [
        "id",
        "kind",
        "preview",
        "started",
        "ended",
        "updated",
        "model",
        "cwd",
        "parent_thread_id",
        "meta_label",
        "message_count",
        "user_count",
        "assistant_count"
      ]));
    }
  }
}

function appendCompactCheckpoints(lines, label, checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return;
  }
  lines.push(`${label}S count=${checkpoints.length}`);
  for (const checkpoint of checkpoints) {
    lines.push(compactObjectLine(label, checkpoint, [
      "ordinal",
      "line_number",
      "copy_line_count",
      "time",
      "kind",
      "label",
      "rollback_turns",
      "message_index",
      "summary"
    ]));
  }
}

function compactObjectLine(prefix, object, keys) {
  const attrs = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object || {}, key)) {
      continue;
    }
    const value = compactAttributeValue(object[key]);
    if (value !== "") {
      attrs.push(`${compactAttributeName(key)}=${value}`);
    }
  }
  return attrs.length > 0 ? `${prefix} ${attrs.join(" ")}` : prefix;
}

function compactAttributeName(key) {
  return {
    app_version: "cli",
    assistant_count: "assistant",
    assistant_stage: "stage",
    copy_line_count: "copy_lines",
    line_number: "line",
    message_count: "messages",
    message_index: "msg_index",
    navigation_href: "nav",
    parent_thread_id: "parent",
    role: "r",
    rollback_group: "rb_group",
    rollback_turns: "rb_turns",
    rolled_back: "rb",
    rolled_back_at: "rb_at",
    time: "t",
    user_count: "user"
  }[key] || key;
}

function compactAttributeValue(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (value === false) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const normalized = collapseWhitespace(String(value));
  if (!normalized) {
    return "";
  }
  return /^[^\s"=]+$/.test(normalized) ? normalized : JSON.stringify(normalized);
}

async function exportCurrentThread() {
  if (!state.currentThread) return;
  const exportThread = currentFilteredExportThread();
  const format = els.exportFormatSelect.value || "markdown";
  const exporters = {
    json: {
      content: JSON.stringify(exportThread, null, 2),
      type: "application/json",
      extension: "json"
    },
    text: {
      content: conversationAsPlainText(exportThread),
      type: "text/plain",
      extension: "txt"
    },
    markdown: {
      content: conversationAsMarkdown(exportThread),
      type: "text/markdown",
      extension: "md"
    }
  };
  const exportData = exporters[format] || exporters.markdown;
  const filename = `${modeConfig().exportPrefix}-${exportThread.summary.id}.${exportData.extension}`;
  const originalText = els.exportButton.textContent;
  els.exportButton.disabled = true;
  els.exportButton.textContent = "Exporting...";
  try {
    const result = await fetchJson("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        content: exportData.content
      })
    });
    els.sourceLine.textContent = `Exported to ${result.path}`;
  } catch (error) {
    els.sourceLine.textContent = error.message || String(error);
  } finally {
    els.exportButton.textContent = originalText;
    els.exportButton.disabled = !state.currentThread;
  }
}

function currentFilteredExportThread(options = {}) {
  const detail = state.currentThread || {};
  const summary = detail.summary || {};
  const messages = [];
  for (const [index, message] of (detail.messages || []).entries()) {
    if (!isMessageVisibleByFilter(message)) {
      continue;
    }
    messages.push(exportMessageObject(message, { ...options, messageIndex: index }));
  }
  return {
    ...detail,
    summary: {
      ...summary,
      message_count: messages.length
    },
    messages
  };
}

function exportMessageObject(message, options = {}) {
  const exported = { ...message };
  exported.text = messageViewText(message);
  delete exported.__finalAssistantReply;
  if (message?.role === "assistant") {
    exported.assistant_stage = assistantStage(message);
  }
  if (options.includeNavigationRefs && Number.isInteger(options.messageIndex)) {
    exported.message_number = options.messageIndex + 1;
    exported.navigation_href = `codex-message:${options.messageIndex + 1}`;
  }
  return exported;
}

function assistantStage(message) {
  return message?.__finalAssistantReply ? "final" : "interim";
}

function conversationAsMarkdown(detail) {
  const summary = detail.summary || {};
  const messages = detail.messages || [];
  const lines = [
    `# ${summary.preview || "Codex conversation"}`,
    "",
    `- Thread ID: ${summary.id || ""}`,
    `- Type: ${modeConfig().label}`,
    `- Started: ${text(summary.started)}`,
    `- Updated: ${text(summary.updated || summary.ended)}`,
    `- Model: ${text(summary.model)}`,
    `- Working directory: ${text(summary.cwd)}`,
    `- Messages: ${messages.length}`,
    ""
  ];

  for (const [index, message] of messages.entries()) {
    lines.push(`## ${index + 1}. ${exportRoleLabel(message)}`);
    const meta = exportMessageMetadata(message);
    if (meta.length > 0) {
      lines.push("", ...meta.map((item) => `- ${item}`));
    }
    lines.push("", message.text || "", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function conversationAsPlainText(detail, options = {}) {
  const summary = detail.summary || {};
  const messages = detail.messages || [];
  const divider = "=".repeat(72);
  const section = "-".repeat(72);
  const lines = [
    summary.preview || "Codex conversation",
    divider,
    `Thread ID: ${summary.id || ""}`,
    `Type: ${modeConfig().label}`,
    `Started: ${text(summary.started)}`,
    `Updated: ${text(summary.updated || summary.ended)}`,
    `Model: ${text(summary.model)}`,
    `Working directory: ${text(summary.cwd)}`,
    `Messages: ${messages.length}`,
    ""
  ];

  for (const [index, message] of messages.entries()) {
    const messageNumber = options.includeNavigationRefs && Number.isInteger(message.message_number)
      ? message.message_number
      : index + 1;
    const navigation = options.includeNavigationRefs && message.navigation_href
      ? ` [link: ${message.navigation_href}]`
      : "";
    lines.push(section, `${messageNumber}. ${exportRoleLabel(message)}${navigation}`);
    for (const item of exportMessageMetadata(message)) {
      lines.push(item);
    }
    lines.push("", message.text || "", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function exportRoleLabel(message) {
  const label = roleLabel(message.role);
  return message.rolled_back ? `${label} (rolled back)` : label;
}

function exportMessageMetadata(message) {
  const meta = [];
  if (message.role === "assistant") {
    meta.push(`Assistant stage: ${message.assistant_stage || assistantStage(message)}`);
  }
  if (message.time) {
    meta.push(`Time: ${message.time}`);
  }
  if (message.source) {
    meta.push(`Source: ${message.source}`);
  }
  if (message.phase) {
    meta.push(`Phase: ${message.phase}`);
  }
  if (message.rolled_back_at) {
    meta.push(`Rolled back at: ${message.rolled_back_at}`);
  }
  return meta;
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

async function archiveCurrentThread() {
  const detail = state.currentThread;
  const summary = detail?.summary;
  if (state.mode !== "main" || !summary?.id || summary.archived) {
    return;
  }

  const confirmed = await confirmWriteAction({
    title: "Archive this conversation?",
    body: "This uses Codex-compatible archive behavior: the rollout file moves to archived_sessions and the conversation is removed from the normal active list. The transcript is not permanently deleted.",
    details: [
      { label: "Conversation", value: summary.preview || summary.id },
      { label: "Thread ID", value: summary.id },
      { label: "Rollout path", value: summary.rollout_path },
      { label: "Descendants", value: "Spawned descendant conversations are archived too when Codex can read them" }
    ],
    confirmLabel: "Archive",
    opener: els.archiveButton
  });
  if (!confirmed) {
    return;
  }

  els.archiveButton.disabled = true;
  const originalText = els.archiveButton.textContent;
  els.archiveButton.textContent = "Archiving...";
  try {
    const result = await fetchJson(
      `/api/main-threads/${encodeURIComponent(summary.id)}/archive`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rollout_path: summary.rollout_path || "" })
      }
    );
    const archivedCount = result.archived_count || 1;
    const skippedCount = (result.descendant_errors || []).length;
    els.sourceLine.textContent = skippedCount > 0
      ? `Archived ${archivedCount} conversation${archivedCount === 1 ? "" : "s"}; ${skippedCount} spawned descendant${skippedCount === 1 ? "" : "s"} could not be archived`
      : `Archived ${archivedCount} conversation${archivedCount === 1 ? "" : "s"}`;
    clearConversation();
    await loadThreads({ preserveSelection: false });
  } catch (error) {
    els.archiveButton.disabled = false;
    els.archiveButton.textContent = originalText;
    els.sourceLine.textContent = error.message || String(error);
  }
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
  resetAskCodex();
  els.emptyStateMessage.textContent = error.message || String(error);
  els.emptyState.classList.remove("hidden");
  els.conversationView.classList.add("hidden");
  els.relatedPanel.classList.add("hidden");
  els.relatedPanel.replaceChildren();
  els.exportButton.disabled = true;
  els.exportFormatSelect.disabled = true;
  els.copyIdButton.disabled = true;
  updateArchiveButton();
}

async function init() {
  setupConfirmModal();
  installThreadPanelControls();
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
    try {
      await loadThreads({ preserveSelection: true, preserveHiddenSelection: true });
    } catch (error) {
      showError(error);
    }
  });
  els.exportButton.addEventListener("click", () => {
    void exportCurrentThread();
  });
  els.copyIdButton.addEventListener("click", copyCurrentId);
  els.archiveButton.addEventListener("click", () => {
    void archiveCurrentThread();
  });
  els.searchInput.addEventListener("input", () => {
    state.filter = els.searchInput.value;
    scheduleThreadSearch();
  });
  els.fullTextSearchInput.addEventListener("change", () => {
    state.fullTextSearch = els.fullTextSearchInput.checked;
    scheduleThreadSearch({ immediate: true });
  });
  els.conversationSearchInput.addEventListener("input", () => {
    scheduleConversationSearchAfterPaint();
  });
  els.conversationSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const query = els.conversationSearchInput.value.trim().toLocaleLowerCase();
    const searchIsPending = state.conversationSearch.timer !== null || state.conversationSearch.inputFrame !== null;
    if (query && (searchIsPending || query !== state.conversationSearch.lowerQuery)) {
      scheduleConversationSearch({ immediate: true });
      return;
    }
    stepConversationSearch(event.shiftKey ? -1 : 1);
  });
  els.conversationSearchPrev.addEventListener("click", () => stepConversationSearch(-1));
  els.conversationSearchNext.addEventListener("click", () => stepConversationSearch(1));
  els.conversationSearchClear.addEventListener("click", () => {
    els.conversationSearchInput.value = "";
    scheduleConversationSearch({ immediate: true });
    els.conversationSearchInput.focus();
  });
  installControlledDetailsToggle(els.messageFilters, () => {
    syncConversationChromeResize();
  });
  installControlledDetailsToggle(els.askCodexPanel, () => {
    window.setTimeout(() => updateSelectedTranscriptText(), 0);
    syncConversationChromeResize();
  });
  els.askCodexQuestion.addEventListener("input", () => {
    setAskCodexRunning(Boolean(state.askCodex.serverRequestId));
  });
  els.askCodexQuestion.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void askCodexAboutCurrentThread();
    }
  });
  els.askSelectedButton.addEventListener("click", () => {
    askCodexAboutSelectedText();
  });
  els.askCodexButton.addEventListener("click", () => {
    void askCodexAboutCurrentThread();
  });
  els.askCodexStopButton.addEventListener("click", () => {
    stopAskCodexRequest();
  });
  els.messageFilterDefaults.addEventListener("click", () => {
    setMessageFilters(defaultMessageFilters());
  });
  els.messageFilterAll.addEventListener("click", () => {
    setMessageFilters(allMessageFilters(true));
  });
  els.messageFilterNone.addEventListener("click", () => {
    setMessageFilters(allMessageFilters(false));
  });

  try {
    renderMessageFilterControls();
    els.fullTextSearchInput.checked = state.fullTextSearch;
    renderMode();
    await loadStatus();
    await loadThreads({ preserveSelection: false });
  } catch (error) {
    showError(error);
  }
}

init();
