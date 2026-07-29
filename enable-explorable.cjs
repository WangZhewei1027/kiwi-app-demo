/**
 * enable-explorable.cjs — put the Explorable Explanations app on the
 * contextual-chat route, and prove it.
 *
 * The app picks its AI surface from the scopes in its app token
 * (`index.html` PART 6). To get `contextual-chat` instead of `askAI × 4`,
 * `calculateEffectiveScopes` (kiwi-app.service.ts:742) must return BOTH
 * `context:student_learning:read` and `llm:prompt:<PROMPT_ID>`. That needs
 * four rows to line up:
 *
 *   1. KiwiAppWhitelist.maxScopes   — must contain the context scope + a
 *                                     prompt scope (literal or `llm:prompt:*`)
 *   2. KiwiAppUI.uiUrl              — must equal the origin the app is served
 *                                     from, or `kiwi:context` never arrives
 *   3. KiwiAppPrompt.isActive       — admin approval; ALSO the gate that
 *                                     `getActivePrompt` checks inside the call
 *   4. ClassKiwiApp                 — isEnabled for the class you actually open
 *
 * This script makes all four true, idempotently, then re-implements
 * `calculateEffectiveScopes` verbatim and prints the token the app will get.
 *
 * It writes rows directly, bypassing AdminGuard, the DTO validators and the
 * admin UI. Fine for local dev; NOT acceptable against a shared deployment —
 * there, get a real admin session and use register.sh.
 *
 * RUN IT FROM THE `kiwi` BACKEND REPO so @prisma/client and .env resolve:
 *
 *     cd /path/to/kiwi
 *     node /path/to/kiwi-app-demo/enable-explorable.cjs
 *
 * CLASS_ID is read from explorable-app/.env next to this script unless you
 * pass it in the environment. Other optional env: SLUG, PROMPT_ID, APP_URL,
 * TAB_LABEL, ADMIN_EMAIL (who to record as approver), DRY_RUN=1.
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

// This script lives outside the backend repository, so resolve dependencies
// from the Kiwi working directory rather than from this file's directory.
const backendRequire = createRequire(path.join(process.cwd(), "package.json"));
backendRequire("dotenv").config({ path: path.join(process.cwd(), ".env") });
const { PrismaClient } = backendRequire("@prisma/client");

// ---------------------------------------------------------------------------
// settings — the app's own .env wins over guesses, the environment wins over it
// ---------------------------------------------------------------------------

const APP_DIR = path.join(__dirname, "explorable-app");

/** Minimal KEY=value reader for explorable-app/.env (same file register.sh uses). */
function readAppEnv() {
  const file = path.join(APP_DIR, ".env");
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const appEnv = readAppEnv();
const pick = (k, fallback) => process.env[k] || appEnv[k] || fallback;

const SLUG = pick("SLUG", "explorable");
const PROMPT_ID = pick("PROMPT_ID", "explorable-build");
const CLASS_ID = pick("CLASS_ID", "");
const APP_URL = pick("APP_URL", "http://localhost:8000/");
const TAB_LABEL = pick("TAB_LABEL", "Explorables");
const DRY_RUN = process.env.DRY_RUN === "1";

/**
 * The whitelist ceiling. `llm:prompt:*` rather than the literal
 * `llm:prompt:explorable-build` on purpose — see the enabledScopes note below.
 */
const MAX_SCOPES = [
  "context:student_learning:read",
  "llm:prompt:*",
  "user:profile:read",
  "class:info:read",
];

/**
 * What the class grants. Deliberately does NOT list `llm:prompt:*`.
 *
 * calculateEffectiveScopes computes `maxScopes ∩ enabledScopes` first and only
 * THEN appends the scopes of *active* prompts (via the wildcard branch). Leaving
 * the wildcard out of enabledScopes is what makes the token honest: with an
 * unapproved prompt the app sees the missing scope up front and says so, instead
 * of pre-checking green and failing inside the endpoint.
 *
 * (An empty enabledScopes means "inherit all of maxScopes" — which would put the
 * wildcard itself in the token and re-open exactly that blind spot, because both
 * the app's scopeMatches and the backend's requireScope treat a trailing `:*` as
 * a prefix match.)
 */
const ENABLED_SCOPES = [
  "context:student_learning:read",
  "user:profile:read",
  "class:info:read",
];

/** What the app needs before it will choose contextual-chat (index.html PART 6). */
const NEEDED_SCOPES = ["context:student_learning:read", `llm:prompt:${PROMPT_ID}`];

const db = new PrismaClient();
const changes = [];
const note = (s) => changes.push(s);

/** Same matching rule as scope-check.ts:28 and index.html's scopeMatches. */
function scopeMatches(granted, needed) {
  return needed.every((n) =>
    granted.some((g) => g === n || (g.endsWith(":*") && n.startsWith(g.slice(0, -1)))),
  );
}

/** kiwi-app.service.ts:742, re-implemented so the verdict is the real thing. */
function calculateEffectiveScopes({ maxScopes, enabledScopes, activePromptIds }) {
  const base =
    enabledScopes.length > 0 ? maxScopes.filter((s) => enabledScopes.includes(s)) : maxScopes;
  const promptScopes = activePromptIds.map((p) => `llm:prompt:${p}`);
  const final = [...base];
  if (maxScopes.includes("llm:prompt:*")) final.push(...promptScopes);
  else promptScopes.forEach((ps) => maxScopes.includes(ps) && final.push(ps));
  return [...new Set(final)];
}

/** Pull REGISTERED_SYSTEM_PROMPT out of index.html so drift is visible. */
function registeredSystemPromptFromIndexHtml() {
  const file = path.join(APP_DIR, "index.html");
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8");
  const m = /const\s+REGISTERED_SYSTEM_PROMPT\s*=\s*([\s\S]*?);\s*\n/.exec(src);
  if (!m) return null;
  try {
    // The value is a concatenation of quoted literals in the app's own source.
    return new Function(`return ${m[1]}`)();
  } catch {
    return null;
  }
}

(async () => {
  if (!CLASS_ID) {
    const classes = await db.class.findMany({ take: 20, select: { id: true, classMetadata: true } });
    console.error(
      "No CLASS_ID. Set it in explorable-app/.env or pass CLASS_ID=… .\n" +
        "Classes in this database:\n" +
        classes
          .map((c) => `  ${c.id}  ${JSON.stringify(c.classMetadata).slice(0, 80)}`)
          .join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const app = await db.kiwiApp.findUnique({
    where: { slug: SLUG },
    include: { prompts: true, uis: true },
  });
  if (!app) throw new Error(`App "${SLUG}" is not registered — run register.sh step 2 first.`);

  const cls = await db.class.findUnique({ where: { id: CLASS_ID } });
  if (!cls) throw new Error(`Class ${CLASS_ID} not found. Check CLASS_ID in explorable-app/.env.`);

  // Whoever we record as the approver has to be a real admin, so the audit
  // fields mean something even though no guard checked them.
  const admin = process.env.ADMIN_EMAIL
    ? await db.user.findFirst({ where: { email: process.env.ADMIN_EMAIL } })
    : await db.user.findFirst({ where: { systemRole: "admin" } });
  if (!admin) throw new Error('No systemRole:"admin" user found to record as the approver.');

  // ---- 1. whitelist: the scope ceiling ---------------------------------
  const wl = await db.kiwiAppWhitelist.findUnique({ where: { slug: SLUG } });
  if (!wl) throw new Error(`No whitelist entry for "${SLUG}" — an admin has to create it first.`);
  const missingMax = MAX_SCOPES.filter((s) => !(wl.maxScopes || []).includes(s));
  if (wl.status !== "approved") note(`whitelist.status: "${wl.status}" -> "approved"`);
  if (missingMax.length) note(`whitelist.maxScopes += ${missingMax.join(", ")}`);
  if (!DRY_RUN && (missingMax.length || wl.status !== "approved")) {
    await db.kiwiAppWhitelist.update({
      where: { slug: SLUG },
      data: {
        status: "approved",
        // Union, not replace: never silently drop a scope an admin added.
        maxScopes: [...new Set([...(wl.maxScopes || []), ...MAX_SCOPES])],
      },
    });
  }

  // ---- 2. the UI row: origin must match where the app is served ---------
  const ui = app.uis.find((u) => u.placement === "class-tab") || app.uis[0];
  if (!ui) {
    note("! no KiwiAppUI row — there will be no class tab. Re-run register.sh.");
  } else if (ui.uiUrl.replace(/\/$/, "") !== APP_URL.replace(/\/$/, "")) {
    note(`uiUrl: "${ui.uiUrl}" -> "${APP_URL}"  (a mismatch keeps the app in Simulator mode)`);
    if (!DRY_RUN)
      await db.kiwiAppUI.update({ where: { id: ui.id }, data: { uiUrl: APP_URL, isEnabled: true } });
  } else if (!ui.isEnabled) {
    note("uiUrl matches but the UI row is disabled -> enabling");
    if (!DRY_RUN) await db.kiwiAppUI.update({ where: { id: ui.id }, data: { isEnabled: true } });
  }

  // ---- 3. approve the prompt, and keep it uncapped ----------------------
  const prompt = app.prompts.find((p) => p.promptId === PROMPT_ID);
  if (!prompt) throw new Error(`Prompt "${PROMPT_ID}" is not registered for "${SLUG}".`);
  if (!prompt.isActive) note("prompt.isActive: false -> true (this is the admin approval)");
  if (prompt.maxTokens != null)
    note(
      `prompt.maxTokens: ${prompt.maxTokens} -> NULL — app-contextual-chat.service.ts passes ` +
        "`prompt.maxTokens ?? undefined`, so NULL is what keeps generation uncapped",
    );
  if (prompt.temperature != null)
    note(`prompt.temperature: ${prompt.temperature} -> NULL (dropped by the reasoning model anyway)`);

  const wanted = registeredSystemPromptFromIndexHtml();
  if (wanted && wanted !== prompt.systemPrompt)
    note(
      "! systemPrompt in the DB differs from REGISTERED_SYSTEM_PROMPT in index.html " +
        `(${prompt.systemPrompt.length} vs ${wanted.length} chars). Not touched — it is what ` +
        "the admin approved. Re-register if the drift is unintended.",
    );

  const approved = DRY_RUN
    ? prompt
    : await db.kiwiAppPrompt.update({
        where: { appId_promptId: { appId: app.id, promptId: PROMPT_ID } },
        data: {
          isActive: true,
          approvedBy: prompt.approvedBy || admin.id,
          approvedAt: prompt.approvedAt || new Date(),
          maxTokens: null, // deliberately uncapped
          temperature: null, // ignored by the reasoning model anyway
        },
      });

  // ---- 4. bind the app to the class you actually open --------------------
  const existing = await db.classKiwiApp.findUnique({
    where: { classId_appId: { classId: CLASS_ID, appId: app.id } },
  });
  if (!existing) note(`ClassKiwiApp: created for class ${CLASS_ID}`);
  else if (!existing.isEnabled) note("ClassKiwiApp.isEnabled: false -> true");
  const others = await db.classKiwiApp.findMany({
    where: { appId: app.id, NOT: { classId: CLASS_ID } },
    select: { classId: true },
  });
  if (others.length)
    note(
      `note: the app is also bound to ${others.length} other class(es) — ` +
        `${others.map((o) => o.classId).join(", ")}. Only ${CLASS_ID} is configured here.`,
    );

  const enabled = DRY_RUN
    ? existing || { classId: CLASS_ID, isEnabled: true, enabledScopes: ENABLED_SCOPES, tabLabel: TAB_LABEL }
    : await db.classKiwiApp.upsert({
        where: { classId_appId: { classId: CLASS_ID, appId: app.id } },
        update: { isEnabled: true, enabledScopes: ENABLED_SCOPES, tabLabel: TAB_LABEL },
        create: {
          classId: CLASS_ID,
          appId: app.id,
          isEnabled: true,
          enabledScopes: ENABLED_SCOPES,
          enabledBy: admin.id,
          tabLabel: TAB_LABEL,
        },
      });

  // ---- verdict: the token the app will actually be handed ---------------
  // Under DRY_RUN nothing was written, so project what the writes WOULD produce
  // — otherwise the verdict reports the broken state the run is meant to fix.
  const finalWl = await db.kiwiAppWhitelist.findUnique({ where: { slug: SLUG } });
  const activePrompts = await db.kiwiAppPrompt.findMany({
    where: { appId: app.id, isActive: true },
    select: { promptId: true },
  });
  const activePromptIds = [...new Set([...activePrompts.map((p) => p.promptId), PROMPT_ID])];
  const scopes = calculateEffectiveScopes({
    maxScopes: DRY_RUN
      ? [...new Set([...(finalWl.maxScopes || []), ...MAX_SCOPES])]
      : finalWl.maxScopes || [],
    enabledScopes: DRY_RUN ? ENABLED_SCOPES : enabled.enabledScopes || [],
    activePromptIds,
  });
  const contextual = scopeMatches(scopes, NEEDED_SCOPES);

  console.log(`\n${DRY_RUN ? "would change" : "changed"}:`);
  console.log(changes.length ? changes.map((c) => "  · " + c).join("\n") : "  (nothing — already set up)");
  console.log("\nprompt  :", {
    promptId: approved.promptId,
    isActive: approved.isActive,
    maxTokens: approved.maxTokens,
    approvedBy: approved.approvedBy,
  });
  console.log("classApp:", {
    classId: enabled.classId,
    isEnabled: enabled.isEnabled,
    tabLabel: enabled.tabLabel,
    enabledScopes: enabled.enabledScopes,
  });
  console.log(`token scopes${DRY_RUN ? " (projected)" : ""}:`, scopes);
  console.log(
    `\n=> AI route${DRY_RUN ? " after these changes" : ""}: ` +
      `${contextual ? "contextual-chat  ✅" : "askAI × 4  ❌"}` +
      (contextual
        ? "  (uncapped, this app's own system prompt, no tutor agent, no tools)"
        : `  — missing ${NEEDED_SCOPES.filter((s) => !scopeMatches(scopes, [s])).join(", ")}`),
  );
  console.log(
    `\nServe the app at ${APP_URL}, open the class -> "${TAB_LABEL}" tab, and check the note\n` +
      "under the Generate button. Green \"contextual-chat\" means it took. If it still says\n" +
      "askAI, the bridge log will name the reason.",
  );
})()
  .catch((e) => {
    console.error("failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
