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

Nothing is embedding the page, so the SDK's **Simulator** answers locally and the
whole flow still runs — type `Bubble Sort`, `Stack` or `Binary Search` and click
through the result. Register it (see `explorable-app/README.md`) to run it
against a real Kiwi class and a real model.

## What it is

Type a concept; the app asks Kiwi's AI for a small interactive explanation and
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

## What Kiwi actually allows

The app is built around limits read out of the Kiwi source rather than guessed,
because they decide what a generator can and cannot do here:

- **`kiwi:askAI` is not a raw model.** It lands on `POST /student/chat/v2`, the
  student tutor agent, which `agent-loop.service.ts` runs with
  `maxTokensPerIteration: **1500**` under a *"guide students rather than giving
  direct answers"* system prompt, with RAG and site-control tools attached. Asking
  it for a whole interactive page is asking a tutor to do a job it is configured
  to refuse and hasn't got the tokens for.
- **`contextualChat` is.** `POST /api/kiwi-apps/:slug/contextual-chat` calls
  `LlmService.createChat` with the app's *own* registered system prompt and
  `prompt.maxTokens ?? undefined` — so a prompt registered **without** `maxTokens`
  sends no `max_completion_tokens` and is not cut off. `outputSchema` compiles to
  a strict `json_schema`, making the reply a guaranteed-valid instance.
- **The model is a reasoning model** (`gpt-5.x`), so token caps are consumed by
  thinking before any output appears, and `temperature` is ignored entirely.

So the app registers an admin-approved prompt with no `maxTokens`, checks its
token scopes at startup, and takes the uncapped structured route when it can.
When it can't, it splits the job into three calls sized for 1500 tokens — plan,
then logic and view **in parallel** — instead of one that gets truncated. Either
way the model fills three slots in a runtime that already exists, so the wiring
is never the thing that breaks.

The full table, and what happens when an answer is broken anyway, is in
`explorable-app/README.md`.

## Relationship to the reference workspace

The structure, the SDK bundle and `register.sh` are lifted from
`kiwi/kiwi-app-developer-guide-example/`; that workspace and
`KIWI_APP_DEVELOPER_GUIDE.md` remain the source of truth for the protocol. Where
this README cites line-level behaviour it is quoting `kiwi/src/**` as read on the
`kiwi-apps-development` branch — re-check it if the backend moves.

Nothing outside this folder is modified by this project.
