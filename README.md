# kiwi-app-demo

**Explorable Explanations** is an external Kiwi App that turns a concept into
an interactive page. It loads a curated visualization when one is available;
otherwise it generates a page with AI and renders it in a sandboxed iframe.

## Run locally

Use Node.js 22 and run from the repository root:

```bash
cp .env.example .env.local
# Fill AI_BASE_URL, AI_API_KEY and AI_MODEL in .env.local.
npx vercel dev --listen 8000
```

Open `http://localhost:8000/explorable-app/`. No Kiwi backend is needed for
standalone use. The root `.env.local` holds model configuration; the separate
`explorable-app/.env` is used only by the Kiwi registration script.

## Deploy to Vercel

Import this repository with the **Other** framework preset and repository root
as the root directory. Set `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` as server
environment variables in Vercel, then deploy. `vercel.json` configures the build
and the streaming `/api/chat` function. Never expose the key through a public
environment-variable prefix or frontend configuration.

The frontend calls `/api/chat`; only the function adds the upstream Bearer key.
The Kiwi bridge carries embedding and context updates only. Each generated run
still uses three calls: page and title/concept in parallel, then instructions
after the controls exist. Curated pages replace only the page-generation call.

GitHub Pages supports only the static page and curated visualizations. AI
generation requires the Vercel deployment. For Kiwi embedding, register the
Vercel app URL through administrator whitelist → registration → class enablement.

See [the app documentation](explorable-app/README.md) for setup, public-demo
limits, the generation pipeline and embedding instructions. The source
repository's previously exposed key must be rotated; rewriting Git history
cannot revoke downloaded copies.

## Verify

```bash
npm test
npm run build
```

Tests use mocked model responses. The static build copies only the HTML pages,
SDK and curated catalog into `public/`; environment files and backend code are
not static assets.

## Layout

```text
api/chat.mjs            # Vercel streaming proxy, server-only environment
explorable-app/         # frontend, bundled Kiwi SDK, curated catalog
scripts/build.mjs      # public asset allowlist
tests/                 # proxy regression tests
vercel.json            # deployment settings
```
