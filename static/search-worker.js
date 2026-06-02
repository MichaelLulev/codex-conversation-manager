let revision = 0;
let records = [];
let activeSearch = null;
const SEARCH_CHUNK_TIME_MS = 4;
const SEARCH_PROGRESS_INTERVAL_MS = 80;

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "reset") {
    revision = data.revision;
    records = [];
    activeSearch = null;
    return;
  }

  if (data.type === "cancel") {
    if (data.revision === revision) {
      activeSearch = null;
    }
    return;
  }

  if (data.type === "append") {
    if (data.revision !== revision) {
      return;
    }
    records.push(...(data.records || []).map((record) => ({
      messageIndex: record.messageIndex,
      text: record.text || "",
      lowerText: null
    })));
    return;
  }

  if (data.type === "finish") {
    if (data.revision === revision) {
      self.postMessage({ type: "ready", revision });
    }
    return;
  }

  if (data.type === "init") {
    revision = data.revision;
    activeSearch = null;
    records = (data.records || []).map((record) => ({
      messageIndex: record.messageIndex,
      text: record.text || "",
      lowerText: null
    }));
    self.postMessage({ type: "ready", revision });
    return;
  }

  if (data.type !== "search" || data.revision !== revision) {
    return;
  }

  startSearch(data);
};

function startSearch(data) {
  const query = String(data.query || "").trim();
  const lowerQuery = query.toLocaleLowerCase();
  const search = {
    revision: data.revision,
    requestId: data.requestId,
    lowerQuery,
    matchGroups: [],
    totalMatches: 0,
    cursor: 0,
    lastProgress: performance.now()
  };
  activeSearch = search;

  if (!lowerQuery) {
    self.postMessage({
      type: "result",
      revision,
      requestId: data.requestId,
      matchGroups: [],
      totalMatches: 0
    });
    activeSearch = null;
    return;
  }

  scheduleSearchChunk(search);
}

function scheduleSearchChunk(search) {
  setTimeout(() => processSearchChunk(search), 0);
}

function processSearchChunk(search) {
  if (activeSearch !== search || search.revision !== revision) {
    return;
  }

  const started = performance.now();
  while (search.cursor < records.length) {
    const record = records[search.cursor];
    search.cursor += 1;
    if (record.lowerText === null) {
      record.lowerText = record.text.toLocaleLowerCase();
    }
    const count = countOccurrences(record.lowerText, search.lowerQuery);
    if (count > 0) {
      search.matchGroups.push({ messageIndex: record.messageIndex, count });
      search.totalMatches += count;
    }
    const now = performance.now();
    if (now - search.lastProgress > SEARCH_PROGRESS_INTERVAL_MS) {
      self.postMessage({
        type: "progress",
        revision,
        requestId: search.requestId,
        totalMatches: search.totalMatches
      });
      search.lastProgress = now;
    }
    if (now - started >= SEARCH_CHUNK_TIME_MS) {
      scheduleSearchChunk(search);
      return;
    }
  }

  if (activeSearch !== search || search.revision !== revision) {
    return;
  }
  self.postMessage({
    type: "result",
    revision,
    requestId: search.requestId,
    matchGroups: search.matchGroups,
    totalMatches: search.totalMatches
  });
  activeSearch = null;
}

function countOccurrences(lowerText, lowerQuery) {
  let count = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);
  while (matchIndex !== -1) {
    count += 1;
    matchIndex = lowerText.indexOf(lowerQuery, matchIndex + lowerQuery.length);
  }
  return count;
}
