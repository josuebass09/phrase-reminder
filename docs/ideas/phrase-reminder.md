# Phrase Reminder

## Problem Statement
How might we bring saved English phrases back every day, so they get remembered instead of sitting in a file?

## Recommended Direction
A small, mobile-first web app with one text input, usable on phone and computer. Each saved phrase becomes a Postgres row with its save date. Once a day, a scheduled job sends a push notification with 3 phrases that are at least 14 days old.

Phrases never shown go first, then those shown longest ago, so a phrase only repeats after the older ones have had a turn.

The app looks native once opened from the home-screen icon: iOS styling on iPhone and computers, Material-like styling on Android. The palette is petrol blue and coral with pastel phrase tiles, following the approved mockup.

Stack: TypeScript on Node, Hono, Railway Postgres, a Railway cron service, and Web Push with VAPID keys through the `web-push` library.

## Key Assumptions to Validate
- [ ] **Reading is enough to remember:** after a month, take 10 phrases you've been sent and check whether you can explain and use them.
- [ ] **You'll read the notification daily:** check whether you read it at least 5 days a week for 3 weeks.
- [ ] **3 a day is the right amount:** adjust after 2 weeks if it feels like too many or too few.
- [ ] **Web push is reliable enough on your phone:** check that the notification arrives every day for the first week.

## MVP Scope
**In:**
- Input page with a Today section (the latest reminder's phrases), a recent-phrases list, and a single password (1-year signed cookie). Later replaced by an app with user accounts: email and password, 12-hour access tokens (later sessions that last until 60 days without use), users sign up in the app with a single-use invite link from the admin, or are created from a terminal
- `phrases` and `push_subscriptions` tables
- Button to turn on reminders on each device
- Daily push notification at 12:00 Costa Rica time. Later made a per-user setting: time, number of phrases, and pause, in the user's own time zone
- One-time import of the current file, backdated so reminders start on day one

**Out:** everything below.

## Not Doing (and Why)
- **Quizzes:** the goal is simplicity. Reconsider only if the first assumption fails.
- **Telegram bot:** the input page already covers saving.
- **LLM meanings and examples:** adds cost and a dependency.
- **Open sign-up:** signing up needs an invite link from the admin, so strangers can't make accounts.
- **Native mobile app:** a web page with web push works on both devices.
- **Email reminders:** replaced by push notifications.
- **Saving offline:** a failed save shows an error and keeps the typed text.
