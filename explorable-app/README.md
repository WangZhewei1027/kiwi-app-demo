# Explorable Explanations — a Kiwi App

Ask it a concept. It comes back with a small interactive page — bars you step
through, a stack you push onto, a search that greys out half the list per guess —
rendered live in a sandboxed iframe.

Single file (`index.html`), no build step, built on the bundled
[`@kiwi/app-sdk`](./kiwi-app-sdk/). Copy this folder as-is; it is self-contained.

**AI calls go straight to the model API.** The Kiwi bridge is used for the
embedding protocol only (`kiwi:ready` / `kiwi:context` / `kiwi:updateContext`);
no AI traffic rides it. The app works identically standalone and embedded.

---

## How it talks to the model

One route. Every call is a plain `fetch` to an OpenAI-compatible
`/chat/completions` endpoint, streamed as SSE (PART 6 of `index.html`):

| | value |
| --- | --- |
| Endpoint | `AI_BASE_URL` — a LiteLLM proxy (`https://litellm.tunnel.kiwiai.org/v1`) |
| Model | `AI_MODEL` — `Qwen3.8-27B-fast` (the `-fast` variants are non-reasoning: tokens go to output, not thinking) |
| Auth | `AI_API_KEY`, sent as a Bearer header |
| Timeout | `AI_TIMEOUT_MS` (120 s) — the app aborts the fetch itself; a late page is discarded whole |
| Output cap | none — the page budget in `PAGE_RULES` is a latency rule, not a token cap |

The old two-surface split (Kiwi's capped `kiwi:askAI` tutor agent vs the
uncapped `contextualChat` op) is gone, and with it the app token, the scope
pre-check, the prompt registration/approval dance, and the route-selection
footer. The footer now just names the model.

> ⚠️ The API key ships inside `index.html`, readable by anyone who opens the
> page source. That is acceptable for this demo's shared endpoint — do not
> reuse the pattern with a key you care about.

Because the browser now calls the endpoint directly, the endpoint must answer
CORS preflights for the app's origin. The LiteLLM proxy above echoes any
origin, so any port works; nothing needs to be added to Kiwi's `FRONTEND_URL`.

---

## Retrieval first: the premade catalog

Before generating anything, the app checks `premade/catalog.json` — a concept →
URL index over the **hotlinked [CS1332 Visualization Tool](https://csvistool.com)**
(Georgia Tech's modern React remake of the Galles tool; GitHub Pages, no
`X-Frame-Options`/CSP, no frame-busting — verified embeddable; needs network).
Every catalog entry is also rendered as a "Curated" chip under the ask bar,
next to a visually distinct "AI" chip row for concepts the catalog lacks.

Matching is local and instant:
aliases (English and Chinese, plus each entry's title) are normalized and
matched longest-first, so "binary search tree" beats "binary search", and `+`
survives normalization so "b+ tree" is not "b tree".

- **Hit** → the curated page loads by URL into the stage iframe (fresh iframe,
  `allow-scripts allow-same-origin`), with the site's header/footer cropped
  away and attribution logged to the console. Only the PAGE call is replaced:
  the head and how-to prose are still LLM calls, personalized to what the
  learner typed, and the how-to gets the catalog's curated control labels.
- **Miss** → the existing generation pipeline runs unchanged.
- **Regenerate-with-feedback always skips the catalog** — feedback means the
  learner explicitly wants a different page than the one that failed.

This is the hybrid architecture in miniature: curated pages for the canon,
generation for the long tail — and every hit/miss logged to the console is a
data point for how much of real student demand a premade library can cover.

## How generation works

The model writes the **complete page**: one self-contained HTML document —
markup, CSS and JavaScript inline — that goes straight into
`<iframe sandbox="allow-scripts">`. There is no slot-filling runtime, no
client-side repair ladder, and no fixed visual vocabulary: the design freedom
(and the design responsibility) is the model's.

The build is one streamed call: `SYSTEM_PROMPT` as the system message, the page
contract (`PAGE_RULES`, via `pagePrompt`) as the user message, raw HTML back.
Raw HTML beats JSON-wrapped HTML here — no escaping to get wrong, and a
truncated reply still renders partially (browsers close open tags; only an
unfinished `<script>` loses its own code). Control labels are parsed back out
of the document (`extractControls`) for the how-to call and
`kiwi.updateContext`.

Before mounting, the app injects exactly one thing into the document: a small
reporting script (first in `<head>`) that traps runtime errors and reports the
page's height over `postMessage`, so the outer page can size the iframe and
offer recovery.

### The page fills in, it does not appear

The prose around the panel is two further calls, kept separate so they can run
in parallel with the page:

| Call | Depends on | Lands |
| --- | --- | --- |
| head — `title` + `concept` | only the typed concept | first, while the page is still being written |
| the build | the typed concept | when the page is ready |
| howto | the finished control labels | last, into a page that already works |

So three blocks go up as skeletons the moment **Explore** is pressed, and each
is replaced on its own: header, then the interactive, then the how-to. Merging
the head into the build call, or letting it name the controls, would put the
first visible text back behind the slowest thing on the page.

Call counts, therefore: **three direct API calls per run** — the page and the
head together, then the how-to. The page prompt tells the model NOT to put a
title or a concept paragraph inside the page (that prose lives outside the
iframe) and that it is expected to write the full HTML, CSS and JavaScript
itself.

`render()` mounts the page and nothing else; the header and the how-to are
owned by `paintHead` / `paintHowto`, so Replay never wipes prose that is
already on screen.

### When the answer is bad anyway

| Failure | What happens |
| --- | --- |
| The reply holds no HTML document | the run fails with a clear message and a **Try again** |
| The call runs past 120 s | aborted client-side; the retry asks for a distinctly smaller page |
| The page throws at runtime | the injected reporter posts the error out; the warn bar shows it and offers **Regenerate with this error** — the retry carries the error text into the prompt as a mistake to avoid |
| The head or how-to call fails | that block only: title falls back to the typed concept, how-to to a generic line; the page is untouched |
| The page mounts but never reports in | a 4 s watchdog raises the "rendered blank" warn bar — and takes it back down on its own if a late first report proves the page alive (background tabs throttle iframes) |

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

**A) Standalone.** Nothing embeds the page, so the SDK reports `sim` mode and
the footer shows a *Standalone* badge — but generation is real: the AI calls
never depended on the host. Type `Bubble Sort`, `Stack`, or anything else.

**B) Embedded in a Kiwi class.** Register and enable it (below); the same code
runs inside the class tab, now with `kiwi:context` and `kiwi:updateContext`
grounding Kiwi's own chat panel in what the learner is looking at.

---

## Enabling the app (embedding only)

Registration is now only about getting the iframe into a class tab — the AI
needs none of it. Three records have to exist (the prompt approval that the
old contextual-chat route required is obsolete; `register.sh` may still create
the prompt records, which is harmless):

| # | Record | Why |
| --- | --- | --- |
| 1 | `KiwiAppWhitelist` — `status:'approved'` | admin allows the slug |
| 2 | `KiwiApp` — registered by `register.sh` | the app itself |
| 3 | `KiwiAppUI` + `ClassKiwiApp` — `placement:'class-tab'`, enabled for the class | **without these there is no tab** |

`register.sh` loads `explorable-app/.env` (copy `.env.example`) and needs an
admin session for steps 1 and 3 — see the comments in the script for the
cookie / password / token options. The flow is the standard one from
`KIWI_APP_DEVELOPER_GUIDE.md`: admin whitelist → public register → enable in
class.

### Gotchas that actually bite

- **`uiUrl` must exactly match where you serve the app** (origin *and* path).
  The host pins `event.origin` to it and drops mismatched messages — which
  shows up as the app never receiving `kiwi:context` (the *Standalone* badge
  stays up even though the page is inside Kiwi).
- **No CORS entry in Kiwi's `FRONTEND_URL` is needed for the AI** — the calls
  go to the LiteLLM endpoint, not to the Kiwi backend. (The endpoint's own
  CORS must allow the app's origin; the current one echoes any origin.)

---

## Reading the code

`index.html` is one file in seven labelled parts:

| Part | What |
| --- | --- |
| 2 | the prompts: `SYSTEM_PROMPT`, `PAGE_RULES`, and the head / how-to briefs |
| 3 | `parseJSONLoose` / `repairJSON` for the prose replies, plus `extractControls` |
| 4 | mounting: `finalizeHtml` (fences off, entities decoded, reporter in) |
| 5 | bridge wiring (embedding only) and the event log |
| 6 | the direct AI client: `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`, `llmChat` (SSE streaming, 120 s abort) |
| 7 | the premade catalog (`findPremade`, `premadeArt`) and the pipeline: `fetchHead`, `fetchHowto`, `buildPage`, `generate`, and the `showSkeleton` / `paintHead` / `paintHowto` painters |
| 8 | buttons and the `__explorable` console debug API |

(Parts 1 and 9 — the Simulator's demo runtime and canned fixtures — were
removed when AI went direct; standalone mode now generates for real.)
