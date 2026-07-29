# AGENTS.md

## Project Overview

This repo holds one external **Kiwi App**: `explorable-app/`, a single-file page
that asks Kiwi's AI for a small interactive explanation of a concept and renders
it in a sandboxed iframe.

A Kiwi App is a separately hosted web app that Kiwi embeds in an iframe and talks
to over `window.postMessage`. This one uses two bridge capabilities —
`kiwi.askAI()` and the host-proxied `contextualChat` op — and no direct backend
calls, so it needs no CORS entry and never handles a token itself.

## Source Of Truth

- The app protocol is specified in
  `../kiwi/kiwi-app-developer-guide-example/KIWI_APP_DEVELOPER_GUIDE.md`. It wins
  over anything in this repo.
- The **limits** this app is designed around are read from the backend, not from
  documentation. If you change anything about generation, re-read:
  `kiwi/src/common/agent/agent-loop.service.ts` (`maxTokensPerIteration`),
  `kiwi/src/kiwi-app/app-contextual-chat.service.ts` (`prompt.maxTokens ??
  undefined`), `kiwi/src/kiwi-app/utils/output-schema.ts` (schema sanitiser),
  `kiwi/src/kiwi-app/dto/app-data.dto.ts` (`userMessage` ≤ 8000, non-empty
  `include`), `kiwi/src/common/llm/llm.service.ts` (reasoning model; temperature
  dropped) and `kiwi/src/student/student.prompts.ts` (the tutor persona).
  The summary table in `explorable-app/README.md` must be updated with them.
- `explorable-app/kiwi-app-sdk/` is a **vendored copy** of the reference SDK.
  Do not edit it; re-copy it if the reference updates.

## Scope

Changes belong in this folder only. `kiwi/`, `kiwi-ui/` and
`kiwi-app-developer-guide-example/` are read-only from here. If a task needs a
backend or frontend change, say so instead of editing them.

## Build And Run

Static, no build step, no dependencies.

```bash
cd explorable-app
python3 -m http.server 8000
```

`index.html` opened directly from disk must also work: with nothing embedding it,
the SDK falls back to Simulator mode and answers locally.

## Implementation Rules

- Post `kiwi:ready` on load and render `kiwi:context` when it arrives; verify
  `event.origin` once Kiwi's origin is known. The SDK does all three — use it.
- **Never send `tutoringMode`.** `'guidance'` appends Kiwi's strict tutoring
  prompt ("NEVER output a working solution", max 3 lines of code) and would gag
  the generator.
- **Prefer the uncapped route.** Route selection reads the app token's scopes;
  keep it a pre-flight, not a 403 discovered mid-generation, and keep the reason
  visible in the UI.
- **Never register the build prompt with `maxTokens`.** `prompt.maxTokens ??
  undefined` is what makes contextual-chat uncapped; any explicit value caps it,
  and the DTO refuses anything above 4096.
- **The prose is two calls, always on askAI, and the split is load-bearing.**
  Two agents in parallel: contextual-chat writes the page and nothing else;
  askAI writes the prose (it fits the 1500-token cap and needs no class
  context). `head` (title + concept) depends only on the typed concept, so it is
  fired *with* the build and paints on arrival; `howto` names the controls, so
  it stays last. Anything that makes `head` depend on the built page, or moves
  prose onto contextual-chat, breaks the parallelism. `render()` mounts the page
  only — the header and how-to belong to `paintHead` / `paintHowto`.
- **The model writes the complete page.** One self-contained HTML document per
  build call (`PAGE_RULES` in Part 2), returned via `PAGE_SCHEMA` on
  contextual-chat and as raw HTML on askAI. The app injects exactly one thing —
  the reporting script in `finalizeHtml` (Part 4) — and mounts the rest as-is.
  Do not reintroduce a client-side runtime or a fixed visual vocabulary.
- **Repair is regeneration with feedback, never patching.** A page that throws
  reports its error through the injected script; the retry carries that error
  back into the prompt (`feedbackLine`). Do not add code that edits a
  model-authored page in place.
- The full page is viable on contextual-chat because the prompt is registered
  without `maxTokens`. On askAI the 1500-token cap (shared with reasoning) means
  the page prompt must keep demanding a minimal document — that route is a
  fallback, not a target.
- Generated pages run in `<iframe sandbox="allow-scripts">` with no
  `allow-same-origin`. Keep both properties, and keep `PAGE_RULES` honest about
  what that sandbox forbids (storage APIs throw, no fetch, no dialogs).
- Part 1's runtime and Part 4's `assemble()` exist only for the Simulator's
  demo fixtures. Live code must not depend on them.

## Registration Rules

Order is strict:

```text
admin whitelist -> app register -> enable in class -> admin approve prompt
```

- `register.sh` is the reproducible path; keep it idempotent, and keep the
  registered `systemPrompt` byte-identical to `REGISTERED_SYSTEM_PROMPT` in
  `index.html`. The build contract lives in `userMessage`, so iterating on it must
  not require another approval.
- Register the exact origin the app is served from — a mismatch means
  `kiwi:context` never arrives and the app silently sits in Simulator mode.

## Verification Checklist

Before finishing a change:

- Simulator mode generates a working, clickable page on **both** routes (use the
  "force the askAI path" link) for `Bubble Sort`, `Stack`, `Binary Search`, and
  something unlisted. The askAI fixture returns a deliberately minimal page —
  that is what the capped route realistically produces.
- Every control changes both the visual and the status line; Reset always works.
- The three blocks fill in independently: header text before the interactive, the
  how-to last, and a failed call (head, how-to or build) leaves no block still
  shimmering.
- A page that throws at runtime shows the warn bar, and **Regenerate with this
  error** produces a run whose prompt contains the error text.
- The bridge log shows `kiwi:ready` → `kiwi:context` → `kiwi:appToken` →
  `kiwi:apiRequest`/`kiwi:askAI` → response.
- Docs updated when the pipeline, the measured limits, or run instructions change.

## Agent Guidance

- Keep this file short. Protocol detail belongs in the developer guide; limits and
  pipeline detail belong in `explorable-app/README.md`.
- Prefer extending `explorable-app/` over adding a second app.
- Do not commit secrets, JWTs, registration secrets or `.env` files.
