const stateLabel = document.querySelector('[data-role="state"]');
const summary = document.querySelector('[data-role="summary"]');
const interval = document.querySelector('[data-field="interval"]');
const qr = document.querySelector('[data-role="qr"]');
const PUSH_SERVER_URL = "https://watcher.kangbeen.my";

document.addEventListener("DOMContentLoaded", refreshState);
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  if (action === "register") {
    await runAction("등록 중", () => sendMessage({ type: "REGISTER_ACTIVE_ZEUS_TAB" }));
  }
  if (action === "record-refresh-action") {
    await runAction("선택 대기", () => sendMessage({ type: "START_REFRESH_ACTION_RECORDING" }));
  }
  if (action === "check") {
    await runAction("확인 중", () => sendMessage({ type: "RUN_CHECK" }));
  }
  if (action === "save-interval") {
    await runAction("저장 중", () => sendMessage({
      type: "SET_INTERVAL",
      minutes: Number(interval.value)
    }));
  }
  if (action === "show-qr") {
    await showQr();
  }
  if (action === "test-push") {
    await runAction("전송 중", () => sendMessage({ type: "SEND_TEST_PUSH" }));
  }
  if (action === "clear") {
    await runAction("삭제 중", () => sendMessage({ type: "CLEAR_CONFIG" }));
    hideQr();
  }

  await refreshState();
});

async function refreshState() {
  const response = await sendMessage({ type: "GET_STATE" });
  const state = response.state || {};
  if (state.intervalMinutes) {
    interval.value = String(state.intervalMinutes);
  }
  stateLabel.textContent = state.watchEnabled ? "감시 중" : "대기";
  summary.textContent = [
    state.studtNo ? `학번: ${state.studtNo}` : "개인성적조회 표가 보이는 화면에서 등록하세요.",
    state.pushChannel ? "모바일 알림 채널 준비됨" : "",
    state.refreshActionSelector ? "새로고침 액션 등록됨" : "",
    state.lastSummary || "",
    state.lastResult ? `최근 결과: ${state.lastResult}` : "",
    state.lastCheckedAt ? `마지막 확인: ${formatTime(state.lastCheckedAt)}` : ""
  ].filter(Boolean).join("\n");
}

async function runAction(status, runner) {
  stateLabel.textContent = status;
  const response = await runner();
  if (!response?.ok) {
    summary.textContent = reasonToMessage(response?.reason);
    return;
  }
  if (response.initialized) {
    summary.textContent = "초기 성적 스냅샷을 저장했습니다.";
    return;
  }
  if (Array.isArray(response.changes)) {
    summary.textContent = response.changes.length > 0
      ? `변경 ${response.changes.length}개 감지`
      : "변경된 성적이 없습니다.";
  }
  if (response.sent !== undefined || response.failed !== undefined) {
    summary.textContent = `푸시 테스트 결과: 성공 ${response.sent || 0}개, 실패 ${response.failed || 0}개`;
  }
  if (response.recordingStarted) {
    summary.textContent = "ZEUS 페이지에서 실행할 액션을 클릭하세요.";
  }
}

async function showQr() {
  const response = await sendMessage({ type: "GET_STATE" });
  let channel = response.state?.pushChannel;
  if (!isValidChannel(channel) && response.state?.studtNo) {
    const channelResponse = await sendMessage({ type: "ENSURE_PUSH_CHANNEL" });
    channel = channelResponse.pushChannel;
  }
  if (!isValidChannel(channel)) {
    hideQr();
    summary.textContent = "먼저 개인성적조회 화면을 등록하면 QR이 생성됩니다.";
    return;
  }
  const registerUrl = `${PUSH_SERVER_URL}/register.html?channel=${encodeURIComponent(channel)}`;
  const qrUrl = `${PUSH_SERVER_URL}/qr?text=${encodeURIComponent(registerUrl)}`;
  qr.hidden = false;
  qr.innerHTML = `
    <img src="${qrUrl}" alt="모바일 등록 QR">
  `;
}

function hideQr() {
  qr.hidden = true;
  qr.textContent = "";
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function reasonToMessage(reason) {
  const messages = {
    "not-zeus-tab": "현재 탭이 ZEUS가 아닙니다.",
    "student-number-not-found": "학번을 찾지 못했습니다. 개인성적조회 표가 보이는 두 번째 화면에서 등록해주세요.",
    "missing-config": "먼저 개인성적조회 화면을 등록해주세요.",
    "zeus-tab-not-open": "등록된 ZEUS 탭이 열려 있지 않습니다.",
    "empty-grade-dataset": "성적 데이터를 읽지 못했습니다. 로그인 상태를 확인해주세요.",
    "missing-push-config": "먼저 개인성적조회 화면을 등록하고 QR을 표시해주세요.",
    "network-error": "푸시 서버에 연결하지 못했습니다.",
    "content-api-not-ready": "ZEUS 탭을 새로고침한 뒤 다시 시도해주세요."
  };
  return messages[reason] || "작업에 실패했습니다.";
}

function isValidChannel(channel) {
  return typeof channel === "string" && /^[-_A-Za-z0-9]{8,80}$/.test(channel);
}
