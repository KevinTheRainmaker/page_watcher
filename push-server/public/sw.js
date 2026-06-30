self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const labels = Array.isArray(data.labels) && data.labels.length > 0
    ? `\n${data.labels.slice(0, 5).join(", ")}`
    : "";
  event.waitUntil(
    self.registration.showNotification(data.title || "Page Watcher", {
      body: `${data.message || "감시 영역 변경이 감지되었습니다."}${labels}`,
      data: {
        pageUrl: data.pageUrl || ""
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const pageUrl = event.notification.data?.pageUrl;
  if (pageUrl) {
    event.waitUntil(clients.openWindow(pageUrl));
  }
});
