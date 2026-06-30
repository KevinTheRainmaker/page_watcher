(() => {
  if (window.ZeusGradeWatcher?.handleCommand) {
    return;
  }

  const SESSION_REFRESH_ENDPOINT = "/sys/main/refreshSessionTime.do";
  const GRADE_ENDPOINT = "/ugd/ugdCptnMrksQ/select.do";
  const PG_KEY = "PERS01^PERS01_03^002^UgdShtmMrksQ";
  const RS = "\x1e";
  const US = "\x1f";

  window.ZeusGradeWatcherContent = true;
  window.ZeusGradeWatcher = {
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

  function pad(value) {
    return String(value).padStart(2, "0");
  }
})();
