# Technical Spec: Meeting Enhance v3 (agentic workflow, structured output, LLM inspector)

**Status:** Draft. Awaiting owner approval.
**Author:** Claude Code coordinator, with Sonnet writers.
**Date:** 2026-10-17
**Tracking:** Umbrella issue #185. Draft PR #186. Origin issue #163.
**Scope:** meeting LLM code, model layer, DB schema (migration 40) and routes, AI SDK v7 upgrade, shared types, renderer meetings pages, tests, scripts. Sections 3 to 11 name the files.
**Baseline:** `main` at `c47cd80d` (release 2.17.1). Every `file:line` was read on that tree. Re-verify before you implement.
**Rules:** ASD-STE100. No em-dashes. `file:line` for current-state claims. A URL for external claims. UNVERIFIED for unchecked claims.

**Table of contents**

- [1. Problem and goals](#1-problem-and-goals)
  - [1.1 Owner decisions (2026-10-17)](#11-owner-decisions-2026-10-17)
  - [1.2 Goals](#12-goals)
  - [1.3 Non-goals](#13-non-goals)
  - [1.4 Glossary](#14-glossary)
- [2. Current state (baseline c47cd80d)](#2-current-state-baseline-c47cd80d)
  - [2.1 End-to-end flow, from stop or import to a saved summary](#21-end-to-end-flow-from-stop-or-import-to-a-saved-summary)
  - [2.2 Flowchart of today's Enhance and Summary path](#22-flowchart-of-todays-enhance-and-summary-path)
  - [2.3 Problems](#23-problems)
- [3. Target architecture](#3-target-architecture)
  - [3.1 Components and files](#31-components-and-files)
  - [3.2 The workflow graph](#32-the-workflow-graph)
  - [3.3 Graph state](#33-graph-state)
  - [3.4 Run lifecycle](#34-run-lifecycle)
  - [3.5 Concurrency](#35-concurrency)
  - [3.6 Summary: one graph with a list of stages](#36-summary-one-graph-with-a-list-of-stages)
  - [3.7 Open questions, checks for other sections, unverified items](#37-open-questions-checks-for-other-sections-unverified-items)
- [4. Node specifications](#4-node-specifications)
  - [4.0 Rules for all nodes](#40-rules-for-all-nodes)
  - [4.1 Node `prepare`](#41-node-prepare)
  - [4.2 Node `correctChunk`](#42-node-correctchunk)
  - [4.3 Node `identifySpeakers`](#43-node-identifyspeakers)
  - [4.4 Node `verifyEvidence`](#44-node-verifyevidence)
  - [4.5 Node `summarize`](#45-node-summarize)
  - [4.6 Node `save`](#46-node-save)
  - [4.7 Open points for the owner](#47-open-points-for-the-owner)
  - [4.8 Unverified in this section](#48-unverified-in-this-section)
- [5. LLM gateway contract](#5-llm-gateway-contract)
  - [5.0 What the gateway replaces](#50-what-the-gateway-replaces)
  - [5.1 The function `callStructured`](#51-the-function-callstructured)
  - [5.2 Typed errors](#52-typed-errors)
  - [5.3 The acceptance gate](#53-the-acceptance-gate)
  - [5.4 Structured-output mode for each provider](#54-structured-output-mode-for-each-provider)
  - [5.5 Reasoning profile](#55-reasoning-profile)
  - [5.6 Retries](#56-retries)
  - [5.7 Timeouts, cancel and lanes](#57-timeouts-cancel-and-lanes)
  - [5.8 Privacy](#58-privacy)
  - [5.9 Proof the gateway needs](#59-proof-the-gateway-needs)
  - [5.10 Proposals, risks and open points](#510-proposals-risks-and-open-points)
- [6. AI SDK v7 migration](#6-ai-sdk-v7-migration)
  - [6.1 Decision and rules](#61-decision-and-rules)
  - [6.2 Current state (baseline c47cd80d)](#62-current-state-baseline-c47cd80d)
  - [6.3 Target versions](#63-target-versions)
  - [6.4 Per-file checklist](#64-per-file-checklist)
  - [6.5 Renames and API facts](#65-renames-and-api-facts)
  - [6.6 Module format](#66-module-format)
  - [6.7 Mixed copies of `ai` (the trap)](#67-mixed-copies-of-ai-the-trap)
  - [6.8 Behavior changes that matter](#68-behavior-changes-that-matter)
  - [6.9 Proof of no behavior change](#69-proof-of-no-behavior-change)
  - [6.10 What the package must not do](#610-what-the-package-must-not-do)
  - [6.11 Open items](#611-open-items)
  - [6.12 Sources](#612-sources)
- [7. Persistence](#7-persistence)
  - [7.1 Current state](#71-current-state)
  - [7.2 Design rules](#72-design-rules)
  - [7.3 Migration 40](#73-migration-40)
  - [7.4 DDL](#74-ddl)
  - [7.5 JSON column shapes](#75-json-column-shapes)
  - [7.6 Enumerations](#76-enumerations)
  - [7.7 The recorder](#77-the-recorder)
  - [7.8 How a reader finds the link that is still true](#78-how-a-reader-finds-the-link-that-is-still-true)
  - [7.9 Checkpoint tables](#79-checkpoint-tables)
  - [7.10 Indexes](#710-indexes)
  - [7.11 Size estimate](#711-size-estimate)
  - [7.12 Retention, delete and boot sweep](#712-retention-delete-and-boot-sweep)
  - [7.13 Proof run](#713-proof-run)
  - [7.14 Files that change in section 7](#714-files-that-change-in-section-7)
  - [7.15 Open questions for section 12](#715-open-questions-for-section-12)
- [8. LLM inspector](#8-llm-inspector)
  - [8.1 Current state](#81-current-state)
  - [8.2 Decisions of this section](#82-decisions-of-this-section)
  - [8.3 API](#83-api)
  - [8.4 Types](#84-types)
  - [8.5 Renderer data layer](#85-renderer-data-layer)
  - [8.6 Entry points and layout](#86-entry-points-and-layout)
  - [8.7 Panel content](#87-panel-content)
  - [8.8 Design tokens](#88-design-tokens)
  - [8.9 Persisted run status replaces the component Enhance error state](#89-persisted-run-status-replaces-the-component-enhance-error-state)
  - [8.10 i18n](#810-i18n)
  - [8.11 Files that change in section 8](#811-files-that-change-in-section-8)
  - [8.12 Tests and proof](#812-tests-and-proof)
  - [8.13 Open questions for section 12](#813-open-questions-for-section-12)
- [9. Tracing](#9-tracing)
  - [9.1 Decisions](#91-decisions)
  - [9.2 Current state (main at c47cd80d)](#92-current-state-main-at-c47cd80d)
  - [9.3 The three records](#93-the-three-records)
  - [9.4 The trace log: what stays and why](#94-the-trace-log-what-stays-and-why)
  - [9.5 MLflow export](#95-mlflow-export)
  - [9.6 Span model (T5, T6)](#96-span-model-t5-t6)
  - [9.7 Privacy and failure isolation (T7, T8)](#97-privacy-and-failure-isolation-t7-t8)
  - [9.8 Bundle size and load cost](#98-bundle-size-and-load-cost)
  - [9.9 Verification](#99-verification)
  - [9.10 Hand-offs to other sections](#910-hand-offs-to-other-sections)
  - [9.11 Open questions for the owner](#911-open-questions-for-the-owner)
- [10. Test plan and definition of done](#10-test-plan-and-definition-of-done)
  - [10.1 Levels of proof](#101-levels-of-proof)
  - [10.2 Rules for every test](#102-rules-for-every-test)
  - [10.3 What exists today](#103-what-exists-today)
  - [10.4 Goal-to-proof map](#104-goal-to-proof-map)
  - [10.5 Gateway tests (sections 5 and 6)](#105-gateway-tests-sections-5-and-6)
  - [10.6 Node tests (section 4)](#106-node-tests-section-4)
  - [10.7 Saver tests (WP4)](#107-saver-tests-wp4)
  - [10.8 Graph and runner tests (WP5)](#108-graph-and-runner-tests-wp5)
  - [10.9 Migration, store and route tests (WP2)](#109-migration-store-and-route-tests-wp2)
  - [10.10 Renderer tests and locales (WP7)](#1010-renderer-tests-and-locales-wp7)
  - [10.11 End-to-end tests in the real app](#1011-end-to-end-tests-in-the-real-app)
  - [10.12 Live proof on the owner's oMLX](#1012-live-proof-on-the-owners-omlx)
  - [10.13 Tracing proof (WP8)](#1013-tracing-proof-wp8)
  - [10.14 Bundle and packaging checks (WP1, WP5, WP8, WP9)](#1014-bundle-and-packaging-checks-wp1-wp5-wp8-wp9)
  - [10.15 Quality gate: benchmarks and the council (WP10a, WP10b)](#1015-quality-gate-benchmarks-and-the-council-wp10a-wp10b)
  - [10.16 Evidence, who runs what, cleanup](#1016-evidence-who-runs-what-cleanup)
  - [10.17 Definition of done for each work package](#1017-definition-of-done-for-each-work-package)
  - [10.18 Open points](#1018-open-points)
- [11. Work breakdown and build orchestration](#11-work-breakdown-and-build-orchestration)
  - [11.1 Build rules](#111-build-rules)
  - [11.2 Work packages at a glance](#112-work-packages-at-a-glance)
  - [11.3 Dependency graph and waves](#113-dependency-graph-and-waves)
  - [11.4 File ownership and conflict matrix](#114-file-ownership-and-conflict-matrix)
  - [11.5 Work package cards](#115-work-package-cards)
  - [11.6 Agent roles and the three Haiku checks](#116-agent-roles-and-the-three-haiku-checks)
  - [11.7 Merge order](#117-merge-order)
- [12. Risks, open questions and rollout](#12-risks-open-questions-and-rollout)
  - [12.1 Risks](#121-risks)
  - [12.2 Open questions for the owner](#122-open-questions-for-the-owner)
  - [12.3 Rollout plan](#123-rollout-plan)
  - [12.4 Data compatibility](#124-data-compatibility)

**Reference conventions.**

- A number such as 4.0.6 points to a heading in this file.
- An ID such as P9 or U3 is local to the section that defines it. A reference from another section names that section, for example "4.1 P9" or "3.7 U3".
- Tables 1 to 3 and Figures 1 and 2 are numbered in document order. Other tables have no number.
- Where two sections give one thing two names, the register in 11.4 and the checks in 3.7 name the conflict and the work package that settles it.

---

## 1. Problem and goals

Enhance (an LLM pass) improves a meeting transcript. A second pass writes the summary. Both call `defaultChatCallFor`: Enhance at `apps/server/src/lib/meetings/enhance.ts:375` and the summary pass at `apps/server/src/lib/meetings/summarize.ts:390`. The function is defined at `apps/server/src/lib/meetings/llm-call.ts:69`. One call does two jobs (P1), the answer has no schema (P2), only `length` is an error (P3, P4), a failed chunk is skipped with no retry (P5), failures show only in the server log (P7), no call leaves a record (P10), and a run cannot resume (P9). Section 2.3 holds the evidence.

**Issue #163** (https://github.com/Maheidem/openstyle/issues/163). On an 8-chunk owner meeting (local oMLX, Qwen3.8-27B), 2 of 8 chunks failed in 6 of 6 tries, so a plain retry does not help. Two chunks ended with `length`. One returned invalid JSON with `stop`. The model writes the `speakers` block first and reasons inside `evidence`, so the corrections after it are lost. Chunk 0 held the only grounded self-introduction, and its failure lost the speaker names of chunks 1 to 7 (2.3 P6). D1 goes further than the three fixes of the issue.

### 1.1 Owner decisions (2026-10-17)

**D1. Shape: an agentic workflow with specialized steps.**
- Decision: The pipeline is a workflow of steps. One LLM call never does two jobs. Steps: (1) prepare (code); (2) correct text for each chunk (LLM, fan-out); (3) identify speakers (LLM); (4) verify evidence (code); (5) summarize (LLM, map and reduce when long); (6) save, with a status for each step (code). Section 4 fixes the list.
- Reason: In #163 the speaker block caused the `length` stops. The evidence check is already code (`apps/server/src/lib/meetings/enhance.ts:328-356`).

**D2. Always structured output.**
- Decision: Every LLM step returns an answer that one fixed zod schema validates.
- Reason: A stray quote in one `evidence` string broke a chunk in #163. Each new schema adds about 0.45 GB to the oMLX grammar cache (https://github.com/jundot/omlx/issues/4321). Whether local oMLX enforces a strict `json_schema` is UNVERIFIED (section 10).

**D3. Reasoning follows a profile per model and per provider.**
- Decision: Reasoning (thinking) follows the model and the provider through a profile (section 5). For oMLX with Qwen, keep the full parameter set that the app already sends (`chat_template_kwargs` and presets, `apps/server/src/lib/llm/task-profiles.ts:355-368`). The preset the owner stored is UNVERIFIED.
- Reason: AI SDK v7 lets a provider-specific setting override its `reasoning` option without a warning (section 5).

**D4. Every finish reason other than `stop` is a handled error.**
- Decision: Table 1 gives the routes. Valid JSON with a non-`stop` reason is still an error. Every failure is typed and shows per step in the UI.
- Reason: AI SDK v7 returns valid JSON that ended with `length` or `content-filter` without an error (section 6).

Table 1. Route for each unified finish reason (D4).

| Unified finish reason | Route |
|---|---|
| `stop` | Success, after the other checks of the gateway (section 5). |
| `length` | Split the input or raise the output budget. If the call still ends with `length`, fail with a typed error. |
| `content-filter` | Fail with a typed error. Do not retry. |
| `tool-calls` (unexpected) | Fail with a typed error. |
| `error`, `other` | Retry once with backoff. Then fail with a typed error. |

**D5. Orchestrator: LangGraph.js.**
- Decision: Use `@langchain/langgraph` (MIT) in process. Nodes call the Vercel AI SDK directly, not LangChain chat models. A custom `retryOn` decides what to retry (5.6). One retry layer exists: the AI SDK runs with `maxRetries: 0`, so `callUnit` is the only layer (5.6, Q9).
- Reason: The default `retryOn` can retry a 4xx error (UNVERIFIED by a run; 3.2 edge rule 7, 5.6). Mastra is out: its `ee/` folders have a non-open license (https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE). CrewAI is out: it is Python (https://pypi.org/pypi/crewai/json).

**D6. Resume after an app restart: a custom checkpoint saver on `node:sqlite`.**
- Decision: A run resumes after an app restart. A custom LangGraph checkpoint saver stores the state in `node:sqlite` (`apps/server/src/lib/db.ts:1`). Validate it with `@langchain/langgraph-checkpoint-validation`.
- Reason: The owner first chose the official `better-sqlite3` saver, then switched after the cost check.
  - The saver needs a native module. Version 1.1.0 depends on `better-sqlite3` `^12.10.0` (https://registry.npmjs.org/@langchain/langgraph-checkpoint-sqlite/1.1.0). Version 12.10.0 has the install script `prebuild-install || node-gyp rebuild --release` (https://registry.npmjs.org/better-sqlite3/12.10.0).
  - In the electron-vite bundle, the loader of that module becomes a stub that throws. This is UNVERIFIED here: a research bundle test outside this repo found it, and no repo source shows it. A real build must confirm it (10.14, BC3 and BC4).
  - The guard script checks only literal `require("x")` calls (`apps/electron/scripts/check-bundled-requires.mjs:26`, `:44-52`). Whether it misses the stub is UNVERIFIED: a build must confirm it.
  - The saver also needs a fetch script, signing and an `allowBuilds` entry (`pnpm-workspace.yaml:4-8`).
  - The plan counts 4 CI changes. This is an estimate, UNVERIFIED. For comparison, the ffmpeg fetch step runs in 3 build jobs (`.github/workflows/build.yml:229-231`, `:290-292`, `:510-512`). The `test-electron` job builds the app and runs the guard (`.github/workflows/build.yml:152-205`, guard at `:189-191`).

**D7. Gateway: upgrade the Vercel AI SDK to v7.**
- Decision: Upgrade `ai` from 6.0.191 (`pnpm-lock.yaml:317`) to v7, globally. Dictation cleanup, Remix, the Remix agent and meetings move together.
- Reason: The server, `stt` and the renderer each pin `ai` to `^6.0.191` (`apps/server/package.json:36`, `packages/stt/package.json:53`, `apps/electron/package.json:42`). Mixed copies already exist: the lock resolves `ai` 6.0.191 (`pnpm-lock.yaml:7348`) and 6.0.240 (`pnpm-lock.yaml:7356`), and `@ai-sdk/react` 3.0.242 pulls 6.0.240 (`pnpm-lock.yaml:5204-5207`). A mixed pair is a trap (the negative control of 6.9.4 tests it; UNVERIFIED until run). Whether v7 accepts the major 3 provider packages of the server is UNVERIFIED (6.7, 6.11). `@ai-sdk/otel` needs `ai` v7, so D8 needs v7 (https://registry.npmjs.org/@ai-sdk/otel/latest).

**D8. Tracing: a local record always, OpenTelemetry export only when configured.**
- Decision: The app always keeps the local record (D10). It exports OpenTelemetry traces to MLflow only when a user sets an endpoint, and the export is off by default. The owner's MLflow server is `http://192.168.31.154:5000`. Verify each trace by reading it back with `search_traces`.
- Reason: The app promises no telemetry (`AGENTS.md:9`). How MLflow renders AI SDK spans is UNVERIFIED (section 9).

**D9. LiteLLM: do not embed it now.**
- Decision: Do not embed the LiteLLM Python module. Apply its lessons (Table 2) to the AI SDK gateway. A user-run LiteLLM proxy already works as an OpenAI-compatible `server` endpoint. Reopen only if new facts appear.
- Reason: The owner asked, "do we really need it now?" The coordinator answered no:
  - The server is TypeScript, and the AI SDK unifies 8 providers in process (`apps/server/src/lib/llm/registry.ts:171-277`).
  - LiteLLM needs a Python sidecar: 18 base packages and a 36.4 MB arm64 wheel (https://pypi.org/pypi/litellm/1.105.1/json). Its import downloads a price map unless `LITELLM_LOCAL_MODEL_COST_MAP=True` (https://github.com/BerriAI/litellm/blob/caad4d62045e76c1a8428ab8f316d351ca9a0a7e/litellm/__init__.py#L549-L551).
  - It maps `error`, `network_error`, `MALFORMED_RESPONSE` and unknown finish reasons to `stop`, which breaks D4 (https://github.com/BerriAI/litellm/blob/caad4d62045e76c1a8428ab8f316d351ca9a0a7e/litellm/litellm_core_utils/core_helpers.py#L229-L291).
  - Versions 1.82.7 and 1.82.8 were compromised on 2026-03-24 (https://docs.litellm.ai/blog/security-update-march-2026).
  - A proxy needs no code: a server entry stores a base URL and an optional key (`apps/server/src/lib/own-servers.ts:37-53`), served through `createOpenAI` (`apps/server/src/lib/llm/registry.ts:245-274`).

**D10. LLM inspector.**
- Decision:
  - The app always records every LLM call locally (corrections, speaker suggestions, summary, failures, retries). The UI shows records only in advanced mode (`advanced_mode` setting, a renderer gate). Records are deleted with their meeting (foreign key `ON DELETE CASCADE` to `meetings`).
  - A record holds: the messages sent; the schema; the params actually sent (param ledger: top level, extra body or dropped); the raw response text; the parsed object; the finish reason (unified and raw); the tokens (input, output, reasoning, cached when known); the latency; the attempt number and retries; the served model next to the requested model; the typed error, if any.
  - A record links to what it produced: the edited segments; the speaker suggestions, with the verdict (kept or dropped) and reason; the summary; the failures and retries that edited nothing.
  - Owner's intent: in the meeting transcript screen, a click on an edited text shows the exact message sent and received. The view is hidden by default and enabled in Advanced.
- Reason: No table keeps these data today. `advanced_mode` is a shared key (`packages/validations/src/settings-keys.ts:6`).

**D11. Build: workflows, with Sonnet and Haiku agents.**
- Decision: Sonnet agents implement and judge. Haiku agents run the brute-force checks. Parallel lanes are allowed. Only the coordinator creates, pushes and merges branches.
- Reason: The branch rules cap open PRs at 2 (`.claude/skills/branch-lifecycle/SKILL.md:13`). The owner allowed more.

**D12. Quality gate: benchmarks and the council.**
- Decision: A change to transcript quality needs a before/after `meeting-benchmarks` run on the owner's real meetings, then the council (Claude, pi, Codex). Codex gets a data set only with the owner's approval for that set. Release needs consensus.
- Reason: Codex sends the meeting text to the cloud (`.claude/skills/council/SKILL.md:27`). The owner's rule is to release only on consensus, when all three judges say SHIP (`.claude/skills/council/SKILL.md:33`).

Table 2. LiteLLM lessons that section 5 applies in the gateway (section 5 holds the sources).

| ID | Lesson |
|---|---|
| L1 | `stop` is not proof. Check the unified and the raw finish reason, and the stop aliases of each provider. A `<think>` tag in the content, or empty content with reasoning present, is a typed `ReasoningLeakError`. |
| L2 | Always send the reasoning params, also when thinking is off. Record a param ledger for each call. A missing thinking flag once gave about 48k characters of reasoning and `length` before any JSON (owner note outside this repo: `~/.claude/projects/-Users-maheidem-Documents-dev-OktoLabsAI-marginalia/memory/project_thinking_transport_loopback_bug.md:12-14`). |
| L3 | One retry layer, with SDK retries at 0. Retry a transient provider error once, with a cap on the Retry-After wait. On `length`, retry once with less reasoning, a bigger budget or a split input. On a schema error, retry once with the validator message in the prompt. Never retry `content-filter` or an auth error. |
| L4 | Check the served model against the requested model. oMLX `model_fallback` once answered with another model. |
| L5 | Use a fixed schema for each node. No dynamic enums of ids. For strict mode make all fields required and use nullable instead of optional (https://developers.openai.com/api/docs/guides/structured-outputs). Authors write the schema to these rules and a test enforces them. The AI SDK sets `additionalProperties` false itself, and the gateway does not change the schema (4.0.3 rule 7). |
| L6 | Prove the gateway with real calls, not only with mocks. Two earlier projects had green suites (988 and 4,052 tests) while real use failed (section 10). |

### 1.2 Goals

Section 10.4 maps each goal to its proof, run against the real system.

| ID | Target (decisions) |
|---|---|
| G1 | One fixed zod schema for each LLM node, with no fields for two jobs. 0 uses of brace slicing in the new path (`extractJsonObject`, `apps/server/src/lib/meetings/enhance.ts:232-246`). (D1, D2) |
| G2 | A test covers the 6 unified finish reasons. Valid JSON with `length` fails typed. One live Qwen3.8-27B call with a small token cap ends in that error. (D4) |
| G3 | Close #163: on its 8-chunk meeting, 6 of 6 runs finish all 8 correction chunks. A failed chunk shows its typed error. The speaker step still returns suggestions. The gate counts only if the old path fails at least one chunk in each baseline run on the same meeting context (10.15). Else the result is "not reproduced" and the replay GR5 is the proof. (D1, D4) |
| G4 | A failed step shows its typed error kind in the meeting screen, after a reload and after an app restart. (D4) |
| G5 | `maxRetries` is 0 on every workflow call. A fake server counts requests for one call: transient error 2, `content-filter` 1, auth error 1, invalid schema 2. A call gets at most one retry, and a retry never repeats another call of its unit. A split chunk whose second half fails twice with HTTP 503 sends 4 requests. (D5, L3, 5.6) |
| G6 | Kill the server during a run. After the restart the run continues and finished nodes send 0 new LLM requests. If the endpoint is down at boot, a local server or a cloud provider, the run stays `interrupted` and the boot resume is not counted. The saver passes `@langchain/langgraph-checkpoint-validation`. (D6) |
| G7 | Every call of a run with the flag `meeting_enhance_workflow` on has a record with all D10 fields, or a counted lost record (7.7); the live proof shows 0 lost records. The flag-off path writes no record until S5 (12.3). Edited segments, speaker suggestions and the summary link to their calls. The UI shows records only when `advanced_mode` is `"true"`. After a meeting delete, 0 records remain. (D10) |
| G8 | The param ledger equals the body on the wire. Reasoning params go out on every call. A served-model mismatch fails typed. (D3, D4, L2, L4) |
| G9 | `pnpm-lock.yaml` holds one `ai` version. Dictation cleanup, Remix, the Remix agent and meetings each pass their tests and one live run. (D7) |
| G10 | No endpoint: no tracer runs and no connection opens. With an endpoint: `search_traces` reads back one MLflow trace for each run, state OK, one span for each call. (D8) |
| G11 | No native module. `check-bundled-requires.mjs` passes. A packaged build runs one Enhance. The asar size is recorded before and after (limit: 12.2 Q6). (D6) |
| G12 | The `meeting-benchmarks` before/after run on the owner's real meetings shows no regression. The council reaches consensus SHIP. (D12) |

### 1.3 Non-goals

- No LiteLLM module (D9). No native Node module. No Python sidecar (D6).
- No change to speech-to-text, alignment, diarization or merge. Enhance starts after the status `transcribed`: `apps/server/src/routes/meetings.ts:1007-1011` sets the status, and `:1039-1043` starts the auto Enhance job when the setting is on.
- Dictation changes only by the AI SDK v7 bump (D7). Dictation and the meeting call path share the `postProcess` function of the `stt` package (`packages/stt/src/post-process.ts:108`). Dictation reaches it through the server wrapper `postProcess` (`apps/server/src/lib/post-process.ts:139`), which imports it as `cleanupWithModel` (`:2`) and calls it at `:228`. Dictation callers of the wrapper include `apps/server/src/lib/transcription-pipeline.ts:238` and `apps/server/src/routes/stream.ts:366`. The meeting call path calls the `stt` function directly (`apps/server/src/lib/meetings/llm-call.ts:14`, `:136`). Changes there add fields only.
- macOS on Apple silicon only (`AGENTS.md:9`). Local-model proofs use MLX. No required cloud service: a Mac with no network still runs Enhance on a local server, because the models.dev read of 5.1 is best effort. The existing read fetches `https://models.dev/api.json` (`apps/server/src/lib/model-registry.ts:64-68`), and its caller ignores a failure (`apps/server/src/routes/models.ts:161-165`). No telemetry by default (D8).
- No LangGraph Studio or LangSmith. Studio needs a LangSmith account (https://docs.langchain.com/oss/javascript/langgraph/studio).
- No new LLM step outside D1. No new client of the server API.

**Constraints that bind every section.** Every local app run, E2E spec and UI proof runs through `scripts/test-runner/run.sh <cwd> -- <command>` (`.claude/skills/live-testing/SKILL.md:202`). The script forwards the caller environment (`scripts/test-runner/run.sh:24`) and sets no quiet-mode variable. `OPENSTYLE_E2E=1` turns on quiet mode (`AGENTS.md:89`). Never use the installed app, port 4649 or the real profile (`AGENTS.md:88`). Never use the mic or the system audio: those tests stay CI-only (`.claude/skills/live-testing/SKILL.md:200`). Stop at the first unexpected privacy prompt (`.claude/skills/live-testing/SKILL.md:204`). Tell the owner before a run that can raise an expected prompt (`.claude/skills/live-testing/SKILL.md:200`). The owner's oMLX at `127.0.0.1:8123` is live infrastructure (`.claude/skills/live-testing/SKILL.md:227-229`; `specs/model-picker-groups.md:15`). Send only Qwen3-ASR and Qwen3.8-27B requests. Never send Parakeet, TTS or embedding requests. Whether it answers now is UNVERIFIED: this spec work sent no request to it. The app ships no `node_modules`, and the asar stays near 9 MiB (`AGENTS.md:87`). Done means proven end to end on the real running system. Unit tests alone never count. Tracker and branch rules: section 11.

### 1.4 Glossary

| Term | Meaning in this spec |
|---|---|
| Workflow, run, step, node | The workflow is the graph of steps for one meeting. A run is one execution. A step is one job (D1). A node is the LangGraph function for a step. A fan-out node runs once for each chunk. |
| Chunk | Whole `meeting_segments` rows for one correction call (table: `apps/server/src/lib/schema.ts:778-788`; whole-segment chunks: `apps/server/src/lib/meetings/enhance.ts:10-12`). Today the limit is 1200 tokens (`apps/server/src/lib/meetings/enhance.ts:66-69`). Section 4 sets the limit (4.0.5, 4.1 P6). It is not an audio chunk. |
| Call | One request to a model endpoint, with its response or error. A retry is a new call. One inspector record per call. |
| Job | The in-memory slot of the job registry, one for each meeting (`apps/server/src/lib/meetings/job-registry.ts:2-3` says one job per meeting, `:53` is the jobs map, `:81-88` is `claimJob`, which takes the slot). A run is not a job (3.4.1). |
| Profile | An entry keyed by provider and model: how to switch reasoning and which params to send (D3). It is not the task profile (`LLM_TASK_PROFILES`, `apps/server/src/lib/llm/task-profiles.ts:81`). |
| Finish reason, unified and raw | Six AI SDK values: `stop`, `length`, `content-filter`, `tool-calls`, `error`, `other` (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/types/language-model.ts#L75-L81). The provider's own string is `rawFinishReason` (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/generate-text/generate-text-result.ts#L113). |
| Typed error, param ledger, served model | A typed error has a fixed `kind` that the code, the UI and the inspector use (section 5). The gateway (section 5) sends and checks every workflow call. The inspector (section 8) shows the call records. The ledger lists every request param of one call and its place: top level, extra body field, or dropped. The served model is the model that the endpoint names in its response. It can differ from the requested model (L4). |

---

## 2. Current state (baseline c47cd80d)

Scope: `main` at c47cd80d (release 2.17.1). The spec changes no code. Sections 3 to 12 answer P1 to P14 (table in 2.3).

Cites are `file:line` with the base name. A directory prefix marks a base name that exists in several places: server/index.ts (`apps/server/src/index.ts`), llm/registry.ts (`apps/server/src/lib/llm/registry.ts`), providers/server.ts (`apps/server/src/lib/streaming/providers/`), meetings/import.tsx (`apps/electron/src/renderer/src/pages/`), stt/post-process.ts (`packages/stt/src/`), validations/settings.ts (`packages/validations/src/`). Every other base name matches one tracked file (`git ls-files`). `index.mjs` and `index.d.ts` = `ai@6.0.191 dist/` (pnpm store of the main checkout). External claims carry a URL. UNVERIFIED marks an unchecked claim. Chunk, call and job: 1.4.

---

### 2.1 End-to-end flow, from stop or import to a saved summary

13 steps. Steps 10 and 12 call an LLM. Steps 1 to 9 are context.

| # | Step | What happens | Cites |
|---|---|---|---|
| 1 | Record or import (user) | The recorder opens `mic.wav` and `system.wav` and journals `sync.json`. Stop finalizes both WAV files, writes `sync.json`, then sends POST `/:id/stop`. Import writes `system.wav` only, with no `mic.wav` and no `sync.json`. | meeting-recorder.ts:13-16, 349-350, 712-713, 738, 743-744, 780-791; meetings.ts:1466; meetings-import.ts:8-14, 277-292 |
| 2 | Start transcription (user) | Route sets `transcribing`, clears old segments, speakers and diarizer turns, takes the job slot, returns 202. | meetings.ts:1528-1566 |
| 3 | Diarize (ML, auto) | Runs unless `meeting_diarization_enabled` is "false" (default on), and only when `system.wav` exists. A mic-only meeting skips this step even when the setting is on. On failure, the call gives null, no speaker labels are applied and the job continues. | meetings.ts:827-831, 851-861, 996-1004; diarize.ts:54-61 |
| 4 | Segment (code, auto) | Energy detector; merge toward 22.5 s, max 30 s. A mic chunk under 60 ms of voice is `empty` (no STT). | segmenter.ts:80-84; transcriber.ts:496-514 |
| 5 | Language and align gate (auto) | Picks mode `align`, `cut` or `plain`. | meetings.ts:463-504 |
| 6 | STT (ML, auto) | 2 lanes (mic, system). 3 attempts per chunk with backoff, then `failed`. | transcriber.ts:389-400 (lanes), 516-517 (attempts, backoff base), 613-633 (retry loop, `failed`) |
| 7 | Align or label (auto) | `align`: `runAlignPass` splits mixed chunks. Else `applyDiarization` labels segments. | meetings.ts:506-513, 586 (`runAlignPass`), 996-1001 (align branch), 1002-1003 (`applyDiarization` branch); diarize.ts:515 |
| 8 | Status `transcribed` (auto) | Writes `transcript.md`. Failed chunks do not fail the job. | meetings.ts:1006-1012 |
| 9 | Merge (code, each read) | Drift fix, hallucination and echo removal, confirmed names. Enhance and Summary read the merged text. | meetings.ts:253-308, 2082, 2114 |
| 10 | Enhance (LLM) | Auto after step 8 if `meeting_enhance_auto_run` is "true" (default off), else button. See 2.1.1. | enhance.ts:51-58; meetings.ts:1039-1045 |
| 11 | Name spelling (code) | Inside Enhance: fixes a name that matches one calendar attendee. | enhance.ts:641-651 |
| 12 | Summary (LLM) | Button only. See 2.1.2. | meetings.ts:2068-2095 |
| 13 | Audio sweep (code, daily) | A daily sweep deletes `mic.wav` and `system.wav` of every meeting older than `meeting_retention_days` (default 30) and sets `audio_dir` to NULL. It keeps all DB rows. It does not wait for a summary. | retention.ts:12-17, 34-61; daily-sweep.ts:1-5, 22-28; validations/settings.ts:177; settings-keys.ts:60; server/index.ts:216 |

#### 2.1.1 Enhance in detail

1. **Start.** Auto: the transcribe job frees its slot and starts `runEnhanceJob` (meetings.ts:1039-1045). Button: POST `/:id/enhance` holds the HTTP request open for the whole run; `/api/meetings` has no 30 s timeout (meetings.ts:2101-2141; server/index.ts:32-47, 91-95).
2. **Model.** Task `meetingEnhance`: reasoning off, temperature 0, timeout `meeting_enhance_timeout_seconds` (default 600 s) (task-profiles.ts:111-126, 154-166). Local server: the app adds `chat_template_kwargs.enable_thinking` = false, and a preset can add keys or override it (task-profiles.ts:358-369). UNVERIFIED: the owner's preset for `meetingEnhance`.
3. **Chunks.** Whole segments, 1200 tokens (length / 4), no overlap (enhance.ts:69, 189-217). Output budget: `ceil(chunkTokens * 2) + 200 + 150 * labels in the chunk`; a preset `max_tokens` can raise it, not lower it (enhance.ts:491-492; task-profiles.ts:395-405).
4. **Prompt.** System: correction contract, plus a speaker block when labels exist. User: the chunk in `<transcript>` tags. Attendee names stay out (enhance-prompt.ts:29-51, 73-130; enhance.ts:99-104).
5. **Call.** Chunks run in order (enhance.ts:458-503), each under a background lane lease; the local lane limit is 1 (lane call: llm-call.ts:126-158; the value 1: lane.ts:106; applied to local providers: lane.ts:189-196). `postProcess` calls `generateText` once, with no JSON mode (stt/post-process.ts:125-137).
6. **Parse.** `extractJsonObject` cuts the first "{" to the last "}" and runs `JSON.parse` (enhance.ts:232-246).
7. **Checks.** Corrections need a chunk id and a string value; unchanged text is dropped. A speaker label must exist; name max 80 characters, evidence max 240 (enhance.ts:528-582). The evidence guard drops a suggestion when (enhance.ts:328-356): no quote; the name is not in the quote; the quote is in no chunk line; the quote is only in a "Me" line; the quote is in the label's own line but is not a self-introduction.
8. **Across chunks.** One `nameProposals` map; the earlier chunk wins (enhance.ts:443-456). A failed chunk logs a warning, keeps its raw text and goes on (enhance.ts:504-526).
9. **Write, once, after the loop.** One transaction updates `meeting_segments.enhanced_text` (enhance.ts:628-636). A second upserts `suggested_name`, `suggested_evidence`, `suggested_kind`, never `confirmed_at` (enhance.ts:652-672). `writeTranscriptMarkdown` rewrites `transcript.md`, and `transcript-enhanced.md` only if a segment has enhanced text; auto calls it in `finally`, button after the 502 check (meetings.ts:322-335, 1139, 2179-2180).
10. **Report.** Button: 502 if a chunk ran, none succeeded and the user did not stop (body: `reason`, `detail`) (meetings.ts:2150-2172); else 200 with `partial` and `stopped_early`; a stop after a failed chunk gives 200 with zero successes (meetings.ts:2183-2195). Auto: log lines only. The route logs one warning when every chunk failed and the user did not stop (meetings.ts:1103-1117, warning at :1112). The pass itself also logs one warning for each failed chunk (enhance.ts:508-510, 521-523) and one "pass incomplete" warning (enhance.ts:675-682).

#### 2.1.2 Summary in detail

1. **Start.** Button: POST `/:id/summarize`; needs status `transcribed` or `summarized`; returns 202; the renderer polls GET `/:id` (meetings.ts:2068-2095; detail.tsx:122-127).
2. **Calls.** Lines: `label: enhanced text` (raw text if none) (summarize.ts:298-316). One call if the transcript fits the budget (summarize.ts:447-459). Else one map call per chunk plus one reduce call (summarize.ts:461-509). More than 24 calls fails the run before the first map call (guard: summarize.ts:468-475; constant 24: summarize.ts:108). The budget default is 8000 tokens (summarize.ts:49, 412-413; validations/settings.ts:185, 254-266).
3. **Limits.** Reasoning off, temperature 0, 4096 output tokens (task-profiles.ts:96-110). Call timeout 600 s (`meeting_summary_timeout_seconds`) (validations/settings.ts:320). Job deadline: between 2 calls and 4 hours (summarize.ts:147-154).
4. **Output.** The prompt asks for four markdown sections (summary-prompt.ts:12-26). No parse, no section check: `call` returns `response.text` as it is (summarize.ts:433-442). Only the prose sanitizer runs, inside `postProcess` (llm-call.ts:136, 172-173; stt/post-process.ts:139). It removes think blocks, wrapping quotes, trailing `<fin>` tags and a repeated final paragraph (text.ts:74-94).
5. **Write.** `INSERT OR REPLACE` into `meeting_summaries`, then status `summarized`. Tokens sum over calls. Provider and model come from the last call that reports one (summarize.ts:435-438). The cost uses the last known price (summarize.ts:439, 512-515). The route writes these values (meetings.ts:1213-1230).
6. **Failure.** A throw or the deadline ends the run before the INSERT; the catch writes no row and sets in-memory text ("Cancelled by user" after a cancel, else the error message) (meetings.ts:1187-1245).

#### 2.1.3 Job and status model

Tables, cascade, retention and registry facts are in 7.1. Status values: `recording`, `interrupted`, `recorded`, `transcribing`, `transcribed`, `summarized`, `failed`; Enhance never changes the status (schema.ts:766-769; meetings.ts:1073-1076). Job kinds, one slot per meeting: `transcribe`, `retry-failed`, `diarize`, `summarize`, `enhance` (job-registry.ts:39-62).

#### 2.1.4 LLM call stack (Enhance and Summary)

Lane and queue facts: 3.5. Finish reason and retry facts: P3, P4 and P12 in 2.3. Also: `defaultChatCallFor` adds the task id and the cancel seams (llm-call.ts:69-83). `resolveTaskCall` returns `provider`, `modelId`, `temperature`, optional `topP`, `maxOutputTokens`, `reasoningEnabled`, `samplingParams`, `timeoutMs` (task-profiles.ts:166-175, 314-409).

---

### 2.2 Flowchart of today's Enhance and Summary path

Red nodes mark a failure path. The dotted edge means that the user starts Summary later by button.

```mermaid
flowchart TD
  B["Transcribe done<br/>status: transcribed"] --> C{"meeting_enhance_auto_run<br/>is true?"}
  C -->|yes| D["Auto Enhance<br/>runEnhanceJob"]
  C -->|no| E["Button<br/>POST /:id/enhance"]
  D --> F
  E --> F
  subgraph ENH["Enhance loop, no retry"]
    F["Chunks: 1200 tokens, no overlap"] --> G["One call per chunk<br/>corrections and speakers"]
    G -->|"timeout or API error"| Z
    G --> H{"finish reason length<br/>or text empty?"}
    H -->|yes| X["postProcess throws<br/>reason: provider"]
    H -->|no| I["First to last brace<br/>JSON.parse"]
    I --> J{"Valid JSON?"}
    J -->|no| Y["Failure reason: parse"]
    J -->|yes| K["Type checks, evidence guard,<br/>shared nameProposals"]
    X --> Z["Skip chunk, keep raw text"]
    Y --> Z
    K --> L{"More chunks?"}
    Z --> L
    L -->|yes| G
  end
  L -->|no| M["Write enhanced_text,<br/>names, speaker suggestions"]
  M -->|auto| O["All chunks failed:<br/>server log only"]
  M -->|button| P["200 partial, or 502 if all<br/>failed and no user stop"]
  M -. "later, button" .-> S0["POST /:id/summarize<br/>202, poll"]
  subgraph SUM["Summary"]
    S0 --> S1{"Tokens within budget<br/>(default 8000)?"}
    S1 -->|yes| S2["One call"]
    S1 -->|no| S3["Map per chunk,<br/>then one reduce"]
    S2 --> S4["Free markdown saved as is"]
    S3 --> S4
    S2 & S3 -.->|any throw| S5["Job fails: job_error,<br/>nothing saved"]
  end
  S4 --> S6["INSERT OR REPLACE meeting_summaries<br/>status: summarized"]
  classDef bad stroke:#c0392b,stroke-width:2px;
  class X,Y,Z,O,S5 bad;
```

---

### 2.3 Problems

Sections 3 to 12 refer to these numbers. "2.1.1 step N" points to the cite in 2.1.

#### P1. One call does two jobs, and a long answer loses both (Enhance)

- One prompt asks for corrections and a `speakers` object in one JSON answer, built once with the labels of the whole meeting (corrections contract: enhance-prompt.ts:16-26; `speakers` block: enhance-prompt.ts:43-50, 103-112, emitted only when `speakerLabels` is not empty, line 78; labels and build: enhance.ts:413-430). One output budget covers both (2.1.1 step 3).
- Issue #163 (8 chunks, local oMLX, Qwen3.8-27B): two chunks ended with `length` at 3168 and 3716 output tokens, and one returned invalid JSON (long reasoning in `evidence`). Their corrections were lost (https://github.com/Maheidem/openstyle/issues/163). The numbers come from the issue text, not a new measurement.

#### P2. The JSON contract exists only as prompt text (Enhance)

- No LLM code path uses `json_schema`, `response_format`, `generateObject`, `Output.object` or tools. `response_format` appears only in two STT form fields (providers/server.ts:71; whisper-local.ts:68). Tool keys are on the preset denylist (llm-task-profiles.ts:199-206).
- The parser takes the first "{" to the last "}" (2.1.1 step 6). Manual `typeof` checks validate the result; no zod schema exists (enhance.ts:529-582).

#### P3. Only `length` is detected, and the code labels it `provider` (Enhance and Summary)

- `postProcess` discards the text when `finishReason === "length"` or the text is empty; `resolveDefaultChatCall` throws (stt/post-process.ts:148-159; llm-call.ts:159-163). `EnhanceFailureReason` has no `length` value, so `length` becomes `provider`; "finishReason: length" survives only in `detail` (200 characters) (enhance.ts:140, 156-170).
- The renderer reads only `body.reason` (detail.tsx:364-375; the read is at :366). While `enhanceFailure` is set, the generic error notice stays hidden (detail.tsx:719-721). Summary: the reduce call once ended with `length` and failed the job (summarize.ts:56-69).

#### P4. Every other finish reason passes as success (Enhance and Summary)

- The AI SDK has six finish reasons plus `rawFinishReason` (index.d.ts:108, 907-911; https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text lists the six values and `rawFinishReason`; the guide page https://ai-sdk.dev/docs/ai-sdk-core/generating-text lists `rawFinishReason` only). `postProcess` checks only `length` and empty text; `content-filter`, `error` or `other` with text returns as success (stt/post-process.ts:148, 162-167).
- `ChatCallResponse` has no finish reason field (llm-call.ts:46-55). A grep over `apps/server/src`, `packages/stt/src` and `apps/electron/src` finds no read of `rawFinishReason`. A leaked `<think>` block is cut out without a signal (text.ts:74-87).

#### P5. No retry: Enhance skips the chunk, Summary drops the whole run (Enhance and Summary)

- Enhance: a failed chunk is skipped (2.1.1 step 8). Issue #163 says the runs are deterministic, so a plain retry does not help (URL in P1).
- Summary: `call` has no `catch` and `summarizeMeeting` has no `try`, so a throw loses the finished map outputs and writes no row (summarize.ts:476-497; 2.1.2 step 6).
- STT chunks get 3 attempts (2.1 step 6). LLM calls get none from the app.

#### P6. A failed chunk 0 loses all speaker names (Enhance)

- A chunk has no state from earlier chunks. The evidence guard checks a quote against its own chunk only (enhance.ts:189-196, 293-306).
- Issue #163: chunk 0 held the only grounded self-introduction. After it failed, the guard dropped all 16 suggestions of chunks 1 to 7 (URL in P1). Drop reasons go to the debug log only (enhance.ts:594-599).

#### P7. Failures are hard to see (Enhance)

- Auto: a failure of all chunks, or any other throw, gives one log warning. A partial failure also reaches only the log (meetings.ts:1103-1117; enhance.ts:508-510, 521-523, 675-682). Enhance never fills `job_error`: `runEnhanceJob` never calls `setJobFailure` (meetings.ts:1078-1142). Only the Summarize catch calls it (meetings.ts:1240). The setter is at job-registry.ts:142, and `GET /:id` reads it at meetings.ts:2250.
- Button: the page keeps `reason` in React state, shows one of three texts, drops `detail`, and a reload clears it. A partial run shows chunk counts with no cause (detail.tsx:87-89, 742-754).
- One variable holds the first failure of any kind (`??=`), so an early parse failure blocks a later call failure (enhance.ts:433-438, 507, 517).

#### P8. The summary is free markdown (Summary)

- No parse and no schema check exist (2.1.2 step 4). The result goes into one `markdown` column (meetings.ts:1213-1227; schema.ts:790-799). A decision or an action item has no field that code can read.
- Planned answer: the model returns a schema object and code reads its fields to render the Markdown (4.5.1, 4.5.6). After the run, only the call record keeps the object, in `llm_calls.parsed_json`. No code reads it and no column holds it (4.5.6, Q12).

#### P9. Jobs live in memory only (Enhance and Summary)

- The registry and `job_error` are in memory and lost at restart (job-registry.ts:9-10, 64-73). The status list has no Enhance value (2.1.3). GET `/orphans` lists only `recording` or `transcribing` rows (meetings.ts:1349-1367).
- Both features write only at the end of the run (2.1.1 step 9; Summary: meetings.ts:1153-1157). A restart in the middle leaves no row and no marker.

#### P10. No record of any call (Enhance and Summary)

- The database stores no prompt, parameters, raw answer, finish reason, latency or retry count. `ChatCallResponse` hands the caller only text, tokens, provider, model and pricing (llm-call.ts:46-55). An always-on trace log file holds the request body (prompt and parameters), the raw answer, `finish_reason`, `usage` and `elapsed_ms`, but only for the `server` provider (trace.ts:10, 206-290; llm/registry.ts:156-169, 271). It is a file, and no row links it to a meeting (P11). No retry counter exists in trace.ts, llm-call.ts, enhance.ts, summarize.ts or stt/post-process.ts; a grep for "retr" and "attempt" finds only the chunk counter `chunksAttempted`. The summary row holds summed tokens, the last provider and model, and a cost (schema.ts:790-799). Enhance stores no model, token count or cost (enhance.ts:628-672).
- `enhanced_text` NULL means "not enhanced" or "left unchanged"; a failed chunk looks like an accepted one. No column links a correction to a call (schema.ts:835-837). A speaker suggestion stores name, evidence and kind only (enhance.ts:658-672).

#### P11. The trace log covers one provider and has no meeting id (Enhance and Summary)

- Only the `server` provider is traced (`traceLlmFetch` inside `createSamplingFetch`). The wrapper is in llm/registry.ts:156-169, and only the `server` entry uses it (llm/registry.ts:245-275, fetch at :271). OpenAI, Anthropic, Google, Mistral, OpenRouter and Vercel use no custom fetch (llm/registry.ts:172-240). Groq uses a keep-alive fetch with no trace (groq-http.ts:7-8, 31).
- The log has full bodies, `finish_reason` and `usage` (trace.ts:184-204). Each entry id is a random 8-character code per HTTP request, with no meeting id and no step name (trace.ts:132-137).
- UNVERIFIED: whether a background job keeps the request id (`AsyncLocalStorage` and a job started with `void`).

#### P12. The AI SDK retries twice, and nothing records it (Enhance and Summary)

- `generateText` has a default `maxRetries` of 2; the first wait is 2 s and doubles (index.mjs:2653-2655, 2739; https://ai-sdk.dev/docs/ai-sdk-core/settings). `postProcess` sets none (2.1.1 step 5).
- The SDK retries a retryable error, never an abort (index.mjs:2672, 2688). One call can send 3 requests inside one lane slot and one timeout (llm-call.ts:126-158). No app log line and no database row counts them. For the `server` provider, the trace log shows each request as its own entry (trace.ts:257-304; UNVERIFIED by a live run).

#### P13. Token and model data lose facts (Enhance and Summary)

- The code reads only `inputTokens` and `outputTokens` (stt/post-process.ts:157-158). The SDK also reports `usage.outputTokenDetails.reasoningTokens` (index.d.ts:296-304); a grep finds no read of it.
- Reasoning shares the output budget (enhance.ts:484-490). The only measure is a code comment, "~300-400 tokens of chain-of-thought per call" (summarize.ts:56-59). UNVERIFIED: the counting method.
- `ChatCallResponse.model` is documented as the serving model (llm-call.ts:50-52), but the code sets it to `resolved.modelId`, the id the app resolved (llm-call.ts:176-177; task-profiles.ts:270-304). A grep finds no read of `response.modelId`. A server that answers with another model leaves the wrong name in the summary row.

#### P14. Reasoning parameters go out for Groq and local servers only (Enhance and Summary)

- A local server gets `chat_template_kwargs.enable_thinking`; other providers get an empty object. The fetch wrapper writes preset keys into the body last, so they win (task-profiles.ts:358-369; llm/registry.ts:112-143).
- Only Groq defines `providerOptions` (`reasoningEffort`, two model families). OpenAI, Anthropic, Google, Mistral, OpenRouter and Vercel get no reasoning option (Groq: llm/registry.ts:72-97, 186-187; the six other entries define no `providerOptions`: llm/registry.ts:172-240, at :173, :195, :202, :209, :220, :232).

#### Unverified in this section

The owner's `meetingEnhance` preset (2.1.1 step 2). The #163 numbers and their spread over other meetings and models (P1, P6). Request-id carry into background jobs (P11). Whether each SDK retry shows as its own trace entry for the `server` provider (P12). The "300-400 tokens" figure (P13).

#### Which later section answers which problem

| Problem | Sections (planned answer) |
|---|---|
| P1, P6 | 3, 4 (separate steps for corrections and speakers) |
| P2, P8 | 4, 5 (one fixed schema for each LLM step; modes and parse in 5.3.5 and 5.4; the summary object stays in the call record only, 4.5.6) |
| P3, P4, P5 | 4, 5 (typed stop reasons, one retry layer) |
| P7 | 3, 4, 7, 8 (typed failure for each step, visible in the UI) |
| P9 | 3, 7 (durable run state; boot sweep and resume in 3.4.7) |
| P10, P13 | 5, 7, 8 (call record and inspector) |
| P11 | 9 (tracing) |
| P12, P14 | 5, 6 (gateway and AI SDK v7) |

---

## 3. Target architecture

Owns: components, graph, state, run lifecycle, concurrency, summary placement. Nodes: 4. Gateway: 5. Tables: 7. Inspector: 8. Tracing: 9.

**Keys.** `S`=`apps/server/src`, `E`=`apps/electron/src`, `V`=`packages/validations/src`, `W`=`S/lib/meetings/workflow` (new). Other paths exist on `main` at c47cd80d. Cite aliases: `R`=`S/routes/meetings.ts`, `J`=`S/lib/meetings/job-registry.ts`, `L`=`S/lib/llm/lane.ts`, `C`=`S/lib/meetings/llm-call.ts`, `N`=`S/lib/meetings/enhance.ts`, `P`=`E/renderer/src/pages/meetings/detail.tsx`. URL aliases: `LG:`=https://github.com/langchain-ai/langgraphjs/blob/cc29753d529caa5eed97a65e765ba26c0f88c631/libs/langgraph-core/src/ and `LD:`=https://docs.langchain.com/oss/javascript/langgraph/.

**Terms** (others: 1.4, which also defines job). **Stage**: `enhance` or `summarize`. **Run context**: the in-memory object (cancel signal, progress counters) that the runner gives to the nodes; it is not graph state. **Soft cancel**: a cancel that lets the graph reach `save` (3.4.5).

**Decisions.** (1) One graph, six nodes; one run is one execution (3.2). (2) State holds inputs and typed results; the recorder holds prompts and raw answers (3.3). (3) A start returns 202 for the button and the auto-run (3.4.2). (4) A durable run row sits beside the in-memory job; only the runner writes run status (3.4). (5) Cancel is cooperative and reaches `save`; a hard stop is the fallback (3.4.5). (6) A boot sweep marks orphan runs; a run resumes once by itself (3.4.7). (7) The LLM lane is the only throttle; the fan-out cap is 3 (3.5). (8) Summary joins the same graph through a stage list (3.6). (9) Every LLM call goes through `callUnit`, the one retry layer. A unit, not a node run, is the retry boundary (3.2, 5.6). The gateway never loops.

---

### 3.1 Components and files

Table 3. New parts. All files are new unless marked "edit". When a file name here differs from sections 7 and 8, the register in 11.4 decides.

| Part | Files | Rule |
|---|---|---|
| Graph | `W/graph.ts` (`buildGraph(deps)`: build, compile, routers), `W/state.ts`, `W/types.ts` (section 4; also `foldStatus`, `deriveRunStatus`, `SaveResult`: 3.4.3, 4.0.7, 4.6), `W/context.ts` (`RunContext` and `WorkflowDeps`, `productionDeps`: 3.4.2), `W/unit.ts` (`callUnit`, `gatewayRetryOn`, `guardNode`: 5.6, 4.0.2), `W/load-graph.ts` (`loadGraph(deps)`), `W/nodes/{prepare,correct-chunk,identify-speakers,verify-evidence,summarize,save}.ts` (each file exports one factory, `make<Node>Node(deps)`, that returns the node function; `buildGraph` calls the six factories); `W/schemas.ts` (the three node schemas, WP3); `W/prompts.ts` (the prompt builders of the three LLM nodes: WP5a writes `correctChunk` and `identifySpeakers`, WP6 writes `summarize`; 4.2.2, 4.3.3, 4.5.2) | Only `W` imports LangGraph, and only below `W/load-graph.ts` (rule 2; bundling risk: section 12). `W/prompts.ts` imports nothing from the old prompt files. |
| Gateway | `S/lib/llm/gateway.ts` (also `probeEndpoint`, 5.7), `S/lib/llm/gateway-errors.ts` | One structured LLM call (section 5). No LangGraph import. |
| Model profiles | `S/lib/llm/model-profiles.ts` | Reasoning and structured-output settings (D3, section 5). Only task profiles exist today (`S/lib/llm/task-profiles.ts:81`). |
| Recorder | `S/lib/llm/call-record.ts` (base types, record types, `CallSink`; WP2: 5.1 rule B); `S/lib/meetings/llm-record.ts` (7.7; WP2, extended in WP5b) | The recorder is the sink and the only writer of `llm_runs`, `llm_run_steps`, `llm_calls` and `llm_call_links`. The gateway needs the types, not the meeting tables. |
| Saver | `W/checkpoint-saver.ts` | `NodeSqliteSaver`, a `BaseCheckpointSaver` on `node:sqlite` (D6, section 7). |
| Runner | `W/runner.ts` (`startRun`, `resumeRun`, `sweepOrphanRuns`, `resumeInterruptedRuns`) | No route writes a run status. Routes call the runner. The runner calls the recorder for run rows. |
| API | `S/routes/meetings-runs.ts` (resume, run list, inspector routes); edit `R`, `S/routes/index.ts`, `V/meeting-types.ts` | A third sibling router keeps the 2288-line `R` from growing (`S/routes/index.ts:47-48`). The client already reads a sibling router (`E/renderer/src/pages/pill/use-dictation-session.ts:191`). |
| Inspector UI | `E/renderer/src/pages/meetings/{llm-inspector,run-status}.tsx`; edit `P` | Section 8. |
| Test fixture | `apps/server/tests/helpers/meeting-fixture.ts` (WP3) | The one fixture builder of 10.2 rule 1. |

Other files that change:

- `J`: `claimJob` takes an optional `AbortController`; `requestCancel` aborts it; `releaseJob` drops it. None has a controller today (J:81-90, J:93-97, J:131-136).
- `L`: `withLlmLane` (L:506-519) accepts `signal`. Its option type is a `Pick` of `AcquireLlmLaneArgs` that omits `signal` today (L:509), and the function spreads that option object into `acquireLlmLane` (L:513). `AcquireLlmLaneArgs` already has `signal` (L:83), and `acquireLlmLane` already stops a queued call when it aborts (L:404-413).
- New `S/lib/meetings/transcript-io.ts`: takes `loadMergedTranscript`, `writeTranscriptMarkdown`, `attendeeNamesOf` from `R` (R:253, R:322, R:1264), because the runner cannot import a route file. WP5a moves them with no behavior change, and `R` imports them back (11.4).
- `R`: both start routes and the auto-run handoff (R:1039-1045) call `startRun`. `runEnhanceJob` (R:1078-1142) and `runSummarizeJob` (R:1159-1250) go away in WP11. Until then the flag `meeting_enhance_workflow` keeps both (11.5 WP5b, 12.2 Q1). `GET /:id` stays as it is. The renderer reads runs from `llm-runs` (8.3).
- `S/index.ts`: `sweepOrphanRuns()` before `serve()`, `resumeInterruptedRuns()` after the server listens (today `sweepStaleWhisperServer()` at :211, `serve()` at :226-236).
- `S/lib/meetings/{enhance,summarize,llm-call}.ts`: the nodes import three helpers from them and nothing else: `chunkForEnhance` (`N:197`), `chunkTranscript` (`S/lib/meetings/summarize.ts:323`) and `estimateTokens` (`C:24`). The guards (4.4) and the prompts (`W/prompts.ts`) are new code. The old prompt files `enhance-prompt.ts` and `summary-prompt.ts` stay unchanged until WP11. The old path still uses them. They also ask for JSON text and Markdown sections, which conflict with the schemas (4.2.2, 4.5.2). `enhanceMeetingTranscript`, `summarizeMeeting` and `llm-call.ts` retire in WP11, after the benchmark passes (D12, 11.5), because the knip gate fails on an unused file (`AGENTS.md:85`). WP11 first moves the three helpers into one `W/` file (11.5).
- Also: migration 40 (section 7). It is a new step after the step 39 block and before the version upsert (`S/lib/schema.ts:1007-1009`), and `SCHEMA_VERSION` changes from 39 to 40 (`S/lib/schema.ts:14`). New `S/lib/llm/tracing.ts` (D8, section 9).

**Layout rules.** (1) Generic LLM code goes in `S/lib/llm`, meeting code in `S/lib/meetings`, LangGraph imports in `W` only (10.8 GR2 and GR3 test this). (2) `W/load-graph.ts` deletes the four tracing variables (privacy guard), then loads `W/graph.ts` with a dynamic `import()` on the first run, as the call helper does for providers (C:4-6, C:95-100). `W/graph.ts` and the modules below it (`state.ts`, `checkpoint-saver.ts`) may import LangGraph with a static `import`. The runner and the nodes import them as types only. No static import path from `S/index.ts` reaches `@langchain/*` (GR2). So a bundling fault breaks Enhance only. (3) The gateway never imports from `W`. (4) Dictation, Remix and the Remix agent stay off the gateway; D7 moves their AI SDK version only.

**Privacy guard.** The server inherits the app environment (`E/main/server-host.ts:203-206`). LangChain turns tracing on when `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING` or `LANGCHAIN_TRACING` equals `true` ([source](https://github.com/langchain-ai/langchainjs/blob/84eca2b11c0900a67775dca258ebec04f8e852a2/libs/langchain-core/src/utils/callbacks.ts#L3-L14), `main` on 2026-10-17), and LangGraph can then send run data to LangSmith ([docs](https://docs.langchain.com/langsmith/trace-with-langgraph)). The app promises no telemetry (`AGENTS.md:9`). So `W/load-graph.ts` must delete those four variables from `process.env` before the dynamic import that loads LangGraph (10.8 GR3 tests it). UNVERIFIED for `@langchain/core` 1.2.18 (U6).

**Dependencies** (server package; exact versions, MIT, checked 2026-10-17): `@langchain/langgraph` 1.5.1 ([npm](https://registry.npmjs.org/@langchain/langgraph/latest); peers `@langchain/core ^1.1.48`, `zod ^3.25.32 \|\| ^4.2.0`; repo zod `^4.4.3`, the catalog entry at `pnpm-workspace.yaml:25`), `@langchain/core` 1.2.18 ([npm](https://registry.npmjs.org/@langchain/core/latest)), `@langchain/langgraph-checkpoint` 1.2.0 ([npm](https://registry.npmjs.org/@langchain/langgraph-checkpoint/latest)) and, as `devDependency`, `@langchain/langgraph-checkpoint-validation` 1.2.0 (D6; [npm](https://registry.npmjs.org/@langchain/langgraph-checkpoint-validation/latest)), which needs `vitest ^4.1.11` while the repo has `^4.1.7` (`pnpm-workspace.yaml:24`): UNVERIFIED together. The Electron build inlines these packages (`externalizeDeps` false, `apps/electron/electron.vite.config.ts:75`) and the app ships no `node_modules` (`AGENTS.md:87`): UNVERIFIED (U1).

---

### 3.2 The workflow graph

Figure 1. A solid arrow is a normal edge. A dotted arrow is a cancel or stop edge. A blue node calls an LLM. A grey node is code. Section 4 defines each node.

```mermaid
flowchart TD
    START([START]) --> prepare["prepare<br/>code"]
    prepare -->|stages has enhance| correctChunk["correctChunk<br/>LLM, one task for each chunk"]
    prepare -->|stages is summarize only| summarize["summarize<br/>LLM, single call or map then reduce"]
    prepare -.->|fault| STOPPED(["run ends, runner records it"])

    correctChunk --> identifySpeakers["identifySpeakers<br/>LLM"]
    identifySpeakers --> verifyEvidence["verifyEvidence<br/>code"]
    verifyEvidence -->|enhance only| save["save<br/>code"]
    verifyEvidence -->|stages has summarize| summarize
    summarize --> save

    correctChunk -.->|cancel or stop| save
    identifySpeakers -.->|cancel or stop| save
    verifyEvidence -.->|cancel or stop| save
    summarize -.->|cancel or stop| save

    save --> DONE(["END"])
    save -.->|meeting deleted| ENDED(["run ends, no row left"])

    classDef llm fill:#e8f0fe,stroke:#4a6fa5
    classDef code fill:#f4f4f4,stroke:#888
    classDef terminal fill:#ffffff,stroke:#999
    class correctChunk,identifySpeakers,summarize llm
    class prepare,verifyEvidence,save code
    class START,DONE,STOPPED,ENDED terminal
```

All 11 Mermaid blocks of the first draft passed `mmdc` 11.12.0 (Chrome 155.0.8059.80) on 2026-10-17, exit code 0. The review then edited some blocks (for example this figure and the graph in 11.3). `mmdc` did not run on the edited text, and a reader checked the syntax by eye (UNVERIFIED by `mmdc`). The coordinator runs `mmdc` on all 11 blocks before the spec merges.

**Edge rules.**

1. **Entry.** After `prepare`, a router reads `stages`. If it holds `enhance`, it returns one `Send("correctChunk", input)` for each chunk (`LD:use-graph-api`). If it is `["summarize"]`, it returns `"summarize"`.
2. **Barrier and order.** Nodes of one super-step run in parallel. A sequential node starts in the next super-step (`LD:graph-api`). So `identifySpeakers` starts after every `correctChunk` task ends. It does not read the corrections (4.3.2) and a local endpoint runs one call at a time (3.5), so a parallel branch gains nothing. Section 4 can change the order with no change here.
3. **After `verifyEvidence`.** Return `"summarize"` if `stages` holds `summarize`, else `"save"`.
4. **Cancel and stop.** After every node a router calls `ctx.isCancelled()` and `ctx.isStopped()`. If either is true, it returns `"save"`. A cancelled pass keeps its finished chunks, as today (R:1073-1076, N:459-470). `isStopped()` is true after a run-wide failure or the failure breaker (3.4.5).
5. **A failed unit is not an edge.** A node turns a final failed call into a typed result and returns it (4.0.2, 5.6 rule 2). `guardNode` turns any other fault of a node into a typed `internal` failure, and the graph goes to `save` (4.0.2). Two faults end the run: a fault of `prepare` and a fault of the checkpoint saver (3.4.6). Failure of each node: 4.1 to 4.6.
6. **No cycle.** The longest path has six nodes. The default recursion limit is 25 super-steps (`LD:graph-api`). The length route of section 4 runs inside a node.
7. **No node retry policy.** A unit, not a node run, is the retry boundary (5.6, X7). No node sets `retryPolicy` or `timeout`. LangGraph does not retry without a policy (`LD:fault-tolerance`). Its default `retryOn` reads `status`, not the AI SDK `statusCode` (`LG:pregel/retry.ts#L28-L58`), so the custom `retryOn` of D5 is `gatewayRetryOn`, run for each unit by `callUnit` (5.6, Q9). A node `timeout` would count the lane wait (3.5 rule 4). Each LLM node sets an `errorHandler` (LangGraph 1.4.0 and later, `LD:fault-tolerance`) as a backstop for what `guardNode` misses. It records a typed `internal` failure and returns `Command({ goto: "save" })` (UNVERIFIED, U11).

---

### 3.3 Graph state

The state holds the run inputs and the typed node results. It never holds a prompt, a raw response or a parsed model object. The recorder keeps those (D10).

```ts
// W/state.ts. Working shape. Section 4 owns the result types. Not compiled.
import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type {
  CorrectChunkResult, IdentifySpeakersResult, PreparedMeeting,
  ResolvedModels, // section 5
  SaveResult, // 4.6: the outcome of each write, the counts and the failures of `save`
  SummarizeResult, VerifyResult,
} from "./types.js";

export const StageSchema = z.enum(["enhance", "summarize"]);

/** One entry for each chunkIndex. A later write replaces an earlier one. */
function mergeByChunkIndex(cur: CorrectChunkResult[], next: CorrectChunkResult[]) {
  const byIndex = new Map(cur.map((r) => [r.chunkIndex, r]));
  for (const r of next) byIndex.set(r.chunkIndex, r);
  return [...byIndex.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export const WorkflowState = new StateSchema({
  runId: z.string(), // set once by the runner
  meetingId: z.string(),
  stages: z.array(StageSchema).min(1),
  // Set once by prepare (4.1). The model for each node is fixed here (4.1 P9).
  prepared: z.custom<PreparedMeeting>().nullable().default(null),
  models: z.custom<ResolvedModels>().nullable().default(null),
  // Fan-out results.
  corrections: new ReducedValue(
    z.array(z.custom<CorrectChunkResult>()).default(() => []),
    { inputSchema: z.array(z.custom<CorrectChunkResult>()), reducer: mergeByChunkIndex },
  ),
  // Single results. Each node writes its own field once.
  identify: z.custom<IdentifySpeakersResult>().nullable().default(null),
  verify: z.custom<VerifyResult>().nullable().default(null),
  summary: z.custom<SummarizeResult>().nullable().default(null),
  saved: z.custom<SaveResult>().nullable().default(null),
});
```

`ReducedValue` takes the value schema and an object with `reducer` and an optional `inputSchema` (`LG:state/values/reduced.ts#L44-L57`). `StateSchema` is the documented form (`LD:use-graph-api`). Nobody has compiled the snippet (U9).

**Checkpoint.** `prepared` dominates: the raw text of every segment (4.1), about 190 KB for 4 hours (section 7.11 sizes the tables). `models` holds no API key (section 5). A checkpoint lives while its run is `running` or `interrupted`; the runner deletes the thread at a final status (3.4.6).

**Why `prepared` is in the state.** A `Send` branch receives its payload as the input of the target node. The docs call it "the state to pass to that node" (`LD:graph-api`), and the source sets the task input to the `Send` argument (`LG:pregel/algo.ts#L943-L945`). The docs do not say in words that the graph state is withheld, so the claim rests on that source line (UNVERIFIED by a run). So the router puts one chunk into `CorrectChunkInput`: `runId`, `chunkIndex`, the chunk segments, the language, the vocabulary terms and the `correctChunk` entry of `models`. It is a slice of `PreparedMeeting`; 4.2 defines the type and reads it (X1). The checkpoint before the `correctChunk` super-step probably also holds the 40 payloads, about 190 KB more (UNVERIFIED, U10). Rejected: ids only, with each branch reloading the transcript (`loadMergedTranscript` is heavy, R:253-308, and a resume could see another transcript).

**Changed transcript.** A re-transcribe deletes all segments (R:1546-1558) and the new segments reuse the id format `<meeting>:<source>:<idx>` (R:420). So `prepare` stores `inputHash` (4.1 P11) and a resume compares it with a fresh hash (3.4.7).

**Reducer rule.** A reducer must give the same state for a repeated write. `mergeByChunkIndex` keys on the chunk index. LangGraph already skips a finished task after a resume. The docs say a resume does not run the successful nodes of the failed super-step again (`LD:checkpointers`). In the source, a resume hands the saved writes back to the finished tasks (`LG:pregel/loop.ts#L1362-L1363`, `LG:pregel/loop.ts#L2355-L2379`). The runner starts only tasks that have no writes (`LG:pregel/runner.ts#L137`). A resume with only a `thread_id` names no `checkpoint_id`, so the loop does not treat it as a time travel and keeps `skipDoneTasks` on (`LG:pregel/loop.ts#L798-L801`, `LG:pregel/loop.ts#L1669-L1671`).

---

### 3.4 Run lifecycle

#### 3.4.1 Two registries

The job registry stays: an in-memory `Map` (J:53), one slot for each meeting (J:81-90), live progress and the cancel flag (J:13-30, J:62). The run records (the recorder tables, 7.7) are new: SQLite rows, many for one meeting, for history, resume and the final result. A running run holds one job; an `interrupted` run holds none.

#### 3.4.2 Start

The routes keep their guards and messages. Unknown id: 404. Wrong status, running job or empty transcript: 409 (R:2070-2085, R:2103-2117). `startRun({ meetingId, stages, trigger })` has a synchronous part with no `await`, so no request can slip between the check and the claim (J:7-9, R:2118-2124).

1. `claimJob(meetingId, kind, progress, controller)` takes the slot. Kind is `enhance` if `stages` holds `enhance`, else `summarize`. A `false` result gives 409.
2. The recorder (`startRun`, 7.7) inserts the run row with status `running` in one transaction. The same transaction marks older `interrupted` rows of the same stages as `cancelled` and deletes their checkpoints. The screen offers Resume before it offers this start (8.9). A foreign key failure means the meeting is gone: `startRun` returns `no_meeting`, the runner releases the job and the route answers 404.
3. `void execute(runId, "start")` runs the graph in the background. `execute` never throws: its whole body, including the first database call, sits in one `try`, and the `finally` releases the job. (`runSummarizeJob` calls `getDb()` before its `try`, R:1164, R:1169.)
4. The route answers 202.

`prepare` loads language, vocabulary, title, context and attendee names itself, so a start needs only the meeting id and the stages. The auto-run handoff calls `startRun` where it calls `runEnhanceJob` today (R:1039-1045).

`execute` calls `graph.invoke(input, config)` with `configurable: { thread_id: runId }`, `durability: "sync"` (the default `"async"` can lose the last checkpoint in a crash; `LD:checkpointers`), `maxConcurrency: WORKFLOW_FANOUT_CAP` (3.5) and `signal`, the hard-stop signal (3.4.5). The runner registers a run context before `invoke`. Nodes find it by run id through `deps.getRunContext(runId)`. The `deps` object is the `WorkflowDeps` (below) that `buildGraph(deps)` closes over. A resume registers a new context.

**Injection seams.** Every effect that a test must replace sits in one object, `WorkflowDeps`. `buildGraph(deps)`, each node factory, `callUnit` (5.6) and the runner take it. Production builds it once with `productionDeps()`. A test builds its own and replaces only the fields it needs. No module-level `recorder` or `sleep` exists.

```ts
// W/context.ts (WP5a). Working shape. Not compiled.
export interface WorkflowDeps {
  db: DatabaseSync;                    // `getDb()` in production (`S/lib/db.ts:14`). The saver, the recorder and `save` will use it, with `withTransaction(db, fn)` (`S/lib/db.ts:61`). None of the three files exists at c47cd80d
  recorder: LlmRecorder;               // 7.7. It is also the CallSink of every call (5.1)
  callStructured: <T>(i: CallStructuredInput<T>) => Promise<CallStructuredResult<T>>; // 5.1. Node tests replace it with a fake gateway (10.2 rule 2)
  createModel?: CreateModel;           // the gateway seam (5.1). Unset in production: `createChatModel`. A scripted `MockLanguageModelV4` enters here. `callUnit` copies it into each call
  sleep: (ms: number, signal: AbortSignal) => Promise<void>; // the retry wait of `callUnit` (5.6). Rejects with `CancelledError` when the signal aborts. A test passes an instant `sleep` (10.2 rule 4)
  now: () => number;                   // epoch ms for run and step times. `Date.now` in production
  loadTranscript: typeof loadMergedTranscript; // `S/lib/meetings/transcript-io.ts` (3.1). `prepare` calls it
  getRunContext: (runId: string) => RunContext; // the runner registers the context before `invoke`. It throws when none exists
  probeEndpoint: (p: CallProfile) => Promise<boolean>; // `gateway.ts` (5.7). The runner calls it before a boot resume (3.4.7)
  reasoningSteps?: ReasoningSteps;     // the test hook of 5.5 rule 4. `prepare` passes it to `resolveModels`. Unset in production
}
export declare function productionDeps(): WorkflowDeps; // the real wiring
// W/graph.ts: export declare function buildGraph(deps: WorkflowDeps): CompiledWorkflow; it compiles with `new NodeSqliteSaver(deps.db)`.
// W/load-graph.ts: export declare function loadGraph(deps: WorkflowDeps): Promise<CompiledWorkflow>; it removes the four variables (3.1 rule 2), then calls `buildGraph`.

export interface RunContext {
  readonly runId: string;
  readonly meetingId: string;
  readonly signal: AbortSignal; // soft cancel: user cancel or deleted meeting
  isCancelled(): boolean;
  isStopped(): boolean; // a run-wide failure or the breaker stopped the run (3.4.5)
  stopRun(kind: FailureKind): void;
  recordLost(): void; // a call whose record write failed (7.7)
  progress: {
    addTotal(calls: number): void;
    callEnded(outcome: "ok" | "failed"): void;
    onQueued(info: { waitedMs: number; ahead: number }): void;
  };
  setInputHash(hash: string): void; // `prepare` calls this once; the runner stores it
}
```

HTTP contract.

| Request | Answer |
|---|---|
| `POST /api/meetings/:id/enhance` | 202 `StartRunResponse` (below), `stages = ["enhance"]`. Today it holds the request open for the whole pass (R:2101-2206). |
| `POST /api/meetings/:id/summarize` | 202 `StartRunResponse`, `stages = ["summarize"]`. Same 202 and polling as today (R:2068-2095). |
| `POST /api/meetings/:id/runs/:runId/resume` | 202 `StartRunResponse` (`runId` is the resumed run). 404 for an unknown meeting or run. 409 `ResumeConflict` (below) when a guard fails (3.4.7). The Resume button calls it (8.9). |
| `POST /api/meetings/:id/cancel-transcribe` | Unchanged. It cancels a run through `requestCancel` (R:1576-1591). |
| `GET /api/meetings/:id` | Unchanged: `job` and `job_error` stay. The renderer reads runs from `GET /:id/llm-runs?latest=1` (8.3; X4). |

```ts
// V/meeting-types.ts (types only, 8.4). WP5b adds both types. Every other error body stays { error: string } (R:2070-2085, R:2103-2117).
export interface StartRunResponse { ok: true; id: string; runId: string } // id = meeting id; today's 202 body is { ok: true, id } (R:2094)
export type ResumeConflictReason =
  | "meeting_status"     // guard 1: the meeting status is not `transcribed` or `summarized`
  | "job_running"        // guard 2: a job holds the slot
  | "not_interrupted"    // guard 3: the run status is not `interrupted`
  | "graph_changed"      // guard 4: `graph_version` differs. The run is now `failed`.
  | "no_checkpoint"      // guard 5: the thread has no checkpoint. The run stays as it was.
  | "transcript_changed"; // guard 6: `input_hash` differs. The run is now `failed`.
export interface ResumeConflict { error: string; reason: ResumeConflictReason } // error: one English line for the generic notice (`P:719-725`)
```

The reason list is closed: one value for each guard of 3.4.7, in guard order. The renderer shows `error` for guards 1, 2, 3 and 5, where the run row does not change. For guards 4 and 6 the run row is now `failed`, and the notice reads its `errorKind` (8.9).

With the flag `meeting_enhance_workflow` off, the start routes keep today's contract (200 or 502 for Enhance) until WP11 (11.5 WP5b, 12.2 Q1).

Old answers of `POST /:id/enhance` map to run status. Read the 200 body in this order (the body is R:2185-2195; `partial` is `chunksFailed > 0` at R:2193 and `stopped_early` is at R:2194): 200 `stopped_early: true` is `cancelled`, even when `partial` is `false`; else 200 `partial: false` is `succeeded`; else 200 `partial: true` is `partial`. A cancel with no failed chunk returns `partial: false` and `stopped_early: true`, so the order matters. The 502 branch needs `!result.stoppedEarly` (R:2150-2154), so a cancel never gives 502. A 502 with every chunk failed (R:2150-2175) is `failed`, or `partial` when `identifySpeakers` saved a suggestion (4.6.3); 500 (R:2196-2199) is `failed`.

**Why 202.** A run must survive a restart, which a long request cannot carry. One path serves the button and the auto-run, whose full failure leaves only a log line today (R:1103-1117). The renderer already polls while `job.kind` is `enhance` (`P:122-127`) and keeps an Enhance failure in component state (`P:87-89`, `P:358-382`). After the change it posts, polls and reads the newest run from `llm-runs?latest=1`, so a reload keeps the failure (8.9).

#### 3.4.3 Run row and status

The run row (working names; section 7 owns the DDL): `id` (UUID, equals the LangGraph `thread_id`), `meeting_id` (foreign key to `meetings`, `ON DELETE CASCADE`, D10), `stages` (JSON list), `trigger` (`button` or `auto`: the first trigger for the whole life of the run; a resume never changes it and adds one to `resume_count`, so `resume_count` above 0 marks a resumed run), `status` (`running`, `interrupted`, `succeeded`, `partial`, `failed`, `cancelled`), `graph_version` (`WORKFLOW_GRAPH_VERSION` at start), `input_hash` (`inputHash` of `prepare`, 4.1 P11; null until `prepare` ends), `resume_count`, `failure` (JSON `{ code, message }` for the whole run), `started_at` and `ended_at` (epoch ms). Failure codes: the node failure kinds of section 4 plus `interrupted_before_checkpoint`, `graph_changed`, `transcript_changed` and `internal`. `save` writes node records (SW4), and verdicts and call links with their data (SW1 to SW3), not this row (4.6.1). The working names differ from the DDL (7.4): `kind` for `stages`, `started_by` for `trigger`, `error_kind` and `error_detail` for `failure`, `finished_at` for `ended_at` (X3). The column `kind` holds `enhance` when the stage list holds `enhance`, else `summarize` (3.4.2 step 1). The checkpoint state keeps the full list (3.3). The run status word is `succeeded` everywhere: stored, API and UI (R16, 11.4). A node status `ok` of section 4 is stored as step status `succeeded`. A step with some failed halves is stored as `partial` (4.0.7).

```mermaid
stateDiagram-v2
    [*] --> running: start
    running --> succeeded: all nodes ok or skipped
    running --> partial: something saved and a node failed
    running --> failed: fatal error or nothing saved
    running --> cancelled: user cancel or hard stop
    running --> interrupted: boot sweep finds a checkpoint
    running --> interrupted: graph error with a checkpoint
    running --> failed: boot sweep finds no checkpoint
    interrupted --> running: resume
    interrupted --> failed: graph version or transcript changed
    interrupted --> cancelled: a newer run replaces it
    succeeded --> [*]
    partial --> [*]
    failed --> [*]
    cancelled --> [*]
```

Figure 2. Run status. A deleted meeting has no row to show a status; the runner calls that outcome `meeting_deleted` (4.0.7) and stores nothing (4.6.3).

The runner derives the final status from the final state with one pure function, `deriveRunStatus`, in `W/types.ts` (WP5a). The runner (WP5b) calls it in `execute` (3.4.6 step 1). A WP5a test can check the status of a hand-built final state without the runner (10.8, GR23).

```ts
// W/types.ts (WP5a). Pure: no database, no clock. SaveResult: 4.6. foldStatus: 4.0.7.
export interface FinalState { // the fields of the graph state (3.3) that the function reads
  stages: ("enhance" | "summarize")[]; corrections: CorrectChunkResult[]; // stages: StageSchema (3.3)
  identify: IdentifySpeakersResult | null; verify: VerifyResult | null;
  summary: SummarizeResult | null; saved: SaveResult | null;
}
export interface RunEnd {
  cancelled: boolean;                  // the soft-cancel flag is set. A hard stop sets it first (3.4.5)
  fault: "none" | "prepare" | "graph"; // `prepare` threw, or another graph error (a saver fault, an escaped bug)
  hasCheckpoint: boolean;              // the thread has a checkpoint
}
export declare function deriveRunStatus(s: FinalState, end: RunEnd): RunStatus | "interrupted";
```

The function first finds the status of each node of the stage list in the final state.

| Node (stage) | Status |
|---|---|
| `correctChunk` (`enhance`) | `foldStatus` over `corrections[].status` (4.0.7). No entry: `skipped` |
| `identifySpeakers` (`enhance`) | `identify.status`. `identify` is null: `skipped` |
| `verifyEvidence` (`enhance`) | `verify.status`. `verify` is null: `skipped` |
| `summarize` (`summarize`) | `summary.status`. `summary` is null: `skipped` |

Then the first matching rule wins. The last column is the run `failure` code that the runner writes with the status (3.4.6 step 3).

| # | Condition | Run status | `failure` code |
|---|---|---|---|
| 1 | `saved` is not null and `saved.meetingGone` | `meeting_deleted`: the runner stores no row (3.4.8) | none |
| 2 | `end.cancelled` | `cancelled` | none |
| 3 | `end.fault` is `prepare` | `failed` | the typed code of the `prepare` failure |
| 4 | `end.fault` is `graph` | `interrupted` when `end.hasCheckpoint`, else `failed` | `internal` |
| 5 | Every node status of the stage list is `ok` or `skipped`, `saved` is not null, and `saved.failures` is empty | `succeeded` | none |
| 6 | `saved` is not null and `saved.wroteAny` | `partial` | none |
| 7 | Any other case | `failed` | none |

A `partial` or `failed` run from rule 6 or 7 has no run `failure` code. Its failed steps carry the error kinds, and 8.9 reads them there. Rule 5 cannot hide a run-wide stop (3.4.5): a stop starts with a final failure, so the node of that failure has status `failed` or `partial`.

Examples. Each one is a test case of GR23 (10.8).

| Final state | Rule and result |
|---|---|
| Chunk 2 ends `content_filter`, the other chunks and `identifySpeakers` are `ok`, SW1 and SW2 are `ok` (GR5) | 6: `partial` |
| The first request gets HTTP 401. Chunk 0 is `failed`. The other chunks, `identifySpeakers` and `verifyEvidence` are `skipped`. SW1 and SW2 are `none` (GR18) | 7: `failed` |
| No API key at the first call (`model_unavailable` from the gateway, 0 requests): the same shape as the row above (GR21 a). A missing key at `prepare` is a `prepare` fault | 7: `failed`; at `prepare`, rule 3: `failed` |
| `verifyEvidence` throws a plain `Error` (`internal`). The corrections are `ok` and SW1 is `ok` (GR21 a) | 6: `partial` |
| SW2 fails twice and SW1 is `ok` (GR21 a). `failures` is not empty, so rule 5 does not match | 6: `partial` |
| SW1 and SW2 both fail twice. Nothing else is written | 7: `failed` |
| A Summarize run ends at its deadline. `summary.status` is `failed`, SW3 is `none` (GR22) | 7: `failed` |
| Three chunks are `ok` with no correction. `identify` is `skipped` (no label). SW1 is `ok` and `correctedCount` is 0 | 5: `succeeded` |

Only a `running` run holds the job slot. For every other status `GET /:id` returns `job` null. The screen for each status is in 8.9.

#### 3.4.4 Progress

The job blob keeps its shape (J:13-30, `V/meeting-types.ts:36-53`), so renderer polling does not change. Each node adds its planned calls to `total` at its start (`correctChunk`: one for each chunk; `summarize`: 4.5.3). `done` counts ended calls and `failed` counts typed failures. `queued` comes from the lane callback `onQueued` (L:275-283); the runner keeps the entry with the smallest `ahead`. Nodes report through `ctx.progress`, never to the registry. The recorder writes each call record when the call ends, so the inspector shows calls during the run (section 8).

#### 3.4.5 Cancel

**Soft cancel** (normal).

1. `POST /:id/cancel-transcribe` and `DELETE /:id` already call `requestCancel(id)` (R:1587, R:2265). The changed `requestCancel` also aborts the `AbortController` that `startRun` passed to `claimJob`.
2. The gateway composes this signal with the call timeout: `AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)])` ([Node docs](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals)). The timer starts after the lane lease. An in-flight call stops; today it runs to its end (L:25-27).
3. A call that waits in the lane stops at the next poll tick, about 50 ms (L:402-413, L:455-462). This needs the `signal` option in `withLlmLane`.
4. A node that sees the abort returns a result with kind `cancelled`. It does not throw.
5. The routers send the graph to `save` (edge rule 4). `save` writes the finished chunks and suggestions. A cancelled `summarize` writes no summary (4.6.3).

**Hard stop** (fallback). The runner arms a timer when the soft signal fires. After `HARD_STOP_GRACE_MS` (30 s) it aborts the signal that it passed to `graph.invoke`. LangGraph then rejects the run with `Error("Abort")`. An abort listener rejects with that error (`LG:pregel/runner.ts#L324-L331`), and the task loop races the listener promise against the running tasks (`LG:pregel/runner.ts#L359-L363`). A signal that is already aborted at the start of a super-step throws the same error (`LG:pregel/runner.ts#L310-L314`). The run ends as `cancelled` and `save` does not run. A hard stop needs a node that ignores its signal. That is a defect.

**Why the user cancel is not the `invoke` signal.** That signal rejects at once. It reaches the runner as `config.signal` (`LG:pregel/index.ts#L2882`). Its abort listener rejects (`LG:pregel/runner.ts#L324-L331`). The task loop races that promise (`LG:pregel/runner.ts#L359-L363`). LangGraph keeps the results of finished sibling tasks only as pending writes (`LG:pregel/runner.ts#L479-L480`). They join the state when every task of the super-step has writes (`LG:pregel/loop.ts#L1205-L1218`). The docs say the full state snapshot is committed once the super-step completes (`LD:checkpointers`). A cancel by that signal would lose the finished chunks of the running super-step, most of the work. Today a cancel keeps them (N:459-465). UNVERIFIED by a run (U3).

**Run-wide stop.** A final failure with `runWide` true (5.2.1) calls `ctx.stopRun(kind)`. A unit that has not started a call then returns status `skipped` and sends no request. A call that waits in the lane ends when its lease opens, with no request (5.1 step 4). A running call ends by itself. A router sends the graph to `save` (edge rule 4). The same happens after `BREAKER_N` = 3 final failures of one kind in a row in one node. So a cause that hits every unit, such as a missing key, costs one request, not one for each chunk (X2, GR18).

**Run deadline.** `summarize` keeps today's job ceiling (4.5.3, R:1170-1210). It gives the gateway `AbortSignal.any([ctx.signal, AbortSignal.timeout(ceilingMs)])`. The gateway reads `signal.reason`: a `TimeoutError` is the ceiling, any other reason is a cancel (5.7). At the ceiling the gateway throws `deadline_exceeded`, the node skips its remaining calls and writes no summary, and the run ends `failed`.

#### 3.4.6 Finish

`execute` ends in one `finally` block. It never throws.

1. Derive the status and the `failure` code with `deriveRunStatus` (3.4.3). Its rules cover a fault of `prepare` (`failed`, typed code), any other graph error (a saver fault, an escaped bug: `interrupted` with code `internal` when a checkpoint exists, else `failed` with code `internal`) and a hard stop (`cancelled`).
2. If the meeting row is gone (`saved.meetingGone`, or a missing row found now), log one info line and stop. Skip steps 3 to 5 (3.4.8).
3. Write `status`, `ended_at`, `failure`, `corrected_count`, `suggestion_count` and `lost_records` in one statement. `corrected_count` and `suggestion_count` come from `saved.correctedCount` and `saved.suggestionCount` for a run of kind `enhance`. They are NULL for a Summarize run and when `saved` is null (`RunFinish`, 7.7). The runner is the only writer of `status` (through the recorder).
4. Close every step row of the run that is still `running`: `cancelled` after a hard stop, `interrupted` for an interrupted run, else `failed` with the run's error kind. The boot sweep closes steps only for runs that are still `running` (7.12).
5. Delete the checkpoints of the thread at every final status: `succeeded`, `partial`, `failed` and `cancelled`. Keep them only for `interrupted`. This is the one rule for checkpoint deletion (7.9, 12.4). Only an `interrupted` run can resume (3.4.7 guard 3), so a checkpoint of any other status has no use and costs space (7.11). A failure here only logs a warning. The tests are GR17 (10.8).
6. For a failed run with stage `summarize`, call `setJobFailure`. The renderer reads `job_error` until WP11 removes it (8.13 O8-2, 11.5; R:1240, J:142-144).
7. Call `releaseJob` and drop the run context.

`save` rewrites `transcript.md` and `transcript-enhanced.md` (4.6.5). Enhance never changes `meetings.status` (R:1073-1076). Only a saved summary sets `summarized` (R:1228-1230). No other code in `apps/server/src` or `apps/electron/src/main` writes that status (a search for `summarized` on 2026-10-17 finds only that update, the status checks at R:1750, R:2072 and R:2105, and the table constraint at `S/lib/schema.ts:768`).

#### 3.4.7 Boot sweep and resume

The server process starts with the app: `app.whenReady` awaits `startServerHost` (`E/main/index.ts:243`), which calls `spawnChild` (`E/main/server-host.ts:269`). `spawnChild` forks the process (`E/main/server-host.ts:123`). The app also restarts a crashed server: the exit handler calls `scheduleRestart` (`E/main/server-host.ts:141-145`), and the restart timer calls `spawnChild` again (`E/main/server-host.ts:196`). The host reuses a live server (`E/main/server-host.ts:238-248`). So a `running` row at boot has no live job (J:10).

**Boot sweep.** `startServer` calls `sweepOrphanRuns()` before `serve()`, next to `sweepStaleWhisperServer()` (`S/index.ts:211`, `:226`). It uses synchronous SQL only and does not load LangGraph. For each `running` row:

- If the thread has a checkpoint, set `interrupted`.
- If not, set `failed` with code `interrupted_before_checkpoint`. LangGraph writes the first checkpoint, the input checkpoint, at the start of an `invoke` that has an input (`LG:pregel/loop.ts#L1909-L1910`). Without it, a call with null input raises `EmptyInputError` (`LG:pregel/loop.ts#L1913-L1916`), so a new run is the only way.

**Boot resume.** After the server listens, `resumeInterruptedRuns()` runs in the background. For each `interrupted` row with `resume_count < MAX_AUTO_RESUMES` (value 1) and no `failure`, it first calls `probeEndpoint` (5.7) for each distinct endpoint in the `models` of the checkpoint state that the stage list uses. The probe covers a local `server` and a cloud provider (5.7, Q15). It tries `BOOT_PROBE_TRIES` = 10 times, `BOOT_PROBE_WAIT_MS` = 15 000 ms apart. If an endpoint stays down, the row stays `interrupted`, the resume is not counted and the user can click Resume. Otherwise it calls `resumeRun`. Without the probe, a reboot with no network yet, or an oMLX restart, would fail every unit with `provider_unavailable`, end the run and delete its checkpoint. The cloud case is the same as the local case: the first resume would be used up and the finished work could not continue. If the process dies again during the resumed run, the next boot leaves it `interrupted` and the user clicks Resume (8.9). This stops a crash loop and follows goal G6. A row that a graph error set to `interrupted` (3.4.6) has a `failure` and waits for the button.

**`resumeRun` guards.** All must pass. A failed guard gives 409 with a `ResumeConflict` (3.4.2). Guards 4 and 6 also end the run: the run becomes `failed`, and the runner deletes its checkpoints (3.4.6 step 5). Guards 1, 2, 3 and 5 leave the run row as it was. The reason for each guard is in `ResumeConflictReason` (3.4.2).

1. The meeting exists and its status is `transcribed` or `summarized`. Reason `meeting_status`.
2. No job holds the slot. Reason `job_running`.
3. The run status is `interrupted`. Reason `not_interrupted`.
4. `graph_version` equals `WORKFLOW_GRAPH_VERSION` (below). Otherwise the run becomes `failed` with `graph_changed`.
5. A checkpoint exists. Reason `no_checkpoint`. The boot sweep and 3.4.6 set `interrupted` only when a checkpoint exists, so this guard is a defensive check. The user can still click "Start again" (8.9).
6. A fresh `inputHash` equals `input_hash`. The fresh value is `inputHash(loadHashRows(db, meetingId), hashVariantOf(run.kind))` (4.1 P11). Otherwise the run becomes `failed` with `transcript_changed`. For a run with the stage `enhance`, the hash covers the segment ids, the raw text and the effective speaker label. A re-transcribe, a re-diarize and a speaker merge change it. A name confirmed while the run is stopped does not change it: SW2 writes only `suggested_*` (4.6.1), so it cannot overwrite that name. For a run with only the stage `summarize`, the hash also covers `enhanced_text` and the confirmed name of each segment, because the summary prints both (4.5). So a new Enhance run changes the hash, and so does a name confirmed while the run is stopped. The run then ends with `transcript_changed`, and the user starts it again. This stops a resumed run from mixing old and new text. The owner can overrule this default (12.2 Q13). Re-diarize passes its only guard while a run is `interrupted` (`R:1762`), then rewrites the labels (`apps/server/src/lib/meetings/diarize.ts:535`, `R:1827-1828`). Skip this check when `input_hash` is null (`prepare` had not ended).

**Graph version.** `WORKFLOW_GRAPH_VERSION` is an integer constant in `W/types.ts`. It starts at 1. The runner copies it into `llm_runs.graph_version` at start (3.4.3). Bump it by 1 in the same PR that changes any of these items. (1) The nodes or edges of Figure 1. (2) A field of the graph state (3.3) or a node result type (section 4). (3) A node schema (4.2.1, 4.3.1, 4.5.1). (4) A prompt in `W/prompts.ts`. (5) A constant of 4.0.5. (6) The unit key grammar (4.0.7). (7) The choice of model or reasoning in `resolveModels` (5.1). A checkpoint or a finished call of an older version could give a result that the new code does not expect. So guard 4 refuses the resume. The snapshot test of the schemas (10.5.4) changes in the same PR, which tells the reviewer to check this rule. Test GR11 stores another version in the run row and expects `graph_changed`.

**Resume.** `resumeRun` claims the job, sets `status = running`, adds one to `resume_count` and calls `graph.invoke(null, config)` with the same `thread_id`. LangGraph continues from the last checkpoint (`LD:checkpointers`). A previous checkpoint is always needed; null input is one accepted form (`LG:pregel/loop.ts#L1641-L1645`; the resume test treats a null or undefined input as a resume when channel versions exist, `LG:pregel/loop.ts#L647-L651` and `LG:pregel/loop.ts#L660-L663`), and this spec uses only that form. Finished nodes do not run again. A node that was running restarts from its start: `prepare` (it only reads); `correctChunk` only for chunks without a saved result; `identifySpeakers` and `summarize` from their start, but `callUnit` reuses each finished call from the call record (5.6), so a finished map call is not sent again; `save` (every write is idempotent, 4.6.2).

The Electron orphan sweep does not change (R:1349-1367, `E/main/meeting-recorder.ts:803-857`), because a run never changes the meeting status. UNVERIFIED for a kill during a super-step with `Send` tasks (U2).

#### 3.4.8 A meeting deleted during a run

`DELETE /:id` does not wait for a job. It asks the job to stop, removes the audio folder and deletes the row (R:2255-2286). Section 7 owns the cascade (7.4, 7.9, 7.12): foreign keys with `ON DELETE CASCADE` serve the run, call and checkpoint tables. The fallback of 7.9 (O7-3) is a `DELETE` trigger on the run table that removes the checkpoint rows, so the saver tables need no foreign key. A probe on 2026-10-17 (`node:sqlite`, Node v26.5.0) showed that such a trigger fires on a cascade. UNVERIFIED on Node 22.22.1 (U5). Runner rules:

1. `DELETE` calls `requestCancel` (soft cancel, 3.4.5) and then deletes the row. A write in the recorder, the saver or `save` can then fail with a foreign key error. Each catches it and checks `getMeetingRow(id) === undefined` (`S/lib/meetings/store.ts:90-95`; `getMeetingRow` returns `undefined`). A recorder error never fails a call. A saver error ends the graph. Do not copy the `=== null` test of `runEnhanceJob` (R:1119-1127): it never matches a deleted meeting (R:1127-1130).
2. `save` checks that the meeting row exists before each write (4.6.4).
3. The `finally` block of `execute` sees no row. It logs `ended because the meeting was deleted`, skips the run update and the markdown write (R:1139) and releases the job. A delete between the route checks and the run insert gives a foreign key error at step 2 of 3.4.2, and the route answers 404.

---

### 3.5 Concurrency

**Today.** One lane serves each endpoint. The lane key is the server root of a local provider (L:194). For a known cloud provider, it is the host from the map at L:109-119 (used at L:205). For any other provider, it is the provider id (L:205). The limit is 1 for a local provider (L:195) and 2 for a cloud provider (L:206). The two constants are at L:106-107, and the rule is described at L:174-179. A call holds a slot for that call only (L:21-24, L:506-519). Meeting calls use class `background` (C:126-134), wait until dictation has been idle for 15 s (L:87-91, L:415-425, `apps/server/src/lib/dictation-activity.ts:78`) and queue behind `interactive` calls (L:291-300). The queue is in memory (L:211-213).

**Rules for the workflow.**

1. Every call goes through the gateway. The gateway takes the lane for each call. No node holds a lease across calls.
2. **Fan-out cap.** LangGraph starts every task of a super-step at once, unless the config sets `maxConcurrency` (`LG:pregel/runner.ts#L340`). The runner sets `WORKFLOW_FANOUT_CAP = LLM_LANE_CONCURRENCY_CLOUD + 1`, which is 3 (L:107). At most three `correctChunk` tasks are alive: on a cloud endpoint two calls run and one waits, on a local endpoint one runs and two wait. The engine has no gap between chunks, and the lane stays the only throttle.
3. Only `correctChunk` fans out. `identifySpeakers` and `summarize` run alone. `summarize` makes its map calls one after the other (4.5.3).
4. **Wait time is not call time.** The call timer starts after the lease (C:126-153). The gateway records the queue wait apart from latency (sections 5, 8).
5. **Backoff outside the lease.** `callUnit` sleeps before it calls the gateway, so a waiting call holds no slot (5.6; X2).
6. **Cancel in the queue.** A queued call stops when the signal fires (3.4.5).
7. **Dictation first.** A dictation cleanup call takes the next free slot before any background call. A call on the wire is never preempted. Runs for two meetings share the lane in call order with no extra code.

---

### 3.6 Summary: one graph with a list of stages

**Decision.** Summary joins the same graph. The run has a list of stages. A router skips the nodes of a stage that the list does not hold. One `save` node serves both stages. The Enhance button and the auto-run after transcription (`meeting_enhance_auto_run`) start `["enhance"]`. The Summarize button starts `["summarize"]`. No trigger starts `["enhance", "summarize"]`, although the graph supports it (OQ-2).

**Why one graph.** D1 lists `summarize` as step 5 of one workflow, and 4.5 reads the corrections of the same run when it holds them. Both stages need the same lifecycle (cancel, resume, boot sweep, deleted meeting, typed failure, inspector links), so one runner, saver, table set and route set cover both; `save` already writes the summary in SW3 (4.6.1). Rejected: a second compiled graph, which needs a second runner, route set and status list for no gain.

**Why the stages stay apart by default.**

1. A person confirms speaker names between the stages. The summary prints confirmed names only (`S/lib/meetings/merge.ts:53-59`, `S/lib/meetings/summarize.ts:313-316`), so an early summary prints "Them N". The screen already warns when names change after a summary (R:1929-1941, `P:444-448`).
2. Cost. Auto-run Enhance is off by default (N:44-58) and the owner kept it opt-in (`specs/meeting-transcription-v2.md:29`). A chained run would add up to 24 long calls to every auto-run, because a summary is capped at `MAX_SUMMARIZE_CALLS` = 24 (`S/lib/meetings/summarize.ts:108`). Today the auto-run starts `runEnhanceJob` only (R:1039-1043), and only the summarize route starts a summary (R:2093). A chained run is a design case, not code yet.
3. Isolation. A failed summary must not mark Enhance as failed, and the reverse (4.6.3).

**Combined run.** The job kind is set at start, so a combined run shows "Enhance" while it summarizes. If OQ-2 is yes, the job registry gets a `setJobKind` call at the stage change. No trigger starts a combined run in this spec.

---

### 3.7 Open questions, checks for other sections, unverified items

**Open questions for the owner.**

| ID | Question | Default |
|---|---|---|
| OQ-1 | After a restart, does an interrupted run resume by itself, or does the user click Resume? | It resumes by itself once, then waits for the button (3.4.7). This follows goal G6. A run on a cloud model can cost money at launch. |
| OQ-2 | Does the Enhance button or the auto-run also run Summarize? | No (3.6). |

**Checks for other sections.** A check has the status Applied (the named section follows it) or Open (a work package settles it).

| ID | Section | Check | Status |
|---|---|---|---|
| X0 | 1 | D5 names a custom `retryOn`. Only a `RetryPolicy` has one. | Applied: edge rule 7 and Decision (9) follow 5.6. `gatewayRetryOn` is the custom `retryOn`, and `callUnit` runs it as the one retry layer (Q9). |
| X1 | 4 | `correctChunk` takes a slice, `CorrectChunkInput`, not `PreparedMeeting` (3.3). | Applied: 4.2 Inputs. |
| X2 | 5 | The retry wait is outside the lane lease. The gateway takes one combined abort signal, reports queue wait apart from latency, and lists the failure kinds that end the whole run. | Applied: 5.1 (`signal`, `queuedMs`), 5.2.1 (`runWide`), 3.4.5 (run-wide stop), 5.6 (`callUnit` sleeps before the lease). |
| X3 | 7 | The run table has the fields of 3.4.3. Checkpoint rows go with the meeting through a foreign key or a trigger. The saver offers `deleteThread` and a thread check. `save` writes SW4 into tables that section 7 names. | Applied: 7.4 holds `input_hash`, `resume_count` and the counters; `kind` holds the stage. Checkpoint rows (7.4, 7.9) and SW4 (4.6.1). |
| X4 | 8 | The resume route exists and has a caller. The renderer polls and reads the run. | Applied: `GET /:id` has no `runs` field. 8.5 reads `llm-runs?latest=1` (8.3). The Resume button calls the resume route (8.9, WP7). The route is in `S/routes/meetings-runs.ts` (3.1, 11.4). |
| X5 | 10 | Tests to add: the saver validation suite; a kill and resume E2E run; only `W` imports LangGraph; the environment guard; graph nodes equal Figure 1; a run with a meeting deleted in the middle (3.4.8). | Applied: 10.7, 10.8 (GR1 to GR3, GR13), 10.11.3. |
| X6 | 12 | Bundle proof, asar size and the packaged smoke run (U1). | Applied: 10.14, 11.5 WP5a and WP9, 12.1 R2 and R3. |
| X7 | 5 | A node `RetryPolicy` re-runs a whole node, but `summarize` and the length route make many calls in one node run. | Applied: the unit is the retry boundary. `callUnit` retries one call once and reuses finished calls after a resume (5.6). Tests GR19 to GR21. Acceptance of WP5a and WP6. |
| X8 | 5 | The Summarize job ceiling allows one retry per call. | Applied: ceiling = `clamp(2 x perCallMs x plannedCalls, 2 x perCallMs, 4 h)` (4.5.3, 5.7). |

**Unverified items.**

| ID | Item | How to settle it |
|---|---|---|
| U1 | The LangGraph packages bundle into `server-process.js` and `check-bundled-requires.mjs` stays green (it reads only top-level files, `apps/electron/scripts/check-bundled-requires.mjs:34`). | Build with electron-vite. Run a packaged Enhance. |
| U2 | `invoke(null, config)` resumes a thread whose process died during a super-step with `Send` tasks. The docs describe a resume after a failure only. | Kill with `kill -9` during `correctChunk`, then resume. |
| U3 | `maxConcurrency` bounds a `Send` fan-out. A cancel through the `invoke` signal loses the pending writes of the running super-step. Both come from source reading. | A spike with a fake model. |
| U4 | A local engine such as oMLX stops generation when the app aborts the request. | A live call on the owner's Qwen3.8-27B. Watch the engine log. Owner: WP5b, probe LP5 (10.12, 11.5 WP5b acceptance 6). |
| U5 | The foreign key error shape and the trigger behavior hold on Node 22.22.1. The design checks `getMeetingRow(id)`, not the error code. | Run the probe in the Electron server process. |
| U6 | The four tracing variables are the same in `@langchain/core` 1.2.18 as on `main`. | Read the published `callbacks.js` of 1.2.18. Owner: WP5a, acceptance step next to GR3 (11.5 WP5a). |
| U7 | A plain `setTimeout` sleep never resolves under the fake timers of the server tests (`apps/server/tests/setup.ts:15-16`, loaded for all 92 test files by `apps/server/vitest.config.ts:21-22`). A run on 2026-10-17 showed it (10.2 rule 4), and the `callUnit` sleep and the AI SDK retry wait sleep that way, so retry tests inject `sleep` or advance the timers. UNVERIFIED: other LangGraph code under these timers. Seven files switch to real timers, for example `apps/server/tests/trace.test.ts:34`. | Run the graph test suite. If it stalls, call `vi.useRealTimers()` in the graph test file. |
| U8 | `durability: "sync"` adds no visible delay. A run writes about seven checkpoints. | Measure on a 4 hour fixture. |
| U9 | The snippet in 3.3 compiles against `@langchain/langgraph` 1.5.1. | `pnpm typecheck` in the spike. |
| U10 | LangGraph stores the pending `Send` payloads in the checkpoint. The size claim in 3.3 depends on it. | Read a checkpoint row in the spike. |
| U11 | A node `errorHandler` runs for a node with no retry policy and can route to `save` with `Command({ goto })`. The docs describe it after the last retry (LangGraph 1.4.0 and later). | A spike with a node that throws. |

---

## 4. Node specifications

**Path key.** `S` = `apps/server/src`. `E` = `apps/electron/src`. `V` = `packages/validations/src`. `M` = `S/lib/meetings`. `W` = `S/lib/meetings/workflow` (3.1). **Planned files.** Every file under `W` is new, and so are `M/input-hash.ts` and the names marked "new" or "planned". They do not exist at c47cd80d. A citation of such a file names the work package (WP) that adds it. It is not a claim about today's code. A citation with a line number points to c47cd80d. Section 3 wires the nodes, section 5 is the gateway, sections 7 and 8 hold tables and inspector, section 10.6 holds the node tests, section 2 holds the current behavior, section 1.4 holds the glossary (node, chunk, call, finish reason). Terms of this section: unit = input of one LLM call (a chunk, the candidate set or a map chunk); label = diarizer label text, "2" for "Them 2" (`M/merge.ts:21-30`); proposal = one entry that the model returns for one label; verdict = the code decision on a proposal, `kept` or `dropped`; suggestion = a kept proposal that `save` writes.

### 4.0 Rules for all nodes

#### 4.0.1 The six nodes

| # | Node | Kind | Task id | Reasoning | Unit |
|---|---|---|---|---|---|
| 1 | `prepare` | code | none | none | the meeting |
| 2 | `correctChunk` | LLM, per chunk | `meetingEnhance` | off | one chunk of whole segments |
| 3 | `identifySpeakers` | LLM, one call | `meetingEnhance` | profile-driven, at most 2048 tokens | the candidate set |
| 4 | `verifyEvidence` | code | none | none | all proposals |
| 5 | `summarize` | LLM, single or map then reduce | `meetingSummarize` | off | the transcript, or one map chunk |
| 6 | `save` | code | none | none | the run |

The two task ids exist (`V/llm-task-profiles.ts:9-16`, `S/lib/llm/task-profiles.ts:81-127`, `M/llm-call.ts:36`). The workflow keeps them (N9). LLM nodes write no domain data. Only `save` writes meeting data.

#### 4.0.2 Who does what: gateway or node

The gateway checks every finish reason and marks which errors are retryable. `callUnit` is the one retry layer (D5, 5.6, Table 1 in 1.1). The gateway must check the finish reason, because AI SDK v7 returns valid JSON with finish reason `length` with no error (5.3.1): `json()` throws only on invalid JSON (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/generate-text/output.ts#L665-L687).

| Result from the gateway | Node |
|---|---|
| Valid object | Checks it in code (4.2 to 4.5). |
| `LengthError` | Runs the length route (4.0.6). |
| `ReasoningLeakError` (L1) | `identifySpeakers`: step 1 of the length route. Others: fail the unit. |
| Typed error with `retry` not null (5.2) | `callUnit` waits and calls once more (5.6). The second failure is final. |
| Any other typed error, or a final one | Fails the unit. |

- A node adds no retry code. The length route changes the input and starts a new unit inside the node (3.2 edge rule 6). It is not a retry, and each of its calls goes through `callUnit` (5.6 rule 4). `extractJsonObject` goes away (`M/enhance.ts:232-246`).
- `guardNode(node, fn)` wraps every node body. It turns any other throw (a bug, a database fault) into one `NodeFailure` of kind `internal`, closes the step row and returns the failed result of that node: a `CorrectChunkResult` with one failed unit; an `IdentifySpeakersResult`, a `VerifyResult` or a `SummarizeResult` with status `failed`; for `save`, the `SaveResult` that `save` filled so far, with the failure added to `failures` (4.6). So the fault shows in the final state, and `deriveRunStatus` sees it (3.4.3). The graph then goes to `save`. A fault of `prepare` is the exception: it ends the run, because no data exists to save (3.4.6). A model-setup fault of `resolveModels` in `prepare` becomes `model_unavailable` (5.2.1): no model chosen, an unsupported provider, no API key, or a removed server. A failed models.dev read is not such a fault. It never gives `model_unavailable` (5.1).
- "Fails the unit" = unit status `failed` and one `NodeFailure` (4.0.7). Other units continue, unless the failure is run-wide (3.4.5).

#### 4.0.3 Schema rules (strict mode)

1. Every field is required; `.nullable()` marks an absent value (https://developers.openai.com/api/docs/guides/structured-outputs).
2. No `.optional()`, `.default()`, `.passthrough()`, `z.record()` or dynamic key. Use an array of objects.
3. Ids, labels, quotes: `z.string()`. No `z.enum()` of ids: each new schema grows the oMLX grammar cache about 0.45 GB (L5; https://github.com/jundot/omlx/issues/4321). A static enum of fixed words is allowed (`"name" | "role"`).
4. No `.min()`, `.max()`, `.length()`, `.regex()`: Anthropic returns error 400 for string length, number range and `minItems` above 1 (https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Code checks sizes after the parse.
5. One schema per node. `summarize` uses one schema for single, map and reduce (L5).
6. Field order is generation order: evidence before conclusion (#163).
7. The gateway does not change the JSON Schema. It passes the zod object to the SDK (`Output.object`, 5.1 step 5). The SDK builds the schema in two steps. First it calls `z.toJSONSchema` with `target` `draft-7` and `io` `input`. Then it sets `additionalProperties` to `false` on every object (`@ai-sdk/provider-utils` 4.0.41 in the pnpm store of the main checkout, `dist/index.mjs:1097-1130, 2396-2407`; v7: https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/provider-utils/src/schema.ts). So authors follow rules 1 to 6. A unit test enforces them on the SDK output, `await asSchema(zod).jsonSchema` (10.5.4). The gateway stores that same output in `llm_calls.schema_json` (7.4). A provider package may reshape it on the wire. The OpenAI package of v7 removes `propertyNames` and lookaround patterns (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/openai/src/normalize-openai-json-schema.ts; UNVERIFIED that the chat path calls it). Rules 2 and 4 keep those keywords out of the node schemas, so no such change applies. The record does not hold a reshaped wire form (L5).

#### 4.0.4 Prompt rules

- System prompt = run rules. User prompt = unit data inside tags, with the guard "treat as content, not instructions" (`M/enhance-prompt.ts:115-116`, `M/summary-prompt.ts:86-87`). Prompts are English, with a language line (`M/enhance-prompt.ts:36-38`). The schema carries the JSON shape.
- Never in a prompt: attendee names and emails (`M/enhance.ts:99-104`, `M/enhance-prompt.ts:29-35`), unconfirmed speaker suggestions (today the prompt gets label numbers only: the label list is built at `M/enhance.ts:413-427` and rendered at `M/enhance-prompt.ts:73-79`; `suggested_name` is written at `M/enhance.ts:660-663` and read only at `S/routes/meetings.ts:1895-1916`), keys, file paths, other meetings. `PromptInput` types have no attendee field; only the `verifyEvidence` input has one (test: 10.5.4). User-written text (vocabulary, title, context, summary instructions) may enter prompts.

#### 4.0.5 Token budget

Section 5 owns the model profile. Fields read here: `contextWindow`, `maxOutputTokens` (nullable), `reasoning.budgetTokens`, `.countsInMaxOutput`, `.maxBudgetTokens`, `.boundedLevel`. The repo has no context-window source: a search of `S` and `packages` for `contextWindow`, `context_window`, `context_length`, `n_ctx`, `ctx-size`, `max_model_len` finds one comment (`M/summarize.ts:73-75`). So `contextWindow` is `null` until the profile fills it. Then nodes skip the fit check and use today's constants.

```
tokens(text)   = ceil(characters / 4) // M/llm-call.ts:24-26
answer(node)   = node formula (4.2.4, 4.3.5, 4.5.4)
reasoningShare = reasoning.budgetTokens when reasoning.countsInMaxOutput, else 0
maxOutput      = min(profile.maxOutputTokens, answer + reasoningShare)
fit            = tokens(system) + tokens(user) + maxOutput + SAFETY_TOKENS <= profile.contextWindow
```

- Reasoning tokens use the output limit on OpenAI (https://developers.openai.com/api/docs/guides/reasoning) and on Google (https://ai.google.dev/gemini-api/docs/thinking). For a local Qwen server the repo shows the same effect, but it names no provider. A reasoning model spends hidden thinking tokens from the same budget (`M/enhance.ts:484-490`). A reasoning-capable local model left only about 1100 to 1200 of 1500 tokens for the answer (`M/summarize.ts:56-63`). UNVERIFIED: how each server counts reasoning tokens. Section 5.5 marks Groq and Mistral UNVERIFIED too.
- Anthropic: `countsInMaxOutput` = `false`. This flag is a field of this spec (section 5). It is not an SDK value. The reason is that the AI SDK adds the thinking budget to the limit: `baseArgs.max_tokens = maxTokens + (thinkingBudget ?? 0)` (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/anthropic/src/anthropic-language-model.ts#L951-L952, block "adjust max tokens to account for thinking").
- `resolveTaskCall` then applies the preset floor `max(taskBudget, presetFloor)` (`S/lib/llm/task-profiles.ts:395-405`). The gateway caps at `maxOutputTokens`.
- UNVERIFIED: `ceil(characters / 4)` for Japanese and Chinese.
- Fit fails: `prepare` makes chunks smaller (4.1). A unit that fails at minimum size gets `budget_exceeded`, no call.

Names in the first column are names of this spec. Only `MAX_SUMMARIZE_CALLS` exists in code under its name. Where the second column says "Today", the value comes from the identifier or the inline literal that it names, and the spec name is new. A value marked "new" has no code source. It is a starting value that the section 10 benchmark tunes (D12, N7).

| Constant | Value and source |
|---|---|
| `CHUNK_TOKENS_MAX` | 1200. Today it is `DEFAULT_ENHANCE_CONTEXT_BUDGET_TOKENS` (`M/enhance.ts:69`). |
| `CORRECT_ANSWER_FACTOR`, `CORRECT_ANSWER_FIXED` | 2, 200. Today they are inline literals in `Math.ceil(chunkTokens * 2) + 200 + 150 * speakerLabelsInChunk` (`M/enhance.ts:491-492`). |
| `SAFETY_TOKENS` | 256, new |
| `MIN_SPLIT_TOKENS` | 300 `correctChunk`, 1500 `identifySpeakers`, 2000 summary map chunk, new |
| `IDENTIFY_MAX_INPUT_TOKENS` | 6000, new |
| `IDENTIFY_ANCHOR_LINES` | 8, new, UNVERIFIED (section 10 measures it) |
| `IDENTIFY_PROPOSAL_TOKENS`, `IDENTIFY_FIXED_TOKENS` | 140, 64, new, UNVERIFIED |
| `IDENTIFY_REASONING_MAX` | 2048 (oMLX note, 4.3.4; extends L2) |
| `QUOTE_MAX_CHARS` | 160 (proposal in https://github.com/Maheidem/openstyle/issues/163) |
| `NAME_MAX_CHARS` | 80. Today it is the inline literal in `name.trim().slice(0, 80)` (`M/enhance.ts:570`). `M/speaker-spelling.ts:11` has a private `MAX_NAME_CHARS` of 80 for attendee names. |
| `SUMMARY_ANSWER_TOKENS` | 4096. Today it is `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` (`M/summarize.ts:77`). |
| `MAX_SUMMARIZE_CALLS` | 24 (`M/summarize.ts:108`). The name exists today. |
| `SUMMARY_PARTIAL_TOKENS` | 800, new, UNVERIFIED (4.5.3) |
| `BREAKER_N` | 3, new (3.4.5) |

#### 4.0.6 The length route

A call that ends with `length` is an error (D4). The node changes the input and tries again. A unit moves to the next step only when the call ends with `length` again.

| Step | Name | Action | Applies to |
|---|---|---|---|
| 1 | `lowerReasoning` | Run again with reasoning off. Once. | A call that ran with reasoning on. Only `identifySpeakers`, and only when its plan mode is `bounded` (5.5 rule 4). While `reasoningSteps` is empty, this step never runs. |
| 2 | `split` | Cut the unit in two halves at a member boundary near the middle. Run each half as a new unit with its own budget. | A unit with at least 2 members, when each half has at least `MIN_SPLIT_TOKENS`. |
| 3 | `raise` | Run again with `min(profile.maxOutputTokens, 2 × maxOutput)`. Once. The fit check of 4.0.5 must pass. | A unit that cannot split. Skipped when the value is not larger or the fit check fails. |
| 4 | `fail` | Fail the unit with kind `length`. | A unit that used steps 1 to 3. |

- A member is a segment (`correctChunk`), a candidate line (`identifySpeakers`) or a transcript line (`summarize` map). A half runs steps 2 to 4 on its own: 1200 tokens split to 600, then 300, then stop. Most calls for one original unit: 11 (1, 2 halves, 4 quarters, 4 raises), plus 1 for step 1.
- `LengthError` with `where: "input"` (the request was too long, 5.2.1) skips steps 1 and 3, because more output room or less reasoning cannot fix it. The unit goes to `split`, then `fail`.
- UNVERIFIED: the route needs a model that stops at the limit. One oMLX runaway text ran to `max_tokens` (`/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/omlx-structured-output-peer-finding.md`). A live probe tests it (10.12 LP2, N10).

#### 4.0.7 Typed failure and node status

```ts
export type NodeId = "prepare" | "correctChunk" | "identifySpeakers" | "verifyEvidence" | "summarize" | "save";

// W/types.ts (planned, WP5a; absent at c47cd80d). GatewayErrorKind is the literal union of the 15 kinds that WP2 declares in `LLM/call-record.ts` (5.1, rule B). Import it. This section adds four.
export type FailureKind = GatewayErrorKind | "budget_exceeded" | "empty_input" | "save_failed" | "internal";

export interface NodeFailure { // one per failed unit; stored in 7, shown in 8 (D4)
  node: NodeId;
  unitKey: string | null; // the key grammar below: "chunk:3", "chunk:3/0" (half), "candidates", "single", "map:2", "reduce:1:0"
  kind: FailureKind;
  finishReason: string | null; rawFinishReason: string | null; // unified, raw
  attempt: number | null; // attempt number of the last call of the unit (`CallFacts.attempt`, 5.2). null: the record write failed (7.7)
  llmCallIds: (number | null)[]; // inspector records (section 8). null: the record write failed (7.7)
  message: string; // one line, no prompt text
}

export type NodeStatus = "ok" | "partial" | "failed" | "skipped" | "cancelled";
export type RunStatus = "succeeded" | "partial" | "failed" | "cancelled" | "meeting_deleted"; // node "ok" is stored as "succeeded" (3.4.3)
```

**Unit keys.** The `unitKey` of a call is also its `step_key` in the record (7.4). The grammar is fixed.

| Node | Key | Meaning |
|---|---|---|
| `prepare`, `verifyEvidence`, `save` | `prepare`, `verify`, `save` | One code step. It makes no call. |
| `correctChunk` | `chunk:<i>` | Chunk `i`, counted from 0. |
| `identifySpeakers` | `candidates` | The candidate set. |
| `summarize` | `single` | The one call for a transcript that fits the budget (4.5.3). |
| `summarize` | `map:<i>` | Map chunk `i`, counted from 0. |
| `summarize` | `reduce:<level>:<group>` | One reduce call. `level` counts from 1. `group` counts from 0 inside the level. |
| any LLM unit | `<key>/<n>` | Half `n` (0 or 1) of the unit `<key>` after a `split` (4.0.6). A half can split again: `chunk:3/0/1`. |

1. Reduce level 1 reads the map results. Level `L + 1` reads the results of level `L`. The last level has one group (4.5.3). So two levels give two different keys, for example `reduce:1:0` and `reduce:2:0`. After a resume, `callUnit` reuses a finished call by its key (5.6). Each key finds only its own call. So the level-2 call never gets the answer of a level-1 call.
2. In one run, one key names one input. The state fixes the chunk plan, the candidate set, the two summary settings and the corrections (3.3, 4.1), so a resumed run builds the same input for the same key. One exception exists: a call whose record write failed is sent again after a resume and can give another answer, while a finished call at a higher reduce level keeps the old one. That needs a failed database write (7.7). The run counts it in `lost_records`, and the inspector shows it (8.7).
3. The length steps `lowerReasoning` and `raise` (4.0.6) send the same key again. They are new attempts of the same unit. Only `split` and the replan of item 4 make new keys.
4. A `single` call that ends with `length` goes to a map and reduce plan (4.5.5). That plan uses the keys `map:<i>` and `reduce:<level>:<group>`, as for a long transcript. The step row `single` ends `succeeded` when the node makes a summary, else `failed`.
5. A call belongs to the step of its top key, which is the part before the first `/` (7.4). A half has no step row of its own.
6. The column `seq` of a step row is the start order of the step in the run (7.7 rule 3).

- `message` holds no prompt text. The SDK error keeps the request body, with the prompt `messages` for OpenAI chat (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/provider-utils/src/post-to-api.ts#L160). UNVERIFIED for other providers. Do not copy `requestBodyValues`.
- Unit status: `ok`, `failed`, `cancelled` or `skipped` (never started because the run stopped, 3.4.5). Node status (`NodeStatus`): `ok`, `partial`, `failed`, `skipped` or `cancelled`. `skipped` also means that the input makes the node useless (no labels). Run status: `deriveRunStatus` derives it (3.4.3). `meeting_deleted` marks a row that vanished (4.6.4).
- **Status fold.** One pure function, `foldStatus(list: NodeStatus[]): NodeStatus`, turns a list of statuses into one status. WP5a writes it in `W/types.ts`. A `partial` entry counts as one `ok` and one `failed`. The first matching row wins.

  | # | The list | Result |
  |---|---|---|
  | 1 | holds `failed` or `partial`, and holds `ok` or `partial` | `partial` |
  | 2 | holds `failed` | `failed` |
  | 3 | holds `cancelled` | `cancelled` |
  | 4 | holds `skipped`, or is empty | `skipped` |
  | 5 | all entries are `ok` | `ok` |

  The fold runs twice. First, the unit statuses of one step (the halves of a chunk or of the candidate set) give the status of the step: `CorrectChunkResult.status`, `IdentifySpeakersResult.status` and the step row. Then the chunk statuses give the status of the node `correctChunk`. A `cancelled` or `skipped` unit is not a failure, so it never makes a step `partial` and the notice of 8.9 does not list it. The data of an `ok` half is still saved, because SW1 writes each `ok` unit (4.6.1). Example: one half `ok` and one half `skipped` give a step `skipped` and a saved first half.
- Step status, as the recorder stores it (7.4, 8.4). A step row is one top key with all its halves. Its status is `foldStatus` over the statuses of its units. `ok` is stored as `succeeded`. `partial`, `failed`, `cancelled` and `skipped` are stored as they are. The error kind of a `partial` or `failed` step is the kind of its first failed half, in key order. A `partial` step counts as a failure for the notice (8.9) and for the Failures list (8.7). `running` and `interrupted` are set by the recorder, not by a node (7.7, 7.12). `unknown` is the value of the read route for any other word (7.2 P7).
- Cancel: a node checks the cancel flag (`ctx.isCancelled()`, 3.4.5) before each call and returns kind `cancelled` (the gateway kind of 5.2). It checks `ctx.isStopped()` too and then returns status `skipped`. Finished units stay in the state. The run goes on to `save` (4.6). Today the chunk loop only polls `options.shouldStop?.()` before each chunk call, sets `stoppedEarly` and breaks (`M/enhance.ts:464-470`). It returns no failure kind.

---

### 4.1 Node `prepare`

**Purpose.** Load the meeting once and build every later input. No LLM call. **Inputs.** Meeting id, rows of `meetings`, `meeting_segments`, `meeting_speakers`, vocabulary, settings.

**Outputs.**

```ts
export interface PreparedSegment {
  id: string; // meeting_segments.id, a plain string
  speaker: "Me" | "Them"; startMs: number;
  speakerLabel: string | null; // "2" for "Them 2". null for Me and undiarized Them
  displayLabel: string; // "Me", "Them 2", or a confirmed name
  text: string; // the raw text, never an earlier correction
  enhancedText: string | null; // stored `enhanced_text` when `prepare` ran. Only `summarize` reads it (4.5)
  speakerName: string | null; // confirmed name after merges. Only `summarize` reads it (4.5)
}

export interface PreparedMeeting {
  meetingId: string;
  language: string | null; title: string | null; context: string | null;
  vocabTerms: string[];
  attendeeNames: string[]; // for verifyEvidence only. Never in a prompt.
  segments: PreparedSegment[]; // time order
  chunks: string[][]; // segment ids per chunk. Whole segments. No overlap.
  labels: { all: string[]; confirmed: string[]; toIdentify: string[] }; // confirmed = has display_name; toIdentify = all minus confirmed
  chunkTokens: number; // chunk size used
  // The two settings that `summarize` reads (4.5). `prepare` reads them once, so a setting change while a run is
  // stopped does not change the chunk plan: the resumed run uses these values, and a finished map call keeps its key (4.0.7).
  summary: {
    instructions: string; // parseMeetingSummaryInstructions(readSetting("meeting_summary_instructions")): trimmed, "" when unset or too long (`V/settings.ts:205-211`)
    contextBudget: number; // parseMeetingSummaryContextBudget(readSetting("meeting_summary_context_budget")): 100 to 200000, default 8000 (range and default: `V/settings.ts:185-186, 257-266`; today's reader: `M/summarize.ts:365-369`, which only calls `parseMeetingSummaryContextBudget`)
  };
  inputHash: string; // sha256 hex from `inputHash(loadHashRows(db, meetingId), hashVariantOf(kind))`: P11
}
```

**Rules.**

- P1. Read the transcript with the loader that WP5a moves to `transcript-io.ts` (`S/routes/meetings.ts:253-307`, 3.1).
- P2. Keep a segment only with an id and non-blank text (`M/enhance.ts:387-388`).
- P3. `text` is the raw text, never an earlier correction (`M/enhance.ts:389-396`).
- P4. `displayLabel` = `speakerDisplayLabel(seg, "Them")`. Today the LLM view of Enhance makes this call (`M/enhance.ts:391`). The function is defined at `M/merge.ts:362-371`. Its doc says that display callers pass "Unidentified" and never bare "Them" (`M/merge.ts:358-360`). The Summary path passes "Unidentified" (`M/summarize.ts:315`). So `displayLabel` serves the Enhance LLM view. It is not a label for the screen.
- P5. Chunk with `chunkForEnhance` (`M/enhance.ts:197-217`): whole segments, no overlap, so the id check in `correctChunk` is exact.
- P6. Chunk size = `min(CHUNK_TOKENS_MAX, floor((contextWindow - tokens(system) - SAFETY_TOKENS - CORRECT_ANSWER_FIXED) / (1 + CORRECT_ANSWER_FACTOR)))` (fit check of 4.0.5). `contextWindow` `null`: `CHUNK_TOKENS_MAX`.
- P7. Label sets come from the structured `speakerLabel`, not display text (`M/enhance.ts:407-422`). Confirmed = `display_name` set (`M/speaker-names.ts:37-51`).
- P8. Copy attendee names (no emails) from the calendar link (`S/routes/meetings.ts:1263-1269`).
- P9. Resolve model and profile for each LLM node once, into the state. A resume reuses them (N5). A model-setup fault here is `model_unavailable` (5.2.1). A failed models.dev read is not a fault: the profile falls back to the hand table and a warning (5.1), so a Mac with no network still runs a local `server` Enhance.
- P10. No segment left: fail the run with `empty_input` before any call. The route answers 409 (`S/routes/meetings.ts:2114-2117`).
- P11. Compute `inputHash` with the one function of `M/input-hash.ts`. The file is planned: WP2 adds it (11.4), and it is absent at c47cd80d. No `inputHash` symbol exists in `apps` or `packages` today. The resume guard (3.4.7) and the inspector reader (7.8) call the same function. Both must get the same bytes from the same database. So the function hashes database rows, not the merged transcript:

```ts
// M/input-hash.ts (planned, WP2; absent at c47cd80d). Planned to be the only code that hashes a transcript.
// Today no code hashes transcript text. In `S` and `E`, `createHash` appears only for a worker script version, downloaded archives and models,
// and update files (`S/lib/mlx-asr/runtime.ts:174, 653`; `S/lib/whisper/models.ts:245`; `E/main/self-updater-core.ts:161, 398`).
import { createHash } from "node:crypto";
export interface HashRow {
  id: string;                  // meeting_segments.id. Never empty (P2)
  text: string;                // the `text` column: raw, never a correction. Never blank (P2)
  speakerLabel: string | null; // the effective label: null for a "mic" row and for an undiarized row
  enhancedText: string | null; // the `enhanced_text` column. "" counts as null
  speakerName: string | null;  // the confirmed `display_name` of the effective label, else null
}
export type HashVariant = "enhance" | "summarize";
export function hashVariantOf(kind: LlmRunKind): HashVariant { return kind === "summarize" ? "summarize" : "enhance"; } // 3.4.3: kind is "summarize" only when stages is ["summarize"]
export function loadHashRows(db: DatabaseSync, meetingId: string): HashRow[]; // rules below
export function inputHash(rows: readonly HashRow[], variant: HashVariant): string {
  const tuples = rows.map((r) =>
    variant === "enhance"
      ? [r.id, r.text, r.speakerLabel]
      : [r.id, r.text, r.speakerLabel, r.enhancedText, r.speakerName]);
  return createHash("sha256").update(JSON.stringify([variant, tuples]), "utf8").digest("hex");
}
```

  - `loadHashRows` reads `meeting_segments` with `status = 'ok'`, in the order of the loader: `ORDER BY idx, start_ms, id` (`S/routes/meetings.ts:259-260`). It applies P2: it drops a row whose `id` is empty or whose `text` is blank after `trim()` (`M/enhance.ts:387-388`).
  - The effective label follows `resolveSpeakerNames` (`M/speaker-names.ts:37-51`). Only a row with `source = 'system'` and a stored label has a label. If the `meeting_speakers` row of that label has `merged_into`, the label is that value (one hop). The confirmed name is the `display_name` of the row of the effective label. A "mic" row has `null` for both fields.
  - The serialization is `JSON.stringify` of nested arrays, so it has no key order and no separator problem. The digest is lower-case hex. There is no Unicode normalization: the bytes are the bytes stored.
  - `prepare` calls `loadHashRows` and `inputHash` in the same synchronous block as the loader of P1, so both see one database state. It uses `hashVariantOf` with the kind of 3.4.2 step 1. It passes the result to `ctx.setInputHash` (3.4).
  - The variant `enhance` covers the segment ids, the raw text and the effective labels. The variant `summarize` adds the two fields that the summary prints (4.5). 3.4.7 guard 6 explains the effect.
  - Why not hash the merged transcript: the merge runs the drift fix (`applyDrift`, `M/merge.ts:305`), the vocabulary leak filter (`M/merge.ts:315`) and the echo removal (`M/merge.ts:322-329`; pipeline doc at `M/merge.ts:294-297`). They need `sync.json` and the current vocabulary. The loader reads those at `S/routes/meetings.ts:274, 283` and calls `mergeTranscript` at `S/routes/meetings.ts:279-284`. The reader would need the audio folder. Those inputs change no segment id and no text. The run keeps its own merged copy in `prepared`. So the hash of the rows is enough for the resume guard and for the label check of 7.8.

---

### 4.2 Node `correctChunk`

**Purpose.** Fix clear speech-to-text errors in one chunk. Nothing else (why: #163, section 1). **Inputs.** `CorrectChunkInput`: a slice of `PreparedMeeting` for one chunk (3.3, X1). The router of 3.2 edge rule 1 builds one for each chunk of `prepared.chunks`.

```ts
// W/types.ts (planned, WP5a; absent at c47cd80d). The payload of one Send. A Send branch gets only this object, not the graph state (3.3).
export interface CorrectChunkInput {
  runId: string; meetingId: string;
  chunkIndex: number;            // index in prepared.chunks, from 0. The unit key is `chunk:<chunkIndex>` (4.0.7)
  segments: PreparedSegment[];   // the whole segments of this chunk, in time order. Their ids are prepared.chunks[chunkIndex]
  language: string | null;       // prepared.language
  vocabTerms: string[];          // prepared.vocabTerms
  profile: CallProfile;          // models.correctChunk (5.1)
}
```

**Outputs.**

```ts
export interface CorrectUnitResult { // one LLM unit: the chunk, or a half after a split (4.0.6)
  unitKey: string; // "chunk:3", "chunk:3/0"
  segmentIds: string[]; // the segments this unit covered
  status: "ok" | "failed" | "cancelled" | "skipped";
  // seq = the index of the entry in the `corrections` array of the model output of the call `callId` (before any drop).
  // A dropped entry keeps its own index. So `seq` is unique inside one call, and an applied entry and a dropped entry never share a link key (4.6.1, 4.6.2).
  corrections: { id: string; text: string; seq: number; callId: number | null }[]; // after the code checks
  dropped: { id: string; reason: CorrectionDropReason; seq: number; callId: number | null }[];
  failure: NodeFailure | null;
}
export interface CorrectChunkResult {
  chunkIndex: number;
  status: NodeStatus; // foldStatus over the statuses of `units` (4.0.7): ok, partial, failed, cancelled or skipped
  units: CorrectUnitResult[]; // one unit when no split ran
}
// CorrectionDropReason = "unknown_id" | "duplicate_id" | "empty_text" | "unchanged".
// Planned: WP2 declares it in V/meeting-types.ts (5.1, rule B). That file exists and holds types only (`V/meeting-types.ts:3-5`).
// The type is absent at c47cd80d. W/types.ts (planned, WP5a) imports it and declares nothing again.
```

#### 4.2.1 Schema

```ts
export const CorrectChunkSchema = z.object({
  corrections: z.array(z.object({ id: z.string(), text: z.string() })),
});
export type CorrectChunk = z.infer<typeof CorrectChunkSchema>;
```

An empty array means "nothing to correct". It replaces the `{}` answer (`M/enhance-prompt.ts:26`). The old answer, a record keyed by segment id (`M/enhance-prompt.ts:16-18`), breaks rule 2 of 4.0.3.

#### 4.2.2 Prompt

The builders live in `W/prompts.ts` (planned, WP5a, 3.1; absent at c47cd80d). Today's builders are `buildEnhanceSystemPrompt` (`M/enhance-prompt.ts:29`) and `buildEnhanceUserPrompt` (`M/enhance-prompt.ts:128`). The text below comes from today's prompt, with the changes that the schema needs. `W/prompts.ts` copies what it keeps. It does not import `enhance-prompt.ts`, and the old file stays unchanged until WP11, so the old path is not affected. The old text differs in two places: it asks for JSON text and for a speaker block (`M/enhance-prompt.ts:16-26, 43-48, 129`), which the schema and the split of D1 replace.

System prompt, in order: (1) role: "Me" is the app user, and "Them N" or a confirmed name marks another speaker. Today's line says "Me" is the app user and "Them" is the other participant, in the singular (`M/enhance-prompt.ts:48`). Today the label list "Them N" appears only in the speaker block, and only when diarization labels exist (`M/enhance-prompt.ts:79, 93`). So the "Them N" sentence is new text for this prompt. The transcript lines already carry it (`M/enhance.ts:391`); (2) language line; (3) vocabulary terms fix a clear mis-transcription and never add a term (`M/enhance-prompt.ts:39-42`); (4) rules (`M/enhance-prompt.ts:21-26`): include a segment only if you change it; do not invent, merge, split, reorder, paraphrase or translate; fix clear recognizer errors; if nothing needs a correction, return an empty list. Today's empty-list rule is line 26 and says to return `{}`. The new prompt (planned) has no speaker block. Today's block is inserted at `M/enhance-prompt.ts:43-48` and defined at `M/enhance-prompt.ts:73-113`. The new prompt also has no JSON text. Today's JSON contract is `M/enhance-prompt.ts:16-18`, and the schema of 4.2.1 replaces it. These two points describe text that is not written yet, so no repo check is possible.

User prompt: guard sentence and the chunk inside `<transcript>` tags, one line `[id] Speaker: text` each (`M/enhance-prompt.ts:119-130`). No title or user context (N4).

#### 4.2.3 Code checks after the parse

For each correction, in order:

1. `id` not in the chunk: drop, `unknown_id` (`M/enhance.ts:528-531`).
2. `id` seen earlier in the array: drop, `duplicate_id`. The first entry wins.
3. Trim the text. Remove an echoed "Speaker: " prefix (`M/enhance.ts:532-543`).
4. Text empty: drop, `empty_text` (`M/enhance.ts:544`).
5. Text equals the original: drop, `unchanged` (`M/enhance.ts:551`).

The unit result lists every drop with its call id. `save` stores each drop as a link with outcome `dropped` (4.6.1), and the Call view shows them (8.7).

#### 4.2.4 Token budget

```
chunkTokens = sum over lines of (tokens("[id] Speaker: text") + 1)    // +1 for each line: M/enhance.ts:185-187 (lineTokensOf); sum: M/enhance.ts:472
answer      = ceil(chunkTokens × CORRECT_ANSWER_FACTOR) + CORRECT_ANSWER_FIXED
maxOutput   = min(profile.maxOutputTokens, answer)                    // reasoningShare = 0
```

Today's formula is `Math.ceil(chunkTokens * 2) + 200 + 150 * speakerLabelsInChunk` (`M/enhance.ts:491-492`). The speaker term `150 × labels` leaves in the new formula, because `correctChunk` no longer asks for speakers. This is a planned change, so the repo cannot check it. Factor 2 stays: 1.3 was too small in a run on 2026-10-06 (`M/enhance.ts:484-490`). Section 10 may lower it.

#### 4.2.5 Reasoning

Off, sent explicitly (L2), recorded in the param ledger. `meetingEnhance` is off today too (`S/lib/llm/task-profiles.ts:111-115`), and a local server gets `chat_template_kwargs.enable_thinking = false` (`S/lib/llm/task-profiles.ts:356-369`). A user preset can set `enable_thinking: true` and wins, as today. The node then uses the effective setting for `reasoningShare`, and the gateway adds a warning to the call record (N5).

#### 4.2.6 Failure handling

- `length`: route `split`, `raise`, `fail` (step 1 does not apply; for `where: "input"` only `split`, then `fail`). Other failure: the unit fails and its segments keep their old text, other units continue (unless the failure is run-wide, 3.4.5), `content_filter` is not retried. If one half of a split chunk fails, the chunk is `partial`: `save` writes the good half and leaves the failed half (4.6.1).
- Chunks run as a fan-out (3.2, 3.5). The lane allows 1 parallel call local, 2 cloud (`S/lib/llm/lane.ts:106-107`).
- All chunks fail: status `failed`. Section 3 sets the answer (3.4.2; today 502: `S/routes/meetings.ts:2142-2173`).

Live proof (L6): a call on the owner's oMLX with Qwen3.8-27B. The body read back from the trace log holds the schema and `enable_thinking: false`.

---

### 4.3 Node `identifySpeakers`

**Purpose.** Propose a name or role for each label that no user confirmed. Each proposal carries one transcript quote. No text correction. **Inputs.** `PreparedMeeting`.

**Skip rule.** `labels.toIdentify` empty: status `skipped`, reason `no_labels` (no diarization label at all) or `all_confirmed` (every label has a confirmed name). Today only the `no_labels` case exists. An empty label list gives an empty speaker block (`M/enhance-prompt.ts:78`) and skips the parse of `speakers` (`M/enhance.ts:560`). `speakerLabels` (`M/enhance.ts:413-422`) has no confirmation check, so a meeting with all labels confirmed does not skip today. The `all_confirmed` skip is new.

**Outputs.**

```ts
export interface IdentifySpeakersResult {
  status: NodeStatus; // foldStatus over the statuses of its units (4.0.7). partial: some halves failed (4.3.6)
  proposals: SpeakerProposal[]; // from the units that succeeded
  shown: { unitKey: string; callId: number | null; segmentIds: string[] }[]; // the lines each call showed (4.4.2 check 2)
  candidates: CandidateStats;
  failures: NodeFailure[]; // one for each failed unit
}
export interface SpeakerProposal {
  unitKey: string; llmCallId: number | null;
  seq: number; // index of the entry in the `speakers` array of the model output of the call `llmCallId`. Two entries for one label in one call have two values (4.6.2)
  segmentId: string; quote: string; label: string;
  kind: "name" | "role"; name: string;
}
export interface CandidateStats {
  poolLines: number; selectedLines: number; anchorLines: number;
  cueLines: number; nameTokenLines: number; droppedByBudget: number;
}
```

#### 4.3.1 Schema

```ts
export const IdentifySpeakersSchema = z.object({
  speakers: z.array(
    z.object({
      segmentId: z.string(), // the line that holds the evidence
      quote: z.string(), // one verbatim quote from that line
      label: z.string(), // "2" for "Them 2"
      kind: z.enum(["name", "role"]),
      name: z.string(), // the name, or the role descriptor
    }),
  ),
});
export type IdentifySpeakers = z.infer<typeof IdentifySpeakersSchema>;
```

- `segmentId` and `quote` come first (rule 6 of 4.0.3). No free-text comment field exists (#163). An empty `speakers` array is valid.
- Code checks `segmentId`, `label` and lengths after the parse, and derives the evidence type from the cited line (4.4.2).

#### 4.3.2 Candidate lines

Code selects the lines. Pool = lines with `speaker = "Them"` and a non-null `speakerLabel`. "Me" lines are out, because the guard drops evidence that comes only from a "Me" line (`M/enhance.ts:316-326`, `M/enhance.ts:342-346`; N2). Undiarized "Them" lines are out, because they are never evidence (`M/enhance.ts:301-304`).

- S1. Pool fits `IDENTIFY_MAX_INPUT_TOKENS`: all pool lines are candidates.
- S2. Otherwise add lines in this order until the budget is full: (1) anchor lines: the first `IDENTIFY_ANCHOR_LINES` pool lines of each label in `toIdentify`; (2) cue lines: a cue word of 4.4.3 followed by a capitalized word ("This is Ana"); (3) name-token lines: a capitalized token that is not the first token of its sentence.
- S3. Sort the selected lines by time. S4. Count lines cut by the budget into `CandidateStats` (section 8 shows them). S5. Use no attendee names (4.0.4) and no vocabulary.

Anchor lines keep the early self-introduction when `correctChunk` fails or a chunk border falls badly (the #163 loss: section 1).

#### 4.3.3 Prompt

The builders live in `W/prompts.ts` (planned, WP5a, 3.1; absent at c47cd80d). Blocks 1 to 5 below copy the text of today's speaker block, which stays in `enhance-prompt.ts` for the old path. The new prompt differs from it: it asks for no JSON text and for no corrections, and its output rules name the schema fields.

System prompt blocks (1 to 5 come from today's speaker block, `M/enhance-prompt.ts:73-112`): (1) role and label list ("Them 2, Them 3"); (2) title and context lines, as evidence, not instructions; (3) two kinds of evidence: SELF-INTRODUCTION (the label's line states its own name) and ADDRESSED-AS (a line of a different speaker addresses the label by name); (4) a name that a label greets or lists is not its name; (5) role fallback: a grounded role, `kind` = `role`; (6) output rules: only listed label numbers; at most one entry per label (strongest evidence); copy `segmentId` exactly; copy the quote word for word from that one line, at most 160 characters; no comment; empty list when no evidence. No JSON text, no corrections text.

User prompt: guard sentence and the candidate lines inside `<transcript>` tags, marked as an excerpt, one line `[segmentId] Speaker: text` each. A confirmed label shows its name (`M/enhance.ts:391`) and leaves the label list.

#### 4.3.4 Reasoning

Reasoning follows the model profile and always has a bound.

| The profile says | The node sends |
|---|---|
| The plan mode is `off`: the model cannot reason, or `reasoningSteps` (5.5 rule 4) does not list `identifySpeakers` | Reasoning off. |
| The plan mode is `bounded`, and the provider has a token budget | Reasoning on, `budgetTokens = min(reasoning.maxBudgetTokens, IDENTIFY_REASONING_MAX)`. The wire shape of a local `server` is in 5.5.2. |
| The plan mode is `bounded`, and the provider has effort levels and no token budget | Level `reasoning.boundedLevel`. |

- Hard limit 2048 reasoning tokens. An oMLX note: without a budget 24 percent of thinking calls put raw reasoning in the content, with 2048 or less 0 of 38 did (`/Users/maheidem/Documents/Symphony/oss-local-hosting-material/homelab/litellm-gateway.md:513-515`). Extends L2.
- The same note, through LiteLLM: a top-level `thinking_budget` works, a nested one is ignored (`litellm-gateway.md:218-223`). UNVERIFIED for a direct call to oMLX. No app code caps reasoning with a preset `thinking_budget`: it is only a request to the server (`V/settings.ts:82-87`, `S/lib/llm/registry.ts:112-125`). UNVERIFIED whether the server applies it.
- A local Qwen server gets `chat_template_kwargs` as today (D3). UNVERIFIED whether oMLX applies a strict schema to the reasoning part (N10): section 10 tests it live.
- A `ReasoningLeakError` starts step 1 of the length route.

#### 4.3.5 Token budget

```
labels         = labels.toIdentify.length
answer         = IDENTIFY_PROPOSAL_TOKENS × labels + IDENTIFY_FIXED_TOKENS
reasoningShare = reasoning.budgetTokens when reasoning.countsInMaxOutput, else 0
maxOutput      = min(profile.maxOutputTokens, answer + reasoningShare)
inputTokens    = tokens(system) + tokens(candidate lines)
```

One proposal needs about 140 tokens (id about 20, quote about 40, rest name, label, keys). UNVERIFIED. Candidate lines: at most `min(IDENTIFY_MAX_INPUT_TOKENS, profile.contextWindow - tokens(system) - maxOutput - SAFETY_TOKENS)`. `contextWindow` `null`: only `IDENTIFY_MAX_INPUT_TOKENS`.

#### 4.3.6 Failure handling

The full route of 4.0.6 applies. `split` cuts the candidate lines by time in two halves, each a call. The proposals join and 4.4.5 removes duplicates. The smallest half is `MIN_SPLIT_TOKENS` = 1500. A failed `identifySpeakers` leaves the corrections intact. Status is `failed`, or `partial` when one half succeeds: the node keeps the proposals of the good half. The UI shows the typed failure for this step.

---

### 4.4 Node `verifyEvidence`

**Purpose.** Code only. Check every proposal against the real transcript, pick one winner per label, fix the spelling of a winning name, store a verdict and reason for each proposal. **Inputs.** `PreparedMeeting` (with `attendeeNames`), the proposals, `shown` (the segment ids each call showed, 4.3).

**Outputs.**

```ts
// V/meeting-types.ts (planned, WP2; the file exists, the four types are absent at c47cd80d). The only declaration of these four types (5.1, rule B). W/types.ts imports them.
export type VerdictStatus = "kept" | "dropped";

export type DropReason =
  | "unknown_label" | "unknown_segment" | "no_quote" | "quote_too_long"
  | "quote_not_in_segment" | "empty_name" | "name_not_in_quote"
  | "not_self_introduction" | "conflict_lost" | "duplicate_same_name";

export type EvidenceType = "self_introduction" | "addressed_as" | "role_detail";

export interface SpeakerVerdict {
  unitKey: string; llmCallId: number | null;
  seq: number; // copied from the proposal (4.3): the index in the `speakers` array of that call. One verdict for each proposal, so (llmCallId, seq) is unique
  label: string;
  proposedKind: "name" | "role"; proposedName: string;
  segmentId: string; quote: string;
  evidenceType: EvidenceType | null; // set by code. null when dropped before the derivation
  status: VerdictStatus;
  reason: DropReason | null;
  detail: string | null; // one line, at most 200 characters
  finalName: string | null; // after the spelling fix. null when dropped
  respelledFrom: string | null; // name before the spelling fix
  winnerCallId: number | null; // conflict_lost: the call of the winner
}

// W/types.ts (planned, WP5a; absent at c47cd80d). The two types below.
export interface SpeakerSuggestion {
  label: string; kind: "name" | "role";
  name: string; // finalName
  evidence: string; // the quote
  evidenceType: EvidenceType; segmentId: string;
}

export interface VerifyResult {
  status: NodeStatus; // `ok`; `skipped` when `identifySpeakers` was skipped or failed (4.4.6); `failed` only when `guardNode` caught an `internal` fault (4.0.2)
  failure: NodeFailure | null; // set with status `failed`
  verdicts: SpeakerVerdict[];
  suggestions: SpeakerSuggestion[]; // at most one winner per label
}
```

Section 7 stores this exact `SpeakerVerdict` as `verdict_json`, and section 8 shows it (D10). Its codes are the only code list (11.4).

#### 4.4.1 Normalization

All comparisons use one normalizer: the current one (`M/enhance.ts:263-265`) plus NFKC, curly apostrophes and curly quotes. Names and cues match only at a Unicode letter boundary.

```ts
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC")
    .replace(/[\u2018\u2019\u02BC]/g, "'") // curly apostrophes
    .replace(/[\u201C\u201D]/g, '"') // curly quotes
    .toLowerCase().replace(/\s+/g, " ").trim();
}

const B = "(?<![\\p{L}\\p{N}])"; // not after a letter or digit
const E = "(?![\\p{L}\\p{N}])"; // not before a letter or digit

export function containsWord(textNorm: string, wordNorm: string): boolean {
  return new RegExp(`${B}${escapeRegExp(wordNorm)}${E}`, "u").test(textNorm);
}
```

Check of 2026-10-17, Node 26.5.0: the current functions (`M/enhance.ts:263-265`, `M/enhance.ts:273-280`) against the code of 4.4.1 and 4.4.3 (not in the repo at c47cd80d, so no file:line; `escapeRegExp` is the expression of `M/enhance.ts:275`), types removed:

| Input | Current code | Code of this section (= expected) |
|---|---|---|
| "Hi, this is Ana", name "Ana" | `true` | `true` |
| "Hi, this is José", name "José" | `false` | `true` |
| "Hi, I’m Ana" (curly apostrophe), name "Ana" | `false` | `true` |
| text "banana", name "ana" (name-in-quote check; current code uses `includes`, `M/enhance.ts:338`) | `true` | `false` |

Cause: `\b` without the `u` flag treats only A to Z, digits and underscore as word characters (`M/enhance.ts:277`; https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Word_boundary_assertion). UNVERIFIED: whether the owner's ASR emits curly apostrophes.

#### 4.4.2 Per-proposal checks

Run in order. The first failure decides the verdict. Every proposal gets exactly one verdict.

| # | Check | Drop reason | From |
|---|---|---|---|
| 1 | `label` is in `labels.toIdentify` (a confirmed label fails). | `unknown_label` | `M/enhance.ts:566`. Today the test accepts any label of `speakerLabels`, a confirmed label included (`M/enhance.ts:413-422`). The failure for a confirmed label is new. |
| 2 | `segmentId` is in `shown` for the `unitKey` of the proposal (a "Me" id fails: never shown; after a split each half shows its own lines). | `unknown_segment` | New |
| 3 | The normalized quote is not empty. | `no_quote` | `M/enhance.ts:336` |
| 4 | The quote has at most `QUOTE_MAX_CHARS` characters. | `quote_too_long` | New (#163) |
| 5 | The normalized quote is a substring of the normalized text of the cited segment. | `quote_not_in_segment` | Replaces the search over all lines of the chunk (`M/enhance.ts:293-306`; the loop is at `M/enhance.ts:300-304`). Today a quote with no matching segment gets a drop text at `M/enhance.ts:345`. |
| 6 | The trimmed name is not empty. Code cuts it to `NAME_MAX_CHARS` (80 characters). | `empty_name` | `M/enhance.ts:569` skips an empty name and gives no reason code. `M/enhance.ts:570` cuts the name with the literal `slice(0, 80)`. The names `empty_name` and `NAME_MAX_CHARS` are new. |
| 7 | `kind = "name"`: the name is in the quote at a letter boundary. | `name_not_in_quote` | `M/enhance.ts:338-340` |
| 8 | `kind = "name"` and the cited line has the same label: the quote reads as a self-introduction (4.4.3). | `not_self_introduction` | `M/enhance.ts:350-355` |

After check 5, code sets the evidence type from the cited segment, not from the model: `kind = "role"` gives `role_detail` (`M/enhance.ts:347`); `kind = "name"` on a line of a different label gives `addressed_as` and passes (`M/enhance.ts:348-349`); `kind = "name"` on a line of the same label gives `self_introduction` and check 8 must pass. Code cannot check that an ADDRESSED-AS name refers to the label. The prompt asks the model to judge (N2).

#### 4.4.3 Self-introduction patterns

English patterns carry over (`M/enhance.ts:273-280`). Boundaries change to the Unicode form of 4.4.1.

```ts
// Cues, English. Lowercase. The name is already normalized.
const SELF_INTRO_CUES_EN = "this is|i'?m|i am|it'?s|it is|my name'?s|my name is";

export function looksSelfIdentifying(quoteNorm: string, nameNorm: string): boolean {
  if (!nameNorm) return false;
  const n = escapeRegExp(nameNorm);
  return new RegExp(
    `${B}(${SELF_INTRO_CUES_EN})\\s+${n}${E}|${B}${n}\\s+(here|speaking)${E}`, "u",
  ).test(quoteNorm);
}
```

Cues are English only. For another language check 8 can never pass, so only ADDRESSED-AS can keep a name (N3). Rule S2.2 uses the same cues.

#### 4.4.4 Spelling fix

Runs after the per-proposal checks and before the conflict policy (N8). A passed `kind = "name"` proposal goes through `fixNameSpelling(name, attendeeNames)` (`M/speaker-spelling.ts:55-86`). It changes a name only when exactly one attendee matches at the best level (`M/speaker-spelling.ts:82-85`). A match needs an equal first name, or a first name that is one letter off (first names of 4 letters or more only), and an equal rest of the name when the suggestion has one (`M/speaker-spelling.ts:46-54`, `M/speaker-spelling.ts:73-83`). An exact match beats a one-letter match (`M/speaker-spelling.ts:84`). So one exact and one near attendee still change the name. Run check of 2026-10-17 on a copy of the file: "Marcus" with the attendees "Marcus Silva" and "Markus Lee" returns "Marcus Silva"; "Marcus" with "Marcos Silva" and "Markus Lee" (two near matches) returns "Marcus". The function never changes evidence or kind (`M/speaker-spelling.ts:6-7`). Its signature takes a name and the attendee names and returns only a string (`M/speaker-spelling.ts:55-58`). The old name goes to `respelledFrom`, the new name to `finalName`. The quote keeps the transcript spelling.

#### 4.4.5 Conflict policy

Several proposals can survive for one label. Code picks one winner with no model score. The lowest rank tuple wins: (1) `name` before `role`; (2) `self_introduction`, then `addressed_as`, then `role_detail`; (3) `startMs` of the cited segment, smallest first; (4) `segmentId`, string order.

- A loser with the winner's name (case-insensitive): `dropped`, `duplicate_same_name`.
- A loser with a different name: `dropped`, `conflict_lost`. `detail` names the winner.
- The winner: `kept`.

Evidence ranks first because only ADDRESSED-AS needs a model judgment of who the name refers to. Time is the tie-break. (Today the earlier chunk wins: `M/enhance.ts:609-616`.)

#### 4.4.6 Result

`suggestions` holds the `kept` winners, at most one per label. `verdicts` holds one entry per proposal. `identifySpeakers` skipped or failed: both lists empty, status `skipped`, `failure` null. A fault that `guardNode` catches gives status `failed` and a `failure` of kind `internal`; `save` then writes no suggestion. The node writes nothing to the database. `save` does (4.6).

---

### 4.5 Node `summarize`

**Purpose.** Write a structured summary. Code renders it to Markdown. The Summary tab and `meeting_summaries.markdown` keep their format.

**Inputs.** `PreparedMeeting`, the corrections of this run (if any), the two settings `prepared.summary.instructions` and `prepared.summary.contextBudget` (4.1: `prepare` reads `meeting_summary_instructions` and `meeting_summary_context_budget` once), the meeting context `prepared.context`. The node reads no setting itself. A setting change while the run is stopped changes nothing for the resumed run. Each segment uses the first value that exists: the correction of this run, `PreparedSegment.enhancedText` (the stored value that `prepare` read), the raw text (`M/summarize.ts:298-316`). Each line is `Speaker: text`. The label is `speakerDisplayLabel(seg, "Unidentified")` (`M/merge.ts:362-371`) over `speaker`, `speakerName` and `speakerLabel`: the confirmed name, "Them N" or "Unidentified". It is not `displayLabel`, which falls back to "Them". `prepare` reads nothing again later, so a resumed run summarizes the same text. Speaker suggestions are never used.

**Outputs.**

```ts
export interface SummarizeResult {
  status: NodeStatus; // `ok`, `failed`, `cancelled` or `skipped`. Never `partial`: a summary that omits content must not look complete (4.5.3)
  summary: MeetingSummary | null;
  markdown: string; // rendered by code
  llmProvider: string | null; llmModel: string | null; // rules 2 and 3 below
  inputTokens: number; outputTokens: number; // sums over all calls (rule 1 below)
  costUsd: number | null; callCount: number; // rule 4 below
  failure: NodeFailure | null;
  llmCallIds: (number | null)[];
}
```

Token and cost fields keep their `meeting_summaries` meaning (`M/summarize.ts:433-442`, `M/summarize.ts:512-515`). Today `resolveDefaultChatCall` reads the price with `getModelCostCached` (`M/llm-call.ts:165-167`), and `summarizeMeeting` multiplies it by the tokens. The new design has no call that returns a price: `CallStructuredResult` and `llm_calls` hold none (5.1, 7.4). WP11 deletes the old reader. So the node fills these fields itself:

1. `inputTokens` and `outputTokens` are the sums over all calls of the run, reused calls included (5.6). A call with unknown usage adds 0, as today (`M/llm-call.ts:45`).
2. `llmProvider` is `profile.provider` of the `summarize` entry in `models` (3.3).
3. `llmModel` is the `modelServed` of the last call of the run. If that value is null, it is `modelRequested`. The last call is the last one in call order, a reused call included.
4. Cost. At the start of the node run, the node does two steps inside one `try`/`catch`. (a) If the provider is not `server`, it awaits `fetchModelsFromRegistry()`. That call returns at once while the 6 hour cache is fresh (the 6 hour TTL is at `S/lib/model-registry.ts:50`, the early return at `:60-62`). Otherwise it waits at most 3 s (`S/lib/model-registry.ts:11`, `:64-66`), and it throws when the read fails (`:67-69`). This also warms the cache after a resume in a new process, because `prepare` does not run again. (b) It calls `getModelCostCached(profile.provider, profile.modelId)` once (`S/lib/model-registry.ts:118-132`). That function reads the cache only. It returns null when the cache is cold or expired (`S/lib/model-registry.ts:122`), and also when the registry has no price for the model (`S/lib/model-registry.ts:100, 104`). Otherwise it returns prices per token: the registry holds prices per million tokens, and the lookup divides them by 1,000,000 (`S/lib/model-registry.ts:106-109`). If the price is not null, then `costUsd = inputTokens × price.input + outputTokens × price.output`. Otherwise `costUsd` is NULL. A throw also gives NULL and adds no failure. A `server` model has no price, so its cost stays NULL, as today.
5. SW3 writes the five values to the columns of `meeting_summaries` with no change (4.6.1).

#### 4.5.1 Schema

```ts
export const MeetingSummarySchema = z.object({
  overview: z.string(),
  keyPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      task: z.string(),
      owner: z.string().nullable(), // null when the transcript names no owner
      due: z.string().nullable(), // time as spoken, e.g. "next Friday". null when none
    }),
  ),
  openQuestions: z.array(z.string()),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;
```

One schema serves the single, map and reduce calls. A partial summary has the final shape, so a reduce can run on reduce results (4.5.3). `due` is free text: copy the time as spoken, do not compute a date. `keyPoints` stays (N1).

#### 4.5.2 Prompt

The builders live in `W/prompts.ts` (planned, WP6, 3.1; absent at c47cd80d). Today's builders are `buildMeetingSummaryUserPrompt` (`M/summary-prompt.ts:90`), `buildMeetingSummaryMapPrompt` (`M/summary-prompt.ts:95`) and `buildMeetingSummaryReducePrompt` (`M/summary-prompt.ts:104`). WP6 writes new single, map and reduce prompts for the schema of 4.5.1. It copies the text it keeps from `summary-prompt.ts` and does not import that file. The old file stays unchanged until WP11, because the old path uses it. Its prompts conflict with the schema: the user prompts say "Return only the markdown summary" and "the final markdown summary" (`M/summary-prompt.ts:91, 108`), and the system prompts ask for four Markdown sections (`M/summary-prompt.ts:12-26`). From the old summarize code, WP6 keeps only `chunkTranscript` (`M/summarize.ts:323`, 11.5).

System prompts (the text comes from `M/summary-prompt.ts`, changed as stated). **Single**: role, meaning of each field, "do not invent facts, decisions or action items" (`M/summary-prompt.ts:26`, `M/summary-prompt.ts:32-34`). **Map**: one part of a longer transcript; the first lines can repeat the previous part, do not count them twice (`M/summary-prompt.ts:40-42`). **Reduce**: combine ordered partial summaries, remove duplicates (`M/summary-prompt.ts:48-50`). Single and reduce end with the user-instructions and meeting-context blocks when they exist (`M/summary-prompt.ts:58-65`, `M/summary-prompt.ts:77-84`). Map gets the context block only (`M/summarize.ts:488-491`). The new prompts (planned) have no Markdown section text. Today's section text is `M/summary-prompt.ts:12-26`, and WP6 removes it. The new prompts are not written at c47cd80d, so this point cannot be checked in the repo.

User prompts. Single and map: guard sentence and lines inside `<transcript>` tags (`M/summary-prompt.ts:90-101`). Reduce: guard sentence and the partial summaries, each inside `<partial index="n">` tags. Today the partials are plain text, and the tag is written at `M/summary-prompt.ts:106` (the prompt is `M/summary-prompt.ts:104-108`). The word JSON does not occur in that file. In the new prompt each partial is a `MeetingSummary` object written as JSON (planned, WP6), because a map call now returns that object (4.5.1, 4.5.3).

#### 4.5.3 Single, map and reduce

- `tokens(transcript) <= contextBudget`: one call (`M/summarize.ts:447`). Otherwise split into chunks of whole lines with a small overlap (`M/summarize.ts:323-359`), one map call per chunk in order, then the reduce.
- `contextBudget = min(prepared.summary.contextBudget, fit)` (the setting `meeting_summary_context_budget`, default 8000: `V/settings.ts:185`, `V/settings.ts:257-266`; `prepare` reads it once, 4.1). `fit = profile.contextWindow - tokens(system) - maxOutput - SAFETY_TOKENS`. `contextWindow` `null`: only the setting (`M/summarize.ts:365-369`).
- The calls use the keys `single`, `map:<i>` and `reduce:<level>:<group>` (4.0.7). Level 1 reduces groups of map results. Level `L + 1` reduces groups of the results of level `L`. The last level has one group, so its key is `reduce:<last level>:0`.
- The reduce input must fit. Partial tokens over `contextBudget`: group consecutive partials so each group fits, run one reduce per group (one level), repeat on the results until one group is left, then run the final reduce (the last level). This token check is new (JSON partials are larger than prose; only a count guard exists: `M/summarize.ts:468-475`, `M/summarize.ts:498-509`).
- Calls are bounded by `MAX_SUMMARIZE_CALLS` = 24. A plan over it fails with `budget_exceeded` and writes no partial summary: a summary that omits content must not look complete. Today the guard throws a plain `Error` before any LLM call, so no partial summary is written (`M/summarize.ts:462-475`; the throw is at `M/summarize.ts:472-474`). No code emits `budget_exceeded` today. The kind is new (4.0.7). `plannedSummaryCalls(tokens, budget)` (new, WP6) replaces `plannedSummarizeCalls`, which cannot count grouped reduces (`M/summarize.ts:116-124`). It plans `ceil(tokens / fresh)` map calls (`fresh` = budget less the overlap), assumes `SUMMARY_PARTIAL_TOKENS` for each partial, groups `floor(budget / SUMMARY_PARTIAL_TOKENS)` partials for each reduce, and adds the reduce calls of each level until one is left. A group of fewer than 2 partials fails the plan with `budget_exceeded`. The run checks the real count after each level. The job deadline uses the plan.
- The job deadline is `clamp(2 x perCallMs x plannedCalls, 2 x perCallMs, 4 h)`, so one retry for each call fits (X8). The factor 2 on `plannedCalls` is new. Today the formula is `clamp(perCallMs x plannedCalls, 2 x perCallMs, 4 h)` (`M/summarize.ts:151-153`): one attempt for each planned call. Its `2 x perCallMs` floor covers the whole job, not each call. One call has one timeout window (`M/llm-call.ts:146-153`), and the repo code around it has no retry loop. The AI SDK retries a retryable error twice by default inside that window (2.3 P12; `packages/stt/src/post-process.ts:125-137` sets no `maxRetries`). At the ceiling the gateway throws `deadline_exceeded` (3.4.5). A map or reduce call that fails after the route fails the node. Each call goes through `callUnit`, so a retry or a resume never repeats a finished map call (5.6).

#### 4.5.4 Token budget and reasoning

```
answer    = SUMMARY_ANSWER_TOKENS                      // 4096; today DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS, M/summarize.ts:77
maxOutput = min(profile.maxOutputTokens, answer)       // reasoningShare = 0
```

Reasoning is off, sent explicitly (L2; today also off: `S/lib/llm/task-profiles.ts:96-110`). Keep 4096: 1500 was too small and a reduce call ended with `length` (`M/summarize.ts:50-77`). The timeout stays the setting `meeting_summary_timeout_seconds` (`S/lib/llm/task-profiles.ts:154-164`).

#### 4.5.5 Length route

Single call: step 2 `split` (plan a map and reduce with a context budget of half the transcript tokens), then step 4 for each failing call. Map call: step 2 `split` the chunk in two, then steps 3 and 4. Reduce call: step 3 `raise`, then step 4 (grouping splits a reduce: 4.5.3). Every new call counts against `MAX_SUMMARIZE_CALLS`.

#### 4.5.6 Rendering to Markdown

Code renders the object. The model does not write Markdown. The Summary tab shows Markdown (`E/renderer/src/pages/meetings/detail.tsx:894-921`).

```ts
export function renderSummaryMarkdown(s: MeetingSummary): string {
  const list = (a: string[]) => (a.length ? a.map((t) => `- ${oneLine(t)}`).join("\n") : "None.");
  const act = s.actionItems.map((a) => {
    const meta = [a.owner && `Owner: ${oneLine(a.owner)}`, a.due && `Due: ${oneLine(a.due)}`].filter(Boolean);
    return `- ${oneLine(a.task)}${meta.length ? ` (${meta.join("; ")})` : ""}`;
  });
  return [
    `## Overview\n${paragraphs(s.overview)}`,
    `## Key Points\n${list(s.keyPoints)}`,
    `## Decisions\n${list(s.decisions)}`,
    `## Action Items\n${act.length ? act.join("\n") : "None."}`,
    `## Open Questions\n${list(s.openQuestions)}`,
  ].join("\n\n");
}
```

Headings are English and "None." marks an empty list (`M/summary-prompt.ts:14-24`). `oneLine` replaces line breaks with spaces. `paragraphs` removes any line that starts with `#`, so a model string cannot add a heading. `save` gets the object and the Markdown. The Markdown goes to `meeting_summaries.markdown`.

**Where the object lives (decision of this section).** The object lives only in `llm_calls.parsed_json` of the final call of the run: the `single` call, or the last reduce call. It is the advanced-mode inspector record. No code reads it after the run, and no column of `meeting_summaries` holds it. Migration 40 adds no column for it (7.4). SW3 writes the same columns as today (4.6.1). The Summary tab and every reader use `markdown`. Reason: nothing in this spec reads a decision or an action item as data, and a column would add a migration step for no reader. If a later feature must query action items, a new migration adds the column then. The owner can overrule (12.2 Q12). P8 (2.3) and 12.4 follow this decision.

Live proof (L6): as in 4.2.6, with the real `MeetingSummarySchema`.

---

### 4.6 Node `save`

**Purpose.** Code only. Write what the run produced and record each node status. The only node that writes meeting data. **Inputs.** The run state (3.3): `corrections`, `identify`, `verify` and `summary`. The node statuses, the failures and the call ids sit inside those results.

**Output.** `save` returns a `SaveResult`, the state field `saved` (3.3). `save` creates it first and fills it as each write ends. It also returns it when `guardNode` catches a throw. The failure then joins `failures` (4.0.2).

```ts
// W/types.ts (planned, WP5a; absent at c47cd80d). deriveRunStatus (3.4.3) and the runner (3.4.6 step 3) read it.
export type WriteOutcome = "ok" | "failed" | "none";
export interface SaveResult {
  sw1: WriteOutcome; sw2: WriteOutcome; sw3: WriteOutcome; // the writes of 4.6.1
  wroteAny: boolean;       // true when at least one SW1, SW2 or SW3 transaction committed
  correctedCount: number;  // segments that SW1 gave a non-NULL `enhanced_text` in this run
  suggestionCount: number; // `meeting_speakers` rows that SW2 wrote in this run
  failures: NodeFailure[]; // `save_failed` for each write that failed twice, and `internal` from `guardNode`
  meetingGone: boolean;    // `save` found that the meeting row is gone (4.6.4)
}
```

- `sw1`, `sw2`, `sw3`: `none` when `save` tried no transaction of that write. `ok` when it tried at least one and none failed. `failed` when at least one transaction failed twice (4.6.1).
- `correctedCount` counts the segments for which a committed SW1 transaction set a non-NULL `enhanced_text`. A segment that SW1 reset to NULL (N6) adds 0. A rolled-back transaction adds 0. A Summarize run has 0.
- `suggestionCount` counts the `meeting_speakers` rows that a committed SW2 transaction wrote. A suggestion that equals the stored one counts too, because SW2 writes it again. A Summarize run has 0.
- A `save_failed` failure has `node` `save`. Its `unitKey` is the key of the unit for SW1 and null for SW2 and SW3. Its `message` names the write, for example `SW2 failed twice`.
- The step row `save` (SW4) takes `succeeded` when `failures` is empty. It takes `partial` when `failures` is not empty and `wroteAny` is true. Otherwise it takes `failed`. Its error kind is `save_failed`, or `internal`.

#### 4.6.1 Writes

Each write is its own transaction via the synchronous `withTransaction` (`S/lib/db.ts:56-75`). A failed write does not roll back the others (`M/enhance.ts:638-640`).

| Write | Condition | Statement |
|---|---|---|
| SW1 corrections | Each unit with status `ok`. One transaction for each unit | For each segment id the unit covered: `UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?`. The value is the correction, or `NULL` when the unit has none for that segment. Segments of a failed unit stay as they are. The same transaction writes one link for each correction (outcome `applied`, `applied_text` = the value) and for each drop (outcome `dropped`, the drop reason). |
| SW2 speakers | `verify` holds at least one verdict. One transaction for the whole speaker result | For each suggestion: `INSERT INTO meeting_speakers (meeting_id, speaker_label, suggested_name, suggested_evidence, suggested_kind, updated_at) ... ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET suggested_name, suggested_evidence, suggested_kind, updated_at`. The same transaction writes one link for each verdict, kept and dropped (`verdict_json` = the `SpeakerVerdict`). |
| SW3 summary | `summarize` status `ok` | One transaction: `INSERT OR REPLACE INTO meeting_summaries (meeting_id, markdown, llm_provider, llm_model, input_tokens, output_tokens, cost_usd, created_at)`, then `UPDATE meetings SET status = 'summarized' WHERE id = ?`. The same transaction writes the summary links (`applied_text` = the new `created_at` as text, 7.8). |
| SW4 run record | Always, last | The `save` step row in `llm_run_steps` (section 7): status rule under the `SaveResult` in 4.6, error kind `save_failed` or `internal`. The other nodes close their own step rows (7.7 `finishStep`). No link writes. |

- SW1 and SW2 follow today's statements (`M/enhance.ts:628-636`, `M/enhance.ts:658-672`). SW3 follows `S/routes/meetings.ts:1213-1228` but uses one transaction. SW4 runs in its own transaction, so a failure record stays when SW1 to SW3 fail. A link is part of the write it describes (7.2 P6): a crash cannot leave edited text without its link, and a rolled-back write leaves no link. Each write is retried once after 200 ms (for example after `SQLITE_BUSY`). A second failure gives a `NodeFailure` of kind `save_failed` for that write, and the other writes go on. `save` adds the failure to `SaveResult.failures` and sets the outcome of that write to `failed`.
- SW2 never writes `display_name` or `confirmed_at`: a suggestion is evidence, not a user decision, and must not move the summary staleness mark (`M/enhance.ts:658-667`; staleness reads `MAX(confirmed_at)`: `S/routes/meetings.ts:1932-1940`). Only the speaker PATCH writes `confirmed_at` (`S/routes/meetings.ts:2030`, `S/routes/meetings.ts:2040-2048`).
- Inside a run, only SW3 changes `meetings.status`. Today the Summarize save sets `summarized` (`S/routes/meetings.ts:1228`), and the Enhance job never changes the status (`S/routes/meetings.ts:1128-1129`). The word "only" holds for the save step of a run, not for the file. Other code writes the column outside a run: the transcription job (`S/routes/meetings.ts:875, 973, 1007, 1050`), `POST /:id/stop` (`S/routes/meetings.ts:1472`), the two orphan repairs (`S/routes/meetings.ts:1494, 1519`), the start of a transcription (`S/routes/meetings.ts:1543`), and the two inserts of a meeting row (`S/routes/meetings.ts:1384`; `S/routes/meetings-import.ts:281`).

**Link rows.** Each link is a `NewLink` (7.7). Its key is `(call_id, target_type, target_id, seq)` (7.4). `seq` is the index of the entry in the model output of the call, so two entries of one call never share a key.

| Write | `call_id` | `target_type`, `target_id` | `seq` | `outcome`, `reason` | `applied_text` | `verdict_json` |
|---|---|---|---|---|---|---|
| SW1, correction | `callId` of the correction | `segment`, the segment id | `seq` of the correction | `applied`, NULL | the value written to `enhanced_text` | NULL |
| SW1, drop | `callId` of the drop | `segment`, the `id` the model gave | `seq` of the drop | `dropped`, the `CorrectionDropReason` | NULL | NULL |
| SW2, kept verdict | `llmCallId` | `speaker`, the label | `seq` of the verdict | `applied`, NULL | `finalName` | the `SpeakerVerdict` |
| SW2, dropped verdict | `llmCallId` | `speaker`, the label | `seq` of the verdict | `dropped`, the `DropReason` | NULL | the `SpeakerVerdict` |
| SW3, summary | each id of `SummarizeResult.llmCallIds` | `summary`, the meeting id | 0 | `applied`, NULL | the new `created_at` as text | NULL |

A `null` call id gets no link (7.7 rule 9). A `duplicate_id` drop and the applied correction of the same segment have two different `seq` values, so the drop does not replace the applied link. Two proposals for one label in one call have two `seq` values too. Without `seq`, `ON CONFLICT DO UPDATE` would turn the applied link into a dropped link, and the reader of 7.8 would find no row and show `noRecord`. The summary link has one row for each call that made the summary, with `seq` 0, because `call_id` already differs.

#### 4.6.2 Idempotent re-run

- Every write uses a natural key: segment id, (meeting id, label) or meeting id. A replay writes the same values and adds no row. Links use `UNIQUE(call_id, target_type, target_id, seq)` with `ON CONFLICT DO UPDATE` (7.4). The values of `seq` come from the model output and do not change between runs of `save`, because a resumed run reads the same stored output (5.6). SW4 rows use the key (run id, step key). A resumed run can run `save` twice. The second run changes nothing (GR16).
- A new run replaces old results (N6). A unit with status `ok` sets every `enhanced_text` of its segments, and a segment with no correction gets `NULL`. A failed unit leaves the old `enhanced_text`. SW2 overwrites a suggestion only when the new run has a winner for that label, and never clears one.

#### 4.6.3 Partial results policy

The rules of `deriveRunStatus` (3.4.3) decide the run status. This table lists the cases, and the last column gives the result of those rules. The run status is `partial` only when SW1, SW2 or SW3 wrote data in the same run (`SaveResult.wroteAny`, above).

| Situation | Corrections | Speakers | Summary | Run status |
|---|---|---|---|---|
| Some chunks or units fail | Saved for `ok` units | Saved when `identifySpeakers` is `ok` or `partial` | Not part of the run | `partial` |
| All chunks fail | None | Saved when `identifySpeakers` is `ok` | Not part of the run | `partial` if speakers saved, else `failed` |
| `identifySpeakers` fails | Saved | None | Not part of the run | `partial` |
| `verifyEvidence` fails (`internal`) | Saved | None | Not part of the run | `partial` |
| `summarize` fails in a Summarize run (the only live case: no trigger starts both stages, 3.6) | Not part of the run | Not part of the run | None. Status unchanged. | `failed`: SW1 and SW2 wrote nothing in this run |
| `summarize` fails in a run that also has the stage `enhance` (the graph supports it, OQ-2) | Saved | Saved | None. Status unchanged. | `partial`: SW1 or SW2 wrote data in the same run |
| Cancelled by the user | Saved for finished chunks | Saved when finished | None | `cancelled` |
| Meeting deleted during the run | None | None | None | `meeting_deleted`, no error |
| A run-wide failure stops the run (3.4.5) | Saved for finished units | Saved when finished | None | `partial`, or `failed` when nothing was saved |
| A write of `save` fails twice (`save_failed`) | The other writes stay | | | `partial`, or `failed` when nothing was saved |

A cancelled run still goes through `save` and writes what exists (`M/enhance.ts:464-469`, `M/enhance.ts:628-636`). A cancelled `summarize` writes no summary (4.5.3). Section 3 maps the run status to the job state.

#### 4.6.4 A deleted meeting

The delete route asks the run to stop and deletes the row at once, without waiting (`S/routes/meetings.ts:2258-2265`, `S/routes/meetings.ts:2283`). The foreign key then rejects inserts into `meeting_speakers`, the summary table and the run record.

- `save` checks that the meeting row exists before each write and catches a constraint error. If the row is gone, `save` stops, logs one info line, sets `meetingGone` in the `SaveResult` and does not fail the run. An `UPDATE` of a deleted segment changes 0 rows, no error.
- Test the missing row with `=== undefined`, not with today's `=== null` (3.4.8 rule 1).

#### 4.6.5 Export files

After the writes, `save` rewrites `transcript.md` and `transcript-enhanced.md`, best effort, never throwing. Today the function is `writeTranscriptMarkdown` (`S/routes/meetings.ts:322-342`; WP5a moves it to `transcript-io.ts`, 3.1). It always writes `transcript.md` (`S/routes/meetings.ts:325-329`). It writes `transcript-enhanced.md` only when a segment has `enhancedText` (`S/routes/meetings.ts:330-336`). Its `catch` logs a warning and never throws (`S/routes/meetings.ts:337-341`). `save` runs it after every run, also after a cancel, and not when the meeting is gone. Today the `finally` block of the Enhance job does this (`S/routes/meetings.ts:1133-1139`).

---

### 4.7 Open points for the owner

D1 to D12 do not settle these points. This section uses each default.

| ID | Point | Default |
|---|---|---|
| N1 | Key Points in the summary: the single and reduce prompts require them (`M/summary-prompt.ts:12-18`, `M/summary-prompt.ts:34`, `M/summary-prompt.ts:50`), the map prompt does not (`M/summary-prompt.ts:40-42`). | Keep `keyPoints`. |
| N2 | The app user often addresses a speaker by name, but the guard drops "Me" evidence. Code cannot check that an ADDRESSED-AS name refers to the label. A turn-taking rule (the addressed speaker talks next) could help. | Keep today's rules. Send no "Me" lines. Measure the rule in the benchmark first. |
| N3 | Self-introduction cues exist in English only. | Keep English. A pattern list per language is a later change. |
| N4 | Title and user context reach the model only inside the speaker block today (`M/enhance-prompt.ts:78-90`). | `identifySpeakers` only. A benchmark can test `correctChunk`. |
| N5 | A user preset can switch reasoning on for `meetingEnhance`; `prepare` fixes the model for the run (4.1 P9). | Preset wins, warning in the call record. 5.5.2 agrees. |
| N6 | A re-run resets `enhanced_text` to `NULL` for segments of an `ok` chunk with no correction (today only segments with a new correction change). | Reset: the last pass is the whole truth. |
| N7 | Constants marked "new" in 4.0.5 are starting values. | The benchmark tunes them (D12). |
| N8 | The spelling fix runs before the conflict policy (today after, on winners only: `M/enhance.ts:641-651`). | Before, so two spellings of one person join. |
| N9 | Each node could have its own task id, model and preset. | Two task ids. A new task id needs no settings migration. A missing task key means `auto` (`specs/llm-task-profiles.md:478-481`), and that file calls a new task id a small additive follow-up with no schema change to presets (`specs/llm-task-profiles.md:1466-1468`). A new id needs a registry row (`V/llm-task-profiles.ts:9-16`, `S/lib/llm/task-profiles.ts:81-127`), and the UI lists one row for each task (`specs/llm-task-profiles.md:1120`). UNVERIFIED: any gain from a model for each node. The benchmark (D12) can test it. |
| N10 | Whether oMLX applies a strict schema, also to the reasoning part, is not verified in this repo. | A live probe in section 10 settles it. |

### 4.8 Unverified in this section

Marked UNVERIFIED in the text: 4.0.5 (CJK token estimate, starting values), 4.0.6 and 4.3.4 (oMLX stop-at-limit, strict schema, `thinking_budget`), 4.3.2 (S2.3 without capital letters), 4.3.5 (proposal size), 4.4.1 (curly apostrophes in the owner's ASR), 4.4.3 (share of non-English meetings).

---

## 5. LLM gateway contract

The gateway is the one module that sends every LLM request of the meeting workflow. Its one entry point is `callStructured`. One call sends one request. The gateway never loops. It is new code (none at baseline `c47cd80d`). It serves the three LLM nodes of section 4, builds no prompts and writes no meeting data (sections 4, 7, 8). It imports no LangGraph (3.1). It uses no LiteLLM module (D9); a user-run LiteLLM proxy is one more `server` endpoint, and these rules apply to it. Dictation cleanup (`L/post-process.ts:223-250`), Remix quick edit (`L/remix-transform.ts:127-132`) and the Remix agent (`L/remix-agent.ts:95-103`) keep their own calls and lane leases; section 6 only moves them to AI SDK v7. Files in `LLM/`: `gateway.ts`, `gateway-errors.ts`, `model-profiles.ts`, `call-record.ts`.

**Keys.** Repo paths are at `c47cd80d`: `S`=`apps/server/src`, `L`=`S/lib`, `LLM`=`L/llm`, `M`=`L/meetings`, `V`=`packages/validations/src`, `STT`=`packages/stt/src`, `E`=`apps/electron/src`. `SDK7`=`https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages` (commit of `ai@7.0.143`). `LGJS`=`https://github.com/langchain-ai/langgraphjs/blob/main/libs`. `AI6`=`/Users/maheidem/Documents/dev/openstyle/node_modules/.pnpm/ai@6.0.191_zod@4.4.3/node_modules/ai/dist/index.mjs`. `AI`=`https://ai-sdk.dev/docs`, `OAI`=`https://developers.openai.com/api/docs/guides`, `ANT`=`https://platform.claude.com/docs/en/build-with-claude`, `OR`=`https://openrouter.ai/docs`. `OSS`=`/Users/maheidem/Documents/Symphony/oss-local-hosting-material/homelab` (outside the repo). `W`=`M/workflow`, planned: the directory does not exist at `c47cd80d`, and every file under it is new (3.1, 11.5). `LT`=`.claude/skills/live-testing/SKILL.md`.

---

### 5.0 What the gateway replaces

Current state: 2.1.4 and P3, P4, P12 in 2.3. At baseline a meeting call has no finish reason (`M/llm-call.ts:46-55`). A `content-filter`, `error` or `other` result with text passes as success (`STT/post-process.ts:148-176`). The SDK default of 2 retries applies. The `generateText` call sets no `maxRetries` (`STT/post-process.ts:125-137`), and meeting calls reach it through `postProcess` (`M/llm-call.ts:136`). The SDK sets the default to 2 (`AI6:2739`; the parameter default is at `AI6:2653`). No LLM call in `apps` or `packages` sets `maxRetries` at baseline. The only other `maxRetries` there are `rmSync` options (`S/routes/transcribe-file.ts:196`, `S/routes/meetings-import.ts:333`).

---

### 5.1 The function `callStructured`

`resolveCallProfile` runs once for each node in `prepare` (4.1 P9). `callStructured` runs once for each request.

**Base types (rule B).** WP2 writes `call-record.ts` and `llm-record.ts` before WP3 exists (11.2). Their fields use six gateway types. So WP2 declares every base type, in the two files below. WP3, WP5a and WP5b import them and declare none again. The check is in 11.4. `FailureKind` (4.0.7) extends `GatewayErrorKind`. It does not define it.

```ts
// LLM/call-record.ts (WP2). The only declaration of each type.
import type { LlmParamsLedger } from "@openstyle/validations"; // V/meeting-types.ts (WP2), below
export type LlmStepId = "correctChunk" | "identifySpeakers" | "summarize";
export interface ChatTurn { role: "user" | "assistant"; content: string }
export type UnifiedFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
export interface TokenUsage { input: number | null; output: number | null; reasoning: number | null; cached: number | null } // null = unknown (the old code writes 0: M/llm-call.ts:45)
export type StructuredMode = LlmParamsLedger["structuredMode"]; // "json_schema_strict" | "json_schema" | "json_tool" | "json_object" | "prompt_only". 7.5 holds the literal union
export type GatewayErrorKind = // the 15 kinds of 5.2.1 and 7.6. One error class for each kind (5.2)
  | "length" | "content_filter" | "unexpected_tool_calls" | "abnormal_stop" | "reasoning_leak" | "schema"
  | "model_mismatch" | "cancelled" | "provider_timeout" | "provider_rate_limited" | "provider_unavailable"
  | "provider_auth" | "provider_invalid_request" | "model_unavailable" | "deadline_exceeded";
// CallRecord, RecordedCall and CallSink are in this file too (below).
```

`V/meeting-types.ts` (WP2) declares these types: `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus` (4.4), `CorrectionDropReason` (4.2), `LlmMessage` and `LlmParamsLedger` (7.5), and the types of 8.4. `V` is a lower package. It imports nothing from the server. So `LlmParamsLedger` keeps the literal union of `structuredMode`, and `StructuredMode` takes its type from it.

```ts
// LLM/gateway.ts and LLM/model-profiles.ts (WP3). The base types above are imported, not declared again.
export type MeetingLlmTaskId = Extract<LlmTaskId, "meetingEnhance" | "meetingSummarize">;
export interface StepSchema<T> { name: string; version: number; zod: z.ZodType<T> } // D2. name: [A-Za-z0-9_], the wire name. version: stored, not sent.
export interface ReasoningPlan { // names: 4.0.5
  mode: "off" | "bounded"; budgetTokens: number; countsInMaxOutput: boolean; maxBudgetTokens: number | null; // budgetTokens 0 when off; maxBudgetTokens null: no token budget
  boundedLevel: "minimal" | "low" | "medium" | "high" | null; control: "none" | "effort" | "toggle" | "budget_tokens" | "template_kwargs";
  force: boolean; // beats a user preset; only the length route sets it (4.0.6)
}
export interface CallProfile { // plain data, no API key, in graph state (3.3)
  taskId: MeetingLlmTaskId; provider: string; modelId: string;
  contextWindow: number | null; maxOutputTokens: number | null; // models.dev limit.context, limit.output; both null for `server` and when the registry read fails (below)
  structured: StructuredMode; reasoning: ReasoningPlan;       // start mode (5.4); reasoning (5.5)
  warnings: string[]; // one line each, no prompt text. `registry_unavailable` when the registry read failed. The gateway copies them into `LlmParamsLedger.warnings` of each call
}
export type ReasoningSteps = Partial<Record<LlmStepId, "bounded">>; // model-profiles.ts. A step that is not in the table reasons off (5.5 rule 4)
export declare const reasoningSteps: ReasoningSteps; // the default table: `{}` until the benchmark shows a gain (D12)
export declare function resolveCallProfile(a: { taskId: MeetingLlmTaskId; step: LlmStepId; maxReasoningTokens: number;
  pin?: { provider: string; modelId: string }; reasoningSteps?: ReasoningSteps }): Promise<CallProfile>; // pin keeps the run model fixed (4.1 P9). reasoningSteps: the test hook; it replaces the default table (5.5 rule 4)
export type ResolvedModels = Record<LlmStepId, CallProfile>;
export declare function resolveModels(a: { maxReasoningTokens: Record<LlmStepId, number>; reasoningSteps?: ReasoningSteps }): Promise<ResolvedModels>; // in `prepare` (4.3.4)
export declare function withReasoningOff(p: CallProfile): CallProfile; // mode "off", force true (4.0.6)
export type CreateModel = typeof createChatModel; // `L/providers.ts:54-58`: (providerId, modelId, taskContext?) => Promise<LanguageModel>. The model seam of the gateway
export interface CallStructuredInput<T> {
  step: LlmStepId; meetingId: string; runId: string; unitKey: string; chunkIndex: number | null; // unitKey: 4.0.7
  schema: StepSchema<T>; instructions: string; messages: readonly ChatTurn[]; // instructions = system text: v7 rejects system-role messages (AI/migration-guides/migration-guide-7-0)
  profile: CallProfile; maxOutputTokens: number; signal: AbortSignal; // maxOutputTokens: capped at profile.maxOutputTokens. signal: the run context signal `ctx.signal` (3.4.5); the gateway combines it with the call timeout (5.7)
  sink: CallSink; onQueued?: (i: { waitedMs: number; ahead: number }) => void; // lane queue progress for the job blob
  stopped?: () => boolean; // `callUnit` sets it to `ctx.isStopped()`. The gateway reads it when the lease opens (3.4.5)
  retry?: { kind: GatewayErrorKind; change: RetryChange; validatorMessage?: string }; // set by `callUnit` on the second call only (5.6)
  createModel?: CreateModel; // test seam, used in step 3 of "One call". A scripted `MockLanguageModelV4` enters here. Production leaves it unset, so the gateway calls `createChatModel`. `callUnit` copies `WorkflowDeps.createModel` into it (3.4.2)
}
export interface CallStructuredResult<T> {
  object: T; finishReason: "stop"; rawFinishReason: string; usage: TokenUsage; // the gate (5.3) throws for every other reason
  modelRequested: string; modelServed: string | null; // model.modelId (STT/post-process.ts:87-94); null: the response names no model. The result holds no price: a node that needs a cost reads the price itself (4.5)
  latencyMs: number; queuedMs: number; // wire time (lane lease to end); lane queue time
  attempt: number | null; // position of this call among the recorded calls of (runId, unitKey), from 1, length-route calls included. The recorder computes it in `recordCall` (below). null: the record write failed (7.7)
  paramsLedger: LlmParamsLedger; structuredMode: StructuredMode; callId: number | null; // null: the record write failed (7.7)
}
export declare function callStructured<T>(input: CallStructuredInput<T>): Promise<CallStructuredResult<T>>;
```

**The models.dev read is best effort.** `resolveCallProfile` reads models.dev for `structured_output`, `reasoning`, `limit.context` and `limit.output` (5.4, 5.5, 4.0.5). That read must never stop a run. `fetchModelsFromRegistry` returns data only while its 6 hour cache is fresh. Otherwise it fetches with a 3 s timeout, and it throws on a network fault or a bad status (`apps/server/src/lib/model-registry.ts:11, 49-73`). The non-goal "no required cloud service" (1.3) needs these rules:

1. **`server` skips the read.** A local server has no models.dev entry. The hand row of 5.4 and 5.5 is enough. `contextWindow` and `maxOutputTokens` are `null`, and the nodes use the constants of 4.0.5. The read costs no 3 s wait.
2. **Other providers read once.** `resolveModels` reads the registry once for its three profiles, not once for each profile. If the read throws, each profile uses the hand table: the first mode of the 5.4 row (a missing `structured_output` key keeps the first mode), the hand row of 5.5, and `null` for both limits. The profile adds the warning `registry_unavailable` to `warnings`. The stale cache is private to `model-registry.ts` (`modelsCache`, :49) and the module returns it only while fresh (:60-62), so the gateway does not use it.
3. **It never gives `model_unavailable`.** A failed read is not a model-setup fault (4.1 P9, 5.2.1). `model_unavailable` stays for steps 2 and 3 of "One call".
4. **Test.** The registry fetch rejects: a `server` profile resolves and a `server` Enhance runs end to end with no `registry_unavailable` warning, and a cloud profile resolves with the hand-table values, the warning, and no `model_unavailable` (10.5.3, W14).

**One call.**

1. If `retry` is set, apply its change: add the validator message as a user turn (5.3.5), or read the lower mode from the mode cache (5.4).
2. `resolveTaskCall(taskId, { autoMaxOutputTokens, pin })` gives sampling, preset params and timeout (`LLM/task-profiles.ts:314-410`). At baseline its options hold only `autoMaxOutputTokens` (`LLM/task-profiles.ts:177-179`), and its result has no `droppedKeys` and no `source` (`LLM/task-profiles.ts:166-175`). The option `pin` and the result fields `droppedKeys` and `source` are required changes. WP3 adds them (11.4).
3. Choose the mode (5.4) and the reasoning shape (5.5). Build the model with `input.createModel ?? createChatModel` (`L/providers.ts:54-72`). Wrap it with the capture middleware, also a scripted model, so the capture and the gate run on every test path. Steps 2 and 3 run in one `try`. Any error there becomes `ModelUnavailableError` (5.2.1): no model set up, an unsupported provider, no API key, or a server removed from the list. `ModelUnavailableError` is a new class: it does not exist at `c47cd80d`. The four throw sites exist and throw a plain `Error` there (`LLM/task-profiles.ts:334-336`, `L/providers.ts:60`, `:64-65`, `LLM/registry.ts:252-254`). They stay as they are. The gateway converts their errors to the new class.
4. Take a `background` lane lease with `withLlmLane` and `signal` (`LLM/lane.ts:506-519`). `signal` must join the `Pick` at `LLM/lane.ts:509`. The lane supports it (`LLM/lane.ts:81-83`). When the lease opens, if `stopped?.()` is true, release the lease and throw `CancelledError` phase `queued`. No request goes out, `startAttempt` does not run and no call record is written. A call that waited in the lane while a run-wide failure stopped the run ends here.
5. In the lease, start the timeout. Call `generateText` (`AI/reference/ai-sdk-core/generate-text`) with `maxRetries: 0` (D5), `abortSignal: AbortSignal.any([signal, timeoutSignal])`, `instructions`, `messages`, `output` (`Output.object`, `Output.json` or `Output.text`), sampling, `providerOptions` and `telemetry` (section 9). `Output.object` has no strict switch (`AI/reference/ai-sdk-core/output`). Strictness comes from the provider option (5.4). The gateway passes `step.schema.zod` to the SDK unchanged and runs no schema step of its own (4.0.3 rule 7). For the record it computes `await asSchema(step.schema.zod).jsonSchema`, the SDK's own conversion, and stores that output as `schema_json`. Run the gate (5.3).
6. Write the call record with `sink.recordCall` (7.7). Return the object or throw one typed error (5.2).

**Capture middleware.** A `wrapLanguageModel` middleware (`wrapGenerate`) copies `finishReason` (`{ unified, raw }`), `response.modelId`, `response.body`, `request.body`, `warnings`, the text parts of `content` and `usage` from the `doGenerate` result before the SDK parses. `wrapGenerate` receives `doGenerate` and `params` (`SDK7/provider/src/language-model-middleware/v4/language-model-v4-middleware.ts:60-65`). The `doGenerate` result type has these fields (`SDK7/provider/src/language-model/v4/language-model-v4-generate-result.ts:11-63`). The `finishReason` field has `unified` and `raw` (`SDK7/provider/src/language-model/v4/language-model-v4-finish-reason.ts:8-33`). The `response` field has `modelId` (`SDK7/provider/src/language-model/v4/language-model-v4-response-metadata.ts:15`). The result has no top-level `text`. The text is in the `content` parts with `type: "text"` (`SDK7/provider/src/language-model/v4/language-model-v4-text.ts:7-13`). The docs page `AI/ai-sdk-core/middleware` shows `wrapLanguageModel` and `wrapGenerate` with `doGenerate` and `params`, and it documents only `content` in the result. It does not list the other fields, so the type files are the source. `NoObjectGeneratedError` has no raw finish reason (`AI/reference/ai-sdk-errors/ai-no-object-generated-error`). If `doGenerate` throws, the gateway reads the `APICallError` (5.2).

**Call record seam.** Section 7 owns the table `llm_calls`. The gateway sees only this interface.

```ts
// LLM/call-record.ts (WP2 writes the whole file, with the base types above; WP3 fills the record). The gateway imports only this file for records.
export interface CallRecord { // one call, built after it ends. Each field maps to one column of `llm_calls` (7.4)
  runId: string; meetingId: string;
  unitKey: string;                       // step_key
  node: LlmStepId;                       // node
  retryReason: string | null;            // retry_reason: `input.retry.kind` on the second call of a unit, else null
  provider: string | null; modelRequested: string | null; modelServed: string | null; // provider, requested_model, served_model
  instructions: string; messages: readonly ChatTurn[]; // messages_json: [{ role: "system", content: instructions }, ...messages]
  schema: { name: string; version: number; json: unknown }; // schema_name, schema_version, schema_json (4.0.3 rule 7)
  params: LlmParamsLedger;               // params_json (7.5). Holds the structured mode (7.5)
  rawText: string | null; parsed: unknown | null; reasoningChars: number | null; // raw_text, parsed_json, reasoning_chars
  finishUnified: UnifiedFinishReason | null; finishRaw: string | null; // finish_unified, finish_raw
  usage: TokenUsage;                     // input_tokens, output_tokens, reasoning_tokens, cached_tokens (null = unknown)
  queuedMs: number | null; latencyMs: number | null; // queued_ms, latency_ms
  errorKind: GatewayErrorKind | null; errorDetail: string | null; // error_kind, error_detail (5.8: no prompt or answer text)
  startedAt: number; finishedAt: number; // started_at, finished_at (epoch ms)
}
// `attempt` is not a field. `recordCall` computes it: the number of `llm_calls` rows with the same `run_id` and `step_key`, plus 1,
// in the same statement as the INSERT. A call that was not recorded does not count. So the gateway learns `attempt` from the return value.
export interface RecordedCall { id: number; attempt: number }
export interface CallSink { // the recorder of 7.7 implements it. One phase: one row, after the call
  startAttempt(a: { runId: string; stepKey: string }): void; // before each request: llm_run_steps.attempts += 1. It returns nothing
  recordCall(c: CallRecord): RecordedCall | null; // after the call ends, also for every error and for cancel. null: the write failed
}
```

A call in flight at process death leaves no row. `step_key` is the `unitKey` (7.4). The gateway sets `callId` and `attempt` of `CallStructuredResult` and of `CallFacts` (5.2) from the `RecordedCall`, or to `null` when `recordCall` returns `null`. A sink failure never fails the call. This is a new rule: no sink exists at baseline (`recordCall`, `CallSink` and `llm_calls` appear nowhere in `apps` and `packages` at `c47cd80d`). The nearest baseline rule is a different one. The Enhance auto-run catch logs a failure and leaves the meeting status unchanged (`S/routes/meetings.ts:1118-1131`, rule at `:1128-1130`). The gateway logs the error kind only. A node counts a `null` id with `ctx.recordLost()`, and `save` writes no link for it (7.7).

**Param ledger.** Goal G8: the ledger equals the captured body (L2). Section 7.5 defines `LlmParamsLedger` (`topLevel`, `extraBody`, `dropped`, `source`, `capturedFrom`, `warnings`, `structuredMode`). The gateway fills it, copies `profile.warnings` and the mode into it, and sets `dropped.reason` from this set:

```ts
type LedgerDropReason = "denylist" | "not_in_safe_subset" /* cloud never gets this preset key */ | "sdk_unsupported" | "no_reasoning_control";
```

For `server`, a new `LlmTaskContext` callback hands the merged body from the fetch wrapper to the gateway (`LLM/registry.ts:151-169`, `:19-22`). Other providers use `request.body` from the capture. The ledger removes `messages`, `system`, `contents` and schema bodies. `dropped` comes from `stripDenylistedKeys` (debug log only today: `LLM/task-profiles.ts:249-265`), the cloud safe subset (`LLM/task-profiles.ts:369-380`) and SDK `warnings`. Both built-in presets carry `stream: false` (`V/llm-task-profiles.ts:92`, `:113`; comment `:73-77`). The denylist drops it (`V/llm-task-profiles.ts:199-206`). Today the drop leaves one debug log line that names the key (`LLM/task-profiles.ts:261-263`) and no record. The ledger adds the record.

---

### 5.2 Typed errors

The gateway throws one kind of object: a subclass of `GatewayError`. Code, UI and inspector use `kind`, never the message. `GatewayErrorKind` is the literal union of the 15 kinds in 5.1 (rule B). WP2 declares it once in `call-record.ts`. `FailureKind` (4.0.7) adds four values to it: `budget_exceeded`, `empty_input`, `save_failed` and `internal`. Neither type is defined through the other. The code form of the routing table (5.2.1) has one entry for each kind (`Record<GatewayErrorKind, ...>`), so a new kind fails the type check until it has a route.

```ts
export type RetryChange = "none" | "add_validator_message" | "downgrade_mode"; // SchemaError; 5.4
export interface RetryAdvice { change: RetryChange; waitMs: number } // waitMs at most 60 000
export interface CallFacts { callId: number | null; step: LlmStepId; unitKey: string; attempt: number | null; finishReason: UnifiedFinishReason | null; // attempt: as in CallStructuredResult
  rawFinishReason: string | null; usage: TokenUsage | null; modelRequested: string; modelServed: string | null; structuredMode: StructuredMode;
  paramsLedger: LlmParamsLedger; latencyMs: number }
export abstract class GatewayError extends Error {
  abstract readonly kind: GatewayErrorKind; readonly facts: CallFacts;
  readonly retry: RetryAdvice | null; // null: final, the graph must not retry
  readonly runWide: boolean;          // the same cause hits every other unit of the run
} // `message`: fixed text with codes and numbers, never prompt or answer text (5.8)
// Subclasses, extra fields (`kind` = class name in snake_case without "Error"; ProviderError: "provider_" + reason):
// LengthError { where: "output" | "input"; maxOutputTokens: number }   ContentFilterError { via: "finish_reason" | "refusal" }   UnexpectedToolCallsError {}
// AbnormalStopError { cause: "error" | "other" | "unknown_raw" | "missing_raw" }   ReasoningLeakError { leak: "think_tag" | "empty_content_with_reasoning" }
// SchemaError { stage: "json" | "schema"; validatorMessage: string }   ModelMismatchError { requested: string; served: string }   CancelledError { phase: "queued" | "in_flight" }
// ModelUnavailableError { reason: "no_model" | "unsupported_provider" | "no_api_key" | "server_removed" }   DeadlineExceededError {}
// ProviderError { reason: "timeout" | "rate_limited" | "unavailable" | "auth" | "invalid_request"; statusCode: number | null; retryAfterMs: number | null; detail: string }
```

`validatorMessage` holds zod paths and messages only, at most 500 characters, no echoed values. `ProviderError` is a new class: it does not exist at `c47cd80d`. `ProviderError.detail` is the provider message cut to 200 characters. Its closest baseline analog is `failureDetail`. That function writes the error name, a colon and the message, then cuts the text to 200 characters (`M/enhance.ts:166-170`; name and message at `:167-168`, cut at `:169`). So the detail of that function includes the error name. `ProviderError.detail` takes the same shape.

#### 5.2.1 Routing table

What the graph and the node do for each error (D4, L3). `callUnit` (5.6) is the only retry layer.

| Error | Raised when | `callUnit` retry, then next |
|---|---|---|
| `LengthError` | Unified `length` (`where: "output"`); `NoObjectGeneratedError` with `finishReason: "length"`; HTTP 413, or HTTP 400 with an input-overflow phrase (`where: "input"`, below) | No. Length route (4.0.6; `input` skips `lowerReasoning` and `raise`), then fail the unit. |
| `ContentFilterError` | Unified `content-filter`; OpenAI `refusal` field with finish reason `stop` | No. Fail the unit. |
| `UnexpectedToolCallsError` | Unified `tool-calls` (the nodes send no tools) | No. Fail the unit. |
| `AbnormalStopError` | Unified `error` or `other`; unified `stop` with a raw reason outside the alias set (5.3) | Cause `error` or `other`: once, same input, 1 s plus jitter, then fail. Cause `unknown_raw` or `missing_raw`: no retry, because every call meets the same cause. |
| `ReasoningLeakError` | `<think>` tag in the text, or empty text with reasoning (5.3) | No. Reasoning on: length route step 1 (`withReasoningOff`). Off: fail (5-P6). |
| `SchemaError` | Invalid JSON, or zod rejects; finish reason `stop` | Once; the next call adds the validator message as a user turn (L3). Then fail. |
| `ModelMismatchError` | Served model differs from requested (5.3.4) | No. Fail; a repeat meets the same swap (L4). |
| `ProviderError` `timeout` | Timeout fires, or HTTP 408 | Cloud: once. `server`: no (5-P2). Then fail. |
| `ProviderError` `rate_limited` | HTTP 429 | Once, after `Retry-After`, at most 60 s; more: no retry (5-P3). Then fail. |
| `ProviderError` `unavailable` | HTTP 409 or 5xx; network failure before any response | Once, 1 s plus jitter. Then fail. |
| `ProviderError` `auth` | HTTP 401 or 403 | No. Fail. |
| `ProviderError` `invalid_request` | HTTP 400, 404, 422 (not an input overflow) | Once with `downgrade_mode`, only if the body names `response_format`, `json_schema` or `schema` and a lower mode exists (5.4). Else fail. |
| `CancelledError` | `signal` aborted (queued: lane threw `LlmLaneCancelledError`; in flight: abort reached the request) | No. Unit status `cancelled`, not a failure. |
| `DeadlineExceededError` | `signal` aborted and `signal.reason.name` is `TimeoutError` (the Summarize job ceiling, 3.4.5, 5.7) | No. Fail the unit. The run stops. |
| `ModelUnavailableError` | Step 2 or 3 of 5.1 throws. No request was sent | No. Fail the unit. Run-wide. `message` names Settings > Models, `detail` holds the original message. |

- **Run-wide:** `provider_auth`, `model_mismatch`, `model_unavailable`, `provider_invalid_request` (not a mode rejection), `abnormal_stop` with cause `unknown_raw` or `missing_raw`, and `reasoning_leak` with reasoning off set `runWide`. The first one calls `ctx.stopRun` (3.4.5), and no other unit starts a call. A cause that hits every unit but is not in this list (a persistent `length` or `schema` failure) stops the node after `BREAKER_N` failures in a row (3.4.5).
- Any other HTTP status: SDK flag `isRetryable` true gives `unavailable`, false gives `invalid_request` (`SDK7/provider/src/errors/api-call-error.ts`). The message never holds `requestBodyValues` (prompts, 4.0.7). `Retry-After`: read `retry-after-ms`, then `retry-after` (`SDK7/ai/src/util/retry-with-exponential-backoff.ts`). An input overflow becomes `LengthError` `where: "input"`: HTTP 413, or HTTP 400 with `prefill_memory_exceeded` (oMLX, `/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:129`), `context_length_exceeded` or `maximum context length` (the last two UNVERIFIED here). A reviewer adds a phrase per provider after a live error (W13). For `server` the fit check is skipped (4.0.5), so this error is the only guard. With `maxRetries: 0` the SDK throws the raw error. This holds by source reading: the catch block of the retry function rethrows the original error without a wrapper when `maxRetries` is 0 (`SDK7/provider-utils/src/retry-with-exponential-backoff.ts:93-95`; the v6.0.191 code does the same: `AI6:2675-2677`). The docs page `AI/reference/ai-sdk-errors/ai-retry-error` does not cover `maxRetries: 0`. No run has proved it (UNVERIFIED by a run).

---

### 5.3 The acceptance gate

The gate runs after every wire call. It reads the capture and reads `result.output` only in step 5. The order is fixed (L1, L4): (1) unified finish reason is `stop`; (2) raw finish reason is in the known aliases; (3) no reasoning leak; (4) served model matches; (5) the answer parses against the schema. The finish reason comes first: a cut answer causes a bad parse and reasoning text, which are effects. It gives `LengthError`, not `SchemaError`.

```mermaid
flowchart TD
  A[Provider answer in the capture] --> B{unified reason}
  B -- length --> L[LengthError]
  B -- content-filter --> C[ContentFilterError]
  B -- tool-calls --> T[UnexpectedToolCallsError]
  B -- error or other --> X[AbnormalStopError]
  B -- stop --> R{refusal field?}
  R -- yes --> C
  R -- no --> D{raw reason in aliases?}
  D -- no --> X
  D -- yes --> E{reasoning leak?}
  E -- yes --> Q[ReasoningLeakError]
  E -- no --> F{served model matches?}
  F -- no --> M[ModelMismatchError]
  F -- yes --> G{schema parses?}
  G -- no --> S[SchemaError]
  G -- yes --> OK[return the object]
```

#### 5.3.1 The AI SDK v7 trap

v7 parses when the finish reason is `stop`, and also when it is not `tool-calls` and the text is not empty (`SDK7/ai/src/generate-text/generate-text.ts:1614-1630`; v6.0.191 parses only for `stop`: `AI6:4729`; section 6). So `length`, `content-filter`, `error` and `other` with valid JSON return normally, and the gate reads the capture. `result.output` is a getter that throws `NoOutputGeneratedError` when no output exists (`AI/reference/ai-sdk-errors/ai-no-output-generated-error`). Never write `const { output } = await generateText(...)`. Read `output` last. After the gate chose an error, read it in a `try`. An object there is kept as `parsed_json` (section 7, D4).

#### 5.3.2 Known stop aliases

The gate accepts one raw value per provider and mode. Unified `stop` alone is not enough. A null or unknown reason becomes `other`. Sources under `SDK7/`: `openai/src/chat/map-openai-finish-reason.ts`, `groq/src/map-groq-finish-reason.ts:3-19`, `anthropic/src/map-anthropic-stop-reason.ts`, `google/src/map-google-finish-reason.ts`, `mistral/src/map-mistral-finish-reason.ts`.

| Alias key | Used for | Accepted raw | Also mapped to `stop`, rejected by the gate |
|---|---|---|---|
| `openai_chat` | `openai`, `vercel`, `openrouter`, `server` (all `createOpenAI().chat`) | `stop` | none |
| `groq` | `groq` (own map, equal to the OpenAI map today) | `stop` | none |
| `anthropic_output_format` | `anthropic` with `output_config.format` | `end_turn` | `stop_sequence` (nodes send none), `pause_turn` |
| `anthropic_json_tool` | `anthropic` with the forced `json` tool | `tool_use` | `pause_turn`, `end_turn` |
| `google` | `google` | `STOP` | none |
| `mistral` | `mistral` | `stop` | none |

`pause_turn` means the client must continue the turn (`ANT/handling-stop-reasons`). The nodes cannot. UNVERIFIED: the native OpenRouter set and the raw values of Ollama, LM Studio and llama.cpp. The page `OR/api/reference/overview` lists only the normalized `finish_reason` set (`tool_calls`, `stop`, `length`, `content_filter`, `error`). It says the raw value is in `native_finish_reason`, and it does not list the native values. So the page does not support a native set. An unknown raw gives `AbnormalStopError` `unknown_raw`. A reviewer adds valid values. The table fails closed on purpose (R5-1). Behind a user-run LiteLLM proxy step 2 adds no safety, because the proxy maps `error` and unknown values to `stop` (https://github.com/BerriAI/litellm/blob/caad4d62045e76c1a8428ab8f316d351ca9a0a7e/litellm/litellm_core_utils/core_helpers.py).

#### 5.3.3 Reasoning leak

`detectReasoningLeak` runs after steps 1 and 2. Rule 1, `think_tag`: the text matches `/<\s*\/?\s*think\s*>/i` (`STT/text.ts:53`). The gateway reuses the pattern (WP3 exports `THINK_TAG` from `packages/stt/src/text.ts` and `index.ts`, 11.4) and does not call the sanitizer, which hides the leak (`STT/text.ts:74-88`). Rule 2, `empty_content_with_reasoning`: the text is blank and the body shows reasoning (`choices[0].message.reasoning_content` or `.reasoning` has text, or `usage.reasoning` is above 0). The gateway reads the raw body, because `@ai-sdk/openai` `.chat` does not read `reasoning_content` (`SDK7/openai/src/chat/openai-chat-language-model.ts`; UNVERIFIED for 3.0.65).

#### 5.3.4 Served model

`modelMatches(requested, served)` is true when: the ids are equal ignoring case; or the served id is the requested id plus one date or version suffix (`-20250929`, `-2024-07-18`, `-v2`); or the requested id ends with `-latest` and the served id is its base plus such a suffix. Any other pair is a mismatch. No model name in the response: pass, with `modelServed: null` and a warning. The rule is proposal 5-P4, UNVERIFIED against live ids (section 10 records them first).

#### 5.3.5 Parse

- Modes `json_schema_strict`, `json_schema`, `json_tool`: the SDK parses with `Output.object`. A failure is `NoObjectGeneratedError` with a `JSONParseError` or validation `cause`. The gate maps it to `SchemaError` `stage` `json` or `schema`.
- Modes `json_object`, `prompt_only`: the gateway runs `JSON.parse` and `zod.safeParse`. It removes one outer code fence first and nothing else (the SDK parser has no such cleanup: `SDK7/ai/src/generate-text/output.ts`). It never cuts JSON out of free text (`extractJsonObject` has no replacement: `M/enhance.ts:232-246`).
- Retry prompt: "Your last reply was not valid. Problem: `<validatorMessage>`. Return the corrected JSON only." It does not echo the bad answer.

---

### 5.4 Structured-output mode for each provider

The mode comes from the provider, the model and a cache. Every mode ends in the same gate (5.3). `md` = models.dev `structured_output`. Registry lines are in `LLM/registry.ts`. SDK wire facts: `SDK7/openai/src/chat/openai-chat-language-model(-options).ts` (`.chat` sends `response_format: json_schema` with `strict: true`; no schema gives `json_object`), `SDK7/groq/src/groq-chat-language-model.ts` and `SDK7/google/src/google-language-model.ts` (option `structuredOutputs`), `SDK7/anthropic/src/anthropic-language-model.ts` (`structuredOutputMode`), `SDK7/mistral/src/mistral-chat-language-model.ts` (`strictJsonSchema` default false).

| Provider (registry) | First mode (detection) | Lower modes |
|---|---|---|
| `openai` (`:173-177`), `openrouter` (`:220-227`), `vercel` (`:232-239`): all `createOpenAI(...).chat` | `json_schema_strict` (md; for `openrouter`, md of the OpenRouter entry). `vercel` with an unsupported model: UNVERIFIED | `json_object`, `prompt_only` |
| `groq` (`:180-193`) | `json_schema_strict` on the strict list (allowlist in code), else `json_object` | `json_object` (`structuredOutputs: false` drops the schema), `prompt_only` |
| `anthropic` (`:195-199`) | `json_schema` (`output_config.format`) if the SDK model table says so, else `json_tool` (forced tool `json`). UNVERIFIED for models newer than `ai@7.0.143` | `json_tool`, `prompt_only` |
| `google` (`:202-206`), `mistral` (`:209-213`) | `json_schema` (md); `mistral` is not strict | `json_object` (`structuredOutputs: false`), `prompt_only` |
| `server`: `createOpenAI({baseURL, fetch}).chat` (`:245-275`) | `json_schema_strict` (cache of the first 400 per server and model) | `prompt_only`. It skips `json_object`: LM Studio rejects it (`git -C /Users/maheidem/Documents/dev/llm_benchmarks show 48bc3f7`) |

- `server` keeps the custom fetch (Option A, no new package). OpenRouter needs a new fetch wrapper that adds `provider: { require_parameters: true }`. UNVERIFIED: what the API returns when no endpoint qualifies. The errors page (https://openrouter.ai/docs/api-reference/errors) does not cover this case. Its nearest entry is a 503 for a routing requirement that no provider meets. One live call settles it.
- Groq strict `json_schema`: `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `meta-models/muse-spark-open`. Best effort adds `openai/gpt-oss-safeguard-20b`. Others: JSON Object Mode only (https://console.groq.com/docs/structured-outputs). A code constant, UNVERIFIED over time.

**Mode resolution.** (1) Start with the first mode of the row. (2) Read `structured_output` from models.dev (https://github.com/sst/models.dev), cached 6 hours (`L/model-registry.ts:50` holds the TTL, `:53-55` the freshness check, `:71` the cache write; `:64-66` is the fetch call). Extra keys are allowed (`L/model-registry.ts:22`). `false` starts one mode lower. A missing key keeps the first mode. `server` skips this read, and a failed read keeps the first mode with the warning `registry_unavailable` (5.1). (3) If the mode cache has `provider|serverId|modelId`, use it. (4) Send the call. If the provider answers 400 and the body names `response_format`, `json_schema` or `schema`, write the next lower mode to the cache and throw `ProviderError(invalid_request)` with `retry.change = "downgrade_mode"`.

- The cache is in memory. A restart costs one fast 400 per server and model. There is no probe request, so the owner's oMLX gets no extra traffic. The 400 text differs by server and the regex can miss it (UNVERIFIED for all five local server types; R5-3).
- Schema rules for authors: 4.0.3. `assertPortableSchema(zodSchema)` converts with the SDK's own function, `asSchema(zodSchema).jsonSchema` (4.0.3 rule 7), and checks them in a unit test on every step schema. The gateway changes no schema at run time. It adds: no recursion or `$ref` cycle (`ANT/structured-outputs`; a bad `$ref` makes llama.cpp return 400 for every message: `/Users/maheidem/Documents/dev/pi-coder-management/custom-extensions/model-discovery/schema-repair.ts:5-26`). Live proof: section 10 (L6).
- **Degraded modes.** In `json_object` and `prompt_only` the transport does not enforce the shape. The gateway adds to `instructions`: "Return one JSON object that matches this JSON Schema. Return no other text." plus the schema text (4.0.4). `json_object` uses `Output.json()`, `prompt_only` uses `Output.text()`. The record shows the mode.

---

### 5.5 Reasoning profile

A profile says how to disable or bound reasoning for one provider and model (D3). Rules: (1) Send the setting on every call where a documented off switch exists (L2). (2) A hand table keyed by provider and model pattern gives the wire shape, starting from models.dev `reasoning` and `reasoning_options` (https://github.com/sst/models.dev). A hand row wins. (3) The gateway sets `providerOptions` and leaves the v7 top-level `reasoning` unset (5-P5), because a provider setting overrides it without a warning (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/content/docs/08-migration-guides/23-migration-guide-7-0.mdx#L1437-L1443). (4) `correctChunk` and `summarize` ask for off. `identifySpeakers` can ask for a bounded budget (4.3.4). `reasoningSteps` (in `model-profiles.ts`, WP3) is an exported constant of type `Partial<Record<LlmStepId, "bounded">>`. It lists the steps where reasoning may be on. It is `{}` by default, until the section 10 benchmark shows a gain (D12). `resolveCallProfile` gives the plan mode `bounded` when the step is in the table and the table below has a bounded shape for the provider and model. Otherwise it gives `off`. `resolveCallProfile` and `resolveModels` take an optional argument `reasoningSteps` that replaces the table for that call. It is the test hook: LR4, LR6, LP3 and LP7 use it (10.8, 10.12). Production code never passes it.

`resolveCallProfile` puts these facts in `ReasoningPlan` (`countsInMaxOutput` and `maxBudgetTokens` feed the 4.0.5 budget formula). "In limit" means that reasoning tokens use the output limit, so an undersized limit ends in `length` with empty content. An effort-only provider cannot enforce a token bound: its `budgetTokens` is the `maxReasoningTokens` argument, a planning value, and the length route covers an overrun. OpenAI reports reasoning tokens in `usage.outputTokenDetails.reasoningTokens` (UNVERIFIED for Anthropic, Google, Groq and Mistral).

| Provider | Off (default) | Bounded | In limit |
|---|---|---|---|
| OpenAI `.chat` | `providerOptions.openai.reasoningEffort: "none"` if models.dev lists `none`, else the lowest listed; no option if `reasoning: false`. Some models reject `none` (`OAI/reasoning`) | `boundedLevel` low, medium, high | Yes (`OAI/reasoning`) |
| Anthropic | `providerOptions.anthropic.thinking: { type: "disabled" }` | Claude 4.7+: `{ type: "adaptive" }` + `effort`. Earlier: `{ type: "enabled", budgetTokens }`, minimum 1024. A wrong type gives 400 (`ANT/extended-thinking`) | No: the SDK adds the budget on top of `max_tokens` |
| Google | `providerOptions.google.thinkingConfig` (beats generic `reasoning`). Gemini 3: lowest listed `thinkingLevel` (3.1 Pro cannot turn thinking off: send `low`, record the level). Gemini 2.5: `thinkingBudget: 0` where models.dev lists `budget_tokens` with `min` 0 | `thinkingLevel` or `thinkingBudget` | Yes (https://ai.google.dev/gemini-api/docs/thinking) |
| Groq | Existing `groqCleanupProviderOptions` (`LLM/registry.ts:72-97`): `qwen/qwen3-32b` gets `reasoningFormat: "hidden"`, `reasoningEffort: "none"`; `openai/gpt-oss-20b`, `-120b` get `"hidden"`, `"low"` (cannot disable). No rule for `qwen/qwen3.8-27b`: UNVERIFIED until one live call | `reasoningEffort: "medium"` for both families. The branch exists at `LLM/registry.ts:83` and `:91` (the comment at `:68-70` says a task profile or override that sets `reasoningEnabled: true` is the only way to reach it). All four task profiles set `reasoningEnabled: false` (`LLM/task-profiles.ts:84, 91, 98, 113`), so no call reaches it at baseline. It is new only for the meeting caller. Dictation and Remix keep using the function | UNVERIFIED |
| Mistral | `providerOptions.mistral.reasoningEffort: "none"`. The page https://docs.mistral.ai/capabilities/reasoning/ names `mistral-small-latest`, `mistral-medium-3-5` and `mistral-large-4-0` and defines `none`. It does not state that each of these three accepts `none`: UNVERIFIED per model. The SDK enum is `high` or `none` (`SDK7/mistral/src/mistral-chat-language-model-options.ts:85`) and holds no per-model support | `"high"` | UNVERIFIED |
| OpenRouter | Body `reasoning: { effort: "none" }`, written by a fetch wrapper. No top-level `reasoning_effort` is documented (`OR/guides/best-practices/reasoning-tokens`) | `reasoning: { effort }` or `{ max_tokens }`. The reply text is in message field `reasoning` (`reasoning_content` alias) | Yes, on most providers (same page) |
| Vercel AI Gateway | UNVERIFIED. No control is sent | UNVERIFIED | UNVERIFIED |
| `server` (local Qwen) | `chat_template_kwargs.enable_thinking: false`, written by the custom fetch (Option A). `resolveTaskCall` seeds it (`LLM/task-profiles.ts:356-369`); `mergeSamplingIntoBody` writes it last (`LLM/registry.ts:112-143`) | `enable_thinking: true` + `reasoning_effort`, top-level `thinking_budget` (UNVERIFIED for a direct oMLX call) | Yes (`M/summarize.ts:56-63`, `M/enhance.ts:484-490`) |

SDK sources: `SDK7/openai/src/chat/openai-chat-language-model-options.ts`, `SDK7/anthropic/src/anthropic-language-model.ts`, `SDK7/google/src/google-language-model.ts`, `SDK7/mistral/src/mistral-chat-language-model-options.ts`.

#### 5.5.1 Local Qwen through the custom fetch (Option A)

`createOpenAI().chat` drops `chat_template_kwargs` from `providerOptions`, so the custom fetch writes it into the body (`LLM/registry.ts:99-111`). The reasoning text is `message.reasoning_content`; the SDK does not read it (`L/trace.ts:184-204`). The wrapper treats `max_tokens` as a floor, so a limit raised by the length route reaches the wire (`LLM/registry.ts:127-138`).

#### 5.5.2 Precedence

Rank 1, the gateway: `response_format`, `model`, `messages`, a plan with `force: true`, a raised `max_tokens`. Rank 2, the user preset or custom object: `temperature`, `top_k`, `chat_template_kwargs` (verbatim for `server`; only `temperature`, `top_p`, `max_tokens` for cloud). Rank 3, the task profile seed: `enable_thinking` from `reasoningEnabled`. Rank 4, SDK defaults.

- Today the wrapper spreads preset keys last (`LLM/registry.ts:125`), so a preset beats the seed (`LLM/task-profiles.ts:361-367`). Rank 1 needs a second pass after that merge: `mergeSamplingIntoBody` gets a third argument `gatewayOverrides`. It has two parts. The part `force` holds keys that always win. The part `bounded` holds keys that win over the seed but not over a key that the preset sets. A preset can enable reasoning for `meetingEnhance` and wins, as today. The ledger holds the warning "reasoning on by preset" (open point N5, 4.7).
- **Bounded plan.** A plan with mode `bounded` writes `chat_template_kwargs.enable_thinking: true` and the top-level `thinking_budget` with `plan.budgetTokens`. It writes them at rank 1, as `force` does, with one exception: a key that the preset sets keeps the preset value. These two keys form the `bounded` part of `gatewayOverrides`. If the preset sets one of them, the ledger holds a warning that names the key ("reasoning plan overridden by preset: enable_thinking"), as N5 does. The node then uses the effective setting for `reasoningShare` (4.2.5). Where the server reads `thinking_budget` is UNVERIFIED for a direct oMLX call (4.3.4): probes LP3 and LP7 settle it (10.12). A cloud provider has no preset reasoning key (below), so its bounded plan goes through `providerOptions` only (table above).
- `force: true` is for the length route only. It sets `chat_template_kwargs.enable_thinking` to false and removes `chat_template_kwargs.reasoning_effort` and the top-level `reasoning_effort` and `thinking_budget`. Cloud providers never get a preset reasoning key: their `samplingParams` is empty (`LLM/task-profiles.ts:369`).

#### 5.5.3 Preset denylist

Add these keys to a new set `LLM_MEETING_DENYLIST_KEYS` in `V/llm-task-profiles.ts`. Do not add them to `LLM_PRESET_DENYLIST_KEYS` (lines 199-206: `model`, `messages`, `stream`, `tools`, `tool_choice`, `n`). `resolveTaskCall` strips the old set for every task and the new set only for `meetingEnhance` and `meetingSummarize`. Today it strips the old set for every task id (`LLM/task-profiles.ts:249`, `:345`), so a change to the old set would also change dictation cleanup and Remix (1.3). The preset editor takes raw JSON, so a user can type any key. A denied key is dropped at resolve time and shown in the ledger `dropped` with reason `denylist`. Test W2b: a cleanup preset with `stop` still reaches the wire.

- `response_format`: the wrapper spreads preset keys last, so a preset value would replace the SDK schema (`LLM/registry.ts:125`).
- `stop`: a stop sequence ends the answer with finish reason `stop` and can cut the JSON. The gate would see a clean reason.
- `guided_json`, `guided_regex`, `guided_choice`, `guided_grammar`, `structured_outputs`, `grammar`, `json_schema`: these also constrain output on some servers and would fight the gateway schema. The names come from vLLM and llama.cpp style APIs. The list for other servers is UNVERIFIED.

Section 10 tests `response_format`, `stop` and `guided_json` with a live call.

---

### 5.6 Retries

One retry layer is planned: `callUnit` in `W/unit.ts` (new file, WP5a, 11.5). `callUnit`, `callStructured` and `W/unit.ts` do not exist at `c47cd80d`, and no LLM call sets `maxRetries` there (5.0). Every LLM node calls `callUnit` for every call (D5, L3). The AI SDK runs with `maxRetries: 0`. `callStructured` retries 0 times. The length route (4.0.6) changes the input and is not a retry.

**Why not a node `RetryPolicy`.** LangGraph retries a whole node function (https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance). An LLM node makes many calls in one run: up to 11 for a split chunk (4.0.6) and up to 24 for `summarize` (4.5.3). A node retry would send the finished calls again. The first unit that fails would also use the one retry of the node, and a second unit with a retryable error would throw on the last attempt and stop the run. So the unit is the retry boundary (X7, Q9).

The LangGraph default `retryOn` is not enough either (source `LGJS/langgraph-core/src/pregel/retry.ts`). It skips abort errors and HTTP 400 to 407 and 409, and reads `error.response.status`, then `error.status`. The AI SDK `APICallError` has `statusCode`, so a 4xx can be retried (UNVERIFIED by a run, D5). It also retries a `TypeError` from a bug.

```ts
// W/unit.ts (planned, WP5a; absent at c47cd80d). No LangGraph import (3.1).
export function gatewayRetryOn(error: unknown): boolean { // the one retry rule
  return error instanceof GatewayError && error.retry !== null; // anything else is a bug: fail at once
}
export type UnitDeps = Pick<WorkflowDeps, "recorder" | "callStructured" | "createModel" | "sleep">; // W/context.ts (3.4.2)
export type UnitInput<T> = Omit<CallStructuredInput<T>, "sink" | "stopped" | "retry" | "createModel">; // the node sets the rest; `callUnit` sets these four
export async function callUnit<T>(input: UnitInput<T>, ctx: RunContext, deps: UnitDeps): Promise<CallStructuredResult<T>> {
  const done = deps.recorder.finishedCall(input.runId, input.unitKey); // a ParsedCall (7.7) or null, after a resume
  const reused = done && resultFromParsedCall(done, input.schema.zod); // null when the schema rejects the stored object
  if (reused) return reused;
  const call = { ...input, sink: deps.recorder, createModel: deps.createModel,
    stopped: () => ctx.isStopped() }; // the gateway checks `stopped` when the lease opens (5.1 step 4)
  try { return await deps.callStructured(call); }
  catch (e) {
    if (!gatewayRetryOn(e) || ctx.isStopped()) throw e;
    await deps.sleep(e.retry.waitMs, ctx.signal); // before the lane lease. An abort ends the wait with CancelledError
    return deps.callStructured({ ...call, retry: { kind: e.kind, change: e.retry.change,
      validatorMessage: e instanceof SchemaError ? e.validatorMessage : undefined } }); // a second failure is final
  }
}
```

`callUnit` reads no module-level state. Its only effects come from `deps`, so a test replaces the recorder, the gateway, the model and the wait one by one (3.4.2, 10.2).

Goal G5: a transient error gives 2 requests, `content-filter` 1, an auth error 1, an invalid schema 2. `waitMs` is the advice of 5.2.1 (at most 60 000 ms, jitter included). `sleep` is injectable (`WorkflowDeps.sleep`, WP5a), so a test passes an instant `sleep` or advances fake timers (10.2 rule 4). The retry carries its change in `retry`, so no memo and no shared map exist.

**Call reuse.** `recorder.finishedCall(runId, unitKey)` returns a `ParsedCall` (7.7): the newest `llm_calls` row of that unit key with `error_kind` NULL, a whole `parsed_json` (no cut marker, 7.7 rule 6), a `finish_raw` and a `params_json` that parses. Otherwise it returns `null`. `resultFromParsedCall` parses `ParsedCall.parsed` with the schema again and builds the `CallStructuredResult`: `finishReason` is `"stop"`, `paramsLedger` is `params`, `structuredMode` is `params.structuredMode`, and the other fields copy across. It returns `null` when the schema rejects the object. `callUnit` then sends no request and writes no row. The result keeps the old `callId` and `attempt`. A reused call is safe only for the same input, which the key grammar and the state give (4.0.7). After a kill, a restarted node sends 0 requests for a finished call (G6). A failed call is not reused, so a resumed split unit repeats its first call once. A lost record (7.7) costs one repeated call.

**Rules for nodes** (sections 3 and 4 follow them).

1. Every LLM call goes through `callUnit`. No node sets `retryPolicy` or `timeout` (3.2 edge rule 7, 5.7).
2. A node catches every error of `callUnit`. A final `GatewayError` becomes a typed `NodeFailure` of the unit, and the node does not throw (3.2 edge rule 5). `CancelledError` becomes kind `cancelled`, or unit status `skipped` when `ctx.isStopped()` is true and `ctx.signal` is not aborted. A final failure with `runWide` calls `ctx.stopRun` (3.4.5).
3. No error leaves a node. `guardNode` (4.0.2) catches the rest. An error that escapes a fan-out node aborts its sibling tasks and stops the run (`LGJS/langgraph-core/src/pregel/runner.ts`).
4. A node catches `LengthError` first, and `ReasoningLeakError` when reasoning was on, and runs the length route (4.0.6) with changed input. Each of those calls goes through `callUnit` and gets its own retry.

---

### 5.7 Timeouts, cancel and lanes

- Timeouts: `meeting_enhance_timeout_seconds` (`correctChunk`, `identifySpeakers`) and `meeting_summary_timeout_seconds` (`summarize`), default 600 s, range 30 to 3600 s. `taskTimeoutMs` reads the setting for each call (`LLM/task-profiles.ts:154-164`; bounds `V/settings.ts:318-320`, `:400-402`). The timeout starts when the lane lease opens, so queue time does not count (`M/llm-call.ts:126-153`). A LangGraph node `timeout` would count it, so the nodes set none.
- The gateway makes `timeoutSignal = AbortSignal.timeout(timeoutMs)` and `AbortSignal.any([signal, timeoutSignal])` (https://nodejs.org/docs/latest-v22.x/api/globals.html). After an abort it checks `signal.aborted` first. If `signal.reason.name` is `TimeoutError`, the caller's deadline fired (the Summarize job ceiling, 3.4.5) and the gateway throws `DeadlineExceededError`. Any other reason gives `CancelledError`. If only `timeoutSignal` fired, it throws `ProviderError` `timeout`. Check of 2026-10-17, Node 26.5.0: `AbortSignal.any` keeps the reason of the first signal that fires (`TimeoutError` for `AbortSignal.timeout`, the value given to `abort()` otherwise). UNVERIFIED on Node 22.22.1. A retry waits the full timeout again (5-P2). Today's ceiling is `clamp(perCallMs x plannedCalls, 2 x perCallMs, 4 h)` (`M/summarize.ts:128-154`). The workflow doubles the middle term for one retry for each call (X8, 4.5.3).
- **Cancel.** Today cancel is a polled flag that stops a queued call. An in-flight call finishes (`M/job-registry.ts:58-61`). Section 3 aborts the run context signal `ctx.signal` on user cancel (3.4.5), so an in-flight request stops at the client. This changes visible behavior. Whether oMLX then stops generating is UNVERIFIED. A queued call stops through the lane `signal` option, which makes the lane throw `LlmLaneCancelledError`. The class is at `LLM/lane.ts:58-63`. The throw sites are `LLM/lane.ts:357`, `:361`, `:426` and `:460`. The `cancelled()` check reads the signal at `:412` and throws nothing itself. The gateway turns that error into `CancelledError` phase `queued`.
- **Lanes.** Every workflow call takes a `background` lease. The lane rules are in 3.5. The lease covers the wire call only. The fan-out cap of `correctChunk` is `WORKFLOW_FANOUT_CAP` (3.5 rule 2).
- **Boot probe.** `probeEndpoint(profile, opts?)` lives in `gateway.ts` (WP3). Its test is W15 (10.5.2). The runner reaches it through `WorkflowDeps.probeEndpoint` (3.4.2) and calls it before a boot resume (3.4.7). `opts` holds `fetch` and `timeoutMs`, for tests. The probe sends one request with a 3 s limit (`AbortSignal.timeout(3000)`) and no API key. Any HTTP status passes, because an answer proves that the endpoint is reachable. A network error or the timeout gives false.
  - A `server` profile: `GET <base>/models`. The base comes from the server entry, built as the registry builds it: `base_url` without a final `/v1` (`LLM/registry.ts:257`), then `/v1` added in `createOpenAI` (`LLM/registry.ts:267`). It is the request of `LT:229` (`.claude/skills/live-testing/SKILL.md:229`, the `curl` on `/v1/models`), which 10.12 uses.
  - A cloud profile: `HEAD` on the base URL of the provider (table below).
  - The probe tests the network only. A missing server entry or a missing API key returns true. The resumed run then fails with the typed `model_unavailable` (5.2.1) at its first call, and the boot resume does not wait without an end.

  | Provider | Base URL for the probe | Source |
  |---|---|---|
  | `openai` | `https://api.openai.com/v1` | SDK default (https://unpkg.com/@ai-sdk/openai@3.0.65/dist/index.mjs, line 6940) |
  | `anthropic` | `https://api.anthropic.com/v1` | SDK default (https://unpkg.com/@ai-sdk/anthropic@3.0.79/dist/index.mjs, line 5789) |
  | `google` | `https://generativelanguage.googleapis.com/v1beta` | SDK default (https://unpkg.com/@ai-sdk/google@3.0.79/dist/index.mjs, line 6017) |
  | `mistral` | `https://api.mistral.ai/v1` | SDK default (https://unpkg.com/@ai-sdk/mistral@3.0.37/dist/index.mjs, line 843) |
  | `groq` | `https://api.groq.com/openai/v1` | SDK default (https://unpkg.com/@ai-sdk/groq@3.0.39/dist/index.mjs, line 994); the app uses it at `S/lib/groq-http.ts:50` |
  | `openrouter` | `https://openrouter.ai/api/v1` | `LLM/registry.ts:225` |
  | `vercel` | `https://ai-gateway.vercel.sh/v1` | `LLM/registry.ts:237` |

  The five SDK lines were read in the pnpm store of the main checkout (the major 3 provider packages of the v6 generation). The v7 provider packages (the major 4 packages of 6.3) are UNVERIFIED: WP3 reads their defaults before it writes the table. The table is a constant in `gateway.ts`. A provider that is not in the table returns true.

  **Why a cloud probe.** After a reboot with no network yet, a resumed cloud run fails every unit with `provider_unavailable`. A final unit failure is stored as a result in the graph state, so the run reaches `save`, ends, and the runner deletes its checkpoint (3.4.6 step 5). A later check could not undo that: the finished run has no node left to resume. So the guard must come before the resume (3.4.7).

---

### 5.8 Privacy

The prompts hold the meeting text. Instructions, messages, raw answer text, the parsed object, `requestBodyValues` and `responseBody` of an `APICallError`, and the param ledger go to the local record `llm_calls` only (section 7). They never go to a log, error message, trace log or URL. The record, the app log and the UI may hold: error kind, step, unit key, call id, status code, token counts, finish reasons, latency. A call record is deleted with its meeting (D10).

- Telemetry: v7 spans hold inputs and outputs by default once an integration is registered (`AI/ai-sdk-core/telemetry`). Nothing is registered until a user sets an endpoint (D8). Prompt text in spans: 9.7 and Q9.2.
- Gap: for `server`, the trace log writes full request and response bodies to `openstyle-trace.log`, always on (`L/trace.ts:10`, `:46-48`, `LLM/registry.ts:265-274`). The gateway does not change it (5-Q1).
- Cloud providers receive the prompt by design. `attendeeNames` does not reach the prompt (`M/enhance.ts:99-104`; rule in 4.0.4). Limit: a confirmed speaker name does reach it. The path has six steps. (1) `resolveSpeakerNames` attaches the confirmed name to the segment (`M/speaker-names.ts:49`). (2) `speakerDisplayLabel` gives that name priority over the numbered label (`M/merge.ts:366-370`). (3) `loadMergedTranscript` builds the segments (`S/routes/meetings.ts:253-307`) and the auto-run job and the manual route call it (`:1089`, `:2114`). (4) Enhance sets the segment speaker with `speakerDisplayLabel` (`M/enhance.ts:387-396`, call at `:391`). (5) `formatChunk` (`M/enhance.ts:219-223`) calls `formatEnhanceLine`, which writes the name into the prompt line (`M/enhance-prompt.ts:119-125`). (6) The user prompt holds the chunk (`M/enhance.ts:500`). The attendee picker suggests attendee names for that field (`E/renderer/src/pages/meetings/speakers.tsx:165`, `:312-318`). So an attendee name can reach a cloud provider after the user confirms it.

---

### 5.9 Proof the gateway needs

Unit tests with a fake model are not enough (L6). Section 10 owns the plan. The gateway needs at least these checks against real systems. The owner's oMLX takes only Qwen3.8-27B requests. Local runs use `scripts/test-runner/run.sh`.

| # | Check | Pass when |
|---|---|---|
| 1 | A fake HTTP server returns each of the six unified finish reasons with valid JSON | Five reasons raise the typed errors of 5.2.1. `stop` returns the object. Goal G2 |
| 2 | Live call to Qwen3.8-27B with `maxOutputTokens: 16` | `LengthError`; `rawFinishReason` is `length`; the ledger shows `max_tokens` |
| 3 | Live call with reasoning off; read the body back from the trace log | Body holds `chat_template_kwargs.enable_thinking: false` and `response_format`. Ledger equals body. Goal G8 |
| 4 | A fake server counts requests for HTTP 503, `content-filter`, HTTP 401, invalid JSON | 2, 1, 1 and 2 requests. Goal G5. SDK `maxRetries` is 0 |
| 5 | A preset with `response_format`, `stop`, `guided_json` assigned to `meetingEnhance` | Ledger lists the three keys as `dropped`. The wire body keeps the SDK `response_format` |
| 6 | A fake server that answers 400 for `response_format` | The mode cache drops to `prompt_only`. The next call succeeds. A restart relearns it |
| 7 | One live call per cloud provider the owner uses (needs test keys: 5-Q2) | Served id passes `modelMatches`. Raw reason is in the alias table |
| 8 | Cancel during a queued call and during an in-flight call | `CancelledError` phase `queued` and `in_flight`. No failure in the UI |
| 9 | Read the call record back from the database after each check | All D10 fields present (goal G7). A write that returned success may have stored nothing |

---

### 5.10 Proposals, risks and open points

Design choices of this section. D1 to D12 do not settle them.

| ID | Proposal | Reason |
|---|---|---|
| 5-P1 | Each call gets at most one retry. | Goal G5, D4 |
| 5-P2 | `provider_timeout` is retried once for cloud providers, never for `server`. | A retry doubles the wait. The user can raise the timeout. |
| 5-P3 | A `Retry-After` above 60 s gives no retry. | Waiting minutes holds the run with no gain. |
| 5-P4 | The `modelMatches` rule (5.3.4). | Cloud ids carry date suffixes. |
| 5-P5 | `providerOptions` set by the gateway. The v7 top-level `reasoning` stays unset. | The ledger shows exact wire values (D3). |
| 5-P6 | `ReasoningLeakError` with reasoning off is not retried. | A repeat gives the same result. |

| ID | Question for the owner |
|---|---|
| 5-Q1 | Keep the always-on full-body trace log for `server`? It holds all prompts and answers. The server never reads `advanced_mode` (no use in `S`); only the renderer does (`E/renderer/src/shell.tsx:179`). 9.4 keeps the log unchanged; the owner can overrule. |
| 5-Q2 | Does the owner supply test keys for cloud providers, so check 7 can run? Without keys the cloud rows stay UNVERIFIED. |
| 5-Q3 | Disable `model_fallback` on the owner's oMLX for the proof? Otherwise a silent swap may not show in `model`. |

| ID | Risk | Mitigation |
|---|---|---|
| R5-1 | The alias table rejects a valid answer: a provider sends a raw value the table lacks. | The record shows the raw value. One retry runs. A reviewer adds the value. Checks 2 and 7 cover each provider in use. |
| R5-2 | `modelMatches` fails a good call. | 5-P4. The live proof records served ids first. |
| R5-3 | A 400 text for an unsupported schema does not match the regex. | The error stays visible as `provider_invalid_request`. The inspector shows the text. |
| R5-4 | A preset enables reasoning for `meetingEnhance`, and the call needs more output tokens than computed. | Ledger warning. The length route handles `length`. |
| R5-5 | oMLX does not enforce the strict schema (it ignores a forced tool call: peer report `/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/omlx-structured-output-peer-finding.md`, not verified here), or does not stop at the limit. | The gate parses every answer. Section 10 probes it with a live call. |

**Alignment with other sections (applied).** D5 names a custom `retryOn`. `gatewayRetryOn` is that rule, and `callUnit` runs it for each unit as the one retry layer (Q9). 3.2 edge rule 7, Decision (9) of section 3 and 4.0.2 follow 5.6. The gateway strips one outer code fence in `json_object` and `prompt_only`, nowhere else (5.3.5). 7.5 holds `capturedFrom` and `warnings` (5.1). Section 7 stores unknown token counts as NULL, as 5.1 does. The step key is the `unitKey` (7.4, 11.4).

---

## 6. AI SDK v7 migration

Owner decision D7: move the repo from `ai` 6.0.191 to `ai` 7.0.143 for all code (cleanup, Remix, meetings, transcription). Sections 4 and 5 use v7 APIs. "The package" is this migration work package (one PR). Path key: `S` = `apps/server/src`, `E` = `apps/electron/src`, `T` = `apps/server/tests`, `STT` = `packages/stt`, `CI` = `.github/workflows/build.yml`. VERIFIED = read or run on 2026-10-17. UNVERIFIED = the package must check it. URL keys: 6.12. A bare ref such as `:2890` or `:39` takes the file named earlier in the same row or sentence (example: 6.2, first bullet, `pnpm-lock.yaml` then `:2890`).

### 6.1 Decision and rules

| Rule | Text |
|---|---|
| M1 | The package ships first, as one PR (WP1, 11.2). No node, gateway or inspector code lands before it. A bump bug and a gateway bug must not mix. |
| M2 | It changes no behavior: only versions, renamed or removed names, and test mocks. |
| M3 | It adds no dependency (`@ai-sdk/otel`: section 9; `@ai-sdk/openai-compatible`: section 5). The knip step flags unused dependencies (`knip.jsonc:4-5`; `CI:91-100`). |
| M4 | It does not use `Output`, `maxRetries`, `reasoning`, `rawFinishReason` or telemetry (sections 5, 9). |
| M5 | The lock file holds one `ai` version after the package (6.7). |
| M6 | Proof: wire-body tests plus a real-app run of dictation cleanup (6.9). |
| M7 | A proof that differs from the baseline stops the package. The coordinator decides. Nobody edits a golden file to pass a test. |

### 6.2 Current state (baseline c47cd80d)

- The lock file holds two `ai` copies: 6.0.191 (`pnpm-lock.yaml:91-93, 242-244, 315-317`) and 6.0.240 (`:2890, :7356`; `@ai-sdk/react@3.0.242` needs it, `:5204-5207`). The stt dev dependency on `ai` `^6.0.191` (`STT/package.json:53`) resolves to 6.0.191 (`pnpm-lock.yaml:315-317`). From which folder the bundler resolves `ai` for the stt `dist` code is UNVERIFIED: stt has no pkgroll config file, and its `build` script is `pkgroll --minify --clean-dist` (`STT/package.json:31`).
- The app sets no SDK `maxRetries` and uses no `Output`, `generateObject`, `streamObject`, telemetry or `onFinish` on SDK text calls (grep). The default of 2 retries applies to every call.
- **Silent failure path.** The stt `postProcess` catches every model-call error (`STT/src/post-process.ts:124`, `catch` `:168-177`) and returns the raw transcript with `model: null`. The server logs `LLM cleanup failed` and goes on (`S/lib/post-process.ts:261-263`). So an SDK incompatibility stops cleanup with no visible error. The proof in 6.9 relies on this.

### 6.3 Target versions

Each target is the npm `latest` tag on 2026-10-17 (VERIFIED: `dist-tags.latest` in `NPM <package>`; scoped names use `%2F`).

| Package | Resolved today (`pnpm-lock.yaml:362-434`) | Target |
|---|---|---|
| `ai` | 6.0.191, 6.0.240 | **7.0.143** |
| `@ai-sdk/openai`, `anthropic`, `google` | 3.0.65, 3.0.79, 3.0.79 | **4.0.96**, **4.0.82**, **4.0.99** |
| `@ai-sdk/groq`, `mistral`, `elevenlabs` | 3.0.39, 3.0.37, 2.0.33 | **4.0.63**, **4.0.66**, **3.0.63** |
| `@ai-sdk/react` | 3.0.242 | **4.0.147** |
| `@ai-sdk/provider-utils` | 4.0.27, 4.0.41 | **5.0.62** |
| `@ai-sdk/provider`, `gateway` (transitive) | 3.0.10, 3.0.14; 3.0.120, 3.0.162 | **4.0.29**, **4.0.116** |

`NPM ai/7.0.143` (VERIFIED): Node 22 or later; exact dependencies `gateway` 4.0.116, `provider` 4.0.29, `provider-utils` 5.0.62. `@ai-sdk/react@4.0.147` pins `ai` 7.0.143 and `@ai-sdk/mcp` 2.0.78 (`NPM @ai-sdk%2Freact/4.0.147`); 3.0.242 has no `@ai-sdk/mcp` (`pnpm-lock.yaml:5204-5210`).

Pin rules (proposal):
- P1. Pin `ai`, `@ai-sdk/react` and `@ai-sdk/provider-utils` to exact versions, with no caret. A caret lets `pnpm update` split the copies and hides behavior changes (6.8 row 1).
- P2. Put them in the pnpm catalog (`pnpm-workspace.yaml:16-25`). The three manifests use `catalog:`.
- P3. The stt peers become `ai ^7.0.0` and `@ai-sdk/provider-utils ^5.0.0`.
- P4. The exact `ai` pin of `@ai-sdk/react` equals the catalog `ai` version.

```yaml
# pnpm-workspace.yaml (add to the catalog, lines 16-25)
catalog:
  "ai": "7.0.143"
  "@ai-sdk/react": "4.0.147"
  "@ai-sdk/provider-utils": "5.0.62"
```

### 6.4 Per-file checklist

Kinds: required (build or run breaks), rename, type (type-check proves it), test, none (no change; proof covers it). Do not run the codemod `npx @ai-sdk/codemod v7` (`GUIDE`): it runs downloaded code, and its `rename-on-finish-to-on-end` could change `useChat` `onFinish`, which v7 keeps (`GH7 ai/src/ui/chat.ts#L233`). `RC` = `E/renderer/src/components/remix-chat.tsx`. `REG` = `S/lib/llm/registry.ts`.

| # | File and lines | Kind: change and evidence |
|---|---|---|
| 1 | `STT/package.json:47-48, 51, 53` | required: peers `^5.0.0`, `^7.0.0`; dev uses catalog (P2, P3) |
| 2 | `apps/server/package.json:26-31, 36` | required: exact targets of 6.3; `ai` uses catalog |
| 3 | `apps/electron/package.json:34, 42` | required: both use catalog |
| 4 | `pnpm-workspace.yaml:16-25` | proposal: add 3 catalog entries (P2). If Q-A is no, rows 1-3 pin the same exact versions |
| 5 | `pnpm-lock.yaml` | required: `pnpm install`; run the check in 6.7 |
| 6 | `STT/src/post-process.ts:127` | rename: `system:` to `instructions:`; v7 reads both (`GH7 ai/src/generate-text/generate-text.ts#L243-L244`). Keep `PostProcessParams.system` (`:39`), line 148 (the `length` decision) and line 151 (reads `result.finishReason` for the error text) |
| 7 | `STT/src/transcribe.ts:3, 41` | rename: `experimental_transcribe as aiTranscribe` to `transcribe as aiTranscribe`. 6.0.191 has no value `transcribe` (`GH6 ai/src/transcribe/index.ts#L1-L2`); v7 has (`GH7 ai/src/transcribe/index.ts#L5`) |
| 8 | `STT/src/post-process.test.ts:4-26` | test: v3 fake. Keep green first (v7 accepts v3), then use `MockLanguageModelV4` from `ai/test` (`UNPKG ai@7.0.143/dist/test/index.d.ts`) |
| 9 | `REG:1, 75` | rename: `GroqLanguageModelOptions` to `GroqLanguageModelChatOptions` |
| 10 | `REG:204-205` | rename: `createGoogleGenerativeAI` to `createGoogle` |
| 11-14, 17, 19-21, 26, 28 | `REG:156-203, 206-277`; `S/lib/groq-http.ts:1-2, 31-34`; `S/lib/providers.ts:1`; `S/lib/remix-agent.ts:123`; `S/lib/streaming/utils.ts:3, 9-11, 43, 49`; `S/lib/streaming/providers/openai.ts:2, 26`, `groq.ts:1, 13`, `elevenlabs.ts:2, 121-125`; `S/lib/post-process.ts:228`; `S/lib/meetings/llm-call.ts:136`; `RC:1, 10-11, 13, 15-18, 258-270, 376-388, 391-398`; `T/llm-task-profiles.test.ts:493-560`; `T/server-provider.test.ts:238-255`; `T/trace.test.ts:299-340` | none or type: no edit. The `.chat(...)` calls and the sampling fetch (6.8 row 6) stay. `toUIMessageStreamResponse` stays: deprecated, works with a warning (`GUIDE`). `useChat` stays (the guide has no React section). The helper `addToolResult` is not in this group: row 25 renames it (`RC:375, 389`). Four line sets are not in this group. Row 10 owns `REG:204-205`. Row 24 owns `RC:12`. Row 23 owns `RC:14`. Rows 25 and 24 own `RC:389-390`. Type-check, the canary tests (real SDK, `fetch` spy), the wire tests and proof B cover them |
| 15 | `S/lib/remix-transform.ts:132-144` | rename: `system` (`:137`) to `instructions` |
| 16 | `S/lib/remix-agent.ts:9, 108, 111` | rename: `stepCountIs` to `isStepCount`; `system` to `instructions` |
| 18 | `S/lib/llm/lane.ts:526` | rename: update the comment that names `stepCountIs` |
| 22 | `apps/server/scripts/benchmark-post-process.ts:5, 164-171`; `tone-benchmark.ts:31, 377-384` | rename: `system:` to `instructions:` |
| 23 | `RC:14, 418, 959, 996` | required: `isToolOrDynamicToolUIPart` to `isToolUIPart`. v7 removed the old name (`GUIDE`); 6.0.191 has the new one (`GH6 ai/src/ui/ui-messages.ts#L478-L487`). Do it before the bump |
| 24 | `RC:12, 390, 960, 1111, 1147` | rename: `getToolOrDynamicToolName` to `getToolName` (`GH7 ai/src/ui/ui-messages.ts#L689-L698`). Before the bump |
| 25 | `RC:375, 389` | rename: `addToolResult` to `addToolOutput`. It exists in `@ai-sdk/react` 3.0.242 (`R3 react/src/use-chat.ts#L187-L190`). `@ai-sdk/react` 4.0.147 keeps `addToolResult` as a deprecated alias of `addToolOutput` (`GH7 react/src/use-chat.ts#L362-L366`; the GH7 commit holds `@ai-sdk/react` 4.0.147, `GH7 react/package.json#L3`). Before the bump |
| 27 | `T/openai-cloud-provider.test.ts:11-21` | test: mock `transcribe`, not `experimental_transcribe` (row 7) |
| 29 | `T/ai-sdk-wire.test.ts` (new) | test: wire-body tests (6.9.2) |

### 6.5 Renames and API facts

Rename evidence is in the 6.4 rows. Other API facts are in 6.8 rows 4 and 6, and in 6.11 U6-3.

### 6.6 Module format

The app ships CJS bundles. v7 is ESM only. The bundler joins them.

- F1 (VERIFIED). `ai` 7.0.143, the six providers and `@ai-sdk/react` 4.0.147 are ESM only (`"type": "module"`, no `require` export condition; `NPM ai/7.0.143`, `GUIDE`). The repo meets the Node 22 need (`package.json:26`; Electron 39.8.10 ships Node 22.22.1, `EL`).
- F2 (VERIFIED). Main, preload and the server process are CJS bundles: electron-vite 5.0.0 picks ESM only if `type` is `module` (`dist/chunks/lib-q6ns0vZr.js:284, 390`), and `apps/electron/package.json` has no `type`. The main and preload builds set `externalizeDeps: false` (`apps/electron/electron.vite.config.ts:75, 96`), so the bundler inlines their dependencies. Only `electron`, `bufferutil` and `utf-8-validate` stay external (`apps/electron/electron.vite.config.ts:84`). So the app loads no `ai` at runtime. The server source is ESM (`apps/server/package.json:3`). The `server-process` entry (`apps/electron/electron.vite.config.ts:82`; `apps/electron/src/server-host/entry.ts:16`) bundles it into `out/main/server-process.js`. That file is CJS (local main-checkout build: first line `"use strict"`, many `require(` calls).
- F3 (VERIFIED). The v6 bundle holds one `ai` copy: one `"6.0.191"` string and one `AI_NoObjectGeneratedError` in `server-process.js` (local main build).
- F4 (UNVERIFIED). A real `electron-vite` build with v7 works and the asar stays near 9 MiB (`AGENTS.md:87`). See 6.9.5.
- F5 (UNVERIFIED). `check-bundled-requires.mjs` stays green. It matches only literal `require("x")` in top-level files, not `out/main/chunks` (`apps/electron/scripts/check-bundled-requires.mjs:24, 26, 34`).
- F6 (UNVERIFIED). The stt `require` entry loads. `STT/package.json:21, 40-43` point it to `dist/index.cjs`, which calls `require("ai")`, and `ai` 7 has no `require` entry. No repo code requires stt, and stt is not on npm (`NPM @openstyle%2Fstt` is 404). The stt `exports` point only to `dist` (`STT/package.json:34-45`), and the electron-vite config does not alias stt to its source (`apps/electron/electron.vite.config.ts:8-13`). So the bundler reads stt `dist`. The `dist` folder exists because turbo `build` runs `^build` first (`turbo.json:20-21`) and the server depends on stt (`apps/server/package.json:35`). CI builds the server this way at `CI:170`. Which entry (`import` or `require`) the bundler picks is UNVERIFIED. See Q-B.
- F7 (UNVERIFIED). vitest 4 loads the ESM-only packages. The first test run answers it.

### 6.7 Mixed copies of `ai` (the trap)

```mermaid
flowchart LR
  subgraph today["Today: two ai copies"]
    stt["stt dist"] --> a191["ai 6.0.191"]
    srv["server"] --> a191
    rnd["renderer code"] --> a191
    rct["@ai-sdk/react 3.0.242"] --> a240["ai 6.0.240"]
  end
  subgraph target["Target: one ai copy"]
    stt2["stt dist"] --> a7["ai 7.0.143"]
    srv2["server"] --> a7
    rnd2["renderer code"] --> a7
    rct2["@ai-sdk/react 4.0.147"] --> a7
  end
```

- A v7 model in a v6 `generateText` throws `UnsupportedModelVersionError` (v6 accepts only specification v3 and v2; `GH6 ai/src/model/resolve-model.ts#L29-L37`). The stt `try` starts at `STT/src/post-process.ts:124`. Its `catch` (`:168-176`) has no type check, so it catches every error, including this one, and returns the raw text (`:171-176`). So dictation still pastes the raw text, a mock-model unit test passes, and only the token count and the log show the fault.
- A v3 model in a v7 `generateText` runs through an adapter (`GH7 ai/src/model/resolve-model.ts#L40-L49`). Two v7 copies work but double the bundle code.

Rules:
- T1. All three manifests take `ai` from the catalog (P2). One exact version.
- T2. `@ai-sdk/react` has the `ai` pin that equals the catalog version (P4).
- T3. After `pnpm install`, this check passes:

```bash
grep -nE "^  (ai|'@ai-sdk/[a-z-]+)@[0-9]" pnpm-lock.yaml
# Expected keys (UNVERIFIED until the install runs): the 6.3 targets plus '@ai-sdk/mcp@2.0.78'.
# Each key can print twice (`packages:` and `snapshots:`). Explain any other key in the PR.
```

The package does not merge while a second `ai` version is in the output.

### 6.8 Behavior changes that matter

| Row | Change | 6.0.191 | 7.0.143 | Effect |
|---|---|---|---|---|
| 1 | Output parse when finish reason is not `stop` | only on `stop` (`GH6 ai/src/generate-text/generate-text.ts#L1210-L1212`) | also when the reason is not `tool-calls` and text is not empty (`GH7 ai/src/generate-text/generate-text.ts#L1614-L1619`) | None here: the app passes no `output`. Section 5 checks the finish reason first (D4) |
| 2 | Default `maxRetries` | 2 (`GH6 ai/src/util/prepare-retries.ts#L38`) | 2 (`GH7 ai/src/util/prepare-retries.ts#L15`); initial delay 2000 ms, factor 2 (`GH7 ai/src/util/retry-with-exponential-backoff.ts#L67-L68`). A `retry-after-ms` or `retry-after` header of 0 to 60 s can change the wait (`GH7 ai/src/util/retry-with-exponential-backoff.ts#L47-L55`) | None here. Section 5 sets `maxRetries: 0` (D5) |
| 3 | System-role messages in `messages` | accepted | rejected by default (`GUIDE`) | The Remix agent passes client messages through (`S/lib/remix-agent.ts:109`; `packages/validations/src/remix.ts:114`). A `system` message now fails the request. Old stored threads: UNVERIFIED (U6-7) |
| 4-5 | OpenAI Responses default `reasoningSummary`; `usage` | not set; last step | `detailed` only when `reasoning` or `providerOptions.openai.reasoningEffort` is not `'none'`; sums all steps (`GUIDE`) | None: the registry always uses `.chat` (`REG:176`), while a call without `.chat` uses the Responses API (`GH7 openai/src/openai-provider.ts#L323-L334`); cleanup and quick edit make one step |
| 6 | Body type passed to `fetch` | JSON string | JSON string (`GH7 provider-utils/src/post-to-api.ts#L38`) | `createOpenAI` keeps the `fetch` setting (`GH7 openai/src/openai-provider.ts#L205`). The sampling fetch needs a string and returns other types untouched (`REG:161-163`). That would drop `chat_template_kwargs` and preset keys with no error. Canary: `T/llm-task-profiles.test.ts:528-540`. Section 5 keeps this fetch |

Test note. `T/setup.ts:16` installs fake timers for every test file, and the SDK retry wait uses global `setTimeout` (`GH7 provider-utils/src/delay.ts#L26`). A wire-test reply with status 408, 409, 429 or 5xx (`GH7 provider/src/errors/api-call-error.ts#L28-L32`) hangs until the 10 s test timeout (`apps/server/vitest.config.ts:23`). So error-path tests use only 400 and 401.

### 6.9 Proof of no behavior change

Unit tests alone never count (section 10), and a 200 does not prove a user path. Dictation cleanup has no screen, so the proof uses the real server in the real app. Command-level parts are marked.

#### 6.9.1 Commit order inside the package

| Commit | Content | Gate |
|---|---|---|
| CP1 | Add `T/ai-sdk-wire.test.ts` and its snapshot. Run on v6 (main as is) | All pass. The snapshot is the baseline |
| CP2 | Rows 23-25 of 6.4 (renames that 6.0.191 supports) | Type-check, tests, renderer build pass. Snapshot unchanged |
| CP3 | The bump (rows 1-5), v7 renames (rows 6, 7, 9, 10, 15, 16, 18, 22), test mocks (rows 8, 27) | Same tests pass. Snapshot has no diff against CP1 |
| CP4 | PR evidence (6.9.3, 6.9.4 output), not source code | Evidence attached |

`vitest -u` never runs in CP3. A snapshot diff is a stop (M7).

#### 6.9.2 Wire-body tests (command-level, not the app)

Method: spy on `globalThis.fetch` as `captureBody` does (`T/llm-task-profiles.test.ts:494-526`) and build the real provider with `createChatModel` (`S/lib/providers.ts:54-72`). A cloud case inserts an `api_keys` row first (`T/llm-task-profiles.test.ts:158-161`). Each Groq case uses a new key, because the client caches by key and model (`S/lib/groq-http.ts:23-29`).

| Case | Call | Snapshot holds |
|---|---|---|
| WB1-WB8 | stt `postProcess`, model from `createChatModel` for openai, groq, anthropic, google, mistral, openrouter, vercel, `server`; production params (`S/lib/post-process.ts:228-249`) | URL, method, header names, `content-type` and `authorization` values, parsed JSON body, result (`cleaned`, `inputTokens`, `outputTokens`) |
| WB9 | `server` provider, preset `builtin:qwen-thinking` | full body incl. `chat_template_kwargs`, `top_k`, `min_p`, floored `max_tokens` |
| WB10 | `runRemixTransform` (`S/lib/remix-transform.ts:95`) on a `server` model | body and result |
| WB11 | `runRemixAgentLocally` (`S/lib/remix-agent.ts:65`), canned SSE: one tool call, then text | request body incl. `tools[].function.parameters`; response bytes with random ids replaced by a fixed token |
| WB12-WB14 | stt `transcribe` for openai, groq, elevenlabs via `transcribeWithAiSdk` (`S/lib/streaming/utils.ts:37-59`) | URL, header names, multipart field names and values; no audio |
| WB15 | one 401 and one 400 reply on WB1 | stt falls back to raw text; `onError` gets an error with the same `statusCode` |

```bash
pnpm --filter @openstyle/server test tests/ai-sdk-wire.test.ts   # no "--" before the path (AGENTS.md:81)
pnpm --filter @openstyle/server test
pnpm --filter @openstyle/stt run test
git diff --stat <CP1>..<CP3> -- apps/server/tests/__snapshots__
# Expected: all pass. The last command prints nothing.
```

A wrong canned reply fails CP1 on v6, so CP1 validates the replies. Limit: no app and no live cloud API.

#### 6.9.3 Real-app proof

Follow `.claude/skills/live-testing/SKILL.md` (`SKILL.md` below): quiet mode, isolated profile, no port 4649, no microphone, no system audio, no installed app; run through the Test Runner app (`:202`); stop at any privacy dialog (`:220`).

**A. Dictation cleanup (required).** `POST /api/post-process` runs the full cleanup path with text and no audio (`S/routes/post-process-route.ts:7-27`; `S/routes/index.ts:52`), through the server `postProcess` (`S/routes/post-process-route.ts:16`; `S/lib/post-process.ts:139-249`). That function calls stt `postProcess` at `S/lib/post-process.ts:228` (imported as `cleanupWithModel`, `S/lib/post-process.ts:2`). The stt function calls `generateText` from `ai` at `STT/src/post-process.ts:125` (function `:108-137`).

1. Make two worktrees: baseline (main c47cd80d, ai 6) and package (ai 7). The coordinator makes them (inference: only the coordinator creates branches, `AGENTS.md:95`, and `git worktree add -b` creates one, `.claude/skills/branch-lifecycle/SKILL.md:16`). Build each worktree (this spec's step; the skill does not say to build per worktree). The server build is `pnpm turbo build --filter=@openstyle/server` (`SKILL.md:83`). The electron build is `cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build` (`SKILL.md:211`).
2-4. Write a throwaway spec `apps/electron/tests/zz-proof-ai-sdk-v7.test.ts` (`SKILL.md:210`), identical in both worktrees, never committed. It runs a loopback capture server that answers `GET /v1/models` with `capture-model` and `POST /v1/chat/completions` with a fixed completion (`finish_reason: "stop"`, `prompt_tokens: 40`, `completion_tokens: 9`), and records URL, header names and raw body (pattern: `apps/electron/tests/meeting-cancel-transcribe.test.ts:108-118, 271-290`). It starts the app with `launchOpenstyle` (`apps/electron/tests/helpers/e2e-app.ts:36-58`; `OPENSTYLE_E2E=1` gives quiet mode on macOS only, `E/main/index.ts:98-100`), registers the server as default LLM, sets `PUT /api/settings/llm_cleanup` `{ "value": "true" }` (`S/routes/settings.ts:94`), and posts `{ "text": "um so we ship on friday i think" }` to `/api/post-process`.
5-6. Assert: HTTP 200; `cleaned` equals the fixed completion; `inputTokens` 40; `outputTokens` 9; one chat request captured; one `llm.request` entry with the same body in `openstyle-trace.log` (`S/lib/trace.ts:257-275`). Write `{status, response, captured}` to a scratch JSON file.
7. Run both builds, then `diff <(jq -S . baseline.json) <(jq -S . package.json)`. Expected: no output.
8. Run the TCC check before and after (`SKILL.md:218-219`). Expected: no new line.
9. Optional (this spec's choice; the skill does not call it optional), owner's server `http://127.0.0.1:8123`. The skill allows two models there: Qwen3-ASR and Qwen3.8-27B (`SKILL.md:229`; `scripts/guard-hook.sh:58-79`). Cleanup is a chat call, so this proof sends `Qwen3.8-27B` only (this spec's rule). The guard hook reads the model only from the Bash command or a `-d @file` body (`scripts/guard-hook.sh:49, 59-69`), so it cannot see a model name inside a spec. The spec itself must obey. Check the trace log body and a non-empty `cleaned`. After the test, `timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models` must print 200 (`SKILL.md:229`).
10. Delete the spec and the scratch folder. Stop only PIDs you started (`SKILL.md:16-17`).

`inputTokens` is the key assertion: it stays 0 when the LLM path fails (`S/lib/post-process.ts:147-148, 252-263`). The fallback also returns text, so text alone cannot tell the two apart.

**B. Remix chat (screen proof).** The renderer changed (rows 23-26). Use the same capture server in SSE: reply 1 streams one tool call, reply 2 streams text. Open the Remix chat (`data-testid="remix-chat"`, `apps/electron/tests/remix-mini-strip.test.ts:228`) and screenshot each build. Check: the tool row shows; the second request body holds the tool output (proves `addToolOutput` and `sendAutomaticallyWhen`); the final text shows. UNVERIFIED: a client tool may need an OS permission. At a privacy dialog, stop and report.

**C. Other paths.** Meetings use the same stt `postProcess` (`S/lib/meetings/llm-call.ts:136`). The skill has no Summarize recipe. Its meetings recipe (`SKILL.md:206-217`) seeds a fictional meeting for a Speakers dialog proof (step 6, `SKILL.md:215`). `SKILL.md:130` says to insert rows with `sqlite3` into the isolated DB for a meeting with a summary. If the package touches `llm-call.ts`, run one Summarize on a seeded fictional meeting, reusing steps 1 to 8 of that recipe. The trigger is `POST /api/meetings/:id/summarize`, which needs the status `transcribed` or `summarized` and a non-empty transcript (`S/routes/meetings.ts:2068-2085`; mount `S/routes/index.ts:47`). The full Summarize recipe is UNVERIFIED until a run. Cloud transcription needs provider keys, so WB12-WB14 are its only proof. Say so in the PR.

#### 6.9.4 Negative control (the proof must be able to fail)

In a scratch worktree, set only `STT/package.json` back to `ai` 6.0.191 and run proof A on the package build. Expected (UNVERIFIED until run): no chat request is captured; `inputTokens` is 0; the server log has `LLM cleanup failed` (`S/lib/post-process.ts:262`). If proof A still passes, the proof is useless. Fix it first.

#### 6.9.5 Build and bundle checks

| Check | Command | Expected |
|---|---|---|
| Lock, build, tests | `pnpm install --frozen-lockfile` and the grep of 6.7; `pnpm turbo build --filter=@openstyle/server` (`CI:170`); `pnpm --filter @openstyle/server test`; `pnpm --filter @openstyle/stt run test` (`CI:144, 147`) | pass; listed lock keys only |
| Type-check | `pnpm --filter @openstyle/electron run typecheck`; `pnpm --filter @openstyle/server run typecheck:tests` (`apps/server/package.json:7`) | pass; covers the `type` and `none` rows of 6.4 |
| Bundle | `cd apps/electron && pnpm run build && node scripts/check-bundled-requires.mjs && node scripts/check-renderer-asset-urls.mjs` (`CI:177-201`) | pass |
| One SDK copy | `grep -o 'AI_NoObjectGeneratedError' apps/electron/out/main/server-process.js \| wc -l` | 1, like v6 (F3); 2 or more means two copies |
| Size | `ls -l apps/electron/out/main/*.js`; `du -sk apps/electron/out/renderer`, before and after | record both; asar near 9 MiB (`AGENTS.md:87`) |

### 6.10 What the package must not do

- Add `Output`, a schema, a gateway file, a retry setting, a reasoning option or telemetry (M4). The app has no telemetry today (`AGENTS.md:9`).
- Change `PostProcessParams` (`STT/src/post-process.ts:24`), the stt `PostProcessResult` (`STT/src/post-process.ts:76`) or `ChatCallResponse` (`S/lib/meetings/llm-call.ts:46-55`). The server has its own, different `PostProcessResult` (`S/lib/post-process.ts:45`); it stays too. Do not change the `length` rule at `STT/src/post-process.ts:148`. That line is the only decision on `finishReason`; line 151 reads it for the error text. Section 5 adds the finish reason.
- Move `toUIMessageStreamResponse` to the stateless helpers. The call is at `S/lib/remix-agent.ts:123`. Its response is the argument of `releaseLeaseOnResponseBodyEnd` (`S/lib/remix-agent.ts:122-132`). That wrapper (`S/lib/llm/lane.ts:535-575`) releases the lane lease when the response body ends (comment `S/lib/llm/lane.ts:521-534`). See Q-C.

### 6.11 Open items

| # | Item (UNVERIFIED) | Settled by |
|---|---|---|
| U6-1 | Real `electron-vite` build with v7, bundle size (incl. the `@ai-sdk/mcp` effect), guard script (F4, F5) | 6.9.5 |
| U6-2 | Every v7 wire body equals its v6 body (8 providers, 3 transcription providers) | CP1 against CP3 (6.9.2) |
| U6-3 | JSON Schema from the zod v3 Remix tool inputs (`packages/validations/src/remix.ts:1`) equals the v6 output. The v7 provider-utils keeps a zod v3 path (`GH7 provider-utils/src/schema.ts#L200-L218`) | WB11 |
| U6-4 | `@ai-sdk/react` 4 works with the current `useChat` options | type-check, proof B |
| U6-5 | The v3 fake in `STT/src/post-process.test.ts:4-26` passes the v7 adapter | stt tests in CP3 |
| U6-6 | Live calls to cloud providers (no keys in the proof environment) | not settled; say so in the PR |
| U6-7 | Stored Remix threads hold no system-role message (6.8 row 3) | a test with a `system` message |

Open questions for section 12:
- Q-A. Put `ai`, `@ai-sdk/react` and `@ai-sdk/provider-utils` in the pnpm catalog (P2)? Without it, three manifests need three equal edits.
- Q-B. Keep the CJS output of the stt package (F6)? It is not published today, but `.github/workflows/release-package.yml:27` lists stt as publishable.
- Q-C. Move `toUIMessageStreamResponse` to the stateless helpers later, before the next AI SDK major?

### 6.12 Sources

- `GUIDE`: https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
- `GH7` (`ai@7.0.143`, commit `b7f6255a`; tag check https://api.github.com/repos/vercel/ai/git/ref/tags/ai%407.0.143): https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ then `<package>/src/...`
- `GH6` (`ai@6.0.191`, commit `0838d52f`; tag check https://api.github.com/repos/vercel/ai/git/ref/tags/ai%406.0.191): https://github.com/vercel/ai/blob/0838d52fe657c4f04891b78423fbc636a543851a/packages/
- `R3` (`@ai-sdk/react@3.0.242`): https://github.com/vercel/ai/blob/%40ai-sdk%2Freact%403.0.242/packages/
- `NPM`: https://registry.npmjs.org/ then `<package>` or `<package>/<version>`
- `UNPKG`: https://unpkg.com/ then `<package>@<version>/dist/...`
- `EL` (Electron Node version): https://artifacts.electronjs.org/headers/dist/index.json

---

## 7. Persistence

Migration 40 adds six tables. This part owns table shapes, write rules and delete rules. Graph: section 3. Verify step: 4. Call content: 5. Tests: 10. Work breakdown: 11.

Path keys (baseline c47cd80d): `srv/`=`apps/server/src/`; `ui/`=`apps/electron/src/renderer/src/`; `tests/`=`apps/server/tests/`; `meetings.ts`=`srv/routes/meetings.ts`; `schema.ts`=`srv/lib/schema.ts`; `db.ts`=`srv/lib/db.ts`; `enhance.ts`=`srv/lib/meetings/enhance.ts`; `detail.tsx`=`ui/pages/meetings/detail.tsx`; `speakers.tsx`=`ui/pages/meetings/speakers.tsx`; `en.json`, `template.json`, `locales.test.ts`=files in `ui/locales/`; `meeting-types.ts`=`packages/validations/src/meeting-types.ts`.

Terms: Run = one workflow execution for one meeting (id = `thread_id`). Step = one node execution. Call = one model request. Attempt = call number in its step. Link = row joining a call to one thing it produced. Recorder = the module that writes the record.

### 7.1 Current state

- One `node:sqlite` connection, WAL, `foreign_keys = ON` (`db.ts:14-40`). `SCHEMA_VERSION` is 39 (`schema.ts:10-14`); steps 38, 39 use a `tableExists` guard (`schema.ts:953,997,254-258`). Four meeting child tables cascade from `meetings` (`schema.ts:780,791,851,943`).
- Segment id = `<meeting>:<source>:<idx>` (`meetings.ts:420`), written with `INSERT OR REPLACE` (`meetings.ts:415`). Re-transcribe deletes segments, speakers and turns (`meetings.ts:1546-1556`). Enhance writes `enhanced_text`, then suggestions, in two transactions (`enhance.ts:628-636,652-672`).
- SQLite needs the FK pragma on each connection (https://www.sqlite.org/foreignkeys.html, section 2). An index on a child key column is not required. The page calls it almost always beneficial, because a parent delete can scan the whole child table without one (same page, section 3). Each of the 11 child key columns in 7.4 is the first column of an index or of a primary key (checked on 2026-10-17 with `PRAGMA foreign_key_list` and `PRAGMA index_info` on the DDL of 7.4).

Link-table traps (checks A1 to A3, 7.13): (1) a plain FK from a link to `meeting_segments(id)` makes the re-transcribe DELETE fail. (2) A CASCADE FK loses the link on `INSERT OR REPLACE` (rows 1 to 0). (3) The id has no run part, and `idx` is the list position (`srv/lib/meetings/transcriber.ts:351`). A new segment can therefore reuse an old id with other text, although `meetings.ts:1547` says "fresh segment ids". 7.8 closes this.

### 7.2 Design rules

P1: Additive migration. P2: Every table has `meeting_id REFERENCES meetings(id) ON DELETE CASCADE` (D10). P3: A link has no FK to a segment, speaker or summary; it stores a string key. P4: A reader accepts a link only if it still matches the current target value (7.8). P5: Only the recorder writes the record; it never throws; a failed record write never fails the run. P6: The save step writes links in the same transaction as the data they describe. P7: No `CHECK` on enum columns (a failed CHECK is a silent lost row); TypeScript owns the enums; the read route maps an unknown value to `"unknown"`. P8: No key, token or header in the record; the recorder caps text fields. P9: Only the meeting delete removes the record (D10).

### 7.3 Migration 40

```ts
const SCHEMA_VERSION = 40;   // schema.ts:10-14
// New step after step 39, before the version upsert (schema.ts:997-1013):
if (currentVersion < 40 && tableExists(db, "meetings")) {
  db.exec(`...SQL of 7.4, one template string...`);   // all IF NOT EXISTS, safe to re-run
}
```

Change the version pins (`tests/schema-meetings.test.ts:7`, `tests/migration-servers.test.ts:91`) and `AGENTS.md:50` to 40. New tests (pattern `tests/schema-meetings.test.ts:406-441`; plan: section 10): v39 upgrade, guard skip with no `meetings` table, cascade for two meetings, link survival after segment delete and `INSERT OR REPLACE`, FK error for an unknown `meeting_id`.

### 7.4 DDL

No `DEFAULT`; the recorder writes every column. Times are epoch ms `INTEGER` (`schema.ts:763-764`; `apps/electron/src/main/meeting-recorder.ts:329`). Enum values: 7.6 and 8.4.

```sql
CREATE TABLE IF NOT EXISTS llm_runs (
  id TEXT PRIMARY KEY,   -- = LangGraph thread_id
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, started_by TEXT NOT NULL, status TEXT NOT NULL,
  graph_version INTEGER NOT NULL, input_hash TEXT, resume_count INTEGER NOT NULL,   -- 3.4.3, 3.4.7
  corrected_count INTEGER, suggestion_count INTEGER,   -- Enhance success note (8.9)
  lost_records INTEGER NOT NULL,   -- calls whose record write failed (7.7)
  error_kind TEXT, error_detail TEXT,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_runs_meeting ON llm_runs(meeting_id, started_at);
CREATE INDEX IF NOT EXISTS idx_llm_runs_open ON llm_runs(status) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS llm_run_steps (
  run_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,   -- the top unit key (grammar: 4.0.7): 'prepare', 'chunk:3', 'candidates', 'verify', 'single', 'map:2', 'reduce:1:0', 'save'
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  node TEXT NOT NULL,
  seq INTEGER NOT NULL,   -- start order of the step in the run, from 1; unique in the run; set by the recorder (7.7 rule 3)
  status TEXT NOT NULL,   -- running|succeeded|partial|failed|skipped|cancelled|interrupted (8.4)
  attempts INTEGER NOT NULL,
  error_kind TEXT, error_detail TEXT, started_at INTEGER, finished_at INTEGER,
  PRIMARY KEY (run_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_llm_run_steps_meeting ON llm_run_steps(meeting_id);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL, node TEXT NOT NULL,
  attempt INTEGER NOT NULL, retry_reason TEXT,
  provider TEXT, requested_model TEXT, served_model TEXT,
  messages_json TEXT NOT NULL,
  schema_name TEXT NOT NULL, schema_version INTEGER NOT NULL, schema_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  raw_text TEXT, parsed_json TEXT,
  finish_unified TEXT, finish_raw TEXT,   -- stop|length|content-filter|tool-calls|error|other; provider value
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cached_tokens INTEGER,   -- NULL = unknown
  reasoning_chars INTEGER, queued_ms INTEGER, latency_ms INTEGER,
  error_kind TEXT, error_detail TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id, step_key, attempt);
CREATE INDEX IF NOT EXISTS idx_llm_calls_meeting ON llm_calls(meeting_id, started_at);
CREATE TABLE IF NOT EXISTS llm_call_links (   -- target_id has no FK (P3)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES llm_calls(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  seq INTEGER NOT NULL,   -- index of the entry in the array of the call output: corrections[i], speakers[i]; 0 for a summary link (4.6.1)
  outcome TEXT NOT NULL,
  reason TEXT,
  applied_text TEXT,
  verdict_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_call_links_target ON llm_call_links(meeting_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_llm_call_links_call ON llm_call_links(call_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_call_links ON llm_call_links(call_id, target_type, target_id, seq);   -- a replayed save adds no row (4.6.2)
-- LangGraph saver (D6): official SQLite saver columns; thread_id = run id.
CREATE TABLE IF NOT EXISTS llm_checkpoints (
  thread_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_llm_checkpoints_meeting ON llm_checkpoints(meeting_id);
CREATE TABLE IF NOT EXISTS llm_checkpoint_writes (
  thread_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  task_path TEXT NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_llm_checkpoint_writes_meeting ON llm_checkpoint_writes(meeting_id);
```

Notes. The call keeps its own schema copy (L5): `schema_json` is the SDK output `await asSchema(zod).jsonSchema` (4.0.3 rule 7), not a form that a provider package reshaped for the wire. Valid JSON with a finish reason other than `stop` keeps `parsed_json` and sets `error_kind` (D4). Unknown tokens are NULL; today's code writes 0 (`srv/lib/meetings/llm-call.ts:45`). A requested and served model difference sets `error_kind = 'model_mismatch'` (L4). `error_detail` holds no request body, because AI SDK `APICallError.requestBodyValues` include prompts (https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error). `llm_calls.step_key` is the `unitKey` of the call (`chunk:3/0` for a half). A call belongs to the step `chunk:3` when its key equals the step key or starts with it plus `/`. `callUnit` reuses a finished call by this key (5.6), and the key grammar of 4.0.7 makes one key name one input in one run. `llm_run_steps.status` also holds `partial`: a step whose halves ended in a mix of ok and failed (4.0.7). `llm_calls.attempt` is computed by the recorder (7.7 rule 3), not by the gateway.

### 7.5 JSON column shapes

```ts
// meeting-types.ts (planned, WP2). The file exists and holds types only (`meeting-types.ts:3-5`). It has no LlmMessage and no LlmParamsLedger at c47cd80d (0 matches in the repo).
// WP2 adds both here, exported, and nowhere else (5.1, rule B).
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }  // messages_json
export interface LlmParamsLedger {     // params_json; section 5 fills it; unknown keys stay readable
  topLevel: Record<string, unknown>;   // request fields: temperature, max_tokens, response_format
  extraBody: Record<string, unknown>;  // gateway-added: chat_template_kwargs, top_k
  dropped: { name: string; value?: unknown; reason: string }[];  // asked for, not sent; reason: LedgerDropReason (5.1)
  source: { mode: "auto" | "preset" | "custom"; presetId?: string };
  capturedFrom: "wire" | "sdk_request";  // 5.1: where the gateway read the body
  warnings: string[];                    // 5.1: one line each, no prompt text. Includes `profile.warnings`, for example `registry_unavailable`
  structuredMode: "json_schema_strict" | "json_schema" | "json_tool" | "json_object" | "prompt_only"; // 5.4: the mode of this call. No column holds it, so `finishedCall` reads it from here
}
// verdict_json holds the SpeakerVerdict of 4.4: one shape and one code list (11.4).
```

Each code has the English text under the key `meetings.inspector.verdict.<code>` in `en.json` and `template.json` (planned, 8.10; `en.json` has no `inspector` key at c47cd80d). The link `reason` column holds the `reason` of the verdict or of the drop.
- Kept (`evidenceType`): `self_introduction` "The speaker named themselves."; `addressed_as` "Another speaker called this speaker by that name."; `role_detail` "A real line supports this role."
- Dropped speaker proposals (`DropReason`, 4.4): `unknown_label` "The speaker label does not exist."; `unknown_segment` "The cited line was not shown to the model."; `no_quote` "The model gave no evidence quote."; `quote_too_long` "The evidence quote is too long."; `quote_not_in_segment` "The evidence quote is not in the cited line."; `empty_name` "The entry has no name."; `name_not_in_quote` "The name is not in its own evidence."; `not_self_introduction` "The speaker said the name but did not name themselves."; `conflict_lost` "Stronger evidence named this speaker differently."; `duplicate_same_name` "Another proposal for this speaker has the same name."
- Dropped corrections (`CorrectionDropReason`, 4.2): `unknown_id` "The model named a segment that is not in this chunk."; `duplicate_id` "The model named this segment twice."; `empty_text` "The correction was empty."; `unchanged` "The correction did not change the text."

### 7.6 Enumerations

`llm_runs.kind`: `enhance`, `summarize` (`srv/lib/meetings/job-registry.ts:39-44`). `started_by`: `auto`, `button`. It holds the original trigger for the whole life of the run. `markResumed` does not write it. A resumed run has `resume_count` above 0 (3.4.3). Section 3 owns both. Run status, step status, target type and outcome: TS types in 8.4. `error_kind` (section 5 owns it: the 15 kinds of 5.2.1; D4, L1 to L4): `length`, `content_filter`, `unexpected_tool_calls`, `abnormal_stop`, `reasoning_leak`, `schema`, `model_mismatch`, `cancelled`, `provider_timeout`, `provider_rate_limited`, `provider_unavailable`, `provider_auth`, `provider_invalid_request`, `model_unavailable`, `deadline_exceeded`. A step can also hold `budget_exceeded`, `empty_input`, `save_failed` or `internal` (4.0.7). A run can also hold `interrupted_before_checkpoint`, `graph_changed`, `transcript_changed` or `internal` (3.4.3). The read route maps any other value to `unknown` (P7).

Run status: `succeeded` = every step `succeeded` or `skipped`. `partial` = a step failed and the save step wrote the other results (D4). `failed` = no result written. `cancelled` = user stop. `interrupted` = process ended while `running` (7.12).

### 7.7 The recorder

New file `srv/lib/meetings/llm-record.ts` (path is a proposal).

```ts
// srv/lib/meetings/llm-record.ts. Types that cross a work-package border. WP2 writes them; WP3, WP5a and WP5b use them.
// Its field types come from the base types of 5.1 (rule B). WP2 adds both sets, so this file compiles before WP3 exists.
// `srv/lib/llm/call-record.ts` is a new file (absent at c47cd80d). `meeting-types.ts` exists but has none of these types at c47cd80d. Both paths describe planned content.
export interface NewRun { // startRun: one row of llm_runs. The recorder sets status "running", resume_count 0, lost_records 0, updated_at = startedAt
  id: string;                      // the run id = LangGraph thread_id (a UUID made by the runner)
  meetingId: string;
  kind: LlmRunKind;                // "enhance" if the stage list holds "enhance", else "summarize" (3.4.2 step 1)
  startedBy: "auto" | "button";    // the trigger of startRun (3.4.2)
  graphVersion: number;            // WORKFLOW_GRAPH_VERSION (3.4.7)
  startedAt: number;               // epoch ms
}
export interface RunFinish { // finishRun: columns written in one statement (3.4.6 step 3)
  errorKind: string | null; errorDetail: string | null; // llm_runs.error_kind, error_detail: the run failure code (3.4.3), no prompt text
  correctedCount: number | null; suggestionCount: number | null; // Enhance success note (8.9). null for a Summarize run
  lostRecords: number;             // calls whose record write failed (7.7 rule 9)
  finishedAt: number;              // epoch ms. Also written to updated_at
}
export interface NewLink { // one row of llm_call_links. The recorder fills meeting_id (from the call row) and created_at
  targetType: LlmTargetType;       // "segment" | "speaker" | "summary" (8.4)
  targetId: string;                // segment id, speaker label, or the meeting id for a summary (4.6.1)
  seq: number;                     // index of the entry in the call output; 0 for a summary link (4.6.1)
  outcome: "applied" | "dropped";
  reason: string | null;           // CorrectionDropReason or DropReason when dropped, else null
  appliedText: string | null;      // enhanced_text, finalName, or the summary created_at as text (7.8)
  verdict: SpeakerVerdict | null;  // stored as verdict_json
}
export interface ParsedCall { // finishedCall: a finished call that callUnit reuses after a resume (5.6)
  callId: number; attempt: number;
  parsed: unknown;                 // parsed_json, JSON.parse of the column. The caller parses it with the schema again
  rawFinishReason: string;         // finish_raw. The unified reason is "stop", because error_kind is NULL
  usage: TokenUsage;               // input_tokens, output_tokens, reasoning_tokens, cached_tokens
  provider: string | null; modelRequested: string; modelServed: string | null;
  queuedMs: number | null; latencyMs: number | null;
  params: LlmParamsLedger;         // params_json, parsed. It holds structuredMode (7.5)
}
export interface LlmRecorder {
  startRun(r: NewRun): "ok" | "no_meeting" | "error";   // "no_meeting": foreign key failure (3.4.2)
  finishRun(id: string, status: LlmRunStatus, f: RunFinish): void;   // 3.4.6
  setInputHash(id: string, hash: string): void;   // `prepare` (3.4.3)
  markResumed(id: string): void;   // status running, resume_count + 1 (3.4.7)
  startStep(runId: string, step: { key: string; node: string }): void;   // the recorder sets seq (rule 3)
  startAttempt(a: { runId: string; stepKey: string }): void;   // CallSink (5.1): before each request, attempts += 1
  finishStep(runId: string, key: string, status: LlmStepStatus, err?: { kind: string; detail: string }): void;
  recordCall(call: CallRecord): RecordedCall | null;    // CallSink.recordCall (5.1): call id and attempt; null when the write failed
  finishedCall(runId: string, unitKey: string): ParsedCall | null;   // call reuse (5.6); null when none, cut, or a JSON column does not parse
  linkCall(callId: number, links: NewLink[]): void;     // joins the open transaction
  sweepInterrupted(): number;                           // 'running' to 'interrupted'; run count
}
```

`CallRecord`, `RecordedCall` and `CallSink` are in 5.1 (`srv/lib/llm/call-record.ts`, planned, WP2; the file is absent at c47cd80d). The gateway imports that file only. `LlmRunKind`, `LlmRunStatus`, `LlmStepStatus` and `LlmTargetType` are in 8.4. The base types `LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode` and `GatewayErrorKind` are in the same `call-record.ts` (5.1). `SpeakerVerdict`, `LlmMessage` and `LlmParamsLedger` will be in `meeting-types.ts` (planned, WP2: 7.14; 5.1, 8.4). None of the names in this paragraph exists in the repo at c47cd80d (0 matches).

1. Every method catches errors, logs `log.warn` with the run id and returns. It never throws. The recorder is the `CallSink` of 5.1 and the only module that writes `llm_runs`, `llm_run_steps`, `llm_calls` and `llm_call_links` (3.1).
2. `recordCall` runs one `INSERT` after the call ends. It sets `attempt` in the same statement to `(SELECT count(*) FROM llm_calls WHERE run_id = ? AND step_key = ?) + 1`: the rows with the same run and unit key, plus 1. A call that was not recorded does not count. The statement returns the new id, and the method returns `{ id, attempt }`. The gateway cannot know the number, because `startAttempt` returns nothing. A call in flight at process death leaves no row; its step stays `running` until the sweep.
3. `startStep` is an upsert on (run id, step key). On the first call for a key it inserts the row with status `running`, `attempts` 0 and `seq` = 1 + the highest `seq` of the run (0 if the run has no step). On a later call it sets `running` and keeps `seq` and `attempts`. So `seq` is the start order of the steps in the run, and no two steps of a run share a value. A node calls `startStep` at the start of its unit, just before its first `callUnit`, so for an LLM step `seq` is also the start order of its first call. A step that starts for the first time after a resume gets the next number. `startAttempt` adds 1 for each request, retries included (check S11, 7.13). Its `stepKey` is the call `unitKey`; the recorder adds 1 to the step row whose key equals it or is its prefix before `/` (7.4).
4. `linkCall` uses plain statements. The save step calls it inside its `withTransaction` (`db.ts:55-75`; synchronous). A failed link fails alone and the transaction commits (check S10, 7.13). A caller with no transaction may open one when `db.isTransaction` is false (Node 22.16.0+, https://nodejs.org/docs/latest-v22.x/api/sqlite.html; Electron 39.8.10 ships Node 22.22.1, https://artifacts.electronjs.org/headers/dist/index.json, `pnpm-lock.yaml:3301`). UNVERIFIED in the packaged app.
5. A vanished meeting makes inserts fail with an FK error. The recorder logs it at `debug` (`meetings.ts:1118-1127`).
6. Cap `messages_json`, `raw_text`, `parsed_json`, `schema_json`, `params_json`, `error_detail` at 500,000 characters each; append `\n[cut: N characters]`. The repo holds no measured prompt size (UNVERIFIED). The code gives two bounds, not measurements. (a) The Summarize reduce call holds all map partials. A run has at most 23 partials: the guard allows 24 calls (`srv/lib/meetings/summarize.ts:108,468`) and one call is the reduce call (`summarize.ts:498-509`). Each partial has at most 4,096 tokens (`summarize.ts:77`; the route passes no other value, `meetings.ts:1188-1199`). At the code estimate of 4 characters per token (`srv/lib/meetings/llm-call.ts:24-26`) this is 23 × 4,096 × 4 = 376,832, about 377,000 characters. (b) A single call or a map call holds one transcript chunk. The budget is 8,000 tokens by default (`summarize.ts:49`) and a user can raise it to 200,000 tokens (`packages/validations/src/settings.ts:185-186`), about 800,000 characters, which is above the cap.
7. No header or key is stored. Mask `params_json` like the trace log (`srv/lib/trace.ts:29-43,50`).
8. `llm_run_steps.attempts` (calls started) versus the call-row count of the step shows an unrecorded call (8.7).
9. When `recordCall` returns `null`, the call has no id. The node calls `ctx.recordLost()`, and the runner stores the count in `llm_runs.lost_records` at finish (3.4.6). `save` writes no link for a `null` id. The inspector shows `recordLost` for the run (8.7), apart from `noRecord`.

The diagram shows planned write paths, not today's code. The runner, node wrapper, gateway, save step and checkpoint saver are new (3.1). Only `startServer` (`srv/index.ts:185`) and the meeting tables exist at c47cd80d. Sources: 3.1, 3.4.6, 7.7 and 7.12.

```mermaid
flowchart LR
  R["Runner (3)"] -->|"startRun, finishRun"| runs[("llm_runs")]
  N["Node wrapper (3)"] -->|"startStep, finishStep"| steps[("llm_run_steps")]
  G["Gateway (5)"] -->|"startAttempt"| steps
  G -->|"recordCall"| calls[("llm_calls")]
  S["Save step (4)"] -->|"update enhanced_text, upsert speakers, replace summary"| data[("meeting tables")]
  S -->|"linkCall, same transaction"| links[("llm_call_links")]
  C["Checkpoint saver"] -->|"put, putWrites"| cp[("llm_checkpoints, llm_checkpoint_writes")]
  B["startServer"] -->|"sweepInterrupted"| runs
```

### 7.8 How a reader finds the link that is still true

A link stays when its target changes. The reader checks it against the current target value.

```sql
-- Segment: the link must match the current enhanced_text.
SELECT l.id, l.call_id FROM llm_call_links l
JOIN meeting_segments s ON s.id = l.target_id AND s.meeting_id = l.meeting_id
WHERE l.meeting_id = ? AND l.target_type = 'segment' AND l.target_id = ?
  AND l.outcome = 'applied' AND l.applied_text = s.enhanced_text
ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
-- Speaker 1: producing call = its applied name equals the current suggestion.
SELECT l.call_id, c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
JOIN meeting_speakers s ON s.meeting_id = l.meeting_id AND s.speaker_label = l.target_id
WHERE l.meeting_id = ? AND l.target_type = 'speaker' AND l.target_id = ?
  AND l.outcome = 'applied' AND l.applied_text = s.suggested_name
ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
-- Speaker 2 (fallback when 1 finds no row): newest run with any proposal for the label.
SELECT c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
WHERE l.meeting_id = ? AND l.target_type = 'speaker' AND l.target_id = ?
ORDER BY c.started_at DESC, l.id DESC LIMIT 1;
-- Speaker 3: all proposals of that run for the label, kept and dropped.
SELECT l.*, c.step_key FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
WHERE l.meeting_id = ? AND l.target_type = 'speaker' AND l.target_id = ? AND c.run_id = ?
ORDER BY c.started_at, l.id;
-- Summary: the link must match the current meeting_summaries row (its created_at, written by SW3).
SELECT c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
JOIN meeting_summaries s ON s.meeting_id = l.meeting_id
WHERE l.meeting_id = ? AND l.target_type = 'summary' AND l.outcome = 'applied'
  AND l.applied_text = CAST(s.created_at AS TEXT)
ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
```

- Segment: after a re-transcribe the segment has the same id and NULL `enhanced_text`, so no row returns (check E3, 7.13). A segment a later run left unchanged keeps the first run's text (`enhance.ts:630-635`) and its link.
- Speaker: a label with only dropped proposals has no suggestion, so step 2 finds the run. After a re-diarize, labels can mean other voices (`meetings.ts:1547-1552`). The reader calls `inputHash(loadHashRows(db, meetingId), "enhance")` (4.1 P11) and compares it with `llm_runs.input_hash` of the producing run. A speaker link comes from an Enhance run, so the variant is `enhance`. The reader and `prepare` call the same two functions on database rows, so equal rows give equal bytes. If the hashes differ, or the stored value is NULL, the link has `staleLabels` true and the panel shows `speakerLabelNote` (8.10).
- Summary: the old path also writes `meeting_summaries` while the flag is off (`meetings.ts:1214`, `INSERT OR REPLACE`), and it writes no link. The `created_at` check then finds no row, and the panel says `noRecord` instead of naming an older run. The run's links list the single call, or the map and reduce calls. A failed Summarize writes no summary link, so the old summary stays true.

### 7.9 Checkpoint tables

- Columns follow the official `SqliteSaver` 1.1.0 (https://unpkg.com/@langchain/langgraph-checkpoint-sqlite@1.1.0/dist/index.js).
- The saver fills `meeting_id` with `INSERT ... SELECT r.meeting_id FROM llm_runs r WHERE r.id = ?`. For a deleted run this inserts 0 rows and does not throw (check C6, 7.13). `task_path` is `''` when absent. `deleteThread` deletes from both tables itself, because the cascade needs the run row to go. The saver does not swallow errors (a saver error ends the graph: 3.4.8 rule 1).
- It implements `getTuple`, `list`, `put`, `putWrites`, `deleteThread`, not `getDeltaChannelHistory` (https://unpkg.com/@langchain/langgraph-checkpoint@1.2.0/dist/base.d.ts). `node:sqlite` has no `pragma()` or `transaction()` (https://nodejs.org/docs/latest-v22.x/api/sqlite.html), so it uses `withTransaction` and `prepareCached` (`db.ts:47-75`). `Uint8Array` binds to `BLOB` (check C2, 7.13).
- Validation (D6; https://unpkg.com/@langchain/langgraph-checkpoint-validation@1.2.0/README.md). UNVERIFIED: how the suite makes thread ids. The foreign-key wrapper is in 10.7 (O7-3). Fallback: drop the FK from `thread_id` to `llm_runs`, add an `AFTER DELETE` trigger on `llm_runs`, and record it in 12.1 (R11).
- Deletion rule (settled, one rule): the runner calls `deleteThread(runId)` at every final status, `succeeded`, `partial`, `failed` and `cancelled`, and keeps the checkpoints only for `interrupted` (3.4.6 step 5). Only an `interrupted` run can resume (3.4.7 guard 3), so a kept checkpoint of a `failed` or `partial` run has no use and costs space (7.11). A guard failure of 3.4.7 (guards 4 and 6) deletes the thread too. The inspector record is never pruned (P9).

### 7.10 Indexes

The nine `idx_` indexes serve: run list and meeting delete (`idx_llm_runs_meeting`), boot sweep (`idx_llm_runs_open`), attempt timeline (`idx_llm_calls_run`), newest and failed calls (`idx_llm_calls_meeting`), 7.8 lookups (`idx_llm_call_links_target`), FK delete scans (the rest). The query-plan checks D1 to D7 of 7.13 show index use. UNVERIFIED: a partial index for failed calls. `uq_llm_call_links` makes a replayed `save` an update (4.6.2). A unique index rejects a duplicate entry (https://www.sqlite.org/lang_createindex.html, section 1.1). Without `uq_llm_call_links`, two identical inserts give 2 rows. A scratch probe on 2026-10-17 with the DDL of 7.4 (SQLite 3.53.4, `node:sqlite`, Node 26.5.0) gave both results: the second insert fails with the index and gives 2 rows without it. The probe script is not in the repo. To repeat it: in an in-memory database with `PRAGMA foreign_keys = ON`, create `meetings`, run the `sql` block of 7.4, add one meeting, one run, one call and one link, then insert the same link again.

### 7.11 Size estimate

ESTIMATE from a scratch database of random words. The scratch script is not in the repo (7.13), so a reader cannot repeat the table (UNVERIFIED). Each correction call has: system 2,500 characters, user 5,000, schema 1,200, ledger 600, raw and parsed 2,000 each, and three links.

- System part. 2,500 is a planning value, not a measurement. The text of today's system prompt is at `srv/lib/meetings/enhance-prompt.ts:16-26,48-50,91-112`. On 2026-10-17, `buildEnhanceSystemPrompt` at c47cd80d returned 1,704 characters with language "en", no vocabulary and no speaker labels. It returned 1,959 with five short vocabulary terms and 4,291 with two speaker labels. The new correction prompt has no speaker block (4.2) and is not written yet, so the first two values are the closer base (UNVERIFIED). A value of 1,959 instead of 2,500 lowers the per-call total of 13,300 characters by 541 (4 percent).
- User part. 5,000 comes from issue #163: user prompts of 4,692 to 5,014 characters for the 8 chunks of one meeting (https://github.com/Maheidem/openstyle/issues/163).
- Schema, ledger, raw and parsed sizes are UNVERIFIED guesses. The speaker call (12,000 characters) is also an UNVERIFIED guess.
- Summary call. Add one call of 32,000 characters. This is 8,000 tokens × 4 characters per token. 8,000 is the default transcript budget (`DEFAULT_SUMMARY_CONTEXT_BUDGET_TOKENS`, `srv/lib/meetings/summarize.ts:49`). 4 characters per token is the code estimate (`srv/lib/meetings/llm-call.ts:24-26`). The summary system prompt adds to it.

| Enhance chunks | Calls | Inspector rows | Checkpoints, state 30 KB | Checkpoints, state 200 KB |
|---|---|---|---|---|
| 8 | 10 | 180 KiB | 228 KiB | 1.2 MiB |
| 40 | 42 | 624 KiB | 860 KiB | 4.6 MiB |
| 120 | 122 | 1.7 MiB | 2.4 MiB | 13 MiB |

A checkpoint holds the state channel values at each super-step (https://docs.langchain.com/oss/javascript/langgraph/checkpointers), so transcript text in the state repeats in every checkpoint. Section 3 keeps the segment text in the state (3.3, about 190 KB for 4 hours), so the 200 KB column applies. The 30 KB column fits a state with ids and small results only, which 3.3 rejects. Map and reduce summaries add up to 24 calls (`srv/lib/meetings/summarize.ts:108`), not modeled. The record can be the largest part of the database file. One hour of speech is about 12,000 transcript tokens, which is about 48,000 characters at 4 characters per token (`specs/meeting-llm-queue.md:519` gives the 12,000 tokens as an estimate, and `:522` marks it UNVERIFIED; its 48,000 at `:523` is the token count of a 4 hour meeting).

### 7.12 Retention, delete and boot sweep

The FKs delete the record with its meeting. `DELETE /api/meetings/:id` (`meetings.ts:2265,2283`) and `resetMeetingTables` (`tests/helpers/meetings-db.ts:6-9`) need no change (checks C1 to C4, 7.13). The retention sweep still deletes WAV files only (`srv/lib/meetings/retention.ts:12-17`). Route code must not delete `llm_*` rows on re-transcribe or re-diarize. The record has no age or size limit (D10; O7-1).

Boot sweep. A killed process leaves `running` rows, and the job registry dies with it (`srv/lib/meetings/job-registry.ts:10`). `startServer` calls the new `sweepInterrupted()` once, next to the other start-up calls (`srv/index.ts:211,215-216`). A different sweep fails `meetings` rows of killed jobs (`apps/electron/src/main/meeting-recorder.ts:803`). A resume (section 3) sets the same run back to `running`. WP2 ships `sweepInterrupted()`; WP5b replaces it with `sweepOrphanRuns()` (3.4.7, 11.5).

```sql
UPDATE llm_run_steps SET status = 'interrupted', finished_at = ?
 WHERE status = 'running' AND run_id IN (SELECT id FROM llm_runs WHERE status = 'running');
UPDATE llm_runs SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE status = 'running';
```

### 7.13 Proof run

Scratch scripts `exp.mjs` to `exp4.mjs` are not in the repo. A search of `/private/tmp` and the dev folder (depth 5, 2026-10-17) found no copy. A reader cannot read or repeat them, so every result below is author-reported and UNVERIFIED, except the re-run in the last paragraph of this section. The check ids A1 to A3, C1 to C6, D1 to D7, E3, S10 and S11 in 7.1 to 7.12 use the letters of these scripts.

Reported setup: `node:sqlite`, Node 26.5.0, SQLite 3.53.4, in-memory, `foreign_keys = ON`, on a hand-written copy of the five meeting tables. The real tables are in `schema.ts` (7.1). Reported results: A traps; B DDL twice (11 tables, 9 `idx_llm_*`, old row intact, `foreign_key_check` empty); C cascade, BLOB, missing run; E segment link; S speaker, summary, sweep, `isTransaction`, S10, S11; D query plans; F sizes. UNVERIFIED: the SQLite version in Electron 39.8.10 (the DDL uses no `STRICT`, generated column or `RETURNING`), and the real `initSchema` with step 40 (the 7.3 tests must run it).

Re-run on 2026-10-17 (Node 26.5.0, SQLite 3.53.4, in-memory): the `sql` block of 7.4 ran twice with no error on a database with a one-column `meetings` table. It gave 6 `llm_*` tables and 9 `idx_llm_*` indexes, and `PRAGMA foreign_key_check` was empty. The unique-index probe of 7.10 and the index check of 7.1 also ran. The other checks were not re-run.

### 7.14 Files that change in section 7

Work breakdown: section 11 (WP2). New: `srv/lib/llm/call-record.ts` (`CallRecord`, `RecordedCall`, `CallSink`, and the base types `LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode`, `GatewayErrorKind`: 5.1), `srv/lib/meetings/llm-record.ts` (the recorder and `NewRun`, `RunFinish`, `NewLink`, `ParsedCall`: 7.7), `llm-record-read.ts` (7.8 queries, 8.3 mapping), `srv/lib/meetings/input-hash.ts` (`HashRow`, `loadHashRows`, `inputHash`, `hashVariantOf`: 4.1 P11); paths are proposals. WP2 also writes the shared types in `meeting-types.ts` (an existing file; none of these types exists there at c47cd80d): `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason`, `LlmMessage`, `LlmParamsLedger` and the types of 8.4 (5.1, rule B). The saver is `srv/lib/meetings/workflow/checkpoint-saver.ts` (new file, WP4; 3.1, 11.4). Edits: `schema.ts`, `srv/index.ts` (one `sweepInterrupted()` call), the two version-pin tests, `AGENTS.md:50`.

### 7.15 Open questions for section 12

- O7-1: Does the owner want a limit on the record (age or size)? D10 sets none; 7.11 shows about 0.6 MiB for 40 chunks.
- O7-2: Closed with a default, no owner decision needed. The rule is 3.4.6 step 5: the runner deletes the checkpoints at every final status (`succeeded`, `partial`, `failed`, `cancelled`) and keeps them only for `interrupted`. Reason: only an `interrupted` run can resume (3.4.7 guard 3), so a kept checkpoint of a `failed` run has no use and costs space (7.11). 7.9 and 12.4 follow it, and GR17 tests it (10.8). The owner can overrule: a rule that keeps `failed` checkpoints needs a guard 3 that accepts `failed`, which this spec does not plan.
- O7-3: Can the validation suite run with the production FKs (7.9)? UNVERIFIED; the fallback changes the DDL.
- O7-4: Is `trace_id` wanted in `llm_calls`? Answered in 9.10: no. 7.4 has no `trace_id` column.

---

## 8. LLM inspector

The inspector shows the record of section 7 in the meeting screen. Owner intent (D10): in the transcript screen the user clicks an edited text and sees exactly the message sent and received. It is hidden by default and enabled in Advanced. Scope: text corrections, speaker suggestions, summary, failures and retries. Non-goals: prompt editing, call replay, export, search across meetings, token streaming, a server check of `advanced_mode`.

Path keys for this section (baseline c47cd80d): `S/` and `srv/` = `apps/server/src/`; `E/` = `apps/electron/src/`; `ui/` = `apps/electron/src/renderer/src/`; `meetings.ts` = `srv/routes/meetings.ts`; `enhance.ts` = `srv/lib/meetings/enhance.ts`; `detail.tsx` = `ui/pages/meetings/detail.tsx`; `speakers.tsx` = `ui/pages/meetings/speakers.tsx`; `en.json`, `template.json`, `locales.test.ts` = files in `ui/locales/`; `meeting-types.ts` = `packages/validations/src/meeting-types.ts`. A file called "new" or "planned" does not exist at the baseline.

### 8.1 Current state

- A segment is a `Fragment` of three grid cells with no row element, handler or test id (`detail.tsx:830-872`). The renderer segment type has `id` and `enhancedText` (`ui/pages/meetings/types.ts:12,15`). The server adds both fields to each segment (`loadMergedTranscript`, `meetings.ts:271-272`) and `GET /:id/transcript` returns them (`meetings.ts:2208-2212`).
- An Enhance failure is `useState`, lost on reload. Only the 502 answer carries a `reason`; 404, 409, 500 give none and the renderer uses `"provider"` (`detail.tsx:79-89,364-375`; `meetings.ts:2104-2199`). A failed auto-run shows nothing (`meetings.ts:1103-1117`). Summarize failures use in-memory `job_error` (`detail.tsx:418-419`).
- A dropped speaker proposal writes no `meeting_speakers` row. The evidence guard skips it before it enters `nameProposals` (`enhance.ts:587-599`). A later chunk that names the same label differently also loses: the earlier chunk wins (`enhance.ts:608-616`). The upsert runs over `nameProposals` only (`enhance.ts:658-672`). Enhance never deletes a row, so an older row stays when a later run drops its proposal (`enhance.ts:668-672`). The only explicit `DELETE FROM meeting_speakers` statements are in re-transcribe (`meetings.ts:1552`) and re-diarize (`meetings.ts:1828`), and each removes all rows of the meeting. `GET /:id/speakers` is read-only and writes no row (`meetings.ts:1863-1942`). `summary.llm_provider`, `llm_model`, `cost_usd` reach the client (`meetings.ts:2226-2239`; `meeting-types.ts:59-65`). No file under `ui/pages/meetings/` reads them (`grep`, 2026-10-17), so the Summary tab shows none (`detail.tsx:894-921`).
- `advanced_mode` is a settings key (`packages/validations/src/settings-keys.ts:6`). Only renderer files read it, each as `=== "true"`: `ui/shell.tsx:179`, `ui/pages/models/index.tsx:40`, `ui/pages/help.tsx:149`, `ui/pages/settings.tsx:516`. `ui/pages/settings.tsx:726-729` writes it. No file in `apps/server` reads it (`grep`, 2026-10-17). `detail.tsx:177` reads the settings query for `calendarEnabled` only, so the inspector gate reuses that query (8.5). A bearer-token middleware guards every route except `/api/health` (`srv/index.ts:76`; `srv/lib/auth.ts:47,67`). When the embedded server runs on a loopback host with no explicit token, a request from a trusted renderer origin, or with no Origin, also passes without the token (`srv/lib/auth.ts:55-58,69-74`; `srv/index.ts:198-203`).
- Pane width: 1152 px window (`apps/electron/src/main/windows/settings-window.ts:66`) - 220 sidebar (`ui/shell.tsx:231`) - 96 padding (two sides of 48 px: `padding-inline: 3rem` at the default 16 px root font size, `ui/globals.css:350-352`; the file sets `font-size` only on `body`, `ui/globals.css:192`) - 262 list - 24 gap (`ui/pages/meetings/index.tsx:189`) = 550 px. A 320 px right column leaves 230 px: too narrow. No `Sheet` component exists: `ui/components/ui/` has no sheet file, and no `.ts`, `.tsx` or `.json` file in `apps` or `packages` names one (`find` and `grep`, 2026-10-17). `DESIGN.md:269` says side panels use `Sheet`, so it names a component that the repo lacks.

### 8.2 Decisions of this section

- I1: No server `advanced_mode` gate. It is a display preference; the data is the kind the transcript API already serves; the auth middleware guards the route like every other route (8.1); the renderer is the only client.
- I2: The renderer shows every inspector entry only when `advanced_mode` is `"true"`.
- I3: The failure notice is not an inspector part. It shows for all users from the persisted run status (8.9).
- I4: The panel is a non-modal overlay at the bottom of the detail pane. It neither dims nor blocks the transcript.
- I5: Routes send two sizes, light summary and full call. The renderer asks for one full call at a time.

### 8.3 API

The two routes go in a new sibling router `S/routes/meetings-runs.ts` (3.1, 11.4). The file does not exist at the baseline. The nearest sibling router at the baseline is `S/routes/meetings-import.ts`, which has one route, `POST /import` (`S/routes/meetings-import.ts:109`). `S/routes/index.ts` mounts `meetings` and then `meetingsImport` on `/meetings` (`S/routes/index.ts:47-48`). It will mount `meetingsRuns` the same way, with `.route("/meetings", meetingsRuns)` after `meetingsImport`, so the client path stays `api.meetings[":id"]["llm-runs"]`. The client already reads a sibling router on a shared base path (`.route("/transcribe", transcribePreWarmRoute)`, `S/routes/index.ts:43-44`; `E/renderer/src/pages/pill/use-dictation-session.ts:191`). Use the 404 pattern of `meetings.ts:1863-1867` and `zValidator("query", ...)` (`srv/routes/history.ts:44`). The route handlers live in `S/routes/meetings-runs.ts`. The queries (7.8) and the mapping to camelCase answers live in the new file `S/lib/meetings/llm-record-read.ts`, which does not exist at the baseline either. Answers use camelCase.

**GET /api/meetings/:id/llm-runs**: `run_id` (one run with all steps in `seq` order; unknown id 404); `limit` (1 to 50, default 10; newest first). Without `run_id`, each run lists only `failed`, `partial`, `interrupted` or `running` steps. `latest="1"`: the newest run of each kind with its failed steps, for the notices of 8.9; it excludes `run_id` and `limit`. Answer `LlmRunListResponse`, ending `satisfies LlmRunListResponse` (as `meetings.ts:2253`).

**GET /api/meetings/:id/llm-calls**: `call_id`; `run_id` + `step_key` (attempts of one step); `target_type` (`segment`|`speaker`|`summary`) + `target_id` (optional for `summary`); `failed="1"`; `detail` (`summary` default | `full`); `limit` (1 to 50, default 20; `full` max 10).
1. Exactly one selector: `call_id`; or `run_id`+`step_key`; or `target_type`+`target_id`; or `run_id` alone; or `failed`; or none. A mixed query gets 400.
2. `detail=full` needs one of the first three selectors, else 400 with a message.
3. A `summary` target returns the calls of the run that made the current summary. A `speaker` target returns the proposal calls of the producing run with that label's links. A `segment` target returns at most one call. All use 7.8.
4. No record: `200` with `{ "calls": [] }`. Unknown meeting: 404. Query values are strings; the schema coerces numbers.

Sizes: `llm-runs` 1 to 10 KB (20 to 40 KB for one run of 120 steps); `llm-calls` about 1 KB each, `full` about 15 KB.

### 8.4 Types

In `meeting-types.ts`, which holds types only (`meeting-types.ts:3-5`; exported at `packages/validations/src/index.ts:12`). WP2 declares there the types below, and also `LlmMessage` and `LlmParamsLedger` (7.5), `SpeakerVerdict`, `DropReason`, `EvidenceType` and `VerdictStatus` (4.4), and `CorrectionDropReason` (4.2). This is the V half of rule B (5.1). WP3, WP5a and WP5b import these types and declare none again.

```ts
export type LlmRunKind = "enhance" | "summarize";
export type LlmRunStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted" | "unknown";
export type LlmStepStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "skipped" | "cancelled" | "interrupted" | "unknown"; // partial: some halves of the step ended ok, others failed (4.0.7)
export type LlmTargetType = "segment" | "speaker" | "summary";   // outcome: "applied" | "dropped"
export interface LlmStepInfo {
  key: string; node: string; status: LlmStepStatus;
  seq: number;             // start order of the step in the run, from 1 (7.4, 7.7 rule 3). The Run view sorts by it
  attempts: number;        // calls started
  recordedCalls: number;   // call rows that exist; less than attempts = gap
  errorKind: string | null; errorDetail: string | null;
  startedAt: number | null; finishedAt: number | null;
}
export interface LlmRunInfo {
  id: string; kind: LlmRunKind; startedBy: "auto" | "button"; // the original trigger. A resume never changes it (3.4.3)
  resumeCount: number;     // llm_runs.resume_count. Above 0 means the run was resumed
  status: LlmRunStatus;
  graphVersion: number; startedAt: number; finishedAt: number | null;
  errorKind: string | null; errorDetail: string | null;
  callCount: number; failedCallCount: number;
  correctedCount: number | null; suggestionCount: number | null; lostRecords: number;   // 7.4
  inputTokens: number; outputTokens: number; reasoningTokens: number;  // sums; unknown = 0
  steps: LlmStepInfo[];
}
export interface LlmRunListResponse { runs: LlmRunInfo[] }
export interface LlmLinkInfo {
  id: number; callId: number; targetType: LlmTargetType; targetId: string;
  outcome: "applied" | "dropped" | "unknown"; reason: string | null; appliedText: string | null;
  verdict: SpeakerVerdict | null;   // the 4.4 shape
  staleLabels: boolean;   // speaker links: the clustering changed since the run (7.8)
}
export interface LlmCallSummary {
  id: number; runId: string; stepKey: string; node: string; attempt: number; retryReason: string | null;
  provider: string | null; requestedModel: string | null; servedModel: string | null;
  finishUnified: string | null; finishRaw: string | null;
  inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; cachedTokens: number | null;
  queuedMs: number | null; latencyMs: number | null;
  errorKind: string | null; errorDetail: string | null;
  startedAt: number; finishedAt: number; links: LlmLinkInfo[];
}
export interface LlmCallFull extends LlmCallSummary {
  messages: LlmMessage[];
  schema: { name: string; version: number; json: unknown };
  params: LlmParamsLedger | null;   // null when params_json does not parse
  rawText: string | null; parsed: unknown | null; reasoningChars: number | null;
  attempts: { callId: number; attempt: number; finishUnified: string | null;
              errorKind: string | null; latencyMs: number | null }[];  // all calls of the step
}
export type LlmCallsResponse =
  | { detail: "summary"; calls: LlmCallSummary[] }
  | { detail: "full"; calls: LlmCallFull[] };
```

A JSON column that does not parse becomes `null`. The route never fails on bad stored JSON. A status, outcome or error kind that the code does not know reads as `unknown` (7.2 P7).

### 8.5 Renderer data layer

Add to `queryKeys.meetings` (`ui/lib/query.ts:50-61`):

```ts
llmRunsLatest: (id: string) => ["meetings", "llm-runs", id, "latest"] as const,
llmRuns: (id: string, runId?: string) => ["meetings", "llm-runs", id, runId ?? "all"] as const,
llmCalls: (id: string, selector: string) => ["meetings", "llm-calls", id, selector] as const,
```

Client (hyphen path, as `["retry-failed"]`, `detail.tsx:269-277`): `getClient().api.meetings[":id"]["llm-runs"].$get({ param: { id }, query: { limit: "10" } })`.
- `llmRunsLatest(id)` (`latest=1`, 8.3) is enabled when `hasTranscript`, not gated by advanced mode. It feeds the notices of 8.9. A list of the newest 10 runs would lose a failed Summarize notice after 10 newer Enhance runs. `llmRuns(id)` (limit 10, the Runs view), `llmRuns(id, runId)` and `llmCalls(id, selector)` run only when `advancedMode` is on and the panel shows that view.
- `resumeRun(runId)` posts to `POST /api/meetings/:id/runs/:runId/resume` (3.4.2), then refetches `llmRunsLatest` and the detail query, so the one-second poll starts.
- Invalidation: add `["meetings","llm-runs",id]` and `["meetings","llm-calls",id]` to the job-end effect (`detail.tsx:192-206`), and fire it when a Summarize job ends too. While the panel is open and a job runs, open queries refetch every 2 s (the detail query polls every 1 s only while the status is `transcribing` or the job kind is `summarize` or `enhance`; otherwise `refetchInterval` returns `false`, `detail.tsx:122-127`).

```ts
type InspectorTarget =
  | { kind: "runs" } | { kind: "run"; runId: string }
  | { kind: "segment"; segmentId: string } | { kind: "speaker"; label: string } | { kind: "summary" };
const [inspector, setInspector] = useState<InspectorTarget | null>(null);
const selectedSegmentId = inspector?.kind === "segment" ? inspector.segmentId : null;
const advancedMode = appSettings?.[SETTINGS_KEYS.advancedMode] === "true";   // appSettings: detail.tsx:177
const inspectorVisible = advancedMode && inspector !== null;
```

When the setting turns off, the panel unmounts and every entry disappears. `inspector` stays in memory until the view drops (`key={activeId}`).

### 8.6 Entry points and layout

**Edited text (main entry).** The segment `Fragment` (`detail.tsx:831-872`) becomes `<div className="contents" data-testid="meetings-segment" data-segment-id={seg.id}>`. The three grid items stay; the key is `seg.id` with the old key as fallback (`detail.tsx:834-836`). When `advancedMode && seg.id && seg.enhancedText !== undefined`, the text becomes `<button type="button" data-testid="meetings-segment-inspect" title={t("meetings.inspector.inspectCorrection")} aria-expanded={selectedSegmentId === seg.id}>` (no `aria-label`: it would replace the text as the accessible name, and a screen reader would lose the transcript) (dotted underline; grey `bg-accent` when selected) that opens the Call view. It shows in both modes of the Enhanced/Raw switch (`detail.tsx:96,437-439,800-815`). A button in a `<p>` is valid HTML (https://html.spec.whatwg.org/multipage/grouping-content.html#the-p-element). UNVERIFIED: `display: contents` on a `div` in Electron 39 Chromium, and Playwright visibility of it.

**Other entries** (advanced mode only): toolbar button `meetings-inspector-open` (`detail.tsx:579-580`) opens Runs. "Inspect" on each speaker row (`speakers.tsx:146-153`; none today) opens Speaker; the dialog is modal (`speakers.tsx:303-304`), so `onInspectSpeaker(label)` closes it first. "Inspect" in the Summary tab opens Summary. It goes next to the Summary `CopyButton` (`detail.tsx:906-911`). No Inspect entry exists there today. "Show details" in the failure notice (8.9) opens Run. A label whose proposals were all dropped still gets a row in the speakers answer, because segment labels drive that query (`meetings.ts:1869-1878,1909`). The answer has no field for dropped proposals today (`meetings.ts:1909-1927`). The Speaker view will show them (8.7; 7.8 Speaker 2 and 3).

**Panel.** `<aside role="complementary" aria-label>` as the new last child of the root `<div>` that `MeetingDetailView` returns. The component spans `detail.tsx:60-983` and its returned JSX spans `detail.tsx:459-981`. No `aside` exists there today; the last child at the baseline is the re-diarize `AlertDialog` (`detail.tsx:960-980`). Style: `sticky bottom-0`, `max-h-[min(60vh,28rem)]`, `bg-card`, as wide as the pane. The pane is 550 px at a 1152 px window, where the page padding is 3rem on each side (`ui/globals.css:350-352`). It is 330 px at 900 px, where the two columns start (`ui/pages/meetings/index.tsx:189`) and the page padding is 2rem on each side (`ui/globals.css:363-368`, which applies from 821 to 1080 px; below 821 px the padding is 1rem, `ui/globals.css:377-382`). The settings window opens at 1152 by 648 px and has a minimum of 720 by 480 px (`apps/electron/src/main/windows/settings-window.ts:66-69`). No window of 900 px exists in code: 900 px is a CSS breakpoint. The design holds at 330 px, and blocks scroll sideways. The transcript stays clickable. The scroll container gets `scroll-padding-bottom` equal to the panel height, and opening the panel calls `scrollIntoView({ block: "nearest" })` on the clicked row, so the row sits above the panel. Not `Dialog` (dims and blocks, `ui/components/ui/dialog.tsx:34-48`), not `Popover` (288 px, `ui/components/ui/popover.tsx:30`), not a right column (230 px). UNVERIFIED: `sticky` in this scroll container (`ui/pages/meetings/index.tsx:183-186`). The proof checks 1152 by 648 px (the default window, `apps/electron/src/main/windows/settings-window.ts:66-67`), 720 by 480 px (the minimum window, `settings-window.ts:68-69`) and 900 by 600 px. The third size is this spec's choice: it sits on the two-column breakpoint (`ui/pages/meetings/index.tsx:189`), and no code defines a window of that size. `Escape` closes the panel and returns focus. The close button has test id `meetings-inspector-close`. No focus trap.

```mermaid
stateDiagram-v2
  [*] --> Closed
  Closed --> Call: click edited text
  Closed --> SpeakerList: Inspect on a speaker row
  Closed --> SummaryList: Inspect on the Summary tab
  Closed --> Runs: toolbar button or Show details
  Runs --> Run: select a run
  Run --> Call: select a step
  SpeakerList --> Call: select a proposal
  SummaryList --> Call: select a call
  Call --> Call: select an attempt
  Call --> Closed: close or Escape
  Runs --> Closed: close or Escape
  SpeakerList --> Closed: close or Escape
  SummaryList --> Closed: close or Escape
  Run --> Runs: back
  Call --> SpeakerList: back
  Call --> SummaryList: back
  Call --> Run: back
```

`Back` returns to the opener. A click on edited text opens the Call view with no view behind it, so it has no `Back`.

### 8.7 Panel content

New files `ui/pages/meetings/llm-inspector.tsx` (panel, views) and `llm-call-view.tsx` (call detail), imported from `detail.tsx`. The `knip` gate needs each new file to be imported, or listed in `knip.jsonc` (`AGENTS.md:85`). Importing from `detail.tsx` is this spec's choice.

**Call view.** Blocks in order: Attempts (`recordedGap` when `attempts` > `recordedCalls`); Overview (provider, requested vs served model with a destructive line if different, finish reason and raw value, token counts, queue wait, latency); Error (shown when `errorKind` is set, even if `parsed` exists); Change (segment target only: "Before" raw text, "After" applied text, count of changed segments); Dropped corrections (each drop of this call with its reason, 7.5); Messages sent (open); Output schema; Parameters (request fields, extra body fields, "Not sent" with reasons, source); Raw response (open; `noResponse` when null); Parsed object (the validator message from `errorDetail` when null); copy buttons. A mono block is `<pre className="mono ...">` with `overflow-auto` (like `ui/components/markdown.tsx:47-48,55-59`). Copy buttons reuse `CopyButton` (`ui/pages/meetings/shared.tsx:62-80`). UNVERIFIED: a 500,000-character `pre` in the slowest case.

**Speaker view.** One row per link of the producing run: step key, name, kind, evidence in mono, and a badge "Kept" or "Dropped" (outline style, because a drop is not a failure) with the reason. "Current" when `appliedText` equals the current suggestion (7.8 Speaker 1; planned, 10.10). The renderer already holds the suggestion as `suggestedName` in the speakers query (`detail.tsx:160-172`; `ui/pages/meetings/types.ts:41`). No "Current" badge and no `appliedText` exist at the baseline (`grep`, 2026-10-17). "Spelling fixed to {{name}}" when respelled; a link to `winnerCallId`; failed calls in destructive style. Data: `GET /llm-calls?target_type=speaker&target_id=<label>` (`summary`), then `call_id` (`full`).

**Summary view.** Calls of the run that made the current summary ("Single", or "Map 1" to "Map N", then "Reduce"). The label comes from the `step_key` of the call (4.0.7): `single` is "Single", `map:<i>` is "Map" with the number `i + 1`, and `reduce:<level>:<group>` is "Reduce" (a transcript with several levels adds the level and the group). A half such as `map:2/0` shows as a part of "Map 3". The view header shows `llm_provider`, `llm_model` and `cost_usd` of the current summary. They come from the `summary` object of the meeting detail (`meeting-types.ts:59-65`), not from a run row: the `llm_runs` table has no such columns (7.4). A NULL cost means an unknown price (`srv/lib/meetings/summarize.ts:512-515`). Data: `target_type=summary` (`summary`).

**Runs view.** Runs newest first. "Failures" on top: each `failed`, `partial` or `interrupted` step of the newest run of each kind opens the Call view for its last attempt (for a `partial` step, the last attempt of the first failed half). A run opens the Run view (steps in `seq` order, the start order of 7.4). A step with no call row shows its error in a block.

**Empty states.** `noRuns` (Runs view and toolbar button still open). `noRecord` for an edited text with no call, a stale link, a flag-off run or a pre-feature meeting (the panel does not guess). `recordLost` when `lostRecords` of the run is above 0: calls ran, but their record write failed. `loadFailed` with a retry button. A neutral loading line.

### 8.8 Design tokens

Panel `bg-card`, `border-border` (`ui/components/ui/dialog.tsx:65`). Selected text (8.6) and the selected attempt use `bg-accent`. This is a choice of this spec for both. The token is neutral and serves hover, focus and "selected preview" states (`specs/design-system.md:176-182`). Prompts, responses, JSON, ids and numbers use `.mono` (`ui/globals.css:218`) and `tabular-nums`, as the progress count does (`detail.tsx:638`). A mono JSON field exists today (`ui/pages/models/param-json-editor.tsx:105`). Failures use `InlineNotice tone="destructive"` with `className="mb-3"` (the tone is at `ui/components/inline-notice.tsx:4-7`; the default `mb-5` is at `:26`; existing uses are `detail.tsx:722` and `:764`). Failures also use `Badge variant="destructive"`, and neutral badges use `Badge variant="outline"` (`ui/components/ui/badge.tsx:20-23`). `StatusBadge` maps `failed` and `interrupted` to `destructive` and every other status to `outline` (`ui/pages/meetings/shared.tsx:29-32,43`). No blue (`accent-passive`, `specs/design-system.md:150-156`). No coral (`--live`: record, live and in-progress only, `specs/design-system.md:172-175`); a running step uses a neutral badge (choice of this spec).

### 8.9 Persisted run status replaces the component Enhance error state

Today any non-2xx JSON answer sets `enhanceFailure` (`detail.tsx:87-89,364-375`), a reload clears it, and a 404, 409 or 500 shows the "provider" text. With the flag on, the notices are a function of the newest run of each kind, read from `llm-runs?latest=1` (8.3, 8.5). The generic `actionError` notice still shows other non-2xx answers (`detail.tsx:719-725`). With the flag off, the old state and notice stay until WP11 (R19).

```ts
const runs = llmRunsLatest.data?.runs ?? [];
const latest = (kind: LlmRunKind) => runs.find((r) => r.kind === kind);
const noticeRun = (kind: LlmRunKind) => {
  const r = latest(kind);
  return !jobHoldsSlot && r && ["failed", "partial", "interrupted"].includes(r.status) ? r : null;
};
```

**Lines (all users, D4, G4).** A notice lists one line for each distinct error kind among the steps of the run with status `failed` or `partial`, for example "Corrections, chunks 4, 7: The model reached its output limit." A `partial` step (a chunk with one failed half) counts as failed here, because part of its text was not corrected (4.0.7). A line holds a node label, the chunk numbers for `correctChunk`, and the `meetings.llmError.<kind>` text. It holds no prompt text. A run with no failed step (`budget_exceeded`, `graph_changed`, `transcript_changed`, `interrupted_before_checkpoint`, `internal`) shows one line from `run.errorKind`. The inspector keeps the per-call detail, in advanced mode only.

- `failed`: destructive; `meetings.llmRun.<kind>.failed`; the lines; the button "Start again" (test id `meetings-enhance-retry` for Enhance; `summarize()` for Summarize).
- `partial`: destructive; `meetings.llmRun.<kind>.partial` with failed and total step counts (`{{failed}}` counts the steps with status `failed` or `partial`; `{{total}}` counts the steps of the LLM nodes, so not `prepare`, `verify` or `save`); the lines; "Start again".
- `interrupted`: neutral; `meetings.llmRun.<kind>.interrupted`; the lines when the run has a `failure`. Two buttons. "Resume" (`meetings-run-resume`) calls `resumeRun(runId)` and keeps the finished work (3.4.7). "Start again" starts a new run and discards the checkpoint of the stopped run (3.4.2 step 2); its label says so (`startAgainDiscards`). A resume that fails a guard answers 409 with a `ResumeConflict` (3.4.2). What follows depends on the guard, as in 3.4.7. Guard 4 or 6 (`graph_changed`, `transcript_changed`): the run becomes `failed` and the checkpoint is deleted. The renderer refetches `llm-runs?latest=1`, and the notice shows the `errorKind` as a line with "Start again". Guard 1, 2, 3 or 5 (`meeting_status`, `job_running`, `not_interrupted`, `no_checkpoint`): the run row does not change. The generic `actionError` notice shows the `error` text of the answer (`detail.tsx:211-243, 719-725`), the renderer refetches the run, and the buttons stay. For `no_checkpoint` the button "Start again" is the way forward.
- `succeeded` and `partial` Enhance runs: a neutral note as today (`EnhanceNote`, `detail.tsx:719-740`): `enhanceResult` with `correctedCount`, or `enhanceNoneCorrected` when it is 0. It shows only when the run ended after the page opened. A reload clears it, as today.
- `cancelled`, `running`: no notice. A notice clears when a newer run of that kind ends or a run starts (`jobHoldsSlot`). In advanced mode a notice adds "Show details".
- **WP7 adds** the new notices, the Resume button and their keys (8.10). The old `enhanceFailure` state (`detail.tsx:87-89`), its reset in `runAction` (`:223`), the non-2xx branch of `enhance()` (`:364-375`), the old notice block (`:763-786`) and the `!enhanceFailure` condition (`:719-721`) stay for flag off. **WP11 deletes them.**
- The `POST /:id/enhance` contract is section 3's (3.4.2). With the flag on, the renderer does not read `reason`. Summarize keeps `job_error` for "Cancelled by user" (`detail.tsx:420`; O8-2).

### 8.10 i18n

All user text uses `t()`. New keys go in `en.json` and `template.json` first (`specs/model-picker-groups.md:393`). Other locales may lag; a missing key falls back to English (`locales.test.ts:10-15`). A `meetings.*` key that a locale carries keeps the `en.json` placeholders (`locales.test.ts:461-474`). A key in a test group must exist in `template.json` and in all 7 locale files (`en.json` is one of them), with the `en.json` placeholders (`locales.test.ts:439-455`). The `meetings.*` test does not cover other sections, which have placeholder drift today (`locales.test.ts:457-460`). Locale tests: section 10.

1. **Failure keys** (all users; the `meetings.llmRun.*` and `meetings.llmError.*` keys) join the group `enhance-honesty` (all 8 files, `locales.test.ts:190-203`). WP7 adds them and keeps `enhanceFailedTimeout`, `enhanceFailedParse`, `enhanceFailedProvider` (`en.json:1106-1108`; used `detail.tsx:767-771`; group `locales.test.ts:196-198`), because the flag-off path still shows them. WP11 removes those three keys and their group entries from all 8 files (WP11 acceptance). `enhancePartial`, `retryEnhance`, `enhanceNoneCorrected` stay.
2. **Inspector keys** (advanced only) go in `en.json` and `template.json`; a new test compares their `meetings.inspector.*` key sets.
3. **Flag toggle keys** (advanced only; WP7 adds them, WP11 removes them): `settings.application.enhanceWorkflow` "New Enhance workflow" and `settings.application.enhanceWorkflowDesc` "Use the new Enhance and Summary workflow. It retries failed calls, shows typed errors and keeps call records for the LLM inspector." They go in `en.json` and `template.json` and sit next to `advancedMode` (`en.json:175-176`). Other locales may lag.

`meetings.llmRun.{enhance|summarize}.*` (`<K>` = Enhance or Summarize): `failed` "<K> failed."; `partial` "<K> finished with errors. {{failed}} of {{total}} steps failed."; `interrupted` "<K> stopped when Openstyle closed." Shared keys `meetings.llmRun.*`: `line` "{{where}}: {{reason}}"; `node.correctChunk` "Corrections"; `node.identifySpeakers` "Speakers"; `node.summarize` "Summary"; `node.save` "Saving"; `chunks` "chunks {{list}}"; `resume` "Resume"; `startAgain` "Start again"; `startAgainDiscards` "Start again. This discards the finished work of the stopped run."

`meetings.llmError.*` (the kinds of 7.6, owned by 5.2.1): `length` "The model reached its output limit."; `content_filter` "The provider blocked the answer."; `unexpected_tool_calls` "The model tried to call a tool."; `abnormal_stop` "The model stopped for an unknown reason."; `reasoning_leak` "The model put its reasoning in the answer."; `schema` "The answer did not match the required format."; `provider_timeout` "The model did not answer in time. Raise the timeout in Settings, then retry."; `provider_rate_limited` "The provider limited the requests."; `provider_unavailable` "The model could not be reached."; `provider_auth` "The provider refused the key."; `provider_invalid_request` "The provider refused the request."; `model_mismatch` "The server answered with another model."; `model_unavailable` "Openstyle cannot use the chosen model. Check Settings > Models, then try again."; `deadline_exceeded` "The summary took longer than its time limit."; `budget_exceeded` "The meeting is too long for the summary limit of 24 calls."; `empty_input` "The meeting has no text to process."; `save_failed` "Openstyle could not save the result."; `internal` "Openstyle stopped the run because of an internal error."; `interrupted_before_checkpoint` "Openstyle closed before the run saved any progress. Start again."; `graph_changed` "Openstyle was updated while the run was stopped. Start again."; `transcript_changed` "The transcript changed while the run was stopped. Start again."; `cancelled` "The run was cancelled."; `unknown` "An unknown error occurred." A kind with no key falls back to `unknown`. No text names an action for `budget_exceeded`: no screen sets `meeting_summary_context_budget` (`packages/validations/src/settings-keys.ts:67`; `grep -rn` finds no renderer file that reads it, 2026-10-17).

`settings.application.advancedModeDesc` (`en.json:176`, `template.json:175`) becomes "Show the Models page for manual voice and cleanup model configuration, and the LLM inspector on meetings." Other locales keep their old text, which stays true.

`meetings.inspector.*` (verdict texts: 7.5). Labels are short ASD-STE words named by the UI elements of 8.7. Examples: `title` "LLM inspector"; `retry` "Try again"; `inspectCorrection` "Show the LLM call that changed this text"; `inspectSpeaker`, `inspectSummary` "Inspect"; `paramsDropped` "Not sent"; `runStatus.partial` "Finished with errors"; `stepStatus.pending` "Waiting"; `stepStatus.partial` "Partly failed". Sentences: `noRuns` "No LLM run exists for this meeting."; `noRecord` "No LLM record exists for this item. An older version of Openstyle made it, or no recorded call produced it."; `loadFailed` "The LLM record could not be loaded."; `noResponse` "The call returned no response."; `modelMismatch` "The served model is not the requested model."; `recordedGap` "{{missing}} calls of this step were not recorded."; `speakerLabelNote` "The speaker labels changed after this run. They may name other voices now."; `recordLost` "{{n}} calls of this run have no record, because the write failed."; `respelled` "Spelling fixed to {{name}}"; `changedCount` "This call changed {{n}} segments."; `attempt` "Attempt {{n}} of {{total}}". Groups: `runKind.*`, `runStatus.*`, `stepStatus.*`, `role.*`, `node.{single,map,reduce}`, `verdict.<code>`.

### 8.11 Files that change in section 8

Work breakdown: section 11. WP2 owns the server side of 8.3 and 8.4: `srv/lib/meetings/llm-record-read.ts`, the two routes in `srv/routes/meetings-runs.ts` and the types in `meeting-types.ts`. WP7 owns the renderer. New: `ui/pages/meetings/llm-inspector.tsx`, `llm-call-view.tsx`. Edits: `ui/lib/query.ts`, `detail.tsx`, `speakers.tsx`, `ui/pages/settings.tsx` (the flag toggle row, 8.10), all 8 locale files in `ui/locales/` (`en.json`, `template.json`, `de`, `es`, `fr`, `it`, `ja`, `pt`), `locales.test.ts`.

### 8.12 Tests and proof

Unit and route tests: section 10. Real-app proof (Definition of Done; unit tests alone do not count; details in 10.11.2 and section 11, WP7 and WP9):
1. **UI proof with seeded rows.** Recipe `.claude/skills/live-testing/SKILL.md:206-221` through `scripts/test-runner/run.sh` (`SKILL.md:202`), throwaway spec `apps/electron/tests/zz-proof-llm-inspector.test.ts`. The spec is new: no such file exists at the baseline. The rule is to name it `zz-proof-<topic>.test.ts`, delete it at the end and never commit it (`.claude/skills/live-testing/SKILL.md:210`). Seed with `POST /api/meetings/start`, then `sqlite3` on the isolated database (fictional rows). Set `PUT /settings/advanced_mode` (`apps/electron/tests/model-picker-groups.test.ts:342`). Take screenshots at 1152 by 648 px, 900 by 600 px and 720 by 480 px. Show: advanced off; advanced on after a click (sent messages and raw answer, three columns intact, row visible above the panel); a failed step; a speaker with a dropped proposal; a summary with map and reduce calls; advanced turned off with the panel open; `enhanced_text` with no record. Count `AUTHREQ_PROMPTING` before and after (`SKILL.md:218-220`). Never start a recording.
2. **Read-back proof.** `sqlite3` row counts of the six tables; delete the meeting through the API; all six counts for it must be 0.
3. **Real model proof** (after sections 3 to 5). Enhance on a scratch meeting with the real oMLX Qwen3.8-27B only. The panel messages must equal the request body in the `llm.request` entry for that call in `openstyle-trace.log`. `traceLlmFetch` (`apps/server/src/lib/trace.ts:257-277`) writes that entry at `apps/server/src/lib/trace.ts:268`. It writes the parsed body, or `body_text` when the body is not JSON. The `server` provider installs `createSamplingFetch` as its `fetch` (`apps/server/src/lib/llm/registry.ts:265-274`), and that function calls `traceLlmFetch` (`apps/server/src/lib/llm/registry.ts:156-166`). The finish reason and the token counts must match the `summary` of the `llm.response` entry. `summarizeCompletion` reads `finish_reason` from `choices[0]` and passes `usage` through unchanged (`apps/server/src/lib/trace.ts:184-204`). The entry itself is written at `apps/server/src/lib/trace.ts:229-241`. Only the `server` provider reaches `traceLlmFetch` (`apps/server/src/lib/llm/registry.ts:271`; `grep`, 2026-10-17), so the trace log covers only that provider. The same file also holds STT entries (`apps/server/src/lib/trace.ts:5-8`). `writeTrace` (`apps/server/src/lib/trace.ts:147-159`) sends each entry to `openstyle-trace.log` through `traceLog` (`packages/utils/src/logger.ts:153-168`). `openstyle-trace.log` is a runtime file outside the repo, and it holds full transcripts. This spec did not read it. UNVERIFIED: the content of a real log entry.
4. **Failure proof.** Force a `length` stop with a small output budget. The run ends `partial` or `failed`; the notice shows after a reload; the Failures list shows the step and the typed error.

### 8.13 Open questions for section 12

- O8-1: Is the bottom-docked panel the right placement? UNVERIFIED in the app; the live proof decides. Fallback: a panel over the full pane with a `Back to transcript` button.
- O8-2: Should `job_error` for Summarize go away? The persisted run holds the same failure. Answered in WP11 (11.5): yes.
- O8-3: Does the owner want an "Inspect" entry on the speaker chips in the transcript? 8.6 leaves it out; it adds a second path to the Speaker view.

---

## 9. Tracing

This section defines how a workflow run (Enhance or Summarize) records its LLM calls: trace log, opt-in MLflow export, span model, privacy, bundle size, read-back proof. Section 7 owns the local record (`llm_calls`). Section 5 owns the gateway. Section 2 owns the general current state.

Cite prefixes: `ai:` https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ , `mlflow:` https://github.com/mlflow/mlflow/blob/v3.16.1/mlflow/ , `unpkg:` https://unpkg.com/ , `npm:` https://registry.npmjs.org/ . Bare paths are in the repo at c47cd80d.

**Terms.** run = one workflow execution for one meeting, an Enhance run or a Summarize run (3.4). node call = one execution of a node function (section 4). `correctChunk` has one node call for each chunk. `summarize` has one node call, which opens several `llm_run_steps` rows (section 7: `single`, `map:<i>`, `reduce:<level>:<group>`). Every other node has one node call and one row. LLM call = one model request; a retry is a new one. local record = one `llm_calls` row. trace log = `openstyle-trace.log`. MLflow trace = all spans of one run. export = send of spans over OTLP/HTTP.

### 9.1 Decisions

D4, D5 (`maxRetries: 0`), D8 and D10 (1.1) apply.

| ID | Design decision (the owner can change it) |
|---|---|
| T1 | Two environment variables enable the export. No setting key and no UI in this release. |
| T2 | The gateway passes the OpenTelemetry integration on each call. The code never calls `registerTelemetry`. |
| T3 | The integration is `LegacyOpenTelemetry`. |
| T4 | The exporter posts to `<base>/v1/traces` with header `x-mlflow-experiment-id`. |
| T5 | One run is one trace: run span as root, one child span per node call. |
| T6 | The gateway sets ERROR on the node span and the run span for every typed error. |
| T7 | A tracing fault never changes the result of a run. |
| T8 | Enhance runs and Summarize runs are both exported (default: yes; Q9.6). Dictation cleanup and Remix never are. |

Non-goals: authorization header, metrics, log export, sampling, MLflow run or artifact. The server never creates an MLflow experiment.

### 9.2 Current state (main at c47cd80d)

The repo has no MLflow or OpenTelemetry code (command in 9.9). `AGENTS.md:9` says "no telemetry". Trace log facts: 9.4.

### 9.3 The three records

```mermaid
flowchart LR
  N[Node call] --> G[LLM gateway, section 5]
  G -->|every call| L[(llm_calls in freestyle.db)]
  G --> F[fetch wrapper, registry.ts]
  F -->|provider server only| T[openstyle-trace.log]
  F --> P[Model provider]
  G -.->|only when both env vars are set| O[LegacyOpenTelemetry, per call]
  O --> M[MLflowSpanProcessor, batch]
  M -->|POST /v1/traces, protobuf| S[(MLflow server)]
```

| | Local record | Trace log | MLflow trace |
|---|---|---|---|
| State | Always on (D10) | On when the log folder is known | Off by default (D8) |
| Covers | Every gateway LLM call, retry and failure | `server` provider LLM calls, `server` STT | Enhance and Summarize runs: run and node tree, timing, LLM input and output, tokens, status |
| Retention, reader | Deleted with its meeting; inspector in advanced mode (section 8) | Rotation, about 15 MB; developer | MLflow server owner; owner |

MLflow is not the UI for failures. The step status and the inspector show failures (D4, D10).

### 9.4 The trace log: what stays and why

This feature changes no line of `trace.ts`. Facts:

- It has its own logger and file (5 MB, 3 files) and never feeds `openstyle.log` (`packages/utils/src/logger.ts:17-19,111-123`). It writes once the log folder is set (`logger.ts:117-119`) and catches its own write errors (`apps/server/src/lib/trace.ts:148-159`).
- Only the `server` provider is traced, by `createSamplingFetch`: the only `fetch:` option and the only place that sees the final body after the sampling merge (`apps/server/src/lib/llm/registry.ts:151-169,265-274`). `server` STT writes its own entries (`apps/server/src/lib/streaming/providers/server.ts:86`).
- The wire summary holds `finish_reason`, `usage` and `reasoning_content_chars`; a transport failure writes `llm.error` (`trace.ts:184-204,290-299`). Redaction covers only `Authorization` and `api_key` (`trace.ts:29-49`). The correlation id is per HTTP request (`apps/server/src/index.ts:79-84`); a `void` job in a handler most likely shares it (UNVERIFIED by a run; `apps/server/src/routes/meetings.ts:1043,1564,2093`).

It stays because it proves the exact wire body and covers call sites outside the gateway. Limits: no meeting id, node name or typed error; no Groq or cloud providers; deleting a meeting keeps its lines; the inspector does not read it.

### 9.5 MLflow export

#### 9.5.1 Gate

The export is off by default, so "no telemetry" stays true (`AGENTS.md:9`). It is on only when both variables hold a value.

| Variable | Meaning |
|---|---|
| `OPENSTYLE_MLFLOW_TRACKING_URI` | Base URL, starts with `http://` or `https://`. Example `http://192.168.31.154:5000`. |
| `OPENSTYLE_MLFLOW_EXPERIMENT_ID` | Experiment id, sent as header `x-mlflow-experiment-id`. Example `12`. |

1. If a variable is empty or missing, the export stays off. If exactly one is set, the server writes one warning at start. A silent "off" is a known trap (`/Users/maheidem/.claude/CLAUDE.md:70-72`).
2. At start the server writes one line: `MLflow tracing: off`, or `on host=<host> experiment=<id>`. It never holds the full URL.
3. The `OPENSTYLE_` prefix stops a global `MLFLOW_TRACKING_URI` from enabling the export. The server reads the variables once, at start. This spec adds no old-name alias (Okto Neuron has one: `/Users/maheidem/Documents/dev/OktoLabsAI/okto-neuron/src/okto_neuron/_compat.py:105-127`).
4. The server child inherits the app environment (`apps/electron/src/main/server-host.ts:201-206`). A Finder launch does not read shell variables. UNVERIFIED on this Mac.
5. Update `AGENTS.md:9` in the same PR: the opt-in MLflow export is the only other outbound call, off unless both variables are set.

#### 9.5.2 Packages

All Apache-2.0 (`npm:<pkg>/<version>`). Pin exactly. `@ai-sdk/otel` needs `ai` 7.0.143 exactly (`npm:@ai-sdk/otel/1.0.143`), so the pins move with the v7 upgrade (D7, section 6). Only `@opentelemetry/api` loads when the export is off.

| Package | Version | Role |
|---|---|---|
| `@opentelemetry/api` | 1.9.1 | `trace`, `context`, `SpanStatusCode`; no-op without a provider. Direct dependency of `apps/server`: `ai` 6.0.191 brings it (`pnpm-lock.yaml:7348-7354`), `ai` 7.0.143 does not (`npm:ai/7.0.143`). |
| `@ai-sdk/otel` | 1.0.143 | `LegacyOpenTelemetry` (ESM only) |
| `@mlflow/vercel` | 0.4.0 | `MLflowSpanProcessor`: translates `ai.*` attributes, then batches (CommonJS) |
| `@opentelemetry/sdk-trace-node` | 2.12.0 | `NodeTracerProvider`, AsyncLocalStorage context manager |
| `@opentelemetry/sdk-trace-base` | 2.12.0 | Peer of `@mlflow/vercel` |
| `@opentelemetry/exporter-trace-otlp-proto` | 0.223.0 | OTLP/HTTP protobuf exporter |

Do not install `@mlflow/core` (19.9 MB, `npm:@mlflow/core/0.4.0`); `@mlflow/vercel` inlines the span type names (`unpkg:@mlflow/vercel@0.4.0/dist/translate.js`, line 5). 6.6 F1 covers the ESM case for `ai`; the build check is WP8 (9.8).

#### 9.5.3 Wiring

New file `apps/server/src/lib/llm/tracing.ts` (WP8).

```ts
export interface Tracing { on: boolean; tracer: Tracer; integrations: TelemetryOptions["integrations"]; // off: no-op tracer, undefined
  forceFlush(): Promise<void>; shutdown(): Promise<void> }
export const getTracing: () => Tracing;                         // the gateway reads it per call
export function startTracing(env: NodeJS.ProcessEnv): Promise<Tracing>;   // once, after configureNetwork() (index.ts:207)
export const stopTracing: () => Promise<void>;                  // race(shutdown, 2000 ms); re-export at index.ts:242-246
```

`startTracing` steps:

1. Read both variables with `trim()`. If one is missing, empty, or the base lacks `http(s)://`, return OFF (9.5.1 warning rules apply).
2. Load by `import()` in one `Promise.all`: `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@mlflow/vercel`, `@ai-sdk/otel`.
3. `new NodeTracerProvider({ spanProcessors: [new MLflowSpanProcessor(new OTLPTraceExporter({ url: base.replace(/\/+$/, "") + "/v1/traces", headers: { "x-mlflow-experiment-id": id } }))] })`, then `provider.register()`.
4. Return `{ on: true, tracer, integrations: [new LegacyOpenTelemetry({ tracer })], forceFlush, shutdown }` with `tracer = provider.getTracer("openstyle")`.
5. On any throw, log the reason once and return OFF (T7).

The gateway passes the integration on each call (section 5):

```ts
const tracing = getTracing();
await generateText({ model, maxRetries: 0 /* D5 */, output: Output.object({ schema }),
  telemetry: tracing.on ? { functionId: `openstyle.${node}`, integrations: tracing.integrations } : { isEnabled: false } });
```

- `register()` is required. Without a context manager `context.active()` is empty (`unpkg:@opentelemetry/api@1.9.1/build/src/context/NoopContextManager.js:10-11`). The integration starts each root span with no explicit context. For `ai.generateText` this is `ai:otel/src/legacy-open-telemetry.ts#L380-L381`. The other operations do the same (`#L317`, `#L448`, `#L620`, `#L1213`, `#L1314`). So the root span of each AI SDK call starts its own trace, and no node span becomes its parent. The child spans pass an explicit context: `state.rootContext` or `state.stepContext` (`#L510`, `#L696`, `#L728`, `#L1145`, `#L1257`, `#L1401`). They join the trace of their own root span. So one AI SDK call gives one trace, not one trace for each span.
- `MLflowSpanProcessor` batches itself: add no second batch processor (`unpkg:@mlflow/vercel@0.4.0/dist/processor.js:28-39`). Use the v7 key `telemetry`, not the deprecated alias `experimental_telemetry` (`unpkg:ai@7.0.143/dist/index.d.ts`, lines 5387-5393).

#### 9.5.4 Why the integration is per call (T2)

- Dictation cleanup and Remix call the AI SDK outside the gateway (`packages/stt/src/post-process.ts:125`; `apps/server/src/lib/remix-transform.ts:132`; `apps/server/src/lib/remix-agent.ts:103`). A global integration from `registerTelemetry` (docs https://ai-sdk.dev/docs/ai-sdk-core/telemetry) would send dictated text to MLflow. T8 forbids that. A per-call integration overrides global ones, and the code registers none, so a call without one emits nothing (`ai:ai/src/telemetry/create-telemetry-dispatcher.ts#L108-L133`). `{ isEnabled: false }` returns no integration (`#L123-L127`).
#### 9.5.5 Why `LegacyOpenTelemetry` (T3)

- `MLflowSpanProcessor` acts only on spans with `ai.operationId` (`unpkg:@mlflow/vercel@0.4.0/dist/translate.js`, lines 15-29, 72-131). `LegacyOpenTelemetry` sets it (`ai:otel/src/assemble-operation-name.ts#L18`). The new `OpenTelemetry` integration does not (`ai:otel/src/open-telemetry.ts`, 0 hits); it emits `gen_ai.*` spans. How MLflow 3.16.1 renders them: UNVERIFIED. Revisit T3 when `@mlflow/vercel` supports `gen_ai.*`. Removal date of the legacy integration: UNVERIFIED.

#### 9.5.6 Endpoint and header (T4)

The author probed two documented paths on the owner's MLflow 3.16.1 on 2026-10-17 (twice, same codes; empty POST body, no experiment id; nothing stored).

| Path | Documented in | Result |
|---|---|---|
| `/v1/traces` | https://mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest/ | Route exists. HTTP 422, header `x-mlflow-experiment-id` required. |
| `/api/2.0/otel/v1/traces` | `unpkg:@mlflow/vercel@0.4.0/README.md`, lines 41, 60 | HTTP 404 (same as the control `/v1/does-not-exist`). |

Decision: use `/v1/traces`. Do not use the README path. The 3.16.1 source agrees: POST only, header required, body `application/x-protobuf` or `application/json`, no spans gives 400, one batch is all or nothing (`mlflow:server/otel_api.py#L97,#L100,#L139-L143,#L168-L171,#L117-L119`). The minimum MLflow version is 3.6.0, OTLP/HTTP only (docs URL above). Test: check C1.

### 9.6 Span model (T5, T6)

#### 9.6.1 Tree and rules

```text
meeting.<kind>                        run span, root, WORKFLOW. <kind> is enhance or summarize (llm_runs.kind)
  node.prepare                        CHAIN, code node, no LLM child
  node.correctChunk (chunk:0)         CHAIN, step_key in brackets; one sibling for each chunk
    ai.generateText                   LLM, from the AI SDK
      ai.generateText.doGenerate      LLM, from the AI SDK
  node.identifySpeakers               CHAIN
  node.verifyEvidence                 CHAIN, code node
  node.summarize                      CHAIN, one node call. Its single, map and reduce calls are its LLM children
  node.save                           CHAIN, code node
```

Node ids are `NodeId` (section 4). Step keys are `llm_run_steps.step_key` (section 7).

1. The run span is the root, started with `ROOT_CONTEXT`. The code keeps run contexts in an in-memory `Map<runId, Context>`. Graph state holds only the run id, because the checkpoint saver serializes state (section 7).
2. **Where the spans open (WP8).** `guardNode` in `W/unit.ts` wraps every node body (4.0.2). WP8 opens each node span there: `guardNode` calls `inNode(t, runId, node, attrs, body)` around the body, inside its own `try`. A throw in the body ends the span with ERROR first, and `guardNode` then turns it into a typed `internal` failure. WP8 edits no node file. The runner in `W/runner.ts` (WP5b) opens and ends the run span. `execute` calls `startRunSpan` before `graph.invoke`, and `endRunSpan` after it writes the final status (3.4.6 step 3). `resumeRun` calls `startRunSpan` again (rule 5).
3. `inNode` starts its span with `startActiveSpan(name, options, context, fn)` and the stored context (`unpkg:@opentelemetry/api@1.9.1/build/src/trace/tracer.d.ts`, line 71). It does not rely on propagation through the LangGraph runner. AI SDK spans still need the registered context manager (9.5.3).
4. A retry is a new LLM call under the same node span. The gateway adds event `attempt.failed` (`attempt`, `error_kind`, `delay_ms`) per failed attempt.
5. A resumed run (D6) starts a new trace with the same `openstyle.run_id` and `openstyle.resume_count` above 0. The first trace stays IN_PROGRESS, because state comes from the root span (`mlflow:store/tracking/sqlalchemy_store.py#L5386`). UI display: UNVERIFIED.
6. `mlflow.spanType` is `WORKFLOW` (run) and `CHAIN` (node). MLflow allows custom strings (`mlflow:entities/span.py#L71-L91`); the processor keeps an existing value (`translate.js`, line 80).

#### 9.6.2 Attributes

Our code sets only these `openstyle.*` attributes.

| Attribute | On | Value |
|---|---|---|
| `run_id`, `meeting_id` | run | `llm_runs.id`, `llm_runs.meeting_id` (opaque) |
| `kind` | run | `enhance` or `summarize`: `llm_runs.kind`. The span name is `meeting.<kind>` too. The attribute lets a query find the Summarize runs without the name |
| `outcome` | run | final `llm_runs.status`: `succeeded`, `partial`, `failed`, `cancelled`. An `interrupted` run never ends its span. |
| `started_by` | run | `auto` or `button`: the original trigger, as in `llm_runs.started_by` |
| `resume_count` | run | `llm_runs.resume_count`. 0 for the first trace of a run, above 0 for a trace after a resume |
| `node`, `step_key`, `attempts` | node | `NodeId`; `llm_run_steps.step_key` (e.g. `chunk:3`), absent on `node.summarize` because it opens several rows; the sum of the final `llm_run_steps.attempts` over the rows of the node call |
| `llm_call_ids` | node | string array of `llm_calls.id`, one per attempt of the node call. Join key to the local record. |
| `finish_reason`, `raw_finish_reason` | node | `llm_calls.finish_unified`, `finish_raw`, last attempt. The AI SDK span holds only the unified one (`rawFinishReason` has 0 hits in `ai:otel/src/legacy-open-telemetry.ts` and `ai:otel/src/open-telemetry.ts`). |
| `model_requested`, `model_served` | node | `llm_calls.requested_model`, `served_model`. A mismatch is an error (section 5). |
| `param_ledger` | node | `llm_calls.params_json`, last attempt. No prompt text. |
| `error_kind` | node | `llm_run_steps.error_kind` of the first failed row of the node call (sections 4, 5, 7) |

MLflow keeps only input, output and total tokens (`translate.js`, lines 187-208); the local record keeps the reasoning count.

#### 9.6.3 Status rules

The AI SDK sets ERROR for three causes (`ai:otel/src/legacy-open-telemetry.ts`):

- Finish reason `error`: on the step span `ai.generateText.doGenerate` (`#L776-L778`) and on the root span `ai.generateText` (`#L991-L993`). Both conditions compare with `error` only. For `LegacyOpenTelemetry`, an SDK test confirms that `error` gives ERROR and `stop` gives UNSET on both spans (`ai:otel/src/finish-reason-status.test.ts#L140-L168`).
- A tool error (`#L765`, through `recordSpanError`, `#L58-L71`). The nodes send no tools (5.2.1, `UnexpectedToolCallsError`), so this cause does not occur in a run.
- An error thrown out of `generateText` while the call state exists (`#L1469-L1501`, called from `ai:ai/src/generate-text/generate-text.ts#L1638-L1639`).

Every other finish reason sets no status. A `length` stop with valid JSON leaves its span UNSET, so the gateway sets status itself (D4). MLflow takes trace state from the root span only: ERROR gives ERROR, any other status gives OK (`mlflow:store/tracking/sqlalchemy_store.py#L5841-L5857`). So the run span needs ERROR when a node fails. The code never sets UNSET; on success it leaves status alone.

| Event | Node span | Run span |
|---|---|---|
| `stop` and valid schema | untouched | untouched |
| `length`, recovery works (split input or raise budget, D4) | untouched, event `attempt.failed` | untouched |
| `length`, recovery fails | ERROR | ERROR, outcome `partial` or `failed` |
| `content-filter` (no retry); unexpected `tool-calls`; `error`, `other`, schema error or transient provider error after the one retry; reasoning leak (`<think>` in content, section 5); auth or invalid request (no retry); `model_mismatch`; `model_unavailable`; `deadline_exceeded`; `save_failed`; `internal` | ERROR | ERROR |
| A unit `skipped` after a run-wide stop (3.4.5) | untouched | ERROR comes from the failure that stopped the run |
| Cancel by the user (not a failure) | untouched | untouched, outcome `cancelled` |

A partial run has at least one node call in ERROR. A typed error message holds no transcript text; the status message holds only the code. For a schema error, which AI SDK span shows ERROR: UNVERIFIED. Reading suggests none. The output parse runs after the `onEnd` event (`ai:ai/src/generate-text/generate-text.ts#L1609-L1630`), `onEnd` removes the call state (`ai:otel/src/legacy-open-telemetry.ts#L1060-L1061`), and `onError` returns when no call state exists (`#L1471-L1474`). No run has confirmed this. Read the node span (check C6).

Helper interface (same file as 9.5.3). With the export off, `tracer` is a no-op tracer that returns `NonRecordingSpan` (`unpkg:@opentelemetry/api@1.9.1/build/src/trace/NoopTracer.js`).

```ts
export function startRunSpan(t: Tracing, runId: string, attrs: Attrs & { kind: LlmRunKind }): Span;   // span name `meeting.${kind}`, WORKFLOW, ROOT_CONTEXT; stores the context. `W/runner.ts` calls it. The name differs from `startRun` of the recorder (7.7) and of the runner (3.4.2)
export function inNode<T>(t: Tracing, runId: string, node: string, attrs: Attrs, fn: (s: Span) => Promise<T>): Promise<T>;
  // `guardNode` (W/unit.ts) calls it around each node body (9.6.1 rule 2). startActiveSpan(`node.${node}`, CHAIN, stored context); on throw: markError, rethrow; always end
export function markError(s: Span, err: unknown): void;   // error_kind = err.code ?? "unknown"; recordException; ERROR, message = code
export function endRunSpan(s: Span, runId: string, outcome: "succeeded" | "partial" | "failed" | "cancelled"): void;   // `W/runner.ts` calls it. ERROR only if partial or failed
```

### 9.7 Privacy and failure isolation (T7, T8)

- Content: the AI SDK records inputs and outputs by default (`ai:ai/src/telemetry/telemetry-options.ts#L34-L48`). With the export on, each Enhance or Summarize prompt (transcript, speaker names) and answer goes to the configured host. Setting both variables accepts this (Q9.2).
- Secrets: provider keys live on the provider, not the call (`registry.ts:173-177`). The legacy integration copies call `headers` into `ai.request.headers.*` (`ai:otel/src/get-base-telemetry-attributes.ts#L30-L35`), so the gateway must never pass `headers`. The exporter sends only the experiment id header (check C7).
- Isolation copies the trace log pattern (`trace.ts:148-159`). The run path never awaits a flush: at run end it calls `void tracing.forceFlush().catch(() => {})`. The batch queue holds 2048 spans, drops new ones when full, exports every 5 s in batches of 512 with a 30 s timeout (`unpkg:@opentelemetry/sdk-trace@2.12.0/build/esm/export/BatchSpanProcessorBase.js`, lines 27-30, 79-84). An exporter wrapper reports a failed send at most once per minute, with the HTTP status and no span data.
- Planned change: `shutdown` (`apps/electron/src/server-host/entry.ts:78-94`) calls `stopWhisperServer()` and `stopMlxServer()` (line 82), no tracing call. Add `stopTracing()` (2 s cap) to that `Promise.allSettled` list, imported from `@openstyle/server` (`entry.ts:7-16`). Do not rely on the `unhandledRejection` handler, which only logs (`entry.ts:58-60`).
- Deleting a meeting removes its local records (D10), not MLflow traces or trace log lines.

### 9.8 Bundle size and load cost

The main process ships no `node_modules`; the asar target is about 9 MiB (`AGENTS.md:87`). Published size, read from the npm registry and unpkg on 2026-10-17 without a build or install. Two reads on that day gave the same numbers. The five new packages and their 10 dependencies make 15 packages, not counting `ai`, `@ai-sdk/provider*` and `@opentelemetry/api`. The registry pages of the 15 packages list no other dependency and no other peer dependency. They hold 19.0 MB unpacked (12.0 MB is `@opentelemetry/semantic-conventions` 1.43.0) and 1.92 MB of published JS (0.48 MB without `semantic-conventions`, `sdk-logs`, `sdk-metrics`). These numbers are an upper bound. The real chunk size: UNVERIFIED.

Sources for each package row (replace `<pkg>` and `<version>`):

- Unpacked bytes: field `dist.unpackedSize` of `https://registry.npmjs.org/<pkg>/<version>`. Example: https://registry.npmjs.org/@opentelemetry/core/2.12.0.
- JS bytes: sum of the file sizes in `https://unpkg.com/<pkg>@<version>/?meta`. Example: https://unpkg.com/@opentelemetry/core@2.12.0/?meta. The sum counts each `.js`, `.mjs` and `.cjs` file of one build for each package: the folder `build/esm`, else `build/src`, else `dist`. It counts no `.d.ts` file and no `.map` file.

| Package | Version | Unpacked bytes | JS bytes | Folder |
|---|---|---|---|---|
| `@ai-sdk/otel` | 1.0.143 | 503,760 | 96,837 | `dist` |
| `@mlflow/vercel` | 0.4.0 | 20,532 | 11,264 | `dist` |
| `@opentelemetry/api-logs` | 0.223.0 | 136,913 | 9,160 | `build/esm` |
| `@opentelemetry/context-async-hooks` | 2.12.0 | 62,640 | 14,893 | `build/src` |
| `@opentelemetry/core` | 2.12.0 | 583,971 | 56,429 | `build/esm` |
| `@opentelemetry/exporter-trace-otlp-proto` | 0.223.0 | 57,561 | 3,546 | `build/esm` |
| `@opentelemetry/otlp-exporter-base` | 0.223.0 | 647,539 | 59,162 | `build/esm` |
| `@opentelemetry/otlp-transformer` | 0.223.0 | 1,053,804 | 101,901 | `build/esm` |
| `@opentelemetry/resources` | 2.12.0 | 440,928 | 40,855 | `build/esm` |
| `@opentelemetry/sdk-logs` | 0.223.0 | 679,622 | 60,368 | `build/esm` |
| `@opentelemetry/sdk-metrics` | 2.12.0 | 1,846,700 | 165,216 | `build/esm` |
| `@opentelemetry/sdk-trace` | 2.12.0 | 832,043 | 74,183 | `build/esm` |
| `@opentelemetry/sdk-trace-base` | 2.12.0 | 123,728 | 9,368 | `build/esm` |
| `@opentelemetry/sdk-trace-node` | 2.12.0 | 32,087 | 5,461 | `build/src` |
| `@opentelemetry/semantic-conventions` | 1.43.0 | 12,006,437 | 1,207,603 | `build/esm` |
| Total | 15 packages | 19,028,265 | 1,916,246 | |

Without `semantic-conventions` the JS total is 708,643 bytes. Without `semantic-conventions`, `sdk-logs` and `sdk-metrics` it is 483,059 bytes.

1. The export code loads through `import()` only when the export is on (`apps/server/src/lib/llm/registry.ts:175` does this for providers; the bundle uses `externalizeDeps: false`, `apps/electron/electron.vite.config.ts:75`). Off means zero start cost; the bytes stay in the asar.
2. `apps/electron/scripts/check-bundled-requires.mjs` reads only files directly in `out/main` and `out/preload` (lines 24, 31-34), not `out/main/chunks`. The lazy code most likely lands in a chunk (UNVERIFIED until a build exists). BC3 of 10.14 (WP1) makes the guard scan chunks. Until then a stray `require()` there passes CI.
3. Build the same commit with and without the tracing code. Record bytes of `out/main/server-process.js`, every file in `out/main/chunks`, and `app.asar`. Put the six numbers in the PR.
4. Proposed budget (not an owner decision): the asar grows by at most 1 MiB. If more, stop and ask (Q9.4).

### 9.9 Verification

The live proof has not run. How MLflow 3.16.1 renders AI SDK spans is UNVERIFIED (D8). Only the probes in 9.5.6 ran. These checks realize goal G10 (section 1) and WP8 (section 11).

A trace counts only after it is read back from the server (`/Users/maheidem/.claude/CLAUDE.md:77-81`). Both span families must land: our spans and the AI SDK `LLM` spans come from different code, and either can work while the other is dead. The owner creates one named experiment for the proof; write its id and name in the PR and ask before deleting it. Run this once against the real server before you trust it. It uses `locations`, because `experiment_ids` is deprecated (https://mlflow.org/docs/latest/api_reference/python_api/mlflow.client.html). Fields: `mlflow:entities/trace_info.py`, `mlflow:entities/span.py`.

```python
from mlflow import MlflowClient
c = MlflowClient(tracking_uri="http://192.168.31.154:5000")
for t in c.search_traces(locations=["<id>"], max_results=50):   # sort by t.info.request_time
    print(t.info.trace_id, t.info.state, [(s.name, s.span_type, s.status.status_code) for s in t.data.spans])
```

| Check | Pass condition |
|---|---|
| C1 Both paths | A script posts one real OTLP span with the experiment header to `/v1/traces` (expect 200) and to `/api/2.0/otel/v1/traces` (expect 404 on 3.16.1). A 404 on the first means MLflow is older than 3.6.0; the export stays off. |
| C2 One trace per run | After N runs, N new traces. A trace of only `ai.*` spans means the context manager is missing. |
| C3 Our spans | Root `meeting.enhance` for an Enhance run and `meeting.summarize` for a Summarize run, type `WORKFLOW`, with `openstyle.kind` equal to `llm_runs.kind`. The count of `node.*` spans equals the node calls of the run: `prepare` 1, `correctChunk` one for each chunk, `identifySpeakers` 1, `verifyEvidence` 1, `summarize` 1, `save` 1, for the nodes that ran. |
| C4 AI SDK spans | Each LLM call gives at least one `ai.generateText` span, type `LLM`. A successful call gives two spans: the root `ai.generateText` and the step `ai.generateText.doGenerate`. The root name is the SDK operation id `'ai.generateText'` (`ai:ai/src/generate-text/generate-text.ts#L688`), used as the span name at `ai:otel/src/legacy-open-telemetry.ts#L380`. The step name is a literal (`ai:otel/src/legacy-open-telemetry.ts#L645-L648`). The SDK test asserts only the count, 2 for `LegacyOpenTelemetry` and 3 for `OpenTelemetry`, and no name (`ai:otel/src/finish-reason-status.test.ts#L157-L158`). |
| C5 Join | Every id in `openstyle.llm_call_ids` exists in `llm_calls` for that run. LLM calls in the trace equal `llm_calls` rows. |
| C6 Typed errors | One live run per typed error (section 10 lists them), including `length` with valid JSON. The failing node span shows ERROR and `openstyle.error_kind`. The root state is ERROR. |
| C7 No secret | A canary API key on the provider appears in no span attribute. |
| C8 Off by default | Variables unset: 0 new traces, log says `MLflow tracing: off`, `lsof -nP -i @192.168.31.154:5000` prints nothing during the run (weak check; a short connection can be missed). |
| C9 Dictation out | One dictation cleanup with the export on gives 0 new traces. |
| C10 Isolation | Export on, MLflow host unreachable: same run result and about the same run time as with the export off. |

Command for the "no code" fact in 9.2:

```text
$ cd /Users/maheidem/Documents/dev/openstyle-spec-185
$ grep -rIil -E "mlflow|opentelemetry" apps packages scripts package.json pnpm-workspace.yaml | grep -v node_modules
(no output)
```

Tests for section 10 (`apps/server/tests/tracing.test.ts`, new):

1. `startTracing`: no variables, one variable and a bad scheme give `on: false`; one variable warns once; unset variables load no export module and open no socket.
2. Spans: `BasicTracerProvider`, `SimpleSpanProcessor`, `InMemorySpanExporter` (`ai:otel/src/finish-reason-status.test.ts#L26-L36`) and an AsyncLocalStorage context manager. A fake model returns `length` with valid JSON. Expect one trace id, node span as parent of the AI SDK span, ERROR on node and run span.
3. Translation: an AI SDK span through `MLflowSpanProcessor` gives `mlflow.spanType = LLM`. It fails when a version bump breaks the `ai.operationId` link.
4. Privacy: with the export off the fake model gets `telemetry.isEnabled = false`; a dictation call gets no `integrations`.
5. Server tests use fake timers (`apps/server/tests/setup.ts:16`); a flush test may need `vi.useRealTimers()` (UNVERIFIED).
6. Run kinds: an Enhance run gives the root span `meeting.enhance` and a Summarize run gives `meeting.summarize`, both with `openstyle.kind` equal to `llm_runs.kind`. A resumed run gives a second trace with `openstyle.resume_count` above 0 and the original `openstyle.started_by`. `guardNode` opens exactly one node span for each node call, and a body that throws ends its span with ERROR before the typed `internal` failure returns.
7. Live: C1 to C10 against the owner's MLflow, the owner's oMLX with Qwen3.8-27B only, and quiet E2E (`scripts/test-runner/run.sh`). Mocks alone do not count.

### 9.10 Hand-offs to other sections

- Sections 3 and 4: the runner (`W/runner.ts`) calls `startRunSpan` before the graph starts and `endRunSpan` after it ends, with run id, `kind`, `started_by`, `resume_count` and final status. `guardNode` (`W/unit.ts`) runs each node body inside `inNode`; no node file changes (9.6.1 rule 2). Section 4 `RunStatus` and section 7 `llm_runs.status` both use `succeeded` (R16, 11.4).
- Section 5: set `telemetry` and `maxRetries: 0` on every call; emit `attempt.failed` and the 9.6.2 attributes; return typed error kinds, raw finish reason, served model and param ledger; never pass `headers`.
- Section 6: the pins in 9.5.2 must match the v7 `ai` version; `@opentelemetry/api` becomes a direct dependency of `apps/server`.
- Section 7: answer to O7-4: remove column `llm_calls.trace_id`. The join runs from MLflow to the local record through `openstyle.run_id` and `openstyle.llm_call_ids`; no screen reads a trace id.
- Section 10: the 9.9 tests, C1 to C10, a guard that scans `out/main/chunks`, and the list of typed-error live runs. Section 8 needs nothing here: the inspector reads neither MLflow nor the trace log.
- Section 11: WP8 creates `apps/server/src/lib/llm/tracing.ts` and `apps/server/tests/tracing.test.ts`; edits `apps/server/src/index.ts`, `apps/server/package.json`, `apps/electron/src/server-host/entry.ts`, `AGENTS.md:9`, `W/unit.ts` (`guardNode` calls `inNode`) and `W/runner.ts` (`startRunSpan`, `endRunSpan`). No node file, no settings file (T1). 11.4 lists these files for WP8.
- Section 12 (12.1 R16 and R20): real tracing chunk size UNVERIFIED (9.8); a very long meeting gives a large trace and the MLflow request size limit is UNVERIFIED; a resumed run leaves an unfinished trace (9.6.1 rule 4); the legacy integration may leave the AI SDK later (9.5.5); a Finder launch may not pass the variables (9.5.1 rule 4).

### 9.11 Open questions for the owner

| ID | Question | Default |
|---|---|---|
| Q9.1 | Do you want a setting key and UI instead of environment variables? It touches `packages/validations/src/settings-keys.ts:58`, `apps/server/src/lib/setting-validators.ts:195-200`, `apps/electron/src/renderer/src/pages/settings.tsx:221-226`, `apps/electron/src/renderer/src/locales/template.json:294-299` and `apps/server/src/lib/llm/task-profiles.ts:154-158`. In 2.8.0 a timeout shipped dead when some were missing (`CHANGELOG.md:301`). | No. Variables only. |
| Q9.2 | Do you want a switch that exports metadata only (`recordInputs` and `recordOutputs` false)? | No. Traces hold content, because the server is the owner's own. |
| Q9.3 | Should the variable hold an experiment id or a name? A name needs `GET /api/2.0/mlflow/experiments/get-by-name` and `POST /api/2.0/mlflow/experiments/create` (https://mlflow.org/docs/latest/api_reference/rest-api.html). | The id. |
| Q9.4 | Is 1 MiB of asar growth an acceptable limit? | Yes. Stop and ask if larger. |
| Q9.5 | Do you want dictation cleanup or Remix in MLflow later? It needs a per-call integration at each call site and a privacy review. | No. T8 stays. |
| Q9.6 | Do you want Summarize runs in MLflow, as T8 says? A Summarize prompt holds the transcript, as an Enhance prompt does. The root span name (`meeting.<kind>`) and `openstyle.kind` tell the two apart. | Yes. Both kinds are exported when both variables are set. |

---

## 10. Test plan and definition of done

This section owns the tests and the definition of done (DoD). It proves goals G1 to G12 (1.2) and closes each work package (WP, section 11). Sections 3 to 9 own the code under test and their own check lists (the floor). Unit tests alone never close a WP (1.3).

Cite prefixes: `~`=`/Users/maheidem`, `S`=`apps/server/src`, `T`=`apps/server/tests`, `W`=`S/lib/meetings/workflow`, `M`=`S/lib/meetings`, `E`=`apps/electron`, `LT`/`MB`/`CS`=`.claude/skills/{live-testing,meeting-benchmarks,council}/SKILL.md`, `CI`=`.github/workflows/build.yml`, `MV2`=`specs/meeting-transcription-v2.md`, `MC`=`E/tests/meeting-cancel-transcribe.test.ts`, `CM`=`~/.claude/CLAUDE.md`, `OLM`=`~/.claude/projects/-Users-maheidem-Documents-dev-OktoLabsAI/memory/MEMORY.md`, `OM`=`~/Documents/dev/omlx-management/docs/troubleshooting.md`, `ON`=`~/Documents/dev/OktoLabsAI/okto-neuron/src/okto_neuron/`, `ai:`=https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/ , `pv:`=https://unpkg.com/@ai-sdk/provider@4.0.29/dist/index.d.ts , `lgv:`=https://unpkg.com/@langchain/langgraph-checkpoint-validation@1.2.0/ , `lgd:`=https://docs.langchain.com/oss/javascript/langgraph/checkpointers.md . Other bare paths are in the repo at `c47cd80d`. The WP card of section 11 wins over a name marked "proposal".

### 10.1 Levels of proof

This spec defines seven levels. A WP passes every level that applies (10.17).

```mermaid
flowchart LR
  L1["1 Unit, scripted model"] --> L2["2 Wire: real provider code, stubbed fetch"] --> L3["3 Graph, saver, migration on a SQLite file"] --> L4["4 E2E in the real app, fake own server"] --> L5["5 Live run on the owner's oMLX, fictional transcript"] --> L6["6 Benchmarks on real meetings"] --> L7["7 Council: Claude, pi, Codex"]
```

Levels 1 to 3 run in CI job `test-server` (`CI:144,147,150`). Renderer tests and level 4 run in `test-electron` (`CI:152-155,174-175,203-205`). Both jobs run on a pull request only when Electron, server, packages, scripts or build config paths change (`CI:62-63,130,155`). Levels 5 to 7 run on the owner's Mac only.

### 10.2 Rules for every test

1. **Fictional data.** One fixture builder (fixed-length lines, known segment ids per chunk) serves all levels. It is the file `apps/server/tests/helpers/meeting-fixture.ts`, and WP3 owns it (11.4). WP3 needs it first, for the live probes of 10.12, and WP5a, WP6, WP7 and WP9 reuse it. It takes the number of chunks, the speakers and an optional self-introduction line. It returns plain data: meeting row, segment rows with their ids, the segment ids of each chunk, and the calendar link with attendees. A second function writes those rows with `node:sqlite` (the pattern of `scripts/site-captures/seed-data.mjs:167-221`), so the unit tests, the live script, the UI seeds and the E2E specs read one source. The file imports no vitest and no server module except types. The `include` list of the electron test tsconfig names `../server/src/**/*` (line 8) and four package folders, `sdk`, `stt`, `utils` and `validations` (lines 9-12). It has no entry for `apps/server/tests` (`apps/electron/tsconfig.tests.json:3-13`). So WP9 adds this file to that list (11.4). Real meetings appear only in 10.15, as numbers (`MB:12-19`).
2. **The fake sits below the code under test.** The timeout test (`T/meeting-llm-timeouts.test.ts:60-94`) moves to the gateway and the timeout must still reach `AbortSignal.timeout` (`M/llm-call.ts:153`). Today `vi.mock` of `postProcess` (`T/meeting-llm-timeouts.test.ts:94`) also hides `generateText` (`packages/stt/src/post-process.ts:125`), and route tests replace Enhance (`S/routes/meetings.ts:172-182`). Both hide the call record the gateway writes (5.1, 7.7). Only node tests fake the gateway: they replace `WorkflowDeps.callStructured` (3.4.2). Others use the real gateway over a scripted model or over a fake HTTP server. A scripted `MockLanguageModelV4` enters through the `createModel` seam (`CallStructuredInput.createModel` for one gateway call, `WorkflowDeps.createModel` for a graph test; 5.1), so the capture middleware, the gate and the record run on the scripted answer. The wire tests of 10.5.2 leave the seam unset.
3. **Red proof.** A typed-error test fails once with its check removed. The PR names the removed check. This is a rule of this spec. A search of the `OLM` memory directory on 2026-10-17 found no such rule. `OLM:36` gives the reason: a simulated error does not prove that the handler sits on the path of the real error.
4. **Time.** `T/setup.ts:16` fakes timers in all server tests (`T/llm-lane.test.ts:8-16` injects a clock and `sleep` instead). A run on 2026-10-17 (vitest 4.1.7) showed `setTimeout` sleeps never resolve. The `callUnit` sleep and the AI SDK retry wait (6.8) sleep that way. `callUnit` takes an injectable `sleep` through `WorkflowDeps.sleep` (WP5a, 3.4.2, 5.6); other retry tests call `vi.advanceTimersByTimeAsync` (WP5a, WP5b). The gateway has no retry wait (WP3). A test that needs real timers opts out per file (`T/trace.test.ts:31-41`). Do not edit `T/setup.ts`.
5. **Read back every write** with a separate query (`CM:47`).
6. **Isolation.** No port 4649, real profile or `~/.cache/huggingface`. Only Qwen3-ASR and Qwen3.8-27B on the owner's oMLX (`LT:12-20,65`).
7. **Keep behavior tests.** Tests of unchanged behavior (for example the `fakeLlm` groups, `T/meeting-enhance.test.ts:65-88,108-128`) move to their new node. The PR lists each deleted `it(` with successor or reason. Five `describe(` blocks of `T/meeting-enhance.test.ts` start at lines 162, 334, 403, 861 and 1015. The first `it(` of each block is at lines 163, 346, 410, 862 and 1040.
8. **Node.** CI runs Node 22 (`.node-version:1`). Electron 39.8.10 ships 22.22.1 (https://artifacts.electronjs.org/headers/dist/index.json). The dev Mac ran 26.5.0. `node:sqlite` is stability 1.1 on Node 22 (https://nodejs.org/docs/latest-v22.x/api/sqlite.html). A green Node 26 run does not close the saver or the migration: CI and the E2E run (Node 22) must pass too.

### 10.3 What exists today

Section 2 owns the current state. Test facts sit where used (rules 2 and 7, 10.5, 10.9 to 10.11).

### 10.4 Goal-to-proof map

Each goal closes only with its real-system evidence. Proof at levels 1 to 3, then evidence: G1 one schema per node, and `git grep -n extractJsonObject -- apps/server/src/lib/meetings/workflow` is empty (10.5.4); live node requests carry `response_format.type` `json_schema` (10.12 step 5). G2 matrix 10.5.1; fake own server (10.11); capped live call gives typed `length` (10.12 LP1). G3 replay GR5; 6 of 6 runs on the 8-chunk meeting finish (10.15). G4 route tests (10.9); typed failure survives reload and restart (10.11). G5 `maxRetries` 0, counts of 10.5.1 and GR7; same counts at the fake server. G6 saver suite (10.7), GR10 to GR12; `SIGKILL` five runs in a row plus a live kill (10.11.3, WP9 acceptance 3). G7 recorder and route tests (10.9); read-back (10.12), panel equals wire (10.11.2), delete leaves 0 rows. G8 ledger equals stubbed body (10.5.2); equals trace log (10.12 step 4). G9 wire-body test 6.9.2; one `ai` version in the lock file, three real runs (WP1). G10 tests of 9.9; C1 to C10 on the owner's MLflow (10.13). G11 guard scans `out/main/chunks`; build, asar size, packaged start (10.14). G12 no unit proof (`MB:117-119`); benchmarks and council (10.15).

### 10.5 Gateway tests (sections 5 and 6)

This matrix is the source of the WP3 test cases (11.5).

#### 10.5.1 Scripted model matrix

Use `MockLanguageModelV4` from `ai/test` (`doGenerate` takes a function, one result or a list; `doGenerateCalls` records calls: https://unpkg.com/ai@7.0.143/dist/test/index.d.ts:135,142). A result needs `finishReason: { unified, raw }` and V4 usage (`pv:654-666,694-740,746-791`). WP3 builds `T/helpers/fake-model.ts`. No file imports `ai/test` today; the hand-made `v3` model in `packages/stt/src/post-process.test.ts:4-11` stays until WP1. `ai` 6.0.191 has only V3 mocks (https://unpkg.com/ai@6.0.191/dist/test/index.d.ts:53), so gateway tests wait for WP1 and use V4.

```ts
import { MockLanguageModelV4 } from "ai/test";
type Unified = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
const reply = (unified: Unified, raw: string | undefined, text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified, raw },
  usage: {
    inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 30, text: 30, reasoning: 0 },
  },
  warnings: [],
});
// First call is cut at the token cap. The second (a smaller unit) succeeds.
const model = new MockLanguageModelV4({
  modelId: "Qwen3.8-27B",
  doGenerate: [reply("length", "length", '{"corrections":['), reply("stop", "stop", '{"corrections":[]}')],
});
// After the run: expect(model.doGenerateCalls).toHaveLength(2);
```

The SDK retry loop wraps `doGenerate` (`ai:generate-text/generate-text.ts#L1056-L1061`). A model that always throws a retryable error must see one call per gateway call: that proves `maxRetries` 0. A gateway call never loops (section 5). Columns: "One gateway call" is a WP3 test of `callStructured` over the scripted model, which enters through `CallStructuredInput.createModel` (5.1). "Req" counts the requests through the whole stack, `callUnit` and the gateway (G5). It is a WP5a test in `workflow-requests.test.ts` (10.8), because `callUnit` is a WP5a part and WP3 cannot run it. Rows with a length route (A4, A5, HE11) count their requests in GR6 and LR1 to LR8. Names: 5.2. Routes and advice: 5.2.1.

| # | Scripted (unified/raw, text) | One gateway call | Req |
|---|---|---|---|
| A1 | `stop`/`stop`, valid JSON | Object; both reasons recorded | 1 |
| A2, A3 | `stop` + zod-invalid JSON; `stop` + stray quote (#163) | `SchemaError` (`schema`; `json`). Retry adds the validator message, no model value | 2 |
| A4 | `length` + cut JSON | `LengthError` | Length route (GR6, LR1 to LR6) |
| A5 | `length` + complete valid JSON | `LengthError`. v7 parses it, so check the finish reason first (`ai:generate-text/generate-text.ts#L1614-L1630`); 6.0.191 throws `NoOutputGeneratedError` (https://unpkg.com/ai@6.0.191/dist/index.mjs:4729,4856) | As A4 |
| A6, A7 | `content-filter`; `stop` + valid JSON + `refusal` | `ContentFilterError` | 1 |
| A8 | `tool-calls` (no tools sent) | `UnexpectedToolCallsError` | 1 |
| A9, A10 | `error`; `other` | `AbnormalStopError`. Retry: same input, 1 s backoff | 2 |
| A11, A12 | `stop` + `network_error`; `stop`, raw missing | `AbnormalStopError` (`unknown_raw`; `missing_raw`). LiteLLM turned `network_error` into `stop` (`ON` `llm/__init__.py:390-397`) | 2 |
| A13 | `stop` + `end_turn` (Anthropic key), then `pause_turn` | `end_turn` passes; `pause_turn` fails `unknown_raw` (a gate rule of 5.3.2; the page defines `pause_turn` as a valid stop reason and tells the client to send the response back, so it names no failure: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons); `end_turn` under the `openai_chat` key fails | 1, then 2 |
| A14, A15 | `stop` + `<think>`; `stop` + empty text + reasoning | `ReasoningLeakError` (`think_tag`; `empty_content_with_reasoning`) | 1 reasoning off; 2 on |
| A16, A17 | Served model differs; absent | `ModelMismatchError`; object with `served_model` NULL + warning | 1 |
| A18 | Usage reasoning 600, cached 40; then none | Stored; missing is NULL, not 0 (the `llm_calls` columns of 7.4). Today a call with unknown usage gives 0 (`M/llm-call.ts:45`). The summary sums still add 0 (4.5 rule 1). The `meeting_summaries` token columns accept NULL (`S/lib/schema.ts:795-796`) | 1 |

Thrown errors use `APICallError` with `statusCode`, `responseHeaders`, `isRetryable` (`pv:2132`). Level 2 repeats each row with a real HTTP reply (10.5.2).

| # | Error | One gateway call | Req |
|---|---|---|---|
| HE1, HE2 | 429 `Retry-After: 3`; `retry-after-ms: 1500` + `retry-after: 9` | `provider_rate_limited`. Wait 3000 ms; 1500 ms | 2 |
| HE3 | 429, HTTP date (https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) | Wait = distance, max 60 s | 2 |
| HE4, HE5 | 429 `Retry-After: 90`; no header | No retry advice (5-P3); 1 s + jitter | 1; 2 |
| HE6 | 500, 502, 503, 504, 409, network error | `provider_unavailable`. Advice | 2 |
| HE7 | 408 or call timeout | `provider_timeout`. Retry on cloud only (5-P2) | 2 or 1 |
| HE8 | 401, 403 | `provider_auth`. No retry | 1 |
| HE9, HE10 | 400 naming `response_format`, `json_schema` or `schema`; other 400, 404, 422 | `provider_invalid_request`. Advice: lower structured mode; none | 2; 1 |
| HE11 | 413; 400 with `prefill_memory_exceeded`, `context_length_exceeded` or `maximum context length` | `LengthError` `input`: `split` only, no `raise`, no `lowerReasoning`. Phrases other than the oMLX one: UNVERIFIED | As LR8 |
| HE12 | Persistent 503 | No advice on the 2nd failure | Exactly 2 for one call, never 6 (SDK default: `ai:util/retry-with-exponential-backoff.ts#L66-L68`). A split chunk whose second half has a persistent 503: 4 |
| HE13 | Abort queued; in flight; `stopped()` true when the lease opens (5.1 step 4) | `CancelledError`, phase `queued`; `in_flight`; `queued` | 0; 1; 0 |
| HE14 | `RetryError` | Gateway reads `lastError`. Not expected at `maxRetries` 0: UNVERIFIED | 1 |
| HE15 | No model set up; unsupported provider; no key; server removed | `ModelUnavailableError`, no request | 0 |
| HE16 | Caller signal aborts with `TimeoutError`; with another reason | `DeadlineExceededError`; `CancelledError` | 1 or 0 |

A `Record<Unified, Route>` constant fails the type check when the SDK adds a seventh unified value (`pv:666`).

#### 10.5.2 Wire tests through the real provider code

Wire tests build the model with `createChatModel("server", ...)` and stub `globalThis.fetch`, so the real `@ai-sdk/openai` and fetch wrapper run (pattern: `T/llm-task-profiles.test.ts:493-526`).

| # | Case | Pass when |
|---|---|---|
| W1 | Normal `server` call body | Holds `response_format.type` `json_schema`, node schema name, `chat_template_kwargs.enable_thinking` `false`, `temperature`, `max_tokens`. Ledger equals the body key by key (G8). `dropped` keys are absent. |
| W2 | Preset sets `response_format`, `stop`, `guided_json` | Ledger: dropped, reason `denylist`. Body keeps the SDK schema. Today the denylist lacks them and preset keys spread last (`packages/validations/src/llm-task-profiles.ts:199-206`, `S/lib/llm/registry.ts:125`). |
| W3 | Wire finish `stop`, `length`, `content_filter`, `tool_calls`, `function_call`, unknown | SDK gives `stop`, `length`, `content-filter`, `tool-calls`, `tool-calls`, `other` (https://unpkg.com/@ai-sdk/openai@4.0.96/dist/index.js:690-699). The wire never gives `error`. |
| W4 | 429 `Retry-After: 3`, `maxRetries` 0 | `APICallError`: `statusCode` 429, `isRetryable` true, `responseHeaders["retry-after"]` `"3"`, one call (offline run 2026-10-17, `ai` 6.0.191, `@ai-sdk/openai` 3.0.65). Repeat on v7. |
| W5 | Each status of HE1 to HE10 | Kind, advice and count match. |
| W6 | 400 naming `response_format` | Mode cache drops to `prompt_only` for that server and model. Next call succeeds. New process relearns (5.9 check 6). |
| W7 | Reply `model`: equal, differs, missing, date suffix (`gpt-4o-mini-2024-07-18`) | Equal and suffix pass; different fails; missing passes with a warning. Suffix rule 5-P4: record served ids first (5.3.4). |
| W8 | `reasoning_content` with empty `content`; `<think>` in `content`; `reasoning_tokens` in usage | `empty_content_with_reasoning`; `think_tag`; tokens recorded, NULL if oMLX omits them (UNVERIFIED). |
| W9 | SDK warns it ignored a setting | Ledger: dropped, reason `sdk_unsupported`. |
| W10 | Held socket, small `timeoutMs` | `provider_timeout`; user signal first gives `CancelledError` (5.7). Real timers. `AbortSignal.timeout` under fake timers: UNVERIFIED. |
| W11 | Body is not a string | The wrapper returns it untouched (`S/lib/llm/registry.ts:161-163`; 6.8 row 6). No test passes a non-string body today. The wrapper tests send a string (`T/llm-task-profiles.test.ts:474-486`). So W11 is a new canary test. |
| W2b | A dictation cleanup preset with `stop` | `resolveTaskCall` keeps `stop` for cleanup and Remix, and drops it for the two meeting tasks (5.5.3). |
| W12 | Each provider and mode of the 5.4 table, table-driven (stubbed fetch, as 6.9.2 WB1 to WB8) | The body holds the structured-output field of that row: `response_format` `json_schema` with `strict`, `output_config.format`, the forced `json` tool, `providerOptions.*` or `provider.require_parameters`. |
| W13 | Each input-overflow phrase of 5.2.1 as HTTP 400, and HTTP 413 | `LengthError` `input` for each. |
| W15 | `probeEndpoint` (5.7) over a stubbed `fetch` | `server`: `GET <base>/models` with the base of the server entry; HTTP 200, 401, 404 and 503 give true; a rejected fetch and the 3 s timeout give false (real timers or an injected `timeoutMs`). Cloud (`openai`, `anthropic`, `google`, `mistral`, `groq`, `openrouter`, `vercel`): `HEAD` on the base URL of the table in 5.7; the same statuses give true; a rejected fetch gives false. No request holds an `Authorization` header or a key. A missing server entry and a missing key give true. A provider that is not in the table gives true. |

#### 10.5.3 Profile and ledger tests

A table-driven test checks the 5.5 reasoning profile per provider and model: the wire shape with reasoning off, then the bounded shape where one exists. Local `server` Qwen: `chat_template_kwargs.enable_thinking` `false` (`T/llm-task-profiles.test.ts:146-155`). Groq `qwen/qwen3-32b`: `hidden`, `none`; `openai/gpt-oss-20b`, `-120b`: `hidden`, `low`; byte for byte as today (`S/lib/llm/registry.ts:72-97`). Unknown model: default profile. No control: ledger reason `no_reasoning_control`. The setting goes out on every call (L2). A preset that turns thinking on wins, with ledger warning "reasoning on by preset" (4.7, N5).

**W14 Registry read is best effort (5.1).** Make `fetchModelsFromRegistry` reject (a network fault, and a bad status in a second case). (a) `resolveModels` for a `server` model resolves with `contextWindow` and `maxOutputTokens` `null` and no `registry_unavailable` warning, a `server` Enhance over a stubbed fetch runs end to end, and the stub sees no request to models.dev. (b) `resolveModels` for a cloud model resolves with the first mode of the 5.4 row, the hand row of 5.5, both limits `null` and the warning `registry_unavailable`; every call record of that run holds the warning in `params_json`. (c) Neither case throws `ModelUnavailableError`. (d) The registry is read once for the three profiles. Case (c) has a red proof: if `resolveModels` lets the rejection escape, `prepare` fails the run with `model_unavailable`, and the test fails.

#### 10.5.4 Schema tests

WP3 builds `assertPortableSchema` (5.4 owns the provider schema rules) and runs it on every node schema of `W/schemas.ts`. That file is new: WP3 writes it (11.4), and the folder `W` is absent at `c47cd80d`. So no repo file confirms this run yet. The input is the SDK output, `await asSchema(zod).jsonSchema` from `ai` (4.0.3 rule 7), because that is the schema the SDK builds for the request. The gateway adds no normalize step. A check on 2026-10-17 (`ai` 6.0.191, zod 4.4.3) ran the function below on the SDK output of the three schemas of 4.2.1, 4.3.1 and 4.5.1 as written in this spec: 0 violations for each. The same check on `z.object({ a: z.string().optional() })` printed `$.a: not required`, so the test catches an `.optional()` key. Flag any `$ref`. Repeat the check on v7 in WP3. At the v7 commit, `@ai-sdk/provider-utils` exports `asSchema`, and its zod 4 conversion has the same options (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/provider-utils/src/schema.ts). That `ai` v7 re-exports `asSchema` (`ai` 6.0.191 does: `index.d.ts:8`) is UNVERIFIED.

```ts
/** One line for each rule that a JSON Schema node breaks (L5, 4.0.3). */
function strictViolations(node: unknown, path = "$"): string[] {
  if (typeof node !== "object" || node === null) return [];
  const n = node as Record<string, unknown>;
  const out: string[] = [];
  if (n.type === "object") {
    const required = (n.required ?? []) as string[];
    if (n.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    for (const k of Object.keys((n.properties ?? {}) as object))
      if (!required.includes(k)) out.push(`${path}.${k}: not required`);
    if ("patternProperties" in n || "propertyNames" in n) out.push(`${path}: dynamic keys`);
  }
  for (const key of ["minLength", "maxLength", "minimum", "maximum", "pattern", "$ref"])
    if (key in n) out.push(`${path}: ${key}`);
  for (const [k, v] of Object.entries(n)) out.push(...strictViolations(v, `${path}.${k}`));
  return out;
}
// expect(strictViolations(await asSchema(CorrectChunkSchema).jsonSchema)).toEqual([]);
```

Also: **stability** (R8; WP5a, WP9): two different fictional meetings put the same JSON schemas on the wire, because the oMLX grammar cache grows about 0.45 GB per new schema (`OM:140`, https://github.com/jundot/omlx/issues/4321). **Snapshot** each schema JSON. **Parse cases** per schema: valid, extra key, missing key, wrong type, allowed null, empty array. **No attendee name** in any recorded request, with a fixture calendar link that has attendees (4.0.4). Code cuts sizes after the parse (`M/enhance.ts:560-582`).

#### 10.5.5 SDK bump tests (WP1)

Section 6.9 owns this proof: the wire-body snapshot is made on v6 first and shows no diff after the bump; `vitest -u` never runs in the bump commit (6.9.1). The lock file holds one `ai` version, two today (`pnpm-lock.yaml:2884,2890`; WP1 acceptance 2, 3). Dictation, Remix transform and Remix agent each pass one real run (WP1 acceptance 5): `POST /api/post-process`, `/api/remix/transform`, `/api/remix/agent` (`S/routes/index.ts:52-53`, `S/routes/remix/index.ts:14-18`). No unit test runs the Remix model calls (`S/lib/remix-agent.ts:103`, `S/lib/remix-transform.ts:132`). `T/remix-model-preflight.test.ts:31-34,59-72` runs both Remix routes, but `createChatModel` rejects, so `streamText` and `generateText` never run. `T/remix-prompts.test.ts` checks prompt assembly. Cloud transcription has no live proof (no keys, 6.11 U6-6). The evidence is the wire tests WB12 to WB14 of 6.9.2. `T/openai-cloud-provider.test.ts` is no evidence for it: it replaces `createOpenAI` (`:5-9`) and `experimental_transcribe` (`:11-21`) with stubs, and it checks only the config that reaches `createOpenAI` (`:56,66`).

### 10.6 Node tests (section 4)

Level 1, real node code, scripted gateway. This is the check list of section 4.

| Node | Required tests |
|---|---|
| `prepare` | No diarization: `labels.all` empty. All labels named: `toIdentify` empty. A chunk never splits a segment; chunk ids never overlap. Empty transcript: `empty_input`, no call. Chunk size shrinks when the fit check fails (4.0.5). `prepared.summary` holds the two settings: a change of `meeting_summary_context_budget` after `prepare` does not change the state. `inputHash` (WP2 test of `M/input-hash.ts`; the file is planned and absent at `c47cd80d`, 4.1 P11): `prepare` and the reader of 7.8 give the same string for the same database; a blank-text row and a row with a failed status do not change it; a merged speaker (`merged_into`), a re-diarize and a re-transcribe change it; a confirmed name and `enhanced_text` change it for variant `summarize` only. |
| `correctChunk` | `length` on a 1200-token chunk splits it and succeeds with halves. One test per drop reason: `unknown_id`, `duplicate_id` (first wins), `empty_text`, `unchanged`. Echoed `Speaker:` prefix removed. Prompt asks for corrections only; no speaker field (D1). A drop keeps its call id and its `seq` (4.2). A model answer with the segment ids `[A, B, A]` gives `seq` 0 and 1 to the two applied entries and `seq` 2 to the `duplicate_id` drop. |
| `identifySpeakers` | Line-1 self-introduction in a 3-hour fixture stays in the candidate set (anchor rule). A `segmentId` the call did not show is dropped. `length` with reasoning on reruns with it off. No attendee name in the prompt. After a split each half checks `segmentId` against its own `shown` lines. One failed half: node `partial`, step `candidates` stored `partial`, the good proposals stay. Each proposal has the `seq` of its place in the `speakers` array. |
| `verifyEvidence` | One test per drop reason of 4.4.2 (10). The four normalization cases of 4.4.1 (`Hi, this is José`, curly apostrophe, `banana` against `ana`, unchanged `Hi, this is Ana`). `Thank you, Ana.` is no introduction. An early role loses to a later self-introduced name. `Anna` and `Ana` with attendee `Ana Lima`: one winner, `respelledFrom`. Each verdict has status and reason (D10). |
| `summarize` | Empty summary: five headings, `None.` under four. `\n## Fake` in a string makes no heading. Six map chunks that do not fit one reduce are grouped, at most 24 calls. Keys (4.0.7): a short transcript uses `single`; a long one uses `map:0` to `map:N-1` and then `reduce:1:0`, or, when the partials need two levels, `reduce:1:0`, `reduce:1:1` and `reduce:2:0`. **Two reduce levels use two different keys.** After a kill between the level-1 and the level-2 call, a resume sends 0 requests for the finished level-1 calls and the level-2 call gets the level-1 results as its input, not the level-1 answer as its own answer. One call under budget, map then reduce above it. A `single` call that ends with `length` replans into `map` and `reduce` keys, and the step row `single` ends `succeeded` when the summary is made. The node reads `prepared.summary.instructions` and `contextBudget`, not the settings (4.1). Job deadline holds: a small ceiling gives `deadline_exceeded`, not `cancelled`. A failure writes no summary. A summarize-only run uses the stored `enhanced_text` and the "Unidentified" label of `prepare`, not the raw text (4.5). |
| `save` | Same state twice, same database. Chunk `ok` with no correction resets `enhanced_text` to NULL; a failed chunk keeps its old one. A delete between SW1 and SW2 (4.6.1) ends the run without error. SW2 never changes `confirmed_at` or `display_name`. A write that throws `SQLITE_BUSY` once succeeds on the retry; one that throws twice gives `save_failed` and the others stay. A rolled-back SW1 leaves no link. `save` twice leaves one link row for each (call, target, seq). **Link keys (4.6.1):** a correction answer that holds the same segment id twice (one applied, one `duplicate_id` drop) leaves two link rows for that segment, with different `seq`, and the 7.8 segment query still returns the `applied` row; after a second `save` the `applied` row is still `applied`. Two proposals for one label in one call, one kept and one `conflict_lost`, leave two link rows with different `seq`, and the 7.8 speaker query returns the kept call. A summary link has `target_id` equal to the meeting id and `seq` 0, one row for each summary call. |

Also: no attendee in any request (10.5.4); per provider row the node output limit equals the 4.0.5 formula. The benchmark tunes the values 4.0.5 marks "new" (`IDENTIFY_ANCHOR_LINES` 8, factor 2 of `CORRECT_ANSWER_FACTOR`), never unit tests (D12). The `meeting_summaries` row keeps summed tokens of all calls, the provider of the profile and the served model of the last call; cost is tokens times price, or NULL (rules 1 to 4 of 4.5). Today `summarizeMeeting` sums the tokens, keeps the last provider and model, and computes the cost (`M/summarize.ts:435-439,512-515`). The model it keeps is the requested one: `M/llm-call.ts:177` sets `model` to `resolved.modelId`, and `describeModel` reads the id from the model object it was given (`packages/stt/src/post-process.ts:87-94,164`). The comment at `M/llm-call.ts:50` says "served", but the value is not. The new node keeps the served model (4.5 rule 3). Summary call records reconcile with it. WP6 writes these cost cases in `workflow-summarize.test.ts` (a new file, absent at `c47cd80d`; WP6 card, 11.5): (a) a priced model: a stub answers the models.dev request with a price, `fetchModelsFromRegistry()` warms the cache, and a scripted model of provider `openai` reports 1000 input and 200 output tokens. Then `meeting_summaries.cost_usd` is not NULL and equals `1000 × price.input + 200 × price.output`, read back with a separate query. (b) A `server` model: `cost_usd` is NULL. (c) The models.dev stub rejects: `cost_usd` is NULL, the node does not fail and records no failure. (d) A resume in a new process with a cold cache and a working stub: `cost_usd` is not NULL. (e) `llm_model` is the served model of the last call when the answer names one, else the requested model; `llm_provider` is `profile.provider`.

### 10.7 Saver tests (WP4)

The saver is `NodeSqliteSaver` (3.1, 7.9). The conformance suite is `@langchain/langgraph-checkpoint-validation` 1.2.0 (D6). Facts from its published files:

- `validate(initializer)` runs five suites: `put`, `putWrites`, `getTuple`, `list`, `deleteThread` (`lgv:dist/spec/index.js`); the WP4 card says every conformance group. It uses `describe`, `it`, `expect`, `beforeAll`, `afterAll` as globals and imports no `vitest`; the server config has `globals: true` (`apps/server/vitest.config.ts:20`), so it runs in a server test file. It depends on `vitest ^4.1.11`; the repo locks 4.1.7 (`pnpm-lock.yaml:4987`) and library mode uses the running vitest. Install it as a dev dependency of `apps/server` only.
- `getDeltaChannelHistory` tests are opt-in (`lgv:dist/spec/delta_channel_history.js`): call `deltaChannelHistoryTests(initializer)` in the same file. The saver does not override that method (7.9), so the test checks the base-class walk on our storage.
- **Skip list.** The suite skips the `put` test "should only store channel_values that have changed" for the official SQLite saver, keyed by name (`lgv:dist/spec/put.js:102-106`). Give the initializer `checkpointerName` `NodeSqliteSaver`, so it runs. If our saver stores full state per checkpoint, it fails, and the PR adds the same skip with a written reason. 7.9 does not say which; 7.11 assumes the text repeats in every checkpoint, so expect the skip (open: WP4 decides). No unexplained skip.
- **Foreign keys (O7-3).** Thread ids are unknown in advance: `uuid6(3)` (`lgv:dist/spec/put.js:10`), `"thread-1"` in `getTuple` and `list`, `"1"` and `"2"` in `deleteThread` (`lgv:dist/spec/delete_thread.js`). The initializer wraps the saver: on the first `put` or `putWrites` for an unknown thread id it inserts a test meeting and a run row with `id` equal to the thread id. Production DDL stays unchanged. The suite needs fresh state per instance (`lgv:README.md`), so `destroyCheckpointer` deletes the test meeting. That production foreign keys stay intact is UNVERIFIED.

Own cases: **S1** `sqlite_master` lists `llm_checkpoints` and `llm_checkpoint_writes` after migration 40. **S2 to S5** `Uint8Array` round-trips through `BLOB`; `deleteThread` leaves 0 rows for the thread and keeps others; a failed write rolls back with no partial checkpoint; a write for a deleted run inserts 0 rows and does not throw (7.9, C6). **S6** is dropped: `node:sqlite` is synchronous, so a second handle in the same process blocks the thread and throws `database is locked` (a probe on 2026-10-17, Node 26.5.0, took 1096 ms). Production uses one cached handle (`S/lib/db.ts:15-47`), so only another process can contend. **S7** nodes A, B, C: B throws after A is checkpointed; close the handle, drop the saver, open new ones on the same file; resume with the same `thread_id` and `durability: "sync"`; counters A 1, B 2, C 1 (WP4 acceptance). **S8** a child process that kills itself is not planned: it needs its own Knip entry and a TypeScript loader (WP4); the E2E kill test (10.11.3) covers it. **S9** the suite and S1 to S7 pass on Node 22 (10.2 rule 8).

The first WP4 test runs a small graph with a retry under the `T/setup.ts` fake timers. A hang means the sleep needs `vi.advanceTimersByTimeAsync` or a per-file opt-out (10.2 rule 4). A graph with no retry under fake timers: UNVERIFIED (3.7 U7, R4).

### 10.8 Graph and runner tests (WP5)

Graph tests use the real graph, the real saver on a temp SQLite file, and the real gateway over a scripted model or stubbed `fetch`. Section 3 lists the tests to add (3.7 X5).

- **GR1 to GR3.** GR1: `drawMermaid()` names exactly the six nodes of Figure 1 (3.7 X5). GR2: only files in `W` import `@langchain/*` (3.1 layout rule 1), and a scan of the static `import` graph from `S/index.ts` reaches no module that imports `@langchain/*` (3.1 rule 2). GR3: set `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING`, `LANGCHAIN_TRACING` to `true`, call `W/load-graph.ts` in a fresh registry: all four are gone from `process.env` before the graph module loads.
- **GR4 Fan-out.** `N` chunks give `N` runs of `correctChunk`; at most 3 alive (`WORKFLOW_FANOUT_CAP`; counter +1 at entry, -1 at exit); a local fake server sees at most 1 request in flight (`S/lib/llm/lane.ts:106-107`); results return in chunk order. Settles 3.7 U3.
- **GR5 One failed chunk.** Chunk 2 ends in `content_filter`, others succeed: run `partial`, the failed chunk keeps its raw text, `identifySpeakers` still runs. This is the #163 replay: chunk 0 ends in `length`, the other chunks' speaker suggestions survive.
- **GR6 Length route.** Table below.
- **GR7 Total requests.** Persistent 503: 2. `content-filter`: 1. HTTP 401: 1. Invalid JSON: 2. Whole graph, real retry settings (G5). The count proves the one retry layer of 5.6 (3.2 edge rule 7).
- **GR8, GR9 Cancel.** Soft: 2 calls queued, 1 in flight; queued calls stop, the in-flight call aborts, the graph reaches `save`, finished chunks are saved, run `cancelled` (3.4.5). Hard: a node ignores its signal; after `HARD_STOP_GRACE_MS` (30 s, advance the fake clock) the run ends `cancelled` and `save` does not run.
- **GR10 Resume, in process.** (a) `correctChunk`: throw inside a node after chunk 2 ends; new graph and saver on the same file; `invoke(null, config)`. Chunks 1 and 2 send 0 new requests. The reducer keeps one entry per chunk (3.3). (b) `identifySpeakers`: 0 requests for a finished half. (c) `summarize`: throw after map call 2: 0 requests for maps 0 and 1 (4.0.7 keys); and with two reduce levels, throw after the level-1 calls: 0 requests for them, and the level-2 call gets the level-1 results.
- **GR11 Resume guards.** One test per guard of 3.4.7 (6). A failed guard gives 409 with a `ResumeConflict` whose `reason` is the one of its guard (3.4.2). Guards 4 and 6 end the run `failed` and delete its checkpoints; guards 1, 2, 3 and 5 leave the run row as it was. Changed `graph_version`: `failed`, `graph_changed`. Re-transcribe, or re-diarize, between kill and resume: `transcript_changed`. A summarize-only run also gets `transcript_changed` when a name is confirmed or an Enhance run writes `enhanced_text` while it is stopped. A confirmed name does not stop the resume of an Enhance run (guard 6).
- **GR12 Boot sweep.** A `running` row with a checkpoint becomes `interrupted`; without one, `failed` `interrupted_before_checkpoint`. Boot resume runs once (`MAX_AUTO_RESUMES` 1); a second crash leaves `interrupted`. The sweep uses synchronous SQL only. With the endpoint down, the boot resume waits, does not count and leaves the row `interrupted`. Run this case twice: a `server` profile over a fake server that refuses connections, and a cloud profile (`openai`) over a stubbed `fetch` that rejects. A stubbed answer of HTTP 404 or 503 means the endpoint is up: the probe passes and the resume runs. The probe tries and the waits between them use the injected `sleep` (3.4.2), so the test needs no real wait. A graph error also leaves `interrupted`, with its `failure`, and the boot resume skips it.
- **GR13 Delete during a run.** Delete the meeting between two nodes: recorder, saver and `save` catch the foreign key error, the run ends with no error, and the six `llm_*` tables hold 0 rows for it (3.4.8). Trigger and FK behavior on Node 22.22.1 is 3.7 U5; the E2E run settles it (10.11.3).
- **GR14 Checkpoint size.** After the first fan-out step no checkpoint row holds the system prompt text, and row size stays near transcript size, not 40 times it (3.7 U10, 3.3).
- **GR15 Durability.** The runner passes `durability: "sync"` to every `invoke` (config spy; kill tests prove the effect).
- **GR16 `save` twice.** `save` twice with the same state gives the same database (4.6.2): the same rows in `meeting_segments`, `meeting_speakers`, `meeting_summaries`, and the same link rows (key `(call_id, target_type, target_id, seq)`).
- **GR17 Checkpoint deletion.** One rule, 3.4.6 step 5 (O7-2 is closed, 7.15). After a run reaches `succeeded`, `partial`, `failed` or `cancelled`, the thread has 0 rows in `llm_checkpoints` and 0 in `llm_checkpoint_writes`. This holds after a hard stop, and after a failed guard 4 or 6 of 3.4.7. After a run reaches `interrupted` (a boot sweep, or a graph error with a checkpoint), the thread has more than 0 rows in `llm_checkpoints`. One test for each of the five statuses.
- **GR18 Run-wide stop.** The first request gets HTTP 401 (or the key is missing): 1 request in all (0 for a missing key), every other unit is `skipped`, also the units that waited in the lane while the first call ran (5.1 step 4), `save` runs, the run is `failed`. Three `schema` failures in a row stop the node (`BREAKER_N`).
- **GR19 Two units, one node run.** Chunks 1 and 2 each get one retryable error: each is retried once, none escapes, the run is `succeeded`.
- **GR20 Many calls in one node (X7).** (a) A split chunk whose second half has a persistent 503 sends 4 requests: original, first half, second half twice. (b) A persistent 503 on the reduce call after N map calls sends N + 2 requests, and no map call is sent again.
- **GR21 Faults.** (a) No API key at the first call: `model_unavailable`, 0 requests, run `failed`. A node that throws a plain `Error` (try `verifyEvidence` and one `correctChunk` task): `internal`, the failed result shows in the final state (4.0.2), the graph reaches `save`, and the run is `partial` when another write committed. A `save` write that throws twice: `save_failed` in `SaveResult.failures`, run `partial` (3.4.3 rule 6); if SW1 and SW2 both fail twice, run `failed`. (b) A graph error with a checkpoint: run `interrupted` with its `failure`, checkpoint kept.
- **GR22 Deadline.** A Summarize run with a small ceiling ends `deadline_exceeded`, run `failed`, no summary, no step marked `cancelled`.
- **GR23 Status tables.** Pure tests, with no database, runner or model. (a) `foldStatus` (4.0.7): each of its five rows, a `partial` entry as both `ok` and `failed`, the empty list (`skipped`), and the case `ok` plus `skipped` (gives `skipped`). (b) `deriveRunStatus` (3.4.3): one hand-built `FinalState` for each of the 7 rules, and one for each example of the table there. The Summarize-only case with `summary.status` `failed` gives `failed`, not `partial` (4.6.3).

The length route (4.0.6) has four steps: `lowerReasoning`, `split`, `raise`, `fail`. Run each path against a scripted model and count requests.

| # | Scripted answers | Req | Result |
|---|---|---|---|
| LR1 | 1200-token chunk `length`; both halves `stop` | 3 | Chunk `ok`. Halves saved in order. Segment ids intact. |
| LR2 | Every call `length` for a 1200-token chunk | 11 | Unit fails with `length`, other chunks fine. 11 is the 4.0.6 maximum: 1 call, 2 halves, 4 quarters, 4 raises. |
| LR3 | One-segment chunk `length`, also after the raise | 2 | Cannot split. Raises once. A second `length` fails the unit. |
| LR4 | `identifySpeakers`, reasoning on (the `reasoningSteps` hook of 5.5 rule 4: `{ identifySpeakers: "bounded" }`), `length` | 2 | Step 1 runs. 1st body: `enable_thinking` `true` and `thinking_budget` (5.5.2). 2nd body: `enable_thinking` `false`, no `reasoning_effort`, no `thinking_budget` (5.5.2). |
| LR5 | The raise step | 2nd | `max_tokens` = `min(profile.maxOutputTokens, 2 x maxOutput)`; the wrapper keeps the larger `max_tokens`, so the raise reaches the wire even under a lower preset value (`S/lib/llm/registry.ts:127-138`). |
| LR6 | `reasoning_leak`, reasoning on (the `reasoningSteps` hook, as LR4), then off | 2, then 1 | On: step 1. Off: the unit fails at once (5-P6). |
| LR7 | 1200-token chunk `length`; first half `stop`, second half `content_filter` | 3 | Chunk `partial`. `save` writes the first half and keeps the old text of the second half. |
| LR8 | HTTP 413 on a 1200-token chunk; then both halves `stop` | 3 | `split` only: no `lowerReasoning`, no `raise`. |
| LR9 | `summarize`: the `single` call ends `length`; every call of the replanned map and reduce `stop` | 1 + planned map and reduce calls | Keys `single`, then `map:<i>` and `reduce:<level>:<group>` (4.0.7). Step `single` ends `succeeded`. A summary is saved. Total at most 24. |
| LR10 | `summarize`: call `map:2` ends `length`; both halves `stop` | 3 for this chunk | Keys `map:2`, `map:2/0`, `map:2/1`. The reduce reads both half results in order. |
| LR11 | `summarize`: call `reduce:1:0` ends `length`; the raise `stop` | 2 for this call | Same key `reduce:1:0`, attempt 2, `max_tokens` = `min(profile.maxOutputTokens, 2 x maxOutput)`. |

A node with a failed unit never throws. The unit gets a `NodeFailure` with a `FailureKind` (4.0.7). A test per kind checks the kind reaches the run row and call record unchanged.

**Owner of each test.** Each test below has one WP and one test file. That WP writes it and must pass it before its PR is ready (11.5, 10.17). The H1 check of 11.6 lists these files as owned paths. WP5a tests use a test `RunContext` and read node statuses and rows. The run status in WP5a tests is the output of `deriveRunStatus` (3.4.3), which WP5a writes. WP5b tests use the runner and the run row. WP6 tests cover the `summarize` node. A test with parts for two WPs has lettered parts, and each part has one WP. The files are in `apps/server/tests/`, and each name starts with `workflow-`.

The table has the rows of 10.8 and also the rows of 10.5.1 and 10.6 that no earlier text assigned. "10.6 rows" are the node rows of 10.6, without the `summarize` row.

| Test | WP | File | Why |
|---|---|---|---|
| GR1, GR2, GR3, and U6 (3.7) | WP5a | `workflow-graph.test.ts` | Graph shape, import rules, `W/load-graph.ts` (3.1). U6: the acceptance step names the four variables in the installed `@langchain/core` (11.5 WP5a) |
| GR5 | WP5a | `workflow-graph.test.ts` | The #163 replay through nodes, `save` and `deriveRunStatus` |
| GR7 | WP5a | `workflow-graph.test.ts` | Request counts through the whole graph (G5) |
| GR14 | WP5a | `workflow-graph.test.ts` | Checkpoint row size |
| GR18, GR19 | WP5a | `workflow-graph.test.ts` | Run-wide stop and breaker; two units in one node run |
| GR21 (a), first two cases | WP5a | `workflow-graph.test.ts` | No API key; a node that throws a plain `Error` |
| Stability and "no attendee in any request" (10.5.4) | WP5a | `workflow-graph.test.ts` | Two fictional meetings put the same JSON schemas on the wire. A calendar link with attendees puts no attendee name in a recorded request |
| The "Req" column of 10.5.1: rows A1 to A3, A6 to A18, HE1 to HE10, HE12 to HE16 | WP5a | `workflow-requests.test.ts` | Requests through `callUnit` and the real gateway over the scripted model (G5). WP3 cannot run `callUnit` |
| 10.6 row `prepare`, without the `inputHash` cases | WP5a | `workflow-prepare.test.ts` | Chunks, labels, settings in the state, `empty_input`. The `inputHash` cases are the WP2 test `input-hash.test.ts` (10.9 check 6). Both `input-hash.ts` and its test are planned and absent at `c47cd80d` (4.1 P11) |
| 10.6 row `correctChunk`; GR6; LR1 to LR3, LR5, LR7, LR8; GR20 (a) | WP5a | `workflow-correct.test.ts` | The length route of `correctChunk`, the four drop reasons, many calls in one node |
| 10.6 row `identifySpeakers`; LR4, LR6 | WP5a | `workflow-identify.test.ts` | Anchor lines, halves, the length route of `identifySpeakers` (reasoning on through the `reasoningSteps` hook, 5.5 rule 4) |
| 10.6 row `verifyEvidence` | WP5a | `workflow-verify.test.ts` | The ten drop reasons, normalization, conflict policy |
| 10.6 row `save`; GR16; GR21 (a), the `save` case; GR23 | WP5a | `workflow-save.test.ts` | Idempotent writes, link keys, `SaveResult`, `deriveRunStatus` (3.4.3), `foldStatus` (4.0.7) |
| GR4 | WP5b | `workflow-runner.test.ts` | The fan-out cap is a runner setting (3.5 rule 2) |
| GR8, GR9 | WP5b | `workflow-runner.test.ts` | Soft cancel and hard stop (3.4.5) |
| GR13 | WP5b | `workflow-runner.test.ts` | Delete during a run (3.4.8) |
| GR15, GR17 | WP5b | `workflow-runner.test.ts` | `durability`; checkpoint deletion at each status (3.4.6) |
| GR21 (b) | WP5b | `workflow-runner.test.ts` | A graph error with a checkpoint (3.4.6 step 1) |
| GR10 (a), GR10 (b), GR11, GR12 | WP5b | `workflow-resume.test.ts` | Resume, guards, boot sweep and boot probe (3.4.7) |
| LR9 to LR11; GR10 (c), GR20 (b), GR22; 10.6 row `summarize` | WP6 | `workflow-summarize.test.ts` | The length route, resume, many calls and deadline of `summarize` (4.5.5); the cost and token cases of 4.5 |

Live probes (10.12) have an owner too. WP3: LP1, LP4, LP6. WP5a: LP2, LP3, LP7. WP5b: LP5, which settles U4 (3.7). WP5a settles U6.

### 10.9 Migration, store and route tests (WP2)

Section 7.3 lists the migration tests, 8.12 the route and lookup tests, and 11.5 WP2 the acceptance checks. Two tests pin schema version 39 (`T/schema-meetings.test.ts:7`, `T/migration-servers.test.ts:91`): raise both to 40. Six more checks:

1. **A real v39 file.** Also run the branch build once on a `.backup` copy of the real database in the scratch folder: `sqlite3 -readonly "<db>" ".backup <scratch>/copy.db"` (`LT:14`). Print counts only. The server start runs the meeting retention sweep at once (`S/index.ts:216`; the timer helper calls its callback at start, `S/lib/daily-sweep.ts:23-26`; the callback is wired at `M/retention.ts:65-67`). The sweep deletes `mic.wav` and `system.wav` at the `audio_dir` of each expired row (`M/retention.ts:41-58`), and on a copy those paths point into the real profile. So after the `.backup` and before the boot, run `UPDATE meetings SET audio_dir = NULL` on the copy. Then `SELECT count(*) FROM meetings WHERE audio_dir IS NOT NULL AND audio_dir NOT LIKE '/tmp/%'` must print 0. The count query is this spec's own. `MB:17` gives the same `/tmp/` check as a manual `select`.

```sql
SELECT version FROM schema_version WHERE id = 1;   -- the new SCHEMA_VERSION (40)
SELECT count(*) FROM meetings;                     -- equals the count before the upgrade
PRAGMA foreign_key_check;                          -- no rows
```

2. **No prompt text in meeting routes.** `GET /api/meetings` and `/api/meetings/:id` read with `SELECT *`. The list reads `meetings` (`S/routes/meetings.ts:1333`). The detail route reads `meetings` through `getMeetingRow` (`M/store.ts:92`, called at `S/routes/meetings.ts:2217`) and `meeting_summaries` (`S/routes/meetings.ts:2227`). Neither answer carries run data, and `llm-runs` carries statuses and failure kinds only. A sentinel word seeded in `messages_json` and `raw_text` appears in none of the three responses.
3. **Start contract** (HTTP contract table of 3.4.2). `POST /:id/enhance` and `/:id/summarize` answer 202 with `runId`; guards keep 404 (unknown meeting) and 409 (wrong status, running job, empty transcript). `POST /:id/runs/:runId/resume` answers 202 `StartRunResponse`, 404, or 409 `ResumeConflict` with the `reason` of the failed guard (3.4.2, WP5b). With the flag `meeting_enhance_workflow` off, the old 200 body stays (11.5 WP5b acceptance 2).
4. **No server gate.** The server has no `advanced_mode` gate (D10): call records answer with it off. The renderer sends no request when it is off (10.11.2).
5. **Recorder** (7.7; WP2, on a real file). `startStep` for three keys in order gives `seq` 1, 2, 3; a second `startStep` of the first key keeps `seq` 1 and `attempts`; after `sweepInterrupted` and a new `startStep` for a fourth key the value is 4. Three `recordCall` calls for the same run and unit key return `attempt` 1, 2, 3 and a call for another key returns 1. A call that was not recorded takes no number. `finishedCall` returns the newest row with `error_kind` NULL, and `null` for a row with a cut marker, a missing `finish_raw` or a `params_json` that does not parse. `linkCall` with the same `(call_id, target_type, target_id, seq)` twice leaves one row, and two links with different `seq` leave two rows.
6. **Input hash** (4.1 P11; WP2, on a real file). The tests of the `prepare` row in 10.6 that name `inputHash`.

Cascade read-back after a real delete (table names: 7.4):

```sql
SELECT 'llm_runs', count(*) FROM llm_runs WHERE meeting_id = :id
UNION ALL SELECT 'llm_run_steps', count(*) FROM llm_run_steps WHERE meeting_id = :id
UNION ALL SELECT 'llm_calls', count(*) FROM llm_calls WHERE meeting_id = :id
UNION ALL SELECT 'llm_call_links', count(*) FROM llm_call_links WHERE meeting_id = :id
UNION ALL SELECT 'llm_checkpoints', count(*) FROM llm_checkpoints WHERE meeting_id = :id
UNION ALL SELECT 'llm_checkpoint_writes', count(*) FROM llm_checkpoint_writes WHERE meeting_id = :id;
-- before the delete: rows. after DELETE /api/meetings/<id>: six rows with count 0.
```

### 10.10 Renderer tests and locales (WP7)

Vitest runs `.ts` tests in a node environment with no `jsdom`, `happy-dom` or `testing-library`, so renderer tests check pure logic (`E/vitest.config.ts:16-21`; style of `E/src/renderer/src/pages/meetings/speakers.test.ts:1-18`). Components get E2E proof. Inspector rules live in the one pure `.ts` helper of WP7, with its test (WP7 card, 11.5). The card names no file. `llm-inspector-model.ts` is only a proposed name, and no such file exists at `c47cd80d`. The helper holds: ledger grouping and the "Current" mark; error kind to text key with the `unknown` fallback; choice of the producing call for an edit (8.12); the notice lines of 8.9 (one line for each error kind, the chunk list, the `run.errorKind` fallback) and the buttons for each run status. One pure gate function: `advanced_mode` equal to `"true"` (`E/src/renderer/src/shell.tsx:178-179`); test `"true"`, `"false"`, missing, garbage. Strings every user sees (failure notice, step status) go into a `KEY_GROUPS` entry of `locales.test.ts` (8.10, group `enhance-honesty`). `KEY_GROUPS` starts at `E/src/renderer/src/locales/locales.test.ts:67`. The loop at `locales.test.ts:439-455` runs each group over `template.json` and the 7 locale files, 8 files in all. Advanced-only strings go into `en.json` and `template.json`: this is the WP7 plan (8.10), not existing code. `locales.test.ts:10-15` says locale files may lag behind `template.json` and `en.json`, and `locales.test.ts:461-474` checks the placeholders of `meetings.*` keys. CI runs renderer tests after the server build (`CI:172-175`).

### 10.11 End-to-end tests in the real app

An E2E test starts the built app with `launchOpenstyle` (`E/tests/helpers/e2e-app.ts:36-58`). The server runs from the bundle `out/main/server-process.js` (`E/electron.vite.config.ts:78-83`), which only E2E exercises. No spec covers transcript rows, the Enhance switch (`E/src/renderer/src/pages/meetings/detail.tsx:802-806`) or the Summary tab (`detail.tsx:793`) today. A search of `apps/electron/tests` for `summary`, `summariz` and `enhance` on 2026-10-17 found only the onboarding skip of the Enhance step (`E/tests/app.test.ts:158-171`) and the Models page task rows (`E/tests/preset-crud-evidence.test.ts:673-683`). The two meeting specs, `meeting-import.test.ts` and `meeting-cancel-transcribe.test.ts`, do not assert on those screens.

The fake own server follows `MC:103-146`: `GET /v1/models`, `/v1/models/status`, `POST /v1/chat/completions` by script. The script reads the node and segment ids from the request, not a request counter (fan-out and retries break counters). It logs every request body.

Setup (`MC`, `LT`): (1) `settings.json` with `onboardingComplete: true`; `config.freestyle.json` with the `meetings` flag (`MC:215-229`); `meeting_enhance_prompt_seen` `"true"` (`LT:213-214`). (2) Launch; wait for the dashboard window and the boot orphan sweep. The sweep timer is `setTimeout(..., 3000)` after the server host starts (`E/src/main/index.ts:243,254-257`). The test itself waits 3.5 s (`MC:258-263`). (3) `POST /api/servers` for the fake server; `POST /api/models/configured` with `type` `llm`, `is_default` true (`MC:271-290`); `PUT /api/settings/advanced_mode` (`E/tests/model-picker-groups.test.ts:342`). (4) Seed the fictional meeting with `node:sqlite` as `scripts/site-captures/seed-data.mjs:167-221` does: status `transcribed` (Enhance accepts `transcribed` and `summarized`, `S/routes/meetings.ts:2105`), no audio. Run locally only through the Test Runner in quiet mode (10.11.4).

#### 10.11.1 Spec A: the workflow in the real app

File (WP9): `E/tests/meeting-enhance-workflow.test.ts`. One meeting, 11 chunks. A local fake server has one lane slot, so calls run one at a time (`S/lib/llm/lane.ts:106-107`). The script keys on the set of segment ids in a request (the full chunk set, or a smaller set for a half). Each chunk replays one row of 10.5.1 and 10.8 and expects that row's request count: 1 and 2 `stop` (A1; one correction, none); 3 LR1; 4 LR2 (11 requests); 5 A6; 6 A8; 7 A10 twice; 8 A2 then valid; 9 A2 twice; 10 HE6 then `stop`; 11 HE1 with `Retry-After: 1`.

On screen and in the record, chunk 1 shows edited text; chunk 2 no edit; chunks 3, 8 and 10 show every attempt; chunks 4 to 7 and 9 show the typed failure for the step (`length`, `content_filter`, `unexpected_tool_calls`, `abnormal_stop`, `schema`) and keep the raw text. A run-wide failure stops the other chunks (3.4.5). So each run-wide kind runs in its own meeting of 3 chunks. The four kinds are A14 (`reasoning_leak`, reasoning off), A16 (`model_mismatch`), HE8 (`provider_auth`) and a 400 without `response_format` (`provider_invalid_request`). Each of those runs sends 1 request and ends `failed`. The other chunks show `skipped`. The notice shows one line with the kind. The speaker call has its own script: one valid self-introduction, one quote not in the transcript, one unknown label. A second meeting repeats 429 twice (`provider_rate_limited`) and 503 twice (`provider_unavailable`). `provider_timeout` is not in the E2E (minimum timeout 30 s, `packages/validations/src/settings.ts:400-402`): W10 of 10.5.2 covers it.

- Every request body holds `response_format.type` `json_schema` and `chat_template_kwargs` (WP9 floor).
- Each typed failure stays on screen after reload and restart (G4), with `advanced_mode` off: the notice of 8.9 shows one line for each kind (5 lines in the first meeting, 1 line in each run-wide meeting), with the text of `meetings.llmError.<kind>`. A later run keeps old failures in the run list.
- A summary run with a small `meeting_summary_context_budget` (minimum 100, `packages/validations/src/settings.ts:257-266`) shows map and reduce calls.
- The step fits its CI limit (R13): 1 worker, 2 retries, 5 minutes for the whole E2E step (`E/playwright.config.ts:9,14-15`, `CI:203-205`). Measure the time before and after. Kill tests set `test.describe.configure({ retries: 0 })`: a retry hides a race.

#### 10.11.2 Spec B: the inspector in the real app

File (WP9): `E/tests/meeting-llm-inspector.test.ts`, on the meeting and script of spec A. A segment row has no wrapper or test id today (`E/src/renderer/src/pages/meetings/detail.tsx:830-872`); WP7 adds test ids (precedent: `getByTestId("onboarding-enhance-skip")`, `E/tests/app.test.ts:160`).

1. Gate off: 0 inspector controls in the DOM and 0 requests for call records (`page.on("request")`).
2. Gate on: click an edited text (chunk 1). The panel's system message, user message and response text equal the body the fake server logged. This joins the screen to the wire.
3. The panel shows top-level params `temperature`, `max_tokens`, `response_format` and extra body param `chat_template_kwargs.enable_thinking`, equal to the logged body keys; both finish reasons, tokens, latency, attempt number, served and requested model; every attempt of chunks 3, 8, 10 in order; a failed or retried chunk with no edit (D10).
4. Speakers: kept suggestion with quote and verdict; dropped suggestion with reason. Summary tab: link to the single call, or to the map calls and the reduce call.
5. `advanced_mode` off with the panel open: the panel disappears. Delete the meeting: the six-table query of 10.9 gives six zeros (G7).
6. Screenshots to `OPENSTYLE_EVIDENCE_DIR`: gate off, edit panel, failed-chunk panel, speaker verdicts, summary calls, at 1152x648 and 720x480 (8.12). Claude opens each before it reports (`LT:179`).

#### 10.11.3 Spec A, part 2: kill and resume

Pattern: `E/tests/server-host-restart.test.ts:54-96`. It reads the PID with `app.evaluate` and `__openstyleServerHostPid` (`E/src/main/server-host.ts:256-260`) and sends `SIGKILL`. Main restarts the process after a 1 s backoff (`E/src/main/server-host.ts:27`).

```mermaid
sequenceDiagram
  participant T as Test
  participant A as App server process
  participant F as Fake own server
  T->>A: start Enhance on an 8-chunk meeting
  A->>F: requests 1 and 2 (answered)
  A->>F: request 3 (held, no answer)
  T->>A: SIGKILL the server process
  Note over A: main restarts it, boot sweep marks the run interrupted
  A->>F: boot resume sends the held chunk again
  F-->>A: answers
  T->>A: read result, run row, call records
```

Every chunk gets a plain `stop`, except the fake server holds the third request. Arrival order is not fixed, so the test reads the answered chunk ids from the requests.

1. The restarted server answers `GET /api/health` 200 within 10 s.
2. The run completes. Final texts equal a control run on a second meeting with the same fixture and script.
3. Each answered chunk reached the fake server exactly once in the whole test; the held chunk twice (before and after the kill). A second spec repeats this for the speaker call (the held request is the `identifySpeakers` call) and for a Summarize run with a small budget (kill after map call 2): a finished call reaches the fake server once (call reuse, 5.6). A second request for an answered chunk means the checkpoint was lost: this proves `durability: "sync"` (G6; `lgd:385-387`).
4. No call record stays non-final. Step rows show `succeeded`. The run row shows its final status.
5. The main-process sweep (`transcribingOnly`) leaves the meeting `transcribed` (`E/src/main/server-host.ts:100-104`, `E/src/main/meeting-recorder.ts:818-830`).
6. **Second kill** during the resumed run: boot resume runs once, the run stays `interrupted`, the screen shows the notice and the Resume button (8.9), and a click on Resume completes the run.
7. **Delete during a run** while a chunk is held: no run error, six-table query shows 0 rows. This runs in the Electron server process on Node 22.22.1 and settles 3.7 U5 (3.4.8).
8. Repeat 1 to 5 five times in a row on the Mac; all five pass. Under `async` durability a lost last checkpoint is a race (`lgd:386`), so one pass proves little. CI runs it once.
9. **Endpoint down at boot.** Kill the server and stop the fake server. The boot resume waits, the run stays `interrupted` and `resume_count` stays 0 (3.4.7). Start the fake server again. A click on Resume completes the run. The cloud case has no E2E run, because it needs a cloud key and a cut network. GR12 and W15 cover it with a stubbed `fetch`, and the cloud probe stays UNVERIFIED against a real provider until Q5 names one.

#### 10.11.4 Run rules

Build first, then run through the Test Runner from the repo root (`LT:202,211,217`).

```bash
pnpm turbo build --filter=@openstyle/server
(cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build)
# Count the privacy dialogs before the run (the number must not change)
/usr/bin/log show --last 10m --predicate 'subsystem == "com.apple.TCC"' --style compact | grep -c AUTHREQ_PROMPTING
OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false \
  scripts/test-runner/run.sh "$PWD/apps/electron" -- timeout 600 \
  pnpm exec playwright test tests/meeting-enhance-workflow.test.ts tests/meeting-llm-inspector.test.ts
/usr/bin/log show --last 10m --predicate 'subsystem == "com.apple.TCC"' --style compact | grep -c AUTHREQ_PROMPTING
```

Pass: Playwright reports every test passed and the two counts are equal. Stop at the first privacy dialog. Do not click it. Report the service name. Never start a recording, the microphone or the system audio. Microphone and system-audio tests stay CI-only (`LT:200`).

### 10.12 Live proof on the owner's oMLX

Real server, seeded fictional meeting, the owner's oMLX at `127.0.0.1:8123`, Qwen3.8-27B requests only. Before and after, `timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models` prints `200` (`LT:229`). A guard hook blocks other models (`LT:65`). Send only the fixed node schemas (a new schema costs about 0.45 GB of grammar cache, 10.5.4). The WP3 probes use the real schemas of `W/schemas.ts`, never a throwaway one. That file is new: WP3 writes it (11.4), and it is absent at `c47cd80d`.

1. Build `pnpm turbo build --filter=@openstyle/server`; start from `apps/electron` on its own port with `scripts/isolated-env.sh` (`LT:70-76,87-100`). Set `OPENSTYLE_LOG_DIR` to the scratch folder for fictional text only (`packages/utils/src/logger.ts:38-41`; never for a real meeting, `MB:19`). `LT:102` says leave it unset, but the proofs read the trace log (step 4; 4.2.6, 4.5.6, 5.9, 8.12): this spec plans a skill change (WP9).
2. `POST /api/servers {"url":"http://127.0.0.1:8123"}`; default LLM `Qwen3.8-27B` via `POST /api/models/configured` (`LT:125-126`). Seed a fictional meeting (6 chunks, 3 speakers, one made-up self-introduction) with `node:sqlite`. Start the run (3.4.2); poll `GET /api/meetings/<id>` until it ends.
3. Read back with `sqlite3 -readonly "$OPENSTYLE_DB_PATH"`. For a run with no failed call, `calls` is above 0 and the rest are 0 (G7):

```sql
SELECT count(*) AS calls,
       sum(finish_unified IS NULL)  AS no_finish,
       sum(finish_raw IS NULL)      AS no_raw,
       sum(input_tokens IS NULL)    AS no_input_tokens,
       sum(latency_ms IS NULL)      AS no_latency,
       sum(parsed_json IS NULL)     AS no_object
FROM llm_calls WHERE meeting_id = :id AND error_kind IS NULL;
```

4. Ledger against wire: one call's `params_json` and messages equal the body of its `llm.request` entry in `openstyle-trace.log` (8.12 item 3; `S/lib/trace.ts:257-277`; `server` provider only).
5. Schema on the wire: every LLM node request holds `response_format.type` `json_schema`; `correctChunk` holds `chat_template_kwargs.enable_thinking` `false` (WP5a acceptance). Result: `enhanced_text` count and speaker rows above 0, `chunksFailed` 0.
6. Probes run from a throwaway `.mts` script in the scratch folder that calls the gateway with the real node schema through `scripts/meeting-v2/ts-register.mjs` (`scripts/meeting-v2/compare.mts:11`, `package.json:9-10`; only `compare.mts` imports server TypeScript through it, `:51-55`). That the gateway loads under it is UNVERIFIED: the hook only retries relative `.js` specifiers as `.ts`, and `apps/server/tsconfig.json` has `paths` aliases that plain Node does not apply. WP3 checks the load first. Fallback: a separate vitest config, not in the default run, with real timers. Delete the script after.

Each probe has one owner WP. That WP runs it and reports the result in its PR (11.5, 10.17).

- **LP1** (WP3; G2) typed `length`: one call, `maxOutputTokens` 16 (5.9 check 2). Expect `LengthError`, `rawFinishReason` `length`, the cut text in the record.
- **LP2** (WP5a; 5.10 R5-5, 4.0.6, 4.7 N10) does oMLX stop at the limit with a strict schema? Long prompt wanting a long answer; record the length. If it runs past the limit, the length route cannot work on oMLX: say so. UNVERIFIED.
- **LP3** (WP5a; 4.7 N10) does oMLX apply the strict schema, also to reasoning? Tempting prompt, reasoning on and off. The script switches reasoning on with the `reasoningSteps` hook of `resolveCallProfile` (5.5 rule 4). Record only: the gate parses every answer. Also record whether the top-level `thinking_budget` of the bounded plan (5.5.2) changes the reasoning length. UNVERIFIED.
- **LP4** (WP3; 5.5.3) a preset with `response_format`, `stop`, `guided_json` on `meetingEnhance`: the ledger lists the three as dropped and the body keeps the SDK `response_format`.
- **LP5** (WP5b; 3.7 U4) does a cancel stop generation? (1) Time T0: a one-token request (`max_tokens` 1, Qwen3.8-27B only) to the idle model. (2) Start an Enhance run with a long answer on a fictional meeting. (3) Cancel it with `POST /api/meetings/<id>/cancel-transcribe` (3.4.5). (4) At once, send the same one-token request and time it as R. R close to T0 means the engine stopped. R much larger than T0 means it kept generating. The PR gives T0, R and the oMLX log lines, not a pass line. UNVERIFIED.
- **LP6** (WP3; L4, 5-P4) record the `served_model` oMLX reports; empty or equal are valid. **LP7** (WP5a; L1) reasoning leak: thinking on (the `reasoningSteps` hook), small budget; if none occurs, the fake own server is the only proof.

Not reachable on the owner's oMLX with a safe request: `content_filter`, `unexpected_tool_calls`, unified `error`, HTTP 429 and 5xx, `model_mismatch`. Only the fake own server (10.11) and the scripted model (10.5) prove them; the PR says so. Cloud providers: no live proof is planned unless Q5 names providers (it needs the owner's keys, 12.2; agents never enter keys). Their rows stay UNVERIFIED, including stop aliases and served ids (5.3.4), and Q5 is an entry gate of S5 (12.3). W12 still checks each request body. Cleanup: kill only your PIDs; delete the scratch folder and script; `git status --short` is empty; the oMLX check prints `200`.

### 10.13 Tracing proof (WP8)

Section 9.9 holds the tests and checks C1 to C10. The gate uses `OPENSTYLE_MLFLOW_TRACKING_URI` and `OPENSTYLE_MLFLOW_EXPERIMENT_ID` (9.5.1). A trace counts only after a read-back from the server.

- **Typed-error runs for C6.** Run each once against the real MLflow with the fake own server of 10.11: `length` with valid JSON, `content_filter`, `unexpected_tool_calls`, `abnormal_stop`, `reasoning_leak`, `schema`, `model_mismatch`, `provider_rate_limited`, `provider_unavailable`, `provider_auth`, `provider_invalid_request`, `cancelled`. Run `provider_timeout` once by hand (30 s or more). One more run uses the real oMLX and probe LP1. Send fictional text only. A `length` call that lands as `OK` is the failure to avoid (another project saw it until it set ERROR: `ON` `llm/_telemetry.py:418-438`).
- **Read back** with `MlflowClient.search_traces` (9.9; `CM:77-81`): both span families (our run and node spans, AI SDK spans). Name the experiment in the PR. Ask the owner before you delete it. A tracing test that needs a flush opts out of fake timers (10.2 rule 4; 9.9 test 5).
- The owner can waive the read-back for one round, as for r9, r9b, r9c (`MV2:483-486`). The waiver goes into the round record. No agent waives it.

### 10.14 Bundle and packaging checks (WP1, WP5, WP8, WP9)

The app ships no `node_modules`, so main, preload and the server bundle stay self-contained (`AGENTS.md:87`, `E/electron-builder.yml:20-28`). A run from `out/` hides a missing dependency (the repo has `node_modules`), so only the guard and a packaged run catch it. The standalone server also builds with `pkgroll` (`apps/server/package.json:5`); the 10.12 proof runs that build. Both builds must pass.

| # | Check | Command | Pass when |
|---|---|---|---|
| BC1 | Build | `cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build` | Exit 0; also type-checks (`E/package.json:19`) |
| BC2 | Guard | `node scripts/check-bundled-requires.mjs` | Last line starts with `ok:` (`E/scripts/check-bundled-requires.mjs:71-72`) |
| BC3 | Guard reads chunks | WP1 extends it to `out/main/chunks` and `commonjsRequire(`; today it reads top-level files only (`E/scripts/check-bundled-requires.mjs:34`) and a literal `require("x")` only (`:26`) | A build with a planted dynamic `require(variable)` in a chunk fails the guard (red proof, 10.2 rule 3) |
| BC4 | Dead stubs | `grep -c 'commonjsRequire(' out/main/*.js out/main/chunks/*.js` | Not above the `c47cd80d` baseline. A local build printed 0 for all 10 files on 2026-10-17; its commit is unrecorded, so WP1 measures the baseline |
| BC5 | One SDK copy | `grep -o 'AI_NoObjectGeneratedError' out/main/server-process.js \| wc -l` | 1, as on v6 (6.9.5) |
| BC6 | Sizes | `ls -l out/main/*.js`, `du -sk out/main/chunks`, `app.asar` | Recorded on `main` and the branch with one recipe. Target near 9 MiB (`AGENTS.md:87`); limit is 12.2 Q6 (WP1 proposes 1 MiB, WP5a 3 MiB, WP8 1 MiB: 9.8, Q9.4) |
| BC7 | Packaged build | `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openstyle/electron build:unpack`; `find apps/electron/dist -name app.asar -exec ls -l {} +` | Size reported (WP9 acceptance 5). That it runs on this Mac is UNVERIFIED |
| BC8 | Packaged start | Start `dist/mac-arm64/Openstyle.app` with `OPENSTYLE_E2E=1`, `OPENSTYLE_USER_DATA`, `OPENSTYLE_SERVER_PORT` through the Test Runner; wait for `GET /api/health` 200; run one Enhance against the fake own server by API; read back the records; kill only that PID | Exit as above. That Playwright can drive the packaged binary is UNVERIFIED (the repo sets no Electron fuse: search of `E/electron-builder.yml`, `E/package.json`, `E/scripts`); if not, use this API-only start |

### 10.15 Quality gate: benchmarks and the council (WP10a, WP10b)

D12 asks for a before and after run on the owner's real meetings, then the council. The skills hold the base procedures (`MB`, `CS`); this subsection adds what Enhance needs. Tool gaps: `scripts/meeting-v2/metrics.mjs:636` sets `enhanceSeconds` 0; no committed script calls the Enhance route; the council skill names only `compare.mts` (`CS:14`), whose dump has no `enhanced_text` and no `meeting_speakers` row (`scripts/meeting-v2/dump-chunks.mjs:1-3,19-22`). `dump-speakers.mjs` and `compare-speakers.mts` fit (rounds r9, r9b, r9c: `MV2:483-486`). WP10a adds `scripts/meeting-v2/run-enhance.mjs`; WP10b updates the council skill.

**Data sets.** `ca70f895` (8 chunks) was the only set of r9, r9b, r9c; arm A failed 2 of 8 chunks in r9 (`MV2:483`). It is probably the #163 case: UNVERIFIED, because issue #163 names no meeting id (https://github.com/Maheidem/openstyle/issues/163) and the full id is not in the repo (Q7). Whether its stored `context` holds the arm A text is UNVERIFIED. WP10a records the failed chunks of each baseline run and a hash of the meeting context (`contextHash`). G3 counts only if the old path fails at least one chunk in each baseline run. The earlier rounds show it for arm A: 2 of 8 chunks failed in r9 and in every run of r9b, and 1 or 2 of 8 in every run of r9c (`MV2:483,485,486`). Arm C had 8 of 8 chunks in r9b (`MV2:485`); the other two rounds give no arm C chunk count. Else report "not reproduced" and prove the fix with the forced-failure replay GR5 on the same meeting. The new arm needs 0 failed chunks in 6 of 6 runs with the same `contextHash`. `2943c36a-532e-4db9-af09-b5e66f0bdf2d` (425 s): short control (`MB:24`). `9243bea0-567f-443b-bf3b-9980f69993fd` (3580 s): long, summary path (`MB:25`); if it fits the summary budget (8000 tokens by default: `packages/validations/src/settings.ts:185`, `M/summarize.ts:49`; `M/summarize.ts:365-369` reads the setting), lower `meeting_summary_context_budget` in the scratch database. `parseMeetingSummaryContextBudget` accepts 100 to 200000 and gives 8000 for a missing, malformed or out-of-range value (`packages/validations/src/settings.ts:214-221,257-266`).

**Procedure.**

1. Levels 1 to 5 pass; oMLX answers 200; tracing variables are unset, so no meeting text leaves the Mac (11.1 B12). Arm X is the old path (WP10a), arm Y the new path with the flag on (WP10b), in separate worktrees when code differs (the coordinator makes them, 11.1 B1), one port per arm, never 4649.
2. `./scripts/meeting-v2/setup-scratch.sh <ids>` (`MB:31`); transcribe once; take a `.backup` copy; start every run from it. The `text` column of the X and Y dumps hashes equal before comparing: `jq -S '[.segments[].text]' <dump> | shasum`. The command is this spec's own. It fits the `dump-speakers.mjs` format, which holds `segments[].text` (`scripts/meeting-v2/dump-speakers.mjs:7-8,32-39`). `MV2:485` records that the transcript was the same in all runs (checked), and it gives no command. `textHash` is a second check (`MB:98`); it hashes the ordered segment rows, not the text only (`scripts/meeting-v2/metrics.mjs:142-150`).
3. 3 runs per arm per meeting, 6 on the #163 meeting (a choice of this spec). oMLX with MTP is not deterministic at temperature 0 (`OM:145`; https://github.com/jundot/omlx/issues/4089, https://github.com/jundot/omlx/issues/4214). That the app uses the MTP model `Qwen3.8-27B-oQ4e-mtp` (`OM:133`) is UNVERIFIED.
4. After each run: `node scripts/meeting-v2/dump-speakers.mjs <db> <meetingId> <out.json>` and numbers to `metrics-enhance.json`. Arm Y adds record counts: calls by finish reason, retries, typed failures, dropped suggestions by reason, tokens (the old path stores none). Dumps hold private text: never print or commit them.
5. `pnpm meeting:compare-speakers --x <X dump> --y <Y dump> --x-name <A> --y-name <B> --out <file.md>` re-reads both dumps and the output, deletes the output and exits 1 on any mismatch (`scripts/meeting-v2/compare-speakers.mts:9-13`). Read only its files.
6. The owner approves each data set for Codex, one `AskUserQuestion` per set (`CS:27`). The same holds for pi when the pin names a cloud provider. WP10b runs `pi_list_agents` with `doctor` first. On 2026-10-17 the pin was `openai-codex/gpt-6.1-sol`, a cloud model, so a pi judge would send meeting text to OpenAI. pi reads compare files without approval only when the pin names a local provider (`Desktop`, `local-mac` or `mac-m3`). `CS:26` says pi is local and `.claude/skills/pi-briefs/SKILL.md:8` names an old pin; WP10b corrects both (Q10). Then `bash scripts/council.sh prepare <round> <compare-file>...`; Claude writes its verdict first, pi from `brief-pi.md`, Codex after approval; `bash scripts/council.sh collect <round>` prints `CONSENSUS: yes` or `no` (exit 0 all SHIP, 2 disagreement, 3 missing file: `CS:15-33`, `scripts/council.sh:24-27`). Judge files start with `VERDICT: <SHIP, FIX-FIRST or REVERT> BETTER=<n> WORSE=<n> SAME=<n>`.
7. The coordinator records the round in this spec (WP10b): round, compare files, verdict lines, decision and tracing waiver. Tracing variables stay unset for real meetings (B12), which breaks the rule that every LLM run is traced and read back (`CM`). So WP10b asks the owner with `AskUserQuestion` for a waiver for each round (rounds r9, r9b and r9c had one: `MV2:483-486`, 10.13). No agent waives it. The alternative, with the owner's approval of the privacy trade-off, is to trace to the owner's own MLflow and read the trace back.

**Metrics** (numbers only, `MB:12-19`; gates are a proposal for the owner). Metrics pass first; the council judges the text (`CS:38`). Report a disagreement with the diverging regions; do not re-run until it agrees (`CS:39`). Release and the default flip (12.3, stage S5) need consensus.

| Metric | Gate |
|---|---|
| Failed chunks, untyped failures | #163 meeting: 0 failed chunks in 6 of 6 runs (G3). Untyped failures: 0 on every meeting. |
| Corrections applied (`enhanced_text` count) | Not lower than arm X, without a written reason. |
| Speaker suggestions kept | Not lower than arm X; a label X names in 3 of 3 runs, Y names in 3 of 3 (r9c table, `MV2:486`). |
| Hallucinated suggestions kept (kept quote not a substring of a segment text) | 0. Report a count only. |
| Calls, tokens, seconds | No gate. Y adds one speaker call plus retry and length-route calls; the owner judges the cost. |
| Summary (sections, length ratio, action items) | WP10a plans `run-enhance.mjs --summarize` to add `summarySections`, `summaryChars` and `summaryActionItems` and to print no text (WP10a card, 11.5). The script is in no commit at `c47cd80d`: UNVERIFIED until WP10a. The owner reads the summaries side by side for each data set before S5 (12.3; 10.18 point 1). |

WP10a's `check-enhance-metrics.mjs` makes the numbers that no other tool makes: `hallucinatedKept`, `untypedFailures` and `namedRuns` for each label. The WP10a card says it re-reads its output and exits 1 on a mismatch, as `compare-speakers.mts` does (11.5; `MB`, "Compare tools must check themselves"). The card does not say that it also re-reads the dumps. WP10a decides that. The script is in no commit at `c47cd80d`: UNVERIFIED until WP10a.

### 10.16 Evidence, who runs what, cleanup

**Evidence counts:** the exact command and its real output; a screenshot Claude looked at; a count read back from the real database or MLflow. The coordinator pastes it into the PR (11.1 B1). **Does not count:** green unit tests; a type check; a scripted model where the row asks for the owner's oMLX; an HTTP 200 with no read-back; a screenshot nobody opened; a pass with no output. A step the agent could not run is reported, and the PR marks it UNVERIFIED. The mark is the convention of this spec (header, `Rules`). The duty to say plainly what was not run comes from the Definition-of-Done gate that `CM:7` names; `CM` itself does not contain the word UNVERIFIED. **Who runs what:** Claude runs a proof first; the procedure then goes into a project skill and a script; later runs go to a pi child whose brief names the skill files to read first and, for app, server or E2E runs, the line "Read `.claude/skills/live-testing/SKILL.md` first and follow it" (`LT:225`). Stop pi after 2 failed rounds and finish with a Claude agent (`CM`, "Distill repeatable work for pi"). Haiku agents take mechanical checks (11.6). The coordinator reads every screenshot and re-runs the key commands. **Cleanup:** kill only your PIDs, delete the scratch folder and each throwaway `zz-proof-*` spec, then `git status --short` shows only the card's files (`LT:184-190` covers the PIDs, the scratch folder and `git status`; `LT:210` says to delete the `zz-proof` spec at the end).

### 10.17 Definition of done for each work package

A WP is done when its section 11 card passes and each applicable row below has its evidence. The card holds the commands.

| WP | Levels | Real-system evidence in the PR | Added by this section |
|---|---|---|---|
| WP1 SDK v7 | 1, 2, 4, bundle | Two lock greps; wire-body snapshot, no diff; real dictation, Remix transform, Remix agent runs (acceptance 5); BC1 to BC6 | BC3 red proof. Remix agent screen proof via the Test Runner, TCC count 0 before and after. Negative control: it fails when `packages/stt` keeps `ai` 6.0.191 (6.9.4) |
| WP2 Call record | 1, 3 | Acceptance 1 to 6: real v39 file migrates, route answers, cascade empties the tables, older build opens the v40 file, a `running` run becomes `interrupted`, recorder and hash tests pass | Run on a `.backup` copy of the real database (10.9 check 1); six-table query after a real delete; recorder and input-hash checks (10.9 checks 5 and 6) |
| WP3 Gateway | 1, 2, 5 | Live checks 2, 3 and 9 of 5.9; ledger equals wire | Matrix 10.5.1 (the "One gateway call" column; the "Req" column is a WP5a test), wire tests 10.5.2 (with W15, `probeEndpoint`), registry test W14 (10.5.3), red proof per typed error, probes LP1, LP4, LP6, `maxRetries` check, Check B of 11.4, served ids of the providers with a live proof (Q5); the fixture builder `meeting-fixture.ts` (10.2 rule 1) |
| WP4 Saver | 1, 3, 4 | Suite output with five groups plus delta tests; S1 to S5 and S7 (S6 is dropped, S8 is not planned, 10.7) | Node 22 run; skip decision. The kill test (10.11.3) belongs to WP9 and closes G6 in the real app |
| WP5a Graph and nodes | 1, 3, 5 | Seven `workflow-*.test.ts` files: `workflow-graph`, `workflow-requests`, `workflow-prepare`, `workflow-correct`, `workflow-identify`, `workflow-verify`, `workflow-save` (owner table, 10.8); live 6-chunk run; wire capture | Tests GR1, GR2, GR3, GR5, GR7, GR14, GR16, GR18, GR19, GR20 (a), GR21 (a), GR23, LR1 to LR8; the "Req" rows of 10.5.1; all 10.6 rows except `summarize`; probes LP2, LP3, LP7; #163 replay; 3.7 U6 (with GR3), U7, U10, U11 settled in the PR |
| WP5b Runner | 1, 3, 5 | Two `workflow-*.test.ts` files (`workflow-runner.test.ts`, `workflow-resume.test.ts`); kill and resume by API (11.5 WP5b acceptance 3) | Tests GR4, GR8, GR9, GR10 (a, b), GR11, GR12, GR13, GR15, GR17, GR21 (b) (owner table, 10.8); probe LP5; 3.7 U2, U3, U4, U8 settled in the PR |
| WP5c Default flip | 1, 3, 4 | Acceptance 1 to 5: a missing key gives 202 with a `runId`; `"false"` gives the old body; the Settings row shows on | The S5 entry gates as "Done when" (12.3): `CONSENSUS: yes`, the summary gate, the cloud gate |
| WP6 Summarize | 1, 5 | Acceptance: single call and map/reduce live | Token reconcile test and priced-model cost test (10.6); map/reduce run uses a lowered budget; two reduce levels with two keys (10.6); tests GR10 (c), GR20 (b), GR22, LR9 to LR11 (owner table, 10.8) |
| WP7 Inspector UI | 1, 4 | Acceptance 1 to 4 with screenshots | Spec B (10.11.2) in CI; panel equals logged body; locale group; the flag toggle row in Settings (8.10) |
| WP8 Tracing | 1, 5 | Acceptance 1 and 2 | 9.9 C1 to C10 and typed-error runs (10.13); the coordinator reads back |
| WP9 E2E | 4, 5 | Acceptance 1 to 5 | Spec A (11 chunks and four run-wide meetings), kill tests, delete test, five local repeats, CI step time, packaged start BC8 |
| WP10a Harness | 6 | Baseline numbers, 3 runs of the old path | `text` hash check of both arms; no text printed (a Haiku reader lists every `console.log` and `writeFileSync`, acceptance 3) |
| WP10b Council | 6, 7 | `CONSENSUS: yes`, exit 0 | Metrics table of 10.15; round record in this spec |
| WP11 Remove old path | 1, 5 | Acceptance 1 to 7 | List of deleted `it(` names with successors; harness run within the WP10a spread |

### 10.18 Open points

Name conflicts between sections are in 11.4. Other checks for sections 3 to 9 are in 3.7.

**Open points for the owner and section 12.** (1) Summary quality has no text tool: `compare-speakers.mts` compares names and `enhanced_text` only. `run-enhance.mjs` gets a count-only check (sections present, length ratio, action items), and the owner reads summaries side by side. Both are entry gates of S5 (12.3, Q11). (2) Cloud providers (Q5): no live proof is planned; name the providers and who supplies keys. (3) CI time (R13): the E2E step has 5 minutes and its current time is UNVERIFIED; measure it and ask to raise the limit above 4 minutes. (4) The foreign key wrapper of 10.7 (O7-3) is expected to work; a run settles it, and the 7.9 fallback changes the DDL. (5) One Codex approval per data set. (6) BC7 and BC8 are UNVERIFIED on this Mac; if they fail, the asar size comes from a CI artifact.

---

## 11. Work breakdown and build orchestration

One work package (WP) has one branch, one draft PR and one implementer. Design is in sections 3 to 9; D1 to D12 are in section 1.1.

**Path key.** `S` = `apps/server/src`. `E` = `apps/electron/src`. `V` = `packages/validations/src`. `W` = `S/lib/meetings/workflow` (3.1). `SK` = `.claude/skills`. `build.yml` = `.github/workflows/build.yml`. No prefix = repo root.

### 11.1 Build rules

- **B1** Only the coordinator creates, pushes and merges branches (D11; `SK/branch-lifecycle/SKILL.md:15`). This spec adds that the coordinator also creates the issues, the worktrees and the draft PRs. No skill line says this: rules 1 and 5 (`SK/branch-lifecycle/SKILL.md:12,16`) do not limit them to the coordinator. It is a rule of this spec.
- **B2** One WP = one branch `type/short-topic` and one draft PR born with the branch (`SK/branch-lifecycle/SKILL.md:12,14`). A WP in a parallel lane also gets one worktree, because the skill allows worktrees only for parallel lanes (`SK/branch-lifecycle/SKILL.md:16`). A WP that runs alone needs none.
- **B3** PR body: Goal, Spec (path and section), Owner, Done when (`SK/branch-lifecycle/SKILL.md:12`), and a link to the issue. Here the link is `Refs #185`, the umbrella issue; the skill allows `Refs #n` for partial work (`SK/branch-lifecycle/SKILL.md:12`). `AGENTS.md:97` says each branch links its issue and that work is tracked in Project 1. One child issue per WP in Project 1 is a rule of this spec.
- **B4** Worktree: `git worktree add -b <branch> ../openstyle-<topic> origin/main`; remove on merge.
- **B5** Cut a branch only after all hard dependencies merge. This is a rule of this spec: the solid arrows of 11.3 mark the hard dependencies. A PR idle 2 days is finished or closed (`SK/branch-lifecycle/SKILL.md:20`).
- **B6** The owner allows more than 2 open PRs (D11). The skill and `scripts/branch-status.sh:21,48` still say 2 and print `!!` above it (Q4; `.claude/settings.json:3-12`).
- **B7** Ready = gates + own acceptance pass. This definition is from this spec: the skill uses the word "ready" and does not define it. Then run `gh pr ready` and `gh pr merge --squash --auto` (`SK/branch-lifecycle/SKILL.md:19`).
- **B8** Every `gh` call runs with `GH_TOKEN="$(gh auth token -u Maheidem)"` (`AGENTS.md:99`).
- **B9** A new file or dependency is imported in the same PR, or knip fails (`AGENTS.md:85`; `build.yml:91-100`).
- **B10** Only the coordinator edits `pnpm-lock.yaml`. After each rebase, run `pnpm install` and read the diff. Both are rules of this spec; no repo doc states them (`AGENTS.md` and the skills have no lockfile rule). [pnpm](https://pnpm.io/git) says to run `pnpm install` after a lockfile merge conflict and to review the result. It does not mention rebase and does not say who edits the lockfile.
- **B11** Unit tests never close a WP; each card names the real run (section 10).
- **B12** Only WP10a and WP10b read real meetings. This is a rule of this spec: proof P4 (real meetings) is only on the WP10a and WP10b cards of 11.5. Report numbers only (`SK/meeting-benchmarks/SKILL.md:15`). Leave `OPENSTYLE_LOG_DIR` unset (`SK/meeting-benchmarks/SKILL.md:19`). Leave the MLflow variables of WP8 unset (D8).
- **B13** Local app runs, E2E and UI proofs use quiet mode via `scripts/test-runner/run.sh` (`SK/live-testing/SKILL.md:20,202`).
- **B14** After each run that calls oMLX, `timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models` prints `200`. Send only Qwen3-ASR and Qwen3.8-27B requests (`SK/live-testing/SKILL.md:227-229`).
- **B15** WP1 lands before any gateway, node, record or inspector code (M1, 6.1). WP2 may start early and merges after WP1.

**Gates** (repo root; all must pass).

| Gate | Command | Pass |
|---|---|---|
| GT1 | `pnpm biome check .` | exit 0 (`AGENTS.md:69`) |
| GT2 | `pnpm run knip` | exit 0 (`AGENTS.md:71`) |
| GT3 | `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck:web && pnpm --filter @openstyle/electron typecheck:tests && pnpm --filter @openstyle/server typecheck:tests` | exit 0. CI runs the build and the three typechecks (`build.yml:112-125`). `AGENTS.md:72` lists the build and two typechecks only; the server `typecheck:tests` is in `build.yml:123-125` |
| GT4 | `NODE_OPTIONS=--expose-gc pnpm --filter @openstyle/server test`, then `pnpm --filter @openstyle/stt test`, `pnpm --filter @openstyle/validations test`, `pnpm --filter @openstyle/electron test` | each exit 0; CI sets `--expose-gc` for the server step only (`build.yml:137-150`) |
| GT5 | `cd apps/electron && pnpm run build && node scripts/check-bundled-requires.mjs` | last line `ok:` (`check-bundled-requires.mjs:71-72`); when a WP changes dependencies or bundle |
| GT6 | `gh pr checks <n>` | `CI Status` passes. Its job fails only when a needed job failed or was cancelled; a skipped job counts as a pass (`build.yml:534-551`) |

One test file: `pnpm --filter @openstyle/server test tests/<file>.test.ts` (never add `--`, `AGENTS.md:81`).

**Proof types.** P1 command, no screen. P2 live LLM (Qwen3.8-27B on the owner's oMLX, fictional text). P3 screen (real app via test runner, fictional meeting). P4 real meetings, numbers only. P5 trace read back from MLflow.

### 11.2 Work packages at a glance

| WP | Title | Spec | Hard deps | Branch |
|---|---|---|---|---|
| WP1 | AI SDK v7, no behavior change | 6 | none | `chore/ai-sdk-v7` |
| WP2 | Migration 40, recorder, read routes | 7, 8.3, 8.4 | none (merges after WP1) | `feat/enhance-llm-record` |
| WP3 | Gateway, model profiles, typed errors | 5 | WP1, WP2 | `feat/enhance-llm-gateway` |
| WP4 | `node:sqlite` checkpoint saver | 3, 7.9 | WP2 | `feat/enhance-sqlite-saver` |
| WP5a | Graph, six node slots, nodes except the `summarize` body | 3, 4 | WP2, WP3, WP4 | `feat/enhance-workflow` |
| WP5b | Runner, resume route, boot sweep, flag | 3.4, 3.5 | WP4, WP5a | `feat/enhance-runner` |
| WP6 | `summarize` node, route switch | 4.5, 3.6 | WP5b | `feat/enhance-summary-node` |
| WP7 | Inspector UI, persisted failure notice, Resume button, flag toggle row | 8 | WP2, WP5b | `feat/llm-inspector-ui` |
| WP8 | Tracing, opt-in | 9 | WP1, WP3, WP5b | `feat/enhance-tracing` |
| WP9 | Committed E2E specs, whole-feature proofs | 10 | WP5b, WP6, WP7 | `test/enhance-e2e` |
| WP10a | Benchmark harness, old-path baseline | 10, 12 | none | `chore/enhance-benchmark-harness` |
| WP10b | After-run, compare files, council | 10, 12 | WP9, WP10a | `docs/enhance-council-record` |
| WP5c | Default flip: a missing flag key means the new path | 12.3 S5, 3.4.2 | WP10b | `chore/enhance-default-flip` |
| WP11 | Remove old path and flag | 12 | WP5c, Q1 | `chore/remove-legacy-enhance` |

Spec PR #186 merges before any WP branch is cut. "WP5" elsewhere = WP5a + WP5b. WP5c is the default flip. It comes after WP10b and is not part of "WP5".

### 11.3 Dependency graph and waves

```mermaid
flowchart TD
  SPEC["Spec PR 186"] --> WP1
  SPEC --> WP2
  SPEC --> WP10a
  WP1 -.->|merge order M1| WP2
  WP1 --> WP3
  WP2 --> WP3
  WP2 --> WP4
  WP2 --> WP7
  WP2 --> WP5a
  WP3 --> WP5a
  WP4 --> WP5a
  WP4 --> WP5b
  WP5a --> WP5b
  WP5b --> WP6
  WP5b --> WP8
  WP1 --> WP8
  WP3 --> WP8
  WP5b --> WP9
  WP6 --> WP9
  WP7 --> WP9
  WP9 --> WP10b
  WP10a --> WP10b
  WP10b --> WP5c
  WP5c --> WP11
  WP5b --> WP7
```

Solid = hard dependency (cut the branch after the merge). Dashed = soft (merge order or test data). Waves: 1 WP1, WP2, WP10a; 2 WP3, WP4; 3 WP5a; 4 WP5b; 5 WP6, WP7, WP8; 6 WP9; 7 WP10b; 8 WP5c (after the council consensus), then release B; 9 WP11 (after one release with default on, and Q1). Proposed cap: 4 open WP PRs (Q4). WP5a imports `@langchain/langgraph`, which WP4 adds to `apps/server/package.json` (the WP5a card: "WP4 did"), and its graph tests run on the WP4 saver (10.8). So WP4 is a hard dependency of WP5a, and B5 cuts the WP5a branch only after the WP4 merge. WP4 stays in wave 2, so no wave changes.

### 11.4 File ownership and conflict matrix

One WP writes a file at a time; several writers go in the listed order. New files have one owner (cards list them). `*` = only if the notes say so.

| File | WPs in order |
|---|---|
| `pnpm-lock.yaml`, `apps/server/package.json` | 1, 4, 8 |
| `pnpm-workspace.yaml`, `apps/electron/package.json`, `check-bundled-requires.mjs` | 1 |
| `packages/stt/**` | 1; then 3 for `src/text.ts` and `src/index.ts` only (`THINK_TAG` export, 5.3.3) |
| `S/lib/llm/registry.ts`, `lane.ts` | 1, 3 (named edits: `LlmTaskContext` callback, `gatewayOverrides`, `signal` in the `Pick`) |
| `S/lib/llm/task-profiles.ts` | 3 (`pin`, `droppedKeys`, `source`; the scoped denylist) |
| `S/lib/llm/gateway.ts` | 3, 8 |
| `V/llm-task-profiles.ts` | 3 |
| `S/lib/schema.ts` + the two tests pinning 39; `call-record.ts` (with the base types `LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode`, `GatewayErrorKind`: 5.1 rule B), `llm-record.ts`, `llm-record-read.ts`, `input-hash.ts`; `S/routes/index.ts` | 2 (`llm-record.ts`: then 5b) |
| `S/routes/meetings-runs.ts` | 2, 5b |
| `V/meeting-types.ts` (WP2 also declares `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason`, `LlmMessage`, `LlmParamsLedger`: 5.1 rule B) | 2, 5b |
| `S/index.ts` | 2, 5b, 8 |
| `W/checkpoint-saver.ts` | 4 |
| `W/graph.ts`, `state.ts`, `types.ts` (also `WORKFLOW_GRAPH_VERSION`, `foldStatus`, `deriveRunStatus`, `SaveResult`), `context.ts` (also `WorkflowDeps`, `productionDeps`), `load-graph.ts`, `nodes/*` (`summarize.ts` is a stub in 5a) | 5a, 11 (the import lines of `nodes/*` only) |
| `W/unit.ts` (`callUnit`, `gatewayRetryOn`, `guardNode`) | 5a, 8 (one named edit: `guardNode` calls `inNode`, 9.10) |
| `W/schemas.ts` | 3 |
| `W/prompts.ts` (new: the prompt builders of the LLM nodes) | 5a (`correctChunk`, `identifySpeakers`), 6 (`summarize`) |
| `W/chunking.ts` (new: `chunkForEnhance`, `chunkTranscript`, `estimateTokens`, moved from the old files) | 11 |
| `S/lib/meetings/enhance.ts`, `enhance-prompt.ts`, `summarize.ts`, `summary-prompt.ts`, `llm-call.ts` | 11 (WP5a and WP6 import the exported helpers of 3.1 and edit none of these files) |
| `apps/server/tests/helpers/meeting-fixture.ts` | 3 |
| `apps/server/tests/{meeting-enhance,meeting-summarize,meeting-llm-timeouts,llm-task-profiles,meetings-calendar}.test.ts` | 11 (they import the files above; the PR rewrites or deletes each `it(` with a successor or a reason, 10.2 rule 7). WP3 puts its tests W2b and W14 in its own new files, so it does not edit `llm-task-profiles.test.ts` |
| `apps/electron/tsconfig.tests.json` | 9 (adds the fixture builder to `include`, 10.2 rule 1) |
| `apps/electron/tests/meeting-enhance-workflow.test.ts`, `meeting-llm-inspector.test.ts` | 9, 11 (the line that sets the flag) |
| `W/runner.ts` | 5b, 8 |
| `S/lib/meetings/job-registry.ts` | 5b |
| `S/lib/meetings/transcript-io.ts` | 5a |
| `S/routes/meetings.ts` | 5a (move three functions), 5b, 6, 11 |
| `V/settings-keys.ts`, `S/lib/setting-validators.ts` | 5b, 11 |
| `V/settings.ts` (`parseMeetingEnhanceWorkflow`), `packages/validations/src/meeting-enhance-workflow.test.ts` | 5b, 5c, 11 |
| `W/nodes/summarize.ts` | 5a (stub), 6 |
| `E/server-host/entry.ts` | 8 |
| `E/renderer/src/pages/meetings/{detail,speakers}.tsx`, `lib/query.ts`, `locales/*.json`, `locales.test.ts` | 7, 11 |
| `E/renderer/src/pages/settings.tsx` (the row of the flag toggle, 8.10) | 7, 11 |
| `apps/server/tests/meetings-routes.test.ts` (it imports `enhance.js`, `:29, :3122`), `helpers/meetings-db.ts` | 2, 5b, 6, 5c (cases that need the old path: set the flag to `"false"`), 11 |
| `apps/server/tests/workflow-runner.test.ts` | 5b, 5c (the missing-key cases only) |
| `AGENTS.md` | 2, 8, 11 |
| `knip.jsonc` | 10a |
| `SK/meeting-benchmarks/SKILL.md`, `SK/council/SKILL.md` | 10a, 10b |
| `scripts/meeting-v2/run-enhance.mjs`, `check-enhance-metrics.mjs` | 10a, 10b |
| `SK/pi-briefs/SKILL.md` | 10b |
| `specs/meeting-enhance-agentic.md` | 10b |
| `SK/live-testing/SKILL.md` | 9 (WP9 otherwise writes only new files) |

- The graph orders `registry.ts`/`lane.ts`, `gateway.ts`, `index.ts`, `meetings.ts`, `enhance.ts`. It does not order the lockfile and `apps/server/package.json` (WP3, WP4 parallel); B10 and 11.7 settle that.
- WP8 edits `W/unit.ts` (`guardNode` wraps each node body with `inNode`) and `W/runner.ts` (the run span calls `startRunSpan` and `endRunSpan`). It edits no other file of `W/` and no node file (9.10). WP8 writes no settings file (T1).
- Check B (rule B of 5.1). The reviewer (11.6) runs it on the WP2 PR, and again on the WP3, WP5a and WP5b PRs: `git grep -n -E "^export (type|interface) (LlmStepId|ChatTurn|TokenUsage|UnifiedFinishReason|StructuredMode|GatewayErrorKind|SpeakerVerdict|DropReason|EvidenceType|VerdictStatus|CorrectionDropReason|LlmMessage|LlmParamsLedger)( |<|=)" -- apps packages` prints 13 lines, one for each type, in `call-record.ts` (6) and `meeting-types.ts` (7). A 14th line is a second declaration, and the PR fails. This command is a plan: nobody has run it, because the files do not exist at `c47cd80d` (UNVERIFIED).
- No WP edits `apps/server/tests/setup.ts` (fake timers, `:16`); a test needing real timers opts out in its own file (10.2 rule 4, R4). No WP edits `.lore.md` (the lore tool owns it, `AGENTS.md:1-4`, `.lore.md:1`).
- `AGENTS.md` edits are plans of this spec: WP2 version and table list (`AGENTS.md:50`, `S/lib/schema.ts:14`); WP8 "no telemetry" sentence (`AGENTS.md:9`, 9.5.1 item 5); WP11 pipeline paragraph.
- The H1 check (11.6) fails a diff that touches a file the card does not list.

**Name conflicts between sections.** The owning WP may rename in its own PR and edits 11.4 in the same commit. Where a section differs from the Decision column, this column decides.

| Item | Names in conflict | Decision |
|---|---|---|
| Checkpoint saver | `W/checkpoint-saver.ts` (3.1) and `S/lib/meetings/llm-checkpointer.ts` | Resolved: `W/checkpoint-saver.ts`. 7.14 follows. |
| Recorder SQL, reads | `S/lib/llm/call-record.ts`, `W/call-recorder.ts`, `W/run-store.ts` (3.1) and `llm-record.ts`, `llm-record-read.ts` (7.7, 7.14) | Resolved: `llm-record.ts`, `llm-record-read.ts` (WP2; `llm-record.ts` extended by WP5b); `call-record.ts` = types and `CallSink` (WP2); no `run-store.ts`: the recorder is the only writer of `llm_*` rows (3.1, 7.7). |
| Inspector routes | `S/routes/meetings-runs.ts` (3.1) and the chain in `meetings.ts` (8.3) | Resolved: `S/routes/meetings-runs.ts`. |
| Inspector UI | `llm-inspector.tsx`, `run-status.tsx` (3.1) and `llm-inspector.tsx`, `llm-call-view.tsx` (8.11) | Resolved: the files of 8.11. |
| Error kinds | `timeout`, `rate_limited`, `unavailable`, `auth`, `invalid_request` and the `provider_` forms of 5.2.1 | Resolved: the kinds of 5.2.1. 7.6 and 8.10 follow. |
| Outcome of a deleted meeting | `ended` (3.4.3) and `meeting_deleted` (4.0.7, 4.6.3) | Resolved: `meeting_deleted`. 3.4.3 follows. |
| Run status words | `ok` (3.4.3, 4.0.7, 4.6.3) and `succeeded` (7.4, 8.4, 9.6.2, 9.10) | Resolved: `succeeded` for runs and steps. The node status `ok` is stored as `succeeded` (3.4.3). |
| Speaker verdict | 4.4 `SpeakerVerdict` with `DropReason` (10 codes) and 7.5 `SpeakerVerdict` with `SpeakerVerdictReason` (11 codes); 8.10 has a text for each 7.5 code | Resolved: the 4.4 shape, with its 10 drop codes and 3 evidence types (7.5 and 8.10 follow). |
| Step key | 4.0.7 `unitKey`: `chunk:3`, `candidates`, `single`, `map:2`, `reduce:0` (old) and 7.4 `step_key`: `correct:3`, `speakers`, `summarize:map:2` (5.1) | Resolved: `step_key` is the `unitKey`, with the grammar of 4.0.7: `single`, `map:<i>`, `reduce:<level>:<group>`, `<key>/<n>` for halves. A step row holds the top key (7.4). `seq` is the start order of the step (7.7 rule 3). |
| Call record contract | `CallSink.begin/finish` with a string id (old 5.1) and `startAttempt`/`recordCall` with a number id (7.7) | Resolved: one phase, `startAttempt` and `recordCall`, id `number \| null`. A null id is a lost record (5.1, 7.7). |
| Base types | `LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode` sat in the WP3 snippet of 5.1, while WP2 needs them. `GatewayErrorKind` (5.2) and `FailureKind` (4.0.7) each defined the other. `DropReason`, `EvidenceType`, `VerdictStatus` and `CorrectionDropReason` had no named home | Resolved by rule B (5.1): WP2 declares them. `LLM/call-record.ts`: `LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode`, and `GatewayErrorKind` as a literal union of the 15 kinds of 7.6. `V/meeting-types.ts`: `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason`, `LlmMessage`, `LlmParamsLedger`. WP3, WP5a and WP5b import them and declare none. `FailureKind` (4.0.7) extends `GatewayErrorKind`. Check B above enforces it. |

### 11.5 Work package cards

Every card passes GT1 to GT4 and its new test files (`pnpm --filter @openstyle/server test tests/<files>` prints `Test Files  N passed (N)`), and runs B14 after any oMLX call. Design, edit sites and test lists live in the spec sections named on each card; edited files are in 11.4. `$S` = `/tmp/<task-name>` (`SK/live-testing/SKILL.md:92`; the scratch folder rule is `SK/live-testing/SKILL.md:17`); `$BASE` = `http://127.0.0.1:$PORT`; isolated server per `SK/live-testing/SKILL.md:87-102`. Agents: standard set (11.6).

**WP1. AI SDK v7** (spec 6, files 6.4; D7). Same request bodies and results for dictation, Remix, meetings. New: `apps/server/tests/ai-sdk-wire.test.ts` + snapshots. `check-bundled-requires.mjs` also scans `out/main/chunks` and fails on `commonjsRequire(` (it reads top-level files only today, `:34`). Must not: anything in 6.10 (M3); `vitest -u` in CP3 (M7).
Accept: (1) `git grep -l -E "from \"(ai|@ai-sdk/[a-z-]+)\"|import\(\"(ai|@ai-sdk/[a-z-]+)\"\)|vi\.mock\(\"(ai|@ai-sdk[^\"]*)\"" -- apps packages scripts` = 18 paths, all in 6.4. (2) `grep -E '^  ai@[0-9]' pnpm-lock.yaml` = `ai@7.0.N:` and `ai@7.0.N(zod@4.4.3):`, same N (143 on 2026-10-17); `grep -E '^  ai@6' pnpm-lock.yaml` empty (today four lines: `pnpm-lock.yaml:2884,2890` in `packages:` and `:7348,7356` in `snapshots:`). (3) Wire test passes on v6 (CP1) and v7 (CP3); `git diff --stat <CP1>..<CP3> -- apps/server/tests/__snapshots__` empty. (4) GT5; `grep -o 'AI_NoObjectGeneratedError' apps/electron/out/main/server-process.js | wc -l` = 1; `grep -rc 'commonjsRequire(' apps/electron/out/main` = 0 per file; a planted `require(variable)` fails the guard (BC3, 10.14). (5) Real app, baseline vs branch (proofs A, B, 6.9.3): `/api/post-process` output `diff <(jq -S . baseline.json) <(jq -S . package.json)` empty, `inputTokens` 40, `outputTokens` 9; Remix transform and agent equal; TCC `AUTHREQ_PROMPTING` 0 (`SK/live-testing/SKILL.md:219`). (6) Negative control (6.9.4): `ai` 6.0.191 in `packages/stt/package.json` alone must break proof A (UNVERIFIED until run); if A still passes, WP1 does not merge. Record bundle and asar sizes (Q6). Proof P1 (1-4), P3 (5-6).

**WP2. Persistence** (spec 7, 8.3, 8.4; D10). Migration 40 adds the six tables of 7.4. No migration 40 exists at `c47cd80d`: `SCHEMA_VERSION` is 39 (`S/lib/schema.ts:14`) and becomes 40. The migration 39 block ends at `S/lib/schema.ts:1007` and the version upsert starts at `:1009`; the new block goes between them. Fix the tests pinning 39 (`apps/server/tests/schema-meetings.test.ts:7`, `migration-servers.test.ts:91`). WP2 adds `sweepInterrupted()` to the recorder (7.12). No such function exists at `c47cd80d`; it is a plan of this spec. `S/index.ts` calls it next to the start-up calls `startHistoryRetentionSweep()` and `startMeetingRetentionSweep()` (`S/index.ts:215-216`). It is a different sweep from the existing `sweepOrphans` (`E/main/meeting-recorder.ts:803`), which marks the `meetings` rows of killed jobs. WP5b replaces the new call (3.4.7). New: `call-record.ts` (the base types and the call types of 5.1, rule B), `llm-record.ts`, `llm-record-read.ts`, `input-hash.ts`, `S/routes/meetings-runs.ts`, two tests. Edits `V/meeting-types.ts`: the types of 8.4 and the shared types `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason`, `LlmMessage`, `LlmParamsLedger`. WP2 declares every base type, so its branch compiles with no WP3 file. WP3, WP5a and WP5b import these types and declare none. A run on a `.backup` copy of a real database first sets `audio_dir` to NULL there (10.9 check 1). Must not: plain FKs to segments, speakers or summaries. Re-transcribe deletes the segments (`S/routes/meetings.ts:1546`), the speakers (`:1552`) and the diarizer turns (`:1556-1558`). It does not delete summaries; the Summarize job replaces the summary row with `INSERT OR REPLACE` (`S/routes/meetings.ts:1213-1225`).
Accept: (1) Seed a fictional meeting with the `main` build on `$S/db.sqlite`: `select version from schema_version` = 39, then 40 on the branch build; `select count(*) from sqlite_master where type='table' and name like 'llm_%'` = 6; meeting count unchanged; `PRAGMA foreign_key_check` empty. (2) `curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/meetings/<id>/llm-runs | jq -e '.runs | length == 0'` true; `llm-calls` with `.calls` likewise; unknown id 404. (3) `DELETE $BASE/api/meetings/<id>` for one of two seeded meetings (`audio_dir` under `/tmp/`, `SK/meeting-benchmarks/SKILL.md:17`) leaves only the other's rows in all six tables. (4) `main` build on the v40 file: `GET $BASE/api/meetings` prints 200. This is a manual check; no source line shows the result. The `main` build returns early when the stored version is 39 or more, so it runs no migration on a v40 file (`S/lib/schema.ts:168`). (5) `running` run and step become `interrupted` after restart (7.12). (6) The recorder and input-hash tests of 10.9 checks 5 and 6 pass: `seq`, `attempt`, `finishedCall`, link keys, and equal hashes in `prepare` and the reader. (7) Check B of 11.4 prints 13 lines, and GT3 passes on the WP2 branch alone, which proves that no base type waits for WP3. Proof P1 on a real server and file; 10.9 adds a `.backup` run, counts only.

**WP3. Gateway, profiles, typed errors** (spec 5). `callStructured` checks finish reasons (D4), reasoning params (D3, L2), served model (L4) and params sent; never loops (5.0). `V/llm-task-profiles.ts` gets `LLM_MEETING_DENYLIST_KEYS` per 5.5.3 (the old set at `packages/validations/src/llm-task-profiles.ts:199-206` stays). New: `gateway.ts` (also `probeEndpoint`, 5.7), `gateway-errors.ts`, `model-profiles.ts` (also `reasoningSteps` and the `reasoningSteps` argument of `resolveCallProfile`, 5.5 rule 4), `W/schemas.ts` (the three node schemas, 4.2.1, 4.3.1, 4.5.1), `tests/helpers/fake-model.ts`, `tests/helpers/meeting-fixture.ts` (the one fixture builder, 10.2 rule 1), two tests (they hold W2b and W14, 10.5; WP3 edits no existing test file). The gateway passes the zod schema to the SDK unchanged (4.0.3 rule 7); the models.dev read is best effort (5.1). Named edits: `THINK_TAG` export in `packages/stt/src/text.ts` and `index.ts`; `pin`, `droppedKeys`, `source` and the scoped denylist in `S/lib/llm/task-profiles.ts`; `LlmTaskContext` callback and `gatewayOverrides` in `registry.ts`; `signal` in the `Pick` of `lane.ts`. Imports the base types of 5.1 (rule B) from WP2 and declares none of them again. Adds the `createModel` seam of `CallStructuredInput` (5.1) and the bounded-plan rule of `gatewayOverrides` (5.5.2). Must not: touch `postProcess`, the old path, dictation, Remix; add a retry loop (the one retry is `callUnit` of WP5a, 5.6) or a dependency (5.4 Option A).
Accept: live checks 2, 3 and 9 of 5.9 on the owner's oMLX, fictional chunk, script in `$S`. Check 2: `maxOutputTokens: 16` gives `LengthError`, `rawFinishReason` `length`, ledger `max_tokens`. Check 3: reasoning off gives `stop`, served model `Qwen3.8-27B`, ledger with `chat_template_kwargs.enable_thinking` false and `response_format`, equal to the body a local listener captured (`OPENSTYLE_LOG_DIR` unset, `SK/meeting-benchmarks/SKILL.md:19`). Check 9: `sqlite3` read-back shows every D10 field. Mock-only (the PR says so): `content-filter`, `tool-calls`, `reasoning_leak`; cloud providers wait for Q5, but W12 (10.5.2) checks every provider body. The checks send the real `CorrectChunkSchema`. W14 passes: the models.dev fetch rejects, a `server` profile still resolves and no case gives `model_unavailable` (5.1, 10.5.3). W15 passes: `probeEndpoint` for a `server` and for each cloud provider over a stubbed `fetch` (10.5.2). Check B of 11.4 prints 13 lines. Probes LP1, LP4, LP6 (10.12) run and their results are in the PR. Proof P1 P2.

**WP4. `node:sqlite` checkpoint saver** (spec 3.1, 7.9; D6). `NodeSqliteSaver` passes `@langchain/langgraph-checkpoint-validation`, no native module. Adds `@langchain/langgraph` 1.5.1, `@langchain/core` 1.2.18 (a peer of all three; the resume test needs `StateGraph`), `@langchain/langgraph-checkpoint` 1.2.0 and dev `@langchain/langgraph-checkpoint-validation` 1.2.0, exact (R11). Each version is on npm: [`@langchain/langgraph` 1.5.1](https://registry.npmjs.org/@langchain/langgraph/1.5.1), [`@langchain/core` 1.2.18](https://registry.npmjs.org/@langchain/core/1.2.18), [`@langchain/langgraph-checkpoint` 1.2.0](https://registry.npmjs.org/@langchain/langgraph-checkpoint/1.2.0), [`@langchain/langgraph-checkpoint-validation` 1.2.0](https://registry.npmjs.org/@langchain/langgraph-checkpoint-validation/1.2.0). The `@langchain/core` peer ranges are `^1.1.48` (langgraph), `^1.1.48` (checkpoint) and `^1.1.44` (validation); 1.2.18 meets all three. The `latest` tag of all four pages equals these versions on 2026-10-17. New: `W/checkpoint-saver.ts`, `checkpoint-saver.test.ts`, `checkpoint-saver.conformance.test.ts`. The README shows import `@langchain/langgraph-validation`; read the real export first ([README](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-validation/README.md)).
Accept: every conformance group passes; `grep -c 'better-sqlite3' pnpm-lock.yaml` = 0; graph A, B, C on a file, B throws after A is checkpointed, reopen handle and saver, resume with the same `thread_id` (the [docs](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) require a `thread_id` in `configurable`) and run both invokes with `durability: "sync"` (a choice of this spec, 3.4.2; the same docs say `"sync"` saves before the next step starts and `"async"` can miss a checkpoint in a crash; they do not say `"sync"` is needed to resume): counters A 1, B 2, C 1. No GT5, no prover. Proof P1; the `SIGKILL` proof is in WP5b and WP9 (G6).

**WP5a. Graph, six node slots, nodes except the `summarize` body** (spec 3.1 to 3.3, 4). `W/nodes/verify-evidence.ts` holds new functions per 4.4.1 to 4.4.4. The old guard functions of `enhance.ts` (`:263,273,293,328`) stay private until WP11. Adds no dependency (WP4 did, so WP4 is a hard dependency, 11.2). New: `W/{graph,state,types,context,unit,load-graph}.ts` (`types.ts` also holds `WORKFLOW_GRAPH_VERSION` = 1, 3.4.7, `foldStatus`, 4.0.7, `deriveRunStatus`, 3.4.3, and `SaveResult`, 4.6; `context.ts` also holds `WorkflowDeps` and `productionDeps`, 3.4.2), `W/prompts.ts` with the `correctChunk` and `identifySpeakers` builders (4.2.2, 4.3.3; WP5a does not change `enhance-prompt.ts` or the old path), `W/nodes/{prepare,correct-chunk,identify-speakers,verify-evidence,summarize,save}.ts` (`summarize.ts` is a stub that returns `skipped`; WP6 replaces its body), `transcript-io.ts` (moved from `S/routes/meetings.ts`, no behavior change), seven test files in `apps/server/tests/`: `workflow-graph.test.ts`, `workflow-requests.test.ts`, `workflow-prepare.test.ts`, `workflow-correct.test.ts`, `workflow-identify.test.ts`, `workflow-verify.test.ts`, `workflow-save.test.ts` (with the #163 replay, [issue](https://github.com/Maheidem/openstyle/issues/163), the request counts of G5; the owner table of 10.8 gives the content of each file: the WP5a rows, the "Req" rows of 10.5.1 and the 10.6 rows except `summarize`). The nodes import `chunkForEnhance` and `estimateTokens` from the old files and edit neither (3.1). They import the base types of 5.1 (rule B) from WP2 and declare none. Only `W` imports LangGraph. `W/load-graph.ts` deletes `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING`, `LANGCHAIN_TRACING` from `process.env`, then loads `W/graph.ts` by dynamic `import()` (3.1 rule 2; [source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/utils/callbacks.ts)). Must not: change the old path, write `confirmed_at` or `display_name` (4.6.1).
Accept: old tests `meeting-enhance`, `meeting-speaker-names` stay green; `git grep -l -E "@langchain/(langgraph|core)" -- apps/server/src` shows only `S/lib/meetings/workflow/` paths; live script (`productionDeps()` on the isolated scratch database, so the real saver runs; 6 chunks and 3 speakers as in 10.12 step 2; fictional names, seed step `SK/live-testing/SKILL.md:215`; Qwen3.8-27B, an allowed model, `SK/live-testing/SKILL.md:229`): `select count(*) from meeting_segments where enhanced_text is not null` > 0, `llm_calls` has one `correctChunk` per chunk and one `identifySpeakers`, a listener sees `response_format.type` `json_schema` and `chat_template_kwargs`; GT5 names the LangGraph chunk (UNVERIFIED until built, 9.8 rule 2), `commonjsRequire(` 0, growth within Q6; every WP5a row of the owner table in 10.8 passes, including GR18, GR19, GR20 (a), GR21 (a) and GR23 (X7). The seven files above exist and each passes alone: `pnpm --filter @openstyle/server test tests/<file>` prints `Test Files  1 passed (1)`. Check B of 11.4 prints 13 lines. U6 (3.7), next to GR3: the installed `@langchain/core` 1.2.18 names the same four tracing variables as 3.1. `grep -rn -E 'LANGSMITH_TRACING|LANGCHAIN_TRACING' $(find node_modules/.pnpm -path '*@langchain/core/dist/utils/callbacks.js' | head -1)` prints the four names, and the PR pastes the lines. The file name in 1.2.18 is UNVERIFIED (on `main` the source is `libs/langchain-core/src/utils/callbacks.ts`). If the installed list differs, `W/load-graph.ts` and GR3 follow the installed list. Probes LP2, LP3 and LP7 (10.12) run, and their results are in the PR. Proof P1 P2.

**WP5b. Runner, resume route, boot sweep, flag** (spec 3.4, 3.5). Edit sites per 3.4 and 3.5. New: `W/runner.ts` (`startRun`, `resumeRun`, `sweepOrphanRuns`, `resumeInterruptedRuns`), `workflow-runner.test.ts`, `workflow-resume.test.ts` (the tests of the WP5b rows in the owner table of 10.8). Edits `llm-record.ts` (resume methods, 7.7), `S/routes/meetings-runs.ts` (the resume route, 3.4.2) and `V/meeting-types.ts` (`StartRunResponse`, `ResumeConflict`, `ResumeConflictReason`, 3.4.2). Flag: key `meeting_enhance_workflow` (`"true"`/`"false"`) in `V/settings-keys.ts` and `S/lib/setting-validators.ts`, reusing `checkEnhanceFlag` (`:212-216`); a setting needs three places (`packages/validations/src/settings-keys.ts:53-57`); default = Q1. One function decides the flag: `parseMeetingEnhanceWorkflow(raw: string | undefined): boolean` in `V/settings.ts`. Until WP5c it returns true only for `"true"`, so a missing key is off. Its test is `packages/validations/src/meeting-enhance-workflow.test.ts`. The server reader `getMeetingEnhanceWorkflowSetting()` in `W/runner.ts` reads the `settings` row and calls the parser, as `getMeetingEnhanceAutoRunSetting` does for the auto-run key (`S/lib/meetings/enhance.ts:51-58`). The start routes and the auto-run handoff call the server reader. The Settings row of WP7 calls the parser, so the default sits in one place and WP5c (11.5) changes only that place. Contract (3.4.2, HTTP contract table and status mapping): flag on, `POST /:id/enhance` = 202 `{ ok, id, runId }`; off = 200 or 502 as today until WP11. The 200 response is `S/routes/meetings.ts:2185-2195`. The 502 response is `S/routes/meetings.ts:2161-2174`; it is sent when every chunk failed (condition `:2150-2154`). Must not: change meeting status in a run (`:1073-1076`); start a run before the first request or the boot resume (3.1 rule 3).
Accept (plus `tests/meetings-routes.test.ts`): (1) `PUT $BASE/api/settings/meeting_enhance_workflow` `{"value":"true"}`; on a 6-chunk fictional meeting `POST $BASE/api/meetings/<id>/enhance` = 202 with `runId`; poll `GET /api/meetings/<id>` until `job` is null; `GET $BASE/api/meetings/<id>/llm-runs?latest=1` shows the enhance run with status `succeeded`; one `llm_calls` row per chunk. (2) With `"false"`: 200 with today's 9 keys; no new `llm_runs` or `llm_calls` rows. (3) Kill and resume (G6, U2): `kill -9 $(cat "$S/server.pid")` after the first chunks save; restart on the same DB; run `interrupted`, then `running`, then success; `select step_key, count(*) from llm_calls where run_id='<runId>' and node='correctChunk' and error_kind is null group by step_key having count(*) > 1` returns no rows. U2 stays open until this runs. Repeat with the kill during `identifySpeakers`: no finished call is sent again (5.6). (4) `POST $BASE/api/meetings/<id>/cancel-transcribe` ends the run `cancelled`; finished chunks keep `enhanced_text`. (5) Every WP5b row of the owner table in 10.8 passes, including GR17: 0 checkpoint rows for a `succeeded`, `partial`, `failed` and `cancelled` run, and more than 0 for an `interrupted` run. (6) The soft cancel of (4) on the live model, with a timer: probe LP5 settles U4 (3.7). On the owner's oMLX, with fictional text and Qwen3.8-27B only: time a one-token request on the idle model (T0), start an Enhance run with a long answer, cancel it with `POST $BASE/api/meetings/<id>/cancel-transcribe`, and time the same request at once after the cancel (R). The PR gives T0, R and the oMLX log lines (10.12 LP5), and B14 prints `200` after. (7) `pnpm --filter @openstyle/validations test` passes the flag cases: a missing value and `"false"` are off, `"true"` is on. GT5. Proof P1 P2.

**WP6. `summarize` node and route switch** (spec 4.5, 3.6). Single call, or map then reduce, with fixed `MeetingSummarySchema`; today's limits and results. With the flag on the Summarize route calls `startRun` with `stages = ["summarize"]` (`S/routes/meetings.ts:2068`; `runSummarizeJob` `:1159` stays for flag off). Edits `W/nodes/summarize.ts` (a stub from WP5a; the graph, state and types are WP5a's). New: `workflow-summarize.test.ts` (the tests of the WP6 rows in the owner table of 10.8, with the 10.6 row `summarize`). The node fills `llmProvider`, `llmModel` and `costUsd` by the rules of 4.5, because WP11 deletes the old price reader (`S/lib/meetings/llm-call.ts:165-167`). WP6 writes the new single, map and reduce prompts for the schema of 4.5.1 in `W/prompts.ts` (4.5.2). It does not import the old prompt builders: they tell the model "Return only the markdown summary" (`summary-prompt.ts:91, 108`), which conflicts with the schema. From the old summarize code it keeps only `chunkTranscript` (`S/lib/meetings/summarize.ts:323`) and `estimateTokens`, after a small mapper gives `chunkTranscript` the fields it reads from each `PreparedSegment` (`text`, `enhancedText`, `speaker`, `speakerName`, `speakerLabel`). The old prompt files stay unchanged until WP11. It adds `plannedSummaryCalls` (4.5.3) for the 24-call limit and the job deadline. It reads `prepared.summary` (4.1), not the settings. The Summarize button starts stage `summarize`; no trigger starts both (3.6; Q2).
Accept (plus `tests/meeting-summarize.test.ts`): flag on, short fictional meeting: `POST $BASE/api/meetings/<id>/summarize` = 202; poll `GET $BASE/api/meetings/<id>` until `job` is null, then check that `status` = `summarized` and `summary.markdown` is not empty. The renderer polls while `status` is `transcribing` or `job.kind` is `summarize` or `enhance` (`E/renderer/src/pages/meetings/detail.tsx:122-127`). No source line combines the two checks; the combined check is an acceptance rule of this spec. The type allows a null `markdown` (`V/meeting-types.ts:59-65`), and the Summary tab shows text only when `markdown` is set (`E/renderer/src/pages/meetings/detail.tsx:895`). Read the row back: `select cost_usd, llm_provider, llm_model from meeting_summaries where meeting_id='<id>'`. On the owner's oMLX the `server` model has no price, so `cost_usd` is NULL and `llm_provider` is `server`; `llm_model` equals `served_model` of the last row in `llm_calls` for the run, or `requested_model` when that is NULL (4.5 rules 2 to 4). A priced model gives a `cost_usd` that is not NULL: cases (a) to (e) of 10.6 pass in `workflow-summarize.test.ts` with a stubbed models.dev answer. A live cloud run waits for Q5 and stays UNVERIFIED. With `meeting_summary_context_budget` = `2000` (min 100, `packages/validations/src/settings.ts:257-266`) and a fictional meeting of about 6000 tokens: N map calls (N = the chunks of `chunkTranscript`), then at least 1 reduce call, at most 24 calls in all and at most `plannedSummaryCalls(...)`. A budget of 300 cannot hold two partials, so the plan fails with `budget_exceeded` (4.5.3). Kill during the map calls: no finished map call is sent again (GR10 (c), GR20 (b), 10.11.3). Two reduce levels use two keys (`reduce:1:0`, `reduce:2:0`), and every WP6 row of the owner table in 10.8 passes, including LR9 to LR11 and GR22. A 5-second ceiling ends `deadline_exceeded`, and the notice names it. Proof P1 P2.

**WP7. Inspector UI, persisted failure notice, Resume button, flag toggle row** (spec 8; hard dep WP5b for the resume route). Hidden unless `advanced_mode` is `"true"`; the server has no gate (I1, 8.2). **Flag toggle (rollout stage S3, 12.3; Q14).** The key `meeting_enhance_workflow` has no screen, and agents may not write the real profile. So WP7 adds a row in Settings > Application, directly under the Advanced mode row (`E/renderer/src/pages/settings.tsx:886-894`; the page has no separate Advanced section). The row shows only while `advanced_mode` is `"true"`. It reads the flag with `parseMeetingEnhanceWorkflow` (WP5b), writes `"true"` or `"false"` with `putSetting` and has the test id `settings-enhance-workflow`. Its keys are `settings.application.enhanceWorkflow` and `settings.application.enhanceWorkflowDesc` in `en.json` and `template.json` (8.10). WP11 removes the row. New: `llm-inspector.tsx`, `llm-call-view.tsx`, one `.ts` helper with test (renderer tests run in node env, `apps/electron/vitest.config.ts:16-21`). Until WP11 `enhance()` handles 202 and 200/502; the old local failure state (`E/renderer/src/pages/meetings/detail.tsx:87-89`) stays for flag off; the notices, lines, Resume and Start again buttons and the success note follow 8.9.
Accept (plus `pnpm --filter @openstyle/electron test`): (1) Throwaway `apps/electron/tests/zz-proof-llm-inspector.test.ts` on seeded rows, recipe `SK/live-testing/SKILL.md:206-221` (set `meeting_enhance_prompt_seen` first, `:214`); screenshots at 1152x648, 900x600 and 720x480 per 8.12 item 1; TCC count 0. (2) Row counts of the six tables are 0 after deleting the meeting by API (8.12 item 2). (3) A seeded `failed` run shows its lines after reload; a seeded `interrupted` run shows Resume, and a click calls the resume route. (4) The flag toggle (8.10): with `advanced_mode` `"false"` the Settings > Application page has no element with the test id `settings-enhance-workflow`; with `"true"` the row shows (screenshot). A click on the switch sets `meeting_enhance_workflow` to `"true"`, and a second click sets `"false"`. Read each value back with `GET $BASE/api/settings`, not from the screen alone. (5) Delete the throwaway spec; `git status --short` shows only card files. Proof P3 via the test runner (B13); the prover views every screenshot (`SK/live-testing/SKILL.md:179`).

**WP8. Tracing, opt-in** (spec 9; D8, G10). Variables unset = no tracer, no connection; set = one MLflow trace per run, one span per node call. `@ai-sdk/otel` pins `ai` 7.0.143 ([npm](https://registry.npmjs.org/@ai-sdk/otel/latest)). Edit sites per 9.10: `W/unit.ts` (`guardNode` calls `inNode` around each node body, inside its `try`), `W/runner.ts` (`startRunSpan` before `graph.invoke`, `endRunSpan` after the final status, `resumeRun` too) and the files listed there; no node file. `AGENTS.md:9`: add that export is off unless both variables are set (9.5.1 item 5). New: `S/lib/llm/tracing.ts`, `tracing.test.ts`. Variables `OPENSTYLE_MLFLOW_TRACKING_URI` and `OPENSTYLE_MLFLOW_EXPERIMENT_ID`, no setting key (T1); a tracing failure never changes a run (T7); Enhance runs and Summarize runs export, dictation cleanup and Remix never (T8, Q9.6); OTLP needs MLflow 3.6.0+ ([MLflow](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest/)); fictional text only.
Accept: (1) Live checks C1 to C10 of 9.9 on the owner's MLflow (3.16.1 on 2026-10-17), oMLX Qwen3.8-27B only; app spans and AI SDK spans both land. The coordinator reads back with `MlflowClient(...).search_traces(locations=[<experiment id>])`: state `OK` for the normal run, ERROR for typed-error runs; a trace counts only once read back. (2) Same commit with and without tracing (9.8 rule 3): record `out/main/server-process.js`, each `out/main/chunks` file, `app.asar`; asar grows at most 1 MiB (Q9.4 default) or stop and ask. GT5. Proof P1 P5.

**WP9. Committed E2E specs and whole-feature live proofs** (spec 10, 10.11). New: `apps/electron/tests/meeting-enhance-workflow.test.ts`, `meeting-llm-inspector.test.ts` (fake own server as `meeting-cancel-transcribe.test.ts:103-146`; `launchOpenstyle`, `helpers/e2e-app.ts:36`; flag `"true"` via API). Floor: happy path (`response_format.type` `json_schema`, `chat_template_kwargs`, all steps done); fake `length` answer (notice live and after reload); `SIGKILL` of the utility process in `correctChunk` (as `server-host-restart.test.ts:54-84`; no second request for a finished chunk, G6); inspector gate. Edit `SK/live-testing/SKILL.md`: add a rule (10.12 step 1): set `OPENSTYLE_LOG_DIR` only for fictional text (today: leave unset, `SKILL.md:102`; a plan of this spec).
Accept: (1) CI `pnpm --filter @openstyle/electron run test:e2e` passes inside the 5-minute limit (`build.yml:203-204`); above 4 minutes, tell the owner (R13). (2) Local: build per `SK/live-testing/SKILL.md:211`, then `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false scripts/test-runner/run.sh "$PWD/apps/electron" -- timeout 600 pnpm exec playwright test tests/meeting-enhance-workflow.test.ts tests/meeting-llm-inspector.test.ts`: all pass, TCC count 0. (3) Live on the owner's oMLX, fictional meeting (recipe `SK/live-testing/SKILL.md:206-221`): Enhance (flag on), Summarize, inspector in advanced mode; three screenshots; the panel equals the `llm.request` body in the trace log (8.12 item 3); kill the utility process during Enhance: the run completes, no second call for a finished chunk. (4) Distinct schemas in the records = number of structured steps (R8); record text size after a long run (about 0.6 MiB per 40 chunks, 7.11; R14). (5) `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openstyle/electron build:unpack`, `find apps/electron/dist -name app.asar -exec ls -l {} +`, compare with `main` (target about 9 MiB, `AGENTS.md:87`), run one Enhance in the packaged app (BC8, 10.14); local viability of `build:unpack` UNVERIFIED. Proof P1 P2 P3.

**WP10a. Benchmark harness and old-path baseline** (spec 10, 12). Edits: `knip.jsonc` (`ignoreFiles` `:34-45`; knip treatment of `compare-speakers.mts` UNVERIFIED), `SK/meeting-benchmarks/SKILL.md`. New `scripts/meeting-v2/run-enhance.mjs`: copies the transcribed scratch meeting; sets the flag only with `--workflow true|false` (baseline omits it); `POST /api/meetings/<id>/enhance`, polls `GET /api/meetings/<id>` until the job ends; writes `metrics-enhance.json` (numbers only: `seconds`, `chunksAttempted`, `chunksSucceeded`, `chunksFailed`, `correctedCount`, `speakerSuggestions`, `namesRespelled`, failure reasons) and a `dump-speakers.mjs` dump; prints no text. `--summarize` posts `/summarize` and adds `summarySections`, `summaryChars`, `summaryActionItems`. New `scripts/meeting-v2/check-enhance-metrics.mjs` (`--dumps <d1> <d2> <d3>`) prints `hallucinatedKept` (a kept quote that is no substring of a segment text in the dump), `untypedFailures` and `namedRuns` for each label. It re-reads its output and exits 1 on a mismatch. `metrics-enhance.json` also holds `contextHash`, the hash of the meeting context. Privacy per `SK/meeting-benchmarks/SKILL.md:14-19`; 3 runs per arm (oMLX with MTP is not deterministic at temperature 0, `/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:145`, [omlx#4089](https://github.com/jundot/omlx/issues/4089)); meetings: the short and long proof meetings (`SK/meeting-benchmarks/SKILL.md:24-25`) plus the #163 meeting (that skill file does not name it; its id is open, 10.15 and Q7 in 12.2: UNVERIFIED); transcribe once, `.backup`, start each run from it; `text` of both arms hashes equal before any compare (10.15 step 3).
Accept: (1) `jq -e 'has("seconds") and has("chunksAttempted") and has("chunksSucceeded") and has("chunksFailed") and has("correctedCount") and has("speakerSuggestions") and has("contextHash")' $S/enhance/*/metrics-enhance.json` exit 0 per file. (1b) `node scripts/meeting-v2/check-enhance-metrics.mjs --dumps <d1> <d2> <d3> --out $S/m.json` exits 0, and `jq -e 'has("hallucinatedKept") and has("untypedFailures") and has("namedRuns")' $S/m.json` exits 0. The baseline shows whether the old path fails a chunk in each run (G3). (2) `pnpm meeting:compare-speakers --x <run1 dump> --y <run2 dump> --x-name run1 --y-name run2 --out $S/self.md` exit 0. The usage line with the command and its arguments is `scripts/meeting-v2/compare-speakers.mts:15-17`; the script name is `package.json:10`; the self-check is `scripts/meeting-v2/compare-speakers.mts:9-13`. (3) A Haiku reader lists every `console.log` and `writeFileSync` in `run-enhance.mjs`; each writes only counts, durations, hashes, ids or paths. (4) GT1, GT2 only. (5) Baseline numbers exist in `$S/enhance/`; the PR names runs and numbers, no text. Proof P4.

**WP10b. After-run, compare files, council** (spec 10, 12; D12). Edits: `specs/meeting-enhance-agentic.md` (council record; the skill names `specs/meeting-transcription-v2.md`, `SK/council/SKILL.md:34`); `SK/council/SKILL.md` names `compare.mts` (`:14`), which reads the `dump-chunks.mjs` format without `enhanced_text` (`dump-chunks.mjs:2-4,19`), so add the speakers compare tool for Enhance arms. Also edits `scripts/meeting-v2/run-enhance.mjs` (its `--workflow true` branch runs first here, so a round can fix it) and `SK/pi-briefs/SKILL.md`; it corrects both skills about the pi pin (10.15 step 6).
Procedure: (1) `run-enhance.mjs --workflow true`, 3 runs per meeting, #163 meeting 6 runs (G3), tracing variables unset (B12). (2) `pnpm meeting:compare-speakers`. (3) Run `pi_list_agents` with `doctor`. The owner approves each data set for Codex first (`SK/council/SKILL.md:27`), and for pi too when its pin is a cloud provider (10.15 step 6). The owner decides the tracing waiver for the round (10.15 step 7). (4) `bash scripts/council.sh prepare <round> <compare-file>...`; judges write `/tmp/meeting-v2/council/<round>/judge-<who>.md`, line 1 `VERDICT: <SHIP|FIX-FIRST|REVERT> BETTER=<n> WORSE=<n> SAME=<n>`; Claude writes first (`SK/council/SKILL.md:20-25`). (5) `bash scripts/council.sh collect <round>`.
Accept: (1) The PR shows per arm failed chunks, speaker suggestions kept, seconds; tokens for the new arm only (the old path stores none, `S/lib/meetings/enhance.ts:630-635,658-672,684-693`); no metric worse without a written reason; #163 meeting: 6 of 6 runs with 0 failed chunks. (2) `collect` prints `CONSENSUS: yes`, exit 0 (`SK/council/SKILL.md:32`). (3) The spec record lists round, compare files, verdict lines, decision. Judges: Claude (coordinator), pi (brief via `pi-briefs`, `SK/council/SKILL.md:26`), Codex; Sonnet and Haiku only run scripts. Proof P4.

**WP5c. Default flip** (spec 12.3 stage S5, 3.4.2; Q1 A; hard dep WP10b). Branch `chore/enhance-default-flip`. One small PR: a missing key `meeting_enhance_workflow` means the new path. Owned files: `packages/validations/src/settings.ts` (`parseMeetingEnhanceWorkflow`: only `"false"` is off), `packages/validations/src/meeting-enhance-workflow.test.ts`, `apps/server/tests/workflow-runner.test.ts` (the missing-key cases only) and `apps/server/tests/meetings-routes.test.ts` (set the flag to `"false"` in the cases that need the old path). No other file changes. The server reader and the Settings row (WP7) call the parser, so the new default reaches them with no edit. The coordinator cuts the branch only after WP10b has merged (B5), and merges it only after the owner agrees to release B. Must not: change a node, a prompt, a schema or any file outside the list; remove the flag (WP11 does that).
Done when (the S5 entry gates of 12.3): (a) `bash scripts/council.sh collect <round>` printed `CONSENSUS: yes`, exit 0, and WP10b recorded the round in this spec (D12). (b) Summary gate: the count check of `run-enhance.mjs --summarize` ran, and the owner read the summaries side by side for each data set (10.15, Q11). The owner's answer is in the PR. (c) Cloud gate: W12 passes, and the live runs of Q5 pass or the owner accepted them in writing as UNVERIFIED. (d) The owner approved release B in chat (`AskUserQuestion`).
Accept (isolated server and scratch database as in `SK/live-testing/SKILL.md:87-102`; a 6-chunk fictional meeting): (1) No row: `sqlite3 -readonly "$S/db.sqlite" "select count(*) from settings where key='meeting_enhance_workflow'"` prints `0`. `curl -s -o "$S/out.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" $BASE/api/meetings/<id>/enhance` prints `202`, and `jq -e '.runId | type == "string"' "$S/out.json"` prints `true`. Poll `GET $BASE/api/meetings/<id>` until `job` is null; then `select status from llm_runs where meeting_id='<id>'` prints `succeeded`. (2) `PUT $BASE/api/settings/meeting_enhance_workflow` with `{"value":"false"}`, then the same POST: it prints `200` (or `502` when every chunk fails), the body has today's keys (WP5b acceptance 2), and `select count(*) from llm_runs where meeting_id='<id>'` does not grow. (3) With `{"value":"true"}` the same POST prints `202`. (4) `pnpm --filter @openstyle/validations test` passes: `undefined` is on, `"false"` is off, `"true"` is on, and `"yes"` is on, because only `"false"` is off (the validator `checkEnhanceFlag`, `S/lib/setting-validators.ts:88`, never stores `"yes"`). (5) Settings > Application with `advanced_mode` `"true"` and no row for the flag: the toggle shows on (screenshot through the test runner, TCC count 0; the prover views it). (6) GT1 to GT4 pass, and the H1 check lists no file outside the owned list. Proof P1 P3.

**WP11. Remove old path and flag** (spec 12; deps WP5c, Q1 answer, one release with default on). O8-2 answered: `job_error` for Summarize goes away here (the run record holds the failure, 8.9; the flag-off path sets it, `S/routes/meetings.ts:1240`). Delete `enhance.ts`, `enhance-prompt.ts`, `summarize.ts`, `summary-prompt.ts` after moving the three helpers that `W/` imports from the old files, `chunkForEnhance`, `chunkTranscript` and `estimateTokens`, into one new file `W/chunking.ts` (the nodes change only their import lines; the new prompts are already in `W/prompts.ts` and `plannedSummaryCalls` replaces `plannedSummarizeCalls`, so nothing else moves); delete `llm-call.ts` (only `enhance.ts:38` and `summarize.ts:33` import it); remove `runEnhanceJob`, `runSummarizeJob`, the 200/502 handling, the flag (the keys, `parseMeetingEnhanceWorkflow` with its test, the server reader, the line that sets the flag in the two E2E specs of WP9, and the Settings row of WP7 with its two locale keys), the renderer local failure state, 502 branch and old notice (8.9); update the `AGENTS.md` pipeline paragraph.
Accept: (1) `git grep -n -E "defaultChatCallFor|extractJsonObject|enhanceMeetingTranscript|runEnhanceJob|runSummarizeJob|parseMeetingEnhanceWorkflow|meeting_enhance_workflow|meetingEnhanceWorkflow|enhanceWorkflow" -- apps packages` prints nothing. (2) The PR lists each deleted `it(` name with its successor test or a written reason. It covers all six test files that import the deleted files: `meeting-enhance.test.ts`, `meeting-summarize.test.ts`, `meeting-llm-timeouts.test.ts`, `llm-task-profiles.test.ts` (the test at `:125` moves to the successor constant `SUMMARY_ANSWER_TOKENS`), `meetings-calendar.test.ts` (`:8` imports `EnhanceMeetingOptions`) and `meetings-routes.test.ts` (`:29, :3122`). `git grep -n -E "meetings/(enhance|enhance-prompt|summarize|summary-prompt|llm-call)\.js" -- apps packages scripts` prints nothing. The H1 list of WP11 holds these files (11.4). (3) GT1 to GT6; knip finds no unused file. (4) The WP10a harness on the same meeting stays inside the recorded run-to-run range. (5) One live Enhance and one live Summarize on a fictional meeting pass (P2); WP9 specs pass. (6) `enhanceFailedTimeout`, `enhanceFailedParse`, `enhanceFailedProvider` and their group entries are gone from all 8 locale files (8.10). (7) The summary cost still has a reader after `llm-call.ts` is gone: `git grep -n getModelCostCached -- apps/server/src` lists `post-process.ts`, `model-registry.ts` and `W/nodes/summarize.ts` (4.5 rule 4), and the cost cases of 10.6 still pass. Proof P1 P2.

### 11.6 Agent roles and the three Haiku checks

The coordinator (main session) runs one workflow for each WP. The script starts agents only. The coordinator does the git and GitHub steps between runs (B1), re-runs the key acceptance commands, reads the output and the screenshots, and accepts no agent report as proof.

- **Implementer** (Sonnet): code and tests in the WP worktree; gates; reports commands and real output. Does not create, push, merge or delete a branch, and touches no file outside the card.
- **Reviewer** (Sonnet): reads the diff against the spec section; finds scope creep, overbuilding, wrong comments and STE errors. Edits no file.
- **Prover** (Sonnet): runs the P2, P3 and P5 proofs from the PR branch; writes only to `$S`; reports commands, output, screenshot paths. The implementer is not the prover.
- **H1 scope, H2 tests, H3 citations** (Haiku): read-only checks below.

Implementer, reviewer and prover stop after 2 failed rounds on the same problem; the coordinator reports to the owner and proposes a card change.

**H1.** Write the owned paths into `$S/owned-wpN.txt` (a path ending `/` is a prefix). Expected: no output.

```bash
git diff --name-only origin/main...HEAD | awk 'NR==FNR{o[$0]=1; next} {ok=0; for (p in o) if (p==$0 || (p ~ /\/$/ && index($0,p)==1)) ok=1; if(!ok) print}' "$S/owned-wpN.txt" -
```

**H2.** On the branch point and the branch:

```bash
pnpm --filter @openstyle/server exec vitest run --reporter=json --outputFile="$S/server-after.json"
jq '[.numTotalTests,.numPassedTests,.numFailedTests,.numPendingTests,.numTodoTests]' "$S/server-after.json"
```

Pass: `numFailedTests` 0; `numPendingTests` not above baseline; `numTotalTests` at least baseline plus the card's new cases ([Vitest reporters](https://vitest.dev/guide/reporters.html)). Also `git diff origin/main...HEAD -- '*.test.ts' | grep -E '^\+.*(\.only\(|\.skip\(|it\.todo|xit\(|xdescribe\()'` prints nothing.

**H3.** For each `path:line`, run `sed -n "<line>p" <path>` and compare with the claim; fetch each URL and check the claim. Report claim, result, evidence line.

### 11.7 Merge order

0 Spec PR #186 (the contract). 1 WP1 (changes lockfile and SDK for all lanes, B15). 2 WP2 (schema version; WP3, WP4, WP5a need it). 3 WP10a (scripts only; any time before WP10b). 4 WP3 (after WP1, WP2). 5 WP4 (after WP2). 6 WP5a (after WP2, WP3, WP4). 7 WP5b (after WP4, WP5a; flag default = Q1). 8 WP6, WP7 and WP8 (after WP5b). 9 WP9 (after WP5b, WP6, WP7). 10 WP10b (after WP9; council consensus first). 11 WP5c, the default flip PR, then release B (only after consensus, D12; it edits `parseMeetingEnhanceWorkflow` of WP5b and the tests of the flag, and no other lane touches them then). 12 WP11 (after one release with default on, and the Q1 answer).

The coordinator merges one PR at a time. After each merge it rebases open lanes, runs `pnpm install` on lockfile conflicts (B10) and `bash scripts/branch-closeout.sh <pr>` (`SK/branch-lifecycle/SKILL.md:34-38`). A quality change needs the council verdict in the PR before `--auto` (`SK/branch-lifecycle/SKILL.md:19`). WP5a to WP6 change transcript output only when the flag is on; a missing key means off, so default output does not change (Q1 confirms this reading).

---

## 12. Risks, open questions and rollout

### 12.1 Risks

UNVERIFIED = nobody proved it in this repo. Last column = the WP that proves the control.

| ID | Risk and evidence | Control | WP |
|---|---|---|---|
| R1 | WP1 breaks dictation or Remix for all users (D7 is global). A v7 model in a v6 `generateText` fails and dictation pastes raw text silently. | Wire snapshots pinned to v6; real-app proof with negative control; WP1 ships alone first (Q8) | 1 |
| R2 | New dependencies can push the asar past its target of about 9 MiB (`AGENTS.md:87`). The last measure is 8.98 MiB after commit `1f093b9`, dated 2026-09-03 (`specs/lean-audit-2026-09.md:257`). This spec did not re-run it at c47cd80d (UNVERIFIED). `@langchain/langgraph` 1.5.1 is 4.57 MB unpacked ([npm](https://registry.npmjs.org/@langchain/langgraph/latest)); a research run counted 22 packages and 54.6 MB with `@langchain/core` (upper bound before tree-shaking, not repeated; bundled size UNVERIFIED). Tracing adds 19.0 MB, 3.70 MB JS. | Measure `out/` and `app.asar` in each WP that adds a dependency (Q6); tracing loads by `import()` only when on | 1, 4, 5a, 8, 9 |
| R3 | ESM-only v7 packages or dynamic requires fail in the CJS bundle ([guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)). The guard reads top-level files and literal `require("x")` only (`apps/electron/scripts/check-bundled-requires.mjs:34,26`). A real v7 and LangGraph build is UNVERIFIED. | WP1 extends the guard with a red proof; GT5 per dependency WP; packaged build in WP9 | 1, 5a, 9 |
| R4 | Fake timers stall a test: `apps/server/tests/setup.ts:16` fakes timers for every server test; Vitest fakes `setTimeout`, not `nextTick` ([Vitest](https://vitest.dev/api/vi.html)). Other LangGraph parts UNVERIFIED (U7, 3.7). | `vi.advanceTimersByTimeAsync`; opt out per file (`apps/server/tests/trace.test.ts:31-41`); no WP edits `apps/server/tests/setup.ts` (rule in 11.4; the file has 4 commits, the last on 2026-08-20, from `git log -- apps/server/tests/setup.ts`); first test of WP4, WP5a, WP8 uses a timer | 3, 4, 5a, 8 |
| R5 | oMLX may keep `json_schema` best effort only (peer report, not verified here: `/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/omlx-structured-output-peer-finding.md`); it reports `tool_calls` when `max_tokens` cuts a tool call (`/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:131`). | zod-validate every answer; handle `length` (4.0.6); send no tools | 3, 5a, 9 |
| R6 | Some providers do not enforce a strict schema ([Groq](https://console.groq.com/docs/structured-outputs), [OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs)). `@ai-sdk/openai-compatible` drops the schema when `supportsStructuredOutputs` is false ([source](https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts#L250-L306)). The Groq error for an unsupported model is UNVERIFIED. | Mode table and cache; OpenRouter `require_parameters`; cloud proof waits for Q5 | 3 |
| R7 | Mixed `ai` copies: lockfile holds `ai@6.0.191` and `ai@6.0.240` (`pnpm-lock.yaml:2884,2890`); `packages/stt/package.json:53` has its own `ai`; `@ai-sdk/otel` pins `ai` 7.0.143 ([npm](https://registry.npmjs.org/@ai-sdk/otel/latest)). | WP1 moves all copies in one PR | 1 |
| R8 | New schemas fill the oMLX grammar cache, about 0.45 GB each (`/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:140`). | One fixed schema per node (L5); test compares schema sets of two meetings | 5a, 9 |
| R9 | Transcript quality gets worse. #163: 2 of 8 chunks failed, zero speaker rows ([issue](https://github.com/Maheidem/openstyle/issues/163)); no Enhance metric today (`scripts/meeting-v2/metrics.mjs:636`). | D12: benchmarks and council, 3 runs per arm; the flag keeps the old path until consensus | 10a, 10b |
| R10 | Retries multiply. SDK default is 2 retries ([docs](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)); default LangGraph `retryOn` ignores `statusCode` ([docs](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)); the retries must stay in one layer (5.6). | `maxRetries: 0`; one layer; request counts at a fake server through the whole graph (G5) | 3, 5a |
| R11 | The custom saver drifts from the base class. `node:sqlite` is "Stability: 1.1 - Active development" ([Node](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)); the suite may reject our FKs (O7-3). | Exact `@langchain/*` pins; conformance suite in CI | 4 |
| R12 | A resumed run repeats an LLM call, or resume fails after a kill in a fan-out. `async` durability can lose the last checkpoint ([docs](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)); `invoke(null, config)` after a kill in a `Send` super-step is UNVERIFIED (U2, 3.7). | `durability: "sync"`; attempt number in the record; live kill in WP5b settles U2 | 5b, 9 |
| R13 | New E2E specs can push the CI E2E step past its 5-minute limit (`.github/workflows/build.yml:203-204`). The step took 64 to 75 seconds in the 11 runs of `build.yml` that ran it on 2026-10-17 (`gh run view`; latest: [run 39054313843](https://github.com/Maheidem/openstyle/actions/runs/39054313843)). | Fake-server specs, few specs, read step time | 9 |
| R14 | Records grow the DB: about 0.6 MiB per 40-chunk run; D10 sets no age limit; retention keeps DB rows (`apps/server/src/lib/meetings/retention.ts:12-17`). | WP9 measures a long run; O7-1 asks for a limit | 9 |
| R15 | Prompts leave the machine, or LangSmith turns on. The app promises no telemetry (`AGENTS.md:9`); the server child gets all env of main (`apps/electron/src/main/server-host.ts:200-215`); LangChain tracing turns on when one of four variables is `true` ([source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/utils/callbacks.ts)). | OTel needs both variables; `W/load-graph.ts` removes the four (planned file, 3.1 rule 2), and test GR3 checks it (10.8); WP8 updates `AGENTS.md:9`; real-meeting runs keep variables unset (B12) | 5a, 8 |
| R16 | Enum words can drift between sections. P7 (7.2) puts no `CHECK` on enums, so a wrong word is stored and the UI shows `unknown`. 11.4 settles run status (`succeeded`), verdict codes and step keys. | The reviewer checks every enum word against 11.4 | 2 |
| R17 | Parallel lanes conflict on shared files. | Matrix, 11.7 order, H1, B10 | all |
| R18 | The old path drifts while both paths exist. | Freeze it; a critical fix is ported to the new path in the same PR | 5b-11 |
| R19 | The renderer carries two Enhance contracts (flag off: held request, 200/502; flag on: 202). | WP7 branches on status and tests both; WP11 deletes the old branch | 7, 11 |
| R20 | Tracing risks: large trace for a long meeting; unfinished trace after a resume; legacy integration may leave the SDK; a Finder launch may not pass the variables. | Live checks C1 to C10 (9.9) | 8 |

### 12.2 Open questions for the owner

D1 to D12 do not settle these. The recommendation is not a decision. The three that matter most: Q1, Q2, Q3.

| ID | Question and options | Recommendation | Blocks |
|---|---|---|---|
| Q1 | Keep the old Enhance and Summary path behind a flag until the council passes? A: yes, key `meeting_enhance_workflow`. B: no flag; build dark; one switch PR flips routes and renderer, draft during benchmarks. C: no flag; WP5b replaces the old path. | A: default output unchanged while work merges; costs the dual contract (R19) and old code until WP11. With the flag off the old path writes no call record (G7). B: its PR hits the 2-day stale rule (`SK/branch-lifecycle/SKILL.md:20`). C: breaks any release cut between merges and needs the council before WP5b merges (`SK/branch-lifecycle/SKILL.md:19`). | WP5b, WP11 |
| Q2 | Does the Enhance trigger also run Summarize (OQ-2, 3.7)? A: no. B: yes. | A: a person confirms speaker names between stages (3.6); a chained run adds up to 24 long calls per auto-run. WP6 builds both entry points, so B needs no rework. | WP6 |
| Q3 | Does the inspector show prompts for imported meetings? A: as recorded meetings. B: record, hide prompt text. C: do not record prompt text. | A: records stay on the Mac and need advanced mode. C conflicts with D10. B is the safer fallback (an import can hold others' speech). | WP7 |
| Q4 | How many PRs may be open? Change `WIP_LIMIT` (`scripts/branch-status.sh:21`)? | Cap 4 and constant 4 during the build. The script prints `!!` above its limit (`:48`). | wave 2 |
| Q5 | Which cloud providers need a live proof, and who supplies keys (5-Q2)? | The owner chooses; agents never enter keys; a proof sends fictional text and needs approval. Until then cloud paths have scripted-model tests only and stay UNVERIFIED. S5 (12.3) needs either the live runs or the owner's written acceptance. | WP3 cloud rows, S5 |
| Q6 | Bundle size limit for WP1, WP4, WP5a? WP8 proposes 1 MiB (Q9.4). | Proposal: 1 MiB for WP1, 3 MiB for WP5a, as `du -sk apps/electron/out` growth plus asar at release (G11, 1.2). | WP1, WP5a |
| Q7 | Which real meeting reproduces #163, and which go to Codex? | The owner names the id (10.15 reads `ca70f895`, UNVERIFIED). Codex gets a data set only after approval (`SK/council/SKILL.md:27`). | WP10a, 10b |
| Q8 | Ship WP1 and WP2 as their own release first? | Yes: WP1 changes the SDK for dictation and Remix (D7); a release with no feature isolates a regression. The owner triggers every release. | release |
| Q9 | D5 asks for a custom `retryOn`, which only a LangGraph `RetryPolicy` has. A node `RetryPolicy` re-runs the finished calls of a node that makes many calls (5.6, X7). May the one retry layer be `callUnit`, with the same `gatewayRetryOn` rule and one retry for each call? | Yes. The layer stays single and `maxRetries` stays 0. The alternative is one graph task for each call, with a loop of nodes and a higher recursion limit. | WP5a |
| Q10 | The pi pin of this project is `openai-codex/gpt-6.1-sol`. The source is the output of `pi_list_agents` with `doctor`, read on 2026-10-17. The pin file is outside this repo, so no `file:line` exists. The owner's note of the choice is `/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/keep-using-pi.md:17`. The user default is the local `mac-m3` (`defaultProvider` in the same output). That `openai-codex` is a cloud provider is UNVERIFIED. The name suggests OpenAI, and nobody observed a request. If it is cloud, a pi judge that reads compare files sends real meeting text to OpenAI. The `pi_agent` tool has no model parameter. A: approve each data set for pi, as for Codex, while the pin is a cloud model. B: the owner sets the project pin to a local provider (`Desktop`, `local-mac` or `mac-m3`) for the council; then pi needs no approval. C: drop pi as a judge. | B, if a local model can judge the compare files. Else A, one `AskUserQuestion` for each set. The council skill says pi is local (`SK/council/SKILL.md:26`): WP10b corrects it. | WP10b |
| Q11 | One flag (`meeting_enhance_workflow`) switches Enhance and Summarize. The summary changes from free Markdown to a schema that code renders, and no tool compares summary text (10.15, 10.18). A: one flag. S5 needs the count check and the owner's side-by-side read of the summaries for each data set. B: two flags. Summarize keeps the old path until the owner has read the summaries. C: one flag, count check only. | A: it adds no flag and no second rollout. B costs a second flag and a second default flip. C ships an unread change to the text that users read most. | S5, WP6 |
| Q12 | Where does the structured summary object live after a run (4.5.6)? A: only in `llm_calls.parsed_json` of the final call, the inspector record. No code reads it. B: also in a new column `meeting_summaries.summary_json`; migration 40 adds it (7.4) and SW3 writes it (4.6.1), so later code can read decisions and action items as data (P8). | A: nothing in this spec reads a decision or an action item as data, and a column adds a migration step and a write for no reader. A later migration can add the column when a feature needs it. B costs one migration step and one more column in the `INSERT OR REPLACE` statement (`S/routes/meetings.ts:1214-1216`; the table is `S/lib/schema.ts:790-799`), and the flag-off path would write NULL there. | WP2, WP6 |
| Q13 | Does a name confirmed (or an Enhance run that writes `enhanced_text`) while a Summarize run is stopped fail its resume with `transcript_changed` (3.4.7 guard 6)? A: yes; the user starts the run again. B: no; the hash of a Summarize run covers only ids, raw text and labels, and the resumed run keeps the old names from its checkpoint. | A: the summary prints the confirmed name and the enhanced text (4.5), so a resumed run would mix old and new text, and the screen already warns when names change after a summary (3.6). B gives the checkpoint's text and one less failure. | WP2, WP5b |
| Q14 | How does the owner turn the flag `meeting_enhance_workflow` on in his own app (stage S3, 12.3)? A: a toggle row that WP7 adds in Settings > Application, under Advanced mode, and shown only while Advanced mode is on (8.10). B: no screen; the owner writes the setting himself with `curl` and the app token. Agents may not write the real profile. | A: the key has no screen today, while the auto-run key has one (`E/renderer/src/pages/meetings/settings-popovers.tsx:263-315`). The row needs one file and two locale keys, and WP11 removes it. The Settings page has no separate Advanced section: the Advanced mode row is in Application (`E/renderer/src/pages/settings.tsx:886-894`). | WP7, S3 |
| Q15 | May the boot resume send one request to a cloud provider before it resumes a cloud run (3.4.7, 5.7)? The request is a `HEAD` on the provider base URL with no key and no meeting data. It happens only when an interrupted run uses that provider. A: yes. B: no probe for a cloud provider; a reboot with no network then ends a resumed cloud run with `provider_unavailable`. | A: the probe goes to a host the user configured, and the interrupted run already used that host. It adds no new host. `AGENTS.md:9` says the only outbound calls go to the STT and LLM providers the user configured. The code is not that exact today. The update check calls the GitHub release feed every 5 minutes while Automatic updates is on (`E/main/updater.ts:26,33-34,69-71,175-182`; `apps/electron/electron-builder.yml:90-93`). After an update downloads, main starts an MLX worker prefetch from GitHub (`E/main/updater.ts:150`; `S/lib/mlx-asr/runtime.ts:469-493`), only on Apple Silicon with an MLX model on disk (`S/lib/mlx-asr/runtime.ts:472`). A Whisper model download calls huggingface.co (`S/lib/whisper/models.ts:220`). None of these hosts is a provider the user configured with a key. B loses the finished work of the run after a reboot with no network yet. | WP3, WP5b |

Questions raised in sections 3 to 9 (owner answers in the spec review; each holds text and default; OQ-2 = Q2, 5-Q2 = Q5): 3.7 OQ-1 (resume by itself or by button after restart; default once by itself, WP5b); 4.7 N1 to N10 (WP5a, WP6); 5.10 5-Q1 and 5-Q3 (WP3); 6.11 Q-A to Q-C (WP1); 7.15 O7-1 to O7-4 (WP2, WP4, WP5b); 8.13 O8-1 to O8-3 (WP7; O8-2 is answered in WP11); 9.11 Q9.1 to Q9.6 (WP8). Checks between sections: 3.7 (X0 to X8) and 11.4.

### 12.3 Rollout plan

Assumes Q1 A, OQ-1, Q2 and Q8 as recommended. The coordinator changes it if the owner answers otherwise.

| Stage | What ships | Flag `meeting_enhance_workflow` | Entry gate | Rollback |
|---|---|---|---|---|
| S0 | Spec PR #186 merges. It is an open draft today (`specs/meeting-enhance-agentic.md:6`; `gh pr view 186` on 2026-10-17: state OPEN, `mergedAt` null; [PR #186](https://github.com/Maheidem/openstyle/pull/186)) | none | Owner approves the spec | Close the PR |
| S1 | Release A: WP1, WP2; no visible change | none | WP1, WP2 acceptance; dictation and Remix proofs | Revert. Migration 40 is additive; an older build opens a v40 file (`S/lib/schema.ts:168`) |
| S2 | WP3 to WP9 merge | missing key = old path | Each card passes | Leave the key unset; revert the PR |
| S3 | Owner turns the flag on in his own app with the toggle that WP7 adds: Settings > Application, under Advanced mode (8.10). Agents never write the real profile (`SK/live-testing/SKILL.md:14`) | `"true"`, owner profile only | S2 done, and the owner's build holds WP7 | Switch the toggle off (`"false"`) |
| S4 | WP10b: benchmarks, then council | `"true"` in scratch profile | WP10a baseline exists | FIX-FIRST or REVERT stops the stage |
| S5 | Release B with the default flip, which is WP5c (11.5): missing key = new path | missing = `"true"` | The "Done when" of WP5c (11.5) is the entry gate. Council `SHIP` from Claude, pi, Codex (D12). Summary gate: the count check and the owner's side-by-side read for each data set (10.15, Q11). Cloud gate: W12 passes, and the Q5 live runs pass or the owner accepts them as UNVERIFIED | Set `"false"`, or revert the flip |
| S6 | WP11 removes old path, key, dual contract | removed | One release with default on, no open regression issue, Q1 answered | Revert; data model unchanged |

The default flip is its own small PR, WP5c (11.5). It changes one function, `parseMeetingEnhanceWorkflow`. The auto-run reader treats only `"true"` as on (`S/lib/meetings/enhance.ts:57`); the new parser treats only `"false"` as off. OQ-1 matters at S5: a cloud run can cost money when the app resumes at launch (3.7); the default resumes once, then waits for the button. Until S5 a run with the flag off writes no call record, so G7 holds for flag-on runs only.

### 12.4 Data compatibility

| Item | What happens |
|---|---|
| Old `enhanced_text` rows | Stay. The transcript shows `enhancedText ?? text` (`E/renderer/src/pages/meetings/detail.tsx:862-866`). |
| Old meetings and summaries in the inspector | No records; the server returns empty lists; the inspector shows "No LLM record" (8.7). |
| Records of new runs | Link to segments, speakers, summary by string keys, not FKs (P3, 7.2); a re-transcribe deletes those rows and the records stay (WP2 test). |
| New run on an old meeting | Rewrites `enhanced_text`; a chunk with status `ok` and no correction resets its segments to `NULL` (N6, 4.7, default yes); never writes `confirmed_at` or `display_name` (4.6.1). |
| Downgrade | An older build opens a v40 DB (`S/lib/schema.ts:168`) and ignores the new tables; meeting delete still cascades. |
| Job kind, settings, exports | Kinds stay `enhance` and `summarize`; the one-second poll works (`detail.tsx:122-127`). The flag is optional; a missing key means the default of the current stage. `save` rewrites `transcript.md` and `transcript-enhanced.md` as today (4.6.5). `meeting_summaries` columns are unchanged. The structured summary object lives only in `llm_calls.parsed_json` of the final call; no column holds it (4.5.6, Q12). |
| Checkpoint data | Run state, not user data. One rule (3.4.6 step 5, 7.9, O7-2 closed): the runner deletes the checkpoints at every final status (`succeeded`, `partial`, `failed`, `cancelled`) and keeps them only for an `interrupted` run, which is the only run that can resume. GR17 tests it (10.8). |
