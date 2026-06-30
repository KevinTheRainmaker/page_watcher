const ALARM_NAME = "zeus-grade-watch";
const ZEUS_URL_PATTERN = "https://zeus.gist.ac.kr/*";
const PUSH_SERVER_URL = "https://watcher.kangbeen.my";
const STORAGE_KEYS = [
  "zeusTabId",
  "studtNo",
  "snapshot",
  "lastCheckedAt",
  "lastSummary",
  "lastResult",
  "intervalMinutes",
  "watchEnabled",
  "pushChannel",
  "refreshActionSelector",
  "refreshActionFrameUrl"
];

chrome.runtime.onInstalled.addListener(async () => {
  const { watchEnabled, intervalMinutes } = await chrome.storage.local.get([
    "watchEnabled",
    "intervalMinutes"
  ]);
  if (watchEnabled && intervalMinutes) {
    createAlarm(intervalMinutes);
  }
  await updateBadgeFromState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }
  runCheck(false);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!isZeusTab(tab)) {
    showNotification("ZEUS Grade Watcher", "ZEUS 페이지에서만 패널을 열 수 있습니다.");
    return;
  }
  try {
    await ensureContentScript(tab.id);
    await executeContentCommand(tab.id, { type: "TOGGLE_PANEL" });
  } catch (error) {
    showNotification("ZEUS Grade Watcher", "ZEUS 페이지에 패널을 열 수 없습니다.");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    respondAsync(sendResponse, getState());
    return true;
  }

  if (message?.type === "REGISTER_ACTIVE_ZEUS_TAB") {
    respondAsync(sendResponse, registerActiveZeusTab());
    return true;
  }

  if (message?.type === "RUN_CHECK") {
    respondAsync(sendResponse, runCheck(true));
    return true;
  }

  if (message?.type === "START_REFRESH_ACTION_RECORDING") {
    respondAsync(sendResponse, startRefreshActionRecording());
    return true;
  }

  if (message?.type === "SET_INTERVAL") {
    respondAsync(sendResponse, setIntervalMinutes(message.minutes));
    return true;
  }

  if (message?.type === "SEND_TEST_PUSH") {
    respondAsync(sendResponse, sendZeusPushNotification([], true));
    return true;
  }

  if (message?.type === "ENSURE_PUSH_CHANNEL") {
    respondAsync(sendResponse, (async () => ({ ok: true, pushChannel: await ensurePushChannel() }))());
    return true;
  }

  if (message?.type === "CLEAR_CONFIG") {
    respondAsync(sendResponse, clearConfig());
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { zeusTabId } = await chrome.storage.local.get("zeusTabId");
  if (zeusTabId === tabId) {
    await chrome.storage.local.remove(["zeusTabId"]);
  }
});

function respondAsync(sendResponse, promise) {
  promise
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      reason: "async-error",
      error: error?.message || String(error)
    }));
}

async function getState() {
  const state = await chrome.storage.local.get(STORAGE_KEYS);
  return { ok: true, state };
}

async function registerActiveZeusTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isZeusTab(tab)) {
    return { ok: false, reason: "not-zeus-tab" };
  }

  await ensureContentScript(tab.id);
  const context = await executeContentCommand(tab.id, { type: "EXTRACT_ZEUS_CONTEXT" });
  if (!context?.ok || !context.studtNo) {
    return { ok: false, reason: "student-number-not-found" };
  }

  const pushChannel = await ensurePushChannel();
  await chrome.storage.local.set({
    zeusTabId: tab.id,
    studtNo: context.studtNo,
    lastResult: "개인성적조회 화면 등록 완료",
    pushChannel
  });
  return { ok: true, studtNo: context.studtNo };
}

async function runCheck(manual) {
  const config = await chrome.storage.local.get(["zeusTabId", "studtNo", "snapshot"]);
  if (!config.studtNo) {
    return markCheckFailure("missing-config", manual);
  }

  const tab = await findZeusTab(config.zeusTabId);
  if (!tab) {
    return markCheckFailure("zeus-tab-not-open", manual);
  }

  await ensureContentScript(tab.id);
  const refreshResults = await executeContentCommands(tab.id, { type: "RUN_REFRESH_ACTION" });
  if (refreshResults.some((result) => result?.actionClicked)) {
    await delay(3000);
  }
  const result = await executeContentCommand(tab.id, {
    type: "FETCH_ZEUS_GRADES",
    studtNo: config.studtNo
  });
  if (!result?.ok) {
    if (!manual) {
      showNotification("ZEUS Grade Watcher", reasonToMessage(result?.reason));
    }
    return markCheckFailure(result?.reason || "no-response", manual, result);
  }

  const previous = Array.isArray(config.snapshot) ? config.snapshot : [];
  const changes = diffSnapshots(previous, result.snapshot);
  const summary = summarizeSnapshot(result.snapshot);
  const changeSummary = changes.length > 0 ? formatChanges(changes) : "";

  await chrome.storage.local.set({
    zeusTabId: tab.id,
    studtNo: result.studtNo || config.studtNo,
    snapshot: result.snapshot,
    lastCheckedAt: Date.now(),
    lastSummary: summary,
    lastResult: "검사 성공"
  });

  if (previous.length === 0) {
    await setBadge("OK", "#2563eb");
    if (manual) {
      showNotification("ZEUS Grade Watcher", "초기 성적 스냅샷을 저장했습니다.");
    }
    return { ok: true, initialized: true, summary, changes: [] };
  }

  if (changes.length > 0) {
    await setBadge("NEW", "#dc2626");
    const changeTitle = formatChangeTitle(changes);
    await chrome.storage.local.set({ lastResult: `${changeTitle}\n${changeSummary}` });
    showNotification(changeTitle, changeSummary);
    await sendZeusPushNotification(changes, false);
  } else if (manual) {
    await setBadge("OK", "#16a34a");
    showNotification("ZEUS Grade Watcher", "변경된 성적이 없습니다.");
  } else {
    await setBadge("OK", "#16a34a");
  }

  return { ok: true, summary, changes, changeSummary };
}

async function markCheckFailure(reason, manual, extra = {}) {
  const message = reasonToMessage(reason);
  await chrome.storage.local.set({
    lastCheckedAt: Date.now(),
    lastResult: message
  });
  await setBadge("ERR", "#dc2626");
  if (manual) {
    showNotification("ZEUS Grade Watcher", message);
  }
  return { ok: false, reason, ...extra };
}

async function startRefreshActionRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isZeusTab(tab)) {
    return { ok: false, reason: "not-zeus-tab" };
  }
  await ensureContentScript(tab.id);
  const results = await executeContentCommands(tab.id, { type: "START_ACTION_RECORDING" });
  const handled = results.some((result) => result?.ok || result?.handled);
  return { ok: handled, recordingStarted: handled, reason: handled ? undefined : "content-api-not-ready" };
}

async function setIntervalMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 1) {
    await chrome.storage.local.set({ watchEnabled: false });
    await chrome.alarms.clear(ALARM_NAME);
    return { ok: true, disabled: true };
  }

  await chrome.storage.local.set({
    intervalMinutes: value,
    watchEnabled: true
  });
  createAlarm(value);
  await setBadge("ON", "#2563eb");
  return { ok: true, minutes: value };
}

async function clearConfig() {
  await chrome.alarms.clear(ALARM_NAME);
  await deletePushChannel();
  await chrome.storage.local.remove(STORAGE_KEYS);
  await chrome.action.setBadgeText({ text: "" });
  return { ok: true };
}

async function findZeusTab(preferredTabId) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (isZeusTab(tab)) {
        return tab;
      }
    } catch (error) {
      // Fall back to any open ZEUS tab.
    }
  }

  const tabs = await chrome.tabs.query({ url: ZEUS_URL_PATTERN });
  return tabs.find(isZeusTab) || null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (error) {
    // The declarative content script is usually already present.
  }
}

async function executeContentCommand(tabId, message) {
  const results = await executeContentCommands(tabId, message);
  return pickBestFrameResult(results);
}

async function executeContentCommands(tabId, message) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (command) => {
      return window.ZeusGradeWatcher?.handleCommand
        ? window.ZeusGradeWatcher.handleCommand(command)
        : { ok: false, reason: "content-api-not-ready", url: location.href };
    },
    args: [message]
  });
  return injectionResults.map((item) => item.result).filter(Boolean);
}

function pickBestFrameResult(results) {
  return results.find((result) => result?.ok && result.studtNo)
    || results.find((result) => result?.ok)
    || results.find((result) => result?.reason !== "content-api-not-ready")
    || results[0]
    || { ok: false, reason: "no-frame-response" };
}

function createAlarm(minutes) {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: Number(minutes),
      periodInMinutes: Number(minutes)
    });
  });
}

async function sendZeusPushNotification(changes, isTest) {
  const { pushChannel } = await chrome.storage.local.get("pushChannel");
  if (!isValidChannel(pushChannel)) {
    return { ok: false, reason: "missing-push-config" };
  }

  const labels = isTest
    ? ["ZEUS Grade Watcher 테스트"]
    : changes.map((change) => change.row?.courseName || "성적 변경").filter(Boolean);
  const message = isTest
    ? "ZEUS Grade Watcher 테스트 알림입니다."
    : formatChanges(changes);
  const title = isTest ? "ZEUS Grade Watcher 테스트" : formatChangeTitle(changes);

  try {
    const response = await fetch(`${PUSH_SERVER_URL}/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        channel: pushChannel,
        title,
        message,
        labels,
        pageUrl: "https://zeus.gist.ac.kr/"
      })
    });
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }
    return response.json();
  } catch (error) {
    return { ok: false, reason: "network-error", error: error?.message || String(error) };
  }
}

async function ensurePushChannel() {
  const { pushChannel } = await chrome.storage.local.get("pushChannel");
  if (isValidChannel(pushChannel)) {
    return pushChannel;
  }
  const nextChannel = generateChannel();
  await chrome.storage.local.set({ pushChannel: nextChannel });
  return nextChannel;
}

async function deletePushChannel() {
  const { pushChannel } = await chrome.storage.local.get("pushChannel");
  if (!isValidChannel(pushChannel)) {
    return { ok: true, skipped: true };
  }
  try {
    const response = await fetch(`${PUSH_SERVER_URL}/channel/${encodeURIComponent(pushChannel)}`, {
      method: "DELETE"
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, reason: "network-error" };
  }
}

function generateChannel() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isValidChannel(channel) {
  return typeof channel === "string" && /^[-_A-Za-z0-9]{8,80}$/.test(channel);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function updateBadgeFromState() {
  const { watchEnabled } = await chrome.storage.local.get("watchEnabled");
  if (watchEnabled) {
    await setBadge("ON", "#2563eb");
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function diffSnapshots(previous, next) {
  const before = new Map(previous.map((row) => [rowKey(row), row]));
  const changes = [];

  for (const row of next) {
    if (row.div !== "1" || !row.courseName) {
      continue;
    }
    const old = before.get(rowKey(row));
    if (!old) {
      changes.push({ type: "added", row });
      continue;
    }
    const fields = ["credit", "grade", "gpa"];
    const changedFields = fields.filter((field) => (old[field] || "") !== (row[field] || ""));
    if (changedFields.length > 0) {
      changes.push({ type: "changed", row, old, fields: changedFields });
    }
  }

  return changes;
}

function rowKey(row) {
  return [row.year, row.term, row.courseNo, row.courseName].join("|");
}

function summarizeSnapshot(snapshot) {
  const courses = snapshot.filter((row) => row.div === "1" && row.courseName);
  const graded = courses.filter((row) => row.grade);
  return `${courses.length}개 과목, 성적 입력 ${graded.length}개`;
}

function formatChanges(changes) {
  const lines = changes.slice(0, 4).map((change) => {
    const row = change.row;
    if (isGradeRegistration(change)) {
      return `"${row.courseName}"의 성적이 등록되었습니다.`;
    }
    if (isGradeChange(change)) {
      return `"${row.courseName}"의 성적이 변경되었습니다.`;
    }
    if (change.type === "added") {
      return `"${row.courseName}" 항목이 추가되었습니다.`;
    }
    return `"${row.courseName}"의 ${formatChangedFields(change.fields)} 항목이 변경되었습니다.`;
  });
  if (changes.length > 4) {
    lines.push(`외 ${changes.length - 4}개`);
  }
  return lines.join("\n");
}

function formatChangeTitle(changes) {
  const hasRegistration = changes.some(isGradeRegistration);
  const hasChange = changes.some((change) => !isGradeRegistration(change));
  if (hasRegistration && !hasChange) {
    return "ZEUS 성적 등록 감지";
  }
  if (!hasRegistration && hasChange) {
    return "ZEUS 성적 변경 감지";
  }
  return "ZEUS 성적 등록/변경 감지";
}

function isGradeRegistration(change) {
  if (change.type === "added") {
    return Boolean(change.row?.grade);
  }
  return change.fields?.includes("grade") && !change.old?.grade && Boolean(change.row?.grade);
}

function isGradeChange(change) {
  if (!change.fields?.includes("grade")) {
    return false;
  }
  return Boolean(change.old?.grade) || !change.row?.grade;
}

function formatChangedFields(fields = []) {
  const labels = {
    credit: "학점",
    grade: "등급",
    gpa: "평점"
  };
  return fields.map((field) => labels[field] || field).join(", ") || "항목 변경";
}

function reasonToMessage(reason) {
  const messages = {
    "missing-student-number": "ZEUS 화면에서 학번을 찾지 못했습니다.",
    "empty-grade-dataset": "성적 데이터를 읽지 못했습니다. 로그인 상태를 확인해주세요.",
    "student-number-mismatch": "현재 ZEUS 화면의 학번과 저장된 학번이 달라 조회를 중단했습니다.",
    "zeus-tab-not-open": "ZEUS 탭이 열려 있지 않습니다.",
    "missing-config": "먼저 개인성적조회 화면을 등록해주세요."
  };
  return messages[reason] || "성적 조회에 실패했습니다.";
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title,
    message
  });
}

function isZeusTab(tab) {
  return Boolean(tab?.id && /^https:\/\/zeus\.gist\.ac\.kr\//i.test(tab.url || ""));
}
