(() => {
  if (window.PageWatcher?.loaded) {
    return;
  }

  const PUSH_SERVER_URL = "https://watcher.kangbeen.my";

  const STORAGE_KEYS = {
    watchSelector: "watchSelector",
    watchFrameUrl: "watchFrameUrl",
    watchPageUrl: "watchPageUrl",
    watchTargets: "watchTargets",
    watchTextSnapshot: "watchTextSnapshot",
    refreshActionSelector: "refreshActionSelector",
    refreshActionFrameUrl: "refreshActionFrameUrl"
  };

  const PANEL_ID = "page-watcher-floating-panel";
  const PANEL_STATUS_ID = "page-watcher-status";
  const ROOT_CLASS = "page-watcher-root";
  const HOVER_CLASS = "page-watcher-hover-element";
  const CANDIDATE_CLASS = "page-watcher-candidate-element";
  const ACTIVE_CLASS = "page-watcher-active-element";
  const TABLE_CELL_SELECTOR = "td, th, [role='cell'], [role='gridcell'], div, span";

  let selectionCleanup = null;
  let actionCleanup = null;
  let watchLayerRefresh = null;
  let hoverElement = null;
  let candidateElements = [];
  let activeElements = [];

  window.PageWatcher = {
    loaded: true,
    handleCommand
  };

  async function handleCommand(type) {
    if (type === "TOGGLE_PANEL") {
      toggleFloatingPanel();
      renderActiveWatchAreas();
      return { handled: true, frameUrl: location.href };
    }

    if (type === "START_WATCH_SELECTION") {
      startWatchSelectionMode();
      return { handled: true, frameUrl: location.href };
    }

    if (type === "START_ACTION_RECORDING") {
      startActionRecordingMode();
      return { handled: true, frameUrl: location.href };
    }

    if (type === "RUN_CHECK_NOW") {
      return runPageCheck();
    }

    if (type === "RUN_REFRESH_ACTION") {
      return runRefreshActionOnly();
    }

    if (type === "RUN_READ_WATCH") {
      return runPageCheck({ skipRefresh: true });
    }

    if (type === "CLEAR_ACTIVE_WATCH_AREAS") {
      clearActiveWatchAreas();
      clearCandidateAreas();
      removeOverlay();
      return { handled: true, frameUrl: location.href };
    }

    return { handled: false };
  }

  async function toggleFloatingPanel() {
    if (window.top !== window) {
      return;
    }

    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      return;
    }

    const config = await chrome.storage.local.get([
      "checkIntervalMinutes",
      "pushChannel",
      "watchTargets",
      "watchSelector"
    ]);
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = ROOT_CLASS;
    panel.innerHTML = `
      <header>
        <strong>Page Watcher</strong>
        <button type="button" data-action="close" aria-label="닫기">x</button>
      </header>
      <div class="page-watcher-body">
        <button type="button" data-action="select-watch">감시 영역 선택/드래그</button>
        <button type="button" data-action="record-action">새로고침 액션 등록</button>
        <button type="button" data-action="check-now">지금 확인</button>
        <label>
          검사 주기
          <select data-field="interval">
            <option value="10">10분</option>
            <option value="30">30분</option>
            <option value="60">1시간</option>
            <option value="120">2시간</option>
          </select>
        </label>
        <button type="button" data-action="save-interval">주기 저장</button>
        <button type="button" data-action="show-qr" class="secondary">핸드폰 등록 QR 표시</button>
        <button type="button" data-action="test-push" class="secondary">푸시 테스트</button>
        <div class="page-watcher-qr" data-role="qr" hidden></div>
        <button type="button" data-action="clear-settings" class="secondary">감시 설정 삭제</button>
        <div id="${PANEL_STATUS_ID}" role="status" aria-live="polite"></div>
      </div>
    `;

    document.documentElement.appendChild(panel);
    panel.querySelector('[data-field="interval"]').value = String(config.checkIntervalMinutes || 30);
    panel.addEventListener("click", handlePanelClick);
    renderQrIfWatchConfigured(panel, config);
    renderActiveWatchAreas();
    setPanelStatus("이 패널은 현재 웹페이지 안에 떠 있습니다.");
  }

  async function handlePanelClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const panel = document.getElementById(PANEL_ID);
    const action = button.dataset.action;

    if (action === "close") {
      panel.remove();
      return;
    }

    if (action === "select-watch") {
      await broadcastCommand("START_WATCH_SELECTION");
      setPanelStatus("감시할 영역을 페이지에서 클릭하세요.");
      return;
    }

    if (action === "record-action") {
      await broadcastCommand("START_ACTION_RECORDING");
      setPanelStatus("검사 전에 클릭할 버튼이나 링크를 선택하세요.");
      return;
    }

    if (action === "check-now") {
      const response = await broadcastCommand("RUN_CHECK_NOW");
      const handled = response.results?.find((result) => result?.handled);
      setPanelStatus(handled?.message || "검사를 실행했습니다.");
      return;
    }

    if (action === "save-interval") {
      const minutes = Number(panel.querySelector('[data-field="interval"]').value);
      await chrome.storage.local.set({ checkIntervalMinutes: minutes });
      await chrome.runtime.sendMessage({ type: "SET_INTERVAL", minutes });
      setPanelStatus(`검사 주기를 ${formatMinutes(minutes)}로 저장했습니다.`);
      return;
    }

    if (action === "show-qr") {
      const config = await chrome.storage.local.get([
        "pushChannel",
        "watchTargets",
        "watchSelector"
      ]);
      if (!hasWatchConfig(config) || !isValidChannel(normalizeChannel(config.pushChannel))) {
        hideQr(panel);
        setPanelStatus("먼저 감시 영역을 선택하면 QR이 생성됩니다.");
        return;
      }
      renderQr(panel, { pushChannel: normalizeChannel(config.pushChannel) });
      setPanelStatus("핸드폰 Chrome으로 QR을 열고 알림을 허용하세요.");
      return;
    }

    if (action === "test-push") {
      const config = await chrome.storage.local.get([
        "pushChannel",
        "watchTargets",
        "watchSelector"
      ]);
      if (!hasWatchConfig(config) || !isValidChannel(normalizeChannel(config.pushChannel))) {
        setPanelStatus("먼저 감시 영역을 선택한 뒤 푸시를 테스트하세요.");
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type: "SEND_PUSH_NOTIFICATION",
        labels: ["테스트 알림"],
        test: true
      });
      setPanelStatus(response?.ok ? "테스트 푸시를 보냈습니다." : "테스트 푸시 전송에 실패했습니다.");
      return;
    }

    if (action === "clear-settings") {
      await broadcastCommand("CLEAR_ACTIVE_WATCH_AREAS");
      await chrome.runtime.sendMessage({ type: "DELETE_PUSH_CHANNEL" });
      await chrome.storage.local.remove([
        "watchSelector",
        "watchFrameUrl",
        "watchPageUrl",
        "watchTargets",
        "watchTextSnapshot",
        "refreshActionSelector",
        "refreshActionFrameUrl",
        "pushChannel"
      ]);
      panel.querySelector('[data-role="qr"]').hidden = true;
      panel.querySelector('[data-role="qr"]').textContent = "";
      clearActiveWatchAreas();
      setPanelStatus("감시 설정을 삭제했습니다.");
    }
  }

  function startWatchSelectionMode() {
    stopActiveModes();
    document.documentElement.classList.add("page-watcher-selection-cursor");

    let dragStart = null;
    let didDrag = false;
    let suppressClick = false;

    const onMouseMove = (event) => {
      if (dragStart) {
        const distance = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
        if (distance > 6) {
          didDrag = true;
          const rect = getRectFromPoints(dragStart.x, dragStart.y, event.clientX, event.clientY);
          removeOverlay();
          showCandidateAreas(findWatchElementsFromRect(rect));
        }
        return;
      }

      const element = getSelectableElement(event.target);
      if (element) {
        showOverlayForElement(element);
      } else {
        removeOverlay();
      }
    };

    const onMouseDown = (event) => {
      const element = getSelectableElement(event.target);
      if (!element) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      dragStart = { x: event.clientX, y: event.clientY, element };
      didDrag = false;
    };

    const onMouseUp = async (event) => {
      if (!dragStart) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      suppressClick = true;
      clearCandidateAreas();

      const targets = didDrag
        ? buildWatchTargetsFromElements(findWatchElementsFromRect(getRectFromPoints(dragStart.x, dragStart.y, event.clientX, event.clientY)))
        : [buildWatchTarget(dragStart.element)];

      const validTargets = targets.filter(Boolean);
      if (validTargets.length === 0) {
        notifyInPage("선택된 감시 영역이 없습니다.");
        setPanelStatus("선택된 감시 영역이 없습니다.");
        dragStart = null;
        didDrag = false;
        removeOverlay();
        return;
      }

      await chrome.runtime.sendMessage({ type: "DELETE_SERVER_CHANNEL_ONLY" });
      const nextChannel = await resetPushChannel();
      await chrome.storage.local.set({
        [STORAGE_KEYS.watchSelector]: validTargets[0].selector,
        [STORAGE_KEYS.watchFrameUrl]: location.href,
        [STORAGE_KEYS.watchPageUrl]: stripHash(location.href),
        [STORAGE_KEYS.watchTargets]: validTargets,
        [STORAGE_KEYS.watchTextSnapshot]: validTargets.map((target) => target.textSnapshot).join("\n")
      });
      await chrome.runtime.sendMessage({
        type: "WATCH_CONFIG_CREATED",
        pageUrl: stripHash(location.href)
      });
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        renderQr(panel, { pushChannel: nextChannel });
      }
      renderActiveWatchAreas(validTargets);

      notifyInPage(`${validTargets.length}개 감시 영역을 저장했습니다.`);
      setPanelStatus(`${validTargets.length}개 감시 영역을 저장했습니다.`);
      dragStart = null;
      didDrag = false;
      stopActiveModes();
    };

    const onClick = (event) => {
      if (!suppressClick) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    };

    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("click", onClick, true);

    selectionCleanup = () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("click", onClick, true);
      document.documentElement.classList.remove("page-watcher-selection-cursor");
      removeOverlay();
      clearCandidateAreas();
      selectionCleanup = null;
    };
  }

  function startActionRecordingMode() {
    stopActiveModes();
    document.documentElement.classList.add("page-watcher-selection-cursor");

    const onMouseMove = (event) => {
      const element = getActionElement(event.target);
      if (element) {
        showOverlayForElement(element);
      } else {
        removeOverlay();
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
        [STORAGE_KEYS.refreshActionSelector]: selector,
        [STORAGE_KEYS.refreshActionFrameUrl]: location.href
      });

      notifyInPage("새로고침 액션을 저장했습니다.");
      setPanelStatus("새로고침 액션을 저장했습니다.");
      stopActiveModes();
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);

    actionCleanup = () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.documentElement.classList.remove("page-watcher-selection-cursor");
      removeOverlay();
      actionCleanup = null;
    };
  }

  async function runPageCheck(options = {}) {
    const config = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    if (!isSameFrame(config.watchFrameUrl)) {
      return { handled: false, frameUrl: location.href };
    }

    const targets = getWatchTargets(config);
    if (targets.length === 0) {
      return { handled: true, message: "먼저 감시 영역을 선택하세요." };
    }

    if (!options.skipRefresh) {
      const actionClicked = await clickRefreshAction(config);
      if (actionClicked) {
        await delay(3000);
      }
    }

    const nextTargets = [];
    const missingTargets = [];
    const changedTargets = [];

    for (const target of targets) {
      const currentText = extractWatchText(target.selector);
      if (currentText === null) {
        missingTargets.push(target);
        nextTargets.push(target);
        continue;
      }

      const previousText = target.textSnapshot || "";
      const nextTarget = { ...target, textSnapshot: currentText };
      nextTargets.push(nextTarget);
      if (previousText !== currentText) {
        changedTargets.push({
          ...nextTarget,
          previousText,
          currentText
        });
      }
    }

    if (missingTargets.length === targets.length) {
      return { handled: true, message: "감시 영역을 찾을 수 없습니다. 다시 선택하세요." };
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.watchTargets]: nextTargets,
      [STORAGE_KEYS.watchTextSnapshot]: nextTargets.map((target) => target.textSnapshot || "").join("\n")
    });

    if (changedTargets.length > 0) {
      const labels = changedTargets.map((target) => target.label);
      const labelSummary = summarizeLabels(labels);
      await sendNotification("Page Watcher", `변경 영역: ${labelSummary}`);
      await sendPushNotification(labels);
      return { handled: true, message: `변경 감지: ${labelSummary}` };
    }

    if (missingTargets.length > 0) {
      return {
        handled: true,
        message: `변경 사항 없음. 단, ${missingTargets.length}개 영역은 현재 찾지 못했습니다.`
      };
    }

    return { handled: true, message: "변경 사항이 없습니다." };
  }

  async function runRefreshActionOnly() {
    const config = await chrome.storage.local.get([
      STORAGE_KEYS.refreshActionSelector,
      STORAGE_KEYS.refreshActionFrameUrl
    ]);
    const actionClicked = await clickRefreshAction(config);
    return {
      handled: false,
      actionClicked,
      frameUrl: location.href
    };
  }

  async function clickRefreshAction(config) {
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
    element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
  }

  function extractWatchText(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      return null;
    }
    return normalizeText(element.innerText || element.textContent || "");
  }

  function normalizeText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  function showOverlayForElement(element) {
    if (hoverElement === element) {
      return;
    }

    removeOverlay();
    hoverElement = element;
    hoverElement.classList.add(HOVER_CLASS);
  }

  function removeOverlay() {
    hoverElement?.classList.remove(HOVER_CLASS);
    hoverElement = null;
  }

  function showCandidateAreas(elements) {
    clearCandidateAreas();
    candidateElements = elements.slice(0, 80);
    for (const element of candidateElements) {
      element.classList.add(CANDIDATE_CLASS);
    }
  }

  function clearCandidateAreas() {
    for (const element of candidateElements) {
      element.classList.remove(CANDIDATE_CLASS);
    }
    candidateElements = [];
  }

  async function renderActiveWatchAreas(targets) {
    const nextTargets = targets || getWatchTargets(await chrome.storage.local.get([
      "watchTargets",
      "watchSelector",
      "watchTextSnapshot"
    ]));
    clearActiveWatchAreas();
    if (nextTargets.length === 0) {
      return;
    }

    activeElements = [];
    for (const target of nextTargets) {
      const element = document.querySelector(target.selector);
      if (!element || !isRenderableWatchElement(element)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        continue;
      }
      element.classList.add(ACTIVE_CLASS);
      element.dataset.pageWatcherLabel = target.label || "감시 영역";
      activeElements.push(element);
    }

    watchLayerRefresh = window.setInterval(() => {
      updateActiveWatchAreas(nextTargets);
    }, 2000);
  }

  function updateActiveWatchAreas(targets) {
    for (const element of activeElements) {
      element.classList.remove(ACTIVE_CLASS);
      delete element.dataset.pageWatcherLabel;
    }
    activeElements = [];
    for (const target of targets) {
      const element = document.querySelector(target.selector);
      if (!element || !isRenderableWatchElement(element)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        continue;
      }
      element.classList.add(ACTIVE_CLASS);
      element.dataset.pageWatcherLabel = target.label || "감시 영역";
      activeElements.push(element);
    }
  }

  function clearActiveWatchAreas() {
    if (watchLayerRefresh) {
      window.clearInterval(watchLayerRefresh);
      watchLayerRefresh = null;
    }
    for (const element of activeElements) {
      element.classList.remove(ACTIVE_CLASS);
      delete element.dataset.pageWatcherLabel;
    }
    activeElements = [];
  }

  function findWatchElementsFromRect(rect) {
    const tableCells = findTableCellsFromRect(rect);
    if (tableCells.length > 0) {
      return uniqueElements(tableCells).slice(0, 120);
    }

    const allElements = Array.from(document.querySelectorAll(`${TABLE_CELL_SELECTOR}, p, li, a, button`));
    const visibleIntersecting = allElements.filter((element) => {
      if (!getSelectableElement(element) || !isWatchCandidateElement(element)) {
        return false;
      }
      return rectsIntersect(rect, element.getBoundingClientRect());
    });

    const selected = smallestUsefulElements(visibleIntersecting).filter(hasOwnVisibleText);
    return uniqueElements(selected).slice(0, 80);
  }

  function findTableCellsFromRect(selectionRect) {
    const cells = Array.from(document.querySelectorAll(TABLE_CELL_SELECTOR))
      .filter((cell) => getSelectableElement(cell) && isTableCell(cell) && hasVisibleBox(cell));
    const directCells = cells.filter((cell) => rectsIntersect(selectionRect, cell.getBoundingClientRect()));
    if (directCells.length === 0) {
      return [];
    }

    const groupedByRow = new Map();
    for (const cell of cells) {
      const row = findCellRow(cell);
      if (!row) {
        continue;
      }
      if (!groupedByRow.has(row)) {
        groupedByRow.set(row, []);
      }
      groupedByRow.get(row).push(cell);
    }

    const selectedRows = new Set();
    for (const cell of directCells) {
      const row = findCellRow(cell);
      if (row) {
        selectedRows.add(row);
      }
    }

    const rowCellsInSelection = [];
    for (const row of selectedRows) {
      const rowCells = groupedByRow.get(row) || [];
      rowCellsInSelection.push(...rowCells);
    }

    return rowCellsInSelection.length > 0 ? rowCellsInSelection : directCells;
  }

  function buildWatchTargetsFromElements(elements) {
    return elements.map(buildWatchTarget).filter(Boolean);
  }

  function buildWatchTarget(element) {
    if (!element) {
      return null;
    }

    const textSnapshot = normalizeText(element.innerText || element.textContent || "");
    if (!textSnapshot && !isTableCell(element)) {
      return null;
    }

    return {
      selector: generateCssSelector(element),
      label: describeElement(element),
      textSnapshot
    };
  }

  function generateCssSelector(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    if (element.id) {
      const idSelector = `#${CSS.escape(element.id)}`;
      if (selectorMatchesOnlyElement(idSelector, element)) {
        return idSelector;
      }
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
          .filter((className) => className && !className.startsWith("page-watcher-"))
          .slice(0, 3)
          .map((className) => `.${CSS.escape(className)}`)
          .join("");
        selector += classes;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (sibling) => sibling.nodeName === current.nodeName
        );
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

  function selectorMatchesOnlyElement(selector, element) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch (error) {
      return false;
    }
  }

  function getStableAttributeSelector(element) {
    const attributes = ["name", "data-id", "data-testid", "data-role"];
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value) {
        return `[${name}="${CSS.escape(value)}"]`;
      }
    }
    return "";
  }

  function getSelectableElement(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    if (
      target.closest(`#${PANEL_ID}`) ||
      target.closest(".page-watcher-root") ||
      target.closest(".page-watcher-toast") ||
      target.closest(".page-watcher-overlay-layer") ||
      target.closest(".page-watcher-highlight-overlay")
    ) {
      return null;
    }
    return target;
  }

  function getActionElement(target) {
    const element = getSelectableElement(target);
    if (!element) {
      return null;
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

  function getWatchTargets(config) {
    if (Array.isArray(config.watchTargets) && config.watchTargets.length > 0) {
      return config.watchTargets.filter((target) => target?.selector);
    }

    if (config.watchSelector) {
      return [
        {
          selector: config.watchSelector,
          label: "선택 영역",
          textSnapshot: config.watchTextSnapshot || ""
        }
      ];
    }

    return [];
  }

  function describeElement(element) {
    const tableLabel = describeTableCell(element);
    if (tableLabel) {
      return tableLabel;
    }

    const ariaLabel = element.getAttribute("aria-label");
    const title = element.getAttribute("title");
    const nearbyHeading = findNearbyHeading(element);
    const ownText = normalizeText(element.innerText || element.textContent || "");
    const base = ariaLabel || title || nearbyHeading || ownText || element.tagName.toLowerCase();
    return truncateText(base, 80);
  }

  function describeTableCell(element) {
    const cell = isTableCell(element) ? element : element.closest("td, th, [role='cell'], [role='gridcell']");
    if (!cell) {
      return "";
    }

    const row = findCellRow(cell);
    const table = cell.closest("table");
    const rowIndex = row ? Array.from(row.parentElement?.children || []).indexOf(row) : -1;
    const rowCells = row ? Array.from(row.children).filter(isTableCell) : [];
    const colIndex = rowCells.indexOf(cell);
    const rowHeader = row
      ? normalizeText(row.querySelector("th, [role='rowheader']")?.innerText || "")
      : "";
    const colHeader = findColumnHeader(table, colIndex);
    const caption = normalizeText(table?.querySelector("caption")?.innerText || "");
    const parts = [caption, rowHeader, colHeader].filter(Boolean);

    if (parts.length > 0) {
      return truncateText(parts.join(" / "), 100);
    }

    if (rowIndex >= 0 && colIndex >= 0) {
      return `표 ${rowIndex + 1}행 ${colIndex + 1}열`;
    }

    return truncateText(normalizeText(cell.innerText || cell.textContent || "표 셀"), 80);
  }

  function findColumnHeader(table, colIndex) {
    if (!table || colIndex < 0) {
      return "";
    }

    const rows = Array.from(table.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.children);
      const header = cells[colIndex];
      if (header?.tagName.toLowerCase() === "th") {
        const text = normalizeText(header.innerText || header.textContent || "");
        if (text) {
          return text;
        }
      }
    }

    return "";
  }

  function findNearbyHeading(element) {
    let current = element.parentElement;
    while (current && current !== document.body) {
      const heading = current.querySelector("h1, h2, h3, h4, h5, h6, caption, legend");
      const text = normalizeText(heading?.innerText || heading?.textContent || "");
      if (text) {
        return text;
      }
      current = current.parentElement;
    }
    return "";
  }

  function smallestUsefulElements(elements) {
    return elements.filter((element) => {
      return !elements.some((other) => other !== element && element.contains(other));
    });
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function isWatchCandidateElement(element) {
    if (!hasVisibleBox(element)) {
      return false;
    }
    return isTableCell(element) || Boolean(normalizeText(element.innerText || element.textContent || ""));
  }

  function isRenderableWatchElement(element) {
    if (!hasVisibleBox(element)) {
      return false;
    }
    if (isTableCell(element)) {
      return true;
    }
    if (element.querySelector(TABLE_CELL_SELECTOR) && Array.from(element.querySelectorAll(TABLE_CELL_SELECTOR)).some(isTableCell)) {
      return false;
    }
    return true;
  }

  function isTableCell(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const name = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const display = getComputedStyle(element).display;
    return (
      name === "td" ||
      name === "th" ||
      role === "cell" ||
      role === "gridcell" ||
      display === "table-cell"
    );
  }

  function findCellRow(cell) {
    const semanticRow = cell.closest("tr, [role='row']");
    if (semanticRow) {
      return semanticRow;
    }

    let current = cell.parentElement;
    while (current && current !== document.documentElement) {
      const display = getComputedStyle(current).display;
      if (display === "table-row") {
        return current;
      }
      if (display === "table" || display === "inline-table" || current === document.body) {
        return null;
      }
      current = current.parentElement;
    }
    return null;
  }

  function hasVisibleBox(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function hasVisibleText(element) {
    if (!hasVisibleBox(element)) {
      return false;
    }
    return Boolean(normalizeText(element.innerText || element.textContent || ""));
  }

  function hasOwnVisibleText(element) {
    const ownText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join("");
    if (normalizeText(ownText)) {
      return true;
    }
    const elementChildren = Array.from(element.children).filter((child) => hasVisibleText(child));
    return elementChildren.length === 0;
  }

  function getRectFromPoints(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    return {
      left,
      top,
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  function rectsIntersect(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function summarizeLabels(labels) {
    const uniqueLabels = Array.from(new Set(labels.filter(Boolean)));
    const shown = uniqueLabels.slice(0, 4).join(", ");
    if (uniqueLabels.length > 4) {
      return `${shown} 외 ${uniqueLabels.length - 4}개`;
    }
    return shown || "선택 영역";
  }

  function truncateText(text, maxLength) {
    const normalized = normalizeText(text);
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 1)}...`;
  }

  function stopActiveModes() {
    selectionCleanup?.();
    actionCleanup?.();
  }

  function isSameFrame(frameUrl) {
    return !frameUrl || frameUrl === location.href;
  }

  function notifyInPage(message) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.className = "page-watcher-toast";
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function setPanelStatus(message) {
    const status = document.getElementById(PANEL_STATUS_ID);
    if (status) {
      status.textContent = message;
    }
  }

  function broadcastCommand(command) {
    return chrome.runtime.sendMessage({
      type: "RUN_FRAME_COMMAND",
      command
    });
  }

  function sendNotification(title, message) {
    return chrome.runtime.sendMessage({
      type: "SHOW_NOTIFICATION",
      title,
      message
    });
  }

  function sendPushNotification(labels) {
    return chrome.runtime.sendMessage({
      type: "SEND_PUSH_NOTIFICATION",
      labels
    });
  }

  function delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function formatMinutes(minutes) {
    if (minutes >= 60) {
      return `${minutes / 60}시간`;
    }
    return `${minutes}분`;
  }

  function stripHash(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return url;
    }
  }

  function renderQr(panel, config) {
    const qr = panel.querySelector('[data-role="qr"]');
    const registerUrl = `${PUSH_SERVER_URL}/register.html?channel=${encodeURIComponent(config.pushChannel)}`;
    const qrUrl = `${PUSH_SERVER_URL}/qr?text=${encodeURIComponent(registerUrl)}`;
    qr.hidden = false;
    qr.innerHTML = `
      <img src="${qrUrl}" alt="모바일 등록 QR">
      <a href="${registerUrl}" target="_blank" rel="noopener noreferrer">${registerUrl}</a>
    `;
  }

  function renderQrIfWatchConfigured(panel, config) {
    const pushChannel = normalizeChannel(config.pushChannel);
    if (!hasWatchConfig(config) || !isValidChannel(pushChannel)) {
      hideQr(panel);
      return;
    }
    renderQr(panel, { pushChannel });
  }

  function hideQr(panel) {
    const qr = panel.querySelector('[data-role="qr"]');
    if (!qr) {
      return;
    }
    qr.hidden = true;
    qr.textContent = "";
  }

  function hasWatchConfig(config) {
    if (Array.isArray(config.watchTargets) && config.watchTargets.some((target) => target?.selector)) {
      return true;
    }
    return Boolean(config.watchSelector);
  }

  function normalizeChannel(channel) {
    return String(channel || "").trim();
  }

  function isValidChannel(channel) {
    return /^[-_A-Za-z0-9]{8,80}$/.test(channel);
  }

  function generateChannel() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function resetPushChannel() {
    const nextChannel = generateChannel();
    await chrome.storage.local.set({ pushChannel: nextChannel });
    return nextChannel;
  }
})();
