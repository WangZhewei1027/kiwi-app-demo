# Explorable Explanations — a Kiwi App

Ask it a concept. It comes back with a small interactive page — bars you step
through, a stack you push onto, a search that greys out half the list per guess —
rendered live in a sandboxed iframe.

Single file (`index.html`), no build step, built on the bundled
[`@kiwi/app-sdk`](./kiwi-app-sdk/). Copy this folder as-is; it is self-contained.
Everything goes through the window bridge — no CORS entry, no backend, and the
app never handles a token itself.

---

## What Kiwi actually allows

Both of Kiwi's AI surfaces end at the same model. They are not the same tool, and
the difference decides whether generation is any good.

| | `kiwi:askAI` | `contextualChat` op |
| --- | --- | --- |
| Route | `POST /student/chat/v2` | `POST /api/kiwi-apps/:slug/contextual-chat` |
| What runs it | the student **tutor agent** (`agent-loop.service.ts`) | `LlmService.createChat` directly |
| Output cap | **1500 tokens per iteration** (`maxTokensPerIteration`) | `prompt.maxTokens ?? undefined` — **register the prompt without maxTokens and nothing is sent**, so uncapped |
| System prompt | Kiwi's: *"guide students rather than giving direct answers"*, plus tool guidance | **this app's**, registered and admin-approved |
| Tools attached | RAG, code interpreter, site control | none |
| Structured output | no | `outputSchema` → strict `json_schema`, a conforming instance is guaranteed |
| Memory | none — the host mints a fresh `conversationId` per request | none |
| Needs | nothing | app token with `context:student_learning:read` + `llm:prompt:<id>`, prompt admin-approved |
| Other caps | prompt length unbounded | `userMessage` ≤ 8000 chars; `outputSchema` ≤ 10k chars / depth 5 / 100 props; `contextRequest.include` must be non-empty; op times out at 120 s |

Two details are worth spelling out because they are easy to get wrong:

- The model is a **gpt-5.x reasoning model** (`llm.service.ts` pins
  `isReasoningModel: true` and maps `max_tokens` → `max_completion_tokens`).
  Reasoning tokens come out of the same budget, so "1500 tokens" is well under
  1500 tokens of visible output. It also means `temperature` is dropped — setting
  it on the registered prompt does nothing.
- `register-app.dto.ts` caps an explicit `maxTokens` at 4096. **Omitting it
  entirely is better than any value you can set**, which is why `register.sh`
  registers the build prompt with no `maxTokens` at all.

The app checks its app-token scopes at startup and picks the route; the note
under the Generate button says which one it got and why. There is a link there to
force the askAI path, so you can compare them on the same concept.

---

## How generation works

The model writes the **complete page**: one self-contained HTML document —
markup, CSS and JavaScript inline — that goes straight into
`<iframe sandbox="allow-scripts">`. There is no slot-filling runtime, no
client-side repair ladder, and no fixed visual vocabulary: the design freedom
(and the design responsibility) is the model's.

**On contextual-chat** the build is one uncapped call. The page contract goes in
`userMessage` and the reply is pinned by a strict schema —
`{ html, controls, summary }` — so the document, the control labels (for the
how-to call and `kiwi.updateContext`) and a one-line summary all come back in a
guaranteed-valid instance. The call also asks for `weak_concepts` +
`relevant_materials`, so the explanation comes out in the vocabulary of the
class the student is actually in — the assembled context stays server-side and
never reaches this app.

**On askAI** the same request is a single best-effort call that returns raw
HTML, told to keep the whole document minimal: the 1500-token iteration cap is
shared with the model's reasoning, so anything ambitious comes back truncated.
Browsers parse truncated HTML forgivingly (open tags get closed; an unfinished
`<script>` loses only its own code), so a cut-off page usually still renders
partially. This route is a fallback, not a target — the quality lives on
contextual-chat.

Before mounting, the app injects exactly one thing into the document: a small
reporting script (before `</body>`) that traps runtime errors and reports the
page's height over `postMessage`, so the outer page can size the iframe and
offer recovery.

### The page fills in, it does not appear

The prose around the panel is **two further calls, and they always ride
askAI** — two agents in parallel: contextual-chat spends its uncapped budget
and its 120 s window on the one artifact that needs them (the page), while the
prose — a few sentences each, comfortably inside the 1500-token cap, needing no
class context — streams in beside it:

| Call | Surface | Depends on | Lands |
| --- | --- | --- | --- |
| head — `title` + `concept` | askAI | only the typed concept | first, while the page is still being written |
| the build | contextual-chat | the typed concept | when the page is ready |
| howto | askAI | the finished control labels | last, into a page that already works |

So three blocks go up as skeletons the moment **Explore** is pressed, and each
is replaced on its own: header, then the interactive, then the how-to. Merging
the head into the build call, or letting it name the controls, would put the
first visible text back behind the slowest thing on the page.

Call counts, therefore: **contextual-chat × 1 + askAI × 2** on the main route,
**askAI × 3** on the fallback — the page and the head together, then the
how-to. The page prompt tells the model NOT to put a title or a concept
paragraph inside the page (that prose lives outside the iframe) and that it is
expected to write the full HTML, CSS and JavaScript itself.

`render()` mounts the page and nothing else; the header and the how-to are
owned by `paintHead` / `paintHowto`, so Replay never wipes prose that is
already on screen.

### When the answer is bad anyway

| Failure | What happens |
| --- | --- |
| The reply holds no HTML document | the run fails with a clear message; on contextual, the app retries the run on askAI first |
| The page throws at runtime | the injected reporter posts the error out; the warn bar shows it and offers **Regenerate with this error** — the retry carries the error text into the prompt as a mistake to avoid |
| The head or how-to call fails | that block only: title falls back to the typed concept, how-to to a generic line; the page is untouched |
| An askAI reply is truncated | the page renders partially (browsers close open tags); regenerate or fix the route |

Repair is **regeneration with feedback**, not patching: editing one function
inside a model-authored page is guesswork, asking for the page again with
"avoid this mistake" is not.

---

## Two ways to run it

```bash
# from this folder:
python3 -m http.server 8000
# then open http://localhost:8000/
```

**A) Standalone.** Nothing is embedding the page, so the SDK switches on its
Simulator and answers *both* surfaces locally — one canned reply for
contextual-chat, three for askAI — marked `✦ sim` in the bridge log. The
pipeline is real; the answers are handwritten. Four explanations ship with it
(sorting, stack/queue, binary search, and a generic walker). Use the
"force the askAI path" link to exercise the fallback offline.

**B) Embedded in a real Kiwi class.** Register and enable it (below), open the
class, and the same code runs against the real model.

---

## Enabling the app

Five records have to exist. Only #2 is public; the rest are admin actions.

### Registration settings

`register.sh` loads `explorable-app/.env` before applying its defaults. Copy
`.env.example` to `.env`, fill in the local Kiwi address, class id, and either
admin credentials, an admin token, or a browser session cookie. Values in
`.env` take precedence over inherited environment variables. The `.env` file is
ignored by Git because it can contain passwords, tokens, session cookies, and
the registration secret.

```bash
cp .env.example .env
./register.sh
```

| # | Record | Why |
| --- | --- | --- |
| 1 | `KiwiAppWhitelist` — `status:'approved'`, `maxScopes` | ceiling of scopes the app may ever get |
| 2 | `KiwiApp` + `KiwiAppPrompt` — registered by `register.sh` | the app and its build prompt |
| 3 | `KiwiAppUI` — `placement:'class-tab'`, `isEnabled`, `uiUrl` | **without this there is no tab** |
| 4 | `KiwiAppPrompt.isActive = true` — admin approval | **without this there is no uncapped route** |
| 5 | `ClassKiwiApp` — `isEnabled:true` for the class | binds the app to that class |

> ⚠️ **A bearer token cannot do the admin steps.** `AdminGuard`
> (`kiwi/src/auth/auth.guard.ts:23`) reads `request.session.userId` and nothing
> else, and there is no global `JwtAuthGuard` in `app.module.ts` to turn a token
> into a session first — so steps 1, 3 and 4 401 with any minted JWT.
> `POST /auth/login` *is* `@Public()` and does set the session server-side
> (`auth.service.ts:294`), handing the id back as a cookie, so `register.sh`
> takes `ADMIN_EMAIL`/`ADMIN_PASSWORD` and reuses a cookie jar. That works
> against a real deployment; the Prisma-seed route does not.

### Approving the `explorable-build` prompt

Prompts register **inactive**, and until one is approved `getActivePrompt` throws
`Prompt "…" is not active (requires admin approval)`.

> ⚠️ **An `llm:prompt:<id>` scope in the token does NOT mean the prompt is
> approved.** `getEffectiveScopes` computes `maxScopes ∩ enabledScopes` first and
> only *appends* the scopes of active prompts — it never removes anything. So a
> literal `llm:prompt:explorable-build` listed in the whitelist's `maxScopes`
> lands in every token regardless of approval, and a scope pre-check will happily
> green-light a call that then fails inside the endpoint.
>
> Listing **`llm:prompt:*`** in `maxScopes` instead makes the token honest: the
> literal per-prompt scope can then only arrive via the active-prompts branch. The
> app handles both — it names the missing approval either way — but `llm:prompt:*`
> is the configuration that fails fast instead of failing late.

> ⚠️ **You cannot approve it from the admin UI.** `KiwiAppsAdmin.tsx`'s
> `fetchAppPrompts` calls `kiwiAppControllerGetAppPrompts({ slug })` with no
> `includeInactive`, so the backend defaults to `includeInactive = false` and
> filters `where: { isActive: true }`. A freshly registered prompt is
> `isActive: false`, so the app expands to **"No prompts registered for this
> app."** — and the Approve button only exists inside that table. The `Pending`
> chip it renders is unreachable. Approval has to go through the API or the DB.

Three ways to approve:

**Route A — the admin UI (easiest, and not mentioned in the developer guide).**
Kiwi ships a screen for exactly this at **`/admin/kiwi-apps`** — sidebar entry
**"Kiwi Apps"** in the admin layout (`AdminLayout.tsx:42`, `roles: ['admin']`),
rendering `kiwi-ui/src/pages/admin/KiwiAppsAdmin.tsx` behind
`AdminProtectedRoute`. You need `systemRole: 'admin'`, not just a class role.

1. **Whitelist** tab. The **`+ Add to Whitelist`** button is at the **top right**,
   above the table — or, if nothing is whitelisted yet, the table is replaced by
   an empty state whose button reads **"Add First Whitelist Entry"**. Both open
   the same dialog:
   - **App Slug** → `explorable`
   - **Registration Secret** → **must be ≥ 32 characters.** `whitelist-app.dto.ts`
     enforces `@MinLength(32)` and the dialog's *Add* button stays disabled until
     you reach it, so `dev-secret` is not usable here. Press the ⟳ icon in the
     field to generate one, then **copy it from the one-time "Save Your
     Registration Secret" dialog** that appears after saving — it is shown once —
     and pass it to the script as `SECRET=…`. It cannot be viewed or changed
     later; a lost secret means deleting the entry and starting over.
   - **App Slug** cannot be edited afterwards — the field is disabled in the edit
     dialog and `UpdateWhitelistEntryDto` has no `slug`. Getting it wrong means
     delete and re-create (and a new secret).
   - **Status** → `Approved`
   - **Maximum Allowed Scopes** → type each one and press *Add* (they become
     chips): `context:student_learning:read`, `llm:prompt:explorable-build`,
     `user:profile:read`, `class:info:read`.

   > ⚠️ **Scopes typed into the *Add* dialog are silently dropped.**
   > `createWhitelistEntry` (`kiwi-app.service.ts`) builds its `data:` from slug,
   > secret, baseUrl, status, description and approvedBy only — `maxScopes` is
   > not in the list, and the entry is created without them. `updateWhitelistEntry`
   > spreads the whole DTO, so it *does* save them. **So: save the entry, then
   > reopen it with the pencil icon and add the scopes there.** The Whitelist
   > table has no scopes column, so the omission is invisible until the app drops
   > to the askAI route; check it under Registered Apps → the app → Scopes.
   >
   > Note also that creating is **not** an upsert — re-POSTing an existing slug
   > returns 409 `Whitelist entry already exists`, so `register.sh` takes
   > `SKIP_WHITELIST=1` for the case where an admin already made the entry.
2. Run the registration (step 2 needs no credentials):
   ```bash
   SECRET='<the 32+ char secret from step 1>' APP_URL=http://localhost:8000/ ./register.sh
   ```
3. Approve the prompt — **not here**, see the warning above; the script's step 4
   does it. Once approved it becomes visible in this table, and the *Settings*
   column should read `-` rather than a token count (a number means the prompt is
   capped and the uncapped route is lost).
4. Enable it for the class at **`/admin/class/<classID>/kiwi-apps`**
   (`ClassKiwiAppsSettings`), leaving `enabledScopes` empty to inherit all of
   `maxScopes`.

Reload the app tab: the note under the Generate button should now say
*contextual-chat*.

**Route B — seed it with Prisma** (scripted local setup, the route the
hello-kiwi-app README uses). Run from the `kiwi` backend repo so `.env` supplies
the DB URL:

```js
await db.kiwiAppPrompt.upsert({
  where:  { appId_promptId: { appId: app.id, promptId: 'explorable-build' } },
  update: { isActive: true, approvedBy: ADMIN_USER_ID, approvedAt: new Date() },
  create: {
    appId: app.id, promptId: 'explorable-build',
    name: 'Explorable Explanation Builder',
    systemPrompt: '…REGISTERED_SYSTEM_PROMPT from index.html…',
    isActive: true, approvedBy: ADMIN_USER_ID, approvedAt: new Date(),
    // maxTokens and temperature deliberately absent — leaving them NULL is what
    // makes the call uncapped (app-contextual-chat.service.ts).
  },
});
```

**Route A′ — the API, with a real session.** `register.sh` needs one of these,
in order of reliability:

```bash
# 1. paste the session straight out of the browser you are already logged into:
#    DevTools -> Application -> Cookies -> http://localhost:3000 -> connect.sid
#    DevTools shows Name and Value in separate columns; either form works, the
#    name defaults to connect.sid:
SESSION_COOKIE='connect.sid=s%3A…' ./register.sh
SESSION_COOKIE='s%3A…'             ./register.sh

# 2. password login (fails for SSO-only accounts; the script prints the server's reply)
ADMIN_EMAIL=… ADMIN_PASSWORD=… ./register.sh

# 3. a bearer token — DevTools -> Application -> Local Storage -> authToken
ADMIN_TOKEN=eyJ… ./register.sh
```

Whichever you pick, the script proves it before using it: `GET /api/kiwi-apps/whitelist`
is `AdminGuard`-protected and read-only, so one probe answers "is this an admin
session?" instead of letting three write calls 401 one by one.

Option 3 works despite `AdminGuard` ignoring bearer tokens, and the mechanism is
worth knowing: `JwtAuthGuard` **regenerates the session and writes
`session.userId`** when one is missing (`auth.guard.ts:~226`), while `AdminGuard`
only ever reads it. So the script calls a `JwtAuthGuard`-protected endpoint
(`GET /auth/profile`) once with the token and a cookie jar, and the jar comes
back holding an admin session. That is also why the browser never trips over
this: something always bootstraps the session before an admin screen loads.

**Route C — `NO_AUTH=true`.** `AdminGuard.canActivate` returns `true` immediately
when that env var is set, so on a throwaway local backend `register.sh` works
end to end with any `ADMIN_TOKEN` value. Never on anything shared.

The endpoint underneath all three is
`POST /api/kiwi-apps/:slug/prompts/:promptId/approve`
(guide §4.2); it sets `isActive: true`, `approvedBy`, `approvedAt`. There is a
matching `…/revoke` if you need to take it back.

### Gotchas that actually bite

- **`uiUrl` must exactly match where you serve the app** (origin *and* path). The
  host pins `event.origin` to it and drops mismatched messages — which shows up
  here as the app quietly staying in Simulator mode.
- **An unapproved prompt does not look like a scope bug — the scopes look fine.**
  See the warning above: the token carries `llm:prompt:explorable-build` anyway if
  it is listed literally in `maxScopes`. The symptom is a *failed* contextual-chat
  call reading `Prompt "explorable-build" is not active`, after which the app
  finishes the run on askAI and tells you where to click.
- **Never send `tutoringMode: 'guidance'`** on `kiwi:ready` or
  `kiwi:updateContext`. It appends Kiwi's strict tutoring prompt — *"NEVER output
  a working solution… maximum 3 lines of code per reply"* — which would gag the
  generator completely. This app never sets it.
- **No CORS entry needed.** Both routes are proxied by the host.

---

## Reading the code

`index.html` is one file in nine labelled parts:

| Part | What |
| --- | --- |
| 1 | the demo runtime (`RUNTIME_CSS` + `HARNESS_JS`) — Simulator fixtures only |
| 2 | the prompts: `PAGE_RULES`, `PAGE_SCHEMA`, and the two prose schemas (all shaped to the sanitiser's rules) |
| 3 | `parseJSONLoose` / `repairJSON`, plus `extractControls` for pages that name no controls |
| 4 | mounting: `finalizeHtml` (fences off, reporter in) and the demo-only `assemble()` |
| 5 | bridge wiring and the event log |
| 6 | route selection from the app token's scopes |
| 7 | the pipeline: `fetchHead`, `fetchHowto`, `buildViaContextual`, `buildViaAsk`, `generate`, and the `showSkeleton` / `paintHead` / `paintHowto` painters |
| 8 | buttons |
| 9 | the Simulator's fixtures for both surfaces |
