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
   - Variables: `DATABASE_URL` (reference the Postgres service), `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `APP_ORIGIN` once the app has a domain, and optionally `MYMEMORY_EMAIL` (see Translations) and `GROQ_API_KEY` (see Suggestions and Pronunciation)
   - Generate a public domain under Networking.
4. Add a **cron service** from the same repository:
   - Build command: `npm run build`
   - Start command: `npm run send-daily`
   - Cron schedule: `*/15 * * * *`
   - Variables: `DATABASE_URL` (reference the Postgres service), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

Generate `SESSION_SECRET` with `openssl rand -base64 32`. It signs the access tokens and must be at least 32 characters. Changing it doesn't log anyone out, since the app renews its tokens; to do that, see Users.

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
npm run users -- log-out you@example.com        # Logs them out of every device
npm run users -- log-out --all                  # Logs everyone out
npm run users -- stats                          # Each user's activity by week (see Activity)
```

Passwords need 12 to 200 characters and are stored as scrypt hashes. Emails are case-insensitive.

The first user gets the phrases and devices saved before accounts existed. Until then, the API shows them to nobody and the reminder job skips them.

Logging in opens a session, which lasts while the app keeps using it: the app stays logged in until 60 days pass without it opening, or the person logs out. The app holds two tokens for it. The access token lasts an hour and names the session, which must still be open, so logging out ends it at once. The refresh token gets the app a new pair, and each use replaces it with a new one; the database keeps only a hash of it. If a refresh token that was already replaced comes back more than a minute later, someone may have a copy, so that session ends. Within the minute it's more likely two of the app's windows renewing at once, and the session stays.

Changing a password logs that user out of every device, in case someone else knew the old one. In the app, Settings can log the person out of this device or of every device.

## API for the app

The app lives in its own repository and domain. Two `*.up.railway.app` domains count as different sites, so browsers don't share cookies between them, and the app sends an access token instead. Set `APP_ORIGIN` to the app's URL so the browser lets it call the API.

| Request | Token | Response |
|---|---|---|
| `GET /api/config` | No | `{ vapidPublicKey }` |
| `POST /api/login` with `{ email, password }` | No | `{ token, expiresAt, expiresIn, refreshToken, user }`, 401 for a wrong email or password, or 400 if one is missing |
| `POST /api/signup` with `{ email, password, code }` | No | The same as a login, 201. 403 if the invite is unknown, used, or expired, 409 if the email has an account, 400 for an invalid email or password |
| `POST /api/session/refresh` with `{ refreshToken }` | No | The same as a login, with a new refresh token in place of that one. 401 if the session is over: it ran out, was logged out, or that token was already used |
| `POST /api/logout` with `{ refreshToken }` | No | 204, and that session ends. It needs no access token, so it works after that one ran out |
| `DELETE /api/sessions` | Yes | 204, and every one of the user's sessions ends, this one included |
| `POST /api/invites` | Admin | `{ code, expiresAt }`, 201. 403 for other users |
| `GET /api/me` | Yes | `{ id, email, isAdmin }` |
| `GET /api/settings` | Yes | `{ remindersOn, reminderTime, timeZone, phrasesPerDay, language }`; `language` is `null` until the app saves one |
| `PATCH /api/settings` with any of those | Yes | All the settings after the change, or 400 with what's wrong. `reminderTime` is 24-hour `HH:MM`, `timeZone` an IANA zone such as `America/Costa_Rica`, `phrasesPerDay` 1 to 5, and `language` `en` or `es` |
| `GET /api/phrases`, optionally with `?q=` and `?before=` | Yes | The user's 50 newest phrases. `q` (up to 100 characters) keeps only those whose text or Spanish has it, ignoring case, and `before`, a phrase's id, gives the 50 after that one |
| `GET /api/today` | Yes | The phrases from the user's latest reminder |
| `POST /api/phrases` with `{ text }`, and optionally `translation` | Yes | The saved phrase, 201. A `translation` (Spanish, up to 1,000 characters) is saved as the phrase's translation |
| `PATCH /api/phrases/:id` with `{ text }` | Yes | The updated phrase, or 404 |
| `DELETE /api/phrases/:id` | Yes | 204, or 404 |
| `GET /api/phrases/:id/translation` | Yes | `{ translation }` in Spanish, or 404. 429 once the user's new translations for the day are used up, and 502 if the translation service fails |
| `POST /api/suggestions` with `{ text }`, and optionally `context` | Yes | `{ formal, informal }`, each `{ text }`: two ways to say the text in English. `context` (up to 300 characters) says who it's for, where, or what it's about, so the options fit. Saves nothing. 429 once the user's suggestions for the day are used up, 502 if the AI fails, 503 without `GROQ_API_KEY` |
| `POST /api/phrases/:id/pronunciation` with a recording as the body, and its type, such as `audio/webm`, as `Content-Type` | Yes | `{ score, words, heard, tip }`: the score from 1 to 10, the phrase's words as `{ text, ok }`, what was heard, and a tip in the user's language. The score is saved as the phrase's `lastScore`. 400 for a body that isn't audio Groq reads, 413 over 1 MB, 422 if nobody spoke, 429 once the user's scores for the day are used up, 502 if Groq fails, 503 without `GROQ_API_KEY` |
| `GET /api/usage` | Yes | `{ translations, suggestions, pronunciations }`, each `{ used, limit }`: what the user has used today, and the daily limit (`null` for the admin) |
| `POST /api/activity` with `{ kind }`, and `phraseId` for a phrase kind | Yes | 204, once recorded (see Activity). 400 for an unknown kind, or a phrase with a kind that has none, and 404 for a phrase that isn't the user's |
| `POST /api/push/subscribe` with a `PushSubscription` | Yes | 204 |

Send the token as `Authorization: Bearer <token>`. It's a JWT signed with `SESSION_SECRET`, and `expiresIn` is its lifetime in seconds (3600). Without a valid token, these requests get a 401. Phrases look like `{ id, text, createdAt, translation, lastScore }`, where `translation` is the saved Spanish, or `null` until someone asks for it, and `lastScore` is the score of the last time the user said it aloud, or `null`. Another user's phrase gets the same 404 as a missing one.

## Translations

The app can show each phrase in Spanish. The backend asks [MyMemory](https://mymemory.translated.net/), a free translation API that needs no key or account, the first time someone asks for a phrase, and saves the result with the phrase. Later requests come from the database, and editing the phrase's text drops the saved translation.

MyMemory's free limit is about 5,000 characters a day per server. Set `MYMEMORY_EMAIL` on the web service to a contact email to raise it to about 50,000. When the limit runs out, the app says it couldn't translate, and the phrase can be translated the next day.

So one person can't use up that shared limit, each user may ask for 30 new translations a day, counted on their local day from their settings' time zone. Opening a saved translation doesn't count, a failed translation is given back, and the admin has no limit (their translations are still counted). Set `TRANSLATIONS_PER_DAY` on the web service to change the 30. With 20 users of about 55-character phrases, 30 each comes to at most about 33,000 characters a day, within the 50,000 with room to spare. Settings in the app shows each user how many they've used today.

## Languages

The app speaks English or Spanish, and each user's choice is saved as `language` in their settings. The daily notification uses it, such as "☀️ ¡Buenas tardes! 3 frases para hoy". The app also sends it as `Accept-Language`, and the API writes its messages for people in that language, such as today's limit or a used invite; anything else gets English.

## Suggestions

The app's Translate button takes a new phrase the user wants to say, in Spanish or English, and shows a formal and an informal way to say it, in English only. An optional context, such as "Slack message to my manager about a late deploy", helps the AI fit the words and tone to the situation. Saving one adds it as a phrase, which translates to Spanish like any other.

The backend asks `openai/gpt-oss-120b` on [Groq](https://console.groq.com/), whose free plan needs no card. Create a key under API Keys and set it as `GROQ_API_KEY` on the web service; `GROQ_MODEL` picks another model. The free plan allows about 1,000 requests a day and 30 a minute for the whole account (see [rate limits](https://console.groq.com/docs/rate-limits)), so each user may ask for 20 suggestions a day, counted like translations: on their local day, a failed answer is given back, and the admin has no limit. Set `SUGGESTIONS_PER_DAY` to change the 20. With 20 users, that's at most 400 requests a day. What users type is sent to Groq.

## Pronunciation

The app's microphone button records the user saying a phrase, and the backend scores it from 1 to 10. Groq's `whisper-large-v3-turbo` writes down what it heard, without being told the phrase, so it can't fill in what was expected. The score is mostly the share of the phrase's words it heard, lined up so one missed word doesn't throw off the rest, and partly how sure Whisper was. Every word heard and clear gives a 10, every word heard but unclear a 7, and a word missed or heard as another marks it in the phrase. Words heard that aren't in the phrase lower the score too. Case, punctuation, and numbers written as digits or words don't count.

Whisper is built to understand accents, so the score says how clearly the phrase came through more than how native it sounded. Homophones, such as "their" and "there", can count as missed. The weights are a first guess, in `src/pronounce.ts`, to tune with real recordings.

When words were missed, the chat model from Suggestions writes one tip from the difference, such as a short "i" heard as a long "ee"; it never hears the audio. Otherwise the tip is a fixed one, so it costs no request. If the tip fails, the score still comes back with a general tip.

The score is saved with the phrase, and editing the text drops it. The recording is passed on to Groq and never kept. Each user may get 20 scores a day, counted like suggestions: on their local day, a failed one or one with nobody speaking is given back, and the admin has no limit. Set `PRONUNCIATIONS_PER_DAY` to change the 20, and `GROQ_TRANSCRIPTION_MODEL` to use another speech model. Each score takes one speech request, and a chat request when words were missed, from the same free plan as suggestions; with 20 users at 20 a day of each, the chat requests stay under its 1,000 a day.

## Activity

To tell whether the reminders help, as `docs/ideas/phrase-reminder.md` asks, the backend records what each user did on each of their local days: that a reminder reached a device, and that the user opened the app from it, looked at Today, or heard, translated, or said aloud a phrase. Each counts once a day, or once a day per phrase, however often it happens, so the table stays small. It keeps the day and the phrase's id, never its text or a recording, and it goes when the user's account does.

The backend records reminders sent and phrases said aloud itself. The app reports the rest with `POST /api/activity`, where `kind` is `reminder_opened` or `today_viewed`, or `phrase_heard` or `phrase_translated` with the phrase's id.

`npm run users -- stats` shows each user's last 4 weeks, from Monday, one line a week: the days a reminder reached a device, the days the user opened the app from it, the days they looked at Today, and how many different phrases they practiced. Add a number for more weeks, up to 52, such as `npm run users -- stats 12`. The notification shows the phrases themselves, so someone can read them without opening the app: the days opened are the least they read, not all of it.

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
