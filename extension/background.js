const ALARM_NAME = "page-watch-check";
const SCRIPT_FILES = ["content.js"];
const STYLE_FILES = ["styles.css"];
const PUSH_SERVER_URL = "https://watcher.kangbeen.my";
const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WATCH_CONFIG_KEYS = [
  "watchSelector",
  "watchFrameUrl",
  "watchPageUrl",
  "watchTargets",
  "watchTextSnapshot",
  "refreshActionSelector",
  "refreshActionFrameUrl",
  "pushChannel",
  "watchTabId",
  "watchCreatedAt"
];

chrome.runtime.onInstalled.addListener(async () => {
  await pruneExpiredWatchConfig();
  const { checkIntervalMinutes } = await chrome.storage.local.get("checkIntervalMinutes");
  if (checkIntervalMinutes) {
    createCheckAlarm(checkIntervalMinutes);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!isInjectableTab(tab)) {
    showNotification("Page Watcher", "이 페이지에서는 플로팅 패널을 열 수 없습니다.");
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await executeFrameCommand(tab.id, "TOGGLE_PANEL", false);
  } catch (error) {
    showNotification("Page Watcher", "현재 페이지에 플로팅 패널을 열 수 없습니다.");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SHOW_NOTIFICATION") {
    showNotification(message.title, message.message);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "SEND_PUSH_NOTIFICATION") {
    sendPushNotification(message.labels || [], Boolean(message.test)).then(sendResponse);
    return true;
  }

  if (message?.type === "DELETE_PUSH_CHANNEL") {
    clearWatchConfig("manual").then(sendResponse);
    return true;
  }

  if (message?.type === "DELETE_SERVER_CHANNEL_ONLY") {
    deletePushChannel().then(sendResponse);
    return true;
  }

  if (message?.type === "WATCH_CONFIG_CREATED" && sender.tab?.id) {
    chrome.storage.local
      .set({
        watchTabId: sender.tab.id,
        watchCreatedAt: Date.now(),
        watchPageUrl: stripHash(message.pageUrl || sender.tab.url || "")
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "SET_INTERVAL") {
    createCheckAlarm(message.minutes);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "RUN_FRAME_COMMAND" && sender.tab?.id) {
    const runner = message.command === "RUN_CHECK_NOW"
      ? runCheckNow(sender.tab.id)
      : executeFrameCommand(sender.tab.id, message.command, true);
    runner
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const expired = await pruneExpiredWatchConfig();
  if (expired) {
    return;
  }

  const { watchPageUrl } = await chrome.storage.local.get("watchPageUrl");
  if (!watchPageUrl) {
    return;
  }

  const tabs = await chrome.tabs.query({});
  const targetTabs = tabs.filter((tab) => samePageUrl(tab.url, watchPageUrl) && isInjectableTab(tab));
  if (targetTabs.length === 0) {
    showNotification("Page Watcher", "감시 대상 페이지가 열려 있지 않아 검사를 건너뛰었습니다.");
    return;
  }

  for (const tab of targetTabs) {
    try {
      await ensureContentScript(tab.id);
      await runCheckNow(tab.id);
    } catch (error) {
      showNotification("Page Watcher", "감시 대상 페이지에 접근할 수 없습니다.");
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { watchTabId } = await chrome.storage.local.get("watchTabId");
  if (watchTabId === tabId) {
    await clearWatchConfig("tab-closed");
  }
});

async function executeFrameCommand(tabId, command, allFrames) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    func: async (commandType) => {
      if (!window.PageWatcher?.handleCommand) {
        return { handled: false, error: "content script가 준비되지 않았습니다." };
      }
      return window.PageWatcher.handleCommand(commandType);
    },
    args: [command]
  });

  return injectionResults.map((item) => item.result).filter(Boolean);
}

async function runCheckNow(tabId) {
  const refreshResults = await executeFrameCommand(tabId, "RUN_REFRESH_ACTION", true);
  const actionClicked = refreshResults.some((result) => result?.actionClicked);
  if (actionClicked) {
    await delay(3000);
  }
  const readResults = await executeFrameCommand(tabId, "RUN_READ_WATCH", true);
  return readResults.map((result) => {
    if (!result?.handled) {
      return result;
    }
    return { ...result, actionClicked };
  });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId, allFrames: true },
    files: STYLE_FILES
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: SCRIPT_FILES
  });
}

function createCheckAlarm(minutes) {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: Number(minutes) });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title,
    message
  });
}

async function sendPushNotification(labels, isTest) {
  const { pushChannel, watchPageUrl } = await chrome.storage.local.get([
    "pushChannel",
    "watchPageUrl"
  ]);
  if (!isValidChannel(pushChannel)) {
    return { ok: false, reason: "missing-push-config" };
  }

  const labelSummary = summarizeLabels(labels);
  const response = await fetch(`${PUSH_SERVER_URL}/notify`, {
    method: "POST",
    body: JSON.stringify({
      channel: pushChannel,
      title: isTest ? "Page Watcher 테스트" : "Page Watcher 변경 감지",
      message: isTest
        ? "Page Watcher 테스트 알림입니다."
        : `변경 영역: ${labelSummary}`,
      labels,
      pageUrl: watchPageUrl || ""
    }),
    headers: {
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    return { ok: false, reason: `http-${response.status}` };
  }

  return { ok: true };
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

async function clearWatchConfig(reason) {
  const deleteResult = await deletePushChannel();
  await chrome.storage.local.remove(WATCH_CONFIG_KEYS);
  return { ok: true, reason, deleteResult };
}

async function pruneExpiredWatchConfig() {
  const { watchCreatedAt } = await chrome.storage.local.get("watchCreatedAt");
  if (!watchCreatedAt) {
    return false;
  }
  if (Date.now() - Number(watchCreatedAt) < WATCH_TTL_MS) {
    return false;
  }
  await clearWatchConfig("expired");
  showNotification("Page Watcher", "감시 설정이 생성 후 1주일이 지나 자동 삭제되었습니다.");
  return true;
}

function isInjectableTab(tab) {
  return Boolean(tab?.id && /^https?:\/\//i.test(tab.url || ""));
}

function samePageUrl(tabUrl, storedUrl) {
  return stripHash(tabUrl) === stripHash(storedUrl);
}

function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function isValidChannel(channel) {
  return typeof channel === "string" && /^[-_A-Za-z0-9]{8,80}$/.test(channel);
}

function summarizeLabels(labels) {
  const uniqueLabels = Array.from(new Set((labels || []).filter(Boolean)));
  const shown = uniqueLabels.slice(0, 4).join(", ");
  if (uniqueLabels.length > 4) {
    return `${shown} 외 ${uniqueLabels.length - 4}개`;
  }
  return shown || "선택 영역";
}
