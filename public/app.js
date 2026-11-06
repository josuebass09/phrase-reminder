const TONE_COUNT = 6; // Keep in sync with src/page.ts and the .tone-* classes in app.css.

const app = document.querySelector('.app');
const form = document.getElementById('phrase-form');
const textarea = document.getElementById('phrase');
const save = document.getElementById('save');
const list = document.getElementById('phrases');
const template = document.getElementById('phrase-row');
const toast = document.getElementById('toast');
const toastText = toast.querySelector('span');
const todaySection = document.getElementById('today');
const todayList = document.getElementById('today-phrases');
const reminders = document.getElementById('reminders');
const remindersLabel = reminders.querySelector('span');

// iOS only exposes push to web apps opened from the Home Screen.
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let saving = false;
let toastTimer;
let remindersOn = false;

function savedLabel(iso) {
  const saved = new Date(iso);
  const now = new Date();
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(saved)) / 86_400_000);
  if (days <= 0) return 'Saved today';
  if (days === 1) return 'Saved yesterday';
  const options = { month: 'short', day: 'numeric' };
  if (saved.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return `Saved ${new Intl.DateTimeFormat('en-US', options).format(saved)}`;
}

function buildRow(phrase) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.classList.add(`tone-${phrase.id % TONE_COUNT}`);
  row.querySelector('.row-text').textContent = phrase.text;
  const when = row.querySelector('.when');
  when.dateTime = phrase.createdAt;
  when.textContent = savedLabel(phrase.createdAt);
  return row;
}

function showToast(message, isError = false) {
  toastText.textContent = message;
  toast.classList.toggle('toast-error', isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2500);
}

function updateSaveButton() {
  save.disabled = saving || !textarea.value.trim();
}

async function savePhrase(text) {
  const response = await fetch('/api/phrases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (response.status === 401) {
    window.location.href = '/login';
    return null;
  }
  if (!response.ok) throw new Error(`Save failed with status ${response.status}`);
  return response.json();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = textarea.value.trim();
  if (!text || saving) return;

  saving = true;
  updateSaveButton();
  try {
    const phrase = await savePhrase(text);
    if (phrase) {
      const row = buildRow(phrase);
      list.prepend(row);
      row.scrollIntoView({ block: 'nearest' });
      textarea.value = '';
      showToast('Phrase saved');
    }
  } catch {
    showToast("Couldn't save. Your text is still here.", true);
  } finally {
    saving = false;
    updateSaveButton();
  }
});

textarea.addEventListener('input', updateSaveButton);

// A phone can keep this page open for days, so tapping a notification may bring
// back an old copy. Refresh Today on return without touching any typed text.
async function refreshToday() {
  try {
    const response = await fetch('/api/today', { cache: 'no-store' });
    if (!response.ok) return;
    const phrases = await response.json();
    todayList.replaceChildren(...phrases.map((phrase) => buildRow(phrase)));
    todaySection.hidden = phrases.length === 0;
  } catch {
    // Offline: keep what's on screen.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshToday();
});

function showReminderState(isOn) {
  remindersOn = isOn;
  remindersLabel.textContent = isOn ? '12:00' : 'Turn on';
  reminders.classList.toggle('pill-off', !isOn);
  reminders.setAttribute('aria-label', isOn ? 'Daily reminder on at 12:00' : 'Turn on daily reminder');
  reminders.hidden = false;
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function saveSubscription(subscription) {
  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });
  if (!response.ok) throw new Error(`Subscribe failed with status ${response.status}`);
}

async function turnOnReminders() {
  if (!pushSupported) {
    showToast('Add this app to your Home Screen to turn on reminders.', true);
    return;
  }
  try {
    // iOS requires this call to come directly from the tap, so it runs first.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notifications are blocked. Allow them in your settings.', true);
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(reminders.dataset.vapidKey),
    });
    await saveSubscription(subscription);
    showReminderState(true);
    showToast('Reminders on');
  } catch {
    showToast("Couldn't turn on reminders. Try again.", true);
  }
}

reminders.addEventListener('click', () => {
  if (remindersOn) {
    showToast('Reminders are on for 12:00 every day.');
  } else {
    turnOnReminders();
  }
});

async function initReminders() {
  if (!pushSupported) {
    showReminderState(false);
    return;
  }
  try {
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    // Saving again on each visit keeps the server current if the browser rotated it.
    if (subscription) await saveSubscription(subscription);
    showReminderState(Boolean(subscription));
  } catch {
    showReminderState(false);
  }
}

initReminders();

for (const when of document.querySelectorAll('.when[datetime]')) {
  when.textContent = savedLabel(when.dateTime);
}

// Keep the Save button above the on-screen keyboard. iOS Safari doesn't resize
// the layout when the keyboard opens, so follow the visual viewport instead.
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const fitToViewport = () => {
    if (viewport.scale !== 1) return;
    app.style.height = `${viewport.height}px`;
    window.scrollTo(0, 0);
  };
  viewport.addEventListener('resize', fitToViewport);
  fitToViewport();
}

updateSaveButton();
