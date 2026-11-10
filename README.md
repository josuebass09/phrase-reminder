# Phrase Reminder

Save English phrases from your phone or computer. Each day at 12:00 Costa Rica time, get a push notification with 3 phrases that are at least 14 days old. Tapping it opens the app, where the Today section shows those phrases in full.

This repository is the API and the daily reminder job. The app people use lives in [phrase-reminder-app](https://github.com/josuebass09/phrase-reminder-app). Each user has their own phrases and devices, and logs in with an email and password.

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
3. Create a user with `npm run users -- add you@example.com`.
4. Run `npm run dev`. The API listens on http://localhost:3000.
5. Run the app against it, as its README describes.

## Deploy to Railway

Railway deploys from this repository, so push it to GitHub first. All settings below go in the Railway dashboard.

1. Generate the push keys once with `npx web-push generate-vapid-keys`, and keep the same pair afterward. Changing them breaks every device's subscription.
2. Create a Railway project and add a **Postgres** database.
3. Add a **web service** from this repository:
   - Build command: `npm run build`
   - Start command: `npm start`
   - Variables: `DATABASE_URL` (reference the Postgres service), `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, and `APP_ORIGIN` once the app has a domain
   - Generate a public domain under Networking.
4. Add a **cron service** from the same repository:
   - Build command: `npm run build`
   - Start command: `npm run send-daily`
   - Cron schedule: `0 18 * * *`
   - Variables: `DATABASE_URL` (reference the Postgres service), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

Generate `SESSION_SECRET` with `openssl rand -base64 32`. It signs the access tokens, must be at least 32 characters, and changing it logs out every device.

Then create the users, as described below. Set `VAPID_SUBJECT` to a contact address with no spaces, such as `mailto:you@example.com`.

### The schedule

Railway cron schedules run in UTC. Costa Rica is UTC-6 all year, so `0 18 * * *` means 12:00 there. If you change the time, also change the `12:00` labels in the app.

## Users

There is no sign-up page: you create users from a terminal. To manage the users on Railway, set `DATABASE_URL` in `.env` to the public connection URL of the Railway database first.

```bash
npm run users -- add you@example.com            # Asks for the password twice
npm run users -- set-password you@example.com   # Asks for the new one
npm run users -- list                           # Each user with their phrase and device counts
```

Passwords need 12 to 200 characters and are stored as scrypt hashes. Emails are case-insensitive.

The first user you create gets the phrases and devices saved before accounts existed. Until then, the API shows them to nobody and the reminder job skips them.

Logging in gives an access token that lasts 12 hours, then the app asks to log in again. Changing a password doesn't end sessions already open; they last until their token expires. To end every session at once, change `SESSION_SECRET`.

## API for the app

The app lives in its own repository and domain. Two `*.up.railway.app` domains count as different sites, so browsers don't share cookies between them, and the app sends an access token instead. Set `APP_ORIGIN` to the app's URL so the browser lets it call the API.

| Request | Token | Response |
|---|---|---|
| `GET /api/config` | No | `{ vapidPublicKey }` |
| `POST /api/login` with `{ email, password }` | No | `{ token, expiresAt, expiresIn, user }`, 401 for a wrong email or password, or 400 if one is missing |
| `GET /api/me` | Yes | `{ id, email }` |
| `GET /api/phrases` | Yes | The user's 50 newest phrases |
| `GET /api/today` | Yes | The phrases from the user's latest reminder |
| `POST /api/phrases` with `{ text }` | Yes | The saved phrase, 201 |
| `PATCH /api/phrases/:id` with `{ text }` | Yes | The updated phrase, or 404 |
| `DELETE /api/phrases/:id` | Yes | 204, or 404 |
| `POST /api/push/subscribe` with a `PushSubscription` | Yes | 204 |

Send the token as `Authorization: Bearer <token>`. It's a JWT signed with `SESSION_SECRET`, and `expiresIn` is its lifetime in seconds (43200). Without a valid token, these requests get a 401. Phrases look like `{ id, text, createdAt }`. Another user's phrase gets the same 404 as a missing one.

## Import your current file

Put one phrase per line in a text file, set `DATABASE_URL` in `.env` to the public connection URL of the Railway database, and run it for an existing user:

```bash
npm run import -- you@example.com path/to/phrases.txt
```

Imported phrases count as 14 days old, so reminders can start the next day. Running the import again skips that user's exact duplicates.

## Turn on reminders on each device

Each device subscribes separately, and gets the reminders of the user logged in when it did. If someone else logs in on that device later, it moves to them. Reminders only reach devices where this happened:

- **iPhone or iPad (iOS 16.4 or later):** open the app's URL in Safari, use **Add to Home Screen**, open the app from that icon, then tap **Turn on**. Apple doesn't offer push in a regular Safari tab.
- **Android:** open the URL in Chrome and tap **Turn on**. Add it to the Home Screen for the full-screen app.
- **Computer:** open the URL in your browser and tap **Turn on**. The browser generally has to be running to show the notification.

To turn reminders off, block notifications for the app in your device settings.
