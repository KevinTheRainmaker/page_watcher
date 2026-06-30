const http = require("http");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const webpush = require("web-push");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_PATH = path.join(DATA_DIR, "data.json");

const data = loadData();
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "https://example.com/page-watcher",
  data.vapid.publicKey,
  data.vapid.privateKey
);
saveData(data);

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendJson(response, 500, { ok: false, error: "internal-error" });
  }
});

server.listen(PORT, () => {
  console.log(`Page Watcher push server listening on http://localhost:${PORT}`);
  console.log("Use an HTTPS public URL for mobile browser registration.");
});

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/vapid-public-key") {
    return sendJson(response, 200, { publicKey: data.vapid.publicKey });
  }

  if (request.method === "GET" && url.pathname === "/qr") {
    const text = url.searchParams.get("text") || "";
    if (!text) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("missing text");
      return;
    }
    const png = await qrcode.toBuffer(text, { margin: 1, width: 240 });
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    response.end(png);
    return;
  }

  if (request.method === "POST" && url.pathname === "/subscribe") {
    const body = await readJson(request);
    const channel = normalizeChannel(body.channel);
    if (!isValidChannel(channel) || !body.subscription) {
      return sendJson(response, 400, { ok: false, error: "bad-request" });
    }
    data.subscriptions[channel] ||= [];
    const endpoint = body.subscription.endpoint;
    data.subscriptions[channel] = data.subscriptions[channel].filter(
      (item) => item.endpoint !== endpoint
    );
    data.subscriptions[channel].push(body.subscription);
    saveData(data);
    return sendJson(response, 200, { ok: true, count: data.subscriptions[channel].length });
  }

  if (request.method === "POST" && url.pathname === "/notify") {
    const body = await readJson(request);
    const channel = normalizeChannel(body.channel);
    if (!isValidChannel(channel)) {
      return sendJson(response, 400, { ok: false, error: "bad-channel" });
    }
    const subscriptions = data.subscriptions[channel] || [];
    const payload = JSON.stringify({
      title: body.title || "Page Watcher",
      message: body.message || "감시 영역 변경이 감지되었습니다.",
      labels: Array.isArray(body.labels) ? body.labels.slice(0, 20) : [],
      pageUrl: body.pageUrl || ""
    });
    const results = await Promise.allSettled(
      subscriptions.map((subscription) => webpush.sendNotification(subscription, payload))
    );
    data.subscriptions[channel] = subscriptions.filter((subscription, index) => {
      const result = results[index];
      const statusCode = result.status === "rejected" ? result.reason?.statusCode : 200;
      return statusCode !== 404 && statusCode !== 410;
    });
    saveData(data);
    return sendJson(response, 200, {
      ok: true,
      sent: results.filter((result) => result.status === "fulfilled").length,
      failed: results.filter((result) => result.status === "rejected").length
    });
  }

  const channelDeleteMatch = url.pathname.match(/^\/channel\/([-_A-Za-z0-9]{8,80})$/);
  if (request.method === "DELETE" && channelDeleteMatch) {
    const channel = channelDeleteMatch[1];
    const removed = data.subscriptions[channel]?.length || 0;
    delete data.subscriptions[channel];
    saveData(data);
    return sendJson(response, 200, { ok: true, removed });
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  return serveStatic(url.pathname, response);
}

function serveStatic(urlPath, response) {
  const relativePath = urlPath === "/" ? "/register.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const contentType = filePath.endsWith(".js")
    ? "application/javascript; charset=utf-8"
    : "text/html; charset=utf-8";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(response);
}

function loadData() {
  if (fs.existsSync(DATA_PATH)) {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  }
  return {
    vapid: webpush.generateVAPIDKeys(),
    subscriptions: {}
  };
}

function saveData(nextData) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(nextData, null, 2));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders()
  });
  response.end(JSON.stringify(body));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function normalizeChannel(channel) {
  return String(channel || "").trim();
}

function isValidChannel(channel) {
  return /^[-_A-Za-z0-9]{8,80}$/.test(channel);
}
