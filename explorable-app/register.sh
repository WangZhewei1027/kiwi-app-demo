#!/usr/bin/env bash
#
# register.sh — register the Explorable Explanations app with a local Kiwi.
#
# Registration order is strict (KIWI_APP_DEVELOPER_GUIDE.md §4):
#
#     [admin] whitelist (approved) -> [dev] register -> [admin] enable in class
#                                                    -> [admin] approve prompt
#
# THE POINT OF STEP 2 AND STEP 4
# ------------------------------
# This app has two ways to reach a model and they are not equivalent:
#
#   kiwi:askAI       -> POST /student/chat/v2 -> the student tutor agent.
#                       agent-loop.service.ts runs it with
#                       maxTokensPerIteration: 1500 on a gpt-5.x reasoning
#                       model, under Kiwi's "guide, don't answer" system prompt,
#                       with RAG / code-interpreter / site-control tools bolted
#                       on. Always available, but a poor code generator.
#
#   contextual-chat  -> POST /api/kiwi-apps/:slug/contextual-chat -> straight to
#                       LlmService.createChat with THIS app's registered system
#                       prompt, no agent, no tools, and:
#
#                         const response = await this.llmService.createChat(
#                           messages, prompt.temperature ?? undefined,
#                           prompt.maxTokens ?? undefined, …);
#
#                       `prompt.maxTokens ?? undefined` is the whole trick: a
#                       prompt registered WITHOUT maxTokens sends no
#                       max_completion_tokens at all, so the answer is not
#                       truncated. (Registering an explicit value would cap it,
#                       and register-app.dto.ts refuses anything over 4096.)
#                       So: the prompt below deliberately sets NO maxTokens.
#                       It also sets no temperature — the openai engine is a
#                       reasoning model and llm.service.ts drops temperature for
#                       those anyway.
#
# The app checks its token's scopes at startup and uses contextual-chat when both
# `context:student_learning:read` and `llm:prompt:explorable-build` are present,
# otherwise it falls back to askAI and says so in the UI.
#
# THE ADMIN STEPS NEED A SESSION COOKIE, NOT A BEARER TOKEN
# ---------------------------------------------------------
# AdminGuard (kiwi/src/auth/auth.guard.ts:23) reads request.session.userId and
# nothing else — there is no global JwtAuthGuard in app.module.ts to turn a
# bearer token into a session first. So steps 1, 3 and 4 always 401 with a bare
# minted JWT, no matter how valid it is.
#
# POST /auth/login is @Public(), and authenticating sets req.session.userId
# server-side (auth.service.ts:294) with the session id handed back as a cookie.
# So: log in with a cookie jar and reuse the jar. That works against a deployed
# Kiwi too, which the Prisma-seed route (hello-kiwi-app README, Route B) does
# not — it needs direct database access and bypasses every guard and audit
# field, which is fine locally and unacceptable in production.
#
# Usage (scripted, works locally and against a real deployment):
#     KIWI=https://kiwi.example.edu \
#     ADMIN_EMAIL=admin@example.edu ADMIN_PASSWORD='…' \
#     APP_URL=https://explorables.example.edu/ \
#     CLASS_ID=<classId> \
#     ./register.sh
#
# Without ADMIN_EMAIL/ADMIN_PASSWORD the admin steps are skipped and printed as
# instructions instead; do them in the admin UI at /admin/kiwi-apps (Whitelist
# tab, then Registered Apps -> the app -> Prompts -> Approve) and
# /admin/class/<classID>/kiwi-apps. Step 2 (register) is a public endpoint and
# always runs. See README.md -> "Approving the explorable-build prompt".
#
# The session is a 1-hour cookie backed by PrismaSessionStore (main.ts:45) and
# is `secure` whenever API_DOMAIN is set, i.e. HTTPS-only on a real deployment.
# Password login does not work for SSO-only admin accounts — use the UI there.

set -euo pipefail

# Load local registration settings when present. Values in this file override
# inherited environment variables and are then used by the defaults below.
#
# One file per Kiwi instance: point ENV_FILE at the one you mean. Without this
# the hardcoded .env wins over anything passed on the command line — including
# KIWI — and a run aimed at a deployment silently retargets localhost.
#     ENV_FILE=./.env.playground ./register.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# ---- Config (override via env) ----
KIWI="${KIWI:-http://localhost:3000}"           # Kiwi backend base URL
SLUG="${SLUG:-explorable}"                      # app id (matches appSlug in index.html)
# The whitelist entry's plaintext secret. MUST be >= 32 characters: both
# whitelist-app.dto.ts (@MinLength(32)) and the admin UI's Add button enforce it,
# so the usual "dev-secret" is rejected. If an admin created the entry through
# /admin/kiwi-apps, use the value from its one-time "Save Your Registration
# Secret" dialog — this default only works if step 1 below created the entry.
SECRET="${SECRET:-change-me-explorable-registration-secret}"
# Where YOU serve index.html — the EXACT URL, origin *and* path. The host pins
# postMessage to this origin and loads the iframe from this URL. Serving the
# explorable-app/ folder puts the app at the server root, hence the trailing
# slash; if you serve the repo root instead, register …:8000/explorable-app/.
APP_URL="${APP_URL:-http://localhost:8000/}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"                  # admin login — this is what actually authorises
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"                  # optional; sent too, but AdminGuard ignores it
CLASS_ID="${CLASS_ID:-}"                        # optional: enable the app in this class
TAB_LABEL="${TAB_LABEL:-Explorables}"
PROMPT_ID="${PROMPT_ID:-explorable-build}"

# `llm:prompt:explorable-build` is what unlocks the prompt for the app token;
# `context:student_learning:read` is required by the contextual-chat endpoint
# itself. The other two only feed the context strip.
SCOPES='["context:student_learning:read","llm:prompt:explorable-build","user:profile:read","class:info:read"]'

# Kept identical to REGISTERED_SYSTEM_PROMPT in index.html — the app assumes this
# text is what the model is running under. The build contract itself travels in
# `userMessage` (≤8000 chars per app-data.dto.ts), so iterating on it does NOT
# need another admin approval.
SYSTEM_PROMPT="You are the generator behind Kiwi's Explorable Explanations app. Given a computer-science concept you produce a complete, self-contained interactive web page that teaches it: controls the learner presses, a picture that changes, and a status line that explains every step in one plain sentence. You write one HTML document with all CSS and JavaScript inline, no external resources, no libraries. You are not tutoring and not chatting: emit only the requested artifact. Favour one clear idea made visible over a feature list, and make every action explain itself in one sentence a learner would understand."

say()  { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
pp() { if command -v python3 >/dev/null 2>&1; then python3 -m json.tool 2>/dev/null || cat; else cat; fi; }

COOKIE_JAR="$(mktemp -t kiwi-session.XXXXXX)"
trap 'rm -f "$COOKIE_JAR"' EXIT
ADMIN_READY=0
COOKIE_ARGS=(-b "$COOKIE_JAR" -c "$COOKIE_JAR")

# express-session writes an httpOnly cookie, which curl stores with a
# "#HttpOnly_" PREFIX — so "is the jar non-empty" and "does it have a non-comment
# line" are both useless tests. Look for the cookie by name.
session_ok() { grep -qi 'connect\.sid' "$COOKIE_JAR" 2>/dev/null; }

admin_curl() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS "${COOKIE_ARGS[@]}" -X "$method" "$KIWI$path" \
      -H "Content-Type: application/json" -d "$data"
  else
    curl -sS "${COOKIE_ARGS[@]}" -X "$method" "$KIWI$path" -H "Content-Type: application/json"
  fi
}

# -----------------------------------------------------------------------------
say "0/4  Get an admin SESSION — AdminGuard reads request.session.userId, nothing else"
if [ -n "${SESSION_COOKIE:-}" ]; then
  # Straight from the browser: DevTools -> Application -> Cookies -> connect.sid.
  # DevTools shows the NAME and the VALUE in separate columns, so accept a bare
  # value too — a Cookie header without a name is silently ignored by the server
  # and looks exactly like a rejected session.
  case "$SESSION_COOKIE" in
    *=*) ;;
    *) SESSION_COOKIE="${SESSION_COOKIE_NAME:-connect.sid}=$SESSION_COOKIE"
       printf '  no cookie name given — assuming %s\n' "${SESSION_COOKIE%%=*}" ;;
  esac
  COOKIE_ARGS=(-H "Cookie: $SESSION_COOKIE")
  ADMIN_READY=1
  printf '  using SESSION_COOKIE from the environment\n'

elif [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  LOGIN_BODY=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' \
    "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  LOGIN_RESPONSE=$(curl -sS -c "$COOKIE_JAR" -X POST "$KIWI/auth/login" \
    -H "Content-Type: application/json" -d "$LOGIN_BODY" || true)
  if session_ok; then
    ADMIN_READY=1
    printf '  logged in as %s, session cookie stored\n' "$ADMIN_EMAIL"
  else
    warn "login did not return a session cookie. The server said:"
    printf '%s\n' "$LOGIN_RESPONSE" | pp
  fi

elif [ -n "$ADMIN_TOKEN" ]; then
  # A bearer token cannot satisfy AdminGuard directly, but JwtAuthGuard
  # (auth.guard.ts:~226) REGENERATES the session and writes session.userId when
  # one is missing. So call any JwtAuthGuard-protected endpoint once with the
  # token and a cookie jar, and the jar comes back holding an admin session.
  # This is exactly why the browser works: /auth/profile bootstraps it there too.
  curl -sS -c "$COOKIE_JAR" "$KIWI/auth/profile" \
    -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1 || true
  if session_ok; then
    ADMIN_READY=1
    printf '  bootstrapped a session from ADMIN_TOKEN via GET /auth/profile\n'
  else
    warn "ADMIN_TOKEN did not bootstrap a session (expired or not an admin?)"
  fi
fi

# Prove the session before spending three calls on it: GET /api/kiwi-apps/whitelist
# is AdminGuard-protected and read-only, so it answers exactly the question the
# admin steps care about — is this an admin session or not.
if [ "$ADMIN_READY" -eq 1 ]; then
  PROBE=$(admin_curl GET "/api/kiwi-apps/whitelist" || true)
  case "$PROBE" in
    *'"statusCode":401'*|*'"statusCode": 401'*|*Unauthorized*)
      ADMIN_READY=0
      warn "the session was rejected by AdminGuard. GET /api/kiwi-apps/whitelist said:"
      printf '%s\n' "$PROBE" | pp
      warn "Sessions last 1 hour (main.ts SESSION_MAX_AGE) — a cookie copied a while"
      warn "ago is simply stale. Reload the admin page in the browser and re-copy it."
      ;;
    '')
      ADMIN_READY=0
      warn "the probe returned nothing — is $KIWI actually the backend? (kiwi-ui is :3001)"
      ;;
    *)
      printf '  session accepted by AdminGuard\n' ;;
  esac
fi

if [ "$ADMIN_READY" -eq 0 ]; then
  warn "No usable admin session — steps 1, 3 and 4 will be skipped."
  warn "Fixes, cheapest first:"
  warn "  · SESSION_COOKIE='connect.sid=s%3A…'  — copy it from the browser you are"
  warn "    already logged into: DevTools -> Application -> Cookies -> $KIWI"
  warn "    (the bare value works too; the name defaults to connect.sid)"
  warn "  · ADMIN_EMAIL=… ADMIN_PASSWORD=…      — fails for SSO-only accounts"
  warn "  · ADMIN_TOKEN=eyJ…                    — bootstraps a session via /auth/profile"
fi

# -----------------------------------------------------------------------------
say "1/4  Whitelist '$SLUG' (admin) — POST /api/kiwi-apps/whitelist"
if [ "$ADMIN_READY" -eq 0 ]; then
  warn "no admin session — skipping. Do it at /admin/kiwi-apps -> Whitelist -> ADD TO WHITELIST"
  warn "  App Slug: $SLUG   Status: Approved   Secret: >= 32 chars (copy it, shown once)"
  warn "  Maximum Allowed Scopes: $SCOPES"
elif [ "${SKIP_WHITELIST:-0}" = "1" ]; then
  warn "SKIP_WHITELIST=1 — leaving the existing entry alone (it holds the secret you already have)."
else
  admin_curl POST "/api/kiwi-apps/whitelist" "{
      \"slug\": \"$SLUG\",
      \"registrationSecret\": \"$SECRET\",
      \"baseUrl\": \"$APP_URL\",
      \"status\": \"approved\",
      \"description\": \"Generates a small interactive explanation of a concept on demand\",
      \"maxScopes\": $SCOPES
    }" | pp || warn "whitelist call failed (it may already exist — that's fine)"
fi

# -----------------------------------------------------------------------------
say "2/4  Register '$SLUG' + the uncapped build prompt — POST /api/kiwi-apps/register"
# NOTE: no "maxTokens" and no "temperature" on the prompt. That is deliberate —
# see the header. Adding maxTokens here is the single easiest way to make this
# app generate truncated, low-quality pages again.
REG_RESPONSE=$(python3 - "$SLUG" "$SECRET" "$APP_URL" "$PROMPT_ID" "$SYSTEM_PROMPT" <<'PY' | curl -sS -X POST "$KIWI/api/kiwi-apps/register" -H "Content-Type: application/json" -d @-
import json, sys
slug, secret, url, prompt_id, system_prompt = sys.argv[1:6]
print(json.dumps({
    "slug": slug,
    "registrationSecret": secret,
    "name": "Explorable Explanations",
    "description": "Ask for a concept, get a small interactive explanation you can click",
    "baseUrl": url,
    "appType": "frontend_only",
    "capabilities": ["ai"],
    "uis": [{
        "uiSlug": "student",
        "uiName": "Explorable Explanations",
        "uiUrl": url,
        "placement": "class-tab",
        "allowedRoles": ["student", "ta", "instructor", "admin"],
        "tabOrder": 0,
    }],
    "prompts": [{
        "promptId": prompt_id,
        "name": "Explorable Explanation Builder",
        "description": "Builds the state/actions/render slots of an interactive explanation. Registered without maxTokens on purpose so the answer is not truncated.",
        "systemPrompt": system_prompt,
    }],
}))
PY
)
echo "$REG_RESPONSE" | pp

APP_ID=$(printf '%s' "$REG_RESPONSE" | python3 -c \
  'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)

# -----------------------------------------------------------------------------
say "3/4  Enable in class (admin) — POST /api/classes/$CLASS_ID/apps"
if [ -z "$CLASS_ID" ]; then
  warn "CLASS_ID not set — skipping. Set CLASS_ID=<id> to enable '$SLUG' as a tab in that class."
elif [ "$ADMIN_READY" -eq 0 ]; then
  warn "no admin session — skipping. Do it at /admin/class/$CLASS_ID/kiwi-apps (leave enabledScopes empty to inherit all maxScopes)."
elif [ -z "$APP_ID" ]; then
  warn "Could not read the app id from the register response — cannot enable. Check step 2 output."
else
  admin_curl POST "/api/classes/$CLASS_ID/apps" "{
      \"appId\": \"$APP_ID\",
      \"tabLabel\": \"$TAB_LABEL\",
      \"enabledScopes\": $SCOPES
    }" | pp || warn "enable call failed"
fi

# -----------------------------------------------------------------------------
say "4/4  Approve the prompt (admin) — POST /api/kiwi-apps/$SLUG/prompts/$PROMPT_ID/approve"
# Prompts register inactive. Until an admin approves it, getActivePrompt() throws
# Forbidden and llm:prompt:$PROMPT_ID never lands in the app token — which is
# exactly when the app drops back to the 1500-token askAI path.
if [ "$ADMIN_READY" -eq 0 ]; then
  warn "no admin session — skipping. Approve it at /admin/kiwi-apps -> Registered Apps -> $SLUG -> Prompts -> Approve,"
  warn "or the app silently runs on the 1500-token askAI route."
else
  admin_curl POST "/api/kiwi-apps/$SLUG/prompts/$PROMPT_ID/approve" \
    | pp || warn "approve call failed (may already be approved — that's fine)"
fi

# -----------------------------------------------------------------------------
say "Done."
echo "Next:"
echo "  • Serve THIS folder (self-contained; the app sits at the server root):"
echo "        python3 -m http.server 8000"
echo "  • Confirm the app loads at exactly:  $APP_URL"
echo "    A mismatch means kiwi:context never arrives and the app sits in Simulator mode."
echo "  • Open the class in Kiwi — the \"$TAB_LABEL\" tab should appear."
echo "  • The note under the Generate button tells you which route it got. If it says"
echo "    kiwi:askAI, the app token is missing a scope — re-check steps 1, 3 and 4."
echo "  • No FRONTEND_URL/CORS entry is needed: both routes are proxied by the host."
