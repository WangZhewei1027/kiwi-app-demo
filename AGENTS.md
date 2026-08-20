# AGENTS.md

## Project Overview

This repo holds one external **Kiwi App**: `explorable-app/`, a single-file page
that asks an AI model for a small interactive explanation of a concept and
renders it in a sandboxed iframe.

A Kiwi App is a separately hosted web app that Kiwi embeds in an iframe and
talks to over `window.postMessage`. This one uses the bridge for the
**embedding protocol only** (`kiwi:ready` / `kiwi:context` /
`kiwi:updateContext`). **AI calls do not go through the bridge**: they are
direct `fetch` calls to an OpenAI-compatible LiteLLM endpoint (`AI_BASE_URL` /
`AI_API_KEY` / `AI_MODEL` in PART 6 of `index.html`), streamed as SSE.

## Source Of Truth

- The embedding protocol is specified in
  `../kiwi/kiwi-app-developer-guide-example/KIWI_APP_DEVELOPER_GUIDE.md`. It
  wins over anything in this repo.
- The AI limits are the app's own now: `AI_TIMEOUT_MS` (120 s client-side
  abort) and the character budget in `PAGE_RULES`. There is no server-side
  token cap and no tutor persona — do not reintroduce prompt text that works
  around either.
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

Standalone (no Kiwi host) the app is fully functional: the SDK sits in `sim`
mode for the bridge, but generation is real — the AI calls never touch the
host. There are no offline fixtures any more.

## Implementation Rules

- Post `kiwi:ready` on load and render `kiwi:context` when it arrives; verify
  `event.origin` once Kiwi's origin is known. The SDK does all three — use it.
- **Retrieval first.** `generate()` consults `premade/catalog.json` before
  calling the model; a hit mounts the curated page (fresh iframe per mount,
  `allow-scripts allow-same-origin`, vetted sources only) and still generates
  the head/how-to prose. Catalog URLs are hotlinks to https://csvistool.com
  (verified frameable — recheck headers if it ever goes blank). Every catalog
  entry becomes a "Curated" chip; `GENERATE_SUGGESTIONS` chips must stay
  concepts the catalog does NOT cover, and the two rows stay visually
  distinct. Regenerate-with-feedback must keep skipping the catalog.
- **All AI traffic goes through `llmChat()`** (PART 6). Do not add calls to
  `kiwi.askAI` or the `contextualChat` op back; the token/scope machinery for
  them is gone.
- **The pipeline is three calls and the split is load-bearing.** `head`
  (title + concept) depends only on the typed concept, so it is fired *with*
  the page call and paints on arrival; `howto` names the controls, so it stays
  last. Anything that makes `head` depend on the built page breaks the
  parallelism. `render()` mounts the page only — the header and how-to belong
  to `paintHead` / `paintHowto`.
- **The model writes the complete page** as raw HTML (one self-contained
  document per `pagePrompt` call, `SYSTEM_PROMPT` as the system message). The
  app injects exactly one thing — the reporting script in `finalizeHtml`
  (PART 4) — and mounts the rest as-is. Do not switch the page call to
  JSON-wrapped HTML, and do not reintroduce a client-side runtime or a fixed
  visual vocabulary.
- **Repair is regeneration with feedback, never patching.** A page that throws
  reports its error through the injected script; the retry carries that error
  back into the prompt (`feedbackLine`). Do not add code that edits a
  model-authored page in place.
- Generated pages run in `<iframe sandbox="allow-scripts">` with no
  `allow-same-origin`. Keep both properties, and keep `PAGE_RULES` honest about
  what that sandbox forbids (storage APIs throw, no fetch, no dialogs).
- The API key is client-visible by design (demo endpoint). Never swap in a
  paid or personal key; change `AI_BASE_URL`/`AI_API_KEY` together.

## Registration Rules (embedding only)

Registration is only about getting the iframe into a class tab; the AI needs
none of it. Order is still:

```text
admin whitelist -> app register -> enable in class
```

- `register.sh` is the reproducible path; keep it idempotent.
- Register the exact origin the app is served from — a mismatch means
  `kiwi:context` never arrives and the app silently stays in Standalone mode.

## Verification Checklist

Before finishing a change:

- Standalone (`python3 -m http.server`, no host): a catalog concept
  (`Binary Search Tree`, `跳表`) mounts its csvistool page instantly with the
  site chrome cropped away, and an unlisted concept (`Sliding Window`) still
  generates against the real API. Every "Curated" chip must route to its own
  catalog entry, and no "AI" chip may hit the catalog.
- Every control changes both the visual and the status line; Reset always works.
- The three blocks fill in independently: header text before the interactive,
  the how-to last, and a failed call (head, how-to or build) leaves no block
  still shimmering.
- A page that throws at runtime shows the warn bar, and **Regenerate with this
  error** produces a run whose prompt contains the error text.
- The console shows `llm:request` → streamed progress → `llm:response` for
  each of the three calls, and `kiwi:updateContext` after a successful mount.
- Docs updated when the pipeline, the endpoint/model, or run instructions
  change.

## Agent Guidance

- Keep this file short. Embedding-protocol detail belongs in the developer
  guide; pipeline detail belongs in `explorable-app/README.md`.
- Prefer extending `explorable-app/` over adding a second app.
- Do not commit secrets or `.env` files. (The demo AI key in `index.html` is
  knowingly public; treat any other credential as secret.)
