# kiwi-app-demo

An external **Kiwi App** that turns a concept into something a learner can click.

```
kiwi-app-demo/
├── README.md            ← you are here
├── AGENTS.md            ← working rules for agents editing this repo
└── explorable-app/      ← the app (self-contained, no build step)
    ├── index.html
    ├── README.md        ← the limits, the pipeline, how to register
    ├── register.sh
    └── kiwi-app-sdk/
```

## Quick start

```bash
cd explorable-app
python3 -m http.server 8000
open http://localhost:8000/
```

Generation works immediately — the app calls the model API directly, so no
Kiwi backend is needed. Type `Bubble Sort`, `Stack` or `Binary Search` and
click through the result. Register it (see `explorable-app/README.md`) only if
you want it embedded as a tab inside a real Kiwi class.

## What it is

Type a concept; the app asks an AI model for a small interactive explanation and
renders it in a sandboxed iframe. Bars you step through, a stack you push onto —
the kind of page where the interaction *is* the explanation.

It follows the framing in *Evaluating Interactivity: Toward Automated Assessment
of AI-Generated Explorable Explanations* (Wang, Wang & Wen): what makes an
explorable explanation good is its **interaction model** — the states a learner
can reach and the actions that move between them — not its markup. The paper
extracts that model *after* generation, as an FSM, in order to score it. This app
puts it first and makes it the build artifact: the model declares the state and
the controls, then writes the actions that move between them. The interaction
model is shown in the UI before the page exists.

## How it talks to the model

AI calls go **directly** to an OpenAI-compatible LiteLLM endpoint
(`AI_BASE_URL` / `AI_MODEL` in `index.html` PART 6), streamed as SSE. The Kiwi
bridge carries only the embedding protocol (`kiwi:ready` / `kiwi:context` /
`kiwi:updateContext`) — the old two-surface split between Kiwi's capped
`kiwi:askAI` tutor agent and the uncapped `contextualChat` op is gone, along
with the app token, the scope checks, and the prompt approval flow they
required.

Each run is three calls: the complete page (raw HTML, streamed, with the app's
own system prompt), plus a title/concept call fired in parallel and a how-to
call once the controls exist. Output is uncapped; the app enforces its own
120-second abort and a character budget in the prompt for latency.

The full pipeline, and what happens when an answer is broken anyway, is in
`explorable-app/README.md`.

## Relationship to the reference workspace

The structure, the SDK bundle and `register.sh` are lifted from
`kiwi/kiwi-app-developer-guide-example/`; that workspace and
`KIWI_APP_DEVELOPER_GUIDE.md` remain the source of truth for the protocol. Where
this README cites line-level behaviour it is quoting `kiwi/src/**` as read on the
`kiwi-apps-development` branch — re-check it if the backend moves.

Nothing outside this folder is modified by this project.
