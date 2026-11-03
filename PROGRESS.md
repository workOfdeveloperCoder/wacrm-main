---
# Project Progress Log

## Last Updated
2026-11-03 18:50 (UTC+5)

## Current State
- The app talks to Postgres through `DATABASE_URL`. It does not call Supabase Auth, Storage, or Realtime.
- Tables are unchanged. A logged-in request runs as the `authenticated` role, so the existing row-level policies still apply. Admin work (webhooks, automations, flows) connects as the database user in `DATABASE_URL` and bypasses those policies, the same way the old service role did.
- Login is an httpOnly cookie (`wacrm_session`). Passwords are bcrypt hashes in `auth.users`. New signups are confirmed immediately and the account trigger still creates the profile and account with role `owner`.
- Uploaded files are stored on disk under `data/storage` and served by `/api/storage`.
- Inbox updates poll every 4 seconds. There is no separate realtime service.
- `DATABASE_URL` is `postgresql://postgres:***@localhost:54322/postgres`. That database has the full schema (37 public tables). A live signup created an owner profile, and that member could see only their own account.
- Cloud credentials remain in gitignored `.env.local.cloud`.
- `@supabase/supabase-js`, `@supabase/ssr`, and `@supabase/server` are removed from `package.json`.

## What Was Done This Session
- Replaced every Supabase client with a Postgres query client that still supports `.from()`, `.rpc()`, `.upsert()`, filters, and embedded selects.
- Browser queries go to `POST /api/db` with the session cookie. The database role is `authenticated`.
- Login, signup, logout, and password change go to `/api/auth/*`.
- Webhook and WhatsApp config admin clients use the same Postgres admin connection.
- Removed the Supabase packages. Typecheck of `src` is clean. Vitest: 157 files, 1684 tests passed.
- Confirmed against the live database: signup creates an `owner` profile, and row-level security hides other accounts.
- Fixed presence loading. `member_presence` has no `id` column (its key is `user_id`), and selects were adding `t.id`.
- The browser database client is created once per tab. A new client on every render was retriggering the contacts fetch until React hit its update limit.
- Browser requests no longer throw "The string did not match the expected pattern" when a response is not JSON. That message was Safari failing to parse an error page.
- Expanded `.gitignore` so a VPS clone gets source, `package-lock.json`, and `supabase/migrations`, and leaves out `node_modules`, `.next`, secrets (`.env.local`, `.env.local.cloud`), uploads (`data/`), and TypeScript build info.

## In Progress / Half Done
- The local database is empty again after the verification user was deleted. Sign up in the app to create the first account.
- Password-reset email is not sent. Signup does not need a confirmation email.

## Next Steps (Do This First When You Return)
- `https://wacrm.metix.co/` is the static `index.html` ("hello"), not the app. `/login` is the host's 404. Run Node (`npm run build` then `npm start`) and reverse-proxy the domain to that process. Remove `index.html` from the web root.
- On the server, set `DATABASE_URL`, `AUTH_SECRET`, `ENCRYPTION_KEY`, `META_APP_SECRET`, and `NEXT_PUBLIC_SITE_URL=https://wacrm.metix.co`. Node 22+. No Supabase keys.
- Sign up at http://localhost:3000/signup once local dev is running.
- pgAdmin: host `localhost`, port `54322`, database `postgres`, user `postgres`, password `postgres`

## Known Issues / Blockers
- Production at `wacrm.metix.co` is nginx + PHP static hosting. `index.html` is served; Next.js routes are not. Needs a Node process and a reverse proxy.
- The server is SiteGround shared hosting (`gvam1197.siteground.biz`, app in `public_html`). `next build` and `next build --webpack` both panic in `stacker` while loading `next.config.ts`, because `/proc` is not a real proc filesystem and the native SWC binary calls `pthread_attr_getstack`. Workaround to try: `NEXT_TEST_WASM=1 npx next build --webpack`. The domain still serves `index.html` until that file is removed and SiteGround's Node.js app is pointed at this folder.
- Port `5432` is a different Postgres and asks for a password this session does not have. The working database is port `54322`.
- Forgot-password returns a clear error because there is no mail server.
- `npm audit` reports 21 vulnerabilities (2 low, 19 moderate). Left alone.

## Key Decisions & Context
- The query methods stay the same so existing screens, webhooks, and broadcasts do not need a rewrite and do not crash.
- Roles stay in Postgres policies (`auth.uid()` plus `SET LOCAL ROLE authenticated`). The admin connection bypasses them.
- The user does not want Docker or a Supabase project. The app only needs `DATABASE_URL`.
---
