import { MAX_PHRASE_LENGTH, type Phrase } from './db.js';

export type Platform = 'ios' | 'android';

const TONE_COUNT = 6; // Keep in sync with the .tone-* classes in public/app.css and public/app.js.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icon(paths: string): string {
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const icons = {
  book: icon('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  bell: icon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  pen: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  clock: icon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  history: icon('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'),
  message: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  save: icon('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/><path d="M12 7v6"/><path d="M15 10H9"/>'),
  check: icon('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
};

function htmlPage(platform: Platform, script: string, body: string): string {
  return `<!doctype html>
<html lang="en" data-platform="${platform}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>Phrases</title>
<meta name="theme-color" content="#0E5E6F">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Phrases">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/app.css">
${script}
</head>
<body>
${body}
</body>
</html>`;
}

function brand(): string {
  return `<div class="brand">
        <span class="brand-mark" aria-hidden="true">${icons.book}</span>
        <h1>Phrases</h1>
      </div>`;
}

function phraseRow(phrase: Phrase): string {
  const iso = phrase.createdAt.toISOString();
  return `<li class="row tone-${phrase.id % TONE_COUNT}"><span class="tile" aria-hidden="true">${icons.message}</span><div class="row-body"><span class="row-text">${escapeHtml(phrase.text)}</span><time class="when" datetime="${iso}">Saved ${iso.slice(0, 10)}</time></div></li>`;
}

export interface AppPage {
  platform: Platform;
  recent: Phrase[];
  today: Phrase[];
  vapidPublicKey: string;
}

export function renderApp({ platform, recent, today, vapidPublicKey }: AppPage): string {
  return htmlPage(
    platform,
    '<script src="/app.js" defer></script>',
    `<div class="app">
  <div class="top">
    <header class="bar">
      ${brand()}
      <button id="reminders" class="pill" type="button" data-vapid-key="${escapeHtml(vapidPublicKey)}" hidden>${icons.bell}<span></span></button>
    </header>
    <form id="phrase-form" class="composer">
      <div class="field">
        <label for="phrase">${icons.pen}<span>New phrase</span></label>
        <textarea id="phrase" maxlength="${MAX_PHRASE_LENGTH}" placeholder="Type an English phrase"></textarea>
      </div>
      <p class="hint">${icons.clock}<span>Comes back in your reminders after 14 days.</span></p>
    </form>
  </div>
  <main class="content">
    <section id="today" class="group"${today.length === 0 ? ' hidden' : ''}>
      <h2>${icons.sun}<span>Today</span></h2>
      <ul id="today-phrases" class="phrases">${today.map(phraseRow).join('')}</ul>
    </section>
    <section class="group">
      <h2>${icons.history}<span>Recent</span></h2>
      <ul id="phrases" class="phrases">${recent.map(phraseRow).join('')}</ul>
      <p class="empty">Your saved phrases will appear here.</p>
    </section>
  </main>
  <div class="actions">
    <button id="save" class="primary" type="submit" form="phrase-form" disabled>${icons.save}<span>Save</span></button>
  </div>
  <div class="toast-region" role="status" aria-live="polite">
    <div id="toast" class="toast" hidden>${icons.check}<span></span></div>
  </div>
</div>
<template id="phrase-row"><li class="row"><span class="tile" aria-hidden="true">${icons.message}</span><div class="row-body"><span class="row-text"></span><time class="when"></time></div></li></template>`,
  );
}

export function renderLogin(platform: Platform, error?: string): string {
  const message = error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : '';
  return htmlPage(
    platform,
    '',
    `<div class="app login">
  <div class="top">
    <header class="bar">
      ${brand()}
    </header>
  </div>
  <main class="login-body">
    <form method="post" action="/login" class="login-form">
      <div class="field">
        <label for="password"><span>Password</span></label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      </div>
      ${message}
      <button class="primary" type="submit"><span>Log in</span></button>
    </form>
  </main>
</div>`,
  );
}
