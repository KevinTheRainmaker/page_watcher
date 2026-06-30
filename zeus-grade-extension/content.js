(() => {
  const SCRIPT_VERSION = 3;
  if (window.ZeusGradeWatcher?.version >= SCRIPT_VERSION) {
    return;
  }

  const PUSH_SERVER_URL = "https://watcher.kangbeen.my";
  const PANEL_ID = "zeus-grade-watcher-panel";
  const PANEL_STATUS_ID = "zeus-grade-watcher-status";
  const DIC_540 = "#9C9798";
  const ACCENT_COLOR = "#F06050";
  const GIST_LOGO_URL = chrome.runtime.getURL("gist-logo.png");
  const A_PLUS_URL = chrome.runtime.getURL("a-plus.png");
  const SESSION_REFRESH_ENDPOINT = "/sys/main/refreshSessionTime.do";
  const GRADE_ENDPOINT = "/ugd/ugdCptnMrksQ/select.do";
  const PG_KEY = "PERS01^PERS01_03^002^UgdShtmMrksQ";
  const RS = "\x1e";
  const US = "\x1f";

  window.ZeusGradeWatcherContent = true;
  window.ZeusGradeWatcher = {
    version: SCRIPT_VERSION,
    handleCommand
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleCommand(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        reason: "command-error",
        error: error?.message || String(error),
        url: location.href
      }));
    return true;
  });

  async function handleCommand(message) {
    if (message?.type === "TOGGLE_PANEL") {
      if (window.top !== window) {
        return { ok: false, handled: false, reason: "not-top-frame", url: location.href };
      }
      await toggleFloatingPanel();
      return { ok: true, handled: true, url: location.href };
    }

    if (message?.type === "EXTRACT_ZEUS_CONTEXT") {
      return {
        ok: true,
        studtNo: findStudentNumber(),
        url: location.href
      };
    }

    if (message?.type === "FETCH_ZEUS_GRADES") {
      return fetchGrades(message.studtNo);
    }

    if (message?.type === "START_ACTION_RECORDING") {
      startActionRecordingMode();
      return { ok: true, handled: true, url: location.href };
    }

    if (message?.type === "RUN_REFRESH_ACTION") {
      const actionClicked = await clickRefreshAction();
      return { ok: true, handled: true, actionClicked, url: location.href };
    }

    return { ok: false, reason: "unknown-command", url: location.href };
  }

  async function toggleFloatingPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      return;
    }
    ensurePanelStyles();
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header>
        <div class="zeus-grade-brand">
          <span class="zeus-grade-gist-wrap">
            <img class="zeus-grade-gist-logo" src="${GIST_LOGO_URL}" alt="GIST">
            <span class="zeus-grade-gist-fallback" hidden>GIST</span>
          </span>
          <strong>ZEUS Grade Watcher</strong>
          <img class="zeus-grade-aplus" src="${A_PLUS_URL}" alt="">
        </div>
        <button type="button" data-action="close" aria-label="닫기">x</button>
      </header>
      <div class="zeus-grade-body">
        <button type="button" data-action="register">개인성적조회 화면 등록</button>
        <button type="button" data-action="record-refresh-action" class="secondary">새로고침 액션 등록</button>
        <button type="button" data-action="check">지금 확인</button>
        <button type="button" data-action="show-qr" class="secondary">핸드폰 등록 QR 표시</button>
        <button type="button" data-action="test-push" class="secondary">푸시 테스트</button>
        <div class="zeus-grade-qr" data-role="qr" hidden></div>
        <label>
          검사 주기
          <select data-field="interval">
            <option value="5">5분</option>
            <option value="10">10분</option>
            <option value="30">30분</option>
            <option value="60">1시간</option>
          </select>
        </label>
        <button type="button" data-action="save-interval">자동 감시 시작</button>
        <button type="button" data-action="clear" class="secondary">설정 삭제</button>
        <div id="${PANEL_STATUS_ID}" role="status" aria-live="polite"></div>
      </div>
    `;
    document.documentElement.appendChild(panel);
    attachLogoFallback(panel);
    panel.addEventListener("click", handlePanelClick);
    await refreshPanelState();
  }

  async function handlePanelClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    if (action === "close") {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (action === "register") {
      await runPanelAction("등록 중", () => sendRuntimeMessage({ type: "REGISTER_ACTIVE_ZEUS_TAB" }));
    }
    if (action === "record-refresh-action") {
      await runPanelAction("ZEUS 페이지에서 실행할 액션을 클릭하세요.", () => sendRuntimeMessage({ type: "START_REFRESH_ACTION_RECORDING" }));
    }
    if (action === "check") {
      await runPanelAction("확인 중", () => sendRuntimeMessage({ type: "RUN_CHECK" }));
    }
    if (action === "show-qr") {
      await showQrInPanel();
    }
    if (action === "test-push") {
      await runPanelAction("전송 중", () => sendRuntimeMessage({ type: "SEND_TEST_PUSH" }));
    }
    if (action === "save-interval") {
      const panel = document.getElementById(PANEL_ID);
      const minutes = Number(panel?.querySelector('[data-field="interval"]')?.value || 30);
      await runPanelAction("저장 중", () => sendRuntimeMessage({ type: "SET_INTERVAL", minutes }));
    }
    if (action === "clear") {
      await runPanelAction("삭제 중", () => sendRuntimeMessage({ type: "CLEAR_CONFIG" }));
      hidePanelQr();
    }
    await refreshPanelState();
  }

  async function runPanelAction(status, runner) {
    setPanelStatus(status);
    const response = await runner();
    if (!response?.ok) {
      setPanelStatus(reasonToMessage(response?.reason));
      return response;
    }
    if (response.initialized) {
      setPanelStatus("초기 성적 스냅샷을 저장했습니다.");
      return response;
    }
    if (Array.isArray(response.changes)) {
      setPanelStatus(response.changes.length > 0
        ? [`변경 ${response.changes.length}개 감지`, response.changeSummary].filter(Boolean).join("\n")
        : "변경된 성적이 없습니다.");
      return response;
    }
    if (response.sent !== undefined || response.failed !== undefined) {
      setPanelStatus(`푸시 테스트 결과: 성공 ${response.sent || 0}개, 실패 ${response.failed || 0}개`);
      return response;
    }
    if (response.recordingStarted) {
      setPanelStatus("ZEUS 페이지에서 실행할 액션을 클릭하세요.");
      return response;
    }
    setPanelStatus("완료되었습니다.");
    return response;
  }

  async function refreshPanelState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    const response = await sendRuntimeMessage({ type: "GET_STATE" });
    const state = response.state || {};
    const interval = panel.querySelector('[data-field="interval"]');
    if (interval && state.intervalMinutes) {
      interval.value = String(state.intervalMinutes);
    }
    const lines = [
      state.studtNo ? `학번: ${state.studtNo}` : "개인성적조회 표가 보이는 화면에서 등록하세요.",
      state.watchEnabled ? "상태: 감시 중" : "상태: 대기",
      state.pushChannel ? "모바일 알림 채널 준비됨" : "",
      state.refreshActionSelector ? "새로고침 액션 등록됨" : "",
      state.lastSummary || "",
      state.lastResult ? `최근 결과: ${state.lastResult}` : "",
      state.lastCheckedAt ? `마지막 확인: ${formatTime(state.lastCheckedAt)}` : ""
    ].filter(Boolean);
    setPanelStatus(lines.join("\n"));
  }

  async function showQrInPanel() {
    const response = await sendRuntimeMessage({ type: "GET_STATE" });
    let channel = response.state?.pushChannel;
    if (!isValidChannel(channel) && response.state?.studtNo) {
      const channelResponse = await sendRuntimeMessage({ type: "ENSURE_PUSH_CHANNEL" });
      channel = channelResponse.pushChannel;
    }
    if (!isValidChannel(channel)) {
      hidePanelQr();
      setPanelStatus("먼저 개인성적조회 화면을 등록하면 QR이 생성됩니다.");
      return;
    }
    const panel = document.getElementById(PANEL_ID);
    const qr = panel?.querySelector('[data-role="qr"]');
    if (!qr) {
      return;
    }
    const registerUrl = `${PUSH_SERVER_URL}/register.html?channel=${encodeURIComponent(channel)}`;
    const qrUrl = `${PUSH_SERVER_URL}/qr?text=${encodeURIComponent(registerUrl)}`;
    qr.hidden = false;
    qr.innerHTML = `
      <img src="${qrUrl}" alt="모바일 등록 QR">
    `;
    setPanelStatus("핸드폰 Chrome으로 QR을 열고 알림을 허용하세요.");
  }

  function hidePanelQr() {
    const qr = document.getElementById(PANEL_ID)?.querySelector('[data-role="qr"]');
    if (!qr) {
      return;
    }
    qr.hidden = true;
    qr.textContent = "";
  }

  function attachLogoFallback(root) {
    const logo = root.querySelector(".zeus-grade-gist-logo");
    const fallback = root.querySelector(".zeus-grade-gist-fallback");
    if (!logo || !fallback) {
      return;
    }
    const showFallback = () => {
      logo.hidden = true;
      fallback.hidden = false;
    };
    logo.addEventListener("error", showFallback);
    logo.addEventListener("load", () => {
      fallback.hidden = true;
    });
    queueMicrotask(() => {
      if (logo.complete && logo.naturalWidth === 0) {
        showFallback();
      }
    });
  }

  function sendRuntimeMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  function setPanelStatus(message) {
    const status = document.getElementById(PANEL_STATUS_ID);
    if (status) {
      status.textContent = message;
    }
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
      "student-number-not-found": "학번을 찾지 못했습니다. 개인성적조회 표가 보이는 화면에서 등록해주세요.",
      "missing-config": "먼저 개인성적조회 화면을 등록해주세요.",
      "zeus-tab-not-open": "등록된 ZEUS 탭이 열려 있지 않습니다.",
      "empty-grade-dataset": "성적 데이터를 읽지 못했습니다. 로그인 상태를 확인해주세요.",
      "student-number-mismatch": "현재 ZEUS 화면의 학번과 저장된 학번이 달라 조회를 중단했습니다.",
      "missing-push-config": "먼저 개인성적조회 화면을 등록하고 QR을 표시해주세요.",
      "network-error": "푸시 서버에 연결하지 못했습니다.",
      "content-api-not-ready": "ZEUS 탭을 새로고침한 뒤 다시 시도해주세요."
    };
    return messages[reason] || "작업에 실패했습니다.";
  }

  function isValidChannel(channel) {
    return typeof channel === "string" && /^[-_A-Za-z0-9]{8,80}$/.test(channel);
  }

  async function fetchGrades(studtNo) {
    const visibleStudentNumber = findStudentNumber();
    const requestedStudentNumber = String(studtNo || "").trim();
    const studentNumber = requestedStudentNumber || visibleStudentNumber;
    if (!studentNumber) {
      return { ok: false, reason: "missing-student-number" };
    }
    if (requestedStudentNumber && visibleStudentNumber && requestedStudentNumber !== visibleStudentNumber) {
      return { ok: false, reason: "student-number-mismatch" };
    }

    const sessionRefresh = await refreshSessionTime();
    const response = await fetch(GRADE_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "Accept": "*/*"
      },
      body: buildRequestBody(studentNumber)
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }

    const rows = parseSsvDataset(text, "dsMain");
    if (rows.length === 0) {
      return { ok: false, reason: "empty-grade-dataset" };
    }

    return {
      ok: true,
      studtNo: studentNumber,
      rows,
      snapshot: normalizeRowsForSnapshot(rows),
      sessionRefresh
    };
  }

  async function refreshSessionTime() {
    try {
      const response = await fetch(SESSION_REFRESH_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Accept": "*/*"
        },
        body: buildSessionRefreshBody()
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return {
        ok: false,
        reason: "session-refresh-error",
        error: error?.message || String(error)
      };
    }
  }

  function buildSessionRefreshBody() {
    const cookiePairs = getCookiePairs();
    return ["SSV:utf-8", ...cookiePairs].join(RS) + RS;
  }

  function buildRequestBody(studtNo) {
    const cookiePairs = getCookiePairs();
    return [
      "SSV:utf-8",
      ...cookiePairs,
      `studt_no=${studtNo}`,
      `pg_key=${PG_KEY}`,
      "page_open_time=",
      `page_open_time_on=${makePageOpenTime()}`
    ].join(RS) + RS;
  }

  function getCookiePairs() {
    return document.cookie
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function makePageOpenTime() {
    const now = new Date();
    const date = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds())
    ].join("");
    return `${date}${String(now.getMilliseconds()).padStart(3, "0")}000`;
  }

  function parseSsvDataset(text, datasetName) {
    const parts = String(text || "").split(RS);
    const datasetIndex = parts.findIndex((part) => part === `Dataset:${datasetName}`);
    if (datasetIndex < 0) {
      return [];
    }

    const header = parts[datasetIndex + 1] || "";
    const columns = header.split(US).slice(1).map((column) => column.split(":")[0]);
    const rows = [];

    for (let index = datasetIndex + 2; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || part.startsWith("Dataset:")) {
        break;
      }
      const values = part.split(US);
      if (values.length < 2) {
        continue;
      }
      const row = {};
      columns.forEach((column, columnIndex) => {
        row[column] = values[columnIndex + 1] || "";
      });
      rows.push(row);
    }

    return rows;
  }

  function normalizeRowsForSnapshot(rows) {
    return rows.map((row) => ({
      year: row.YY || "",
      term: row.SHTM_CD || "",
      div: row.DIV || "",
      courseNo: row.SBJT_NO || "",
      courseName: row.SBJT_NM || "",
      type: row.CPTN_TLSN_NM || "",
      credit: row.PNT || "",
      grade: row.GRD || "",
      gpa: row.GPA || ""
    }));
  }

  function findStudentNumber() {
    const zeusStudentInput = document.querySelector([
      "input[id$='edtStdutNo_input']",
      "input[id*='edtStdutNo']",
      "input[id*='StudtNo']",
      "input[id*='StdutNo']"
    ].join(","));
    const zeusStudentNumber = readStudentNumberFromElement(zeusStudentInput);
    if (zeusStudentNumber) {
      return zeusStudentNumber;
    }

    const inputValues = Array.from(document.querySelectorAll("input"))
      .map((input) => readStudentNumberFromElement(input))
      .map((value) => value.trim())
      .filter(Boolean);
    const inputMatch = inputValues.find(isStudentNumber);
    if (inputMatch) {
      return inputMatch;
    }

    const text = [
      document.body?.innerText || "",
      document.body?.textContent || "",
      document.documentElement?.innerHTML || ""
    ].join("\n");
    const textMatch = text.match(/\b20\d{6}\b/);
    return textMatch ? textMatch[0] : "";
  }

  function readStudentNumberFromElement(element) {
    if (!element) {
      return "";
    }
    const candidates = [
      element.value,
      element.defaultValue,
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.parentElement?.innerText,
      element.parentElement?.textContent
    ];
    const found = candidates
      .map((value) => String(value || "").trim())
      .find(isStudentNumber);
    if (found) {
      return found;
    }

    const combined = candidates.join(" ");
    return combined.match(/\b20\d{6}\b/)?.[0] || "";
  }

  function isStudentNumber(value) {
    return /^20\d{6}$/.test(String(value || "").trim());
  }

  function startActionRecordingMode() {
    stopActionRecordingMode();
    document.documentElement.classList.add("zeus-grade-action-cursor");

    const onMouseMove = (event) => {
      if (isInsidePanel(event.target)) {
        removeActionOverlay();
        return;
      }
      const element = getActionElement(event.target);
      if (element) {
        showActionOverlay(element);
      } else {
        removeActionOverlay();
      }
    };

    const onClick = async (event) => {
      if (isInsidePanel(event.target)) {
        return;
      }
      const element = getActionElement(event.target);
      if (!element) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selector = generateCssSelector(element);
      await chrome.storage.local.set({
        refreshActionSelector: selector,
        refreshActionFrameUrl: location.href
      });
      notifyInPage("새로고침 액션을 저장했습니다.");
      stopActionRecordingMode();
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    window.ZeusGradeWatcherActionCleanup = () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.documentElement.classList.remove("zeus-grade-action-cursor");
      removeActionOverlay();
      window.ZeusGradeWatcherActionCleanup = null;
    };
  }

  function stopActionRecordingMode() {
    window.ZeusGradeWatcherActionCleanup?.();
  }

  function isInsidePanel(target) {
    return target instanceof Element && Boolean(target.closest(`#${PANEL_ID}`));
  }

  async function clickRefreshAction() {
    const config = await chrome.storage.local.get(["refreshActionSelector", "refreshActionFrameUrl"]);
    if (!config.refreshActionSelector || !isSameFrame(config.refreshActionFrameUrl)) {
      return false;
    }
    const action = document.querySelector(config.refreshActionSelector);
    if (!action) {
      return false;
    }
    const clickableAction = getActionElement(action) || action;
    clickableAction.focus?.();
    dispatchClickSequence(clickableAction);
    return true;
  }

  function dispatchClickSequence(element) {
    const rect = element.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 1
    };
    element.dispatchEvent(new MouseEvent("mouseover", eventOptions));
    element.dispatchEvent(new MouseEvent("mousemove", eventOptions));
    element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
    if (isNativeActionElement(element)) {
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
  }

  function getActionElement(target) {
    const element = getSelectableElement(target);
    if (!element) {
      return null;
    }
    if (isNativeActionElement(element)) {
      return element;
    }
    const childAction = findSingleChildAction(element);
    if (childAction) {
      return childAction;
    }

    let current = element;
    let fallback = element;
    while (current && current !== document.documentElement) {
      if (!getSelectableElement(current)) {
        break;
      }
      if (isInternalRenderElement(current)) {
        current = current.parentElement;
        continue;
      }
      if (isLikelyActionRoot(current)) {
        return current;
      }
      if (current.id) {
        fallback = current;
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function findSingleChildAction(element) {
    const actions = Array.from(element.querySelectorAll(
      "button, input[type='button'], input[type='submit'], input[type='reset'], a[href], [role='button'], [role='link']"
    )).filter((candidate) => getSelectableElement(candidate) && hasVisibleBox(candidate));
    return actions.length === 1 ? actions[0] : null;
  }

  function getSelectableElement(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    if (
      target.closest(`#${PANEL_ID}`) ||
      target.closest(".zeus-grade-action-overlay") ||
      target.closest(".zeus-grade-toast")
    ) {
      return null;
    }
    return target;
  }

  function isLikelyActionRoot(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    if (element.matches("button, a, input, select, textarea, [role='button'], [role='link']")) {
      return true;
    }
    const style = getComputedStyle(element);
    return element.hasAttribute("tabindex") && element.id && !isInternalRenderElement(element) && style.display !== "none";
  }

  function isInternalRenderElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const id = element.id || "";
    return (
      element.tagName.toLowerCase() === "img" ||
      /(?:ImageElement|TextBoxElement|InputElement|AlignImageElement)$/.test(id) ||
      (!element.id && element.parentElement)
    );
  }

  function isNativeActionElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") {
      return true;
    }
    if (tagName === "a" && element.hasAttribute("href")) {
      return true;
    }
    if (tagName !== "input") {
      return false;
    }
    const type = (element.getAttribute("type") || "text").toLowerCase();
    return ["button", "submit", "reset", "image"].includes(type);
  }

  function generateCssSelector(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }
    const path = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.nodeName.toLowerCase();
      const stableAttribute = getStableAttributeSelector(current);
      if (stableAttribute) {
        selector += stableAttribute;
      } else if (current.className && typeof current.className === "string") {
        const classes = current.className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .map((className) => `.${CSS.escape(className)}`)
          .join("");
        selector += classes;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sibling) => sibling.nodeName === current.nodeName);
        if (siblings.length > 1) {
          selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      path.unshift(selector);
      const candidate = path.join(" > ");
      if (selectorMatchesOnlyElement(candidate, element)) {
        return candidate;
      }
      current = current.parentElement;
    }
    return path.join(" > ");
  }

  function getStableAttributeSelector(element) {
    const attributes = ["name", "data-id", "data-testid", "data-role", "value"];
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value) {
        return `[${name}="${CSS.escape(value)}"]`;
      }
    }
    return "";
  }

  function selectorMatchesOnlyElement(selector, element) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch (error) {
      return false;
    }
  }

  function showActionOverlay(element) {
    const rect = element.getBoundingClientRect();
    let overlay = document.querySelector(".zeus-grade-action-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "zeus-grade-action-overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        border: `3px solid ${ACCENT_COLOR}`,
        background: "rgba(240, 96, 80, 0.16)",
        boxSizing: "border-box"
      });
      document.documentElement.appendChild(overlay);
    }
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  }

  function removeActionOverlay() {
    document.querySelector(".zeus-grade-action-overlay")?.remove();
  }

  function notifyInPage(message) {
    const toast = document.createElement("div");
    toast.className = "zeus-grade-toast";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "2147483647",
      padding: "10px 12px",
      color: "#ffffff",
      background: ACCENT_COLOR,
      borderRadius: "6px",
      font: "13px/1.4 system-ui, sans-serif",
      boxShadow: "0 12px 36px rgba(15, 23, 42, 0.24)"
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function hasVisibleBox(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isSameFrame(frameUrl) {
    return !frameUrl || frameUrl === location.href;
  }

  function ensurePanelStyles() {
    if (document.getElementById("zeus-grade-watcher-styles")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "zeus-grade-watcher-styles";
    style.textContent = `
      #${PANEL_ID} {
        --dic-540: ${DIC_540};
        --accent-color: ${ACCENT_COLOR};
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 2147483647;
        width: 310px;
        color: #172033;
        background: #f7f8fb;
        border: 1px solid #d7dce7;
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
        font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow: hidden;
      }
      #${PANEL_ID}, #${PANEL_ID} * {
        box-sizing: border-box;
      }
      #${PANEL_ID} header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 26px;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 8px 10px 8px 12px;
        color: #ffffff;
        background: var(--dic-540);
      }
      #${PANEL_ID} .zeus-grade-brand {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 8px;
      }
      #${PANEL_ID} header strong {
        font-size: 14px;
        font-weight: 750;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .zeus-grade-aplus {
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        object-fit: contain;
      }
      #${PANEL_ID} .zeus-grade-gist-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 54px;
        height: 18px;
        flex: 0 0 auto;
      }
      #${PANEL_ID} .zeus-grade-gist-logo {
        width: 54px;
        height: 18px;
        object-fit: contain;
      }
      #${PANEL_ID} .zeus-grade-gist-logo[hidden] {
        display: none;
      }
      #${PANEL_ID} .zeus-grade-gist-fallback {
        color: #ffffff;
        font-size: 15px;
        font-weight: 800;
        letter-spacing: 0;
      }
      #${PANEL_ID} .zeus-grade-gist-fallback[hidden] {
        display: none;
      }
      #${PANEL_ID} header button {
        width: 26px;
        min-height: 26px;
        padding: 0;
        color: #ffffff;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.46);
        border-radius: 6px;
      }
      #${PANEL_ID} .zeus-grade-body {
        display: grid;
        gap: 9px;
        padding: 12px;
      }
      #${PANEL_ID} button,
      #${PANEL_ID} select {
        width: 100%;
        min-height: 34px;
        border: 1px solid #cbd2df;
        border-radius: 6px;
        font: inherit;
      }
      #${PANEL_ID} button {
        cursor: pointer;
        color: #ffffff;
        background: var(--accent-color);
        border-color: var(--accent-color);
        font-weight: 700;
      }
      #${PANEL_ID} button.secondary {
        color: #293246;
        background: #ffffff;
        border-color: #cbd2df;
      }
      #${PANEL_ID} label {
        display: grid;
        gap: 5px;
        color: #475569;
      }
      #${PANEL_ID} select {
        padding: 0 9px;
        color: #172033;
        background: #ffffff;
      }
      #${PANEL_ID} #${PANEL_STATUS_ID} {
        min-height: 38px;
        padding: 9px;
        color: #475569;
        background: #ffffff;
        border: 1px solid #d9deea;
        border-radius: 6px;
        white-space: pre-line;
      }
      #${PANEL_ID} .zeus-grade-qr {
        display: grid;
        gap: 6px;
        justify-items: center;
        padding: 8px;
        background: #ffffff;
        border: 1px solid #d9deea;
        border-radius: 6px;
      }
      #${PANEL_ID} .zeus-grade-qr[hidden] {
        display: none;
      }
      #${PANEL_ID} .zeus-grade-qr img {
        width: 180px;
        height: 180px;
      }
      .zeus-grade-action-cursor,
      .zeus-grade-action-cursor * {
        cursor: crosshair !important;
      }
      .zeus-grade-action-cursor #${PANEL_ID},
      .zeus-grade-action-cursor #${PANEL_ID} * {
        cursor: auto !important;
      }
      .zeus-grade-action-cursor #${PANEL_ID} button,
      .zeus-grade-action-cursor #${PANEL_ID} select {
        cursor: pointer !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }
})();
