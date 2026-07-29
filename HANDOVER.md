# Handover — finishing the Explorable Explanations install

The app is built and tested; the **last two admin records are missing** and every
API route to create them has been blocked by an auth problem. Everything needed
to finish is below. Nothing in `kiwi/`, `kiwi-ui/` or the reference workspace has
been modified.

---

## 1. Where things stand

Local Kiwi: backend `http://localhost:3000`, UI `http://localhost:3001`.
App served from `http://localhost:8000/` (`explorable-app/`, `python3 -m http.server 8000`).

| # | Record | State |
| --- | --- | --- |
| 1 | `KiwiAppWhitelist` slug `explorable` | ✅ `status: approved`, maxScopes: `context:student_learning:read`, `llm:prompt:explorable-build`, `user:profile:read`, `class:info:read` |
| 2 | `KiwiApp` + `KiwiAppUI` | ✅ registered — appId `5e2c7bc2-ee7f-4c2b-9b9b-404597fba843`, UI `student` / `class-tab` / `http://localhost:8000/` / enabled |
| 3 | `KiwiAppPrompt` `explorable-build` | ⚠️ exists (row `a2eeca3f-fead-417b-9631-676b73ae766f`) but **`isActive: false`** — `maxTokens: null`, `temperature: null`, which is correct and must stay that way |
| 4 | `ClassKiwiApp` for class `f4beb243-ff6f-4797-ad15-fa624f3b0ace` | ❌ **not created** |

**The two remaining tasks**: approve the prompt, and enable the app for that class.

Registration secret: not in this repo. It is in the shell history of the session
that created the whitelist entry; `register.sh` takes it as `SECRET=…`. It cannot
be read back from Kiwi (bcrypt-hashed, and the admin UI says so) — if it is lost,
delete the whitelist entry and re-create it.

---

## 2. Why the API route kept failing

Three separate findings, all verified against the source on this branch.

**(a) `AdminGuard` only reads the session.** `kiwi/src/auth/auth.guard.ts:23` —
it takes `request.session.userId`, looks the user up, and requires
`systemRole === 'admin'`. There is **no global `APP_GUARD`** in `app.module.ts`,
so on `@UseGuards(AdminGuard)` routes a bearer token is never even examined.
`register.sh`'s original `ADMIN_TOKEN=…` therefore 401'd on steps 1, 3 and 4.

**(b) `JwtAuthGuard` *does* bootstrap a session** (`auth.guard.ts:~226`): when
`session.userId` is missing it calls `session.regenerate()` and writes `userId`
plus a new `userSessionId`. That is why the browser never hits this — some
`JwtAuthGuard` route runs before any admin screen. It also gives a scripted way
in: `GET /auth/profile` with `Authorization: Bearer <token>` and a cookie jar
returns a jar holding a valid admin session.

**(c) The current blocker is unresolved.** `register.sh` now supports
`SESSION_COOKIE`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` and `ADMIN_TOKEN`, and probes
`GET /api/kiwi-apps/whitelist` (AdminGuard-protected, read-only) before doing
anything. On the last run with a `connect.sid` copied from the browser, **the
probe was rejected**. Not yet distinguished:

- stale cookie — sessions are 1 h (`main.ts` `SESSION_MAX_AGE`), stored in
  `PrismaSessionStore`;
- the cookie value was mangled in transit (it is the *signed* form
  `s%3A<sid>.<sig>`; the script now prepends `connect.sid=` if the name is
  missing, which was one earlier cause);
- the logged-in user is not actually `systemRole: 'admin'`;
- `cookie.secure` is on (`main.ts` sets `secure: !!process.env.API_DOMAIN`) and
  the cookie is being dropped over plain http.

The script prints the server's raw reply for the probe, so **one run shows which
it is**. Check `Session` rows in Postgres and the user's `systemRole` first.

---

## 3. Two upstream bugs found (in `kiwi`, not fixed here)

Worth reporting or fixing separately; both cost real time.

**A pending prompt is invisible in the admin UI, so it can never be approved
there.** `kiwi-ui/src/pages/admin/KiwiAppsAdmin.tsx` → `fetchAppPrompts` calls
`kiwiAppControllerGetAppPrompts({ slug })` without `includeInactive`, so
`kiwi-app.service.ts` `getAppPrompts` defaults to `includeInactive = false` and
filters `where: { isActive: true }`. A freshly registered prompt is
`isActive: false` → the panel renders **"No prompts registered for this app."**
The Approve button and the `Pending` chip live inside that table and are
unreachable. One-line fix: pass `includeInactive: true` from the admin page.

**`maxScopes` typed into the *Add to Whitelist* dialog is silently dropped.**
`kiwi-app.service.ts` `createWhitelistEntry` builds its `data:` from slug,
registrationSecret, baseUrl, status, description, approvedBy — `maxScopes` is not
included. `updateWhitelistEntry` spreads the whole DTO and does save it. So
scopes must be added by re-opening the entry with the pencil icon; the Whitelist
table has no scopes column, so the omission is invisible. (Also: create throws
`ConflictException` on an existing slug — it is not an upsert.)

---

## 4. Three ways to finish

**Fastest to verify (recommended for local dev): Prisma.** Run
`node enable-explorable.cjs` **from the `kiwi` backend repo** so `@prisma/client`
and `.env` resolve — see `enable-explorable.cjs` next to this file. It approves
the prompt and enables the class app, and prints the resulting rows. It writes
`approvedBy` with a real admin's id, so the audit fields stay honest.

**API, once the session works.** From `explorable-app/`:

```bash
SESSION_COOKIE='connect.sid=s%3A…' \
KIWI=http://localhost:3000 SLUG=explorable SECRET='…' SKIP_WHITELIST=1 \
APP_URL=http://localhost:8000/ CLASS_ID=f4beb243-ff6f-4797-ad15-fa624f3b0ace \
bash register.sh
```

Step 0 must print `session accepted by AdminGuard`. `ADMIN_TOKEN=` (from
DevTools → Application → Local Storage → `authToken`) is the other good option.

**Admin UI.** Only step 3 (`/admin/class/<classID>/kiwi-apps`) can be done there.
Step 4 cannot — see bug A.

---

## 5. How to know it worked

1. `KiwiAppPrompt.isActive = true`, `approvedBy`/`approvedAt` set,
   **`maxTokens` still NULL**.
2. `ClassKiwiApp` row exists for the class with `isEnabled: true`.
3. Open the class → **Explorables** tab. The note under the Generate button must
   read **contextual-chat** (green). Yellow **kiwi:askAI** means a scope or the
   approval is still missing — the note names which.
4. Bridge log (right column) shows `kiwi:requestToken` → `kiwi:appToken` (scopes
   array) → `kiwi:apiRequest {op:"contextualChat"}` → `kiwi:apiResponse`.
5. Type `Bubble Sort`. Expect a plan, three filled slots, and a clickable page in
   the iframe.

---

## 6. Do not break these

The app is built around limits measured from the backend; `explorable-app/README.md`
has the full table. The three that will silently ruin output quality:

- **Never give the `explorable-build` prompt a `maxTokens`.**
  `app-contextual-chat.service.ts` passes `prompt.maxTokens ?? undefined`, so NULL
  means no `max_completion_tokens` is sent and the answer is uncapped. Any value
  caps it, and `register-app.dto.ts` refuses anything over 4096 anyway.
- **Never send `tutoringMode: 'guidance'`** on `kiwi:ready`/`kiwi:updateContext`.
  It appends Kiwi's strict tutoring prompt ("NEVER output a working solution",
  max 3 lines of code) and gags the generator.
- **`kiwi:askAI` is the fallback, not the target.** It goes through the student
  tutor agent at `maxTokensPerIteration: 1500` on a reasoning model. The app
  splits work into three small calls there for a reason; do not merge them.

Also note: `llm:prompt:<id>` appearing in the app token does **not** prove the
prompt is approved — `getEffectiveScopes` computes `maxScopes ∩ enabledScopes`
first and only appends active-prompt scopes, so a literal entry in `maxScopes`
always lands in the token. Using `llm:prompt:*` in `maxScopes` instead makes the
token track approval honestly.
