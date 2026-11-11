# Phrase Reminder

Save English phrases from your phone or computer. Each day, at the time you pick in the app's settings, get a push notification with phrases that are at least 14 days old (3 by default, at 12:00 Costa Rica time). Tapping it opens the app, where the Today section shows those phrases in full.

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
   - Variables: `DATABASE_URL` (reference the Postgres service), `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `APP_ORIGIN` once the app has a domain, and optionally `MYMEMORY_EMAIL` (see Translations) and `GROQ_API_KEY` (see Suggestions)
   - Generate a public domain under Networking.
4. Add a **cron service** from the same repository:
   - Build command: `npm run build`
   - Start command: `npm run send-daily`
   - Cron schedule: `*/15 * * * *`
   - Variables: `DATABASE_URL` (reference the Postgres service), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

Generate `SESSION_SECRET` with `openssl rand -base64 32`. It signs the access tokens, must be at least 32 characters, and changing it logs out every device.

Then create the users, as described below. Set `VAPID_SUBJECT` to a contact address with no spaces, such as `mailto:you@example.com`.

### The schedule

Each user picks their reminder in the app's Settings: on or paused, the time, and 1 to 5 phrases. The time zone comes from their device. New users start at 12:00 Costa Rica time with 3 phrases.

The cron service runs every 15 minutes and sends each user's reminder once per local day, at the first run at or after their time, so it arrives within 15 minutes of it. If runs are missed, the next run within 3 hours still sends it; after that, the day is skipped. A reminder counts as sent once any of the user's devices received it, so a failed run is retried by the next one. Each run that finds nothing due logs `No reminders due`.

The notification greets for the user's local time and says how many phrases there are, such as "☀️ Good afternoon! 3 phrases for today" (🌅 Good morning from 5:00, ☀️ Good afternoon from 12:00, 🌙 Good evening from 18:00), with one bulleted phrase per line. Long phrases are shortened so the notification stays within the push size limit.

## Users

The first user is the admin. In the app, the admin opens the account sheet (the person icon) and taps **Invite someone** to get an invite link. Each link creates one account and expires after 7 days. Opening it shows the app's sign-up form with the code filled in, and the new account is a regular user. The database keeps only a hash of each code, so the link can't be shown again later; create a new one instead.

If the admin account is deleted, the oldest remaining user becomes the admin, and the invites it made stop working.

You can also manage users from a terminal. To do it on Railway, set `DATABASE_URL` in `.env` to the public connection URL of the Railway database first.

```bash
npm run users -- add you@example.com            # Asks for the password twice
npm run users -- set-password you@example.com   # Asks for the new one
npm run users -- list                           # Each user with their phrase and device counts
```

Passwords need 12 to 200 characters and are stored as scrypt hashes. Emails are case-insensitive.

The first user gets the phrases and devices saved before accounts existed. Until then, the API shows them to nobody and the reminder job skips them.

Logging in gives an access token that lasts 12 hours, then the app asks to log in again. Changing a password doesn't end sessions already open; they last until their token expires. To end every session at once, change `SESSION_SECRET`.

## API for the app

The app lives in its own repository and domain. Two `*.up.railway.app` domains count as different sites, so browsers don't share cookies between them, and the app sends an access token instead. Set `APP_ORIGIN` to the app's URL so the browser lets it call the API.

| Request | Token | Response |
|---|---|---|
| `GET /api/config` | No | `{ vapidPublicKey }` |
| `POST /api/login` with `{ email, password }` | No | `{ token, expiresAt, expiresIn, user }`, 401 for a wrong email or password, or 400 if one is missing |
| `POST /api/signup` with `{ email, password, code }` | No | The same as a login, 201. 403 if the invite is unknown, used, or expired, 409 if the email has an account, 400 for an invalid email or password |
| `POST /api/invites` | Admin | `{ code, expiresAt }`, 201. 403 for other users |
| `GET /api/me` | Yes | `{ id, email, isAdmin }` |
| `GET /api/settings` | Yes | `{ remindersOn, reminderTime, timeZone, phrasesPerDay }` |
| `PATCH /api/settings` with any of those | Yes | All the settings after the change, or 400 with what's wrong. `reminderTime` is 24-hour `HH:MM`, `timeZone` an IANA zone such as `America/Costa_Rica`, and `phrasesPerDay` 1 to 5 |
| `GET /api/phrases` | Yes | The user's 50 newest phrases |
| `GET /api/today` | Yes | The phrases from the user's latest reminder |
| `POST /api/phrases` with `{ text }`, and optionally `translation` | Yes | The saved phrase, 201. A `translation` (Spanish, up to 1,000 characters) is saved as the phrase's translation |
| `PATCH /api/phrases/:id` with `{ text }` | Yes | The updated phrase, or 404 |
| `DELETE /api/phrases/:id` | Yes | 204, or 404 |
| `GET /api/phrases/:id/translation` | Yes | `{ translation }` in Spanish, or 404. 429 once the user's new translations for the day are used up, and 502 if the translation service fails |
| `POST /api/suggestions` with `{ text }`, and optionally `context` | Yes | `{ formal, informal }`, each `{ text, es }`: two ways to say the text in English, with their Spanish. `context` (up to 300 characters) says who it's for, where, or what it's about, so the options fit. Saves nothing. 429 once the user's suggestions for the day are used up, 502 if the AI fails, 503 without `GROQ_API_KEY` |
| `GET /api/usage` | Yes | `{ translations, suggestions }`, each `{ used, limit }`: what the user has used today, and the daily limit (`null` for the admin) |
| `POST /api/push/subscribe` with a `PushSubscription` | Yes | 204 |

Send the token as `Authorization: Bearer <token>`. It's a JWT signed with `SESSION_SECRET`, and `expiresIn` is its lifetime in seconds (43200). Without a valid token, these requests get a 401. Phrases look like `{ id, text, createdAt }`. Another user's phrase gets the same 404 as a missing one.

## Translations

The app can show each phrase in Spanish. The backend asks [MyMemory](https://mymemory.translated.net/), a free translation API that needs no key or account, the first time someone asks for a phrase, and saves the result with the phrase. Later requests come from the database, and editing the phrase's text drops the saved translation.

MyMemory's free limit is about 5,000 characters a day per server. Set `MYMEMORY_EMAIL` on the web service to a contact email to raise it to about 50,000. When the limit runs out, the app says it couldn't translate, and the phrase can be translated the next day.

So one person can't use up that shared limit, each user may ask for 30 new translations a day, counted on their local day from their settings' time zone. Opening a saved translation doesn't count, a failed translation is given back, and the admin has no limit (their translations are still counted). Set `TRANSLATIONS_PER_DAY` on the web service to change the 30. With 20 users of about 55-character phrases, 30 each comes to at most about 33,000 characters a day, within the 50,000 with room to spare. Settings in the app shows each user how many they've used today.

## Suggestions

The app's Get options button takes a new phrase the user wants to say, in Spanish or English, and shows a formal and an informal way to say it in English, each with its Spanish. An optional context, such as "Slack message to my manager about a late deploy", helps the AI fit the words and tone to the situation. Saving one adds it as a phrase with that Spanish as its translation, so translating it later is free.

The backend asks `openai/gpt-oss-120b` on [Groq](https://console.groq.com/), whose free plan needs no card. Create a key under API Keys and set it as `GROQ_API_KEY` on the web service; `GROQ_MODEL` picks another model. The free plan allows about 1,000 requests a day and 30 a minute for the whole account (see [rate limits](https://console.groq.com/docs/rate-limits)), so each user may ask for 20 suggestions a day, counted like translations: on their local day, a failed answer is given back, and the admin has no limit. Set `SUGGESTIONS_PER_DAY` to change the 20. With 20 users, that's at most 400 requests a day. What users type is sent to Groq.

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
