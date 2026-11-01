# Announcements

Once a day, `.github/workflows/announce.yml` posts the oldest **due** file in `queue/` to
Mastodon and Bluesky, then moves it to `posted/` with links to the posts. At most one post a day,
so followers see a steady trickle, not a flood. Nothing is posted until the accounts below are set up.

## Daily rotation (when the queue is empty)

When nothing in `queue/` is due, the workflow posts about one app from `apps.json` instead, forever:

- The app posted longest ago (or never) goes next; ties go in the order listed in `apps.json`.
- Each app has a few different posts; they are used in turn and start over once all are used.
- New GitHub Pages sites on the account that aren't in `apps.json` get a short generic post made
  from the **repo description** on GitHub. A repo with no description is not posted.
- Repos in `skip` are never posted. A site whose link doesn't load is skipped that day.
- `rotation.json` is written by the workflow: when each app was last posted, which posts were used,
  and the links to recent posts. You don't need to edit it.

To add better posts for an app, add it to `apps.json`. To stop an app, add its repo name to `skip`.
A queued post always goes before the rotation.

## Queue a post

Add `queue/YYYY-MM-DD-name.json` (it becomes due on that date, UTC):

```json
{ "text": "I made Hifz, a free app for memorising the Qur'an with smart review. No account, works offline. https://candanumut.github.io/hifz/ #opensource #Quran" }
```

Keep it under 300 characters (Bluesky's limit); the link and hashtags become clickable, and Bluesky
shows a preview card from the page's `og:` tags.

## One-time setup (about 10 minutes)

Passwords never go into chat or into the code — only into this repo's encrypted secrets
(**Settings → Secrets and variables → Actions → New repository secret**).

**Mastodon**
1. Sign up at https://mastodon.social (or another server you like).
2. In your profile settings, tick **"This is an automated account"** if you want it marked as a bot (optional, honest).
3. **Preferences → Development → New application**: name it "announce", keep only the `write:statuses` scope, save.
4. Open the app and copy **Your access token**.
5. Add two secrets: `MASTODON_INSTANCE` = `https://mastodon.social` and `MASTODON_TOKEN` = the token.

**Bluesky**
1. Sign up at https://bsky.app.
2. **Settings → Privacy and security → App passwords → Add App Password** (name it "announce"). Copy it.
3. Add two secrets: `BLUESKY_HANDLE` = your handle (e.g. `name.bsky.social`) and
   `BLUESKY_APP_PASSWORD` = the app password. (An app password can be revoked any time; it is not your login password.)

To test without posting: **Actions → Announce → Run workflow → tick "Only print"**.
To stop all posting: delete the secrets, or disable the workflow.
