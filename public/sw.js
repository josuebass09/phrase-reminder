self.addEventListener('push', (event) => {
  // Every push must show a notification: browsers can revoke access otherwise.
  const { title = 'Your phrases for today', body = '' } = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      tag: 'daily-phrases',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const [existing] = windows;
      return existing ? existing.focus() : self.clients.openWindow('/');
    }),
  );
});
