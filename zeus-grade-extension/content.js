(() => {
  const SCRIPT_VERSION = 2;
  if (window.ZeusGradeWatcher?.version >= SCRIPT_VERSION) {
    return;
  }

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

  async function fetchGrades(studtNo) {
    const studentNumber = studtNo || findStudentNumber();
    if (!studentNumber) {
      return { ok: false, reason: "missing-student-number" };
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
      const element = getActionElement(event.target);
      if (element) {
        showActionOverlay(element);
      } else {
        removeActionOverlay();
      }
    };

    const onClick = async (event) => {
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
        border: "3px solid #f97316",
        background: "rgba(249, 115, 22, 0.16)",
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
      background: "#2457c5",
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

  function pad(value) {
    return String(value).padStart(2, "0");
  }
})();
