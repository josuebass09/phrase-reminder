# Phrase Reminder

Save English phrases from your phone or computer. Each day at 12:00 Costa Rica time, get a push notification with 3 phrases that are at least 14 days old. Tapping it opens the app, where the Today section shows those phrases in full.

The design and scope are in [docs/ideas/phrase-reminder.md](docs/ideas/phrase-reminder.md).

## Run the tests

```bash
npm install
npm test
npm run typecheck
npm run build
```

The tests run on an in-process Postgres engine, so they need no database or accounts. They use a fake push sender, so real delivery has to be checked on a device.

## Run locally

1. Copy `.env.example` to `.env`.
2. Generate the push keys with `npx web-push generate-vapid-keys` and fill in the variables.
3. Run `npm run dev`.
4. Open http://localhost:3000.

## Deploy to Railway

Railway deploys from this repository, so push it to GitHub first. All settings below go in the Railway dashboard.

1. Generate the push keys once with `npx web-push generate-vapid-keys`, and keep the same pair afterward. Changing them breaks every device's subscription.
2. Create a Railway project and add a **Postgres** database.
3. Add a **web service** from this repository:
   - Build command: `npm run build`
   - Start command: `npm start`
   - Variables: `DATABASE_URL` (reference the Postgres service), `APP_PASSWORD`, `SESSION_SECRET`, `VAPID_PUBLIC_KEY`
   - Generate a public domain under Networking.
4. Add a **cron service** from the same repository:
   - Build command: `npm run build`
   - Start command: `npm run send-daily`
   - Cron schedule: `0 18 * * *`
   - Variables: `DATABASE_URL` (reference the Postgres service), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

Generate `APP_PASSWORD` and `SESSION_SECRET` with `openssl rand -base64 32`. Set `VAPID_SUBJECT` to a contact address with no spaces, such as `mailto:you@example.com`.

### The schedule

Railway cron schedules run in UTC. Costa Rica is UTC-6 all year, so `0 18 * * *` means 12:00 there. If you change the time, also change the `12:00` labels in `public/app.js`.

## Import your current file

Put one phrase per line in a text file, set `DATABASE_URL` in `.env` to the public connection URL of the Railway database, and run:

```bash
npm run import -- path/to/phrases.txt
```

Imported phrases count as 14 days old, so reminders can start the next day. Running the import again skips exact duplicates.

## Turn on reminders on each device

Each device subscribes separately. Reminders only reach devices where you did this:

- **iPhone or iPad (iOS 16.4 or later):** open the app's URL in Safari, use **Add to Home Screen**, open the app from that icon, then tap **Turn on**. Apple doesn't offer push in a regular Safari tab.
- **Android:** open the URL in Chrome and tap **Turn on**. Add it to the Home Screen for the full-screen app.
- **Computer:** open the URL in your browser and tap **Turn on**. The browser generally has to be running to show the notification.

To turn reminders off, block notifications for the app in your device settings.
