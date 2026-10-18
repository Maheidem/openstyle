# Technical Spec: Meeting Enhance v3 (generic LLM platform, agentic workflow, structured output, LLM inspector)

**Status:** Approved by the owner on 2026-10-17. Build starts with wave 1 (section 11).
**Author:** Claude Code coordinator, with Sonnet writers.
**Date:** 2026-10-17
**Tracking:** Umbrella issue #185. Draft PR #186. Origin issue #163.
**Scope:** a domain-agnostic LLM platform under `apps/server/src/lib/llm/` (gateway, `callUnit` retry, recorder, run registry, checkpoint saver, tracing), the meeting workflow as its first consumer, scope-generic DB schema (migration 40) and routes, the AI SDK v7 upgrade, removal of the Remix feature (own work package), shared types, renderer meetings pages, tests, scripts. The workflow replaces the old Enhance and Summary path directly: no feature flag, no dual path. Sections 3 to 12 name the files and the work. Work packages (11.2): WP0 (WIP limit 4), WP-R (Remix removal), then WP1 to WP11. WP-R and WP0 are new. WP5c and the old WP11 (remove the flag) do not exist. WP11 now means the close-out.
**Baseline:** `main` at `c47cd80d` (release 2.17.1). Every `file:line` was read on that tree. Re-verify before you implement.
**Rules:** ASD-STE100. Round-2 owner decisions (2026-10-17) override any older recommendation in this file set. Answered questions are recorded as decisions, not as open questions. No em-dashes. `file:line` for current-state claims. A URL for external claims. UNVERIFIED for unchecked claims.

**Table of contents**

- [1. Problem and goals](#1-problem-and-goals): [1.1 Owner decisions (2026-10-17)](#11-owner-decisions-2026-10-17), [1.2 Goals](#12-goals), [1.3 Non-goals](#13-non-goals), [1.4 Glossary](#14-glossary)
- [2. Current state (baseline c47cd80d)](#2-current-state-baseline-c47cd80d): [2.1 End-to-end flow, from stop or import to a saved summary](#21-end-to-end-flow-from-stop-or-import-to-a-saved-summary), [2.2 Flowchart of today's Enhance and Summary path](#22-flowchart-of-todays-enhance-and-summary-path), [2.3 Problems](#23-problems)
- [3. Target architecture](#3-target-architecture): [3.1 Components and files](#31-components-and-files), [3.2 The workflow graph](#32-the-workflow-graph), [3.3 Graph state](#33-graph-state), [3.4 Run lifecycle](#34-run-lifecycle), [3.5 Concurrency](#35-concurrency), [3.6 Summary: one graph with a list of stages](#36-summary-one-graph-with-a-list-of-stages), [3.7 Open questions, checks for other sections, unverified items](#37-open-questions-checks-for-other-sections-unverified-items)
- [4. Node specifications](#4-node-specifications): [4.0 Rules for all nodes](#40-rules-for-all-nodes), [4.1 `prepare`](#41-node-prepare), [4.2 `correctChunk`](#42-node-correctchunk), [4.3 `identifySpeakers`](#43-node-identifyspeakers), [4.4 `verifyEvidence`](#44-node-verifyevidence), [4.5 `summarize`](#45-node-summarize), [4.6 `save`](#46-node-save), [4.7 Decisions on the former open points](#47-decisions-on-the-former-open-points), [4.8 Unverified in this section](#48-unverified-in-this-section)
- [5. LLM gateway contract](#5-llm-gateway-contract): [5.0 What the gateway replaces](#50-what-the-gateway-replaces), [5.1 The function `callStructured`](#51-the-function-callstructured), [5.2 Typed errors](#52-typed-errors), [5.3 The acceptance gate](#53-the-acceptance-gate), [5.4 Structured-output mode for each provider](#54-structured-output-mode-for-each-provider), [5.5 Reasoning profile](#55-reasoning-profile), [5.6 Retries](#56-retries), [5.7 Timeouts, cancel and lanes](#57-timeouts-cancel-and-lanes), [5.8 Privacy](#58-privacy), [5.9 Proof the gateway needs](#59-proof-the-gateway-needs), [5.10 Proposals, risks and open points](#510-proposals-risks-and-open-points), [5.11 Decisions (2026-10-17)](#511-decisions-2026-10-17)
- [6. AI SDK v7 migration](#6-ai-sdk-v7-migration): [6.1 Decision and rules](#61-decision-and-rules), [6.2 Current state (baseline c47cd80d)](#62-current-state-baseline-c47cd80d), [6.3 Target versions](#63-target-versions), [6.4 Per-file checklist](#64-per-file-checklist), [6.5 Renames and API facts](#65-renames-and-api-facts), [6.6 Module format](#66-module-format), [6.7 Mixed copies of `ai` (the trap)](#67-mixed-copies-of-ai-the-trap), [6.8 Behavior changes that matter](#68-behavior-changes-that-matter), [6.9 Proof of no behavior change](#69-proof-of-no-behavior-change), [6.10 What the package must not do](#610-what-the-package-must-not-do), [6.11 Open items and decisions](#611-open-items-and-decisions), [6.12 Sources](#612-sources)
- [7. Persistence](#7-persistence): [7.1 Current state](#71-current-state), [7.2 Design rules](#72-design-rules), [7.3 Migration 40](#73-migration-40), [7.4 DDL](#74-ddl), [7.5 JSON column shapes](#75-json-column-shapes), [7.6 Enumerations](#76-enumerations), [7.7 The recorder](#77-the-recorder), [7.8 How a reader finds the link that is still true](#78-how-a-reader-finds-the-link-that-is-still-true), [7.9 Checkpoint tables](#79-checkpoint-tables), [7.10 Indexes](#710-indexes), [7.11 Size estimate](#711-size-estimate), [7.12 Retention, delete and boot sweep](#712-retention-delete-and-boot-sweep), [7.13 Proof run](#713-proof-run), [7.14 Files that change in section 7](#714-files-that-change-in-section-7), [7.15 Decisions (closed questions of section 7)](#715-decisions-closed-questions-of-section-7)
- [8. LLM inspector](#8-llm-inspector): [8.1 Current state](#81-current-state), [8.2 Decisions of this section](#82-decisions-of-this-section), [8.3 API](#83-api), [8.4 Types](#84-types), [8.5 Renderer data layer](#85-renderer-data-layer), [8.6 Entry points and layout](#86-entry-points-and-layout), [8.7 Panel content](#87-panel-content), [8.8 Design tokens](#88-design-tokens), [8.9 Persisted run status replaces the component Enhance error state](#89-persisted-run-status-replaces-the-component-enhance-error-state), [8.10 i18n](#810-i18n), [8.11 Files that change in section 8](#811-files-that-change-in-section-8), [8.12 Tests and proof](#812-tests-and-proof), [8.13 Decisions closed on 2026-10-17](#813-decisions-closed-on-2026-10-17)
- [9. Tracing](#9-tracing): [9.1 Decisions](#91-decisions), [9.2 Current state (main at c47cd80d)](#92-current-state-main-at-c47cd80d), [9.3 The three records](#93-the-three-records), [9.4 The trace log: what stays and why](#94-the-trace-log-what-stays-and-why), [9.5 MLflow export](#95-mlflow-export), [9.6 Span model (T5, T6)](#96-span-model-t5-t6), [9.7 Privacy and failure isolation (T7, T8)](#97-privacy-and-failure-isolation-t7-t8), [9.8 Bundle size and load cost](#98-bundle-size-and-load-cost), [9.9 Verification](#99-verification), [9.10 Hand-offs to other sections](#910-hand-offs-to-other-sections), [9.11 Decisions (2026-10-17) and open questions](#911-decisions-2026-10-17-and-open-questions)
- [10. Test plan and definition of done](#10-test-plan-and-definition-of-done): [10.1 Levels of proof](#101-levels-of-proof), [10.2 Rules for every test](#102-rules-for-every-test), [10.3 What exists today](#103-what-exists-today), [10.4 Goal-to-proof map](#104-goal-to-proof-map), [10.5 Gateway tests (sections 5 and 6)](#105-gateway-tests-sections-5-and-6), [10.6 Node tests (section 4)](#106-node-tests-section-4), [10.7 Saver tests (WP4)](#107-saver-tests-wp4), [10.8 Graph and runner tests (WP5)](#108-graph-and-runner-tests-wp5), [10.9 Migration, store and route tests (WP2)](#109-migration-store-and-route-tests-wp2), [10.10 Renderer tests and locales (WP7)](#1010-renderer-tests-and-locales-wp7), [10.11 End-to-end tests in the real app](#1011-end-to-end-tests-in-the-real-app), [10.12 Live proof on the owner's oMLX](#1012-live-proof-on-the-owners-omlx), [10.13 Tracing proof (WP8)](#1013-tracing-proof-wp8), [10.14 Bundle and packaging checks (WP1, WP5, WP8, WP9)](#1014-bundle-and-packaging-checks-wp1-wp5-wp8-wp9), [10.15 Quality gate: benchmarks and the council (WP10a, WP10b)](#1015-quality-gate-benchmarks-and-the-council-wp10a-wp10b), [10.16 Evidence, who runs what, cleanup](#1016-evidence-who-runs-what-cleanup), [10.17 Definition of done for each work package](#1017-definition-of-done-for-each-work-package), [10.18 Open points](#1018-open-points), [10.19 Decisions applied in this section (2026-10-17)](#1019-decisions-applied-in-this-section-2026-10-17)
- [11. Work breakdown and build orchestration](#11-work-breakdown-and-build-orchestration): [11.1 Build rules](#111-build-rules), [11.2 Work packages at a glance](#112-work-packages-at-a-glance), [11.3 Dependency graph and waves](#113-dependency-graph-and-waves), [11.4 File ownership and conflict matrix](#114-file-ownership-and-conflict-matrix), [11.5 Work package cards](#115-work-package-cards), [11.6 Agent roles and the three Haiku checks](#116-agent-roles-and-the-three-haiku-checks), [11.7 Merge order](#117-merge-order), [11.8 Decisions that shape this section (2026-10-17)](#118-decisions-that-shape-this-section-2026-10-17)
- [12. Risks, decisions and rollout](#12-risks-decisions-and-rollout): [12.1 Risks](#121-risks), [12.2 Owner decisions](#122-owner-decisions), [12.3 Rollout plan](#123-rollout-plan), [12.4 Data compatibility](#124-data-compatibility)

**Reference conventions.**

- A number such as 4.0.6 points to a heading in this file.
- An ID such as P9 or U3 is local to the section that defines it. Other sections name the section, for example "4.1 P9" or "3.7 U3".
- Tables 1 to 3 and Figures 1 and 2 are numbered in document order. Other tables have no number.
- Where two sections give one thing two names, the register in 11.4 and the checks in 3.7 name the conflict and the work package that settles it.

---

## 1. Problem and goals

Enhance (an LLM pass) improves a meeting transcript. A second pass writes the summary. Both call `defaultChatCallFor` (`apps/server/src/lib/meetings/llm-call.ts:69`): Enhance builds it at `enhance.ts:375` and sends the request at `enhance.ts:498`; summary builds it at `summarize.ts:390` and sends the request at `summarize.ts:434` (same folder). Problems: one call does two jobs (P1), no schema (P2), only `length` is an error (P3, P4), a failed chunk is skipped with no retry (P5), failures show only in the server log (P7), no call leaves a record (P10), a run cannot resume (P9). Evidence: 2.3.

**Issue #163** (https://github.com/Maheidem/openstyle/issues/163). On an 8-chunk owner meeting (local oMLX, Qwen3.8-27B), 2 of 8 chunks failed in 6 of 6 tries, so a plain retry does not help. Two ended with `length`; one returned invalid JSON with `stop`. The model writes the `speakers` block first and reasons inside `evidence`, so later corrections are lost. Chunk 0 held the only grounded self-introduction; its failure lost the speaker names of chunks 1 to 7 (2.3 P6). Meeting `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6` reproduces it. VERIFIED: `/tmp/meeting-v2/r9b.log` lines 3, 8, 23, 28, 48, 53 (`chunksAttempted` 8, `chunksFailed` 2, 6 of 6 arm A tries); `/tmp/meeting-v2/r9b.log:1-60`; `specs/meeting-transcription-v2.md:483-486`. D1 goes further than the three fixes of the issue.

### 1.1 Owner decisions (2026-10-17)

**D1. An agentic workflow with specialized steps.** One LLM call never does two jobs. Steps: (1) prepare (code); (2) correct text for each chunk (LLM, fan-out); (3) identify speakers (LLM); (4) verify evidence (code); (5) summarize (LLM, map and reduce when long); (6) save, with a status for each step (code). Enhance chains into Summarize in the same run (Q2): the auto Enhance and the Enhance button run steps 1 to 6. The Summarize button stays as a separate entry point of the same graph. A speaker name confirmed later makes the summary stale; the existing stale warning stays. Section 4 fixes the list. Reason: in #163 the speaker block caused the `length` stops. The evidence check is already code (`apps/server/src/lib/meetings/enhance.ts:328-356`).

**D2. Always structured output.** Every LLM step returns an answer that one fixed zod schema validates. Reason: a stray quote in one `evidence` string broke a chunk in #163. Each new schema adds about 0.45 GB to the oMLX grammar cache (https://github.com/jundot/omlx/issues/4321). Whether local oMLX enforces a strict `json_schema` is UNVERIFIED (section 10).

**D3. Reasoning follows a profile per model and provider (section 5).** For oMLX with Qwen, keep the full parameter set the app already sends (`chat_template_kwargs` and presets, `apps/server/src/lib/llm/task-profiles.ts:355-368`). The stored owner preset is UNVERIFIED. Reason: AI SDK v7 lets a provider-specific setting override its `reasoning` option without a warning.

**D4. Every finish reason other than `stop` is a handled error.** Valid JSON with a non-`stop` reason is still an error. Every failure is typed and shows per step in the UI. Reason: AI SDK v7 returns valid JSON that ended with `length` or `content-filter` without an error (section 6).

Table 1. Route for each unified finish reason (D4).

| Unified finish reason | Route |
|---|---|
| `stop` | Success, after the other gateway checks (section 5). |
| `length` | Split the input or raise the output budget. If it still ends with `length`, fail with a typed error. |
| `content-filter` | Fail with a typed error. Do not retry. |
| `tool-calls` (unexpected) | Fail with a typed error. |
| `error`, `other` | Retry once with backoff. Then fail with a typed error. |

**D5. Orchestrator: LangGraph.js.** Use `@langchain/langgraph` (MIT) in process. Nodes call the Vercel AI SDK directly, not LangChain chat models. One retry layer exists: the AI SDK runs with `maxRetries: 0`, so `callUnit` is the only layer. It makes one retry per call by the `gatewayRetryOn` rule, and no node has a `RetryPolicy` (Q9; 5.6). Reason: the default `retryOn` can retry a 4xx error (UNVERIFIED by a run; 3.2 edge rule 7, 5.6). Mastra is out: its `ee/` folders have a non-open license (https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE). CrewAI is out: it is Python (https://pypi.org/pypi/crewai/json).

**D6. Resume after an app restart: a custom checkpoint saver on `node:sqlite`** (planned; no checkpoint saver exists yet. The server already uses `node:sqlite` at `apps/server/src/lib/db.ts:1`). Validate it with `@langchain/langgraph-checkpoint-validation`. The owner first chose the official `better-sqlite3` saver, then switched after the cost check:
- It needs a native module: version 1.1.0 depends on `better-sqlite3` `^12.10.0` (https://registry.npmjs.org/@langchain/langgraph-checkpoint-sqlite/1.1.0), whose install script is `prebuild-install || node-gyp rebuild --release` (https://registry.npmjs.org/better-sqlite3/12.10.0).
- In the electron-vite bundle, that module's loader becomes a stub that throws. UNVERIFIED here: found by a research bundle test outside this repo. A real build must confirm it (10.14, BC3, BC4).
- The guard checks only literal `require("x")` calls (`apps/electron/scripts/check-bundled-requires.mjs:26`, `:44-52`). Whether it misses the stub is UNVERIFIED.
- It also needs a fetch script, signing and an `allowBuilds` entry (`pnpm-workspace.yaml:4-8`). The plan counts 4 CI changes (estimate, UNVERIFIED); the ffmpeg fetch step runs in 3 build jobs (`.github/workflows/build.yml:229-231`, `:290-292`, `:510-512`). `test-electron` builds the app and runs the guard (`.github/workflows/build.yml:152-205`, guard `:189-191`).

**D7. Gateway: upgrade the Vercel AI SDK to v7, globally.** Upgrade `ai` from 6.0.191 (`pnpm-lock.yaml:317`). Dictation cleanup and meetings move together. Remix leaves first (D15), so no Remix file takes part. Reason: server, `stt` and renderer pin `ai` to `^6.0.191` (`apps/server/package.json:36`, `packages/stt/package.json:53`, `apps/electron/package.json:42`). The lock already holds `ai` 6.0.191 (`pnpm-lock.yaml:7348`) and 6.0.240 (`:7356`); `@ai-sdk/react` 3.0.242 pulls 6.0.240 (`:5204-5207`). After D15, `@ai-sdk/react` and the 6.0.240 copy should leave the lock (STATIC, `specs/remix-removal-inventory.md` section 10; UNVERIFIED until a lock run). A mixed pair is a trap (negative control 6.9.4; UNVERIFIED until run). Whether v7 accepts the server's major 3 provider packages is UNVERIFIED (6.7, 6.11). `@ai-sdk/otel` needs `ai` v7, so D8 needs v7 (https://registry.npmjs.org/@ai-sdk/otel/latest).

**D8. Tracing: a local record always, OpenTelemetry export only when configured.** The app always keeps the local record (D10). It exports OpenTelemetry traces to MLflow only when a user sets an endpoint; export is off by default. The owner's MLflow server is `http://192.168.31.154:5000`. Verify each trace by reading it back with `search_traces`. Reason: the app promises no telemetry (`AGENTS.md:9`). How MLflow renders AI SDK spans is UNVERIFIED (section 9).

**D9. LiteLLM: do not embed it now.** Apply its lessons (Table 2) to the AI SDK gateway. A user-run LiteLLM proxy already works as an OpenAI-compatible `server` endpoint. Reopen only if new facts appear. The owner asked, "do we really need it now?" The coordinator answered no:
- The server is TypeScript; the AI SDK unifies 8 providers in process (`apps/server/src/lib/llm/registry.ts:171-277`).
- LiteLLM needs a Python sidecar: 18 base packages, a 36.4 MB arm64 wheel (https://pypi.org/pypi/litellm/1.105.1/json). Import may download a price map unless `LITELLM_LOCAL_MODEL_COST_MAP=True`. UNVERIFIED: the gate is not confirmed in `litellm/__init__.py` lines 549-551 (https://github.com/BerriAI/litellm/blob/caad4d62045e76c1a8428ab8f316d351ca9a0a7e/litellm/__init__.py#L549-L551); it may live in `litellm/litellm_core_utils/get_model_cost_map.py`.
- It maps `error`, `network_error`, `MALFORMED_RESPONSE` and unknown finish reasons to `stop`, which breaks D4 (https://github.com/BerriAI/litellm/blob/caad4d62045e76c1a8428ab8f316d351ca9a0a7e/litellm/litellm_core_utils/core_helpers.py#L229-L291).
- Versions 1.82.7 and 1.82.8 were compromised on 2026-03-24 (https://docs.litellm.ai/blog/security-update-march-2026).
- A proxy needs no code: a server entry stores a base URL and optional key (`apps/server/src/lib/own-servers.ts:37-53`), served through `createOpenAI` (`registry.ts:245-274`).

**D10. LLM inspector.**
- The app always records every LLM call locally (corrections, speaker suggestions, summary, failures, retries). Imported meetings are recorded like recorded ones (Q3). The UI shows records only in advanced mode (`advanced_mode` setting, a renderer gate; shared key, `packages/validations/src/settings-keys.ts:6`). Records are deleted with their meeting: the tables are scope-generic (D14), and a nullable `meeting_id` foreign key with `ON DELETE CASCADE` to `meetings` keeps this rule.
- A record holds: messages sent; schema; params actually sent (param ledger: top level, extra body or dropped); raw response text; parsed object; finish reason (unified and raw); tokens (input, output, reasoning, cached when known); latency; attempt number and retries; served model next to requested model; typed error, if any.
- A record links to what it produced by a generic link `(target_type, target_id)`: edited segments; speaker suggestions, with verdict (kept or dropped) and reason; the summary; failures and retries that edited nothing.
- The inspector UI stays meeting-only for now. Its data API and types are generic (D14). Owner's intent: in the meeting transcript screen, a click on an edited text shows the exact message sent and received, hidden by default and enabled in Advanced.
- Reason: no table keeps these data today.

**D11. Build: workflows, with Sonnet and Haiku agents.** Sonnet agents implement and judge. Haiku agents run brute-force checks. Parallel lanes are allowed. Only the coordinator creates, pushes and merges branches. Reason: the branch rules cap open PRs at 2 (`.claude/skills/branch-lifecycle/SKILL.md:13`). The owner set 4 open PRs for the build (Q4): `WIP_LIMIT` in `scripts/branch-status.sh` is 2 today (`scripts/branch-status.sh:21`). The build plan raises it to 4 and returns it to 2 after the build. UNVERIFIED: no code sets 4 yet.

**D12. Quality gate: benchmarks and the council.** A change to transcript quality needs a before/after `meeting-benchmarks` run on the owner's real meetings, then the council (Claude, pi, Codex). The council reaches consensus before the WP5b merge (D13). Release needs consensus: all three judges say SHIP (`.claude/skills/council/SKILL.md:33`). Reason: Codex sends meeting text to the cloud and the skill asks approval for each data set (`.claude/skills/council/SKILL.md:27`). The owner states (2026-10-17) that the benchmark meetings (`ca70f895` and the control meetings) may go to pi (pin `openai-codex/gpt-6.1-sol`) and to Codex in this development, with no approval for each data set.

**D13. No feature flag: direct replacement (Q1).** The new workflow replaces the old Enhance and Summary path. WP5b switches the routes and the renderer. There is no `meeting_enhance_workflow` key, no toggle row and no dual contract. The council must reach consensus BEFORE the WP5b merge. A release cut between merges ships the change. Reason: a flag would keep two code paths alive.

**D14. The LLM framework is a generic platform (Q16).** The domain-agnostic parts live under `apps/server/src/lib/llm/`: gateway, model profiles, typed errors, `callUnit` retry, call recorder, run registry, checkpoint saver, workflow helpers, tracing. Meetings are the first consumer, under `apps/server/src/lib/meetings/workflow/`. The tables `llm_runs` and `llm_calls` carry `scope` (for example `meeting`) and `scope_id`. Links use `(target_type, target_id)`. A nullable `meeting_id` foreign key (or an equivalent cascade path) keeps delete-with-meeting (D10). Reason, owner: "essa estruturação do framework de LLMs vai ser a base pro futuro estender as capacidades agênticas em outras áreas".

**D15. Remove Remix now, in its own work package.** The Remix feature leaves the app: renderer pages and components, the Remix bar window, main-process windows, hotkeys and IPC, server routes and libs (`remix-transform`, `remix-agent`, `routes/remix`), the `remix` LLM task id with its profile and assignment UI, settings keys, onboarding, help and tutorial text, locale keys, tests, E2E specs and site mentions. `specs/remix.md` is marked retired. The removal has exclusive file ownership and lands before WP1. File list: `specs/remix-removal-inventory.md` (42 files to delete, 94 to edit; STATIC, UNVERIFIED until a build). Reason: the owner finds the current Remix bad and will rebuild it later on the new platform. WP1 also shrinks: no `remix-transform`, `remix-agent`, `remix-chat` or `@ai-sdk/react` work remains.

**D16. The summary has fields and a stored object (Q11, Q12).** The schema has five fields: overview, key points, decisions, action items, open questions. Code renders the object to Markdown. The save step also writes the object to the new column `meeting_summaries.summary_json` (migration 40), so later code can read decisions and action items as data. The check before the WP5b merge is automatic only (section and count checks); the owner does no side-by-side read.

**D17. Resume rules (Q13, Q15).** A confirmed speaker name, or a new `enhanced_text`, while a Summarize run is `interrupted` makes its resume fail with `transcript_changed`. A name confirmed while a chained run is `interrupted` does the same, because its Summarize stage prints the name. The user starts the run again. Before the boot resume of an interrupted cloud run, the app may send one HEAD request to the base URL the run already used, with no key and no meeting data. Reason: a resume on a changed transcript gives a summary of old text; the probe avoids a failed run at boot with no network.

**D18. Proof and release scope (Q5, Q6, Q8).** Only the owner's local oMLX (Qwen3.8-27B) gets live proofs. Cloud paths keep scripted-model tests and stay UNVERIFIED. No fixed bundle limit applies: each PR measures and reports the growth (`du -sk apps/electron/out`, and the asar size at release). Everything ships in one release. Reason: the owner keeps the app local-first and wants measured numbers, not a fixed cap.

Table 2. LiteLLM lessons that section 5 applies in the gateway (section 5 holds the sources).

| ID | Lesson |
|---|---|
| L1 | `stop` is not proof. Check the unified and the raw finish reason, and the stop aliases of each provider. A `<think>` tag in the content, or empty content with reasoning present, is a typed `ReasoningLeakError`. |
| L2 | Always send the reasoning params, also when thinking is off. Record a param ledger for each call. A missing thinking flag once gave about 48k characters of reasoning and `length` before any JSON (owner note outside this repo: `~/.claude/projects/-Users-maheidem-Documents-dev-OktoLabsAI-marginalia/memory/project_thinking_transport_loopback_bug.md:12-14`). |
| L3 | One retry layer (`callUnit`), SDK retries at 0. Retry a transient provider error once, with a cap on the Retry-After wait. On `length`, retry once with less reasoning, a bigger budget or a split input. On a schema error, retry once with the validator message in the prompt. Never retry `content-filter` or an auth error. |
| L4 | Check the served model against the requested model. oMLX `model_fallback` once answered with another model. |
| L5 | Use a fixed schema for each node. No dynamic enums of ids. For strict mode make all fields required and use nullable instead of optional. UNVERIFIED as a stated rule; the page only shows required fields with type `[string, null]` in an example (https://developers.openai.com/api/docs/guides/structured-outputs). Authors write to these rules and a test enforces them. The AI SDK sets `additionalProperties` false itself; the gateway does not change the schema (4.0.3 rule 7). |
| L6 | Prove the gateway with real calls, not only mocks. Two earlier projects had green suites (988 and 4,052 tests) while real use failed (section 10). |

### 1.2 Goals

Section 10.4 maps each goal to its proof, run against the real system.

| ID | Target (decisions) |
|---|---|
| G1 | One fixed zod schema for each LLM node, with no fields for two jobs. 0 uses of brace slicing in the new path (`extractJsonObject`, `apps/server/src/lib/meetings/enhance.ts:232-246`). (D1, D2) |
| G2 | A test covers the 6 unified finish reasons. Valid JSON with `length` fails typed. One live Qwen3.8-27B call with a small token cap ends in that error. (D4) |
| G3 | Close #163: on its 8-chunk meeting, 6 of 6 runs finish all 8 correction chunks. A failed chunk shows its typed error. The speaker step still returns suggestions. The gate counts only if the old path fails at least one chunk in each baseline run on the same meeting context (10.15). Else the result is "not reproduced" and the replay GR5 is the proof. (D1, D4) |
| G4 | A failed step shows its typed error kind in the meeting screen, after a reload and after an app restart. (D4) |
| G5 | `maxRetries` is 0 on every workflow call. A fake server counts requests for one call: transient error 2, `content-filter` 1, auth error 1, invalid schema 2. A call gets at most one retry, and a retry never repeats another call of its unit. A split chunk whose second half fails twice with HTTP 503 sends 4 requests. (D5, L3, 5.6) |
| G6 | Kill the server during a run. After the restart the run continues and finished nodes send 0 new LLM requests. If the endpoint (local server or cloud provider) is down at boot, the run stays `interrupted` and the boot resume is not counted. The saver passes `@langchain/langgraph-checkpoint-validation`. (D6) |
| G7 | Every call of a run has a record with all D10 fields, or a counted lost record (7.7); the live proof shows 0 lost records. Edited segments, speaker suggestions and the summary link to their calls. The UI shows records only when `advanced_mode` is `"true"`. After a meeting delete, 0 records remain. (D10) |
| G8 | The param ledger equals the body on the wire. Reasoning params go out on every call. A served-model mismatch fails typed. (D3, D4, L2, L4) |
| G9 | `pnpm-lock.yaml` holds one `ai` version. Dictation cleanup and meetings each pass their tests and one live run. (D7) |
| G10 | No endpoint: no tracer runs and no connection opens. With an endpoint: `search_traces` reads back one MLflow trace for each run, state OK, one span for each call. (D8) |
| G11 | No native module. `check-bundled-requires.mjs` passes. A packaged build runs one Enhance. The asar size and `du -sk apps/electron/out` are recorded before and after and reported in each PR. No fixed limit. (D6, D18) |
| G12 | The `meeting-benchmarks` before/after run on the owner's real meetings shows no regression. The council reaches consensus SHIP before the WP5b merge. (D12, D13) |
| G13 | Remix is gone: no Remix route, window, hotkey, IPC channel, setting key, locale key or LLM task id remains; the app builds and passes its tests; the Remix grep of 10.14.1 prints nothing. Migration 40 drops the 3 `remix_*` tables and the 3 Remix settings rows (WP2, 11.8 row 21). (D15) |
| G14 | Code under `apps/server/src/lib/llm/` imports nothing from `apps/server/src/lib/meetings/`. `llm_runs` and `llm_calls` hold `scope` and `scope_id`, and a meeting delete removes its rows. (D14) |
| G15 | A finished summary run writes `meeting_summaries.summary_json`, and the stored object passes the summary schema. The automatic section and count checks pass before the WP5b merge. (D16) |

### 1.3 Non-goals

- No Remix feature or redo now (D15). No cloud live proof now (D18).
- No LiteLLM module (D9). No native Node module. No Python sidecar (D6).
- No change to speech-to-text, alignment, diarization or merge. Enhance starts after the status `transcribed`: `apps/server/src/routes/meetings.ts:1007-1011` sets it, and `:1039-1043` starts the auto Enhance job when the setting is on.
- Dictation changes only by the AI SDK v7 bump (D7). Dictation and meetings share the `stt` `postProcess` function (`packages/stt/src/post-process.ts:108`). Dictation calls it through the server wrapper (`apps/server/src/lib/post-process.ts:139` defines the wrapper, import `:2`, call `:228`; callers `apps/server/src/lib/transcription-pipeline.ts:238`, `apps/server/src/routes/stream.ts:366`). Meetings call the `stt` function directly (import `apps/server/src/lib/meetings/llm-call.ts:14`, call `:136`). Changes there add fields only.
- macOS on Apple silicon only (`README.md:54`; `AGENTS.md:9` says developed and tested on macOS/Apple Silicon). Local-model proofs use MLX. No required cloud service: a Mac with no network still runs Enhance on a local server, because the models.dev read of 5.1 is best effort. It fetches `https://models.dev/api.json` (`apps/server/src/lib/model-registry.ts:64-68`); a cold cache records cost as 0 and avoids a stall (`apps/server/src/lib/model-registry.ts:113-117`), and its caller ignores a failure (`apps/server/src/routes/models.ts:161-165`). No telemetry by default (D8).
- No LangGraph Studio or LangSmith. Studio needs a LangSmith account (https://docs.langchain.com/oss/javascript/langgraph/studio).
- No new LLM step outside D1. No new client of the server API.

**Constraints that bind every section.**
- Every local app run, E2E spec and UI proof runs through `scripts/test-runner/run.sh <cwd> -- <command>` (`.claude/skills/live-testing/SKILL.md:202`). The script forwards the caller environment (`scripts/test-runner/run.sh:24`) and sets no quiet-mode variable. `OPENSTYLE_E2E=1` turns on quiet mode (`AGENTS.md:89`).
- Never use the installed app, port 4649 or the real profile (`AGENTS.md:88`). Never use the mic or system audio: those tests stay CI-only (`.claude/skills/live-testing/SKILL.md:200`). Stop at the first unexpected privacy prompt (`:204`). Tell the owner before a run that can raise an expected prompt (`:200`).
- The owner's oMLX at `127.0.0.1:8123` is live infrastructure (`.claude/skills/live-testing/SKILL.md:227-229`; `specs/model-picker-groups.md:15` only says the server is configured in three places). Send only Qwen3-ASR and Qwen3.8-27B requests. Never send Parakeet, TTS or embedding requests. Whether it answers now is UNVERIFIED: this spec work sent no request to it.
- pi and Codex may read the benchmark meetings (D12).
- The app ships no `node_modules`. The asar was near 9 MiB at baseline (`AGENTS.md:87`). Each PR reports measured size (D18).
- Done means proven end to end on the real running system. Unit tests alone never count. Tracker and branch rules: section 11.

### 1.4 Glossary

| Term | Meaning in this spec |
|---|---|
| Workflow, run, step, node | The workflow is the graph of steps for one scope item (first scope: one meeting). A run is one execution. A step is one job (D1). A node is the LangGraph function for a step. A fan-out node runs once for each chunk. |
| Chunk | Whole `meeting_segments` rows for one correction call (table: `apps/server/src/lib/schema.ts:778-788`; whole-segment chunks: `apps/server/src/lib/meetings/enhance.ts:10-12`). Today the limit is 1200 tokens (`apps/server/src/lib/meetings/enhance.ts:66-69`). Limit: 4.0.5, 4.1 P6. Not an audio chunk. |
| Call | One request to a model endpoint, with its response or error. A retry is a new call. One inspector record per call. |
| Job | The in-memory slot of the job registry, one for each meeting (`apps/server/src/lib/meetings/job-registry.ts:2-3`; jobs map `:53`; `claimJob` `:81-88`). A run is not a job (3.4.1). |
| Profile | An entry keyed by provider and model: how to switch reasoning and which params to send (D3). Not the task profile (`LLM_TASK_PROFILES`, `apps/server/src/lib/llm/task-profiles.ts:81`). |
| Finish reason, unified and raw | Six AI SDK values: `stop`, `length`, `content-filter`, `tool-calls`, `error`, `other` (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/types/language-model.ts#L75-L81). The provider's own string is `rawFinishReason` (same repo, `generate-text/generate-text-result.ts#L114`, unpinned main, lines may drift). |
| Platform layer, scope | The platform layer is the domain-agnostic code under `apps/server/src/lib/llm/` (D14). A scope names a run's domain, for example `meeting`, with a `scope_id`. |
| Typed error, param ledger, served model | A typed error has a fixed `kind` (section 5). The ledger lists each request param of one call and its place: top level, extra body field, or dropped. The served model is the model the endpoint names in its response; it can differ from the requested model (L4). |

---

## 2. Current state (baseline c47cd80d)

Scope: `main` at c47cd80d (release 2.17.1). The spec changes no code. Sections 3 to 12 answer P1 to P14 (table in 2.3). Owner decisions of 2026-10-17: the new workflow replaces the path below directly (no feature flag), and Enhance chains into Summarize in the same run. Remix is out of scope; its removal is a separate work package.

Cites are `file:line` with the base name. A directory prefix marks a base name that exists in several places: server/index.ts (`apps/server/src/index.ts`), llm/registry.ts (`apps/server/src/lib/llm/registry.ts`), providers/server.ts (`apps/server/src/lib/streaming/providers/`), meetings/import.tsx (`apps/electron/src/renderer/src/pages/`), stt/post-process.ts (`packages/stt/src/`), validations/settings.ts (`packages/validations/src/`). Every other base name matches one tracked file. `index.mjs` and `index.d.ts` = `ai@6.0.191 dist/`. UNVERIFIED marks an unchecked claim. Chunk, call and job: 1.4.

---

### 2.1 End-to-end flow, from stop or import to a saved summary

13 steps. Steps 10 and 12 call an LLM. Steps 1 to 9 are context.

| # | Step | What happens | Cites |
|---|---|---|---|
| 1 | Record or import (user) | The recorder journals `mic.wav`, `system.wav` and `sync.json`. Stop finalizes them, then sends POST `/:id/stop`. Import writes `system.wav` only. | meeting-recorder.ts:13-16, 349-350 (opens the WAV writers at start), 728-743 (stop: teardown 731, `writeJournal` 738, POST 743; `stopSync` 770-779 calls `teardown` and sends no POST); meetings.ts:1466; meetings-import.ts:8-14, 277-292 |
| 2 | Start transcription (user) | Route sets `transcribing`, clears old segments, speakers and diarizer turns, takes the job slot, returns 202. | meetings.ts:1528-1566 |
| 3 | Diarize (ML, auto) | Runs unless `meeting_diarization_enabled` is "false" (default on), and only when `system.wav` exists. On failure: null, no labels, job continues. | meetings.ts:827-831 (gate), 851-861 (catch returns null), 1001-1004 (no labels when null); diarize.ts:54-61 (default on), 415-504 (`runDiarizer` returns null on each failure) |
| 4 | Segment (code) | Energy detector; merge toward 22.5 s, max 30 s. A mic chunk under 60 ms of voice is `empty` (no STT). | segmenter.ts:80-84 (22.5 s target), 1009 (`MIN_MIC_VOICED_MS` = 60); transcriber.ts:496-514 (silence skip) |
| 5 | Language and align gate | Picks mode `align`, `cut` or `plain`. | meetings.ts:463-504 |
| 6 | STT (ML, auto) | 2 lanes (mic, system). 3 attempts per chunk with backoff, then `failed`. | transcriber.ts:389-400, 516-517, 613-633 |
| 7 | Align or label | `align`: `runAlignPass` splits mixed chunks. Else `applyDiarization` labels segments. | meetings.ts:506-513, 586, 996-1003; diarize.ts:515 |
| 8 | Status `transcribed` | Writes `transcript.md`. Failed chunks do not fail the job. | meetings.ts:1006-1012 |
| 9 | Merge (code, each read) | Drift fix, hallucination and echo removal, confirmed names. Enhance and Summary read the merged text. | meetings.ts:253-308, 2082, 2114 |
| 10 | Enhance (LLM) | Auto after step 8 if `meeting_enhance_auto_run` is "true" (default off), else button. See 2.1.1. | enhance.ts:51-58; meetings.ts:1039-1045 |
| 11 | Name spelling (code) | Inside Enhance: fixes a name that matches one calendar attendee. | enhance.ts:641-651 |
| 12 | Summary (LLM) | Button only. See 2.1.2. | meetings.ts:2068-2095 |
| 13 | Audio sweep (code, daily) | Deletes `mic.wav` and `system.wav` of meetings older than `meeting_retention_days` (default 30) and sets `audio_dir` to NULL. Keeps all DB rows. Does not wait for a summary. | retention.ts:12-17, 34-61; daily-sweep.ts:22-28; validations/settings.ts:177; server/index.ts:216 |

#### 2.1.1 Enhance in detail

1. **Start.** Auto: the transcribe job frees its slot and starts `runEnhanceJob` (meetings.ts:1039-1045). Button: POST `/:id/enhance` holds the HTTP request open for the whole run; `/api/meetings` has no 30 s timeout (meetings.ts:2101-2141; server/index.ts:32-47, 91-95).
2. **Model.** Task `meetingEnhance`: reasoning off, temperature 0, timeout `meeting_enhance_timeout_seconds` (default 600 s) (task-profiles.ts:111-126, 154-166). Local server: see P14. UNVERIFIED: the owner's preset for `meetingEnhance`.
3. **Chunks.** Whole segments, 1200 tokens (length / 4), no overlap (enhance.ts:69, 189-217). Output budget: `ceil(chunkTokens * 2) + 200 + 150 * labels in the chunk`; a preset `max_tokens` can only raise it (enhance.ts:491-492; task-profiles.ts:395-405).
4. **Prompt.** System: correction contract, plus a speaker block when labels exist. User: the chunk in `<transcript>` tags. No attendee names (enhance-prompt.ts:29-51, 73-130; enhance.ts:99-104).
5. **Call.** Chunks run in order (enhance.ts:458-503), each under a background lane lease; the local lane limit is 1 (llm-call.ts:126-158; lane.ts:106, 189-196). `postProcess` calls `generateText` once, with no JSON mode (stt/post-process.ts:125-137).
6. **Parse.** `extractJsonObject` cuts the first "{" to the last "}" and runs `JSON.parse` (enhance.ts:232-246).
7. **Checks.** Corrections need a chunk id and a string value; unchanged text is dropped. A speaker label must exist; name max 80 characters, evidence max 240 (enhance.ts:528-582). The evidence guard drops a suggestion (enhance.ts:328-356) when: no quote; name not in the quote; quote in no chunk line; quote only in a "Me" line; quote in the label's own line but not a self-introduction.
8. **Across chunks.** One `nameProposals` map; the earlier chunk wins (map: enhance.ts:443-456; rule: enhance.ts:600-608). A failed chunk keeps its raw text and the loop goes on (enhance.ts:504-526).
9. **Write, once, after the loop.** One transaction updates `meeting_segments.enhanced_text` (enhance.ts:628-636). A second upserts `suggested_name`, `suggested_evidence`, `suggested_kind`, never `confirmed_at` (enhance.ts:652-672). `writeTranscriptMarkdown` rewrites `transcript.md` (and `transcript-enhanced.md` if a segment has enhanced text); auto calls it in `finally`, button after the 502 check (rewrite: meetings.ts:322-335; auto call in `finally`: meetings.ts:1139; button call: meetings.ts:2179-2180, after the 502 return at 2166-2175).
10. **Report.** Button: 502 (body: `reason`, `detail`) if a chunk ran, none succeeded and the user did not stop (meetings.ts:2150-2172); else 200 with `partial` and `stopped_early`; a stop after a failed chunk gives 200 with zero successes (meetings.ts:2183-2195). Auto: log lines only. Logs: when every chunk failed without a stop, the route logs one error (`log.error`, meetings.ts:2158-2160) and the auto-run job logs one warning (`log.warn`, meetings.ts:1103-1117, :1112); one warning per failed chunk (enhance.ts:508-510, 521-523); one "pass incomplete" warning (enhance.ts:675-682).

#### 2.1.2 Summary in detail

1. **Start.** Button: POST `/:id/summarize`; needs status `transcribed` or `summarized`; returns 202; the renderer polls GET `/:id` (meetings.ts:2068-2095; detail.tsx:122-127).
2. **Calls.** Lines: `label: enhanced text` (raw text if none) (summarize.ts:298-316). One call if the transcript fits the budget (summarize.ts:447-459). Else one map call per chunk plus one reduce call (summarize.ts:461-509). More than 24 calls fails the run before the first call (summarize.ts:468-475, 108). Budget default: 8000 tokens (summarize.ts:49, 365-369, 412-413 (`resolveContextBudget`); validations/settings.ts:185, 254-266).
3. **Limits.** Reasoning off, temperature 0, 4096 output tokens (task-profiles.ts:96-110). Call timeout 600 s (`meeting_summary_timeout_seconds`) (validations/settings.ts:320). Job deadline: between 2 calls and 4 hours (summarize.ts:147-154).
4. **Output.** The prompt asks for four markdown sections (summary-prompt.ts:12-26). No parse, no section check: `call` returns `response.text` as is (summarize.ts:433-442). Only the prose sanitizer and a guard in `postProcess` run (llm-call.ts:136, 172-173; stt/post-process.ts:139). The guard returns `model` null when `finishReason` is `length` or the cleaned text is empty, and llm-call.ts:159-163 then throws (stt/post-process.ts:148-163); it removes think blocks, wrapping quotes, trailing `<fin>` tags and a repeated final paragraph (text.ts:74-94).
5. **Write.** `INSERT OR REPLACE` into `meeting_summaries`, then status `summarized`. Tokens sum over calls. Provider and model come from the last call that reports one (summarize.ts:435-438); cost uses the last known price (summarize.ts:439, 512-515). Route write: meetings.ts:1213-1230.
6. **Failure.** A throw or the deadline ends the run before the INSERT; the catch writes no row and sets in-memory text ("Cancelled by user" or the error message) (meetings.ts:1187-1245).

#### 2.1.3 Job and status model

Tables and retention: 7.1. Status values: `recording`, `interrupted`, `recorded`, `transcribing`, `transcribed`, `summarized`, `failed`; Enhance never changes the status (schema.ts:766-769; meetings.ts:1073-1076). Job kinds, one slot per meeting: `transcribe`, `retry-failed`, `diarize`, `summarize`, `enhance` (job-registry.ts:39-62).

#### 2.1.4 LLM call stack

Lane and queue: 3.5. Finish reason and retry: P3, P4, P12. `defaultChatCallFor` adds task id and cancel seams (llm-call.ts:69-83). `resolveTaskCall` returns `provider`, `modelId`, `temperature`, `topP?`, `maxOutputTokens`, `reasoningEnabled`, `samplingParams`, `timeoutMs` (task-profiles.ts:166-175, 314-409).

---

### 2.2 Flowchart of today's Enhance and Summary path

Red nodes mark a failure path. The dotted edge: the user starts Summary later by button.

```mermaid
flowchart TD
  B["Transcribed"] --> C{"meeting_enhance_auto_run<br/>is true?"}
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
    S0 --> S1{"Within budget<br/>(8000 tokens)?"}
    S1 -->|yes| S2["One call"]
    S1 -->|no| S3["Map per chunk,<br/>one reduce"]
    S2 --> S4["Free markdown saved as is"]
    S3 --> S4
    S2 & S3 -.->|any throw| S5["Job fails, nothing saved"]
  end
  S4 --> S6["INSERT OR REPLACE meeting_summaries<br/>status: summarized"]
  classDef bad stroke:#c0392b,stroke-width:2px;
  class X,Y,Z,O,S5 bad;
```

---

### 2.3 Problems

#### P1. One call does two jobs, and a long answer loses both (Enhance)

- One prompt asks for corrections and a `speakers` object in one JSON answer, built once with the labels of the whole meeting (corrections contract: enhance-prompt.ts:16-26, no `speakers` object; `speakers` request: `buildSpeakerSuggestionBlock`, enhance-prompt.ts:73-111, JSON at 103-105, only when `speakerLabels` is not empty, line 78; build: enhance.ts:413-430). One output budget covers both (2.1.1 step 3).
- Issue #163 (8 chunks, local oMLX, Qwen3.8-27B): two chunks ended with `length` at 3168 and 3716 output tokens; one returned invalid JSON (long reasoning in `evidence`). Corrections were lost (https://github.com/Maheidem/openstyle/issues/163). Numbers come from the issue text; spread over other meetings and models is UNVERIFIED.

#### P2. The JSON contract exists only as prompt text (Enhance)

- No LLM code path uses `json_schema`, `response_format`, `generateObject`, `Output.object` or tools. `response_format` appears only in two STT form fields (providers/server.ts:71; whisper-local.ts:68). Tool keys are on the preset denylist (llm-task-profiles.ts:199-206).
- Parser: 2.1.1 step 6. Manual `typeof` checks validate the result; no zod schema exists (enhance.ts:529-582).

#### P3. Only `length` is detected, and the code labels it `provider` (Enhance and Summary)

- `postProcess` discards the text when `finishReason === "length"` or the text is empty; `resolveDefaultChatCall` throws (stt/post-process.ts:148-159; llm-call.ts:159-163). `EnhanceFailureReason` has no `length` value, so `length` becomes `provider`; "finishReason: length" survives only in `detail` (200 characters) (enhance.ts:140, 156-170).
- The renderer reads only `body.reason` (detail.tsx:364-375, :366); the generic error notice stays hidden while `enhanceFailure` is set (detail.tsx:719-721). Summary: the reduce call once ended with `length` and failed the job (summarize.ts:56-69).

#### P4. Every other finish reason passes as success (Enhance and Summary)

- The AI SDK has six finish reasons plus `rawFinishReason` (index.d.ts:108, 907-911 UNVERIFIED: the `ai` package is not installed locally; https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text lists the six values and `rawFinishReason`). `postProcess` checks only `length` and empty text; `content-filter`, `error` or `other` with text passes as success (stt/post-process.ts:148, 162-167).
- `ChatCallResponse` has no finish reason field (llm-call.ts:46-55). A grep over `apps/server/src`, `packages/stt/src` and `apps/electron/src` finds no read of `rawFinishReason`. A leaked `<think>` block is cut silently (text.ts:74-87).

#### P5. No retry: Enhance skips the chunk, Summary drops the whole run (Enhance and Summary)

- Enhance: a failed chunk is skipped (2.1.1 step 8). Issue #163 says the runs are deterministic, so a plain retry does not help.
- Summary: `call` has no `catch` and `summarizeMeeting` no `try`, so a throw loses the finished map outputs and writes no row (summarize.ts:476-497; 2.1.2 step 6).
- STT chunks get 3 attempts (2.1 step 6); LLM calls get none from the app. Planned answer, decided 2026-10-17 (owner decision Q9): `callUnit` is the single retry layer, one retry per call under the `gatewayRetryOn` rule; no node `RetryPolicy`; AI SDK `maxRetries` is 0 (5.6).

#### P6. A failed chunk 0 loses all speaker names (Enhance)

- A chunk has no state from earlier chunks. The evidence guard checks a quote against its own chunk only (enhance.ts:189-196, 293-306).
- Issue #163: chunk 0 held the only grounded self-introduction. After it failed, the guard dropped all 16 suggestions of chunks 1 to 7. Drop reasons reach the debug log only (enhance.ts:594-599).

#### P7. Failures are hard to see (Enhance)

- Auto: all-chunk failure, any other throw and partial failure reach only the log (2.1.1 step 10). Enhance never fills `job_error`: `runEnhanceJob` never calls `setJobFailure` (meetings.ts:1078-1142). Only the Summarize catch calls it (meetings.ts:1240). Setter: job-registry.ts:142; `GET /:id` reads it at meetings.ts:2250.
- Button: the page keeps `reason` in React state, shows one of three texts, drops `detail`; a reload clears it. A partial run shows chunk counts with no cause (detail.tsx:87-89, 742-754).
- One variable keeps the first failure of any kind (`??=`), so an early parse failure hides a later call failure (enhance.ts:433-438, 507, 517).

#### P8. The summary is free markdown (Summary)

- No parse and no schema check (2.1.2 step 4). The result goes into one `markdown` column (meetings.ts:1213-1227; schema.ts:790-799). A decision or action item has no field that code can read.
- Planned answer: the model returns a schema object and code reads its fields to render the Markdown (4.5.1, 4.5.6). Code stores the object in the new column `meeting_summaries.summary_json` (migration 40, written by the save step), so later code reads decisions and action items as data. The call record keeps the same object in `llm_calls.parsed_json`. Decided 2026-10-17 (owner decision Q12): store it in `summary_json` (4.5.6, 7.4). The Summary tab keeps using `markdown`.

#### P9. Jobs live in memory only (Enhance and Summary)

- The registry and `job_error` are in memory and lost at restart (job-registry.ts:9-10, 64-73). The status list has no Enhance value (2.1.3). GET `/orphans` lists only `recording` or `transcribing` rows (meetings.ts:1349-1367).
- Both write only at the end of the run (2.1.1 step 9; Summary: meetings.ts:1153-1157). A restart mid-run leaves no row and no marker.

#### P10. No record of any call (Enhance and Summary)

- The database stores no prompt, parameters, raw answer, finish reason, latency or retry count. `ChatCallResponse` hands the caller only text, tokens, provider, model and pricing (llm-call.ts:46-55). A trace log file holds the request body, raw answer, `finish_reason`, `usage` and `elapsed_ms`, only for the `server` provider (trace.ts:206-240 writes `status`, `summary` with `finish_reason` and `usage`, `elapsed_ms` and `body`; llm/registry.ts:156-169, 271 limit it to the `server` provider); no row links it to a meeting (P11). No retry counter exists (a grep for "retr" and "attempt" finds only `chunksAttempted`). The summary row holds summed tokens, the last provider and model, and a cost (schema.ts:790-799). Enhance stores no model, tokens or cost (enhance.ts:628-672).
- `enhanced_text` NULL means "not enhanced" or "unchanged"; a failed chunk looks like an accepted one. No column links a correction to a call (schema.ts:835-837). A speaker suggestion stores name, evidence and kind only (enhance.ts:658-672).

#### P11. The trace log covers one provider and has no meeting id (Enhance and Summary)

- Only the `server` provider is traced (`traceLlmFetch` inside `createSamplingFetch`, llm/registry.ts:156-169; only the `server` entry uses it, llm/registry.ts:245-275, fetch at :271). OpenAI, Anthropic, Google, Mistral, OpenRouter and Vercel use no custom fetch (llm/registry.ts:172-240); Groq uses a keep-alive fetch with no trace (groq-http.ts:7-8, 31).
- The log has full bodies, `finish_reason` and `usage` (summary with `finish_reason` and `usage`: trace.ts:184-204; full body: trace.ts:240, request body :273). Each entry id is a random 8-character code per HTTP request, with no meeting id or step name (trace.ts:132-137).
- UNVERIFIED: whether a background job keeps the request id (`AsyncLocalStorage`, job started with `void`).

#### P12. The AI SDK retries twice, and nothing records it (Enhance and Summary)

- `generateText` has a default `maxRetries` of 2; the first wait is 2 s and doubles (index.mjs:2653-2655, 2700, 2739 UNVERIFIED: the `ai` source is not installed locally; https://ai-sdk.dev/docs/ai-sdk-core/settings confirms only the default `maxRetries` of 2, not the wait). `postProcess` sets none.
- The SDK retries a retryable error, never an abort (index.mjs:2672, 2688 UNVERIFIED: the `ai` source is not installed locally). One call can send 3 requests in one lane slot and one timeout (llm-call.ts:126-158). No log line or row counts them. For `server`, the trace log should show each request as an entry (trace.ts:257-304; UNVERIFIED by a live run).

#### P13. Token and model data lose facts (Enhance and Summary)

- Code reads only `inputTokens` and `outputTokens` (stt/post-process.ts:157-158). The SDK also reports `usage.outputTokenDetails.reasoningTokens` (index.d.ts:296-304 UNVERIFIED: the `ai` types are not installed locally); nothing reads it (a repo grep for `reasoningTokens` and `outputTokenDetails` finds no hit).
- Reasoning shares the output budget (enhance.ts:484-490). The only measure is a comment, "~300-400 tokens of chain-of-thought per call" (summarize.ts:56-59). UNVERIFIED: the method.
- `ChatCallResponse.model` is documented as the serving model (llm-call.ts:50-52), but code sets it to the app-resolved `resolved.modelId` (llm-call.ts:177; task-profiles.ts:270-304 only picks `provider` and `modelId`). Nothing reads `response.modelId`. Another serving model leaves a wrong name in the summary row.

#### P14. Reasoning parameters go out for Groq and local servers only (Enhance and Summary)

- A local server gets `chat_template_kwargs.enable_thinking` set to `profile.reasoningEnabled` (false in the default profiles, task-profiles.ts:84-113); other providers get an empty object. Preset keys go into the body last and win (task-profiles.ts:358-369; llm/registry.ts:125 spreads sampling last).
- Only Groq defines `providerOptions` (`reasoningEffort`, two model families). OpenAI, Anthropic, Google, Mistral, OpenRouter and Vercel get no reasoning option (Groq: llm/registry.ts:72-97, 186-187; the six others define none: llm/registry.ts:172-240).

#### Which later section answers which problem

| Problem | Sections (planned answer) |
|---|---|
| P1, P6 | 3, 4 (separate steps for corrections and speakers) |
| P2, P8 | 4, 5, 7 (one fixed schema per LLM step; 5.3.5, 5.4; `summary_json` and call record, 4.5.6, 7.4) |
| P3, P4, P5 | 4, 5 (typed stop reasons; `callUnit` single retry layer) |
| P7 | 3, 4, 7, 8 (typed failure per step, visible in UI) |
| P9 | 3, 7 (durable `llm_runs`; boot sweep 3.4.7) |
| P10, P13 | 5, 7, 8 (`llm_calls`; meeting inspector) |
| P11 | 9 |
| P12, P14 | 5, 6 (gateway in `apps/server/src/lib/llm/`, AI SDK v7) |

---

## 3. Target architecture

Owns: components, graph, state, run lifecycle, concurrency, summary placement. Nodes: 4. Gateway: 5. Tables: 7. Inspector: 8. Tracing: 9.

**Keys.** `S`=`apps/server/src`, `E`=`apps/electron/src`, `V`=`packages/validations/src`, `W`=`S/lib/meetings/workflow` (new), `G`=`S/lib/llm`, `GW`=`S/lib/llm/workflow` (new; generic platform layer, Q16). Other paths exist on `main` at c47cd80d. Cite aliases: `R`=`S/routes/meetings.ts`, `J`=`S/lib/meetings/job-registry.ts`, `L`=`S/lib/llm/lane.ts`, `C`=`S/lib/meetings/llm-call.ts`, `N`=`S/lib/meetings/enhance.ts`, `P`=`E/renderer/src/pages/meetings/detail.tsx`. The alias list is the Keys paragraph of `specs/meeting-enhance-agentic.md:369`; it is not a code line. URL aliases: `LG:`=https://github.com/langchain-ai/langgraphjs/blob/cc29753d529caa5eed97a65e765ba26c0f88c631/libs/langgraph-core/src/ and `LD:`=https://docs.langchain.com/oss/javascript/langgraph/.

**Terms** (others: 1.4). **Stage**: `enhance` or `summarize`. **Run context**: the in-memory object (cancel signal, progress counters) the runner gives to the nodes; it is not graph state. **Soft cancel**: a cancel that lets the graph reach `save` (3.4.5).

**Decisions.** (1) One graph, six nodes; one run is one execution (3.2). (2) State holds inputs and typed results; the recorder holds prompts and raw answers (3.3). (3) A start returns 202 for the button and the auto-run (3.4.2). (4) A durable run row sits beside the in-memory job; only the runner writes run status (3.4). (5) Cancel is cooperative and reaches `save`; a hard stop is the fallback (3.4.5). (6) A boot sweep marks orphan runs; a run resumes once by itself (3.4.7). (7) The LLM lane is the only throttle; fan-out cap 3 (3.5). (8) Summary joins the graph through a stage list; the Enhance button and the auto-run chain Summarize into one run (3.6). (9) Every LLM call goes through `callUnit`, the one retry layer; a unit is the retry boundary; the gateway never loops (3.2, 5.6). (10) Domain-agnostic parts live in `G` and `GW`; rows carry `scope` and `scope_id` (3.1, 3.4.3). (11) No feature flag; WP5b replaces the old path after council consensus (3.1, 3.4.2).

---

### 3.1 Components and files

Table 3. New parts. All files are new unless marked "edit". If a name differs from sections 7 and 8, the register in 11.4 decides.

| Part | Files | Rule |
|---|---|---|
| Graph | `W/graph.ts` (`buildGraph(deps)`), `state.ts`, `types.ts` (section 4; `foldStatus`, `deriveRunStatus`, `SaveResult`), `context.ts` (`RunContext`, `WorkflowDeps`, `productionDeps`), `unit.ts` (`guardNode`, `runStep`: 4.0.2), `summary-pure.ts` (4.5.3, 4.5.6; WP5a), `load-graph.ts` (`loadGraph(deps)`), `nodes/{prepare,correct-chunk,identify-speakers,verify-evidence,summarize,save}.ts` (each exports `make<Node>Node(deps)`), `schemas.ts` (WP3), `prompts.ts` (WP5a `correctChunk`, `identifySpeakers`; WP6 `summarize`) | Only `W` and `GW` import LangGraph, and only below the dynamic load of `load-graph.ts` (rule 2; section 12). `prompts.ts` imports nothing from the old prompt files. |
| Gateway, profiles | `G/gateway.ts` (also `probeEndpoint`, 5.7), `gateway-errors.ts`, `model-profiles.ts` | One structured LLM call (section 5). No LangGraph import. Today `S/lib/llm/task-profiles.ts` holds the task profile record (`:81`), `resolveTaskCall` (`:314`) and the related types (`:39`, `:166`, `:182`); no other profile kind exists. |
| Call layer | `G/call-unit.ts` (`callUnit`, `gatewayRetryOn`, `CallUnitDeps`, `UnitContext`: 5.6) | The one retry layer (Q9). No meeting code, no LangGraph. `WorkflowDeps` extends `CallUnitDeps`; `RunContext` extends `UnitContext`. |
| Recorder | `G/call-record.ts` (WP2), `G/recorder.ts` (7.7), `S/lib/meetings/llm-record.ts`, `G/record-read.ts` (8.3), `S/lib/meetings/llm-record-read.ts` (7.8), `S/lib/meetings/input-hash.ts` (4.1 P11) | The only writer of `llm_runs`, `llm_run_steps`, `llm_calls`, `llm_call_links`. Scope-generic (3.4.3). |
| Saver | `GW/checkpoint-saver.ts`; `GW/env-guard.ts` (`stripTracingEnv`) | `NodeSqliteSaver`, a `BaseCheckpointSaver` on `node:sqlite` (D6, section 7). Keys on a thread id. |
| Registries | `GW/run-registry.ts` (WP5b); `GW/run-context-registry.ts` (WP5a): `createRunContextRegistry<C>()` with `register`, `get`, `drop`, `size` | Run registry: claims and cancel controllers by `scope` and `scope_id`; `J` keeps the meeting job slot and progress blob (3.4.1). Context registry: run id to `RunContext`, never job claims; `W/context.ts` makes `runContexts`. WP5a owns it, so `productionDeps()` needs no WP5b file. |
| Test harness | `apps/server/tests/helpers/workflow-harness.ts` (WP5a); `meeting-fixture.ts` (WP3) | `makeTestRunContext`, `makeTestDeps`, `instantSleep`, `makeFakeRecorder`, `runScriptedGraph` (10.2 rules 1, 9). WP5b and WP6 import, do not edit. |
| Runner | `W/runner.ts` (`startRun`, `resumeRun`, `sweepOrphanRuns`, `resumeInterruptedRuns`) | No route writes a run status. The runner calls the recorder. |
| API, UI | `S/routes/meetings-runs.ts` (resume, run list, inspector routes); edit `R`, `S/routes/index.ts`, `V/meeting-types.ts`; `E/renderer/src/pages/meetings/{llm-inspector,llm-call-view}.tsx`, `llm-inspector-model.ts` (WP7), `run-notice.ts` (WP5b), edit `P` | A third sibling router keeps the 2288-line `R` from growing (`S/routes/index.ts:47-48`); the client already reads a sibling router (`E/renderer/src/pages/pill/use-dictation-session.ts:191`). Files of 8.11 decide. |

Other files that change:

- `J`: `claimJob` takes an optional `AbortController`; `requestCancel` aborts it; `releaseJob` drops it; new `setJobKind` changes the kind at the stage change of a chained run (3.6). None has a controller today (J:81-90, J:93-97, J:131-136).
- `L`: `withLlmLane` (L:506-519) accepts `signal`. Its option type is a `Pick` of `AcquireLlmLaneArgs` that omits `signal` (L:509) and is spread into `acquireLlmLane` (L:513). `AcquireLlmLaneArgs` has `signal` (L:83); `acquireLlmLane` stops a queued call on abort (L:457-462; the `cancelled()` test is at L:404-413, a pre-queue check at L:426).
- New `S/lib/meetings/transcript-io.ts` takes `loadMergedTranscript`, `writeTranscriptMarkdown`, `attendeeNamesOf` from `R` (R:253, R:322, R:1264), because the runner cannot import a route file. WP5a moves them; `R` imports them back (11.4).
- `R`: both start routes and the auto-run handoff (R:1039-1045) call `startRun`. WP5b deletes `runEnhanceJob` (R:1078-1142) and `runSummarizeJob` (R:1159-1250) in the same PR (Q1). `GET /:id` keeps `job`; WP5b removes `job_error` and its writer (3.4.6 step 6). The renderer reads runs from `llm-runs` (8.3).
- `S/index.ts`: `sweepOrphanRuns()` before `serve()`, `resumeInterruptedRuns()` after the server listens (planned; today `sweepStaleWhisperServer()` at :211, `serve()` at :226-236).
- `S/lib/meetings/{enhance,summarize,llm-call}.ts`: nodes import only `chunkForEnhance` (`N:197`), `chunkTranscript` (`S/lib/meetings/summarize.ts:323`), `estimateTokens` (`C:24`); WP5b first moves them into one `W/` file (11.5). The old prompt files ask for JSON text and Markdown sections, which conflict with the schemas (4.2.2, 4.5.2). `enhanceMeetingTranscript`, `summarizeMeeting`, `llm-call.ts` and both prompt files retire in WP5b, because the knip gate fails on an unused file (`AGENTS.md:85`). The council must reach consensus before the WP5b merge (D12, amended 2026-10-17; 11.5).
- Migration 40 (section 7): adds `meeting_summaries.summary_json` (Q12) and the scope columns (3.4.3), drops the Remix tables and settings rows (7.3, 11.8 row 21). It is a new step after the step 39 block and before the version upsert (`S/lib/schema.ts:1007-1009`); `SCHEMA_VERSION` goes from 39 to 40 (`S/lib/schema.ts:14`). New `S/lib/llm/tracing.ts` (D8, section 9).

**Layout rules.** (1) Generic LLM code goes in `G` and `GW`, meeting code in `S/lib/meetings`, LangGraph imports in `W` and `GW` only (10.8 GR2, GR3). (2) `W/load-graph.ts` calls `stripTracingEnv()` (deletes the four tracing variables), then loads `W/graph.ts` with a dynamic `import()` on the first run, as the call helper does for providers (C:4-6, C:95-100). `W/graph.ts` and modules below it (`state.ts`, `GW/checkpoint-saver.ts`) may import LangGraph statically. The runner and nodes import them as types only. No static import path from `S/index.ts` reaches `@langchain/*` (GR2), so a bundling fault breaks Enhance only. (3) The gateway never imports from `W`. (4) Dictation stays off the gateway; D7 moves its AI SDK version only. The Remix removal work package deletes Remix and the Remix agent (decided 2026-10-17). (5) A later consumer builds on `G` and `GW` with its own `scope` string and runner, and adds no meeting code to them.

**Privacy guard.** The server inherits the app environment (`E/main/server-host.ts:203-206`). LangChain turns tracing on when `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING` or `LANGCHAIN_TRACING` equals `true` ([source](https://github.com/langchain-ai/langchainjs/blob/84eca2b11c0900a67775dca258ebec04f8e852a2/libs/langchain-core/src/utils/callbacks.ts#L3-L14), `main` on 2026-10-17), and LangGraph can then send run data to LangSmith ([docs](https://docs.langchain.com/langsmith/trace-with-langgraph)). The app promises no telemetry (`AGENTS.md:9`). So `GW/env-guard.ts` deletes those four variables from `process.env` before the dynamic import (GR3). UNVERIFIED for `@langchain/core` 1.2.18 (U6).

**Dependencies** (server package; exact versions, MIT, checked 2026-10-17): `@langchain/langgraph` 1.5.1 ([npm](https://registry.npmjs.org/@langchain/langgraph/latest); peers `@langchain/core ^1.1.48`, `zod ^3.25.32 \|\| ^4.2.0`; repo zod `^4.4.3`, `pnpm-workspace.yaml:25`), `@langchain/core` 1.2.18 ([npm](https://registry.npmjs.org/@langchain/core/latest)), `@langchain/langgraph-checkpoint` 1.2.0 ([npm](https://registry.npmjs.org/@langchain/langgraph-checkpoint/latest)) and, as `devDependency`, `@langchain/langgraph-checkpoint-validation` 1.2.0 (D6; [npm](https://registry.npmjs.org/@langchain/langgraph-checkpoint-validation/latest) gives the version only; no `package.json` in this checkout lists it yet, so its use is planned, not current), which needs `vitest ^4.1.11` while the repo has `^4.1.7` (`pnpm-workspace.yaml:24`): UNVERIFIED together; WP4 fallback: bump the catalog line (11.5). The Electron build inlines these packages (`externalizeDeps` false, `apps/electron/electron.vite.config.ts:75`) and the app ships no `node_modules` (`AGENTS.md:87`): UNVERIFIED (U1). No fixed size limit (Q6); each PR measures `du -sk apps/electron/out` and, at release, the asar size, and reports the growth.

---

### 3.2 The workflow graph

Figure 1. Solid arrow: normal edge. Dotted arrow: cancel or stop edge. Blue node: calls an LLM. Grey node: code.

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

The 11 Mermaid blocks of the first draft passed `mmdc` 11.12.0 on 2026-10-17. Later edits (this figure, the graph in 11.3) were not re-run (UNVERIFIED by `mmdc`). The coordinator runs `mmdc` on all 11 blocks before the spec merges.

**Edge rules.**

1. **Entry.** After `prepare`, a router reads `stages`. If it holds `enhance`, it returns one `Send("correctChunk", input)` for each chunk (`LD:use-graph-api`). If it is `["summarize"]`, it returns `"summarize"`.
2. **Barrier and order.** A sequential node starts in the next super-step (`LD:graph-api`), so `identifySpeakers` starts after every `correctChunk` task ends. It does not read the corrections (4.3.2) and a local endpoint runs one call at a time (3.5), so a parallel branch gains nothing.
3. **After `verifyEvidence`.** Return `"save"` when the run is cancelled or stopped (rule 4). Otherwise return `"summarize"` if `stages` holds `summarize`, else `"save"`. The router ignores the status of `correctChunk` and `identifySpeakers`, so `summarize` runs even when one failed and uses the stored or raw text (4.5).
4. **Cancel and stop.** After every node a router calls `ctx.isCancelled()` and `ctx.isStopped()`. If either is true, it returns `"save"`. A cancelled pass keeps its finished chunks (R:1073-1076, N:459-470). `isStopped()` is true after a run-wide failure or the failure breaker (3.4.5).
5. **A failed unit is not an edge.** A node turns a final failed call into a typed result (4.0.2, 5.6 rule 2). `guardNode` turns any other node fault into a typed `internal` failure, and the graph goes to `save`. Two faults end the run: a fault of `prepare` and a fault of the checkpoint saver (3.4.6). Failure of each node: 4.1 to 4.6.
6. **No cycle.** The longest path has six nodes. The default recursion limit is 25 super-steps (`LD:graph-api`). The length route of section 4 runs inside a node.
7. **No node retry policy.** A unit is the retry boundary (5.6, X7). No node sets `retryPolicy` or `timeout`; LangGraph does not retry without a policy (`LD:fault-tolerance`). Its default `retryOn` reads `status`, not the AI SDK `statusCode` (`LG:pregel/retry.ts#L28-L58`), so the custom `retryOn` of D5 is `gatewayRetryOn`, run per unit by `callUnit` (Q9). A node `timeout` would count the lane wait (3.5 rule 4). Each LLM node sets an `errorHandler` (LangGraph 1.4.0 and later, `LD:fault-tolerance`) as a backstop for what `guardNode` misses: it records a typed `internal` failure and returns `Command({ goto: "save" })` (UNVERIFIED, U11).
8. **Fallback if the WP4 spike fails.** The design rests on five LangGraph facts (U2, U3, U9, U10, U11), tested by the WP4 spike on the real saver (11.5). If one is false, WP4 does not merge until this section is amended. The fallback has no `Send` fan-out and no node `errorHandler`. (a) `correctChunk` is one node: it reads the chunk list from `prepared`, loops over chunks in order and calls `callUnit` for each. After a kill, `invoke(null, config)` enters the node again and `callUnit` reuses each finished call by key from `llm_calls` (`finishedCall`, 5.6), so a finished chunk sends 0 requests. (b) `guardNode` is the only fault handler (4.0.2). (c) If the loop runs chunks in parallel, `WORKFLOW_FANOUT_CAP` becomes a counter inside the node. (d) `identifySpeakers` and `summarize` stay as they are. Mapping: U2 or U10 false: (a) and (b) in full. U3 false: keep `Send`, add the counter of (c). U11 false: (b) only. U9 false: use the export names of the installed package. Cost of (a): no parallel chunks for a cloud provider; a resume re-enters the node.

---

### 3.3 Graph state

The state holds run inputs and typed node results (validated node output). It never holds a prompt or a raw response; the recorder keeps those (D10).

```ts
// W/state.ts. Working shape. Section 4 owns the result types. Not compiled.
import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type {
  CorrectChunkResult, IdentifySpeakersResult, PreparedMeeting,
  ResolvedModels, // section 5
  SaveResult, // 4.6
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

`ReducedValue` takes the value schema and an object with `reducer` and optional `inputSchema` (`LG:state/values/reduced.ts#L155-L169`). `StateSchema` is the documented form (`LD:use-graph-api`). The snippet is not compiled (U9).

**Checkpoint.** `prepared` dominates: raw text of every segment (4.1), about 190 KB for 4 hours (7.11). `models` holds no API key. A checkpoint lives while its run is `running` or `interrupted`; the runner deletes the thread at a final status (3.4.6).

**Why `prepared` is in the state.** A `Send` branch receives its payload as the input of the target node (`LD:graph-api`; `LG:pregel/algo.ts#L943-L945`). The docs do not say that graph state is withheld; the claim rests on that source line (UNVERIFIED by a run). So the router puts one chunk into `CorrectChunkInput`: `runId`, `chunkIndex`, the chunk segments, the language, the vocabulary terms and the `correctChunk` entry of `models`. It is a slice of `PreparedMeeting` (4.2, X1). The checkpoint probably also holds the 40 payloads, about 190 KB more (UNVERIFIED, U10). Rejected: ids only with each branch reloading the transcript (`loadMergedTranscript` is heavy, R:253-308; a resume could see another transcript).

**Changed transcript.** A re-transcribe deletes all segments (R:1546-1558) and new segments reuse the id format `<meeting>:<source>:<idx>` (R:420). So `prepare` stores `inputHash` (4.1 P11) and a resume compares it with a fresh hash (3.4.7).

**Reducer rule.** A reducer must give the same state for a repeated write; `mergeByChunkIndex` keys on the chunk index. LangGraph skips a finished task after a resume (`LD:checkpointers`): saved writes go back to finished tasks (`LG:pregel/loop.ts#L1362-L1363`, `#L2355-L2379`) and the runner starts only tasks without writes (`LG:pregel/runner.ts#L137`). A resume with only a `thread_id` names no `checkpoint_id`, so it is not a time travel and keeps `skipDoneTasks` on (`LG:pregel/loop.ts#L798-L801`, `#L1669-L1671`).

---

### 3.4 Run lifecycle

#### 3.4.1 Two registries

The job registry stays: an in-memory `Map` (J:53), one slot for each meeting (J:81-90), live progress (J:13-30) and the cancel flag, a separate `cancellations` Set (J:58-62). The run records (recorder tables, 7.7) are new SQLite rows, many for one meeting, for history, resume and the final result. A `running` run holds one job; an `interrupted` run holds none.

#### 3.4.2 Start

The routes keep their guards and messages. Unknown id: 404. Wrong status, running job or empty transcript: 409 (R:2070-2085, R:2103-2117). `startRun({ meetingId, stages, trigger })` has a synchronous part with no `await`, so no request can slip between the check and the claim. `startRun` does not exist at c47cd80d (UNVERIFIED as built); the precedents are `claimJob` (J:7-9) and the enhance route (R:2118-2124).

1. `claimJob(meetingId, kind, progress, controller)` takes the slot. Kind is `enhance` if `stages` holds `enhance`, else `summarize`. A `false` result gives 409.
2. The recorder (`startRun`, 7.7) inserts the run row with status `running`, `scope` `meeting`, and `scope_id` and `meeting_id` set to the meeting id, in one transaction. The same transaction marks older `interrupted` rows of the same stages as `cancelled` and deletes their checkpoints (the screen offers Resume first, 8.9). A foreign key failure means the meeting is gone: recorder `startRun` returns `no_scope` (7.7), the runner releases the job and the route answers 404.
3. `void execute(runId, "start")` runs the graph in the background. `execute` never throws: its whole body, including the first database call, sits in one `try`, and the `finally` releases the job. (`runSummarizeJob` calls `getDb()` before its `try`, R:1164, R:1169.)
4. The route answers 202.

`prepare` loads language, vocabulary, title, context and attendee names itself, so a start needs only the meeting id and the stages. The auto-run handoff calls `startRun` where it calls `runEnhanceJob` today (R:1039-1045).

`execute` calls `graph.invoke(input, config)` with `configurable: { thread_id: runId }`, `durability: "sync"` (the default `"async"` can lose the last checkpoint in a crash; `LD:checkpointers`), `maxConcurrency: WORKFLOW_FANOUT_CAP` (3.5) and `signal`, the hard-stop signal (3.4.5). The runner calls `runContexts.register(ctx)` before `invoke` and `runContexts.drop(runId)` in the `finally` (3.4.6 step 7). Nodes find the context through `deps.getRunContext(runId)`. A resume registers a new context. A live script of WP5a or WP6 has no runner: it calls `runContexts.register(makeTestRunContext(...))` (10.2 rule 9) before `invoke`.

**Injection seams.** Every effect that a test must replace sits in `WorkflowDeps`. `buildGraph(deps)`, each node factory, `callUnit` (5.6) and the runner take it. Production builds it once with `productionDeps()`. A test replaces only the fields it needs. No module-level `recorder` or `sleep` exists.

```ts
// W/context.ts (WP5a). Working shape. Not compiled.
export interface WorkflowDeps extends CallUnitDeps { // `recorder`, `callStructured`, `createModel`, `sleep` repeat or narrow CallUnitDeps members (5.6)
  db: DatabaseSync;                    // `getDb()` in production (`S/lib/db.ts:14`); `withTransaction(db, fn)` (`S/lib/db.ts:61`). Saver, recorder and `save` do not exist at c47cd80d
  recorder: LlmRecorder;               // 7.7. Also the CallSink of every call (5.1)
  callStructured: <T>(i: CallStructuredInput<T>) => Promise<CallStructuredResult<T>>; // 5.1. Node tests use a fake (10.2 rule 2)
  createModel?: CreateModel;           // gateway seam (5.1). Unset in production: `createChatModel`. A scripted `MockLanguageModelV4` enters here
  sleep: (ms: number, signal: AbortSignal) => Promise<void>; // retry wait of `callUnit` (5.6). Rejects with `CancelledError` on abort. Tests pass an instant `sleep` (10.2 rule 4)
  now: () => number;                   // epoch ms. `Date.now` in production
  loadTranscript: typeof loadMergedTranscript; // `S/lib/meetings/transcript-io.ts` (3.1). `prepare` calls it
  getRunContext: (runId: string) => RunContext; // `runContexts.get` in production. Throws when none exists
  probeEndpoint: (p: CallProfile) => Promise<boolean>; // `gateway.ts` (5.7). Called before a boot resume (3.4.7)
  reasoningSteps?: ReasoningSteps;     // test hook of 5.5 rule 4. `prepare` passes it to `resolveModels`
}
export declare function productionDeps(): WorkflowDeps;
export declare const runContexts: RunContextRegistry<RunContext>; // via `createRunContextRegistry`. The only module-level state of the workflow. A test uses its own registry (`makeTestDeps`, 10.2 rule 9)
// W/graph.ts: export declare function buildGraph(deps: WorkflowDeps): CompiledWorkflow; compiles with `new NodeSqliteSaver(deps.db)`.
// W/load-graph.ts: export declare function loadGraph(deps: WorkflowDeps): Promise<CompiledWorkflow>; removes the four variables (3.1 rule 2), then calls `buildGraph`.

export interface RunContext extends UnitContext { // `signal` and `isStopped()` are UnitContext members (5.6)
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
  onNodeStart(node: NodeId): void; // `guardNode` calls it first for every node run (4.0.2), before the step row opens. Must not throw, be quick, be idempotent. The runner calls `setJobKind(meetingId, "summarize")` for `summarize` (3.6 item 4)
}
```

HTTP contract.

| Request | Answer |
|---|---|
| `POST /api/meetings/:id/enhance` | 202 `StartRunResponse`, `stages = ["enhance", "summarize"]` (3.6). Today it holds the request open for the whole pass (R:2101-2206). |
| `POST /api/meetings/:id/summarize` | 202 `StartRunResponse`, `stages = ["summarize"]`. Same 202 and polling as today (R:2068-2095). |
| `POST /api/meetings/:id/runs/:runId/resume` | 202 `StartRunResponse` (`runId` is the resumed run). 404 for an unknown meeting or run. 409 `ResumeConflict` when a guard fails (3.4.7). The Resume button calls it (8.9). |
| `POST /api/meetings/:id/cancel-transcribe` | Unchanged. It cancels a run through `requestCancel` (R:1576-1591). |
| `GET /api/meetings/:id` | `job` stays. `job_error` goes in WP5b (3.4.6 step 6). The renderer reads runs from `GET /:id/llm-runs?latest=1` (8.3; X4). |

```ts
// V/meeting-types.ts (types only, 8.4). WP5b adds both. Every other error body stays { error: string } (R:2070-2085, R:2103-2117).
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

The reason list is closed: one value per guard of 3.4.7, in guard order. The renderer shows `error` for guards 1, 2, 3 and 5. For guards 4 and 6 the run row is `failed` and the notice reads its `errorKind` (8.9). The old 200 and 502 answers of `POST /:id/enhance` (R:2101-2206) go in WP5b with the renderer change in the same PR (Q1).

#### 3.4.3 Run row and status

The run row (working names; section 7 owns the DDL): `id` (UUID, equals the LangGraph `thread_id`), `scope` (`meeting` for the first consumer), `scope_id` (the meeting id), `meeting_id` (nullable foreign key to `meetings`, `ON DELETE CASCADE`, D10; set when `scope` is `meeting`), `stages` (JSON list), `trigger` (`button` or `auto`: the first trigger for the life of the run; a resume never changes it and adds one to `resume_count`), `status` (`running`, `interrupted`, `succeeded`, `partial`, `failed`, `cancelled`), `graph_version` (`WORKFLOW_GRAPH_VERSION` at start), `input_hash` (`inputHash` of `prepare`, 4.1 P11; null until `prepare` ends), `resume_count`, `failure` (JSON `{ code, message }`), `started_at`, `ended_at` (epoch ms). Failure codes: the node failure kinds of section 4 plus `interrupted_before_checkpoint`, `graph_changed`, `transcript_changed`, `internal`. `save` writes node records (SW4), verdicts and call links (SW1 to SW3), not this row (4.6.1). DDL names (7.4) differ: `kind` for `stages`, `started_by` for `trigger`, `error_kind` and `error_detail` for `failure`, `finished_at` for `ended_at` (X3). `kind` is `enhance` when the stage list holds `enhance`, else `summarize` (3.4.2 step 1); the checkpoint state keeps the full list (3.3). `llm_calls` carry `scope` and `scope_id`, copied from the run row (7.7 rule 1), and have no `meeting_id`: only `llm_runs.meeting_id` is the cascade root and a call is deleted through `run_id` (7.4). `llm_call_links` stay generic by `(target_type, target_id)` (Q16). The run status word is `succeeded` everywhere (R16, 11.4). A node status `ok` of section 4 is stored as step status `succeeded`; a step with some failed halves is stored as `partial` (4.0.7).

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

Figure 2. Run status. A deleted meeting has no row; the runner calls that outcome `meeting_deleted` (4.0.7) and stores nothing (4.6.3).

The runner derives the final status with one pure function, `deriveRunStatus`, in `W/types.ts` (WP5a), called in `execute` (3.4.6 step 1; WP5b). A WP5a test checks a hand-built final state without the runner (GR23, 10.8).

```ts
// W/types.ts (WP5a). Pure: no database, no clock. SaveResult: 4.6. foldStatus: 4.0.7.
export interface FinalState { // graph state fields (3.3) that the function reads
  stages: ("enhance" | "summarize")[]; corrections: CorrectChunkResult[];
  identify: IdentifySpeakersResult | null; verify: VerifyResult | null;
  summary: SummarizeResult | null; saved: SaveResult | null;
}
export interface RunEnd {
  cancelled: boolean;                  // soft-cancel flag set. A hard stop sets it first (3.4.5)
  fault: "none" | "prepare" | "graph"; // `prepare` threw, or another graph error (saver fault, escaped bug)
  hasCheckpoint: boolean;              // the thread has a checkpoint
}
export declare function deriveRunStatus(s: FinalState, end: RunEnd): RunStatus | "interrupted";
```

First, the status of each node of the stage list:

| Node (stage) | Status |
|---|---|
| `correctChunk` (`enhance`) | `foldStatus` over `corrections[].status` (4.0.7). No entry: `skipped` |
| `identifySpeakers` (`enhance`) | `identify.status`; null: `skipped` |
| `verifyEvidence` (`enhance`) | `verify.status`; null: `skipped` |
| `summarize` (`summarize`) | `summary.status`; null: `skipped` |

Then the first matching rule wins. The last column is the run `failure` code the runner writes (3.4.6 step 3).

| # | Condition | Run status | `failure` code |
|---|---|---|---|
| 1 | `saved` not null and `saved.meetingGone` | `meeting_deleted`: no row stored (3.4.8) | none |
| 2 | `end.cancelled` | `cancelled` | none |
| 3 | `end.fault` is `prepare` | `failed` | typed code of the `prepare` failure |
| 4 | `end.fault` is `graph` | `interrupted` when `end.hasCheckpoint`, else `failed` | `internal` |
| 5 | Every node status of the stage list is `ok` or `skipped`, `saved` not null, `saved.failures` empty | `succeeded` | none |
| 6 | `saved` not null and `saved.wroteAny` | `partial` | none |
| 7 | Any other case | `failed` | none |

A run from rule 6 or 7 has no run `failure` code; its failed steps carry the error kinds (8.9). Rule 5 cannot hide a run-wide stop (3.4.5): the node of the first final failure has status `failed` or `partial`.

Examples (GR23 test cases, 10.8; stage list `["enhance"]` unless named):

| Final state | Result |
|---|---|
| Chunk 2 ends `content_filter`; rest and SW1, SW2 `ok` (GR5) | 6: `partial` |
| First request HTTP 401; chunk 0 `failed`; later nodes `skipped`; SW1, SW2 `none` (GR18) | 7: `failed` |
| No API key at the first call (`model_unavailable`, 0 requests; GR21 a) | 7: `failed`; at `prepare`, 3: `failed` |
| `verifyEvidence` throws a plain `Error` (`internal`); SW1 `ok` (GR21 a) | 6: `partial` |
| SW2 fails twice, SW1 `ok` (GR21 a) | 6: `partial` |
| SW1 and SW2 both fail twice | 7: `failed` |
| Summarize run hits its deadline; SW3 `none` (GR22) | 7: `failed` |
| Three chunks `ok`, no correction; `identify` `skipped`; SW1 `ok` | 5: `succeeded` |
| Chained run; corrections and SW1 `ok`; `summary` `failed`, SW3 `none` | 6: `partial`; Enhance stays saved |
| Chained run; all nodes and SW1 to SW3 `ok` | 5: `succeeded` |

Only a `running` run holds the job slot. For every other status `GET /:id` returns `job` null. The screen for each status: 8.9.

#### 3.4.4 Progress

The job blob keeps its shape (J:13-30, `V/meeting-types.ts:36-53`), so renderer polling does not change. Each node adds its planned calls to `total` at its start (`correctChunk`: one per chunk; `summarize`: 4.5.3). `done` counts ended calls; `failed` counts typed failures. `queued` comes from the lane callback `onQueued` (L:275-283); the runner keeps the entry with the smallest `ahead`. Nodes report through `ctx.progress`, never to the registry. The recorder writes each call record when the call ends, so the inspector shows calls during the run (section 8).

#### 3.4.5 Cancel

**Soft cancel** (normal).

1. `POST /:id/cancel-transcribe` and `DELETE /:id` call `requestCancel(id)` (R:1587, R:2265). The changed `requestCancel` also aborts the `AbortController` that `startRun` passed to `claimJob`.
2. The gateway composes this signal with the call timeout: `AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)])` ([Node docs](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals)). The timer starts after the lane lease. An in-flight call stops; today it runs to its end (L:25-27).
3. A call that waits in the lane stops at the next poll tick, about 50 ms (L:402-413, L:455-462). This needs the `signal` option in `withLlmLane`.
4. A node that sees the abort returns a result with kind `cancelled`. It does not throw.
5. The routers send the graph to `save` (edge rule 4). `save` writes the finished chunks and suggestions. A cancelled `summarize` writes no summary (4.6.3).

**Hard stop** (fallback). The runner arms a timer when the soft signal fires. After `HARD_STOP_GRACE_MS` (30 s) it aborts the signal it passed to `graph.invoke`. LangGraph rejects the run with `Error("Abort")`: an abort listener rejects (`LG:pregel/runner.ts#L324-L331`) and the task loop races it against the running tasks (`#L359-L363`). A signal already aborted at the start of a super-step throws the same error (`#L310-L314`). The run ends `cancelled` and `save` does not run. A hard stop needs a node that ignores its signal; that is a defect.

**Why the user cancel is not the `invoke` signal.** That signal rejects at once (`LG:pregel/runner.ts#L310-L331`). Finished sibling tasks keep their results only as pending writes (`LG:pregel/runner.ts#L479-L480`) until every task of the super-step has writes (`LG:pregel/loop.ts#L1205-L1218`; `LD:checkpointers`). So it would lose the finished chunks of the running super-step. Today a cancel keeps them (N:459-465). UNVERIFIED by a run (U3).

**Run-wide stop.** A final failure with `runWide` true (5.2.1) calls `ctx.stopRun(kind)`. A unit that has not started a call returns status `skipped` and sends no request. A call that waits in the lane ends when its lease opens, with no request (5.1 step 4). A running call ends by itself. A router sends the graph to `save` (edge rule 4). The same happens after `BREAKER_N` = 3 final failures of one kind in a row in one node. So a cause that hits every unit, such as a missing key, costs one request, not one per chunk (X2, GR18).

**Run deadline.** `summarize` keeps today's job ceiling (4.5.3, R:1170-1210). It gives the gateway `AbortSignal.any([ctx.signal, AbortSignal.timeout(ceilingMs)])`. The gateway reads `signal.reason`: a `TimeoutError` is the ceiling, any other reason is a cancel (5.7). At the ceiling the gateway throws `deadline_exceeded`, the node skips its remaining calls and writes no summary, and the run ends `failed`.

#### 3.4.6 Finish

`execute` ends in one `finally` block. It never throws.

1. Derive the status and `failure` code with `deriveRunStatus` (3.4.3). It covers a `prepare` fault (`failed`, typed code), any other graph error (`interrupted` with code `internal` when a checkpoint exists, else `failed` with code `internal`) and a hard stop (`cancelled`).
2. If the meeting row is gone (`saved.meetingGone`, or a missing row found now), log one info line and skip steps 3 to 5 (3.4.8).
3. Write `status`, `ended_at`, `failure`, `result` and `lost_records` in one statement (`finishRun`, `RunFinish`, 7.7). The recorder stores `result` as opaque JSON in `llm_runs.result_json`. For kind `enhance` the runner passes `{ correctedCount, suggestionCount }` from `saved`; it passes null for a Summarize run and when `saved` is null. The reader of 8.3 parses the note from it. The runner is the only writer of `status` (through the recorder).
4. Close every step row still `running`: `cancelled` after a hard stop, `interrupted` for an interrupted run, else `failed` with the run's error kind. The boot sweep closes steps only for runs still `running` (7.12).
5. Delete the checkpoints of the thread at every final status (`succeeded`, `partial`, `failed`, `cancelled`). Keep them only for `interrupted`. This is the one rule for checkpoint deletion (7.9, 12.4): only an `interrupted` run can resume (3.4.7 guard 3). A failure here only logs a warning. Tests: GR17 (10.8).
6. Do not call `setJobFailure`. WP5b removes `job_error` and its writer (R:1240, J:142-144). The renderer reads every failure from the run row (8.9).
7. Call `releaseJob` and drop the run context.

`save` rewrites `transcript.md` and `transcript-enhanced.md` (4.6.5). Enhance never changes `meetings.status` (R:1073-1076). Only a saved summary sets `summarized` (R:1228-1230). No other code in `apps/server/src` or `apps/electron/src/main` writes that status (a search on 2026-10-17 finds only that update, the status checks at R:1750, R:2072 and R:2105, and the table constraint at `S/lib/schema.ts:768`).

#### 3.4.7 Boot sweep and resume

The server process starts with the app: `app.whenReady` awaits `startServerHost` (`E/main/index.ts:243`), which calls `spawnChild` (`E/main/server-host.ts:269`), which forks the process (`:123`). The app restarts a crashed server (`scheduleRestart` is called at `:144` and defined at `:176-198`; its timer calls `spawnChild` at `:193-197`) and reuses a live one (`:238-248`). So a `running` row at boot has no live job (J:10).

**Boot sweep.** `startServer` will call `sweepOrphanRuns()` before `serve()` (planned, WP5b; no such function exists at c47cd80d), next to the present `sweepStaleWhisperServer()` (`S/index.ts:211`) and `serve()` (`S/index.ts:226`). It uses synchronous SQL only and does not load LangGraph. For each `running` row:

- If the thread has a checkpoint, set `interrupted`.
- If not, set `failed` with code `interrupted_before_checkpoint`. LangGraph writes the input checkpoint at the start of an `invoke` that has an input (`LG:pregel/loop.ts#L1909-L1910`); without it, null input with no resume flag raises `EmptyInputError` (`LG:pregel/loop.ts#L1913-L1916`; the resume test reads channel versions, about `#L647-L663`), so a new run is the only way.

**Boot resume.** After the server listens, `resumeInterruptedRuns()` runs in the background. For each `interrupted` row with `resume_count < MAX_AUTO_RESUMES` (1) and no `failure`, it calls `probeEndpoint` (5.7) for each distinct endpoint in the checkpoint `models` that the stage list uses: one HEAD request, with no API key and no meeting data, to the base URL the run already used (Q15), local or cloud. It tries `BOOT_PROBE_TRIES` = 10 times, `BOOT_PROBE_WAIT_MS` = 15 000 ms apart. If an endpoint stays down, the row stays `interrupted`, the resume is not counted and the user can click Resume. Otherwise it calls `resumeRun`. Without the probe, a reboot with no network yet, or an oMLX restart, would fail every unit with `provider_unavailable`, end the run and delete its checkpoint. If the process dies again during the resumed run, the next boot leaves it `interrupted` and the user clicks Resume (8.9). This stops a crash loop and follows G6 (OQ-1). A row set to `interrupted` by a graph error (3.4.6) has a `failure` and waits for the button.

**`resumeRun` guards.** All must pass. A failed guard gives 409 with a `ResumeConflict` (3.4.2). Guards 4 and 6 also set the run to `failed` and the runner deletes its checkpoints (3.4.6 step 5). Guards 1, 2, 3 and 5 leave the run row as it was.

1. The meeting exists and its status is `transcribed` or `summarized`. Reason `meeting_status`.
2. No job holds the slot. Reason `job_running`.
3. The run status is `interrupted`. Reason `not_interrupted`.
4. `graph_version` equals `WORKFLOW_GRAPH_VERSION` (below). Otherwise `failed` with `graph_changed`.
5. A checkpoint exists. Reason `no_checkpoint`. The boot sweep and 3.4.6 set `interrupted` only when one exists, so this is a defensive check. The user can still click "Start again" (8.9).
6. A fresh `inputHash` equals `input_hash`. The fresh value is `inputHash(loadHashRows(db, meetingId), hashVariantOf(stages))` (4.1 P11), with `stages` from the checkpoint state (3.3). Otherwise `failed` with `transcript_changed`, and the user starts again (Q13, 2026-10-17). Three variants. (a) `enhance` only hashes segment ids, raw text and effective speaker label; a re-transcribe, re-diarize or speaker merge changes it. A name confirmed while the run is stopped does not, because SW2 writes only `suggested_*` (4.6.1). (b) A chained run also hashes the confirmed name of each segment, because its summary prints it (4.5). It ignores `enhanced_text`, because it writes it itself. A name confirmed while it is stopped fails the resume of its Summarize stage. (c) `summarize` only hashes the same fields, the confirmed name and `enhanced_text`, because the summary prints both. A name confirmed, or a new `enhanced_text` from an Enhance run, while a Summarize run is stopped fails the resume. The stale warning covers a name confirmed after the run ended (3.6). Re-diarize passes its only guard while a run is `interrupted` (`R:1762`), then rewrites the labels (`apps/server/src/lib/meetings/diarize.ts:535`, `R:1827-1828`). Skip this check when `input_hash` is null (`prepare` had not ended).

**Graph version.** `WORKFLOW_GRAPH_VERSION` is an integer constant in `W/types.ts`, starting at 1. The runner copies it into `llm_runs.graph_version` at start (3.4.3). Bump it by 1 in the same PR that changes: (1) the nodes or edges of Figure 1; (2) a field of the graph state (3.3) or a node result type (section 4); (3) a node schema (4.2.1, 4.3.1, 4.5.1); (4) a prompt in `W/prompts.ts`; (5) a constant of 4.0.5; (6) the unit key grammar (4.0.7); (7) the model or reasoning choice in `resolveModels` (5.1). An older checkpoint or finished call could give a result the new code does not expect, so guard 4 refuses the resume. The schema snapshot test (10.5.4) changes in the same PR, which tells the reviewer to check this rule. Test GR11 stores another version and expects `graph_changed`.

**Resume.** `resumeRun` claims the job, sets `status = running`, adds one to `resume_count` and calls `graph.invoke(null, config)` with the same `thread_id`. LangGraph continues from the last checkpoint (`LD:checkpointers`). A previous checkpoint is always needed; null input is one accepted form (`LG:pregel/loop.ts#L1641-L1645`, `#L647-L651`, `#L660-L663`) and this spec uses only that form. Finished nodes do not run again. A node that was running restarts from its start: `prepare` (it only reads); `correctChunk` only for chunks without a saved result; `identifySpeakers` and `summarize` from their start, but `callUnit` reuses each finished call from the call record (5.6), so a finished map call is not sent again; `save` (every write is idempotent, 4.6.2).

The Electron orphan sweep does not change (R:1349-1367, `E/main/meeting-recorder.ts:803-857`), because a run never changes the meeting status. UNVERIFIED for a kill during a super-step with `Send` tasks (U2).

#### 3.4.8 A meeting deleted during a run

`DELETE /:id` does not wait for a job. It asks the job to stop, removes the audio folder and deletes the row (R:2255-2286). Section 7 owns the cascade (7.4, 7.9, 7.12): foreign keys with `ON DELETE CASCADE` serve the run, call and checkpoint tables. The fallback of 7.9 (O7-3) is a `DELETE` trigger on the run table that removes the checkpoint rows. A probe on 2026-10-17 (`node:sqlite`, Node v26.5.0) showed such a trigger fires on a cascade. UNVERIFIED on Node 22.22.1 (U5). Runner rules:

1. `DELETE` calls `requestCancel` (3.4.5), then deletes the row. A write in the recorder, the saver or `save` can then fail with a foreign key error. Each catches it and checks `getMeetingRow(id) === undefined` (`S/lib/meetings/store.ts:90-95`). A recorder error never fails a call. A saver error ends the graph. Do not copy the `=== null` test of `runEnhanceJob` (R:1119): it never matches a deleted meeting; the else branch logs a failure (R:1127-1130).
2. `save` checks that the meeting row exists before each write (4.6.4).
3. The `finally` block of `execute` sees no row. It logs `ended because the meeting was deleted`, skips the run update and the markdown write (R:1139) and releases the job. A delete between the route checks and the run insert gives a foreign key error at step 2 of 3.4.2, and the route answers 404.
4. A run with a `scope` other than `meeting` has `meeting_id` NULL and no cascade. Its consumer defines its own delete rule.

---

### 3.5 Concurrency

**Today.** One lane serves each endpoint. The lane key is the server root of a local provider (L:194), the host from the map at L:109-119 for a known cloud provider, else the provider id (L:205). The limit is 1 for local (L:195) and 2 for cloud (L:206); constants at L:106-107, rule at L:174-179. A call holds a slot for that call only (L:21-24, L:506-519). Meeting calls use class `background` (C:126-134), wait until dictation has been idle for 15 s (L:87-91, L:415-425, `apps/server/src/lib/dictation-activity.ts:73-93`, check at `:85-93`) and queue behind `interactive` calls (strict priority in `drain()`, L:305-310; background stands aside at L:467-468). The queue is in memory (L:211-213).

**Rules for the workflow.**

1. Every call goes through the gateway, which takes the lane for each call. No node holds a lease across calls.
2. **Fan-out cap.** LangGraph starts every task of a super-step at once unless the config sets `maxConcurrency` (`LG:pregel/runner.ts`; the fallback to all tasks was seen at the pinned commit, the exact line is UNVERIFIED). The runner will set `WORKFLOW_FANOUT_CAP = LLM_LANE_CONCURRENCY_CLOUD + 1`, which is 3 (planned; the constant is not in code at c47cd80d, and `LLM_LANE_CONCURRENCY_CLOUD` is 2 at L:107). On cloud two calls run and one waits; on local one runs and two wait. The lane stays the only throttle. The cap must be 2 or more: in LangGraph 1.5.1, `maxConcurrency: 1` drops every `Send` task after the first with no error, and the next node does not run (WP4 spike SP2, 2026-10-18; a test pins it).
3. Only `correctChunk` fans out. `identifySpeakers` and `summarize` run alone. `summarize` makes its map calls one after the other (4.5.3).
4. **Wait time is not call time.** The call timer starts after the lease (C:126-153). The gateway records queue wait apart from latency (sections 5, 8).
5. **Backoff outside the lease.** `callUnit` sleeps before it calls the gateway, so a waiting call holds no slot (5.6; X2).
6. **Cancel in the queue.** A queued call stops when the signal fires (3.4.5).
7. **Dictation first.** A dictation cleanup call takes the next free slot before any background call. A call on the wire is never preempted. Runs for two meetings share the lane in call order with no extra code.

---

### 3.6 Summary: one graph with a list of stages

**Decision.** Summary joins the same graph. A router skips the nodes of a stage that the list does not hold. One `save` node serves both stages. Q2 (2026-10-17): the Enhance button and the auto-run after transcription (`meeting_enhance_auto_run`) start `["enhance", "summarize"]`. The Summarize button stays and starts `["summarize"]`.

**What the chain changes.**

1. Names. The summary prints confirmed names only (`S/lib/meetings/merge.ts:53-59`, `S/lib/meetings/summarize.ts:313-316`), so a chained summary prints "Them N" for unconfirmed speakers. The stale warning stays (the server input is `latestSpeakerUpdate` at R:1929-1941; the condition is at `P:444-449` and the banner renders at `P:897-905`): after a person confirms names, the screen offers Summarize again.
2. Cost. The auto-run stays opt-in (N:44-58, `specs/meeting-transcription-v2.md:29`). A chained run adds up to `MAX_SUMMARIZE_CALLS` = 24 long calls (`S/lib/meetings/summarize.ts:108`). The owner accepts this. Progress shows the planned total (3.4.4).
3. Isolation. A failed summary must not mark Enhance as failed, and the reverse (4.6.3). `save` writes the Enhance results even when `summarize` fails, and the run ends `partial` (3.4.3 rule 6). A cancel or run-wide stop before `summarize` skips it (edge rule 4).
4. Job kind. The job starts with kind `enhance`. `guardNode` calls `ctx.onNodeStart("summarize")` when `summarize` starts (4.0.2); the runner implements it with `setJobKind` (3.1), so the banner names the running stage. The graph, nodes and WP5a know no job registry (WP5b).
5. Summary data. SW3 writes the Markdown summary and the validated summary object to `meeting_summaries.summary_json` (migration 40, Q12). The node asks for a schema with five fields (overview, key points, decisions, action items, open questions) and code renders the Markdown (4.5). The pre-merge check is automatic: section and count checks, no owner side-by-side read (Q11).

---

### 3.7 Open questions, checks for other sections, unverified items

**Open questions for the owner.** None. The owner answered on 2026-10-17.

**Decided 2026-10-17.**

| ID | Decision |
|---|---|
| OQ-1 | An interrupted run resumes by itself once after a restart, then waits for the button (3.4.7). Reason: G6; the probe (Q15) protects cost. |
| OQ-2, Q2 | The Enhance button and the auto-run chain Summarize into one run; the Summarize button stays (3.6). |
| Q1 | No feature flag. WP5b replaces the old path after council consensus (3.1, 3.4.2). |
| Q5 | Only the owner's local oMLX (Qwen3.8-27B) gets a live proof. Cloud paths keep scripted-model tests and stay UNVERIFIED. |
| Q6 | No fixed bundle limit. Each PR measures and reports the growth (3.1). |
| Q8 | One release ships everything. Section 3 has no step that needs an earlier release. |
| Q9 | `callUnit` is the single retry layer. No node `RetryPolicy`. AI SDK `maxRetries` is 0 (3.2 rule 7, 5.6). |
| Q11, Q12 | The summary uses a field schema; code renders the Markdown; the pre-merge check is automatic. `meeting_summaries.summary_json` holds the object; migration 40 adds it, SW3 writes it (3.6). |
| Q13 | A confirmed name or a new `enhanced_text` fails the resume of an interrupted Summarize run with `transcript_changed` (3.4.7 guard 6). |
| Q15 | The boot resume of a cloud run sends one HEAD, with no key and no meeting data, to the base URL the run already used (3.4.7). |
| Q16 | The generic platform sits in `G` and `GW`. Run and call rows carry `scope` and `scope_id`. Delete-with-meeting holds through the nullable `meeting_id` (3.1, 3.4.3, 3.4.8). |
| Remix | Remix removal is its own work package; no AI SDK or gateway work for Remix (3.1 rule 4). |

**Checks for other sections** (all Applied; a work package proves each).

| ID | Check | Applied in |
|---|---|---|
| X0 | D5 names a custom `retryOn`; only a `RetryPolicy` has one | Edge rule 7, 5.6 (`gatewayRetryOn`, Q9) |
| X1 | `correctChunk` takes a slice, `CorrectChunkInput`, not `PreparedMeeting` | 4.2 Inputs |
| X2 | Retry wait outside the lease; combined abort signal; queue wait apart from latency; run-ending failure kinds | 5.1, 5.2.1 (`runWide`), 3.4.5, 5.6 |
| X3 | Run table has the fields of 3.4.3; checkpoint rows cascade by foreign key or trigger; `deleteThread`; SW4 | 7.4, 7.9, 4.6.1 |
| X4 | Resume route has a caller; renderer reads the run | 8.5, 8.3 (`llm-runs?latest=1`), 8.9, WP7, 11.4 |
| X5 | Tests: saver suite; kill and resume E2E; LangGraph import scope; env guard; nodes equal Figure 1; delete mid-run | 10.7, 10.8 (GR1 to GR3, GR13), 10.11.3 |
| X6 | Bundle proof, asar size, packaged smoke run (U1) | 10.14, 11.5 WP5a, WP9, 12.1 R2, R3 |
| X7 | Many calls in one node run, so a unit, not a node, is the retry boundary | 5.6; GR19 to GR21; WP5a, WP6 |
| X8 | Summarize ceiling allows one retry per call | `clamp(2 x perCallMs x plannedCalls, 2 x perCallMs, 4 h)` (4.5.3, 5.7) |
| X9 | Scope columns, nullable `meeting_id` cascade, `summary_json` in migration 40 | 7.3, 7.4, WP2 (11.5) |
| X10 | 4.5, 4.6 write `summary_json` in SW3; 8 reads runs by scope | 4.5.6, 4.6.1, 8.3, 8.4; WP6, WP7 |
| X11 | No flag: council precedes WP5b merge; WP5b deletes the old path; one release | 10.15, 11.7, 12.3 |

**Unverified items.**

| ID | Item | How to settle it |
|---|---|---|
| U1 | LangGraph packages bundle into `server-process.js` and `check-bundled-requires.mjs` stays green (it reads only top-level files, `apps/electron/scripts/check-bundled-requires.mjs:34`). | Build with electron-vite. Run a packaged Enhance. |
| U2 | `invoke(null, config)` resumes a thread whose process died during a super-step with `Send` tasks. The docs describe a resume after a failure only. | WP4 spike SP1: manual `SIGKILL` script on the real saver (11.5 WP4); WP5b acceptance 3. If false: 3.2 rule 8. |
| U3 | `maxConcurrency` bounds a `Send` fan-out. A cancel through the `invoke` signal loses the pending writes of the running super-step. Both from source reading. | WP4 spike SP2. If false: keep `Send`, add the counter of 3.2 rule 8 (c). Result 2026-10-18: caps 2 and 3 hold; cap 1 drops tasks 2 to N (see 3.5 rule 2). |
| U4 | A local engine such as oMLX stops generation when the app aborts the request. | Live call on the owner's Qwen3.8-27B; watch the engine log. WP5b probe LP5 (10.12, 11.5 WP5b acceptance 6). |
| U5 | The foreign key error shape and trigger behavior hold on Node 22.22.1. The design checks `getMeetingRow(id)`, not the error code. | Run the probe in the Electron server process. |
| U6 | The four tracing variables are the same in `@langchain/core` 1.2.18 as on `main`. | Read the published `callbacks.js` of 1.2.18. WP5a, step next to GR3 (11.5). |
| U7 | A plain `setTimeout` sleep never resolves under the fake timers of the server tests (`apps/server/tests/setup.ts:15-16`, loaded for all 92 test files by `apps/server/vitest.config.ts:21-22`). A run on 2026-10-17 showed it (10.2 rule 4); the `callUnit` sleep and the AI SDK retry wait sleep that way, so retry tests inject `sleep` or advance the timers. UNVERIFIED: other LangGraph code under these timers. Seven files use real timers, for example `apps/server/tests/trace.test.ts:34`. | Run the graph test suite. If it stalls, call `vi.useRealTimers()` in the graph test file. |
| U8 | `durability: "sync"` adds no visible delay. A run writes about seven checkpoints. | Measure on a 4 hour fixture. |
| U9 | The snippet in 3.3 compiles against `@langchain/langgraph` 1.5.1. | WP4 spike SP5: `pnpm --filter @openstyle/server typecheck:tests`. If false: use the real export names. |
| U10 | LangGraph stores the pending `Send` payloads in the checkpoint. The size claim in 3.3 depends on it. | WP4 spike SP4: read the rows of `llm_checkpoints`. If payloads multiply the size: 3.2 rule 8. Result 2026-10-18: one checkpoint row of 300598 bytes holds the 3 payloads of 100 KB, and the `__pregel_tasks` writes hold them once more; they do not multiply per checkpoint, so 3.2 rule 8 is not needed. |
| U11 | A node `errorHandler` runs for a node with no retry policy and can route to `save` with `Command({ goto })`. The docs describe it after the last retry (LangGraph 1.4.0 and later). | WP4 spike SP3. If false: drop it; `guardNode` is the only handler (3.2 rule 8 (b)). |

---

## 4. Node specifications

**Path key.** `S` = `apps/server/src`. `E` = `apps/electron/src`. `V` = `packages/validations/src`. `M` = `S/lib/meetings`. `W` = `S/lib/meetings/workflow` (3.1). `L` = `S/lib/llm`, the domain-agnostic LLM platform: gateway, model profiles, typed errors, `callUnit`, call recorder, run registry, checkpoint saver, tracing (3.1, 5.1; decided 2026-10-17, Q16). A node holds meeting logic only. Run and call records are scope-generic: a meeting run has `scope` = `meeting` and `scope_id` = the meeting id (7.4). **Planned files.** Every file under `W`, `M/input-hash.ts` and every name marked "new" or "planned" is absent at c47cd80d. A citation of such a file names the work package (WP) that adds it. A line-number citation points to c47cd80d. Cross-references: 3 (wiring), 5 (gateway), 7 and 8 (tables, inspector), 10.6 (node tests), 2 (current behavior), 1.4 (glossary). Terms: unit = input of one LLM call (a chunk, the candidate set or a map chunk); label = diarizer label text, "2" for "Them 2" (`M/merge.ts:21-30`); proposal = one model entry for one label; verdict = the code decision on a proposal, `kept` or `dropped`; suggestion = a kept proposal that `save` writes.

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

The two task ids exist (`V/llm-task-profiles.ts:9-16`, `S/lib/llm/task-profiles.ts:81-127`, `M/llm-call.ts:36`) and stay (N9). The Remix removal drops the `remix` id (own work package, 11.5). LLM nodes write no domain data. Only `save` writes meeting data.

#### 4.0.2 Who does what: gateway or node

The gateway checks every finish reason and marks which errors are retryable. `callUnit` is the one retry layer (D5, 5.6, Table 1 in 1.1). The gateway must check the finish reason, because AI SDK v7 returns valid JSON with finish reason `length` with no error (5.3.1): `json()` throws only on invalid JSON (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/generate-text/output.ts#L665-L687).

| Result from the gateway | Node |
|---|---|
| Valid object | Checks it in code (4.2 to 4.5). |
| `LengthError` | Runs the length route (4.0.6). |
| `ReasoningLeakError` (L1) | `identifySpeakers`: step 1 of the length route. Others: fail the unit. |
| Typed error with `retry` not null (5.2) | `callUnit` waits and calls once more (5.6). The second failure is final. |
| Any other typed error, or a final one | Fails the unit. |

- `callUnit` makes one retry per call, with the gateway's one retry rule (`gatewayRetryOn`, 5.6). AI SDK `maxRetries` is 0, and the graph sets no node `RetryPolicy` (decided 2026-10-17, Q9). A node adds no retry code. The length route changes the input and starts a new unit inside the node (3.2 edge rule 6); it is not a retry, and each call goes through `callUnit` (5.6 rule 4). `extractJsonObject` goes away (`M/enhance.ts:232-246`).
- `guardNode(deps, node, fn)` wraps every node body. It turns any other throw (a bug, a database fault) into one `NodeFailure` of kind `internal`, closes the step row and returns the failed result of that node: a `CorrectChunkResult` with one failed unit; an `IdentifySpeakersResult`, `VerifyResult` or `SummarizeResult` with status `failed`; for `save`, the `SaveResult` filled so far plus the failure in `failures` (4.6). So `deriveRunStatus` sees the fault (3.4.3), and the graph goes to `save`. A fault of `prepare` ends the run, because no data exists to save (3.4.6). A model-setup fault of `resolveModels` in `prepare` becomes `model_unavailable` (5.2.1): no model chosen, unsupported provider, no API key, or a removed server. A failed models.dev read is not such a fault (5.1).
- "Fails the unit" = unit status `failed` and one `NodeFailure` (4.0.7). Other units continue, unless the failure is run-wide (3.4.5).

**Step ownership.** A step row is one top key of 4.0.7 (7.4). Exactly one party opens and closes each row. `W/unit.ts` (WP5a) holds both helpers.

```ts
// W/unit.ts (WP5a). Working shape. Not compiled.
export interface NodeSpec<S extends { runId: string }, R> {
  id: NodeId;
  stepKey: ((state: S) => string) | null; // "prepare", `chunk:${i}`, "candidates", "verify", "save". null for "summarize": its body opens its own steps
  failed: ((state: S, f: NodeFailure) => R) | null; // the typed failed result of the node. null for "prepare": its fault is rethrown (3.4.6)
  outcome: (r: R) => { status: NodeStatus; failure: NodeFailure | null }; // for "save" it reads the SaveResult (4.6)
}
export function guardNode<S extends { runId: string }, R>(
  deps: WorkflowDeps, node: NodeSpec<S, R>, fn: (state: S, ctx: RunContext) => Promise<R>,
): (state: S) => Promise<R>; // the function that the node factory hands to LangGraph
export function runStep<R>(
  deps: WorkflowDeps, runId: string, step: { key: string; node: NodeId },
  body: () => Promise<R>, outcome: (r: R) => { status: NodeStatus; failure: NodeFailure | null },
): Promise<R>; // startStep, body, finishStep. On a throw it closes the row `failed` with kind `internal` and rethrows
```

`guardNode` does these things in this order, for each node run (a `Send` task of `correctChunk` is one node run):

1. `ctx = deps.getRunContext(state.runId)`; `ctx.onNodeStart(node.id)` (3.4.2; a throw is logged and ignored).
2. If `node.stepKey` is not null, `key = node.stepKey(state)` and `deps.recorder.startStep(state.runId, { key, node: node.id })`, before the first `callUnit` of the step (7.7 rule 3).
3. Run `fn(state, ctx)` in a `try`. WP8 puts `inNode` around this call (9.6.1).
4. If `fn` throws: build one `NodeFailure` of kind `internal`. With `node.failed` not null, the result is `node.failed(state, failure)`. With null (`prepare`), close the row and rethrow, and the runner ends the run (3.4.6).
5. If a step was opened, call `deps.recorder.finishStep(runId, key, status, err)`. `status` is from `node.outcome(result)` with `ok` stored as `succeeded` (4.0.7). `err` is the first failure as `{ kind, detail: message }`. Return the result.

| Node | Step key | Opens and closes the row |
|---|---|---|
| `prepare`, `verifyEvidence`, `save` | `prepare`, `verify`, `save` | `guardNode` |
| `correctChunk` | `chunk:<i>`, one row per `Send` task. The halves of a split share the row (4.0.7 item 5) | `guardNode`, once per task |
| `identifySpeakers` | `candidates`. The halves share the row | `guardNode` |
| `summarize` | `single`, `map:<i>`, `reduce:<level>:<group>`. One node run opens many rows | The node body (WP6) calls `runStep` per unit. `guardNode` has `stepKey` null, so it opens none. It still calls `onNodeStart` and catches a fault |

The `save` row is the SW4 write (4.6.1): `guardNode` closes it from the `SaveResult`. A node calls `startStep` or `finishStep` only through `runStep`. The row of a unit killed with the process stays `running` until the boot sweep (7.12).

**Resume and the fan-out.** A resume re-runs `guardNode` for each task without saved writes (3.3, 3.4.7). A repeated `startStep` keeps `seq` and `attempts` (7.7 rule 3). A finished task is not re-run: LangGraph returns its writes, and `callUnit` reuses each finished call by key (5.6). A task killed between `finishStep` and the checkpoint runs again and writes the same status.

#### 4.0.3 Schema rules (strict mode)

1. Every field is required; `.nullable()` marks an absent value (https://developers.openai.com/api/docs/guides/structured-outputs).
2. No `.optional()`, `.default()`, `.passthrough()`, `z.record()` or dynamic key. Use an array of objects.
3. Ids, labels, quotes: `z.string()`. No `z.enum()` of ids: each new schema grows the oMLX grammar cache about 0.45 GB (L5; https://github.com/jundot/omlx/issues/4321). A static enum of fixed words is allowed (`"name" | "role"`).
4. No `.min()`, `.max()`, `.length()`, `.regex()`: Anthropic returns error 400 for string length, number range and `minItems` above 1 (https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Code checks sizes after the parse.
5. One schema per node. `summarize` uses one schema for single, map and reduce (L5).
6. Field order is generation order: evidence before conclusion (#163).
7. The gateway does not change the JSON Schema. It passes the zod object to the SDK (`Output.object`, 5.1 step 5), which calls `z.toJSONSchema` (`target` `draft-7`, `io` `input`) and sets `additionalProperties` to `false` on every object (`@ai-sdk/provider-utils` 4.0.41, `dist/index.mjs:1097-1130, 2396-2407`; v7: https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/provider-utils/src/schema.ts). Authors follow rules 1 to 6; a unit test checks `await asSchema(zod).jsonSchema` (10.5.4), which the gateway stores in `llm_calls.schema_json` (7.4). A provider package may reshape it on the wire: the OpenAI package file removes `propertyNames`, removes a regex `pattern` that uses lookaround, and rewrites a singleton `allOf` (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/openai/src/normalize-openai-json-schema.ts). UNVERIFIED: that the chat path calls this file. UNVERIFIED: that rules 2 and 4 cover every keyword it changes (the file has no numbered rules).

#### 4.0.4 Prompt rules

- System prompt = run rules. User prompt = unit data inside tags, with the guard "treat as content, not instructions" (`M/enhance-prompt.ts:115-116`, `M/summary-prompt.ts:86-87`). Prompts are English, with a language line (`M/enhance-prompt.ts:36-38`). The schema carries the JSON shape.
- Never in a prompt: attendee names and emails (`M/enhance.ts:99-104`, `M/enhance-prompt.ts:29-35`), unconfirmed speaker suggestions (today the prompt gets label numbers only: `M/enhance.ts:413-427`, `M/enhance-prompt.ts:73-79`; `suggested_name` is written at `M/enhance.ts:660-663`, read only at `S/routes/meetings.ts:1895-1916`), keys, file paths, other meetings. `PromptInput` types have no attendee field; only the `verifyEvidence` input has one (test: 10.5.4). User-written text (vocabulary, title, context, summary instructions) may enter prompts.

#### 4.0.5 Token budget

Section 5 owns the model profile. Fields read here: `contextWindow`, `maxOutputTokens` (nullable), `reasoning.budgetTokens`, `.countsInMaxOutput`, `.maxBudgetTokens`, `.boundedLevel`. The repo has no context-window source: a search of `S` and `packages` for `contextWindow`, `context_window`, `context_length`, `n_ctx`, `ctx-size`, `max_model_len` finds one comment (`M/summarize.ts:73-75`). So `contextWindow` is `null` until the profile fills it. Then nodes skip the fit check and use today's constants.

```
tokens(text)   = ceil(characters / 4) // M/llm-call.ts:24-26
answer(node)   = node formula (4.2.4, 4.3.5, 4.5.4)
reasoningShare = reasoning.budgetTokens when reasoning.countsInMaxOutput, else 0
maxOutput      = min(profile.maxOutputTokens, answer + reasoningShare)
fit            = tokens(system) + tokens(user) + maxOutput + SAFETY_TOKENS <= profile.contextWindow
```

- Reasoning tokens use the output limit on OpenAI (https://developers.openai.com/api/docs/guides/reasoning) and Google (https://ai.google.dev/gemini-api/docs/thinking). A local reasoning model spends hidden thinking tokens from the same budget (`M/enhance.ts:484-490`) and left about 1100 to 1200 of 1500 tokens for the answer (`M/summarize.ts:56-63`). UNVERIFIED: how each server counts reasoning tokens (5.5 marks Groq and Mistral UNVERIFIED too).
- Anthropic: `countsInMaxOutput` = `false` (a field of this spec, section 5, not an SDK value), because the AI SDK adds the thinking budget to the limit: `baseArgs.max_tokens = maxTokens + (thinkingBudget ?? 0)` (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/anthropic/src/anthropic-language-model.ts#L951-L952).
- `resolveTaskCall` applies the preset floor `max(taskBudget, presetFloor)` (`S/lib/llm/task-profiles.ts:395-405`). The gateway caps at `maxOutputTokens`. UNVERIFIED: `ceil(characters / 4)` for Japanese and Chinese.
- Fit fails: `prepare` makes chunks smaller (4.1). A unit that fails at minimum size gets `budget_exceeded`, no call.

Constant names are names of this spec. Only `MAX_SUMMARIZE_CALLS` exists in code under its name. "Today" gives the identifier or literal that the value comes from. "New" means no code source: a starting value that the section 10 benchmark tunes (D12, N7).

| Constant | Value and source |
|---|---|
| `CHUNK_TOKENS_MAX` | 1200. Today `DEFAULT_ENHANCE_CONTEXT_BUDGET_TOKENS` (`M/enhance.ts:69`). |
| `CORRECT_ANSWER_FACTOR`, `CORRECT_ANSWER_FIXED` | 2, 200. Today inline literals in `Math.ceil(chunkTokens * 2) + 200 + 150 * speakerLabelsInChunk` (`M/enhance.ts:491-492`). |
| `SAFETY_TOKENS` | 256, new |
| `MIN_SPLIT_TOKENS` | 300 `correctChunk`, 1500 `identifySpeakers`, 2000 summary map chunk, new |
| `IDENTIFY_MAX_INPUT_TOKENS` | 6000, new |
| `IDENTIFY_ANCHOR_LINES` | 8, new, UNVERIFIED (section 10 measures it) |
| `IDENTIFY_PROPOSAL_TOKENS`, `IDENTIFY_FIXED_TOKENS` | 140, 64, new, UNVERIFIED |
| `IDENTIFY_REASONING_MAX` | 2048 (oMLX note, 4.3.4; extends L2) |
| `QUOTE_MAX_CHARS` | 160 (proposal in https://github.com/Maheidem/openstyle/issues/163) |
| `NAME_MAX_CHARS` | 80. Today inline `name.trim().slice(0, 80)` (`M/enhance.ts:570`). `M/speaker-spelling.ts:11` has a private `MAX_NAME_CHARS` of 80 for attendee names. |
| `SUMMARY_ANSWER_TOKENS` | 4096. Today `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` (`M/summarize.ts:77`). |
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

- A member is a segment (`correctChunk`), a candidate line (`identifySpeakers`) or a transcript line (`summarize` map). A half runs steps 2 to 4 alone: 1200 tokens split to 600, then 300, then stop. Most calls for one original unit: 11 (1, 2 halves, 4 quarters, 4 raises), plus 1 for step 1.
- `LengthError` with `where: "input"` (the request was too long, 5.2.1) skips steps 1 and 3, because more output room or less reasoning cannot fix it. The unit goes to `split`, then `fail`.
- UNVERIFIED: the route needs a model that stops at the limit. One oMLX runaway text ran to `max_tokens` (`/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/omlx-structured-output-peer-finding.md`). A live probe tests it (10.12 LP2, N10).

#### 4.0.7 Typed failure and node status

```ts
export type NodeId = "prepare" | "correctChunk" | "identifySpeakers" | "verifyEvidence" | "summarize" | "save";

// W/types.ts (planned, WP5a; absent at c47cd80d). GatewayErrorKind is the literal union of the 15 kinds that WP2 declares in `L/call-record.ts` (5.1, rule B). Import it. This section adds five.
export type FailureKind = GatewayErrorKind | "budget_exceeded" | "empty_input" | "save_failed" | "internal" | "transcript_changed"; // transcript_changed is run-level: the runner writes it when resume guard 6 fails (3.4.7), before any call. No node returns it

export interface NodeFailure { // one per failed unit; stored in 7, shown in 8 (D4)
  node: NodeId;
  unitKey: string | null; // key grammar below: "chunk:3", "chunk:3/0" (half), "candidates", "single", "map:2", "reduce:1:0"
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

1. Reduce level 1 reads the map results; level `L + 1` reads level `L`; the last level has one group (4.5.3). So two levels give different keys (`reduce:1:0`, `reduce:2:0`), and after a resume `callUnit` reuses a finished call only by its own key (5.6).
2. In one run, one key names one input (the state fixes the plan, candidates, settings and corrections: 3.3, 4.1). Exception: a call whose record write failed is resent after a resume and can answer differently (7.7; counted in `lost_records`, 8.7).
3. The length steps `lowerReasoning` and `raise` (4.0.6) resend the same key as new attempts. Only `split` and the replan of item 4 make new keys.
4. A `single` call that ends with `length` goes to a map and reduce plan (4.5.5) with keys `map:<i>` and `reduce:<level>:<group>`. The step row `single` ends `succeeded` when the node makes a summary, else `failed`.
5. A call belongs to the step of its top key, the part before the first `/` (7.4). A half has no step row. The step row `seq` is the start order in the run (7.7 rule 3).

- `message` holds no prompt text. The SDK error keeps the request body, with the prompt `messages` for OpenAI chat (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/provider-utils/src/post-to-api.ts#L160); UNVERIFIED for other providers. Do not copy `requestBodyValues`.
- Unit status: `ok`, `failed`, `cancelled` or `skipped` (never started because the run stopped, 3.4.5). `NodeStatus` adds `partial`; `skipped` also means the input makes the node useless (no labels). Run status: `deriveRunStatus` (3.4.3). `meeting_deleted` marks a row that vanished (4.6.4).
- **Status fold.** One pure function, `foldStatus(list: NodeStatus[]): NodeStatus`, in `W/types.ts` (WP5a). A `partial` entry counts as one `ok` and one `failed`. The first matching row wins.

  | # | The list | Result |
  |---|---|---|
  | 1 | holds `failed` or `partial`, and holds `ok` or `partial` | `partial` |
  | 2 | holds `failed` | `failed` |
  | 3 | holds `cancelled` | `cancelled` |
  | 4 | holds `skipped`, or is empty | `skipped` |
  | 5 | all entries are `ok` | `ok` |

  The fold runs twice: unit statuses of one step (halves of a chunk or of the candidate set) give the step status (`CorrectChunkResult.status`, `IdentifySpeakersResult.status`, the step row); chunk statuses give the status of `correctChunk`. A `cancelled` or `skipped` unit is not a failure: it never makes a step `partial` and 8.9 does not list it. The data of an `ok` half is still saved (SW1 writes each `ok` unit, 4.6.1). Example: one half `ok` and one `skipped` give a step `skipped` and a saved first half.
- Step status, as stored (7.4, 8.4): `foldStatus` over the units of one top key. `ok` is stored as `succeeded`; the others as they are. The error kind of a `partial` or `failed` step is the kind of its first failed half, in key order. A `partial` step counts as a failure for 8.9 and 8.7. `running` and `interrupted` are set by the recorder (7.7, 7.12). `unknown` is the read route's value for any other word (7.2 P7).
- Cancel: a node checks `ctx.isCancelled()` (3.4.5) before each call and returns kind `cancelled` (5.2), and checks `ctx.isStopped()` and then returns status `skipped`. Finished units stay in the state. The run goes on to `save` (4.6). Today the chunk loop polls `options.shouldStop?.()` before each call, sets `stoppedEarly` and breaks, with no failure kind (`M/enhance.ts:464-470`).

---

### 4.1 Node `prepare`

**Purpose.** Load the meeting once and build every later input. No LLM call. **Inputs.** Meeting id, rows of `meetings`, `meeting_segments`, `meeting_speakers`, vocabulary, settings.

```ts
export interface PreparedSegment {
  id: string; // meeting_segments.id
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
  // The two settings that `summarize` reads (4.5), read once, so a setting change while a run is stopped does not change the plan (4.0.7).
  summary: {
    instructions: string; // parseMeetingSummaryInstructions(readSetting("meeting_summary_instructions")): trimmed, "" when unset or too long (`V/settings.ts:205-211`)
    contextBudget: number; // parseMeetingSummaryContextBudget(readSetting("meeting_summary_context_budget")): 100 to 200000, default 8000 (`V/settings.ts:185-186, 257-266`; today's reader `M/summarize.ts:365-369`; budget callers `M/summarize.ts:198, 413`)
  };
  inputHash: string; // sha256 hex from `inputHash(loadHashRows(db, meetingId), hashVariantOf(stages))`: P11
}
```

**Rules.**

- P1. Read the transcript with the loader that WP5a moves to `transcript-io.ts` (`S/routes/meetings.ts:253-307`, 3.1).
- P2. Keep a segment only with an id and non-blank text (`M/enhance.ts:387-388`).
- P3. `text` is the raw text, never an earlier correction (`M/enhance.ts:389-396`).
- P4. `displayLabel` = `speakerDisplayLabel(seg, "Them")` (`M/enhance.ts:391`; `M/merge.ts:362-371`). Today the field is named `speaker` (`M/enhance.ts:391`); `displayLabel` is the new name. Display callers pass "Unidentified", never bare "Them" (`M/merge.ts:358-360`; Summary: `M/summarize.ts:315`). So `displayLabel` serves the Enhance LLM view only.
- P5. Chunk with `chunkForEnhance` (`M/enhance.ts:197-217`): whole segments, no overlap, so the id check in `correctChunk` is exact.
- P6. Chunk size = `min(CHUNK_TOKENS_MAX, floor((contextWindow - tokens(system) - SAFETY_TOKENS - CORRECT_ANSWER_FIXED) / (1 + CORRECT_ANSWER_FACTOR)))` (4.0.5). `contextWindow` `null`: `CHUNK_TOKENS_MAX`.
- P7. Label sets come from the structured `speakerLabel`, not display text (`M/enhance.ts:413-423`; the set has no `speakerName` filter). Confirmed = `display_name` set (`M/speaker-names.ts:37-51`).
- P8. Copy attendee names (no emails) from the calendar link (`S/routes/meetings.ts:1264-1269` reads names from the stored calendar attendees and drops emails; the copy from the calendar event is `calendarColumnValues`, `S/routes/meetings.ts:1281`).
- P9. Resolve model and profile for each LLM node once, into the state. A resume reuses them (N5). A model-setup fault is `model_unavailable` (5.2.1). A failed models.dev read is not a fault: the profile falls back to the hand table with a warning (5.1), so an offline Mac still runs a local `server` Enhance. Call: `resolveModels({ maxReasoningTokens: { correctChunk: 0, identifySpeakers: IDENTIFY_REASONING_MAX, summarize: 0 }, reasoningSteps: deps.reasoningSteps })` (5.1). Zeros match mode `off` (`reasoning.budgetTokens` 0; 5.5 rule 4, 4.0.1). `IDENTIFY_REASONING_MAX` is a cap only: reasoning runs when 5.5 rule 4 or a user preset turns it on.
- P10. No segment left: fail the run with `empty_input` before any call. The route answers 409 (`S/routes/meetings.ts:2114-2117`).
- P11. Compute `inputHash` with the one function of `M/input-hash.ts` (planned, WP2, 11.4; no `inputHash` symbol exists in `apps` or `packages`). The resume guard (3.4.7) and the inspector reader (7.8) call it too and must get the same bytes from the same database, so it hashes database rows, not the merged transcript:

```ts
// M/input-hash.ts (planned, WP2; absent at c47cd80d). Planned to be the only code that hashes a transcript.
// Today `createHash` appears only for worker versions, archives/models and update files (`S/lib/mlx-asr/runtime.ts:174, 653`; `S/lib/whisper/models.ts:245`; `E/main/self-updater-core.ts:161, 398`).
import { createHash } from "node:crypto";
export interface HashRow {
  id: string;                  // meeting_segments.id. Never empty (P2)
  text: string;                // the `text` column: raw, never a correction. Never blank (P2)
  speakerLabel: string | null; // the effective label: null for a "mic" row and for an undiarized row
  enhancedText: string | null; // the `enhanced_text` column. "" counts as null
  speakerName: string | null;  // the confirmed `display_name` of the effective label, else null
}
export type HashVariant = "enhance" | "summarize" | "chain";
export type RunStage = "enhance" | "summarize"; // StageSchema (3.3)
// "summarize" when stages has no "enhance"; "chain" when stages has both (Enhance chains into Summarize, Q2); else "enhance".
export function hashVariantOf(stages: readonly RunStage[]): HashVariant {
  if (!stages.includes("enhance")) return "summarize";
  return stages.includes("summarize") ? "chain" : "enhance";
}
export function loadHashRows(db: DatabaseSync, meetingId: string): HashRow[]; // rules below
export function inputHash(rows: readonly HashRow[], variant: HashVariant): string {
  const tuples = rows.map((r) =>
    variant === "enhance"
      ? [r.id, r.text, r.speakerLabel]
      : variant === "chain"
        ? [r.id, r.text, r.speakerLabel, r.speakerName]
        : [r.id, r.text, r.speakerLabel, r.enhancedText, r.speakerName]);
  return createHash("sha256").update(JSON.stringify([variant, tuples]), "utf8").digest("hex");
}
```

  - The new `loadHashRows` (planned; no function of this name exists at c47cd80d) reads `meeting_segments` with `status = 'ok'`, `ORDER BY idx, start_ms, id` (the same query is in `loadMergedTranscript`, `S/routes/meetings.ts:259-260`), and applies P2.
  - Effective label per `resolveSpeakerNames` (`M/speaker-names.ts:37-51`): only a `source = 'system'` row with a stored label has one; `merged_into` of its `meeting_speakers` row replaces it (one hop). Confirmed name = `display_name` of the effective label's row. A "mic" row has `null` for both.
  - Serialization: `JSON.stringify` of nested arrays, lower-case hex digest, no Unicode normalization. `prepare` calls both functions in the same synchronous block as the loader of P1 (one database state), with `hashVariantOf` over the run `stages` (3.4.2 step 1), and passes the result to `ctx.setInputHash` (3.4).
  - Variant `enhance`: ids, raw text, effective labels. `summarize` adds stored `enhanced_text` and the confirmed name (the fields the summary prints, 4.5). `chain` adds the confirmed name only, because the run writes `enhanced_text` itself in SW1 (4.6.1). A resume recomputes the hash. A different value fails the resume with `transcript_changed` and the user starts again (decided 2026-10-17, Q13; 3.4.7 guard 6). So a confirmed name, or a new `enhanced_text`, during an interrupted Summarize run ends it; a name change ends an interrupted chained run.

---

### 4.2 Node `correctChunk`

**Purpose.** Fix clear speech-to-text errors in one chunk. Nothing else (why: #163, section 1). **Inputs.** `CorrectChunkInput`: a slice of `PreparedMeeting` for one chunk (3.3, X1). The router of 3.2 edge rule 1 builds one per chunk of `prepared.chunks`.

```ts
// W/types.ts (planned, WP5a; absent at c47cd80d). The payload of one Send. A Send branch gets only this object, not the graph state (3.3).
export interface CorrectChunkInput {
  runId: string; meetingId: string;
  chunkIndex: number;            // index in prepared.chunks, from 0. Unit key `chunk:<chunkIndex>` (4.0.7)
  segments: PreparedSegment[];   // the whole segments of this chunk, in time order. Ids = prepared.chunks[chunkIndex]
  language: string | null;       // prepared.language
  vocabTerms: string[];          // prepared.vocabTerms
  profile: CallProfile;          // models.correctChunk (5.1)
}

export interface CorrectUnitResult { // one LLM unit: the chunk, or a half after a split (4.0.6)
  unitKey: string; // "chunk:3", "chunk:3/0"
  segmentIds: string[]; // the segments this unit covered
  status: "ok" | "failed" | "cancelled" | "skipped";
  // seq = index of the entry in the `corrections` array of the model output of call `callId` (before any drop). A dropped entry keeps its own index, so an applied entry and a dropped entry never share a link key (4.6.1, 4.6.2).
  corrections: { id: string; text: string; seq: number; callId: number | null }[]; // after the code checks
  dropped: { id: string; reason: CorrectionDropReason; seq: number; callId: number | null }[];
  failure: NodeFailure | null;
}
export interface CorrectChunkResult {
  chunkIndex: number;
  status: NodeStatus; // foldStatus over `units` (4.0.7)
  units: CorrectUnitResult[]; // one unit when no split ran
}
// CorrectionDropReason = "unknown_id" | "duplicate_id" | "empty_text" | "unchanged".
// Planned: WP2 declares it in V/meeting-types.ts (5.1, rule B; the file exists and holds types only, `V/meeting-types.ts:3-5`). W/types.ts imports it.
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

Builders live in `W/prompts.ts` (planned, WP5a, 3.1), copy what they keep and do not import the old `enhance-prompt.ts` (today `buildEnhanceSystemPrompt` `M/enhance-prompt.ts:29`, `buildEnhanceUserPrompt` `128`), which the route switch deletes (11.5). No flag, no second path (decided 2026-10-17, Q1). The new prompt has no JSON text (today `16-18`) and no speaker block (today `43-48`, `73-113`). It is not written yet, so no repo check is possible.

System prompt, in order: (1) role: "Me" is the app user; "Them N" or a confirmed name marks another speaker (today: "Them" singular, `M/enhance-prompt.ts:48`; "Them N" only in the speaker block, `79, 93`; transcript lines already carry it: name or "Them N" from `speakerDisplayLabel`, `M/merge.ts:368-369`, called at `M/enhance.ts:391`); (2) language line; (3) vocabulary terms fix a clear mis-transcription and never add a term (`39-42`); (4) rules (`21-26`): include a segment only if you change it; do not invent, merge, split, reorder, paraphrase or translate; fix clear recognizer errors; if nothing needs correction, return an empty list (today `{}`, line 26).

User prompt: guard sentence and the chunk inside `<transcript>` tags, one line `[id] Speaker: text` each (`M/enhance-prompt.ts:119-130`). No title or user context (N4).

#### 4.2.3 Code checks after the parse

For each correction, in order:

1. `id` not in the chunk: drop (`unknown_id` is the new reason label; today a silent `continue`, `M/enhance.ts:530-531`).
2. `id` seen earlier in the array: drop, `duplicate_id`. The first entry wins.
3. Trim the text. Remove an echoed "Speaker: " prefix (`M/enhance.ts:532-543`).
4. Text empty: drop (`empty_text` is the new reason label; today a silent `continue`, `M/enhance.ts:544`).
5. Text equals the original: drop (`unchanged` is the new reason label; today a silent `continue`, `M/enhance.ts:551`).

The unit result lists every drop with its call id. `save` stores each drop as a link with outcome `dropped` (4.6.1), and the Call view shows them (8.7).

#### 4.2.4 Token budget

```
chunkTokens = sum over lines of (tokens("[id] Speaker: text") + 1)    // +1 per line: M/enhance.ts:185-187; sum: M/enhance.ts:472
answer      = ceil(chunkTokens × CORRECT_ANSWER_FACTOR) + CORRECT_ANSWER_FIXED
maxOutput   = min(profile.maxOutputTokens, answer)                    // reasoningShare = 0
```

Today: `Math.ceil(chunkTokens * 2) + 200 + 150 * speakerLabelsInChunk` (`M/enhance.ts:491-492`). The speaker term leaves (planned), because `correctChunk` no longer asks for speakers. Factor 2 stays: 1.3 was too small in a run on 2026-10-06 (`M/enhance.ts:484-490`). Section 10 may lower it.

#### 4.2.5 Reasoning

Off, sent explicitly (L2), recorded in the param ledger. `meetingEnhance` is off today (`S/lib/llm/task-profiles.ts:111-115`), and a local server gets `chat_template_kwargs.enable_thinking = false` (`356-369`). A user preset can set `enable_thinking: true` and wins, as today; the node then uses the effective setting for `reasoningShare`, and the gateway adds a warning to the call record (N5).

#### 4.2.6 Failure handling

- `length`: route `split`, `raise`, `fail` (step 1 does not apply; for `where: "input"` only `split`, then `fail`). Other failure: the unit fails and its segments keep their old text; other units continue (unless run-wide, 3.4.5); `content_filter` is not retried. If one half of a split chunk fails, the chunk is `partial`: `save` writes the good half (4.6.1).
- Chunks run as a fan-out (3.2, 3.5). The lane allows 1 parallel call local, 2 cloud (`S/lib/llm/lane.ts:106-107`). All chunks fail: status `failed`; section 3 sets the answer (3.4.2; today 502: `S/routes/meetings.ts:2142-2173`).

Live proof (L6): a call on the owner's oMLX with Qwen3.8-27B. The body read back from the trace log holds the schema and `enable_thinking: false`. No cloud provider gets a live proof (decided 2026-10-17, Q5): cloud paths keep scripted-model tests and stay UNVERIFIED.

---

### 4.3 Node `identifySpeakers`

**Purpose.** Propose a name or role for each label that no user confirmed. Each proposal carries one transcript quote. No text correction. **Inputs.** `PreparedMeeting`.

**Skip rule.** `labels.toIdentify` empty: status `skipped`, reason `no_labels` (no diarization label) or `all_confirmed`. Today only `no_labels` exists: an empty label list gives an empty speaker block (`M/enhance-prompt.ts:78`) and skips the parse of `speakers` (`M/enhance.ts:560`). `speakerLabels` (`M/enhance.ts:413-422`) has no confirmation check. The `all_confirmed` skip is new.

```ts
export interface IdentifySpeakersResult {
  status: NodeStatus; // foldStatus over its units (4.0.7). partial: some halves failed (4.3.6)
  proposals: SpeakerProposal[]; // from the units that succeeded
  shown: { unitKey: string; callId: number | null; segmentIds: string[] }[]; // the lines each call showed (4.4.2 check 2)
  candidates: CandidateStats;
  failures: NodeFailure[]; // one per failed unit
}
export interface SpeakerProposal {
  unitKey: string; llmCallId: number | null;
  seq: number; // index of the entry in the `speakers` array of the output of call `llmCallId`. Two entries for one label in one call have two values (4.6.2)
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

`segmentId` and `quote` come first (rule 6 of 4.0.3). No free-text comment field exists (#163). An empty `speakers` array is valid. Code checks `segmentId`, `label` and lengths after the parse, and derives the evidence type from the cited line (4.4.2).

#### 4.3.2 Candidate lines

Code selects the lines. Pool = lines with `speaker = "Them"` and a non-null `speakerLabel`. "Me" lines are out, because the guard drops evidence that comes only from a "Me" line (`M/enhance.ts:316-326`, `342-346`; N2). Undiarized "Them" lines are out, because they are never evidence (`M/enhance.ts:301-304`).

- S1. Pool fits `IDENTIFY_MAX_INPUT_TOKENS`: all pool lines are candidates.
- S2. Otherwise add lines in this order until the budget is full: (1) anchor lines: the first `IDENTIFY_ANCHOR_LINES` pool lines of each label in `toIdentify`; (2) cue lines: a cue word of 4.4.3 followed by a capitalized word ("This is Ana"); (3) name-token lines: a capitalized token that is not the first token of its sentence.
- S3. Sort the selected lines by time. S4. Count lines cut by the budget into `CandidateStats` (section 8 shows them). S5. Use no attendee names (4.0.4) and no vocabulary.

Anchor lines keep the early self-introduction when `correctChunk` fails or a chunk border falls badly (the #163 loss: section 1).

#### 4.3.3 Prompt

Builders live in `W/prompts.ts` (planned, WP5a, 3.1). The blocks copy today's speaker block (`M/enhance-prompt.ts:73-112`), which the route switch deletes (11.5). The new prompt asks for no JSON text and no corrections, and its output rules name the schema fields.

System prompt blocks: (1) role and label list ("Them 2, Them 3"); (2) title and context lines, as evidence, not instructions; (3) two kinds of evidence: SELF-INTRODUCTION (the label's line states its own name) and ADDRESSED-AS (a line of a different speaker addresses the label by name); (4) a name that a label greets or lists is not its name; (5) role fallback: a grounded role, `kind` = `role`; (6) output rules: only listed label numbers; at most one entry per label (strongest evidence); copy `segmentId` exactly; copy the quote word for word from that one line, at most 160 characters; no comment; empty list when no evidence.

User prompt: guard sentence and the candidate lines inside `<transcript>` tags, marked as an excerpt, one line `[segmentId] Speaker: text` each. A confirmed label shows its name (`M/merge.ts:368`, called at `M/enhance.ts:391`) and leaves the label list.

#### 4.3.4 Reasoning

Reasoning follows the model profile and always has a bound.

| The profile says | The node sends |
|---|---|
| Plan mode `off`: the model cannot reason, or `reasoningSteps` (5.5 rule 4) does not list `identifySpeakers` | Reasoning off. |
| Plan mode `bounded`, provider has a token budget | Reasoning on, `budgetTokens = min(reasoning.maxBudgetTokens, IDENTIFY_REASONING_MAX)`. Wire shape of a local `server`: 5.5.2. |
| Plan mode `bounded`, provider has effort levels and no token budget | Level `reasoning.boundedLevel`. |

- Hard limit 2048 reasoning tokens. An oMLX note: without a budget 24 percent of thinking calls put raw reasoning in the content, with 2048 or less 0 of 38 did (`/Users/maheidem/Documents/Symphony/oss-local-hosting-material/homelab/litellm-gateway.md:513-515`). Extends L2. Through LiteLLM a top-level `thinking_budget` works, a nested one is ignored (`:218-223`); UNVERIFIED for a direct oMLX call. No app code caps reasoning with a preset `thinking_budget` (`V/settings.ts:82-87`, `S/lib/llm/registry.ts:112-125`); UNVERIFIED whether the server applies it.
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

**Purpose.** Code only. Check every proposal against the real transcript, pick one winner per label, fix the spelling of a winning name, store a verdict and reason for each proposal. **Inputs.** `PreparedMeeting` (with `attendeeNames`), the proposals, `shown` (4.3).

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
  seq: number; // copied from the proposal (4.3). One verdict per proposal, so (llmCallId, seq) is unique
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

// W/types.ts (planned, WP5a; absent at c47cd80d).
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

Section 7 stores this `SpeakerVerdict` as `verdict_json`, section 8 shows it (D10). Its codes are the only code list (11.4).

#### 4.4.1 Normalization

All comparisons use one normalizer: the current one (`M/enhance.ts:263-265`) plus NFKC, curly apostrophes and curly quotes. Names and cues match only at a Unicode letter boundary.

```ts
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC")
    .replace(/[‘’ʼ]/g, "'") // curly apostrophes
    .replace(/[“”]/g, '"') // curly quotes
    .toLowerCase().replace(/\s+/g, " ").trim();
}

const B = "(?<![\\p{L}\\p{N}])"; // not after a letter or digit
const E = "(?![\\p{L}\\p{N}])"; // not before a letter or digit

export function containsWord(textNorm: string, wordNorm: string): boolean {
  return new RegExp(`${B}${escapeRegExp(wordNorm)}${E}`, "u").test(textNorm);
}
```

Check of 2026-10-17, Node 26.5.0, current functions (`M/enhance.ts:263-265`, `273-280`) against the code of 4.4.1 and 4.4.3 (today the regex escape is inline at `M/enhance.ts:275`; no function `escapeRegExp` exists at c47cd80d, so the new name is planned):

| Input | Current code | Code of this section (= expected) |
|---|---|---|
| "Hi, this is Ana", name "Ana" | `true` | `true` |
| "Hi, this is José", name "José" | `false` | `true` |
| "Hi, I’m Ana" (curly apostrophe), name "Ana" | `false` | `true` |
| text "banana", name "ana" (name-in-quote check; current code uses `includes`, `M/enhance.ts:338`) | `true` | `false` |

Cause: `\b` without the `u` flag counts only A to Z, digits and underscore as word characters (`M/enhance.ts:277`; https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Word_boundary_assertion). UNVERIFIED: curly apostrophes in the owner's ASR.

#### 4.4.2 Per-proposal checks

Run in order. The first failure decides the verdict. Every proposal gets exactly one verdict.

| # | Check | Drop reason | From |
|---|---|---|---|
| 1 | `label` is in `labels.toIdentify` (a confirmed label fails). | `unknown_label` | `M/enhance.ts:566`. Today any label of `speakerLabels` passes, a confirmed one included (set: `M/enhance.ts:413-423`; check: `M/enhance.ts:560-566`). The failure for a confirmed label is new. |
| 2 | `segmentId` is in `shown` for the `unitKey` of the proposal (a "Me" id fails: never shown; after a split each half shows its own lines). | `unknown_segment` | New |
| 3 | The normalized quote is not empty. | `no_quote` | `M/enhance.ts:336` |
| 4 | The quote has at most `QUOTE_MAX_CHARS` characters. | `quote_too_long` | New (#163) |
| 5 | The normalized quote is a substring of the normalized text of the cited segment. | `quote_not_in_segment` | Replaces the search over all chunk lines (`M/enhance.ts:293-306`, loop `300-304`; drop text `345`). |
| 6 | The trimmed name is not empty. Code cuts it to `NAME_MAX_CHARS`. | `empty_name` | `M/enhance.ts:569` skips an empty name with no reason code; `570` cuts with `slice(0, 80)`. `empty_name` and `NAME_MAX_CHARS` are new. |
| 7 | `kind = "name"`: the name is in the quote at a letter boundary. | `name_not_in_quote` | `M/enhance.ts:338-340` |
| 8 | `kind = "name"` and the cited line has the same label: the quote reads as a self-introduction (4.4.3). | `not_self_introduction` | `M/enhance.ts:350-355` |

After check 5, code sets the evidence type from the cited segment, not from the model: `kind = "role"` gives `role_detail` (new value; today the check returns null and keeps the suggestion, `M/enhance.ts:347`); `kind = "name"` on a line of a different label gives `addressed_as` and passes (new value; today the check returns null, `M/enhance.ts:348-349`; both values are proposed in `specs/meeting-enhance-agentic.md:1315`); `kind = "name"` on a line of the same label gives `self_introduction` and check 8 must pass. Code cannot check that an ADDRESSED-AS name refers to the label. The prompt asks the model to judge (N2).

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

Runs after the per-proposal checks and before the conflict policy (N8). A passed `kind = "name"` proposal goes through `fixNameSpelling(name, attendeeNames)` (`M/speaker-spelling.ts:55-86`, returns a string). It changes a name only when exactly one attendee matches at the best level (`82-85`): equal first name, or a first name one letter off (4+ letters), and an equal rest of the name when the suggestion has one (`46-54`, `73-83`); an exact match beats a one-letter match (`84`). Check of 2026-10-17 on a file copy: "Marcus" with "Marcus Silva" and "Markus Lee" returns "Marcus Silva"; "Marcus" with "Marcos Silva" and "Markus Lee" (two near matches) returns "Marcus". It never changes evidence or kind (`6-7`). Old name to `respelledFrom`, new name to `finalName`. The quote keeps the transcript spelling.

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

**Purpose.** Write a structured summary. Code renders it to Markdown. The Summary tab and `meeting_summaries.markdown` keep their format. Code stores the object too, in `meeting_summaries.summary_json` (4.5.6).

**When it runs.** The Enhance trigger chains into Summarize in one run: the auto-run after transcription and the Enhance button start stages `enhance` and `summarize` (decided 2026-10-17, Q2; routing 3.6). The Summarize button stays: stage `summarize` only. In a chained run, `summarize` starts after `verifyEvidence` (3.2 edge rule 3), also when `correctChunk` or `identifySpeakers` failed (stored or raw text). It does not run when the run is cancelled or stopped (3.4.5). Names confirmed later make the summary stale; the existing warning stays (`S/routes/meetings.ts:1932-1940`). A chained summary prints "Them N" for an unconfirmed label, because suggestions are never used.

**Inputs.** `PreparedMeeting`, this run's corrections, `prepared.summary.instructions`, `prepared.summary.contextBudget` (4.1), `prepared.context`. The node reads no setting itself. Per-segment text, first value that exists (today's rule: `M/summarize.ts:298-316`): with stage `enhance`, a segment of an `ok` unit (`CorrectUnitResult.segmentIds`) uses this run's correction, else the raw text (SW1 resets `enhanced_text` to NULL for it, N6, so no older stored value enters); any other unit uses `PreparedSegment.enhancedText`, else raw. A `summarize`-only run uses `enhancedText`, else raw. Each line is `Speaker: text` with `speakerDisplayLabel(seg, "Unidentified")` (`M/merge.ts:362-371`): confirmed name, "Them N" or "Unidentified" (not `displayLabel`). A resumed run summarizes the same text.

```ts
export interface SummarizeResult {
  status: NodeStatus; // `ok`, `failed`, `cancelled` or `skipped`. Never `partial`: a summary that omits content must not look complete (4.5.3)
  summary: MeetingSummary | null;
  markdown: string; // rendered by code
  llmProvider: string | null; llmModel: string | null; // rules 2 and 3
  inputTokens: number; outputTokens: number; // sums over all calls (rule 1)
  costUsd: number | null; callCount: number; // rule 4
  failure: NodeFailure | null;
  llmCallIds: (number | null)[];
}
```

Token and cost fields keep their `meeting_summaries` meaning (`M/summarize.ts:433-442`, `512-515`). Today `resolveDefaultChatCall` reads the price (`getModelCostCached`, `M/llm-call.ts:165-167`); the new design returns no price (5.1, 7.4) and WP5b deletes that reader. So the node fills:

1. `inputTokens` and `outputTokens` are sums over all calls of the run, reused calls included (5.6). A call with unknown usage adds 0, as today (`M/llm-call.ts:45`).
2. `llmProvider` = `profile.provider` of the `summarize` entry in `models` (3.3).
3. `llmModel` = `modelServed` of the last call in call order (reused included); if null, `modelRequested`.
4. Cost. At node start, in one `try`/`catch`: (a) if the provider is not `server`, await `fetchModelsFromRegistry()`: it returns at once while the 6 hour cache is fresh (`S/lib/model-registry.ts:50, 60-62`), else waits at most 3 s (`11`, `64-66`) and throws on a failed read (`67-69`); this also warms the cache after a resume in a new process. (b) Call `getModelCostCached(profile.provider, profile.modelId)` once (`118-132`): cache only, null when cold or expired (`122`) or when the registry has no price (`100, 104`), else prices per token (registry per million, divided by 1,000,000: `106-109`). Price not null: `costUsd = inputTokens × price.input + outputTokens × price.output`. Otherwise NULL; a throw also gives NULL and no failure. A `server` model has no price, so NULL, as today.
5. SW3 writes the five values to the `meeting_summaries` columns unchanged, plus `summary_json` (4.6.1).

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

One schema serves single, map and reduce calls. A partial summary has the final shape, so a reduce can run on reduce results (4.5.3). `due` is free text: copy the time as spoken, compute no date. `keyPoints` stays (N1).

#### 4.5.2 Prompt

Builders live in `W/prompts.ts` (planned, WP6, 3.1): new single, map and reduce prompts for 4.5.1, copying what they keep and not importing the old file, which the route switch deletes (11.5). Today's builders: `M/summary-prompt.ts:90, 95, 104`. They conflict with the schema ("Return only the markdown summary", `91, 108`; four Markdown sections, `12-26`). From the old summarize code WP6 keeps only `chunkTranscript` (`M/summarize.ts:323`, 11.5).

System prompts (text from `M/summary-prompt.ts`, changed as stated). **Single**: role, meaning of each field, "do not invent facts, decisions or action items" (`26`, `32-34`). **Map**: one part of a longer transcript; first lines can repeat the previous part, do not count them twice (`40-42`). **Reduce**: combine ordered partial summaries, remove duplicates (`48-50`). Single and reduce end with the meeting-context block when it exists, after the user-instructions block (helpers `58-65`, `77-84`; order `M/summarize.ts:449-455`, `498-505`); map gets the context block only (`M/summarize.ts:488-491`). The new prompts (planned) have no Markdown section text; no repo check is possible.

User prompts. Single and map: guard sentence and lines inside `<transcript>` tags (`M/summary-prompt.ts:90-101`). Reduce: guard sentence and the partials, each in `<partial index="n">` tags (today already tagged: `<partial index="n">` at `106`, prompt `104-108`); in the new prompt each partial is a `MeetingSummary` as JSON (planned, WP6), because a map call returns that object.

#### 4.5.3 Single, map and reduce

- `tokens(transcript) <= contextBudget`: one call (`M/summarize.ts:447`). Otherwise split into chunks of whole lines with a small overlap (`M/summarize.ts:323-359`), one map call per chunk in order, then the reduce.
- `contextBudget = min(prepared.summary.contextBudget, fit)`. `fit = profile.contextWindow - tokens(system) - maxOutput - SAFETY_TOKENS`. `contextWindow` `null`: only the setting (today's reader `M/summarize.ts:365-369`; no `contextWindow` fallback exists in `M/summarize.ts` at c47cd80d, so this rule is new).
- Keys: `single`, `map:<i>`, `reduce:<level>:<group>` (4.0.7). Level 1 reduces groups of map results; level `L + 1` reduces the results of level `L`; the last level has one group, key `reduce:<last>:0`.
- The reduce input must fit. Partial tokens over `contextBudget`: group consecutive partials so each group fits, run one reduce per group (one level), repeat until one group is left, then run the final reduce. This check is new (JSON partials are larger than prose; today only a count guard: `M/summarize.ts:468-469`; the reduce call site `498-509` has no guard).
- Calls are bounded by `MAX_SUMMARIZE_CALLS` = 24. A plan over it fails with `budget_exceeded` and writes no partial summary. Today the guard throws a plain `Error` before any call (`M/summarize.ts:462-475`, `472-474`); no code emits `budget_exceeded` today (new kind, 4.0.7). `plannedSummaryCalls(tokens, budget)` (new, `W/summary-pure.ts`, WP5a; WP6 tests it) replaces `plannedSummarizeCalls`, which cannot count grouped reduces (`M/summarize.ts:116-124`). It plans `ceil(tokens / fresh)` map calls (`fresh` = budget less overlap), assumes `SUMMARY_PARTIAL_TOKENS` per partial, groups `floor(budget / SUMMARY_PARTIAL_TOKENS)` partials per reduce, and adds the reduce calls of each level until one is left. A group of fewer than 2 partials fails the plan with `budget_exceeded`. The run checks the real count after each level. The job deadline uses the plan.
- The job deadline is `clamp(2 x perCallMs x plannedCalls, 2 x perCallMs, 4 h)`, so one retry per call fits (X8). The factor 2 on `plannedCalls` is new (today `clamp(perCallMs x plannedCalls, 2 x perCallMs, 4 h)`, `M/summarize.ts:151-153`). One call has one timeout window (`M/llm-call.ts:146-153`); the AI SDK retries a retryable error twice by default inside it (2.3 P12). At the ceiling the gateway throws `deadline_exceeded` (3.4.5). A map or reduce call that fails after the route fails the node. Every call uses `callUnit`, so retry or resume never repeats a finished map call (5.6).

#### 4.5.4 Token budget and reasoning

```
answer    = SUMMARY_ANSWER_TOKENS                      // 4096; today DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS, M/summarize.ts:77
maxOutput = min(profile.maxOutputTokens, answer)       // reasoningShare = 0
```

Reasoning is off, sent explicitly (L2; today also off: `S/lib/llm/task-profiles.ts:96-110`). Keep 4096: 1500 was too small and a reduce call ended with `length` (`M/summarize.ts:50-77`). The timeout stays the setting `meeting_summary_timeout_seconds` (`S/lib/llm/task-profiles.ts:154-164`).

#### 4.5.5 Length route

Single call: step 2 `split` (plan a map and reduce with a context budget of half the transcript tokens), then step 4 per failing call. Map call: step 2 `split` the chunk in two, then steps 3 and 4. Reduce call: step 3 `raise`, then step 4 (grouping splits a reduce: 4.5.3). Every new call counts against `MAX_SUMMARIZE_CALLS`.

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

**Home file.** The pure functions of this section and 4.5.3 live in `W/summary-pure.ts`. WP5a owns it with full bodies, because the `save` test of 10.6 compares the stored Markdown with the real function and WP5a runs before WP6 (11.4). It imports no LangGraph module, database or model, and exports `renderSummaryMarkdown`, `oneLine`, `paragraphs`, `plannedSummaryCalls`, `MAX_SUMMARIZE_CALLS`, `SUMMARY_PARTIAL_TOKENS`. `MeetingSummary` is the type of `W/schemas.ts` (WP3). UNVERIFIED: the file home; `specs/meeting-enhance-agentic.md:1469-1482` defines `MeetingSummarySchema` with no file header, and the WP6 file list (`specs/meeting-enhance-agentic.md:4136`) names no schemas file. `plannedSummaryCalls(tokens: number, budget: number): { calls: number } | { error: "budget_exceeded" }` takes the overlap from `overlapTokens`, which WP5a moves with `chunkTranscript` into `W/chunking.ts` (`M/summarize.ts:83-84, 216-221`). Test GR26 covers both groups.

Headings are English and "None." marks an empty list (`M/summary-prompt.ts:14-24`). `oneLine` replaces line breaks with spaces. `paragraphs` removes any line that starts with `#`, so a model string cannot add a heading. The Markdown goes to `meeting_summaries.markdown`, the object to `meeting_summaries.summary_json`.

**Where the object lives (decided 2026-10-17, Q12).** In `llm_calls.parsed_json` of the final call (`single` or last reduce) for the advanced-mode inspector, and in the new nullable TEXT column `meeting_summaries.summary_json` as data (migration 40 adds it; 7.4 owns the DDL). SW3 writes `JSON.stringify(summary)` (4.6.1). Rows from before migration 40 keep NULL. The Summary tab and every current reader still use `markdown`.

**Automatic pre-merge check (decided 2026-10-17, Q11).** The summary keeps the five fields of 4.5.1. No owner side-by-side read is part of the gate. Owner: WP10a. Script: `scripts/meeting-v2/check-summary.mts`, run through the `ts-register` loader as `compare-speakers.mts` is (`package.json:10`; no `check-summary` script exists at c47cd80d). WP10a adds the root script `meeting:check-summary`:

```bash
pnpm meeting:check-summary --db <db> --meeting <meetingId> --arm <old|new> --out <metrics.json>
```

The script opens the database read-only and reads the `meeting_summaries` row (`markdown`, `summary_json`). Five checks:

1. The Markdown holds the five headings of `renderSummaryMarkdown` in order. 2. `overview` is not blank after `trim()`. 3. For each list, the count of list lines equals the array length in `summary_json` (`None.` = 0). 4. No Markdown line except the five headings starts with `#`. 5. `summary_json` parses, passes the field types of 4.5.1, and equals the object the Markdown was rendered from. The script keeps its own copy of the format and rebuilds the expected Markdown from `summary_json`; WP6 test SW3 compares the stored Markdown with the real `renderSummaryMarkdown`. Two implementations must agree, so a drift in either fails loudly.

**Output.** One line of JSON (numbers and booleans only, no meeting text), also written to `--out`. Fields: `arm`, `headingsInOrder` (check 1), `overviewNonBlank` (2), `listCountsMatch` (3), `strayHashLines` (4, a count), `summaryRenderMatches` (5), `summarySections`, `summaryKeyPoints`, `summaryDecisions`, `summaryActionItems`, `summaryOpenQuestions`, `summaryChars`, `pass` (checks 1 to 5 hold). Exit 0: `pass`. Exit 1: a check failed. Exit 2: wrong usage or unreadable database.

**The old arm.** The old Markdown has four sections and no `Open Questions` (`M/summary-prompt.ts:12-23`), and `summary_json` is NULL. With `--arm old`, the script counts from the Markdown only: it splits at lines starting `## ` and counts lines starting `- ` per section (`None.` = 0). It sets `summaryOpenQuestions` and `summaryRenderMatches` to `null`, reports checks 1 to 4 as information, and exits 0 when it can read the row (measured, not gated). The gate compares the new arm with the old counts of key points, decisions and action items; none compares `summaryOpenQuestions`.

**Where it runs.** WP6 runs it on three fictional summaries in its acceptance (11.5). `run-enhance.mjs --summarize` calls it after each run and merges the numbers into `metrics-enhance.json` (WP10a). WP10b needs `pass` true on every data set (10.15). A failed check blocks the merge. Cloud providers get scripted-model tests only (Q5). Live proof (L6): as in 4.2.6, with the real `MeetingSummarySchema`, on the owner's local oMLX only.


---

### 4.6 Node `save`

**Purpose.** Code only. Write what the run produced and record each node status. The only node that writes meeting data. **Inputs.** The run state (3.3): `corrections`, `identify`, `verify`, `summary`. The node statuses, failures and call ids sit inside those results.

**Output.** `save` returns a `SaveResult`, the state field `saved` (3.3). It creates it first and fills it as each write ends. It also returns it when `guardNode` catches a throw; the failure then joins `failures` (4.0.2).

```ts
// W/types.ts (planned, WP5a; absent at c47cd80d). deriveRunStatus (3.4.3) and the runner (3.4.6 step 3) read it.
export type WriteOutcome = "ok" | "failed" | "none";
export interface SaveResult {
  sw1: WriteOutcome; sw2: WriteOutcome; sw3: WriteOutcome; // the writes of 4.6.1
  wroteAny: boolean;       // true when at least one SW1, SW2 or SW3 transaction committed
  correctedCount: number;  // segments that SW1 gave a non-NULL `enhanced_text` in this run
  suggestionCount: number; // `meeting_speakers` rows that SW2 wrote in this run
  failures: NodeFailure[]; // `save_failed` per write that failed twice, and `internal` from `guardNode`
  meetingGone: boolean;    // the meeting row is gone (4.6.4)
}
```

- `sw1`, `sw2`, `sw3`: `none` when no transaction of that write was tried; `ok` when at least one was tried and none failed; `failed` when at least one failed twice (4.6.1).
- `correctedCount`: segments for which a committed SW1 transaction set a non-NULL `enhanced_text`. A segment reset to NULL (N6) or rolled back adds 0. A Summarize run has 0. `suggestionCount`: `meeting_speakers` rows a committed SW2 transaction wrote, an unchanged suggestion included. A Summarize run has 0.
- A `save_failed` failure has `node` `save`. `unitKey` is the unit key for SW1, null for SW2 and SW3. `message` names the write, for example `SW2 failed twice`.
- The step row `save` (SW4) is `succeeded` when `failures` is empty; `partial` when `failures` is not empty and `wroteAny` is true; else `failed`. Its error kind is `save_failed` or `internal`.

#### 4.6.1 Writes

Each write is its own transaction via the synchronous `withTransaction` (`S/lib/db.ts:56-75`). A failed write does not roll back the others (`M/enhance.ts:638-640`).

| Write | Condition | Statement |
|---|---|---|
| SW1 corrections | Each unit with status `ok`. One transaction per unit | For each segment id the unit covered: `UPDATE meeting_segments SET enhanced_text = ? WHERE id = ?`. The value is the correction, or `NULL` when the unit has none for that segment. Segments of a failed unit stay as they are. The same transaction writes one link per correction (outcome `applied`, `applied_text` = the value) and per drop (outcome `dropped`, the drop reason). |
| SW2 speakers | `verify` holds at least one verdict. One transaction for the whole speaker result | For each suggestion: `INSERT INTO meeting_speakers (meeting_id, speaker_label, suggested_name, suggested_evidence, suggested_kind, updated_at) ... ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET suggested_name, suggested_evidence, suggested_kind, updated_at`. The same transaction writes one link per verdict, kept and dropped (`verdict_json` = the `SpeakerVerdict`). |
| SW3 summary | `summarize` status `ok` | One transaction: `INSERT OR REPLACE INTO meeting_summaries (meeting_id, markdown, summary_json, llm_provider, llm_model, input_tokens, output_tokens, cost_usd, created_at)`, then `UPDATE meetings SET status = 'summarized' WHERE id = ?`. The same transaction writes the summary links (`applied_text` = the new `created_at` as text, 7.8). |
| SW4 run record | Always, last | The `save` step row in `llm_run_steps` (7): status rule under the `SaveResult`, error kind `save_failed` or `internal`. `guardNode` writes it with `finishStep` from the `SaveResult` (4.0.2). No link writes. |

- SW1 and SW2 follow today's statements (`M/enhance.ts:628-636`, `658-672`). SW3 follows `S/routes/meetings.ts:1213-1228` with one transaction and the new column `summary_json`. SW4 has its own transaction, so a failure record stays when SW1 to SW3 fail. A link is part of the write it describes (7.2 P6): no edited text without its link, no link for a rolled-back write. Each write is retried once after 200 ms (for example `SQLITE_BUSY`). A second failure gives a `NodeFailure` of kind `save_failed`, sets that write's outcome to `failed`, adds the failure to `SaveResult.failures`, and the other writes go on.
- SW2 never writes `display_name` or `confirmed_at`: a suggestion is evidence, not a user decision, and must not move the summary staleness mark (`M/enhance.ts:658-667`; staleness reads `MAX(confirmed_at)`: `S/routes/meetings.ts:1932-1940`). Only the speaker PATCH writes `confirmed_at` (`S/routes/meetings.ts:2030`, `2040-2048`).
- Inside a run, only SW3 changes `meetings.status` (today: Summarize save sets `summarized`, `S/routes/meetings.ts:1228`; the Enhance job never does, `1128-1129`). Code outside a run writes it too: `S/routes/meetings.ts:1384, 1472, 1494, 1519, 1543` (lines 875, 973, 1007, 1050 are inside `runTranscribeJob`, `776-1077`, so they are run code); `S/routes/meetings-import.ts:281`.

**Link rows.** Each link is a `NewLink` (7.7). Its key is `(call_id, target_type, target_id, seq)` (7.4). `seq` is the index of the entry in the model output of the call, so two entries of one call never share a key.

| Write | `call_id` | `target_type`, `target_id` | `seq` | `outcome`, `reason` | `applied_text` | `verdict_json` |
|---|---|---|---|---|---|---|
| SW1, correction | `callId` of the correction | `segment`, the segment id | `seq` of the correction | `applied`, NULL | the value written to `enhanced_text` | NULL |
| SW1, drop | `callId` of the drop | `segment`, the `id` the model gave | `seq` of the drop | `dropped`, the `CorrectionDropReason` | NULL | NULL |
| SW2, kept verdict | `llmCallId` | `speaker`, the label | `seq` of the verdict | `applied`, NULL | `finalName` | the `SpeakerVerdict` |
| SW2, dropped verdict | `llmCallId` | `speaker`, the label | `seq` of the verdict | `dropped`, the `DropReason` | NULL | the `SpeakerVerdict` |
| SW3, summary | each id of `SummarizeResult.llmCallIds` | `summary`, the meeting id | 0 | `applied`, NULL | the new `created_at` as text | NULL |

A `null` call id gets no link (7.7 rule 9). A `duplicate_id` drop and the applied correction of one segment have different `seq` values, so the drop cannot replace the applied link; two proposals for one label in one call also differ in `seq`. Without `seq`, `ON CONFLICT DO UPDATE` would turn the applied link into a dropped one, and the reader of 7.8 would show `noRecord`. The summary link has one row per call, `seq` 0, because `call_id` differs.

#### 4.6.2 Idempotent re-run

- Every write uses a natural key: segment id, (meeting id, label) or meeting id. A replay writes the same values and adds no row. Links use `UNIQUE(call_id, target_type, target_id, seq)` with `ON CONFLICT DO UPDATE` (7.4). `seq` values come from the model output and do not change between runs of `save`, because a resumed run reads the same stored output (5.6). SW4 rows use the key (run id, step key). A resumed run can run `save` twice. The second run changes nothing (GR16).
- A new run replaces old results (N6). A unit with status `ok` sets every `enhanced_text` of its segments, and a segment with no correction gets `NULL`. A failed unit leaves the old `enhanced_text`. SW2 overwrites a suggestion only when the new run has a winner for that label, and never clears one.

#### 4.6.3 Partial results policy

`deriveRunStatus` (3.4.3) decides the run status. The run status is `partial` only when SW1, SW2 or SW3 wrote data in the same run (`SaveResult.wroteAny`). Rows 1 to 8 describe an Enhance run (stages `enhance` and `summarize`, 4.5). Row 9 describes a Summarize run (stage `summarize` only, writes only the summary). Row 10 applies to both.

| # | Situation | Corrections | Speakers | Summary | Run status |
|---|---|---|---|---|---|
| 1 | Some chunks or units fail | Saved for `ok` units | Saved when `identifySpeakers` is `ok` or `partial` | Saved when `summarize` is `ok` | `partial` |
| 2 | All chunks fail | None | Saved when `identifySpeakers` is `ok` | Saved when `summarize` is `ok`. It uses the stored or raw text. | `partial` if speakers or the summary are saved, else `failed` |
| 3 | `identifySpeakers` fails | Saved | None | Saved when `summarize` is `ok` | `partial` |
| 4 | `verifyEvidence` fails (`internal`) | Saved | None | Saved when `summarize` is `ok` | `partial` |
| 5 | `summarize` fails | Saved | Saved | None. Status unchanged. | `partial`: SW1 or SW2 wrote data in the same run |
| 6 | Cancelled by the user | Saved for finished chunks | Saved when finished | None | `cancelled` |
| 7 | Meeting deleted during the run | None | None | None | `meeting_deleted`, no error |
| 8 | A run-wide failure stops the run (3.4.5) | Saved for finished units | Saved when finished | None | `partial`, or `failed` when nothing was saved |
| 9 | `summarize` fails in a Summarize run | Not part of the run | Not part of the run | None. Status unchanged. | `failed`: SW1 and SW2 wrote nothing in this run |
| 10 | A write of `save` fails twice (`save_failed`) | The other writes stay | | | `partial`, or `failed` when nothing was saved |

A cancelled run still goes through `save` and writes what exists (`M/enhance.ts:464-469`, `628-636`). A cancelled `summarize` writes no summary, and a cancelled run starts none (4.5). Section 3 maps run status to job state.

#### 4.6.4 A deleted meeting

The delete route asks the run to stop and deletes the row at once, without waiting (`S/routes/meetings.ts:2258-2265`, `2283`). The foreign key then rejects inserts into `meeting_speakers`, the summary table and the run record. A meeting run row carries `scope` = `meeting`, `scope_id` and a nullable `meeting_id` with `ON DELETE CASCADE`, so the calls and links of the run go with the meeting (D10; 7.4 owns the DDL).

- `save` checks that the meeting row exists before each write and catches a constraint error. If the row is gone, `save` stops, logs one info line, sets `meetingGone` and does not fail the run. An `UPDATE` of a deleted segment changes 0 rows, no error.
- Test the missing row with `=== undefined`, not today's `=== null` (3.4.8 rule 1).

#### 4.6.5 Export files

After the writes, `save` rewrites `transcript.md` and `transcript-enhanced.md`, best effort, never throwing. Today: `writeTranscriptMarkdown` (`S/routes/meetings.ts:322-342`; WP5a moves it to `transcript-io.ts`, 3.1). It always writes `transcript.md` (`325-329`), writes `transcript-enhanced.md` only when a segment has `enhancedText` (`330-336`), and logs a warning on error (`337-341`). `save` runs it after every run, also after a cancel, not when the meeting is gone. Today the Enhance job's `finally` does this (`1133-1139`).

---

### 4.7 Decisions on the former open points

D1 to D12 and the round 2 answers settle these points. No open point remains in this section.

| ID | Point | Decision |
|---|---|---|
| N1 | Key Points: the single and reduce prompts require them (`M/summary-prompt.ts:12-18`, `34`, `50`), the map prompt does not (`40-42`). | Decided 2026-10-17 (owner viewpoint): keep `keyPoints` in the schema. The summary keeps its current Markdown sections, and `summary_json` keeps the field. |
| N2 | The app user often addresses a speaker by name, but the guard drops "Me" evidence. Code cannot check that an ADDRESSED-AS name refers to the label. | Decided 2026-10-17 (owner viewpoint): keep today's rules, send no "Me" lines. A turn-taking rule is out of scope; the benchmark may measure it later. |
| N3 | Self-introduction cues exist in English only. | Decided 2026-10-17 (owner viewpoint): keep English. A pattern list per language is a later change. |
| N4 | Title and user context reach the model only inside the speaker block today (`M/enhance-prompt.ts:78-90`). | Decided 2026-10-17 (owner viewpoint): `identifySpeakers` only. The benchmark may test `correctChunk` later. |
| N5 | A user preset can switch reasoning on for `meetingEnhance`; `prepare` fixes the model for the run (4.1 P9). | Decided 2026-10-17 (owner viewpoint): the preset wins, with a warning in the call record (5.5.2 agrees). |
| N6 | A re-run resets `enhanced_text` to `NULL` for segments of an `ok` chunk with no correction (today only segments with a new correction change). | Decided 2026-10-17 (owner viewpoint): reset. The last pass is the whole truth; the chained summary relies on it (4.5). |
| N7 | Constants marked "new" in 4.0.5 are starting values. | Decided 2026-10-17 (owner viewpoint): the benchmark tunes them (D12). Each PR measures and reports the result. |
| N8 | The spelling fix runs before the conflict policy (today after, on winners only: `M/enhance.ts:641-651`). | Decided 2026-10-17 (owner viewpoint): before, so two spellings of one person join. |
| N9 | Each node could have its own task id, model and preset. | Decided 2026-10-17 (owner viewpoint): two task ids, `meetingEnhance` and `meetingSummarize`. A new id needs no settings migration (a missing task key means `auto`: `specs/llm-task-profiles.md:478-481`; a new id is a small additive follow-up: `1466-1468`) but needs a registry row (`V/llm-task-profiles.ts:9-16` holds the id list; the row is `LLM_TASK_PROFILES: Record<LlmTaskId, LlmTaskProfile>`, `S/lib/llm/task-profiles.ts:81`, so the type forces one row per id) and a UI row (`specs/llm-task-profiles.md:1120`). Later features add their own id on the generic platform. UNVERIFIED: any gain from a model per node. |
| N10 | Whether oMLX applies a strict schema, also to the reasoning part, is unverified in this repo. | Decided 2026-10-17 (owner viewpoint): a live probe on the owner's local oMLX with Qwen3.8-27B settles it (10). No cloud probe (Q5). |

**Round 2 decisions applied here (2026-10-17).** Q1 no flag, old files go with the route switch (11.5), council first (12). Q2 chain (4.5). Q5 no cloud proof. Q9 (4.0.2). Q11, Q12 (4.5.6, 4.6.1). Q13 (4.1 P11). Q16 (path key). Remix removal (4.0.1).


### 4.8 Unverified in this section

Marked UNVERIFIED in the text: 4.0.5 (CJK token estimate, starting values), 4.0.6 and 4.3.4 (oMLX stop-at-limit, strict schema, `thinking_budget`), 4.3.2 (S2.3 without capital letters), 4.3.5 (proposal size), 4.4.1 (curly apostrophes in the owner's ASR), 4.4.3 (share of non-English meetings). No cloud provider has a live proof (Q5), so every cloud behavior here is UNVERIFIED beyond scripted-model tests.

---

## 5. LLM gateway contract

The gateway is the one module that sends every LLM request of the meeting workflow. Its one entry point is `callStructured`. One call sends one request. The gateway never loops. It is new code (none at baseline `c47cd80d`). It serves the three LLM nodes of section 4, builds no prompts and writes no meeting data (sections 4, 7, 8). It imports no LangGraph (3.1) and no LiteLLM module (D9); a user-run LiteLLM proxy is one more `server` endpoint.

**Generic platform layer (decided 2026-10-17, owner round 2, Q16).** The gateway is the base for later agentic features. Every file of this section is domain-agnostic, lives in `LLM/` (`apps/server/src/lib/llm/`) and imports no meeting module. Each call and record carries a `scope` (for example `meeting`) and a `scopeId`. Meeting code supplies step ids, task ids and schemas. A later consumer adds its own ids to the same unions.

Dictation cleanup (`L/post-process.ts:223-250`) keeps its own call and lane lease; section 6 only moves it to AI SDK v7. The Remix quick edit (`L/remix-transform.ts:127-132`) and agent (`L/remix-agent.ts:95-103`) are removed in their own work package (decided 2026-10-17). This section does not touch them. Files in `LLM/`: `gateway.ts`, `gateway-errors.ts`, `model-profiles.ts`, `call-record.ts`, `call-unit.ts` (5.6), `recorder.ts` and `record-read.ts` (7.7, 8.3).

**Keys.** Repo paths at `c47cd80d`: `S`=`apps/server/src`, `L`=`S/lib`, `LLM`=`L/llm`, `M`=`L/meetings`, `V`=`packages/validations/src`, `STT`=`packages/stt/src`, `E`=`apps/electron/src`. `SDK7`=`https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages` (commit of `ai@7.0.143`). `LGJS`=`https://github.com/langchain-ai/langgraphjs/blob/main/libs`. `AI6`=`/Users/maheidem/Documents/dev/openstyle/node_modules/.pnpm/ai@6.0.191_zod@4.4.3/node_modules/ai/dist/index.mjs`. `AI`=`https://ai-sdk.dev/docs`, `OAI`=`https://developers.openai.com/api/docs/guides`, `ANT`=`https://platform.claude.com/docs/en/build-with-claude`, `OR`=`https://openrouter.ai/docs`. `W`=`M/workflow`, planned: it does not exist at `c47cd80d` (3.1, 11.5). `LT`=`.claude/skills/live-testing/SKILL.md`.

---

### 5.0 What the gateway replaces

Current state: 2.1.4 and P3, P4, P12 in 2.3. A meeting call has no finish reason (`M/llm-call.ts:46-55`). A `content-filter`, `error` or `other` result with text passes as success (`STT/post-process.ts:148-176`). `generateText` sets no `maxRetries` (`STT/post-process.ts:125-137`; reached through `postProcess`, `M/llm-call.ts:136`), so the SDK default of 2 applies (`AI6:2739`, `AI6:2653`). No LLM call in `apps` or `packages` sets `maxRetries`; the only other `maxRetries` there are `rmSync` options (`S/routes/transcribe-file.ts:196`, `S/routes/meetings-import.ts:333`).

---

### 5.1 The function `callStructured`

`resolveCallProfile` runs once for each node in `prepare` (4.1 P9). `callStructured` runs once for each request.

**Base types (rule B).** WP2 writes `call-record.ts` and `recorder.ts` before WP3 exists (11.2). So WP2 declares every base type below. WP3, WP5a and WP5b import them and declare none again (check: 11.4). `FailureKind` (4.0.7) extends `GatewayErrorKind`.

```ts
// LLM/call-record.ts (WP2). The only declaration of each type.
import type { LlmParamsLedger, LlmScope } from "@openstyle/validations"; // V/llm-types.ts (WP2)
export type LlmStepId = "correctChunk" | "identifySpeakers" | "summarize"; // a later consumer widens it
export interface ChatTurn { role: "user" | "assistant"; content: string }
export type UnifiedFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
export interface TokenUsage { input: number | null; output: number | null; reasoning: number | null; cached: number | null } // null = unknown (old code writes 0: M/llm-call.ts:45)
export type StructuredMode = LlmParamsLedger["structuredMode"]; // "json_schema_strict" | "json_schema" | "json_tool" | "json_object" | "prompt_only" (7.5)
export type GatewayErrorKind = // the 15 kinds of 5.2.1 and 7.6
  | "length" | "content_filter" | "unexpected_tool_calls" | "abnormal_stop" | "reasoning_leak" | "schema"
  | "model_mismatch" | "cancelled" | "provider_timeout" | "provider_rate_limited" | "provider_unavailable"
  | "provider_auth" | "provider_invalid_request" | "model_unavailable" | "deadline_exceeded";
// CallRecord, RecordedCall and CallSink are in this file too (below).
```

`V/meeting-types.ts` (WP2) declares `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus` (4.4) and `CorrectionDropReason` (4.2). The new `V/llm-types.ts` (WP2) declares `LlmMessage`, `LlmParamsLedger` (7.5), `LlmScope` and the types of 8.4. `V` is a lower package and imports nothing from the server, so `LlmParamsLedger` keeps the literal union of `structuredMode`.

```ts
// LLM/gateway.ts and LLM/model-profiles.ts (WP3). Base types are imported.
export type MeetingLlmTaskId = Extract<LlmTaskId, "meetingEnhance" | "meetingSummarize">;
export interface StepSchema<T> { name: string; version: number; zod: z.ZodType<T> } // D2. name: [A-Za-z0-9_], the wire name. version: stored, not sent
export interface ReasoningPlan { // names: 4.0.5
  mode: "off" | "bounded"; budgetTokens: number; countsInMaxOutput: boolean; maxBudgetTokens: number | null; // budgetTokens 0 when off; null: no token budget
  boundedLevel: "minimal" | "low" | "medium" | "high" | null; control: "none" | "effort" | "toggle" | "budget_tokens" | "template_kwargs";
  force: boolean; // beats a user preset; only the length route sets it (4.0.6)
}
export interface CallProfile { // plain data, no API key, in graph state (3.3)
  taskId: MeetingLlmTaskId; provider: string; modelId: string;
  contextWindow: number | null; maxOutputTokens: number | null; // models.dev limit.context, limit.output; null for `server` and when the registry read fails
  structured: StructuredMode; reasoning: ReasoningPlan;       // start mode (5.4); reasoning (5.5)
  warnings: string[]; // one line each, no prompt text; `registry_unavailable` when the read failed. Copied into `LlmParamsLedger.warnings`
}
export type ReasoningSteps = Partial<Record<LlmStepId, "bounded">>; // a step not in the table reasons off (5.5 rule 4)
export declare const reasoningSteps: ReasoningSteps; // default `{}` until the benchmark shows a gain (D12)
export declare function resolveCallProfile(a: { taskId: MeetingLlmTaskId; step: LlmStepId; maxReasoningTokens: number;
  pin?: { provider: string; modelId: string }; reasoningSteps?: ReasoningSteps }): Promise<CallProfile>; // pin: 4.1 P9. reasoningSteps: test hook, replaces the table
export type ResolvedModels = Record<LlmStepId, CallProfile>;
export declare function resolveModels(a: { maxReasoningTokens: Record<LlmStepId, number>; reasoningSteps?: ReasoningSteps }): Promise<ResolvedModels>; // in `prepare` (4.3.4)
export declare function withReasoningOff(p: CallProfile): CallProfile; // mode "off", force true (4.0.6)
export type CreateModel = typeof createChatModel; // `L/providers.ts:54-58`: (providerId, modelId, taskContext?) => Promise<LanguageModel>
export interface CallStructuredInput<T> {
  step: LlmStepId; // no scope, scopeId or meetingId: the recorder reads them from the run row (7.7 rule 1)
  runId: string; unitKey: string; chunkIndex: number | null; // unitKey: 4.0.7
  schema: StepSchema<T>; instructions: string; messages: readonly ChatTurn[]; // instructions = system text: v7 rejects system-role messages (AI/migration-guides/migration-guide-7-0)
  profile: CallProfile; maxOutputTokens: number; signal: AbortSignal; // maxOutputTokens capped at profile.maxOutputTokens. signal = `ctx.signal` (3.4.5), combined with the call timeout (5.7)
  sink: CallSink; onQueued?: (i: { waitedMs: number; ahead: number }) => void; // lane queue progress for the job blob
  stopped?: () => boolean; // `callUnit` sets `ctx.isStopped()`; read when the lease opens (3.4.5)
  retry?: { kind: GatewayErrorKind; change: RetryChange; validatorMessage?: string }; // `callUnit`, second call only (5.6)
  createModel?: CreateModel; // test seam for step 3 below: a scripted `MockLanguageModelV4`. Production leaves it unset. `callUnit` copies `WorkflowDeps.createModel` (3.4.2)
}
export interface CallStructuredResult<T> {
  object: T; finishReason: "stop"; rawFinishReason: string; usage: TokenUsage; // the gate (5.3) throws for every other reason
  modelRequested: string; modelServed: string | null; // model.modelId (STT/post-process.ts:87-94); null: response names no model. No price (4.5)
  latencyMs: number; queuedMs: number; // wire time (lease to end); lane queue time
  attempt: number | null; // position among recorded calls of (runId, unitKey), from 1, length-route calls included; computed by `recordCall`. null: record write failed (7.7)
  paramsLedger: LlmParamsLedger; structuredMode: StructuredMode; callId: number | null; // null: record write failed (7.7)
}
export declare function callStructured<T>(input: CallStructuredInput<T>): Promise<CallStructuredResult<T>>;
```

**The models.dev read is best effort.** `resolveCallProfile` reads models.dev for `structured_output`, `reasoning`, `limit.context` and `limit.output` (5.4, 5.5, 4.0.5). The read must never stop a run (non-goal "no required cloud service", 1.3). `fetchModelsFromRegistry` returns data only while its 6 hour cache is fresh; otherwise it fetches with a 3 s timeout and throws on a network fault or bad status (`apps/server/src/lib/model-registry.ts:11, 49-73`).

1. **`server` skips the read.** A local server has no models.dev entry; the hand row of 5.4 and 5.5 is enough. Both limits are `null` and the nodes use the constants of 4.0.5.
2. **Other providers read once.** `resolveModels` reads the registry once for its three profiles. If it throws, each profile uses the hand table (first mode of the 5.4 row, hand row of 5.5, `null` limits) and adds the warning `registry_unavailable`. The stale cache is private (`modelsCache`, :49; returned only while fresh, :60-62), so the gateway does not use it.
3. **It never gives `model_unavailable`** (4.1 P9, 5.2.1).
4. **Test.** The registry fetch rejects: a `server` profile resolves and a `server` Enhance runs end to end with no `registry_unavailable` warning. A cloud profile resolves with hand-table values, the warning, and no `model_unavailable` (10.5.3, W14).

**One call.**

1. If `retry` is set, apply its change: add the validator message as a user turn (5.3.5), or read the lower mode from the mode cache (5.4).
2. `resolveTaskCall(taskId, { autoMaxOutputTokens, pin })` gives sampling, preset params and timeout (`LLM/task-profiles.ts:314-410`). Its baseline options hold only `autoMaxOutputTokens` (`:177-179`) and its result has no `droppedKeys` and no `source` (`:166-175`). WP3 adds `pin`, `droppedKeys` and `source` (11.4).
3. Choose the mode (5.4) and the reasoning shape (5.5). Build the model with `input.createModel ?? createChatModel` (`L/providers.ts:54-72`). Wrap it with the capture middleware, also a scripted model, so the capture and gate run on every test path. Steps 2 and 3 run in one `try`; any error becomes the new `ModelUnavailableError` (5.2.1): no model set up, unsupported provider, no API key, or a server removed from the list. The four throw sites keep their plain `Error` (`LLM/task-profiles.ts:334-336`, `L/providers.ts:60`, `:64-65`, `LLM/registry.ts:252-254`); the gateway converts.
4. Take a `background` lane lease with `withLlmLane` (`LLM/lane.ts:506-519`). Today `withLlmLane` does not take `signal`: its `Pick` (`LLM/lane.ts:509`) omits it. Only `acquireLlmLane` accepts `signal` (`LLM/lane.ts:83`). `signal` must join the `Pick` at `LLM/lane.ts:509`. When the lease opens, if `stopped?.()` is true, release it and throw `CancelledError` phase `queued`. No request goes out, `startAttempt` does not run and no record is written.
5. In the lease, start the timeout. Call `generateText` (planned step: no gateway code in the repo makes this call yet; the docs page `AI/reference/ai-sdk-core/generate-text` lists these options) with `maxRetries: 0` (D5), `abortSignal: AbortSignal.any([signal, timeoutSignal])`, `instructions`, `messages`, `output` (`Output.object`, `Output.json` or `Output.text`), sampling, `providerOptions` and `telemetry` (section 9). `Output.object` has no strict switch (`AI/reference/ai-sdk-core/output`); strictness comes from the provider option (5.4). The gateway passes `step.schema.zod` unchanged and runs no schema step of its own (4.0.3 rule 7). For the record it stores `await asSchema(step.schema.zod).jsonSchema` as `schema_json`. Run the gate (5.3).
6. Write the record with `sink.recordCall` (7.7). Return the object or throw one typed error (5.2).

**Capture middleware.** A `wrapLanguageModel` middleware (`wrapGenerate`, receives `doGenerate` and `params`: `SDK7/provider/src/language-model-middleware/v4/language-model-v4-middleware.ts:60-65`) copies `finishReason` (`{ unified, raw }`), `response.modelId`, `response.body`, `request.body`, `warnings`, the text parts of `content` and `usage` from the `doGenerate` result before the SDK parses. Types: result `SDK7/provider/src/language-model/v4/language-model-v4-generate-result.ts:11-63`; finish reason `.../language-model-v4-finish-reason.ts:8-33`; `response.modelId` `.../language-model-v4-response-metadata.ts:15`. The result has no top-level `text`; text is in `content` parts with `type: "text"` (`.../language-model-v4-text.ts:7-13`). The docs page `AI/ai-sdk-core/middleware` documents only `content`, so the type files are the source. `NoObjectGeneratedError` has no raw finish reason (`AI/reference/ai-sdk-errors/ai-no-object-generated-error`). If `doGenerate` throws, the gateway reads the `APICallError` (5.2).

**Call record seam.** Section 7 owns the table `llm_calls`. The gateway sees only this interface.

```ts
// LLM/call-record.ts (WP2 writes the file; WP3 fills the record). The gateway imports only this file for records.
export interface CallRecord { // one call, built after it ends. Each field maps to a column of `llm_calls` (7.4)
  runId: string;                         // run_id. No scope, scopeId or meetingId: `recordCall` copies scope and scope_id from the run row. No `meeting_id` column: delete-with-meeting runs through `llm_runs.meeting_id` (D10, 7.4)
  unitKey: string;                       // step_key
  node: LlmStepId;                       // node
  retryReason: string | null;            // retry_reason: `input.retry.kind` on the second call, else null
  provider: string | null; modelRequested: string | null; modelServed: string | null; // provider, requested_model, served_model
  instructions: string; messages: readonly ChatTurn[]; // messages_json: [{ role: "system", content: instructions }, ...messages]
  schema: { name: string; version: number; json: unknown }; // schema_name, schema_version, schema_json (4.0.3 rule 7)
  params: LlmParamsLedger;               // params_json (7.5), holds the structured mode
  rawText: string | null; parsed: unknown | null; reasoningChars: number | null; // raw_text, parsed_json, reasoning_chars
  finishUnified: UnifiedFinishReason | null; finishRaw: string | null; // finish_unified, finish_raw
  usage: TokenUsage;                     // input_tokens, output_tokens, reasoning_tokens, cached_tokens
  queuedMs: number | null; latencyMs: number | null; // queued_ms, latency_ms
  errorKind: GatewayErrorKind | null; errorDetail: string | null; // error_kind, error_detail (5.8: no prompt or answer text)
  startedAt: number; finishedAt: number; // started_at, finished_at (epoch ms)
}
// `attempt` is not a field. `recordCall` computes it in the INSERT statement: rows with the same `run_id` and `step_key`, plus 1. An unrecorded call does not count.
export interface RecordedCall { id: number; attempt: number }
export interface CallSink { // the recorder of 7.7 implements it. One phase: one row, after the call
  startAttempt(a: { runId: string; stepKey: string }): void; // before each request: llm_run_steps.attempts += 1
  recordCall(c: CallRecord): RecordedCall | null; // after the call ends, also for every error and cancel. null: the write failed
}
```

A call in flight at process death leaves no row. `step_key` is the `unitKey` (7.4). The gateway sets `callId` and `attempt` of `CallStructuredResult` and `CallFacts` (5.2) from the `RecordedCall`, or `null` when `recordCall` returns `null`. A sink failure never fails the call. This rule is new (`recordCall`, `CallSink` and `llm_calls` appear nowhere in `apps` and `packages` at `c47cd80d`). Nearest baseline rule: the Enhance auto-run catch logs a failure and leaves the meeting status unchanged (`S/routes/meetings.ts:1118-1131`, rule `:1128-1130`). The gateway logs the error kind only. A node counts a `null` id with `ctx.recordLost()`, and `save` writes no link for it (7.7).

**Param ledger.** Goal G8: the ledger equals the captured body (L2). `LlmParamsLedger` (7.5) holds `topLevel`, `extraBody`, `dropped`, `source`, `capturedFrom`, `warnings`, `structuredMode`. The gateway fills it and sets `dropped.reason` from this set:

```ts
type LedgerDropReason = "denylist" | "not_in_safe_subset" /* cloud never gets this preset key */ | "sdk_unsupported" | "no_reasoning_control";
```

For `server`, the fetch wrapper `createSamplingFetch` merges the sampling into the body (`LLM/registry.ts:156-167`). The wrapper gets `taskContext.sampling` from the `server` wiring (`LLM/registry.ts:270-273`; `LlmTaskContext` is a parameter at `:44`). A new `LlmTaskContext` callback that hands the merged body to the gateway is planned (none at baseline; the merge is in the wrapper, not in the context type) (`:19-22`). Other providers use `request.body` from the capture. The ledger removes `messages`, `system`, `contents` and schema bodies. `dropped` comes from `stripDenylistedKeys` (debug log only today: `LLM/task-profiles.ts:249-265`), the cloud safe subset (`V/llm-task-profiles.ts:218` `SAFE_SUBSET_KEYS`; `LLM/task-profiles.ts:371-376` keeps only `temperature` and `top_p` for cloud providers; the denylist drop is at `:345`) and SDK `warnings`. Both built-in presets carry `stream: false` (`V/llm-task-profiles.ts:92`, `:113`; comment `:73-77`) and the denylist drops it (`:199-206`). Today that drop leaves one debug log line naming the key (`LLM/task-profiles.ts:261-263`) and no record. The ledger adds the record.

---

### 5.2 Typed errors

The gateway throws a subclass of `GatewayError`. Code, UI and inspector use `kind`, never the message. `FailureKind` (4.0.7) adds five values to the 15 kinds: `budget_exceeded`, `empty_input`, `save_failed`, `internal` and `transcript_changed` (run-level, set by the runner, 3.4.7). The code form of the routing table (5.2.1) is `Record<GatewayErrorKind, ...>`, so a new kind fails the type check until it has a route.

```ts
export type RetryChange = "none" | "add_validator_message" | "downgrade_mode"; // SchemaError; 5.4
export interface RetryAdvice { change: RetryChange; waitMs: number } // waitMs at most 60 000
export interface CallFacts { callId: number | null; step: LlmStepId; unitKey: string; attempt: number | null; finishReason: UnifiedFinishReason | null;
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

`validatorMessage` holds zod paths and messages only, at most 500 characters, no echoed values. `ProviderError` and `ModelUnavailableError` are new classes. `ProviderError.detail` is the provider message cut to 200 characters, in the shape of baseline `failureDetail`: error name, colon, message, cut at 200 (`M/enhance.ts:166-170`).

#### 5.2.1 Routing table

What the graph and node do for each error (D4, L3). `callUnit` (5.6) is the only retry layer.

| Error | Raised when | `callUnit` retry, then next |
|---|---|---|
| `LengthError` | Unified `length` (`where: "output"`); `NoObjectGeneratedError` with `finishReason: "length"`; HTTP 413, or HTTP 400 with an input-overflow phrase (`where: "input"`, below) | No. Length route (4.0.6; `input` skips `lowerReasoning` and `raise`), then fail the unit. |
| `ContentFilterError` | Unified `content-filter`; OpenAI `refusal` field with finish reason `stop` | No. Fail the unit. |
| `UnexpectedToolCallsError` | Unified `tool-calls` (nodes send no tools) | No. Fail the unit. |
| `AbnormalStopError` | Unified `error` or `other`; unified `stop` with a raw reason outside the alias set (5.3) | Cause `error` or `other`: once, same input, 1 s plus jitter, then fail. Cause `unknown_raw` or `missing_raw`: no retry. |
| `ReasoningLeakError` | `<think>` tag in the text, or empty text with reasoning (5.3) | No. Reasoning on: length route step 1 (`withReasoningOff`). Off: fail (5-P6). |
| `SchemaError` | Invalid JSON, or zod rejects; finish reason `stop` | Once; the next call adds the validator message as a user turn (L3). Then fail. |
| `ModelMismatchError` | Served model differs from requested (5.3.4) | No. Fail (L4). |
| `ProviderError` `timeout` | Timeout fires, or HTTP 408 | Cloud: once. `server`: no (5-P2). Then fail. |
| `ProviderError` `rate_limited` | HTTP 429 | Once, after `Retry-After`, at most 60 s; more: no retry (5-P3). Then fail. |
| `ProviderError` `unavailable` | HTTP 409 or 5xx; network failure before any response | Once, 1 s plus jitter. Then fail. |
| `ProviderError` `auth` | HTTP 401 or 403 | No. Fail. |
| `ProviderError` `invalid_request` | HTTP 400, 404, 422 (not an input overflow) | Once with `downgrade_mode`, only if the body names `response_format`, `json_schema` or `schema` and a lower mode exists (5.4). Else fail. |
| `CancelledError` | `signal` aborted (queued: lane threw `LlmLaneCancelledError`; in flight: abort reached the request) | No. Unit status `cancelled`, not a failure. |
| `DeadlineExceededError` | `signal` aborted and `signal.reason.name` is `TimeoutError` (Summarize job ceiling, 3.4.5, 5.7) | No. Fail the unit. The run stops. |
| `ModelUnavailableError` | Step 2 or 3 of 5.1 throws. No request was sent | No. Fail the unit. Run-wide. `message` names Settings > Models, `detail` holds the original message. |

- **Run-wide** (`runWide`): `provider_auth`, `model_mismatch`, `model_unavailable`, `provider_invalid_request` (not a mode rejection), `abnormal_stop` with cause `unknown_raw` or `missing_raw`, and `reasoning_leak` with reasoning off. The first one calls `ctx.stopRun` (3.4.5); no other unit starts a call. Any other cause that hits every unit (a persistent `length` or `schema` failure) stops the node after `BREAKER_N` failures in a row (3.4.5).
- Any other HTTP status: the spec maps SDK flag `isRetryable` true to `unavailable` and false to `invalid_request` (spec rule, `specs/meeting-enhance-agentic.md:1867`; no matching code in `apps/server/src`). The SDK defines only the boolean flag, default true for 408, 409, 429 and 5xx (`@ai-sdk/provider@3.0.14` `src/errors/api-call-error.ts` in `/Users/maheidem/Documents/dev/openstyle/node_modules/.pnpm`; the `SDK7` path is not present, v7 UNVERIFIED). The message never holds `requestBodyValues` (4.0.7). `Retry-After`: read `retry-after-ms`, then `retry-after` (`ai@6.0.191` `src/util/retry-with-exponential-backoff.ts:32-40` in `/Users/maheidem/Documents/dev/openstyle/node_modules/.pnpm`: `retry-after` is read only when the ms value is still undefined; the `SDK7` file is not installed, v7 UNVERIFIED).
- Input overflow becomes `LengthError` `where: "input"`: HTTP 413, or HTTP 400 with `prefill_memory_exceeded` (oMLX, `/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:129`), `context_length_exceeded` or `maximum context length` (the last two UNVERIFIED). A reviewer adds a phrase per provider after a live error (W13). For `server` the fit check is skipped (4.0.5), so this error is the only guard.
- With `maxRetries: 0` the SDK rethrows the raw error, by source reading (v6.0.191: `ai@6.0.191` `src/util/retry-with-exponential-backoff.ts:107-108` in `/Users/maheidem/Documents/dev/openstyle/node_modules/.pnpm`, also `AI6:2675-2677`; the `SDK7/provider-utils` file is not installed, v7 UNVERIFIED). The docs page `AI/reference/ai-sdk-errors/ai-retry-error` does not cover it. UNVERIFIED by a run.

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

v7 parses when the finish reason is `stop`, and also when it is not `tool-calls` and the text is not empty (`SDK7/ai/src/generate-text/generate-text.ts:1614-1630`, UNVERIFIED: v7 source is not installed; v6.0.191 parses only for `stop`: `AI6:4729`; section 6). So `length`, `content-filter`, `error` and `other` with valid JSON return normally, and the gate reads the capture. `result.output` is a getter that throws `NoOutputGeneratedError` when no output exists (`AI/reference/ai-sdk-errors/ai-no-output-generated-error`). Never write `const { output } = await generateText(...)`. Read `output` last. After the gate chose an error, read it in a `try`; an object there is kept as `parsed_json` (section 7, D4).

#### 5.3.2 Known stop aliases

The gate accepts one raw value per provider and mode. Unified `stop` alone is not enough. A null or unknown reason becomes `other`. Sources under `SDK7/`: `openai/src/chat/map-openai-finish-reason.ts`, `groq/src/map-groq-finish-reason.ts:3-19`, `anthropic/src/map-anthropic-stop-reason.ts`, `google/src/map-google-finish-reason.ts`, `mistral/src/map-mistral-finish-reason.ts`.

| Alias key | Used for | Accepted raw | Also mapped to `stop`, rejected by the gate |
|---|---|---|---|
| `openai_chat` | `openai`, `vercel`, `openrouter`, `server` (all `createOpenAI().chat`) | `stop` | none |
| `groq` | `groq` | `stop` | none |
| `anthropic_output_format` | `anthropic` with `output_config.format` | `end_turn` | `stop_sequence` (nodes send none), `pause_turn` |
| `anthropic_json_tool` | `anthropic` with the forced `json` tool | `tool_use` | `pause_turn`, `end_turn` |
| `google` | `google` | `STOP` | none |
| `mistral` | `mistral` | `stop` | none |

`pause_turn` means the client must continue the turn (`ANT/handling-stop-reasons`); the nodes cannot. UNVERIFIED: the native OpenRouter set and the raw values of Ollama, LM Studio and llama.cpp. The page `OR/api/reference/overview` lists only the normalized `finish_reason` set and says the raw value is in `native_finish_reason`, without native values. An unknown raw gives `AbnormalStopError` `unknown_raw`. A reviewer adds valid values. The table fails closed on purpose (R5-1). Behind a user-run LiteLLM proxy step 2 adds no safety, because the proxy maps `error` and unknown values to `stop` (https://github.com/BerriAI/litellm/blob/caad4d62045e76c1a8428ab8f316d351ca9a0a7e/litellm/litellm_core_utils/core_helpers.py).

#### 5.3.3 Reasoning leak

`detectReasoningLeak` runs after steps 1 and 2. Rule 1, `think_tag`: the text matches `/<\s*\/?\s*think\s*>/i` (`STT/text.ts:53`). The gateway reuses the pattern (WP3 exports `THINK_TAG` from `packages/stt/src/text.ts` and `index.ts`, 11.4) and does not call the sanitizer, which hides the leak (`STT/text.ts:74-88`). Rule 2, `empty_content_with_reasoning`: the text is blank and the body shows reasoning (`choices[0].message.reasoning_content` or `.reasoning` has text, or `usage.reasoning` above 0). The gateway reads the raw body, because `@ai-sdk/openai` `.chat` does not read `reasoning_content` (`SDK7/openai/src/chat/openai-chat-language-model.ts`; UNVERIFIED for 3.0.65).

#### 5.3.4 Served model

`modelMatches(requested, served)` is true when: the ids are equal ignoring case; or the served id is the requested id plus one date or version suffix (`-20250929`, `-2024-07-18`, `-v2`); or the requested id ends with `-latest` and the served id is its base plus such a suffix. Any other pair is a mismatch. No model name in the response: pass, with `modelServed: null` and a warning. The rule is proposal 5-P4, UNVERIFIED against live ids (section 10 records them first).

#### 5.3.5 Parse

- Modes `json_schema_strict`, `json_schema`, `json_tool`: the SDK parses with `Output.object`. A failure is `NoObjectGeneratedError` with a `JSONParseError` or validation `cause`; the gate maps it to `SchemaError` `stage` `json` or `schema`.
- Modes `json_object`, `prompt_only`: the gateway runs `JSON.parse` and `zod.safeParse`. It removes one outer code fence first and nothing else (the SDK parser has no such cleanup: `SDK7/ai/src/generate-text/output.ts`). It never cuts JSON out of free text (`extractJsonObject` has no replacement: `M/enhance.ts:232-246`).
- Retry prompt: "Your last reply was not valid. Problem: `<validatorMessage>`. Return the corrected JSON only." It does not echo the bad answer.

---

### 5.4 Structured-output mode for each provider

The mode comes from the provider, the model and a cache. Every mode ends in the same gate (5.3). `md` = models.dev `structured_output`. Registry lines are in `LLM/registry.ts`. SDK wire facts: `SDK7/openai/src/chat/openai-chat-language-model(-options).ts` (`.chat` sends `response_format: json_schema` with `strict: true`; no schema gives `json_object`), `SDK7/groq/src/groq-chat-language-model.ts` and `SDK7/google/src/google-language-model.ts` (option `structuredOutputs`), `SDK7/anthropic/src/anthropic-language-model.ts` (`structuredOutputMode`), `SDK7/mistral/src/mistral-chat-language-model.ts` (`strictJsonSchema` default false).

| Provider (registry) | First mode (detection) | Lower modes |
|---|---|---|
| `openai` (`:172-178`; `createOpenAI(...).chat` at `:175-176`; prefix detection is in `getLlmProvider`, `:285-292`), `openrouter` (`:220-227`), `vercel` (`:232-239`): all `createOpenAI(...).chat` | `json_schema_strict` (md; for `openrouter`, md of the OpenRouter entry). `vercel` with an unsupported model: UNVERIFIED | `json_object`, `prompt_only` |
| `groq` (`:179-193`) | `json_schema_strict` on the strict list (a new allowlist constant in the gateway; the switch at `:72-97` is the reasoning-options switch, not this list), else `json_object` | `json_object` (`structuredOutputs: false` drops the schema), `prompt_only` |
| `anthropic` (`:195-199`) | `json_schema` (`output_config.format`) if the SDK model table says so, else `json_tool` (forced tool `json`). UNVERIFIED for models newer than `ai@7.0.143` | `json_tool`, `prompt_only` |
| `google` (`:202-206`), `mistral` (`:209-213`) | `json_schema` (md); `mistral` is not strict | `json_object` (`structuredOutputs: false`), `prompt_only` |
| `server`: `createOpenAI({baseURL, fetch}).chat` (`:245-275`) | `json_schema_strict` (cache of the first 400 per server and model) | `prompt_only`. It skips `json_object`: LM Studio rejects it (`git -C /Users/maheidem/Documents/dev/llm_benchmarks show 48bc3f7`) |

- `server` keeps the custom fetch (Option A, no new package). OpenRouter needs a new fetch wrapper that adds `provider: { require_parameters: true }`. UNVERIFIED: what the API returns when no endpoint qualifies (nearest entry: a 503 for an unmet routing requirement, https://openrouter.ai/docs/api-reference/errors). One live call settles it.
- Groq strict `json_schema`: `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `meta-models/muse-spark-open`. Best effort adds `openai/gpt-oss-safeguard-20b`. Others: JSON Object Mode only (https://console.groq.com/docs/structured-outputs). A code constant, UNVERIFIED over time.

**Mode resolution.** (1) Start with the first mode of the row. (2) Read `structured_output` from models.dev (https://github.com/sst/models.dev), cached 6 hours (`L/model-registry.ts:50` TTL, `:53-55` freshness, `:64-66` fetch, `:71` cache write). Extra keys are allowed (`:22`). `false` starts one mode lower. A missing key keeps the first mode. `server` skips this read; a failed read keeps the first mode with the warning `registry_unavailable` (5.1). (3) If the mode cache has `provider|serverId|modelId`, use it. (4) Send the call. If the provider answers 400 and the body names `response_format`, `json_schema` or `schema`, write the next lower mode to the cache and throw `ProviderError(invalid_request)` with `retry.change = "downgrade_mode"`.

- The cache is in memory. A restart costs one fast 400 per server and model. There is no probe request, so the owner's oMLX gets no extra traffic. The 400 text differs by server and the regex can miss it (UNVERIFIED for all five local server types; R5-3).
- Schema rules for authors: 4.0.3. `assertPortableSchema(zodSchema)` converts with `asSchema(zodSchema).jsonSchema` (4.0.3 rule 7) and is checked in a unit test on every step schema. The gateway changes no schema at run time. It adds: no recursion or `$ref` cycle (`ANT/structured-outputs`; a bad `$ref` makes llama.cpp return 400 for every message: `/Users/maheidem/Documents/dev/pi-coder-management/custom-extensions/model-discovery/schema-repair.ts:5-26`). Live proof: section 10 (L6).
- **Degraded modes.** In `json_object` and `prompt_only` the transport does not enforce the shape. The gateway adds to `instructions`: "Return one JSON object that matches this JSON Schema. Return no other text." plus the schema text (4.0.4). `json_object` uses `Output.json()`, `prompt_only` uses `Output.text()`. The record shows the mode.

---

### 5.5 Reasoning profile

A profile says how to disable or bound reasoning for one provider and model (D3). Rules: (1) Send the setting on every call where a documented off switch exists (L2). (2) A hand table keyed by provider and model pattern gives the wire shape, starting from models.dev `reasoning` and `reasoning_options` (https://github.com/sst/models.dev). A hand row wins. (3) The gateway sets `providerOptions` and leaves the v7 top-level `reasoning` unset (5-P5), because a provider setting overrides it without a warning (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/content/docs/08-migration-guides/23-migration-guide-7-0.mdx#L1437-L1443). (4) `correctChunk` and `summarize` ask for off. `identifySpeakers` can ask for a bounded budget (4.3.4). `reasoningSteps` (`model-profiles.ts`, WP3) lists the steps where reasoning may be on; it is `{}` until the section 10 benchmark shows a gain (D12). `resolveCallProfile` gives mode `bounded` when the step is in the table and the table below has a bounded shape for the provider and model; otherwise `off`. The optional argument `reasoningSteps` of `resolveCallProfile` and `resolveModels` replaces the table for that call. It is the test hook for LR4, LR6, LP3 and LP7 (10.8, 10.12). Production code never passes it.

`ReasoningPlan` facts: `countsInMaxOutput` and `maxBudgetTokens` feed the 4.0.5 budget formula. "In limit" means reasoning tokens use the output limit, so an undersized limit ends in `length` with empty content. An effort-only provider cannot enforce a token bound: its `budgetTokens` is the `maxReasoningTokens` argument, a planning value, and the length route covers an overrun. OpenAI reports reasoning tokens in `usage.outputTokenDetails.reasoningTokens` (UNVERIFIED for Anthropic, Google, Groq, Mistral).

| Provider | Off (default) | Bounded | In limit |
|---|---|---|---|
| OpenAI `.chat` | `providerOptions.openai.reasoningEffort: "none"` if models.dev lists `none`, else the lowest listed; no option if `reasoning: false`. Some models reject `none` (`OAI/reasoning`) | `boundedLevel` low, medium, high | Yes (`OAI/reasoning`) |
| Anthropic | `providerOptions.anthropic.thinking: { type: "disabled" }` | Claude 4.7+: `{ type: "adaptive" }` + `effort`. Earlier: `{ type: "enabled", budgetTokens }`, minimum 1024. A wrong type gives 400 (`ANT/extended-thinking`) | No: the SDK adds the budget on top of `max_tokens` |
| Google | `providerOptions.google.thinkingConfig` (beats generic `reasoning`). Gemini 3: lowest listed `thinkingLevel` (3.1 Pro cannot turn thinking off: send `low`, record the level). Gemini 2.5: `thinkingBudget: 0` where models.dev lists `budget_tokens` with `min` 0 | `thinkingLevel` or `thinkingBudget` | Yes, UNVERIFIED which limit: the page says `max_output_tokens` caps thinking plus output together (https://ai.google.dev/gemini-api/docs/thinking) |
| Groq | Existing `groqCleanupProviderOptions` (`LLM/registry.ts:72-97`): `qwen/qwen3-32b` gets `reasoningFormat: "hidden"`, `reasoningEffort: "none"`; `openai/gpt-oss-20b`, `-120b` get `"hidden"`, `"low"` (cannot disable). No rule for `qwen/qwen3.8-27b`: UNVERIFIED until one live call | `reasoningEffort: "medium"` for both families. Branch at `LLM/registry.ts:83`, `:91` (comment `:68-70`: only a task profile or override with `reasoningEnabled: true` reaches it). All four task profiles set `reasoningEnabled: false` (`LLM/task-profiles.ts:84, 91, 98, 113`). The hook runs with `reasoningEnabled` false for every profile (`LLM/registry.ts:186-187`; `L/post-process.ts:244`), so Groq calls for `qwen/qwen3-32b` and `gpt-oss` do reach the false arms of the switch. Only the `true` arm is unreachable at baseline. New only for the meeting caller; dictation and Remix keep using the function | UNVERIFIED |
| Mistral | `providerOptions.mistral.reasoningEffort: "none"`. The page https://docs.mistral.ai/capabilities/reasoning/ lists `reasoning_effort` (`high`, `none`) for `mistral-small-latest`, `mistral-medium-3-5` and `mistral-large-4-0`, and `low`, `high`, `max` for `zai-glm-5-3`. It names the Magistral models as native reasoning models (deprecated). SDK enum `high` or `none` (`SDK7/mistral/src/mistral-chat-language-model-options.ts:85`): UNVERIFIED, the SDK7 file is not installed | `"high"` | UNVERIFIED |
| OpenRouter | Body `reasoning: { effort: "none" }`, written by a fetch wrapper. No top-level `reasoning_effort` is documented (`OR/guides/best-practices/reasoning-tokens`) | `reasoning: { effort }` or `{ max_tokens }`. Reply text is in message field `reasoning` (`reasoning_content` alias) | Yes, on most providers (same page) |
| Vercel AI Gateway | UNVERIFIED. No control is sent | UNVERIFIED | UNVERIFIED |
| `server` (local Qwen) | `chat_template_kwargs.enable_thinking: false`, written by the custom fetch (Option A). `resolveTaskCall` seeds it (`LLM/task-profiles.ts:356-369`); `mergeSamplingIntoBody` writes it last (`LLM/registry.ts:112-143`) | `enable_thinking: true` + `reasoning_effort`, top-level `thinking_budget` (UNVERIFIED for a direct oMLX call) | UNVERIFIED for Qwen: `M/summarize.ts:56-63` and `M/enhance.ts:484-490` describe hidden thinking tokens of a reasoning-capable model and name no Qwen. The default profile sets reasoning off (`LLM/task-profiles.ts:98`, `:113`, seeded at `:362`); a preset can override it |

SDK sources (UNVERIFIED: no `SDK7` path exists locally, so none was checked): `SDK7/openai/src/chat/openai-chat-language-model-options.ts`, `SDK7/anthropic/src/anthropic-language-model.ts`, `SDK7/google/src/google-language-model.ts`, `SDK7/mistral/src/mistral-chat-language-model-options.ts`.

#### 5.5.1 Local Qwen through the custom fetch (Option A)

`createOpenAI().chat` drops `chat_template_kwargs` from `providerOptions`, so the custom fetch writes it into the body (`LLM/registry.ts:99-111`). The reasoning text is `message.reasoning_content`; the SDK does not read it (`L/trace.ts:184-204`). The wrapper treats `max_tokens` as a floor, so a limit raised by the length route reaches the wire (`LLM/registry.ts:127-138`).

#### 5.5.2 Precedence

Rank 1, the gateway: `response_format`, `model`, `messages`, a plan with `force: true`, a raised `max_tokens`. Rank 2, the user preset or custom object: `temperature`, `top_k`, `chat_template_kwargs` (verbatim for `server`; only `temperature`, `top_p`, `max_tokens` for cloud). Rank 3, the task profile seed: `enable_thinking` from `reasoningEnabled`. Rank 4, SDK defaults.

- Today the wrapper spreads preset keys last (`LLM/registry.ts:125`), so a preset beats the seed (`LLM/task-profiles.ts:361-367`). Rank 1 needs a second pass after that merge: `mergeSamplingIntoBody` gets a third argument `gatewayOverrides` with two parts. `force` holds keys that always win. `bounded` holds keys that win over the seed but not over a key the preset sets. A preset can enable reasoning for `meetingEnhance` and wins, as today. The ledger holds the warning "reasoning on by preset" (open point N5, 4.7).
- **Bounded plan.** Mode `bounded` writes `chat_template_kwargs.enable_thinking: true` and the top-level `thinking_budget` with `plan.budgetTokens`, at rank 1 like `force`, except that a key the preset sets keeps the preset value. These two keys form the `bounded` part. If the preset sets one, the ledger holds a warning that names the key ("reasoning plan overridden by preset: enable_thinking"), as N5 does. The node then uses the effective setting for `reasoningShare` (4.2.5). Where the server reads `thinking_budget` is UNVERIFIED for a direct oMLX call (4.3.4): probes LP3 and LP7 settle it (10.12). A cloud provider has no preset reasoning key, so its bounded plan goes through `providerOptions` only.
- `force: true` is for the length route only. It sets `chat_template_kwargs.enable_thinking` to false and removes `chat_template_kwargs.reasoning_effort` and the top-level `reasoning_effort` and `thinking_budget`. Cloud providers never get a preset reasoning key: their `samplingParams` is empty (`LLM/task-profiles.ts:369`).

#### 5.5.3 Preset denylist

Add these keys to a new set `LLM_MEETING_DENYLIST_KEYS` in `V/llm-task-profiles.ts`. Do not add them to `LLM_PRESET_DENYLIST_KEYS` (`:199-206`: `model`, `messages`, `stream`, `tools`, `tool_choice`, `n`). `resolveTaskCall` strips the old set for every task and the new set only for `meetingEnhance` and `meetingSummarize`. Today it strips the old set for every task id (`LLM/task-profiles.ts:249`, `:345`), so a change to the old set would also change dictation cleanup (1.3). The preset editor takes raw JSON, so a user can type any key. A denied key is dropped at resolve time and shown in the ledger `dropped` with reason `denylist`. Test W2b: a cleanup preset with `stop` still reaches the wire.

- `response_format`: the wrapper spreads preset keys last, so a preset value would replace the SDK schema (`LLM/registry.ts:125`).
- `stop`: a stop sequence ends the answer with finish reason `stop` and can cut the JSON. The gate would see a clean reason.
- `guided_json`, `guided_regex`, `guided_choice`, `guided_grammar`, `structured_outputs`, `grammar`, `json_schema`: these also constrain output on some servers and would fight the gateway schema. The names come from vLLM and llama.cpp style APIs. The list for other servers is UNVERIFIED.

Section 10 tests `response_format`, `stop` and `guided_json` with a live call.

---

### 5.6 Retries

Decided 2026-10-17 (owner round 2, Q9): `callUnit` in `LLM/call-unit.ts` (new file, WP5a, 11.5) is the single retry layer. It allows one retry for each call and applies the one `gatewayRetryOn` rule. No node has a `RetryPolicy`. The AI SDK runs with `maxRetries: 0` and `callStructured` retries 0 times. `callUnit`, `callStructured` and the file do not exist at `c47cd80d` (5.0). Every LLM node calls `callUnit` for every call (D5, L3). The length route (4.0.6) changes the input and is not a retry.

**Why not a node `RetryPolicy`.** LangGraph retries a whole node function (https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance). An LLM node makes many calls in one run: up to 11 for a split chunk (4.0.6) and up to 24 for `summarize` (4.5.3). A node retry would send the finished calls again. The first failing unit would also use the one node retry, and a second unit with a retryable error would throw on the last attempt and stop the run. So the unit is the retry boundary (X7, Q9). The LangGraph default `retryOn` is not enough either (`LGJS/langgraph-core/src/pregel/retry.ts`): it skips abort errors and HTTP 400 to 407 and 409, reads `error.response.status`, then `error.status`, so a 4xx `APICallError` (which has `statusCode`) can be retried (UNVERIFIED by a run, D5), and it retries a `TypeError` from a bug.

```ts
// LLM/call-unit.ts (planned, WP5a). No LangGraph import (3.1). No meeting import.
export function gatewayRetryOn(error: unknown): boolean { // the one retry rule
  return error instanceof GatewayError && error.retry !== null; // anything else is a bug: fail at once
}
export interface UnitContext { signal: AbortSignal; isStopped(): boolean } // the run context of 3.4.5 satisfies it
export interface UnitRecorder extends CallSink { finishedCall(runId: string, unitKey: string): ParsedCall | null } // ParsedCall: 7.7
export interface CallUnitDeps { recorder: UnitRecorder; callStructured: typeof callStructured; createModel?: CreateModel;
  sleep(ms: number, signal: AbortSignal): Promise<void> } // `WorkflowDeps` (3.4.2) holds the same four members
export type UnitInput<T> = Omit<CallStructuredInput<T>, "sink" | "stopped" | "retry" | "createModel">; // `callUnit` sets these four
export async function callUnit<T>(input: UnitInput<T>, ctx: UnitContext, deps: CallUnitDeps): Promise<CallStructuredResult<T>> {
  const done = deps.recorder.finishedCall(input.runId, input.unitKey); // a ParsedCall or null, after a resume
  const reused = done && resultFromParsedCall(done, input.schema.zod); // null when the schema rejects the stored object
  if (reused) return reused;
  const call = { ...input, sink: deps.recorder, createModel: deps.createModel,
    stopped: () => ctx.isStopped() }; // checked when the lease opens (5.1 step 4)
  try { return await deps.callStructured(call); }
  catch (e) {
    if (!gatewayRetryOn(e) || ctx.isStopped()) throw e;
    await deps.sleep(e.retry.waitMs, ctx.signal); // before the lane lease. An abort ends the wait with CancelledError
    return deps.callStructured({ ...call, retry: { kind: e.kind, change: e.retry.change,
      validatorMessage: e instanceof SchemaError ? e.validatorMessage : undefined } }); // a second failure is final
  }
}
```

`callUnit` reads no module-level state. Its only effects come from `deps`, so a test replaces the recorder, gateway, model and wait one by one (3.4.2, 10.2).

Goal G5: a transient error gives 2 requests, `content-filter` 1, an auth error 1, an invalid schema 2. `waitMs` is the advice of 5.2.1 (at most 60 000 ms, jitter included). `sleep` is injectable (`WorkflowDeps.sleep`, WP5a), so a test passes an instant `sleep` or advances fake timers (10.2 rule 4). The retry carries its change in `retry`: no memo, no shared map.

**Call reuse.** `recorder.finishedCall(runId, unitKey)` returns a `ParsedCall` (7.7): the newest `llm_calls` row of that unit key with `error_kind` NULL, a whole `parsed_json` (no cut marker, 7.7 rule 6), a `finish_raw` and a `params_json` that parses. Otherwise `null`. `resultFromParsedCall` parses `ParsedCall.parsed` with the schema again and builds the `CallStructuredResult`: `finishReason` is `"stop"`, `paramsLedger` is `params`, `structuredMode` is `params.structuredMode`, other fields copy across, and it keeps the old `callId` and `attempt`. It returns `null` when the schema rejects the object. A reused call sends no request and writes no row. Reuse is safe only for the same input, which the key grammar and state give (4.0.7). Decided 2026-10-17 (owner round 2, Q13): for Summarize, a confirmed speaker name or a new `enhanced_text` while a run is interrupted makes the resume fail with `transcript_changed` before any call; the user starts a new run. So `callUnit` never reuses a call for a changed transcript. The check belongs to the runner (3.4.7). After a kill, a restarted node sends 0 requests for a finished call (G6). A failed call is not reused, so a resumed split unit repeats its first call once. A lost record (7.7) costs one repeated call.

**Rules for nodes** (sections 3 and 4 follow them).

1. Every LLM call goes through `callUnit`. No node sets `retryPolicy` or `timeout` (3.2 edge rule 7, 5.7).
2. A node catches every error of `callUnit`. A final `GatewayError` becomes a typed `NodeFailure` of the unit, and the node does not throw (3.2 edge rule 5). `CancelledError` becomes kind `cancelled`, or unit status `skipped` when `ctx.isStopped()` is true and `ctx.signal` is not aborted. A final failure with `runWide` calls `ctx.stopRun` (3.4.5).
3. No error leaves a node. `guardNode` (4.0.2) catches the rest. An error that escapes a fan-out node aborts its sibling tasks and stops the run (`LGJS/langgraph-core/src/pregel/runner.ts`).
4. A node catches `LengthError` first, and `ReasoningLeakError` when reasoning was on, and runs the length route (4.0.6) with changed input. Each of those calls goes through `callUnit` and gets its own retry.

---

### 5.7 Timeouts, cancel and lanes

- Timeouts: `meeting_enhance_timeout_seconds` (`correctChunk`, `identifySpeakers`) and `meeting_summary_timeout_seconds` (`summarize`), default 600 s, range 30 to 3600 s. `taskTimeoutMs` reads the setting for each call (`LLM/task-profiles.ts:154-164`; bounds `V/settings.ts:318-320`, `:400-402`). The timeout starts when the lane lease opens, so queue time does not count (`M/llm-call.ts:126-153`). A LangGraph node `timeout` would count it, so the nodes set none.
- The gateway makes `timeoutSignal = AbortSignal.timeout(timeoutMs)` and `AbortSignal.any([signal, timeoutSignal])` (https://nodejs.org/docs/latest-v22.x/api/globals.html). After an abort it checks `signal.aborted` first. If `signal.reason.name` is `TimeoutError`, the caller's deadline fired (Summarize job ceiling, 3.4.5) and it throws `DeadlineExceededError`. Any other reason gives `CancelledError`. If only `timeoutSignal` fired, it throws `ProviderError` `timeout`. Check of 2026-10-17, Node 26.5.0: `AbortSignal.any` keeps the reason of the first signal that fires. UNVERIFIED on Node 22.22.1. A retry waits the full timeout again (5-P2). Today's ceiling is `clamp(perCallMs x plannedCalls, 2 x perCallMs, 4 h)` (`M/summarize.ts:128-154`); the workflow doubles the middle term for one retry for each call (X8, 4.5.3).
- **Cancel.** Today cancel is a polled flag that stops a queued call; an in-flight call finishes (`M/job-registry.ts:58-61`). Section 3 aborts `ctx.signal` on user cancel (3.4.5), so an in-flight request stops at the client. This changes visible behavior. Whether oMLX then stops generating is UNVERIFIED. A queued call stops through the lane `signal` option, which makes the lane throw `LlmLaneCancelledError` (class `LLM/lane.ts:58-63`; throw sites `:357`, `:361`, `:426`, `:460`; the `cancelled()` check at `:412` throws nothing). The gateway turns it into `CancelledError` phase `queued`.
- **Lanes.** Every workflow call takes a `background` lease covering the wire call only. Lane rules: 3.5. Fan-out cap of `correctChunk`: `WORKFLOW_FANOUT_CAP` (3.5 rule 2).
- **Boot probe.** `probeEndpoint(profile, opts?)` lives in `gateway.ts` (WP3); test W15 (10.5.2). The runner reaches it through `WorkflowDeps.probeEndpoint` (3.4.2) before a boot resume (3.4.7). `opts` holds `fetch` and `timeoutMs`, for tests. One request, 3 s limit (`AbortSignal.timeout(3000)`), no API key. Any HTTP status passes (an answer proves the endpoint is reachable). A network error or timeout gives false.
  - `server` profile: `GET <base>/models`. The base is built as the registry builds it: the registry strips an optional trailing `/v1` from `base_url` at read time (`LLM/registry.ts:257`); no write-side normalization exists (`apps/server/src/lib/own-servers.ts:45`), so the stored value is what the user entered, then `/v1` added in `createOpenAI` (`:267`). It is the request of `LT:229` (the `curl` on `/v1/models`), which 10.12 uses.
  - Cloud profile: one `HEAD` on the base URL that the interrupted run already used (decided 2026-10-17, owner round 2, Q15), with no API key and no meeting data. A provider the user pointed at another base URL uses that URL; otherwise the table below.
  - The probe tests the network only. A missing server entry or API key returns true; the resumed run then fails with the typed `model_unavailable` (5.2.1) at its first call, so the boot resume does not wait without an end.

  | Provider | Base URL for the probe | Source |
  |---|---|---|
  | `openai` | `https://api.openai.com/v1` | SDK default (https://unpkg.com/@ai-sdk/openai@3.0.65/dist/index.mjs, line 6940) |
  | `anthropic` | `https://api.anthropic.com/v1` | SDK default (https://unpkg.com/@ai-sdk/anthropic@3.0.79/dist/index.mjs, line 5789) |
  | `google` | `https://generativelanguage.googleapis.com/v1beta` | SDK default (https://unpkg.com/@ai-sdk/google@3.0.79/dist/index.mjs, line 6017) |
  | `mistral` | `https://api.mistral.ai/v1` | SDK default (https://unpkg.com/@ai-sdk/mistral@3.0.37/dist/index.mjs, line 843) |
  | `groq` | `https://api.groq.com/openai/v1` | SDK default (https://unpkg.com/@ai-sdk/groq@3.0.39/dist/index.mjs, line 994); app use `S/lib/groq-http.ts:50` |
  | `openrouter` | `https://openrouter.ai/api/v1` | `LLM/registry.ts:225` |
  | `vercel` | `https://ai-gateway.vercel.sh/v1` | `LLM/registry.ts:237` |

  The five SDK lines were read in the pnpm store of the main checkout (major 3 provider packages, v6 generation). The v7 provider packages (major 4, 6.3) are UNVERIFIED: WP3 reads their defaults before it writes the table. The table is a constant in `gateway.ts`. A provider not in the table returns true.

  **Why a cloud probe.** After a reboot with no network yet, a resumed cloud run fails every unit with `provider_unavailable`. A final unit failure is stored as a result in the graph state, so the run reaches `save`, ends, and the runner deletes its checkpoint (3.4.6 step 5). A later check could not undo that. So the guard must come before the resume (3.4.7).

---

### 5.8 Privacy

Instructions, messages, raw answer text, the parsed object, `requestBodyValues` and `responseBody` of an `APICallError`, and the param ledger go to the local record `llm_calls` only (section 7). They never go to a log, error message, trace log or URL. The record, app log and UI may hold: error kind, step, unit key, call id, status code, token counts, finish reasons, latency. A call record is deleted with its meeting (D10).

- Telemetry: v7 spans hold inputs and outputs by default once an integration is registered (`AI/ai-sdk-core/telemetry`). Nothing is registered until a user sets an endpoint (D8). Prompt text in spans: 9.7 and Q9.2.
- Gap: for `server`, the trace log writes full request and response bodies to `openstyle-trace.log`, always on (`L/trace.ts:10`, `:46-48`, `LLM/registry.ts:265-274`). The gateway does not change it (5-Q1).
- Cloud providers receive the prompt by design. `attendeeNames` does not reach the prompt (`M/enhance.ts:99-104`; rule in 4.0.4). A confirmed speaker name does, in six steps: (1) `resolveSpeakerNames` attaches the name to the segment (`M/speaker-names.ts:49`); (2) `speakerDisplayLabel` gives it priority over the numbered label (`M/merge.ts:366-370`); (3) `loadMergedTranscript` builds the segments (`S/routes/meetings.ts:253-307`; callers `:1089`, `:2114`); (4) Enhance sets the segment speaker with `speakerDisplayLabel` (`M/enhance.ts:387-396`); (5) `formatChunk` (`:219-223`) calls `formatEnhanceLine`, which writes the name into the prompt line (`M/enhance-prompt.ts:119-125`); (6) the user prompt holds the chunk (`M/enhance.ts:500`). The attendee picker suggests attendee names for that field (`E/renderer/src/pages/meetings/speakers.tsx:165`, `:312-318`). So an attendee name can reach a cloud provider after the user confirms it.

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
| 7 | A scripted model per cloud alias row (no live call: Q5) | The scripted served id passes `modelMatches`. The scripted raw reason is in the alias table. Cloud rows stay UNVERIFIED against a live provider |
| 8 | Cancel during a queued call and during an in-flight call | `CancelledError` phase `queued` and `in_flight`. No failure in the UI |
| 9 | Read the call record back from the database after each check | All D10 fields present (goal G7). A write that returned success may have stored nothing |

---

### 5.10 Proposals, risks and open points

Decided 2026-10-17 (owner viewpoint): the owner accepts 5-P1 to 5-P6 as written. No question for the owner is open in this section; 5-Q1 to 5-Q3 are decided (5.11).

| ID | Proposal | Reason |
|---|---|---|
| 5-P1 | Each call gets at most one retry. | Goal G5, D4 |
| 5-P2 | `provider_timeout` is retried once for cloud providers, never for `server`. | A retry doubles the wait. The user can raise the timeout. |
| 5-P3 | A `Retry-After` above 60 s gives no retry. | Waiting minutes holds the run with no gain. |
| 5-P4 | The `modelMatches` rule (5.3.4). | Cloud ids carry date suffixes. |
| 5-P5 | `providerOptions` set by the gateway. The v7 top-level `reasoning` stays unset. | The ledger shows exact wire values (D3). |
| 5-P6 | `ReasoningLeakError` with reasoning off is not retried. | A repeat gives the same result. |

| ID | Risk | Mitigation |
|---|---|---|
| R5-1 | The alias table rejects a valid answer: a provider sends a raw value the table lacks. | The record shows the raw value. One retry runs. A reviewer adds the value. Check 2 covers the local server. Check 7 is scripted, so cloud raw values stay UNVERIFIED. |
| R5-2 | `modelMatches` fails a good call. | 5-P4. The live proof records served ids first. |
| R5-3 | A 400 text for an unsupported schema does not match the regex. | The error stays visible as `provider_invalid_request`. The inspector shows the text. |
| R5-4 | A preset enables reasoning for `meetingEnhance`, and the call needs more output tokens than computed. | Ledger warning. The length route handles `length`. |
| R5-5 | oMLX does not enforce the strict schema (it ignores a forced tool call: peer report `/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/omlx-structured-output-peer-finding.md`, not verified here), or does not stop at the limit. | The gate parses every answer. Section 10 probes it with a live call. |

**Alignment with other sections (applied).** D5 names a custom `retryOn`; `gatewayRetryOn` is that rule, run by `callUnit` as the one retry layer (Q9). 3.2 edge rule 7, Decision (9) of section 3 and 4.0.2 follow 5.6. The gateway strips one outer code fence in `json_object` and `prompt_only`, nowhere else (5.3.5). 7.5 holds `capturedFrom` and `warnings` (5.1). Section 7 stores unknown token counts as NULL, as 5.1 does. The step key is the `unitKey` (7.4, 11.4).

---

### 5.11 Decisions (2026-10-17)

| ID | Decision | Reason |
|---|---|---|
| Q9 | `callUnit` is the single retry layer: one retry for each call, one `gatewayRetryOn` rule, no node `RetryPolicy`, SDK `maxRetries: 0` (5.6). Owner answer. | One layer gives exact request counts (G5). |
| Q15 | A boot resume of a cloud run may send one `HEAD` to the base URL the run already used, with no key and no meeting data (5.7). Owner answer. | A resume with no network would fail every unit and end the run. |
| Q5 | No cloud provider gets a live proof. Check 7 uses a scripted model. Only the owner's local oMLX (Qwen3.8-27B) gets live proofs. Owner answer. | The owner supplies no cloud keys. |
| Q13 | A Summarize resume fails with `transcript_changed` when a speaker name or `enhanced_text` changed (5.6). Owner answer. | A reused call must see the same input. |
| Q16 | The gateway, profiles, errors, `callUnit` and the recorder are generic under `LLM/`. Call rows carry `scope` and `scope_id`, copied from the run row by the recorder; the record and gateway input carry neither, and no `meetingId` (5.1, 7.4). Only `llm_runs.meeting_id` cascades. Owner answer. | They are the base for later agentic features. |
| Remix | Remix is removed in its own work package. This section drops the Remix calls. Owner answer. | The owner will redo Remix on the new platform. |
| 5-Q1 | Decided (owner viewpoint): keep the always-on full-body trace log for `server` unchanged (9.4). | The file is local only; a change is outside this work. |
| 5-Q2 | Decided (owner viewpoint): no test keys. Check 7 is scripted. | Follows Q5. |
| 5-Q3 | Decided (owner viewpoint): do not change `model_fallback` on the owner's oMLX. Check 3 records the served model; the scripted `ModelMismatchError` test covers a swap. | The oMLX is live infrastructure. A silent swap may not show in `model`: UNVERIFIED. |

---

## 6. AI SDK v7 migration

Owner decision D7: move from `ai` 6.0.191 to `ai` 7.0.143 for all code. Decision 2026-10-17 (round 2): WP-R removes Remix first (11.2), so this package (WP1, one PR) touches no Remix code. Sections 4 and 5 use v7 APIs. Path keys: `S` = `apps/server/src`, `E` = `apps/electron/src`, `T` = `apps/server/tests`, `STT` = `packages/stt`, `CI` = `.github/workflows/build.yml`, `REG` = `S/lib/llm/registry.ts`. VERIFIED = read or run on 2026-10-17. UNVERIFIED = the package must check it. URL keys: 6.12. A bare `:N` takes the file named earlier in the row. Lines are for baseline c47cd80d; WP-R shifts some, so find each site by symbol.

### 6.1 Decision and rules

| Rule | Text |
|---|---|
| M1 | WP-R merges first. WP1 merges second, as one PR (11.2). No node, gateway or inspector code lands before WP1. A bump bug and a gateway bug must not mix. |
| M2 | No behavior change: only versions, renamed or removed names, and test mocks. |
| M3 | No new dependency (`@ai-sdk/otel`: section 9; `@ai-sdk/openai-compatible`: section 5). The knip step flags unused dependencies (`knip.jsonc:4-5`; `CI:91-100`). |
| M4 | No `Output`, `maxRetries`, `reasoning`, `rawFinishReason` or telemetry (sections 5, 9). The LLM platform layer (`S/lib/llm/`, section 5) adds them later. |
| M5 | The lock file holds one `ai` version after WP-R (6.0.191) and after the package (7.0.143) (6.7). |
| M6 | Proof: wire-body tests plus a real-app run of dictation cleanup (6.9). |
| M7 | A proof that differs from the baseline stops the package. The coordinator decides. Nobody edits a golden file to pass a test. |

### 6.2 Current state (baseline c47cd80d)

- The lock file holds `ai` 6.0.191 (`pnpm-lock.yaml:91-93, 242-244, 315-317`) and 6.0.240 (`:2890, :7356`). Only `@ai-sdk/react@3.0.242` needs the second (`:5204-5207`). Only the Remix renderer chat uses `@ai-sdk/react` and `ai` in `apps/electron` (VERIFIED: `apps/electron/package.json:34, 42`, used only by `E/renderer/src/components/remix-chat.tsx`). WP-R removes both, leaving 6.0.191. The stt dev dependency `ai` `^6.0.191` (`STT/package.json:53`) resolves to 6.0.191. From which folder the bundler resolves `ai` for stt `dist` is UNVERIFIED: stt has no pkgroll config, and `build` is `pkgroll --minify --clean-dist` (`STT/package.json:31`).
- The app sets no `maxRetries` and uses no `Output`, `generateObject`, `streamObject`, telemetry or `onFinish` on SDK text calls (grep). The default of 2 retries applies.
- **Silent failure path.** The stt `postProcess` catches every model-call error (`STT/src/post-process.ts:124`, `catch` `:168-177`) and returns the raw transcript with `model: null`. The server logs `LLM cleanup failed` and goes on (`S/lib/post-process.ts:261-263`). An SDK incompatibility stops cleanup with no visible error. Proof 6.9 relies on this.

### 6.3 Target versions

Targets are the npm `latest` tags on 2026-10-17 (VERIFIED: `dist-tags.latest` in `NPM <package>`; scoped names use `%2F`).

| Package | Resolved today (`pnpm-lock.yaml:362-434`, all rows except `ai`; the `ai` row is `pnpm-lock.yaml:2884, 2890`) | Target |
|---|---|---|
| `ai` | 6.0.191, 6.0.240 | **7.0.143** |
| `@ai-sdk/openai`, `anthropic`, `google` | 3.0.65, 3.0.79, 3.0.79 | **4.0.96**, **4.0.82**, **4.0.99** |
| `@ai-sdk/groq`, `mistral`, `elevenlabs` | 3.0.39, 3.0.37, 2.0.33 | **4.0.63**, **4.0.66**, **3.0.63** |
| `@ai-sdk/provider-utils` | 4.0.27, 4.0.41 | **5.0.62** |
| `@ai-sdk/provider`, `gateway` (transitive) | 3.0.10, 3.0.14; 3.0.120, 3.0.162 | **4.0.29**, **4.0.116** |

`@ai-sdk/react` has no target (WP-R removes it), so `@ai-sdk/mcp` 2.0.78 (`NPM @ai-sdk%2Freact/4.0.147`) never enters the lock file. `NPM ai/7.0.143` (VERIFIED): Node 22 or later; exact dependencies `gateway` 4.0.116, `provider` 4.0.29, `provider-utils` 5.0.62.

Pin rules (decided 2026-10-17, see 6.11):
- P1. Pin `ai` and `@ai-sdk/provider-utils` to exact versions, no caret. A caret lets `pnpm update` split the copies and hides behavior changes (6.8 row 1).
- P2. Put them in the pnpm catalog (`pnpm-workspace.yaml:16-25`). The server and stt manifests use `catalog:`.
- P3. The stt peers become `ai ^7.0.0` and `@ai-sdk/provider-utils ^5.0.0`.

```yaml
# pnpm-workspace.yaml (add to the catalog, lines 16-25)
catalog:
  "ai": "7.0.143"
  "@ai-sdk/provider-utils": "5.0.62"
```

### 6.4 Per-file checklist

Kinds: required (build or run breaks), rename, type (type-check proves it), test, none (proof covers it). Do not run `npx @ai-sdk/codemod v7` (`GUIDE`): it runs downloaded code.

| # | File and lines | Kind: change and evidence |
|---|---|---|
| 1 | `STT/package.json:47-48, 51, 53` | required: peers `^5.0.0`, `^7.0.0`; dev uses catalog (P2, P3) |
| 2 | `apps/server/package.json:26-31, 36` | required: exact targets of 6.3; `ai` uses catalog |
| 3 | `pnpm-workspace.yaml:16-25` | required: add 2 catalog entries (P2) |
| 4 | `pnpm-lock.yaml` | required: `pnpm install`; run the check in 6.7 |
| 5 | `STT/src/post-process.ts:127` | rename: `system:` to `instructions:`; v7 reads `instructions` (`GH7 ai/src/generate-text/generate-text.ts#L244`); that v7 also reads `system` is UNVERIFIED (no cited line shows `system`; read the raw file). Keep `PostProcessParams.system` (`:39`), line 148 (the `length` decision) and line 151 (reads `result.finishReason` for the error text) |
| 6 | `STT/src/transcribe.ts:3, 41` | rename: `experimental_transcribe as aiTranscribe` to `transcribe as aiTranscribe`. 6.0.191 has no value `transcribe` (`GH6 ai/src/transcribe/index.ts#L1-L2`); v7 has (`GH7 ai/src/transcribe/index.ts#L5`) |
| 7 | `STT/src/post-process.test.ts:4-26` | test: v3 fake. Keep green first (v7 accepts v3), then use `MockLanguageModelV4` from `ai/test` (`UNPKG ai@7.0.143/dist/test/index.d.ts`) |
| 8 | `REG:1, 75` | rename: `GroqLanguageModelOptions` to `GroqLanguageModelChatOptions` |
| 9 | `REG:204-205` | rename: `createGoogleGenerativeAI` to `createGoogle` |
| 10 | `apps/server/scripts/benchmark-post-process.ts:5, 164-171`; `tone-benchmark.ts:31, 377-384` | rename: `system:` to `instructions:` |
| 11 | `REG:156-203, 206-277`; `S/lib/groq-http.ts:1-2, 31-34`; `S/lib/providers.ts:1`; `S/lib/streaming/utils.ts:3, 9-11, 43, 49`; `S/lib/streaming/providers/{openai.ts:2,26; groq.ts:1,13; elevenlabs.ts:2,121-125}`; `S/lib/post-process.ts:228`; `S/lib/meetings/llm-call.ts:136`; `T/llm-task-profiles.test.ts:493-560`; `T/server-provider.test.ts:238-255`; `T/trace.test.ts:299-340` | none or type: no edit. The `.chat(...)` calls and the sampling fetch (6.8 row 6) stay. Type-check, the canary tests (real SDK, `fetch` spy) and the wire tests cover this row |
| 12 | `T/openai-cloud-provider.test.ts:11-21` | test: mock `transcribe`, not `experimental_transcribe` (row 6) |
| 13 | `T/ai-sdk-wire.test.ts` (new) | test: wire-body tests (6.9.2) |

WP-R owns all Remix renames (`remix-transform.ts`, `remix-agent.ts`, `remix-chat.tsx`), the `S/lib/llm/lane.ts` comment edit and the `@ai-sdk/react` and electron `ai` manifest edits. Other API facts: 6.8.

### 6.6 Module format

The app ships CJS bundles. v7 is ESM only. The bundler joins them.

- F1 (VERIFIED). `ai` 7.0.143 and the six providers are ESM only (`"type": "module"`, no `require` export condition; `NPM ai/7.0.143`, `GUIDE`). The repo meets Node 22 (`package.json:26`; Electron 39.8.10 ships Node 22.22.1, `EL`).
- F2 (VERIFIED). Main, preload and the server process are CJS bundles: electron-vite 5.0.0 picks ESM only if `type` is `module` (`dist/chunks/lib-q6ns0vZr.js:284, 390`), and `apps/electron/package.json` has no `type`. Main and preload set `externalizeDeps: false` (`apps/electron/electron.vite.config.ts:75, 96`), so dependencies are inlined; only `electron`, `bufferutil` and `utf-8-validate` stay external (`:84`). The app loads no `ai` at runtime. The `server-process` entry is set at `apps/electron/electron.vite.config.ts:78-82` (source `E/server-host/entry.ts`). It bundles the ESM server (`apps/server/package.json:3`) into `out/main/server-process.js`. The output is CJS because `apps/electron/package.json` has no `type` field. UNVERIFIED: the CJS content (`"use strict"`, `require(` calls), because `out/` is not built in this checkout.
- F3 (VERIFIED). The v6 bundle holds one `ai` copy: one `"6.0.191"` string and one `AI_NoObjectGeneratedError` in `server-process.js`.
- F4 (UNVERIFIED). A real `electron-vite` build with v7 works and the asar stays near 9 MiB (`AGENTS.md:87`). See 6.9.5.
- F5 (UNVERIFIED). `check-bundled-requires.mjs` stays green. It matches only literal `require("x")` in top-level files, not `out/main/chunks` (`apps/electron/scripts/check-bundled-requires.mjs:24, 26, 34`).
- F6 (UNVERIFIED). The stt `require` entry loads. `packages/stt/package.json:21, 40-43` point it to `dist/index.cjs`. UNVERIFIED: that this file calls `require("ai")` (no dist is built; the imports are at `packages/stt/src/post-process.ts:3` and `packages/stt/src/transcribe.ts:3`); `ai` 7 has no `require` entry. No repo code requires stt, and stt is not on npm (`NPM @openstyle%2Fstt` is 404). The bundler reads stt `dist` (`exports` at `packages/stt/package.json:34-45`; no alias to source, `apps/electron/electron.vite.config.ts:8-13`), built first by turbo `^build` (`turbo.json:20-21`; `apps/server/package.json:35`; `.github/workflows/build.yml:170`). Which entry (`import` or `require`) it picks is UNVERIFIED. See Q-B.
- F7 (UNVERIFIED). vitest 4 loads the ESM-only packages. The first test run answers it.

### 6.7 Mixed copies of `ai` (the trap)

```mermaid
flowchart LR
  subgraph today["After WP-R: one ai copy"]
    stt["stt dist"] --> a191["ai 6.0.191"]
    srv["server"] --> a191
  end
  subgraph target["After WP1: one ai copy"]
    stt2["stt dist"] --> a7["ai 7.0.143"]
    srv2["server"] --> a7
  end
```

If WP1 ran before WP-R, it would also bump `apps/electron` and `@ai-sdk/react`, and the lock file would keep two versions (6.2). M1 prevents this.

- A v7 model in a v6 `generateText` throws `UnsupportedModelVersionError` (v6 accepts only specification v3 and v2; `GH6 ai/src/model/resolve-model.ts#L29-L37`). The stt `catch` (`STT/src/post-process.ts:168-176`) has no type check and returns the raw text. Dictation still pastes, a mock-model unit test passes, and only the token count and the log show the fault.
- A v3 model in a v7 `generateText` runs through an adapter (`GH7 ai/src/model/resolve-model.ts#L40-L49`). Two v7 copies work but double bundle code.

Rules:
- T1. Both manifests (server, stt) take `ai` from the catalog (P2). One exact version.
- T2. After `pnpm install`, this check passes:

```bash
grep -nE "^  (ai|'@ai-sdk/[a-z-]+)@[0-9]" pnpm-lock.yaml
# Expected keys (UNVERIFIED until the install runs): the 6.3 targets only. No '@ai-sdk/react' and no '@ai-sdk/mcp'.
# Keys can print twice (`packages:`, `snapshots:`). Explain any other key in the PR.
```

No merge while a second `ai` version is in the output.

### 6.8 Behavior changes that matter

| Row | Change | 6.0.191 | 7.0.143 | Effect |
|---|---|---|---|---|
| 1 | Output parse when finish reason is not `stop` | only on `stop` (`GH6 ai/src/generate-text/generate-text.ts#L1210-L1212`) | also when the reason is not `tool-calls` and text is not empty (`GH7 ai/src/generate-text/generate-text.ts#L1614-L1619`) | None here: the app passes no `output`. Section 5 checks the finish reason first (D4) |
| 2 | Default `maxRetries` | 2 (`GH6 ai/src/util/prepare-retries.ts#L38`) | 2 (`GH7 ai/src/util/prepare-retries.ts#L15`); initial delay 2000 ms, factor 2 (`GH7 ai/src/util/retry-with-exponential-backoff.ts#L64-L65`); a `retry-after(-ms)` header of 0 to 60 s changes the wait (`#L47-L55`) | None here. Section 5 sets `maxRetries: 0` (D5). `callUnit` is the single retry layer (decided Q9) |
| 4-5 | OpenAI Responses default `reasoningSummary`; `usage` | not set; last step | `detailed` only when `reasoning` or `providerOptions.openai.reasoningEffort` is not `'none'`; sums all steps (`GUIDE`) | None: the registry always uses `.chat` (`REG:176`); a call without `.chat` uses the Responses API (`GH7 openai/src/openai-provider.ts#L323-L334`); cleanup and quick edit make one step |
| 6 | Body type passed to `fetch` | JSON string | JSON string (`GH7 provider-utils/src/post-to-api.ts#L38`) | `createOpenAI` keeps the `fetch` setting (`GH7 openai/src/openai-provider.ts#L206, #L321, #L340`). The sampling fetch needs a string and returns other types untouched (`REG:161-163`); a non-string body would silently drop `chat_template_kwargs` and preset keys. Canary: `T/llm-task-profiles.test.ts:528-540`. Section 5 keeps this fetch |

Row 3 (system-role messages) is retired with Remix (`S/lib/remix-agent.ts:108` is the `system:` parameter; the file has no `role: 'system'` message). Row ids stay.

Test note. `T/setup.ts:16` fakes timers, and the SDK retry wait uses global `setTimeout` (`GH7 provider-utils/src/delay.ts#L26`). A reply with status 408, 409, 429 or 5xx (`GH7 provider/src/errors/api-call-error.ts#L29-L33`) hangs to the 10 s timeout (`apps/server/vitest.config.ts:23`). Error-path tests use only 400 and 401.

### 6.9 Proof of no behavior change

Unit tests alone never count (section 10). Dictation cleanup has no screen, so the proof uses the real server in the real app. Only the owner's local oMLX (Qwen3.8-27B) gets live proofs. Cloud providers get scripted-model and wire tests only (Q5).

#### 6.9.1 Commit order inside the package

| Commit | Content | Gate |
|---|---|---|
| CP1 | Add `T/ai-sdk-wire.test.ts` and its snapshot. Run on v6 (main after WP-R) | All pass. The snapshot is the baseline |
| CP2 | The bump (rows 1-4), v7 renames (rows 5, 6, 8, 9, 10), test mocks (rows 7, 12) | Same tests pass. Snapshot has no diff against CP1 |
| CP3 | PR evidence (6.9.3, 6.9.4 output), not source code | Evidence attached |

`vitest -u` never runs in CP2. A snapshot diff is a stop (M7).

#### 6.9.2 Wire-body tests (command-level, not the app)

Method: spy on `globalThis.fetch` as `captureBody` does (`T/llm-task-profiles.test.ts:494-526`) and build the real provider with `createChatModel` (`S/lib/providers.ts:54-72`). A cloud case inserts an `api_keys` row first (`T/llm-task-profiles.test.ts:158-161`). Each Groq case uses a new key, because the client caches by key and model (`S/lib/groq-http.ts:23-29`). WB10 and WB11 are retired with Remix.

| Case | Call | Snapshot holds |
|---|---|---|
| WB1-WB8 | stt `postProcess`, model from `createChatModel` for openai, groq, anthropic, google, mistral, openrouter, vercel, `server`; production params (`S/lib/post-process.ts:228-249`) | URL, method, header names, `content-type` and `authorization` values, parsed JSON body, result (`cleaned`, `inputTokens`, `outputTokens`) |
| WB9 | `server` provider, preset `builtin:qwen-thinking` | full body incl. `chat_template_kwargs`, `top_k`, `min_p`, floored `max_tokens` |
| WB12-WB14 | stt `transcribe` for openai, groq, elevenlabs via `transcribeWithAiSdk` (`S/lib/streaming/utils.ts:37-59`) | URL, header names, multipart field names and values; no audio |
| WB15 | one 401 and one 400 reply on WB1 | stt falls back to raw text; `onError` gets an error with the same `statusCode` |

```bash
pnpm --filter @openstyle/server test tests/ai-sdk-wire.test.ts   # no "--" before the path (AGENTS.md:81)
pnpm --filter @openstyle/server test
pnpm --filter @openstyle/stt run test
git diff --stat <CP1>..<CP2> -- apps/server/tests/__snapshots__
# Expected: all pass. The last command prints nothing.
```

A wrong canned reply fails CP1 on v6. Limit: no app, no live cloud API. The zod 4 JSON Schema check for the meeting schemas (section 5) belongs to WP3.

#### 6.9.3 Real-app proof

Follow `.claude/skills/live-testing/SKILL.md` (`SKILL.md` below): quiet mode, isolated profile, no port 4649, no microphone, no system audio, no installed app; run through the Test Runner app (`:202`); stop at any privacy dialog (`:220`).

**A. Dictation cleanup (required).** `POST /api/post-process` runs the full cleanup with text only (`S/routes/post-process-route.ts:7-27`; `S/routes/index.ts:52`). Chain: server `postProcess` (`S/lib/post-process.ts:139-249`) calls stt `postProcess` at `:228` (as `cleanupWithModel`, `:2`), which calls `generateText` at `STT/src/post-process.ts:125`.

1. The coordinator makes two worktrees: baseline (main after WP-R, ai 6) and package (ai 7) (worktree setup traps: `.claude/skills/live-testing/SKILL.md:173-175`; the branch rule `.claude/skills/branch-lifecycle/SKILL.md:16` covers parallel lanes only, not baseline or package builds, so this use is a proof-only choice). Build each: `pnpm turbo build --filter=@openstyle/server` (`SKILL.md:83`); `cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build` (`SKILL.md:211`).
2. Write a throwaway spec `apps/electron/tests/zz-proof-ai-sdk-v7.test.ts` (naming pattern: `.claude/skills/live-testing/SKILL.md:210`; the file does not exist today), identical in both worktrees, never committed. A loopback capture server answers `GET /v1/models` with `capture-model` and `POST /v1/chat/completions` with a fixed completion (`finish_reason: "stop"`, `prompt_tokens: 40`, `completion_tokens: 9`), and records URL, header names and raw body (pattern: `apps/electron/tests/meeting-cancel-transcribe.test.ts:108-118, 271-290`). The spec starts the app with `launchOpenstyle` (`apps/electron/tests/helpers/e2e-app.ts:36-58`; `OPENSTYLE_E2E=1` is quiet mode, macOS only, `E/main/index.ts:98-100`), registers the server as default LLM, sets `PUT /api/settings/llm_cleanup` `{ "value": "true" }` (`S/routes/settings.ts:94`), and posts `{ "text": "um so we ship on friday i think" }` to `/api/post-process`.
3. Assert: HTTP 200; `cleaned` equals the fixed completion; `inputTokens` 40; `outputTokens` 9; one chat request captured; one `llm.request` entry with the same body in `openstyle-trace.log` (`S/lib/trace.ts:257-275`). Write `{status, response, captured}` to a scratch JSON file.
4. Run both builds, then `diff <(jq -S . baseline.json) <(jq -S . package.json)`. Expected: no output.
5. Run the TCC check before and after (`SKILL.md:218-219`). Expected: no new line.
6. Local oMLX run (this spec's choice), owner's server `http://127.0.0.1:8123`. The skill allows Qwen3-ASR and Qwen3.8-27B there (`SKILL.md:229`; `scripts/guard-hook.sh:58-79`); this proof sends `Qwen3.8-27B` only. The guard hook reads the model only from the Bash command or a `-d @file` body (`scripts/guard-hook.sh:49, 59-69`), so the spec itself must obey. Check the trace log body and a non-empty `cleaned`. Afterwards `timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models` must print 200 (`SKILL.md:229`).
7. Delete the spec and the scratch folder. Stop only PIDs you started (`SKILL.md:16-17`).

`inputTokens` is the key assertion: it stays 0 when the LLM path fails (`S/lib/post-process.ts:147-148, 252-263`), and the fallback also returns text.

**B. Other paths.** Meetings use the same stt `postProcess` (`S/lib/meetings/llm-call.ts:136`). The skill has no Summarize recipe; use its meetings recipe (`SKILL.md:206-217`) and insert rows with `sqlite3` into the isolated DB (`:130`). If the package touches `llm-call.ts`, run one Summarize on a seeded fictional meeting (steps 1 to 8 of that recipe). Trigger: `POST /api/meetings/:id/summarize`, which needs status `transcribed` or `summarized` and a non-empty transcript (`S/routes/meetings.ts:2068-2085`; mount `S/routes/index.ts:47`). The full recipe is UNVERIFIED until a run. Cloud transcription needs keys, so WB12-WB14 are its only proof. Say so in the PR.

WP-R owns the proof that the app starts and builds without Remix.

#### 6.9.4 Negative control (the proof must be able to fail)

In a scratch worktree, set only `STT/package.json` back to `ai` 6.0.191 and run proof A on the package build. Expected (UNVERIFIED until run): no chat request captured; `inputTokens` 0; server log has `LLM cleanup failed` (`S/lib/post-process.ts:262`). If proof A still passes, fix the proof first.

#### 6.9.5 Build and bundle checks

| Check | Command | Expected |
|---|---|---|
| Lock, build, tests | `pnpm install --frozen-lockfile` and the grep of 6.7; `pnpm turbo build --filter=@openstyle/server` (`.github/workflows/build.yml:170`); `pnpm --filter @openstyle/server test`; `pnpm --filter @openstyle/stt run test` (`CI:144, 147`) | pass; listed lock keys only |
| Type-check | `pnpm --filter @openstyle/server run typecheck:tests` (`apps/server/package.json:7`); `pnpm --filter @openstyle/electron run typecheck` | pass; covers the `type` and `none` rows of 6.4 |
| Bundle | `cd apps/electron && pnpm run build && node scripts/check-bundled-requires.mjs && node scripts/check-renderer-asset-urls.mjs` (`CI:177-201`) | pass |
| One SDK copy | `grep -o 'AI_NoObjectGeneratedError' apps/electron/out/main/server-process.js \| wc -l` | 1, like v6 (F3); 2 or more means two copies |
| Size | `ls -l apps/electron/out/main/*.js`; `du -sk apps/electron/out`, `du -sk apps/electron/out/renderer`, before (main after WP-R) and after | record and report the growth in the PR. No fixed limit (Q6). Reference: asar near 9 MiB (`AGENTS.md:87`) |

### 6.10 What the package must not do

- Add `Output`, a schema, a gateway file, a retry setting, a reasoning option or telemetry (M4; `AGENTS.md:9` confirms only that the app has no telemetry; that it has no `Output`, schema, gateway, retry or reasoning setting is UNVERIFIED by that line, and a grep of baseline packages and apps found none).
- Change `PostProcessParams` (`STT/src/post-process.ts:24`), the stt `PostProcessResult` (`:76`) or `ChatCallResponse` (`S/lib/meetings/llm-call.ts:46-55`). The server's own `PostProcessResult` (`S/lib/post-process.ts:45`) stays too. Do not change the `length` rule at `STT/src/post-process.ts:148`, the only decision on `finishReason`. Section 5 adds the finish reason.
- Edit any Remix file or the renderer. WP-R owns them.

### 6.11 Open items and decisions

Ids keep their old numbers. U6-3, U6-4 and U6-7 are retired with Remix.

| # | Item (UNVERIFIED) | Settled by |
|---|---|---|
| U6-1 | Real `electron-vite` build with v7, bundle size, guard script (F4, F5) | 6.9.5 |
| U6-2 | Every v7 wire body equals its v6 body (8 providers, 3 transcription providers) | CP1 against CP2 (6.9.2) |
| U6-5 | The v3 fake in `STT/src/post-process.test.ts:4-26` passes the v7 adapter | stt tests in CP2 |
| U6-6 | Live calls to cloud providers (no keys in the proof environment) | Not settled by decision Q5: scripted-model and wire tests only. Say so in the PR |

Decided 2026-10-17:
- Q-A. Put `ai` and `@ai-sdk/provider-utils` in the pnpm catalog (P2, T1).
- Q-B. Keep the CJS output of the stt package as it is (F6). The server build and bundle checks of 6.9.5 show which entry the bundler picks. If they fail, the package stops (M7).
- Q-C. Moot. The Remix agent was the only user of `toUIMessageStreamResponse`, and WP-R removes it.
- Q8 (release). WP1 does not ship as its own release. Everything ships in one release. WP1 still merges first on main (M1), and its proofs run before that merge.
- Q5 (live proofs). No cloud provider gets a live proof. Only the owner's local oMLX (Qwen3.8-27B) does. Cloud paths keep scripted-model tests.
- Q6 (size). No fixed bundle limit. The package measures and reports the growth (6.9.5).
- Q9 (retry). `callUnit` is the single retry layer. The AI SDK keeps `maxRetries` 0 from section 5 on (6.8 row 2).

### 6.12 Sources

- `GUIDE`: https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0
- `GH7` (`ai@7.0.143`, commit `b7f6255a`; tag check https://api.github.com/repos/vercel/ai/git/ref/tags/ai%407.0.143): https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ then `<package>/src/...`
- `GH6` (`ai@6.0.191`, commit `0838d52f`; tag check https://api.github.com/repos/vercel/ai/git/ref/tags/ai%406.0.191): https://github.com/vercel/ai/blob/0838d52fe657c4f04891b78423fbc636a543851a/packages/
- `NPM`: https://registry.npmjs.org/ then `<package>` or `<package>/<version>`
- `UNPKG`: https://unpkg.com/ then `<package>@<version>/dist/...`
- `EL` (Electron Node version): https://artifacts.electronjs.org/headers/dist/index.json

---

## 7. Persistence

Migration 40 adds six tables and one column (`meeting_summaries.summary_json`). It drops the three Remix tables and the three Remix settings rows (7.3, Q17). The six tables are scope-generic: a run names its scope (`scope`, `scope_id`). Meetings are the first scope (Q16, 2026-10-17). This part owns table shapes, write rules and delete rules. Graph: section 3. Verify step: 4. Call content: 5. Tests: 10. Work breakdown: 11.

Path keys (baseline c47cd80d): `srv/`=`apps/server/src/`; `tests/`=`apps/server/tests/`; `meetings.ts`=`srv/routes/meetings.ts`; `schema.ts`=`srv/lib/schema.ts`; `db.ts`=`srv/lib/db.ts`; `enhance.ts`=`srv/lib/meetings/enhance.ts`; `en.json`, `template.json`=files in `apps/electron/src/renderer/src/locales/`; `meeting-types.ts`=`packages/validations/src/meeting-types.ts`; `llm/`=`srv/lib/llm/`.

Terms: Scope = kind of thing a run works on (`meeting` today). Scope id = id of that thing. Run = one workflow execution for one scope id (id = `thread_id`). Step = one node execution. Call = one model request. Attempt = call number in its step. Link = row joining a call to one thing it produced. Recorder = the module that writes the record.

### 7.1 Current state

- One `node:sqlite` connection, WAL, `foreign_keys = ON` (`db.ts:14-40`). `SCHEMA_VERSION` is 39 (`schema.ts:14`); steps 38, 39 use a `tableExists` guard (`schema.ts:953,997,254-258`). Four meeting child tables cascade from `meetings` (`schema.ts:780,791,851,943`).
- Segment id = `<meeting>:<source>:<idx>` (`meetings.ts:420`), written with `INSERT OR REPLACE` (`meetings.ts:415`). Re-transcribe deletes segments, speakers and turns (`meetings.ts:1546-1556`). Enhance writes `enhanced_text`, then suggestions, in two transactions (`enhance.ts:628-636,652-672`).
- SQLite needs the FK pragma on each connection (https://www.sqlite.org/foreignkeys.html, section 2). A child key index is almost always beneficial because a parent delete can scan the child table (same page, section 3). Each of the 6 child key columns in 7.4 leads an index or a primary key (checked 2026-10-17 with `PRAGMA foreign_key_list` and `index_info`).

Link-table traps (checks A1 to A3, 7.13): (1) a plain FK from a link to `meeting_segments(id)` makes the re-transcribe DELETE fail. (2) A CASCADE FK loses the link on `INSERT OR REPLACE` (rows 1 to 0). (3) The id has no run part, and `idx` is the list position (`srv/lib/meetings/transcriber.ts:351`). A new segment can reuse an old id with other text, although `meetings.ts:1547` says "fresh segment ids". 7.8 closes this.

### 7.2 Design rules

P1: Additive migration. P2: Every run row names its scope. A run of scope `meeting` also has `meeting_id REFERENCES meetings(id) ON DELETE CASCADE` (D10). Steps, calls, links and checkpoints cascade from the run row through `run_id`, `call_id` or `thread_id`: one cascade path covers every table. P3: A link has no FK to a segment, speaker or summary; it stores a string key. P4: A reader accepts a link only if it still matches the current target value (7.8). P5: Only the recorder writes the record; it never throws; a failed record write never fails the run. P6: The save step writes links in the same transaction as the data they describe. P7: No `CHECK` on enum columns (a failed CHECK is a silent lost row); TypeScript owns the enums; the read route maps an unknown value to `"unknown"`. P8: No key, token or header in the record; the recorder caps text fields. P9: Only the delete of the scope owner removes the record (D10); for a meeting, the meeting delete. A future scope names its own owner and cascade column in its own migration (7.12). P10: The platform tables hold no meeting noun except the nullable `llm_runs.meeting_id` (Q16).

### 7.3 Migration 40

```ts
const SCHEMA_VERSION = 40;   // new value; today schema.ts:14 holds 39
// New step after step 39, before the version upsert (schema.ts:997-1013):
if (currentVersion < 40 && tableExists(db, "meetings")) {
  db.exec(`...SQL of 7.4, one template string...`);   // all IF NOT EXISTS, safe to re-run
  // Q12: ALTER has no IF NOT EXISTS, so test the column first (pattern: schema.ts:528-537)
  if (!hasColumn(db, "meeting_summaries", "summary_json")) {
    db.exec(`ALTER TABLE meeting_summaries ADD COLUMN summary_json TEXT`);
  }
}
```

`summary_json` holds the validated summary object as JSON text (4.5.6). The save step writes it with the Markdown (SW3, 4.6.1). Older rows keep NULL. The table is at `schema.ts:790-799`. `hasColumn` is a new helper in `schema.ts` (name is a proposal).

**Remix removal in the same migration (Q17, 11.8 row 21).** The release has one migration, so the drop sits here, not in the WP-R PR. Children go first. No `DROP` of a Remix table exists at c47cd80d; the `CREATE TABLE IF NOT EXISTS` statements for the three tables are at `schema.ts:589-621`. The block sits outside the `tableExists(db, "meetings")` guard.

```ts
db.exec(`DROP TABLE IF EXISTS remix_messages; DROP TABLE IF EXISTS remix_runs; DROP TABLE IF EXISTS remix_threads;`);
db.exec(`DELETE FROM settings WHERE key IN ('remix_hotkey', 'remix_bar_enabled', 'remix_enabled')`);
```

Migration 20 stays as written (`schema.ts:585-636`). The SQL above is a plan (UNVERIFIED until the 7.3 tests run it).

Change the version pins (`tests/schema-meetings.test.ts:7`, `tests/migration-servers.test.ts:91`) and `AGENTS.md:50` to 40. New tests (pattern `tests/schema-meetings.test.ts:406-441`; section 10): v39 upgrade (new column exists, old summary rows read NULL), guard skip with no `meetings` table, second run of the step, cascade for two meetings, a run of another scope with no `meeting_id` survives a meeting delete, link survival after segment delete and `INSERT OR REPLACE`, FK error for an unknown `meeting_id`, and the Remix drop (three tables and three settings rows gone, a second run adds no error, `tests/v20-merge-reconciliation.test.ts:107-109,141` today expects the Remix tables to exist, so WP2 must edit that test to expect the dropped state).

### 7.4 DDL

No `DEFAULT`; the recorder writes every column. Times are epoch ms `INTEGER` (`schema.ts:763-764`; `apps/electron/src/main/meeting-recorder.ts:329`). Enum values: 7.6 and 8.4.

```sql
CREATE TABLE IF NOT EXISTS llm_runs (
  id TEXT PRIMARY KEY,   -- = thread_id
  scope TEXT NOT NULL,   -- 7.6
  scope_id TEXT NOT NULL,   -- meeting id for scope 'meeting'
  meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,   -- NULL unless scope = 'meeting'; the cascade root (P2)
  kind TEXT NOT NULL, started_by TEXT NOT NULL, status TEXT NOT NULL,
  graph_version INTEGER NOT NULL, input_hash TEXT, resume_count INTEGER NOT NULL,   -- 3.4.3, 3.4.7
  result_json TEXT,   -- Enhance: {"correctedCount":n,"suggestionCount":n} (8.9); else NULL
  lost_records INTEGER NOT NULL,   -- 7.7 rule 9
  error_kind TEXT, error_detail TEXT,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_runs_meeting ON llm_runs(meeting_id, started_at);   -- FK scan
CREATE INDEX IF NOT EXISTS idx_llm_runs_scope ON llm_runs(scope, scope_id, started_at);
CREATE INDEX IF NOT EXISTS idx_llm_runs_open ON llm_runs(status) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS llm_run_steps (
  run_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,   -- top unit key (4.0.7): 'prepare','chunk:3','candidates','verify','single','map:2','reduce:1:0','save'
  node TEXT NOT NULL,
  seq INTEGER NOT NULL,   -- start order from 1, unique in the run (7.7 rule 3)
  status TEXT NOT NULL,   -- running|succeeded|partial|failed|skipped|cancelled|interrupted (8.4)
  attempts INTEGER NOT NULL,
  error_kind TEXT, error_detail TEXT, started_at INTEGER, finished_at INTEGER,
  PRIMARY KEY (run_id, step_key)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, scope_id TEXT NOT NULL,   -- copied from the run row
  step_key TEXT NOT NULL, node TEXT NOT NULL,
  attempt INTEGER NOT NULL, retry_reason TEXT,
  provider TEXT, requested_model TEXT, served_model TEXT,
  messages_json TEXT NOT NULL,
  schema_name TEXT NOT NULL, schema_version INTEGER NOT NULL, schema_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  raw_text TEXT, parsed_json TEXT,
  finish_unified TEXT, finish_raw TEXT,   -- unified: stop|length|content-filter|tool-calls|error|other; raw: provider value
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cached_tokens INTEGER,   -- NULL = unknown
  reasoning_chars INTEGER, queued_ms INTEGER, latency_ms INTEGER,
  error_kind TEXT, error_detail TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id, step_key, attempt);
CREATE INDEX IF NOT EXISTS idx_llm_calls_scope ON llm_calls(scope, scope_id, started_at);
CREATE TABLE IF NOT EXISTS llm_call_links (   -- target_id has no FK (P3)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES llm_calls(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, scope_id TEXT NOT NULL,   -- copied from the call row
  target_type TEXT NOT NULL,   -- consumer-defined; meetings: segment|speaker|summary (8.4)
  target_id TEXT NOT NULL,
  seq INTEGER NOT NULL,   -- index in the call output (corrections[i], speakers[i]); 0 for summary (4.6.1)
  outcome TEXT NOT NULL,
  reason TEXT,
  applied_text TEXT,
  verdict_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_call_links_target ON llm_call_links(scope, scope_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_llm_call_links_call ON llm_call_links(call_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_call_links ON llm_call_links(call_id, target_type, target_id, seq);   -- replayed save adds no row (4.6.2)
-- LangGraph saver (D6): official SQLite saver columns
CREATE TABLE IF NOT EXISTS llm_checkpoints (
  thread_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS llm_checkpoint_writes (
  thread_id TEXT NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
  checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL,
  task_path TEXT NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
```

Notes.
- Delete path: a meeting delete removes its `llm_runs` rows through `meeting_id`; steps, calls, checkpoints and writes follow through `run_id` or `thread_id`; links follow through `call_id` (3-level cascade proven in 7.13).
- `schema_json` is the SDK output `await asSchema(zod).jsonSchema` (4.0.3 rule 7, L5), not a provider-reshaped form.
- Valid JSON with a finish reason other than `stop` keeps `parsed_json` and sets `error_kind` (D4). Unknown tokens are NULL; today's code writes 0 (`srv/lib/meetings/summarize.ts:406-407`; `srv/lib/post-process.ts:164-165`; the doc comment at `srv/lib/meetings/llm-call.ts:45` says "0 when unknown"). A requested and served model difference sets `error_kind = 'model_mismatch'` (L4).
- `error_detail` holds no request body, because AI SDK `APICallError.requestBodyValues` include prompts (https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error).
- `llm_calls.step_key` is the `unitKey` of the call (`chunk:3/0` for a half). A call belongs to step `chunk:3` when its key equals the step key or starts with it plus `/`. `callUnit` reuses a finished call by this key (5.6; grammar 4.0.7).
- `callUnit` is the single retry layer (Q9, 2026-10-17): AI SDK `maxRetries` is 0, and a retry is one more `llm_calls` row with `attempt` + 1, computed by the recorder (7.7 rule 3).
- `llm_run_steps.status` also holds `partial`: halves ended in a mix of ok and failed (4.0.7).
- The recorder copies `scope` and `scope_id` from run to calls and links, so a reader needs no join (7.8).

### 7.5 JSON column shapes

```ts
// llm-types.ts (new, WP2). `meeting-types.ts` holds types only (`meeting-types.ts:3-5`). The two new types are not named in this text, so "neither type at c47cd80d" is UNVERIFIED. WP2 adds both here only (5.1, rule B).
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }  // messages_json
export interface LlmParamsLedger {     // params_json; section 5 fills it; unknown keys stay readable
  topLevel: Record<string, unknown>;   // request fields: temperature, max_tokens, response_format
  extraBody: Record<string, unknown>;  // gateway-added: chat_template_kwargs, top_k
  dropped: { name: string; value?: unknown; reason: string }[];  // asked for, not sent; reason: LedgerDropReason (5.1)
  source: { mode: "auto" | "preset" | "custom"; presetId?: string };
  capturedFrom: "wire" | "sdk_request";  // 5.1: where the gateway read the body
  warnings: string[];                    // 5.1: one line each, no prompt text; includes `profile.warnings`
  structuredMode: "json_schema_strict" | "json_schema" | "json_tool" | "json_object" | "prompt_only"; // 5.4: no column holds it; `finishedCall` reads it here
}
// verdict_json holds the SpeakerVerdict of 4.4 for a meeting speaker link: one shape and one code list (11.4). The platform treats the column as opaque JSON.
```

Each code has English text under `meetings.inspector.verdict.<code>` in `en.json` and `template.json` (planned, 8.10; `en.json` has no `inspector` key at c47cd80d). The link `reason` column holds the `reason` of the verdict or of the drop.
- Kept (`evidenceType`): `self_introduction` "The speaker named themselves."; `addressed_as` "Another speaker called this speaker by that name."; `role_detail` "A real line supports this role."
- Dropped speaker proposals (`DropReason`, 4.4): `unknown_label` "The speaker label does not exist."; `unknown_segment` "The cited line was not shown to the model."; `no_quote` "The model gave no evidence quote."; `quote_too_long` "The evidence quote is too long."; `quote_not_in_segment` "The evidence quote is not in the cited line."; `empty_name` "The entry has no name."; `name_not_in_quote` "The name is not in its own evidence."; `not_self_introduction` "The speaker said the name but did not name themselves."; `conflict_lost` "Stronger evidence named this speaker differently."; `duplicate_same_name` "Another proposal for this speaker has the same name."
- Dropped corrections (`CorrectionDropReason`, 4.2): `unknown_id` "The model named a segment that is not in this chunk."; `duplicate_id` "The model named this segment twice."; `empty_text` "The correction was empty."; `unchanged` "The correction did not change the text."

### 7.6 Enumerations

`llm_runs.scope`: `meeting`, and `test` for runs that platform tests create (recorder tests 10.9 checks 5 and 7; saver wrapper 10.7). `LlmScope = "meeting" | "test"` is declared once, in `packages/validations/src/llm-types.ts` (8.4; new file, proposed path, it does not exist at c47cd80d), so tests compile under `typecheck:tests` (GT3) with no cast. A new consumer adds its word to the union in its own PR; `llm/` stays unchanged (Check P).

`llm_runs.kind`: `enhance`, `summarize` (`srv/lib/meetings/job-registry.ts:39-44`). An Enhance run chains into Summarize in the same run (Q2, 2026-10-17): kind is `enhance` when the stage list holds `enhance`, and the run then also holds the Summarize steps and the summary link. A Summarize-button run has kind `summarize`.

`started_by`: `auto`, `button`; the original trigger for the whole run (`markResumed` does not write it). A resumed run has `resume_count` above 0 (3.4.3). Run status, step status, target type and outcome: TS types in 8.4.

`error_kind` (section 5 owns it: the 15 kinds of 5.2.1; D4, L1 to L4): `length`, `content_filter`, `unexpected_tool_calls`, `abnormal_stop`, `reasoning_leak`, `schema`, `model_mismatch`, `cancelled`, `provider_timeout`, `provider_rate_limited`, `provider_unavailable`, `provider_auth`, `provider_invalid_request`, `model_unavailable`, `deadline_exceeded`. A step can also hold `budget_exceeded`, `empty_input`, `save_failed`, `internal` (4.0.7). A run can also hold `interrupted_before_checkpoint`, `graph_changed`, `transcript_changed`, `internal` (3.4.3). The read route maps any other value to `unknown` (P7).

`transcript_changed` (Q13, 2026-10-17): a confirmed speaker name or a new `enhanced_text` while a Summarize run, or the Summarize stage of a chained run, is `interrupted` fails the resume; the user starts again. The guard compares `llm_runs.input_hash` with a fresh `inputHash` of the variant from `hashVariantOf(stages)` (4.1 P11). The `summarize` variant covers enhanced text and confirmed names; the `chain` variant covers confirmed names only (the chained run writes the enhanced text itself).

Run status: `succeeded` = every step `succeeded` or `skipped`. `partial` = a step failed and the save step wrote the other results (D4). `failed` = no result written. `cancelled` = user stop. `interrupted` = process ended while `running` (7.12).

### 7.7 The recorder

New file `llm/recorder.ts`, that is `apps/server/src/lib/llm/recorder.ts` (path is a proposal; the directory exists at c47cd80d). Per Q16 it is domain-agnostic and imports no meeting module.

```ts
// WP2 writes these types; WP3, WP5a, WP5b use them. Base types: 5.1 (rule B).
export interface NewRun { // startRun: recorder sets status "running", resume_count 0, lost_records 0, updated_at = startedAt
  id: string;                      // = thread_id (UUID from the runner)
  scope: LlmScope;                 // "meeting" | "test" (7.6)
  scopeId: string;                 // scope "meeting": also written to meeting_id; other scopes: meeting_id NULL
  kind: LlmRunKind;                // "enhance" if the stage list holds "enhance", else "summarize" (3.4.2 step 1)
  startedBy: "auto" | "button";
  graphVersion: number;            // WORKFLOW_GRAPH_VERSION (3.4.7)
  startedAt: number;               // epoch ms
}
export interface RunFinish { // finishRun: one statement (3.4.6 step 3)
  errorKind: string | null; errorDetail: string | null; // run failure code (3.4.3), no prompt text
  result: unknown | null;          // -> result_json. Enhance (8.9): { correctedCount, suggestionCount }; null for Summarize
  lostRecords: number;             // rule 9
  finishedAt: number;              // epoch ms; also written to updated_at
}
export interface NewLink { // recorder fills scope, scope_id (from the call row), created_at
  targetType: LlmTargetType;       // "segment" | "speaker" | "summary" (8.4)
  targetId: string;                // segment id, speaker label, or meeting id for a summary (4.6.1)
  seq: number;                     // index of the entry in the call output; 0 for a summary link (4.6.1)
  outcome: "applied" | "dropped";
  reason: string | null;           // CorrectionDropReason | DropReason when dropped
  appliedText: string | null;      // enhanced_text, finalName, or summary created_at as text (7.8)
  verdict: unknown | null;         // -> verdict_json. A speaker link passes a SpeakerVerdict
}
export interface ParsedCall { // finishedCall: a finished call that callUnit reuses after a resume (5.6)
  callId: number; attempt: number;
  parsed: unknown;                 // JSON.parse of parsed_json; the caller parses it with the schema again
  rawFinishReason: string;         // finish_raw; unified reason is "stop" because error_kind is NULL
  usage: TokenUsage;
  provider: string | null; modelRequested: string; modelServed: string | null;
  queuedMs: number | null; latencyMs: number | null;
  params: LlmParamsLedger;         // parsed params_json, holds structuredMode (7.5)
}
export interface LlmRecorder {
  startRun(r: NewRun): "ok" | "no_scope" | "error";   // "no_scope": FK failure, scope owner gone (3.4.2)
  finishRun(id: string, status: LlmRunStatus, f: RunFinish): void;   // 3.4.6
  setInputHash(id: string, hash: string): void;   // `prepare` (3.4.3)
  markResumed(id: string): void;   // status running, resume_count + 1 (3.4.7)
  startStep(runId: string, step: { key: string; node: string }): void;   // recorder sets seq (rule 3)
  startAttempt(a: { runId: string; stepKey: string }): void;   // CallSink (5.1): before each request, attempts += 1
  finishStep(runId: string, key: string, status: LlmStepStatus, err?: { kind: string; detail: string }): void;
  recordCall(call: CallRecord): RecordedCall | null;    // CallSink (5.1): { id, attempt }; null when the write failed
  finishedCall(runId: string, unitKey: string): ParsedCall | null;   // 5.6; null when none, cut, or a JSON column does not parse
  linkCall(callId: number, links: NewLink[]): void;     // joins the open transaction
  sweepInterrupted(): number;                           // 'running' to 'interrupted'; run count
}
```

`CallRecord`, `RecordedCall`, `CallSink` and the base types (`LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode`, `GatewayErrorKind`) are in `llm/call-record.ts` (5.1, planned, WP2). `LlmScope`, `LlmRunKind`, `LlmRunStatus`, `LlmStepStatus`, `LlmTargetType` are in 8.4 (`packages/validations/src/llm-types.ts`). `SpeakerVerdict` will be in `meeting-types.ts` (7.14); the recorder does not import it. None of these names exists at c47cd80d (0 matches).

1. Every method catches errors, logs `log.warn` with the run id and returns; it never throws. The recorder is the `CallSink` of 5.1 and the only writer of `llm_runs`, `llm_run_steps`, `llm_calls`, `llm_call_links` (3.1). It reads `scope` and `scope_id` from the run and call rows; the caller passes neither.
2. `recordCall` runs one `INSERT` after the call ends, with `attempt` = `(SELECT count(*) FROM llm_calls WHERE run_id = ? AND step_key = ?) + 1`. The gateway cannot know the number, because `startAttempt` returns nothing. A call in flight at process death leaves no row; its step stays `running` until the sweep.
3. `startStep` is an upsert on (run id, step key). First call for a key: insert status `running`, `attempts` 0, `seq` = 1 + highest `seq` of the run (0 if none). Later call: set `running`, keep `seq` and `attempts`. So `seq` is the unique start order of steps in a run. `guardNode` calls it when a node run starts; the `summarize` body calls it through `runStep` at each unit start (4.0.2, "Step ownership"); both just before the first `callUnit` of the step. No node calls it itself. `startAttempt` adds 1 per request, retries included (check S11, 7.13); the recorder adds it to the step row whose key equals the call `unitKey` or is its prefix before `/` (7.4).
4. `linkCall` uses plain statements. The save step calls it inside its synchronous `withTransaction` (`db.ts:55-75`). A failed link fails alone and the transaction commits (check S10, 7.13). A caller with no transaction may open one when `db.isTransaction` is false (Node 22.16.0+, https://nodejs.org/docs/latest-v22.x/api/sqlite.html; `pnpm-lock.yaml:3301` pins `electron@39.8.10`; the lock file does not state the bundled Node version. The claim that this Electron ships Node 22.22.1 (index: https://artifacts.electronjs.org/headers/dist/index.json) is UNVERIFIED: the 39.8.10 entry was not read). UNVERIFIED in the packaged app.
5. A vanished meeting makes inserts fail with an FK error; the recorder logs it at `debug`. Today's catch block logs the deleted-meeting case with `log.info` (`meetings.ts:1118-1127`, the log call at `1124-1126`); the `debug` level is a new rule.
6. Cap `messages_json`, `raw_text`, `parsed_json`, `schema_json`, `params_json`, `error_detail` at 500,000 characters each; append `\n[cut: N characters]`. The repo holds no measured prompt size (UNVERIFIED); the code gives two bounds. (a) The Summarize reduce call holds at most 23 map partials (guard allows 24 calls, `srv/lib/meetings/summarize.ts:108,468`; one is the reduce call, `summarize.ts:498-509`), each at most 4,096 tokens (`summarize.ts:77`; the route deadline uses `MAX_SUMMARIZE_CALLS`, `summarize.ts:103-104`): 23 × 4,096 × 4 characters per token (`srv/lib/meetings/llm-call.ts:24-26`) = 376,832 characters. (b) A single or map call holds one transcript chunk: default 8,000 tokens (`summarize.ts:49`), user maximum 200,000 tokens (`packages/validations/src/settings.ts:185-186`), about 800,000 characters, above the cap.
7. No header or key is stored. Mask `params_json` like the trace log, which redacts only `Authorization` and `api_key`/`apiKey` values (`srv/lib/trace.ts:29-50`). `params_json` is a new field; no such field exists at c47cd80d.
8. `llm_run_steps.attempts` versus the call-row count of the step shows an unrecorded call (8.7).
9. When `recordCall` returns `null`, the node calls `ctx.recordLost()`; the runner stores the count in `llm_runs.lost_records` at finish (3.4.6). `save` writes no link for a `null` id. The inspector shows `recordLost` (8.7), apart from `noRecord`.

The diagram shows planned write paths (3.1, 3.4.6, 7.12). Only `startServer` (`srv/index.ts:185`) and the meeting tables exist at c47cd80d.

```mermaid
flowchart LR
  R["Runner (3)"] -->|"startRun, finishRun"| runs[("llm_runs")]
  N["Node wrapper (3)"] -->|"startStep, finishStep"| steps[("llm_run_steps")]
  G["Gateway (5)"] -->|"startAttempt"| steps
  G -->|"recordCall"| calls[("llm_calls")]
  S["Save step (4)"] -->|"update enhanced_text, upsert speakers, replace summary and summary_json"| data[("meeting tables")]
  S -->|"linkCall, same transaction"| links[("llm_call_links")]
  C["Checkpoint saver"] -->|"put, putWrites"| cp[("llm_checkpoints, llm_checkpoint_writes")]
  B["startServer"] -->|"sweepInterrupted"| runs
```

### 7.8 How a reader finds the link that is still true

A link stays when its target changes. The reader checks it against the current target value. Every query below is meeting code: it reads the generic link table by `scope = 'meeting'` and joins the meeting tables. It lives in `srv/lib/meetings/llm-record-read.ts` (7.14), not in the platform.

```sql
-- Segment: the link must match the current enhanced_text.
SELECT l.id, l.call_id FROM llm_call_links l
JOIN meeting_segments s ON s.id = l.target_id AND s.meeting_id = l.scope_id
WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'segment' AND l.target_id = ?
  AND l.outcome = 'applied' AND l.applied_text = s.enhanced_text
ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
-- Speaker 1: producing call = its applied name equals the current suggestion.
SELECT l.call_id, c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
JOIN meeting_speakers s ON s.meeting_id = l.scope_id AND s.speaker_label = l.target_id
WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'speaker' AND l.target_id = ?
  AND l.outcome = 'applied' AND l.applied_text = s.suggested_name
ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
-- Speaker 2 (fallback when 1 finds no row): newest run with any proposal for the label.
SELECT c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'speaker' AND l.target_id = ?
ORDER BY c.started_at DESC, l.id DESC LIMIT 1;
-- Speaker 3: all proposals of that run for the label, kept and dropped.
SELECT l.*, c.step_key FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'speaker' AND l.target_id = ? AND c.run_id = ?
ORDER BY c.started_at, l.id;
-- Summary: the link must match the current meeting_summaries row (its created_at, written by SW3).
SELECT c.run_id FROM llm_call_links l JOIN llm_calls c ON c.id = l.call_id
JOIN meeting_summaries s ON s.meeting_id = l.scope_id
WHERE l.scope = 'meeting' AND l.scope_id = ? AND l.target_type = 'summary' AND l.outcome = 'applied'
  AND l.applied_text = CAST(s.created_at AS TEXT)
ORDER BY l.created_at DESC, l.id DESC LIMIT 1;
```

- Segment: after a re-transcribe the segment has the same id and NULL `enhanced_text`, so no row returns (check E3, 7.13). A segment a later run left unchanged keeps the first run's text (`enhance.ts:630-635`) and its link.
- Speaker: a label with only dropped proposals has no suggestion, so query 2 finds the run. After a re-diarize, labels can mean other voices (`meetings.ts:1547-1552`). The reader calls `loadHashRows(db, meetingId)` and compares `inputHash(rows, variant)` (4.1 P11) with `llm_runs.input_hash` of the producing run. A speaker link comes from a run of kind `enhance`; the run row stores the kind, not the stage list, so the reader tries the variants `chain` and `enhance` and accepts the first match. Decided 2026-10-17 (owner viewpoint): accept one known limit. The `chain` variant covers confirmed names, so a name confirmed after a chained run also sets `staleLabels`. This is a hint in advanced mode, and a second hash column would add schema for a hint. The reader and `prepare` call the same two functions on database rows. If the hashes differ, or the stored value is NULL, `staleLabels` is true and the panel shows `speakerLabelNote` (8.10).
- Summary: a row written before WP5b (old path, `meetings.ts:1214`, `INSERT OR REPLACE`) has no link and `summary_json` NULL; the `created_at` check finds no row, and the panel says `noRecord`. After WP5b only the workflow writes the row (Q1). A failed Summarize writes no summary link, so the old summary stays true. A chained Enhance run (Q2) writes its summary link in the same run as its segment and speaker links. A later speaker confirmation makes the summary stale: the existing stale warning stays.

### 7.9 Checkpoint tables

- Columns follow the official `SqliteSaver` 1.1.0 (https://unpkg.com/@langchain/langgraph-checkpoint-sqlite@1.1.0/dist/index.js). That source defines a `checkpoints` table with `thread_id`, `checkpoint_ns`, `checkpoint_id`, `parent_checkpoint_id`, `type`, `checkpoint`, `metadata`. A column-by-column match with the DDL in this section is UNVERIFIED.
- The saver is new platform code in `srv/lib/llm/workflow/checkpoint-saver.ts` (Q16; proposed path, the file does not exist at c47cd80d). It inserts with `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM llm_runs WHERE id = ?)`; for a deleted run it inserts 0 rows and does not throw (check C6, 7.13). `task_path` is `''` when absent. `deleteThread` deletes from both tables itself, because a final status keeps the run row and the cascade does not fire. The saver does not swallow errors (3.4.8 rule 1).
- It implements `getTuple`, `list`, `put`, `putWrites`, `deleteThread`, not `getDeltaChannelHistory`. The base class declares that method (https://unpkg.com/@langchain/langgraph-checkpoint@1.2.0/dist/base.d.ts). The saver is not written yet, so this is a design rule, not a checked fact. `node:sqlite` has no `pragma()` or `transaction()` (https://nodejs.org/docs/latest-v22.x/api/sqlite.html), so it uses `withTransaction` and `prepareCached` (`db.ts:47-75`). `Uint8Array` binds to `BLOB` (check C2).
- Validation (D6; https://unpkg.com/@langchain/langgraph-checkpoint-validation@1.2.0/README.md). UNVERIFIED: how the suite makes thread ids. Decided 2026-10-17 (owner viewpoint, O7-3): production FKs stay, and the suite runs through the FK wrapper of 10.7, which creates the run row per thread id (a test-only schema would prove a different table). Contingency, only if the wrapper fails in WP4: drop the FK from `thread_id` to `llm_runs`, add an `AFTER DELETE` trigger on `llm_runs`, record it in 12.1 (R11).
- Deletion rule (O7-2): the runner calls `deleteThread(runId)` at every final status (`succeeded`, `partial`, `failed`, `cancelled`) and keeps checkpoints only for `interrupted` (3.4.6 step 5). Only an `interrupted` run can resume (3.4.7 guard 3). A guard failure of 3.4.7 (guards 4 and 6) deletes the thread too. The inspector record is never pruned (P9).

### 7.10 Indexes

The seven `idx_` indexes serve: FK delete scan meeting to runs (`idx_llm_runs_meeting`), run list of a scope id (`idx_llm_runs_scope`), boot sweep (`idx_llm_runs_open`), attempt timeline (`idx_llm_calls_run`), calls of a scope id (`idx_llm_calls_scope`), 7.8 lookups (`idx_llm_call_links_target`), FK delete scan call to links (`idx_llm_call_links_call`). Other FK child columns lead a primary key. Checks D1 to D7 (7.13) show index use. UNVERIFIED: a partial index for failed calls.

`uq_llm_call_links` makes a duplicate link insert fail (https://www.sqlite.org/lang_createindex.html, section 1.1: a duplicate in a UNIQUE index is an error). A replayed `save` becomes an update only if the statement is an upsert or `INSERT OR REPLACE` (4.6.2). Check 2026-10-17 on the 7.4 DDL (7.13, group 2 setup): a second identical link insert fails with `UNIQUE constraint failed: llm_call_links.call_id, llm_call_links.target_type, llm_call_links.target_id, llm_call_links.seq`. The 2-row result without the index is author-reported, not re-run. `EXPLAIN QUERY PLAN` shows `idx_llm_call_links_target` for the 7.8 lookup, `idx_llm_runs_meeting` for `WHERE meeting_id = ?`, `idx_llm_runs_scope` and `idx_llm_calls_scope` for scope lists, `idx_llm_calls_run` for the call timeline.

### 7.11 Size estimate

ESTIMATE from a scratch database of random words; the script is not in the repo, so the table cannot be repeated (UNVERIFIED). Each correction call has: system 2,500 characters, user 5,000, schema 1,200, ledger 600, raw and parsed 2,000 each, and three links.

- System part: 2,500 is a planning value (prompt text: `srv/lib/meetings/enhance-prompt.ts:16-26,48-50,91-112`). `buildEnhanceSystemPrompt` at c47cd80d returned 1,704 characters (no vocabulary, no speaker labels), 1,959 with five vocabulary terms, 4,291 with two speaker labels (2026-10-17). The new correction prompt has no speaker block (4.2) and is not written (UNVERIFIED). 1,959 would lower the per-call total of 13,300 characters by 4 percent.
- User part: 5,000 comes from issue #163: user prompts of 4,692 to 5,014 characters for the 8 chunks of one meeting (https://github.com/Maheidem/openstyle/issues/163).
- Schema, ledger, raw and parsed sizes, and the speaker call (12,000 characters), are UNVERIFIED guesses.
- Summary call (chained, Q2): one call of 32,000 characters = 8,000 tokens (`srv/lib/meetings/summarize.ts:49`) × 4 characters per token (`llm-call.ts:24-26`). `summary_json` (a few KiB, UNVERIFIED) and `scope`/`scope_id` (under 100 bytes per row) are not in the table.

| Enhance chunks | Calls | Inspector rows | Checkpoints, state 30 KB | Checkpoints, state 200 KB |
|---|---|---|---|---|
| 8 | 10 | 180 KiB | 228 KiB | 1.2 MiB |
| 40 | 42 | 624 KiB | 860 KiB | 4.6 MiB |
| 120 | 122 | 1.7 MiB | 2.4 MiB | 13 MiB |

A checkpoint holds the state channel values at each super-step (https://docs.langchain.com/oss/javascript/langgraph/checkpointers), so transcript text in the state repeats in every checkpoint. Section 3 keeps the segment text in the state (3.3, about 190 KB for 4 hours), so the 200 KB column applies. The 30 KB column fits a state with ids and small results only, which 3.3 rejects. Map and reduce summaries add up to 24 calls (`summarize.ts:108`), not modeled. The record can be the largest part of the database file. The record has no limit (O7-1), so a release check reports the size of the `llm_*` tables and of the database file for the benchmark meetings (`dbstat` or `ls -l`; a measurement, not a cap).

### 7.12 Retention, delete and boot sweep

The FKs delete the record with its meeting. `DELETE /api/meetings/:id` (`meetings.ts:2265,2283`) and `resetMeetingTables` (`tests/helpers/meetings-db.ts:6-9`) need no change (checks C1 to C4, 7.13): the meeting delete removes its `llm_runs` rows through `meeting_id`, and the other five tables follow through the run row (P2). A new scope brings its own cascade root (a nullable FK column on `llm_runs` in its own migration, or an explicit delete by its owner); this spec ships the meeting scope only. A run of a scope with no cascade root survives a meeting delete (P9). The retention sweep still deletes WAV files only (`srv/lib/meetings/retention.ts:12-17`). Route code must not delete `llm_*` rows on re-transcribe or re-diarize. The record has no age or size limit (D10, O7-1).

Boot sweep. A killed process leaves `running` rows, and the job registry dies with it (`srv/lib/meetings/job-registry.ts:10`). `startServer` calls the new `sweepInterrupted()` once, next to the other start-up calls (`srv/index.ts:215-216` holds the other start-up calls; `sweepInterrupted` does not exist at c47cd80d, it is a planned new call). A different sweep fails `meetings` rows of killed jobs (`apps/electron/src/main/meeting-recorder.ts:803`). The sweep reads no meeting table and ignores `scope`. A resume (section 3) sets the run back to `running`. WP2 ships `sweepInterrupted()`; WP5b replaces it with `sweepOrphanRuns()` (3.4.7, 11.5).

```sql
UPDATE llm_run_steps SET status = 'interrupted', finished_at = ?
 WHERE status = 'running' AND run_id IN (SELECT id FROM llm_runs WHERE status = 'running');
UPDATE llm_runs SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE status = 'running';
```

### 7.13 Proof run

Group 1, author-reported and UNVERIFIED: scratch scripts `exp.mjs` to `exp4.mjs` (not in the repo; no copy found in `/private/tmp` or the dev folder, depth 5, 2026-10-17) ran on the earlier DDL with `meeting_id` on every table. Check ids A1 to A3, C1 to C6, D1 to D7, E3, S10, S11 come from them and were not re-run. The 7.8 queries use new join keys (`scope_id`), so they are UNVERIFIED until the tests of 7.3 and section 10 run them.

Group 2, re-run 2026-10-17 on the 7.4 DDL (scratch script, not in the repo; Node 26.5.0, SQLite 3.53.4, in-memory, `foreign_keys = ON`, hand-written copies of `meetings`, `meeting_segments`, `meeting_summaries`):
- The 7.4 SQL ran twice with no error: 6 `llm_*` tables, 7 `idx_llm_*` indexes, 1 `uq_llm_*` index; `PRAGMA foreign_key_check` empty.
- `summary_json` was added once with the column test of 7.3; a second run did not add it again.
- Cascade: 3 runs (two meetings, one run of scope `other` with `meeting_id` NULL), each with 1 step, call, link, checkpoint and checkpoint write. `DELETE FROM meetings WHERE id = 'm1'` left 2 rows in each of the 6 tables (run of `m2`, run of scope `other`).
- A run insert with an unknown `meeting_id` failed with `FOREIGN KEY constraint failed`.
- A link survived `INSERT OR REPLACE` and `DELETE` on the segment row (1 row before and after).
- Query plans: 7.10. FK column indexes: 7.1.

Not re-run: the SQLite version in Electron 39.8.10 (UNVERIFIED; the DDL uses no `STRICT`, generated column or `RETURNING`), and the real `initSchema` with step 40 (the 7.3 tests must run it).

### 7.14 Files that change in section 7

Work breakdown: section 11 (WP2; Remix removal is a separate work package). Paths are proposals.
- New platform files (Q16, no meeting import): `llm/call-record.ts` (5.1 types), `llm/recorder.ts` (7.7), `llm/record-read.ts` (generic reader, 8.3), `llm/workflow/checkpoint-saver.ts` (7.9; WP4).
- New meeting files: `srv/lib/meetings/llm-record.ts` (scope helper, link targets), `srv/lib/meetings/llm-record-read.ts` (7.8 queries), `srv/lib/meetings/input-hash.ts` (`HashRow`, `loadHashRows`, `inputHash`, `hashVariantOf`: 4.1 P11).
- Shared types (WP2): new `llm-types.ts` holds `LlmScope`, `LlmMessage`, `LlmParamsLedger` and the 8.4 types. `meeting-types.ts` gets `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason` (5.1, rule B).
- Edits: `schema.ts` (six tables, `summary_json`, Remix drop), `srv/index.ts` (one `sweepInterrupted()` call), the two version-pin tests, `AGENTS.md:50`.

### 7.15 Decisions (closed questions of section 7)

No open question of section 7 is left for section 12. All are decided on 2026-10-17.

- O7-1 (owner viewpoint): the record has no limit on age or size. Reason: the owner wants a measurement, not a fixed limit. 7.11 shows about 0.6 MiB of inspector rows for 40 chunks; a release check reports the growth.
- O7-2 (owner viewpoint): checkpoints are deleted at every final status and kept only for `interrupted` (7.9; 3.4.6 step 5). Keeping `failed` checkpoints needs a guard 3 that accepts `failed`, which this spec does not plan. 12.4 follows it; GR17 tests it (10.8).
- O7-3 (owner viewpoint): production FKs stay; the validation suite uses the wrapper of 10.7 (7.9). The trigger fallback is a contingency in R11 (12.1).
- O7-4 (decided in 9.10, confirmed): no `trace_id` column in `llm_calls`. The trace log and MLflow carry the trace; the record is local.
- Q12, Q17, Q16, Q9, Q13 (owner): decided in 7.3, 7.3, 7.4, 7.4 and 7.6.

---

## 8. LLM inspector

The inspector shows the record of section 7 in the meeting screen. Owner intent (D10): in the transcript screen the user clicks an edited text and sees exactly the message sent and received. It is hidden by default and enabled in Advanced. Scope: text corrections, speaker suggestions, summary, failures and retries. The data API and the types are scope-generic (I6). The panel serves meetings only. Non-goals: prompt editing, call replay, export, search across meetings, token streaming, a server check of `advanced_mode`.

Path keys (baseline c47cd80d): `S/` and `srv/` = `apps/server/src/`; `E/` = `apps/electron/src/`; `ui/` = `apps/electron/src/renderer/src/`; `L/` = `S/lib/llm/`; `meetings.ts` = `srv/routes/meetings.ts`; `enhance.ts` = `srv/lib/meetings/enhance.ts`; `detail.tsx` = `ui/pages/meetings/detail.tsx`; `speakers.tsx` = `ui/pages/meetings/speakers.tsx`; `en.json`, `template.json`, `locales.test.ts` = files in `ui/locales/`; `meeting-types.ts` and `llm-types.ts` = files in `packages/validations/src/`. A file called "new" or "planned" does not exist at the baseline (`llm-types.ts` is planned).

### 8.1 Current state

- A segment is a `Fragment` of three grid cells with no row element, handler or test id (`detail.tsx:830-872`). The renderer segment type has `id` and `enhancedText` (`ui/pages/meetings/types.ts:12,15`). The server adds both in `loadMergedTranscript` (`meetings.ts:271-272`). `GET /:id/transcript` returns `{ segments: loadMergedTranscript(...) }` (`meetings.ts:2208-2212`), so both fields reach the client.
- An Enhance failure is `useState`, lost on reload. Only the 502 answer carries a `reason`; 404, 409, 500 give none and the renderer uses `"provider"` (`detail.tsx:79-89,364-375`; `meetings.ts:2104-2199`). A failed auto-run shows nothing (`meetings.ts:1103-1117`). Summarize failures use in-memory `job_error` (`detail.tsx:418-419`).
- A dropped speaker proposal writes no `meeting_speakers` row: the evidence guard skips it before `nameProposals` (`enhance.ts:587-599`). A later chunk that names the same label differently loses; the earlier chunk wins (`enhance.ts:608-616`). The upsert runs over `nameProposals` only and Enhance never deletes a row, so an older row stays (`enhance.ts:658-672`). The only `DELETE FROM meeting_speakers` statements are in re-transcribe (`meetings.ts:1552`) and re-diarize (`meetings.ts:1828`); each removes all rows of the meeting. `GET /:id/speakers` is read-only (`meetings.ts:1863-1942`). `summary.llm_provider`, `llm_model`, `cost_usd` reach the client: `GET /:id` runs `SELECT *` on `meeting_summaries` (`meetings.ts:2226-2239`) and returns `summary ?? null` (`meetings.ts:2252`); `meeting-types.ts:59-65`). No file under `ui/pages/meetings/` reads them (`grep`, 2026-10-17), so the Summary tab shows none (`detail.tsx:894-921`).
- `advanced_mode` is a settings key (`packages/validations/src/settings-keys.ts:6`). Only renderer files read it, each as `=== "true"`: `ui/shell.tsx:179`, `ui/pages/models/index.tsx:40`, `ui/pages/help.tsx:149`, `ui/pages/settings.tsx:516`; `settings.tsx:726-729` writes it. No file in `apps/server` reads it (`grep`, 2026-10-17). `detail.tsx:177-179` reads the settings query for `calendarEnabled` only (`advancedMode` is read in `ui/shell.tsx:179`); the inspector gate reuses that query (8.5). A bearer-token middleware guards every route except `/api/health` (`srv/index.ts:76`; `srv/lib/auth.ts:47,67`). On a loopback host with no explicit token, a request from a trusted renderer origin, or with no Origin, also passes (`srv/lib/auth.ts:55-58,69-74`). `srv/index.ts:198-203` only sets the `allowTrustedOriginFallback` flag, and only when the host is loopback, no explicit token exists and `!options.tokenIsRetrievable`.
- Pane width: 1152 px window (`E/main/windows/settings-window.ts:66`) - 220 sidebar (`ui/shell.tsx:231`) - 96 padding (`padding-inline: 3rem`, `ui/globals.css:350-352`) - 262 list - 24 gap (`ui/pages/meetings/index.tsx:189`) = 550 px. A 320 px right column leaves 230 px: too narrow. No `Sheet` component exists (`find`, `grep`, 2026-10-17), although `DESIGN.md:269` names one.

### 8.2 Decisions of this section

- I1: No server `advanced_mode` gate. It is a display preference; the data is the kind the transcript API already serves; the auth middleware guards the route (8.1); the renderer is the only client.
- I2: The renderer shows every inspector entry only when `advanced_mode` is `"true"`.
- I3: The failure notice is not an inspector part. It shows for all users from the persisted run status (8.9).
- I4: The panel is a non-modal overlay at the bottom of the detail pane. It neither dims nor blocks the transcript.
- I5: Routes send two sizes, light summary and full call. The renderer asks for one full call at a time.
- I6: Generic data API (round 2, Q16). Run and call rows carry `scope` and `scope_id` (7.4). The read module and the types hold no meeting name. The meeting routes of 8.3 pass `scope = 'meeting'`. The inspector UI stays meeting-only. A later feature adds its own route and panel on the same module and types.
- I7: Imported meetings show their prompts like recorded meetings (Q3). No special case for a meeting source.
- I8: No feature flag (Q1). The inspector and the failure notices read the persisted record of the only workflow. A meeting made before migration 40 has no record; the panel shows `noRecord`.

### 8.3 API

Two routes go in a new sibling router `S/routes/meetings-runs.ts` (3.1, 11.4). They are the meeting adapter of a generic record API: each handler reads `:id`, checks that the meeting exists, and calls the scope-generic reader with `scope = 'meeting'`, `scope_id = :id`. The nearest sibling router is `S/routes/meetings-import.ts` (one route, `POST /import`, `:109`). `S/routes/index.ts` mounts `meetings` then `meetingsImport` on `/meetings` (`:47-48`). It will mount `meetingsRuns` the same way, after `meetingsImport`, so the client path stays `api.meetings[":id"]["llm-runs"]`. Use the 404 pattern of `meetings.ts:1863-1867` and `zValidator("query", ...)` (`srv/routes/history.ts:44`). The queries (7.8) and the camelCase mapping live in new `L/record-read.ts`, which takes `scope` and `scope_id` as arguments. Meeting-only parts of the read (the stale-label check with `inputHash`, 7.8 Speaker) live in a small meeting helper that the meeting router passes in. Deleting a meeting removes its runs and calls through the nullable `meeting_id` FK with ON DELETE CASCADE (7.4, D10); the routes need no delete code.

**GET /api/meetings/:id/llm-runs**: `run_id` (one run with all steps in `seq` order; unknown id 404); `limit` (1 to 50, default 10; newest first). Without `run_id`, each run lists only `failed`, `partial`, `interrupted` or `running` steps. `latest="1"`: the newest run of each kind with its failed steps, for the notices of 8.9; it excludes `run_id` and `limit`. Answer `LlmRunListResponse`, ending `satisfies LlmRunListResponse` (as `meetings.ts:2253`).

**Step counts for the partial notice.** `latest=1` lists only bad or open steps, so a client cannot count the others. The reader returns `llmStepCount` and `failedStepCount` in each `LlmRunInfo` (8.4). `llmStepCount` is `SELECT count(*) FROM llm_run_steps WHERE run_id = ? AND node IN (:llmNodes)`. `failedStepCount` is the same query with `AND status IN ('failed','partial')`. The generic reader knows no node name, so the caller passes `llmNodes`. The meeting adapter passes `["correctChunk","identifySpeakers","summarize"]` (the `LlmStepId` values, 5.1); the code nodes `prepare`, `verify`, `save` are excluded. A step that never started has no row and is not counted. The counts are the same for `run_id`, `limit` and `latest=1` answers. WP2 writes the reader and the two fields. WP5b reads them and computes nothing from the `steps` array.

**GET /api/meetings/:id/llm-calls**: `call_id`; `run_id` + `step_key` (attempts of one step); `target_type` (`segment`|`speaker`|`summary`) + `target_id` (optional for `summary`); `failed="1"`; `detail` (`summary` default | `full`); `limit` (1 to 50, default 20; `full` max 10).
1. Exactly one selector: `call_id`; or `run_id`+`step_key`; or `target_type`+`target_id`; or `run_id` alone; or `failed`; or none. A mixed query gets 400.
2. `detail=full` needs one of the first three selectors, else 400 with a message. `detail=full` with `limit` above 10 also answers 400 (the route does not clamp).
3. A `summary` target returns the calls of the run that made the current summary. A `speaker` target returns the proposal calls of the producing run with that label's links. A `segment` target returns at most one call. All use 7.8.
4. No record: `200` with `{ "calls": [] }`. Unknown meeting: 404. A run of another scope never appears (the reader filters on `scope` and `scope_id`). Query values are strings; the schema coerces numbers.

Sizes: `llm-runs` 1 to 10 KB (20 to 40 KB for 120 steps); `llm-calls` about 1 KB each, `full` about 15 KB.

### 8.4 Types

The generic types go in new `llm-types.ts`, and WP2 adds its export line to `packages/validations/src/index.ts` next to the `meeting-types.js` export (`index.ts:12`; no `llm-types` export exists at the baseline). `meeting-types.ts` holds types only (`meeting-types.ts:3-5`); `llm-types.ts` will hold types only too. WP2 declares there the types below, and also `LlmMessage` and `LlmParamsLedger` (7.5). The meeting-only types `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus` (4.4) and `CorrectionDropReason` (4.2) stay in `meeting-types.ts`; `LlmLinkInfo.verdict` imports `SpeakerVerdict` as a type (V half of rule B, 5.1). WP3, WP5a and WP5b import these types and declare none again.

```ts
export type LlmScope = "meeting" | "test";   // "test": runs of scope "test" have meeting_id NULL (WP2 check 7, WP4 saver wrapper). A new consumer adds its word here in its own PR; it edits no file under L/
export type LlmRunKind = "enhance" | "summarize";   // an "enhance" run also holds the chained summarize steps (3.2)
export type LlmRunStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted" | "unknown";
export type LlmStepStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "skipped" | "cancelled" | "interrupted" | "unknown"; // partial: some halves of the step ended ok, others failed (4.0.7)
export type LlmTargetType = "segment" | "speaker" | "summary";   // the meeting targets; a link is generic by (target_type, target_id). outcome: "applied" | "dropped"
export interface LlmStepInfo {
  key: string; node: string; status: LlmStepStatus;
  seq: number;             // start order of the step in the run, from 1 (7.4, 7.7 rule 3). The Run view sorts by it
  attempts: number;        // calls started
  recordedCalls: number;   // call rows that exist; less than attempts = gap
  errorKind: string | null; errorDetail: string | null;
  startedAt: number | null; finishedAt: number | null;
}
export interface LlmRunInfo {
  id: string; scope: LlmScope; scopeId: string;   // llm_runs.scope, scope_id (7.4)
  kind: LlmRunKind; startedBy: "auto" | "button"; // the original trigger. A resume never changes it (3.4.3)
  resumeCount: number;     // llm_runs.resume_count. Above 0 means the run was resumed
  status: LlmRunStatus;
  graphVersion: number; startedAt: number; finishedAt: number | null;
  errorKind: string | null; errorDetail: string | null;
  callCount: number; failedCallCount: number;
  llmStepCount: number;    // LLM-node steps of this run, all statuses (8.3). {{total}} in 8.9
  failedStepCount: number; // LLM-node steps with status `failed` or `partial`. {{failed}} in 8.9
  correctedCount: number | null; suggestionCount: number | null; lostRecords: number;   // first two from parsed `llm_runs.result_json` (3.4.6 step 3, 7.4); null when absent. lostRecords is a column
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

`summary_json` of `meeting_summaries` (migration 40, 7.4) is not part of these types. The Summary tab reads the summary through the meeting detail. The Call view shows the same object as the `parsed` block.

A JSON column that does not parse becomes `null`. The route never fails on bad stored JSON. A status, outcome or error kind the code does not know reads as `unknown` (7.2 P7).

### 8.5 Renderer data layer

Add to `queryKeys.meetings` (`ui/lib/query.ts:50-61`):

```ts
llmRunsLatest: (id: string) => ["meetings", "llm-runs", id, "latest"] as const,
llmRuns: (id: string, runId?: string) => ["meetings", "llm-runs", id, runId ?? "all"] as const,
llmCalls: (id: string, selector: string) => ["meetings", "llm-calls", id, selector] as const,
```

Client (hyphen path, as the existing `retry-failed` call at `detail.tsx:271-273`; `llm-runs` is a planned route and appears in no code at the baseline): `getClient().api.meetings[":id"]["llm-runs"].$get({ param: { id }, query: { limit: "10" } })`.
- `llmRunsLatest(id)` (`latest=1`) is enabled when `hasTranscript`, not gated by advanced mode. It feeds the notices of 8.9. `llmRuns(id)` (limit 10, Runs view), `llmRuns(id, runId)` and `llmCalls(id, selector)` run only when `advancedMode` is on and the panel shows that view.
- `resumeRun(runId)` posts to `POST /api/meetings/:id/runs/:runId/resume` (3.4.2), then refetches `llmRunsLatest` and the detail query, so the one-second poll starts.
- Invalidation: add `["meetings","llm-runs",id]` and `["meetings","llm-calls",id]` to the job-end effect (`detail.tsx:192-206`), and fire it when a Summarize job ends too. While the panel is open and a job runs, open queries refetch every 2 s (the detail query polls every 1 s only while status is `transcribing` or job kind is `summarize` or `enhance`, else `refetchInterval` returns `false`, `detail.tsx:122-127`).

```ts
type InspectorTarget =
  | { kind: "runs" } | { kind: "run"; runId: string }
  | { kind: "segment"; segmentId: string } | { kind: "speaker"; label: string } | { kind: "summary" };
const [inspector, setInspector] = useState<InspectorTarget | null>(null);
const selectedSegmentId = inspector?.kind === "segment" ? inspector.segmentId : null;
const advancedMode = appSettings?.[SETTINGS_KEYS.advancedMode] === "true";   // appSettings: the settings query, detail.tsx:177-179 (new use; today only calendarEnabled)
const inspectorVisible = advancedMode && inspector !== null;
```

When the setting turns off, the panel unmounts and every entry disappears. `inspector` stays in memory until the view drops (`key={activeId}`).

### 8.6 Entry points and layout

**Edited text (main entry).** Today the segment is a plain `Fragment` with key `` `${seg.speaker}-${seg.startMs}-${seg.endMs}` `` (`detail.tsx:834-836`); no `div`, `contents` class or test id exists. The `Fragment` (`detail.tsx:831-872`) will become `<div className="contents" data-testid="meetings-segment" data-segment-id={seg.id}>`. The three grid items stay; the new key will be `seg.id` with the old template key as fallback. When `advancedMode && seg.id && seg.enhancedText !== undefined`, the text becomes `<button type="button" data-testid="meetings-segment-inspect" title={t("meetings.inspector.inspectCorrection")} aria-expanded={selectedSegmentId === seg.id}>` (no `aria-label`: it would replace the text as accessible name) (dotted underline; grey `bg-accent` when selected) that opens the Call view. It will show in both modes of the Enhanced/Raw switch. The switch state is at `detail.tsx:96`; the switch renders only when `hasEnhanced` is true (`detail.tsx:437,800-812`). No inspector button exists at the baseline. A button in a `<p>` is valid HTML (https://html.spec.whatwg.org/multipage/grouping-content.html#the-p-element). UNVERIFIED: `display: contents` on a `div` in Electron 39 Chromium, and Playwright visibility of it.

**Other entries** (advanced mode only): a new toolbar button `meetings-inspector-open` opens Runs; no such test id exists today. Place it in the toolbar near `SummaryInstructionsPopover` and the Reveal-in-Finder button (`detail.tsx:579-590`). "Inspect" on each speaker row (`speakers.tsx:146-153`; none today) opens Speaker; the dialog is modal (`speakers.tsx:303-304`), so `onInspectSpeaker(label)` closes it first. "Inspect" in the Summary tab opens Summary, next to the Summary `CopyButton` (`detail.tsx:906-911`; no Inspect entry today). "Show details" in the failure notice (8.9) opens Run. A label whose proposals were all dropped still gets a row in the speakers answer, because segment labels drive that query (`meetings.ts:1869-1878,1909`). The answer has no field for dropped proposals today (`meetings.ts:1909-1927`); the Speaker view will show them (8.7; 7.8 Speaker 2 and 3).

**Panel.** `<aside role="complementary" aria-label>` as the new last child of the root `<div>` that `MeetingDetailView` returns (component `detail.tsx:60-983`, returned JSX `:459-981`). No `aside` exists there; the last child at the baseline is the re-diarize `AlertDialog` (`detail.tsx:960-980`). Style: `sticky bottom-0`, `max-h-[min(60vh,28rem)]`, `bg-card`, as wide as the pane. The pane is 550 px at a 1152 px window (page padding 3rem per side, `ui/globals.css:350-352`). It is 330 px at 900 px, where the two columns start (`ui/pages/meetings/index.tsx:189`) and padding is 2rem per side (`ui/globals.css:363-368`; 1rem below 821 px, `:377-382`). The window minimum is 720 by 480 px (`E/main/windows/settings-window.ts:66-69`). No window of 900 px exists in code: it is a CSS breakpoint. The design holds at 330 px, and blocks scroll sideways. The transcript stays clickable. The scroll container gets `scroll-padding-bottom` equal to the panel height, and opening the panel calls `scrollIntoView({ block: "nearest" })` on the clicked row. Not `Dialog` (dims and blocks, `ui/components/ui/dialog.tsx:34-48`), not `Popover` (288 px, `ui/components/ui/popover.tsx:30`), not a right column (230 px). UNVERIFIED: `sticky` in this scroll container (`ui/pages/meetings/index.tsx:183-186`). The proof checks 1152 by 648, 720 by 480 and 900 by 600 px (the third is this spec's choice). `Escape` closes the panel and returns focus. The close button has test id `meetings-inspector-close`. No focus trap.

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

New files `ui/pages/meetings/llm-inspector.tsx` (panel, views) and `llm-call-view.tsx` (call detail), imported from `detail.tsx` (this spec's choice). The `knip` gate needs each new file imported or listed in `knip.jsonc` (`AGENTS.md:85`).

**Call view.** Blocks in order: Attempts (`recordedGap` when `attempts` > `recordedCalls`); Overview (provider, requested vs served model with a destructive line if different, finish reason and raw value, token counts, queue wait, latency); Error (shown when `errorKind` is set, even if `parsed` exists); Change (segment target only: "Before" raw text, "After" applied text, count of changed segments); Dropped corrections (each drop of this call with its reason, 7.5); Messages sent (open); Output schema; Parameters (request fields, extra body fields, "Not sent" with reasons, source); Raw response (open; `noResponse` when null); Parsed object (the validator message from `errorDetail` when null); copy buttons. A mono block is `<pre className="mono ...">` with `overflow-auto`. Copy buttons reuse `CopyButton` (`ui/pages/meetings/shared.tsx:62-80`). UNVERIFIED: a 500,000-character `pre`.

**Speaker view.** One row per link of the producing run: step key, name, kind, evidence in mono, and a badge "Kept" or "Dropped" (outline style; a drop is not a failure) with the reason. "Current" when `appliedText` equals the current suggestion (7.8 Speaker 1; planned, 10.10); the renderer holds the suggestion as `suggestedName` (`ui/pages/meetings/speakers.tsx:39,97,131`; `detail.tsx:160-172` only fetches the speakers; `ui/pages/meetings/types.ts:41`). No "Current" badge and no `appliedText` exist at the baseline (`grep`, 2026-10-17). "Spelling fixed to {{name}}" when respelled; a link to `winnerCallId`; failed calls in destructive style. Data: `GET /llm-calls?target_type=speaker&target_id=<label>` (`summary`), then `call_id` (`full`).

**Summary view.** Calls of the run that made the current summary ("Single", or "Map 1" to "Map N", then "Reduce"). The label comes from `step_key` (4.0.7): `single` is "Single", `map:<i>` is "Map" with number `i + 1`, `reduce:<level>:<group>` is "Reduce" (several levels add level and group). A half such as `map:2/0` shows as a part of "Map 3". The header shows `llm_provider`, `llm_model` and `cost_usd` of the current summary. When Enhance chained into the summary, the summary calls belong to the Enhance run and the view lists them from that run. The header values come from the `summary` object of the meeting detail (`meeting-types.ts:59-65`), not from a run row: `llm_runs` has no such columns (7.4). A NULL cost means an unknown price (`srv/lib/meetings/summarize.ts:512-515`) or a call with no text (`srv/lib/meetings/summarize.ts:408`). Data: `target_type=summary` (`summary`). The summary has five fields (overview, key points, decisions, action items, open questions), and code renders them to Markdown. The `parsed` block shows these fields as data.

**Runs view.** Runs newest first. "Failures" on top: each `failed`, `partial` or `interrupted` step of the newest run of each kind opens the Call view for its last attempt (for a `partial` step, the last attempt of the first failed half). A run opens the Run view (steps in `seq` order). A step with no call row shows its error in a block.

**Empty states.** `noRuns` (Runs view and toolbar button still open). `noRecord` for an edited text with no call, a stale link or a meeting made before migration 40 (the panel does not guess). `recordLost` when `lostRecords` is above 0: calls ran, but their record write failed. `loadFailed` with a retry button. A neutral loading line.

### 8.8 Design tokens

Panel `bg-card`, `border-border` (`ui/components/ui/dialog.tsx:65`). Selected text (8.6) and the selected attempt use `bg-accent` (this spec's choice; `specs/design-system.md:176-182`). Prompts, responses, JSON, ids and numbers use `.mono` (`ui/globals.css:218`) and `tabular-nums` (as `detail.tsx:638`). Failures use `InlineNotice tone="destructive"` with `className="mb-3"` (`ui/components/inline-notice.tsx:4-7,14,20,28`; `detail.tsx:722,764`) and `Badge variant="destructive"`; neutral badges use `Badge variant="outline"` (`ui/components/ui/badge.tsx:20-23`). `StatusBadge` maps `failed` and `interrupted` to `destructive` and every other status to `outline` (`ui/pages/meetings/shared.tsx:29-32,43`). No blue (`accent-passive`) outside its three allowed uses: selected-nav state, speaker chips and the `Badge` `passive` variant (`specs/design-system.md:150-156`). No coral (`--live`: record, live and in-progress only, `specs/design-system.md:172-175`); a running step uses a neutral badge (this spec's choice).

### 8.9 Persisted run status replaces the component Enhance error state

The new workflow replaces the `enhanceFailure` path (8.1) directly (round 2, Q1): no flag, no dual path. Notices are a function of the newest run of each kind, from `llm-runs?latest=1` (8.3, 8.5). The generic `actionError` notice still shows other non-2xx answers (`detail.tsx:719-725`).

```ts
const runs = llmRunsLatest.data?.runs ?? [];
const latest = (kind: LlmRunKind) => runs.find((r) => r.kind === kind);
const noticeRun = (kind: LlmRunKind) => {
  const r = latest(kind);
  return !jobHoldsSlot && r && ["failed", "partial", "interrupted"].includes(r.status) ? r : null;
};
```

**Chained runs (Q2).** The Enhance trigger, from auto-run and button, chains into Summarize in the same run (3.2). The `enhance` run holds the correction, speaker and summary steps. A failed summary step of an `enhance` run shows in the Enhance notice with node label "Summary". The separate Summarize button starts its own `summarize` run with its own notice. Speaker names the user confirms later make the summary stale; the existing stale warning stays. While the run is active, the banner names the running stage: the job kind changes from `enhance` to `summarize` when the Summarize stage starts (`setJobKind`, 3.6), and the Enhance button posts once and polls one run.

**Lines (all users, D4, G4).** A notice lists one line per distinct error kind among the steps with status `failed` or `partial`, for example "Corrections, chunks 4, 7: The model reached its output limit." A `partial` step counts as failed here, because part of its text was not corrected (4.0.7). A line holds a node label, the chunk numbers for `correctChunk`, and the `meetings.llmError.<kind>` text, never prompt text. A run with no failed step (`budget_exceeded`, `graph_changed`, `transcript_changed`, `interrupted_before_checkpoint`, `internal`) shows one line from `run.errorKind`. The inspector keeps per-call detail, in advanced mode only.

- `failed`: destructive; `meetings.llmRun.<kind>.failed`; the lines; button "Start again" (test id `meetings-enhance-retry` for Enhance; `summarize()` for Summarize).
- `partial`: destructive; `meetings.llmRun.<kind>.partial` with `{{failed}}` = `run.failedStepCount` and `{{total}}` = `run.llmStepCount` (8.4; from the server; `run-notice.ts` does not count the `steps` array); the lines; "Start again".
- `interrupted`: neutral; `meetings.llmRun.<kind>.interrupted`; the lines when the run has a `failure`. Two buttons. "Resume" (`meetings-run-resume`) calls `resumeRun(runId)` and keeps the finished work (3.4.7). "Start again" starts a new run and discards the checkpoint of the stopped run (3.4.2 step 2); its label says so (`startAgainDiscards`). A resume that fails a guard answers 409 with a `ResumeConflict` (3.4.2); what follows depends on the guard (3.4.7). Guard 4 or 6 (`graph_changed`, `transcript_changed`): the run becomes `failed` and the checkpoint is deleted; the renderer refetches `llm-runs?latest=1` and the notice shows the `errorKind` line with "Start again". Guard 1, 2, 3 or 5 (`meeting_status`, `job_running`, `not_interrupted`, `no_checkpoint`): the run row does not change; the generic `actionError` notice shows the `error` text (`detail.tsx:211-243, 719-725`), the renderer refetches the run, and the buttons stay. For `no_checkpoint`, "Start again" is the way forward.
- `transcript_changed` for a Summarize run or the Summarize stage of a chained run (Q13): a speaker name the user confirmed, or (Summarize-only) a new `enhanced_text`, while the run is interrupted, fails the resume with `transcript_changed`. The notice shows that line with "Start again". No merge is offered.
- `succeeded` and `partial` Enhance runs: a neutral note as today (`EnhanceNote`, type at `ui/pages/meetings/types.ts:29-34`; note rendered at `detail.tsx:739-752`): `enhanceResult` with `correctedCount`, or `enhanceNoneCorrected` when 0. It shows only when the run ended after the page opened; a reload clears it.
- `cancelled`, `running`: no notice. A notice clears when a newer run of that kind ends or a run starts (`jobHoldsSlot`). In advanced mode a notice adds "Show details".
- **Renderer switch.** WP5b adds the new notices, the Resume button and their keys (8.10). In the same PR it deletes the old `enhanceFailure` state (`detail.tsx:87-89`), its reset in `runAction` (`:223`), the non-2xx branch of `enhance()` (`:364-375`), the old notice block (`:763-786`) and the `!enhanceFailure` condition (`:719-721`). The council (10.15) must reach consensus before that PR merges. WP5b also adds `llmRunsLatest`, `resumeRun` and the pure helper `run-notice.ts` (11.5). WP7 adds the inspector panel on top. Until WP7 merges the inspector is absent, so the old and new notices never both exist, and no merge leaves a failed run without a notice.
- The `POST /:id/enhance` contract is section 3's (3.4.2). The renderer does not read `reason`.
- **Decided 2026-10-17 (owner viewpoint):** the renderer stops reading `job_error` for Summarize. The persisted run holds the same failure, and a `cancelled` run status gives the cancelled text that `summarizeCancelled` drives today (`detail.tsx:418-420`). This closes O8-2.

### 8.10 i18n

All user text uses `t()`. New keys go in `en.json` and `template.json` first (`specs/model-picker-groups.md:393`). A missing key falls back to English (`locales.test.ts:10-15`). A `meetings.*` key that a locale carries keeps the `en.json` placeholders (`locales.test.ts:461-474`). A key in a test group must exist in `template.json` and in every locale file that `readdirSync` finds (`locales.test.ts:20-22`; at the baseline `de`, `en`, `es`, `fr`, `it`, `ja`, `pt` = 7 files) with the `en.json` placeholders (key and placeholder check `locales.test.ts:443-453`). Locale tests: section 10.

1. **Failure keys** (all users; `meetings.llmRun.*`, `meetings.llmError.*`) join the group `enhance-honesty` (`template.json` plus 7 locale files = 8 files; key list `locales.test.ts:194-203`, loop `:439-455`). WP5b adds them. In the same PR it removes `enhanceFailedTimeout`, `enhanceFailedParse`, `enhanceFailedProvider` (`en.json:1106-1108`; used `detail.tsx:767-771`; group `locales.test.ts:196-198`) and their group entries from all 8 files. `enhancePartial`, `retryEnhance`, `enhanceNoneCorrected` stay.
   **Languages and placeholders (decided 2026-10-17, owner viewpoint: existing keys of this group are translated in every locale, so the new ones are too).** WP5b writes English in `en.json` and `template.json`, and translated text for `de`, `es`, `fr`, `it`, `ja`, `pt`, as `enhancePartial` has (`de.json:911`, `ja.json:911`). An English copy is not allowed: the group test needs only a non-empty value, so a copy would pass and show English to a Japanese user. If a translation is unsure, the PR names the key. Each placeholder keeps its exact name: `{{failed}}`, `{{total}}`, `{{where}}`, `{{reason}}`, `{{list}}`; it may move inside the sentence (`locales/README.md:14-25`). Check: `pnpm --filter @openstyle/electron test locales.test.ts` (group loop `:439-455`; `meetings.*` guard `:457-474`). The PR pastes the line `Tests  N passed`.
2. **Inspector keys** (advanced only) go in `en.json` and `template.json`; a new test compares their `meetings.inspector.*` key sets.
3. **No toggle keys.** No feature flag (Q1), so no `settings.application.enhanceWorkflow` key and no toggle row.

`meetings.llmRun.{enhance|summarize}.*` (`<K>` = Enhance or Summarize): `failed` "<K> failed."; `partial` "<K> finished with errors. {{failed}} of {{total}} steps failed."; `interrupted` "<K> stopped when Openstyle closed." Shared keys `meetings.llmRun.*`: `line` "{{where}}: {{reason}}"; `node.correctChunk` "Corrections"; `node.identifySpeakers` "Speakers"; `node.summarize` "Summary"; `node.save` "Saving"; `chunks` "chunks {{list}}"; `resume` "Resume"; `startAgain` "Start again"; `startAgainDiscards` "Start again. This discards the finished work of the stopped run."

`meetings.llmError.*` (kinds of 7.6, owned by 5.2.1): `length` "The model reached its output limit."; `content_filter` "The provider blocked the answer."; `unexpected_tool_calls` "The model tried to call a tool."; `abnormal_stop` "The model stopped for an unknown reason."; `reasoning_leak` "The model put its reasoning in the answer."; `schema` "The answer did not match the required format."; `provider_timeout` "The model did not answer in time. Raise the timeout in Settings, then retry."; `provider_rate_limited` "The provider limited the requests."; `provider_unavailable` "The model could not be reached."; `provider_auth` "The provider refused the key."; `provider_invalid_request` "The provider refused the request."; `model_mismatch` "The server answered with another model."; `model_unavailable` "Openstyle cannot use the chosen model. Check Settings > Models, then try again."; `deadline_exceeded` "The summary took longer than its time limit."; `budget_exceeded` "The meeting is too long for the summary limit of 24 calls."; `empty_input` "The meeting has no text to process."; `save_failed` "Openstyle could not save the result."; `internal` "Openstyle stopped the run because of an internal error."; `interrupted_before_checkpoint` "Openstyle closed before the run saved any progress. Start again."; `graph_changed` "Openstyle was updated while the run was stopped. Start again."; `transcript_changed` "The transcript changed while the run was stopped. Start again."; `cancelled` "The run was cancelled."; `unknown` "An unknown error occurred." A kind with no key falls back to `unknown`. No text names an action for `budget_exceeded`: no screen sets `meeting_summary_context_budget` (`packages/validations/src/settings-keys.ts:67`; `grep -rn` finds no renderer reader, 2026-10-17).

`settings.application.advancedModeDesc` (`en.json:176`, `template.json:175`) becomes "Show the Models page for manual voice and cleanup model configuration, and the LLM inspector on meetings." Other locales keep their old text, which stays true.

`meetings.inspector.*` (verdict texts: 7.5). Labels are short ASD-STE words named by the UI elements of 8.7. Examples: `title` "LLM inspector"; `retry` "Try again"; `inspectCorrection` "Show the LLM call that changed this text"; `inspectSpeaker`, `inspectSummary` "Inspect"; `paramsDropped` "Not sent"; `runStatus.partial` "Finished with errors"; `stepStatus.pending` "Waiting"; `stepStatus.partial` "Partly failed". Sentences: `noRuns` "No LLM run exists for this meeting."; `noRecord` "No LLM record exists for this item. An older version of Openstyle made it, or no recorded call produced it."; `loadFailed` "The LLM record could not be loaded."; `noResponse` "The call returned no response."; `modelMismatch` "The served model is not the requested model."; `recordedGap` "{{missing}} calls of this step were not recorded."; `speakerLabelNote` "The speaker labels changed after this run. They may name other voices now."; `recordLost` "{{n}} calls of this run have no record, because the write failed."; `respelled` "Spelling fixed to {{name}}"; `changedCount` "This call changed {{n}} segments."; `attempt` "Attempt {{n}} of {{total}}". Groups: `runKind.*`, `runStatus.*`, `stepStatus.*`, `role.*`, `node.{single,map,reduce}`, `verdict.<code>`.

### 8.11 Files that change in section 8

See 3.1 and section 11. WP2: `L/record-read.ts`, the meeting stale-label helper, `srv/routes/meetings-runs.ts`, `llm-types.ts`, `meeting-types.ts`. WP5b: the notices of 8.9, the keys `meetings.llmRun.*` and `meetings.llmError.*`, the old-state deletion, `llmRunsLatest` and `resumeRun` in `query.ts`, new `run-notice.ts` and `run-notice.test.ts`. WP7: the panel and `meetings.inspector.*` keys; new `ui/pages/meetings/llm-inspector.tsx`, `llm-call-view.tsx`, `llm-inspector-model.ts`, `llm-inspector-model.test.ts`; edits to `ui/lib/query.ts` (`llmRuns`, `llmCalls`), `detail.tsx`, `speakers.tsx`, the 8 locale files (`en`, `template`, `de`, `es`, `fr`, `it`, `ja`, `pt`) and `locales.test.ts`.

### 8.12 Tests and proof

Unit and route tests: section 10. Real-app proof (Definition of Done; unit tests alone do not count; see 10.11.2 and section 11, WP7 and WP9):
1. **UI proof with seeded rows.** Recipe `.claude/skills/live-testing/SKILL.md:206-221` through `scripts/test-runner/run.sh` (`SKILL.md:202`), throwaway spec `apps/electron/tests/zz-proof-llm-inspector.test.ts` (new; name it `zz-proof-<topic>.test.ts`, delete it at the end, never commit it, `SKILL.md:210`). Seed with `POST /api/meetings/start`, then `sqlite3` on the isolated database (fictional rows). Seed one imported meeting and one recorded meeting; check that the panel shows the prompts of both (Q3). Set `PUT /settings/advanced_mode` (`apps/electron/tests/model-picker-groups.test.ts:342`). Take screenshots at 1152 by 648, 900 by 600 and 720 by 480 px. Show: advanced off; advanced on after a click (sent messages and raw answer, three columns intact, row visible above the panel); a failed step; a speaker with a dropped proposal; a summary with map and reduce calls; advanced turned off with the panel open; `enhanced_text` with no record. Count `AUTHREQ_PROMPTING` before and after (`SKILL.md:218-220`). Never start a recording.
2. **Read-back proof.** `sqlite3` row counts of the six tables; delete the meeting through the API; all six counts for it must be 0.
3. **Real model proof** (after sections 3 to 5). Enhance, with its chained Summarize, on a scratch meeting with the real oMLX Qwen3.8-27B only. No cloud provider gets a live proof (Q5). The panel messages must equal the request body of the `llm.request` entry for that call in `openstyle-trace.log`; the finish reason and token counts must match the `summary` of the `llm.response` entry. Source: `traceLlmFetch` (`S/lib/trace.ts:257-277`, entry at `:268`) is called by `createSamplingFetch` (`S/lib/llm/registry.ts:156-166,265-274`); `summarizeCompletion` reads `finish_reason` and `usage` (`trace.ts:184-204`); `writeTrace` sends entries to the log (`trace.ts:147-159`; `packages/utils/src/logger.ts:153-168`). Only the `server` provider reaches `traceLlmFetch` (`registry.ts:271`; `grep`, 2026-10-17). The log is a runtime file outside the repo with full transcripts. This spec did not read it. UNVERIFIED: the content of a real log entry.
4. **Failure proof.** Force a `length` stop with a small output budget. The run ends `partial` or `failed`; the notice shows after a reload; the Failures list shows the step and the typed error.

### 8.13 Decisions closed on 2026-10-17

No open question remains. Owner round 2 (`00b`) closed O8-1 to O8-3; Q3 and Q16 are in 8.2.

- O8-1 (owner viewpoint): the bottom-docked panel stays. The live proof (8.12 step 1) checks it at three window sizes. If `sticky` fails, the fallback is a panel over the full pane with a `Back to transcript` button.
- O8-2 (owner viewpoint): `job_error` for Summarize goes away in the renderer-switch PR (8.9).
- O8-3 (owner viewpoint): no "Inspect" entry on the speaker chips in the transcript. The speaker row already opens the Speaker view.

---

## 9. Tracing

This section defines trace log, opt-in MLflow export, span model, privacy, bundle size and read-back proof for workflow runs. Section 7 owns the local record (`llm_calls`). Section 5 owns the gateway.

Cite prefixes. Each prefix is shorthand for the base URL after it. A cite is the base URL plus the path. The cited files were read at these pins. `ai:` https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ , `mlflow:` https://github.com/mlflow/mlflow/blob/v3.16.1/mlflow/ , `unpkg:` https://unpkg.com/ , `npm:` https://registry.npmjs.org/ . Bare paths are in the repo at c47cd80d.

**Terms.** run = one workflow execution for one scope target (`llm_runs.scope`, `llm_runs.scope_id`; today `meeting`): Enhance or Summarize (3.4). An Enhance run chains into Summarize in the same run (Decided 2026-10-17, Q2). A Summarize button run is a separate run with kind `summarize`. node call = one execution of a node function (section 4); `correctChunk` has one per chunk; `summarize` has one, which opens several `llm_run_steps` rows (section 7: `single`, `map:<i>`, `reduce:<level>:<group>`). LLM call = one model request; a retry is a new one. local record = one `llm_calls` row. trace log = `openstyle-trace.log`. MLflow trace = all spans of one run. export = send of spans over OTLP/HTTP.

### 9.1 Decisions

D4, D5 (`maxRetries: 0`), D8 and D10 (1.1) apply. `callUnit` is the single retry layer (owner decision 2026-10-17).

| ID | Design decision (decided 2026-10-17, owner viewpoint: accepted as written) |
|---|---|
| T1 | Two environment variables enable the export. No setting key and no UI in this release. |
| T2 | The gateway passes the OpenTelemetry integration on each call. The code never calls `registerTelemetry`. |
| T3 | The integration is `LegacyOpenTelemetry`. |
| T4 | The exporter posts to `<base>/v1/traces` with header `x-mlflow-experiment-id`. |
| T5 | One run is one trace: run span as root, one child span per node call. |
| T6 | The gateway and `callUnit` set ERROR on the node span and the run span for every typed error. |
| T7 | A tracing fault never changes the result of a run. |
| T8 | Enhance runs and Summarize runs are both exported (Q9.6). Dictation cleanup never is. The Remix feature is removed in this work (9.11). |
| T9 | The tracing code is domain-agnostic. The run span name is `<scope>.<kind>` (`meeting.enhance`, `meeting.summarize`). Attributes `openstyle.scope` and `openstyle.scope_id` identify the target. |

Non-goals: authorization header, metrics, log export, sampling, MLflow run or artifact. The server never creates an MLflow experiment.

### 9.2 Current state (main at c47cd80d)

The repo has no MLflow or OpenTelemetry code (command in 9.9). `AGENTS.md:9` says "no telemetry".

### 9.3 The three records

```mermaid
flowchart LR
  N[Node call via callUnit] --> G[LLM gateway, section 5]
  G -->|every call| L[(llm_calls in freestyle.db)]
  G --> F[fetch wrapper, registry.ts]
  F -->|provider server only| T[openstyle-trace.log]
  F --> P[Model provider]
  G -.->|only when both env vars are set| O[LegacyOpenTelemetry, per call]
  O --> M[MLflowSpanProcessor, batch]
  M -->|POST /v1/traces, protobuf| S[(MLflow server)]
```

Local record: always on (D10), deleted with its meeting, read by the inspector (section 8). Trace log: on when the log folder is known, rotation about 15 MB, developer only. MLflow trace: off by default (D8), covers workflow runs only.

MLflow is not the UI for failures. The step status and the inspector show failures (D4, D10).

### 9.4 The trace log

This feature changes no line of `trace.ts`. It stays because it proves the exact wire body and covers call sites outside the gateway.

- Own logger and file (5 MB, 3 files); never feeds `openstyle.log` (`packages/utils/src/logger.ts:17-19,111-123`). Writes once the log folder is set (`logger.ts:117-119`); catches write errors (`apps/server/src/lib/trace.ts:148-159`).
- Only the `server` provider is traced, by `createSamplingFetch` (`apps/server/src/lib/llm/registry.ts:151-169,265-274`). `server` STT writes its own entries (`apps/server/src/lib/streaming/providers/server.ts:86`).
- Wire summary: `finish_reason`, `usage`, `reasoning_content_chars`; transport failure writes `llm.error` (`trace.ts:184-204,290-299`). Redaction covers only `Authorization` and `api_key` (`trace.ts:29-49`). The correlation id is per HTTP request (`apps/server/src/index.ts:79-84`); a `void` job most likely shares it (UNVERIFIED; `apps/server/src/routes/meetings.ts:1043,1564,2093`).
- Limits: no meeting id, node name or typed error; no Groq or cloud providers; deleting a meeting keeps its lines; the inspector does not read it.

### 9.5 MLflow export

#### 9.5.1 Gate

The export is off by default, so "no telemetry" stays true (`AGENTS.md:9`). It is on only when both variables hold a value.

| Variable | Meaning |
|---|---|
| `OPENSTYLE_MLFLOW_TRACKING_URI` | Base URL, starts with `http://` or `https://`. Example `http://192.168.31.154:5000`. |
| `OPENSTYLE_MLFLOW_EXPERIMENT_ID` | Experiment id, sent as header `x-mlflow-experiment-id`. Example `12`. |

1. If a variable is empty or missing, the export stays off. If exactly one is set, the server writes one warning at start.  (A silent "off" is a known trap: `/Users/maheidem/.claude/CLAUDE.md:70-72`.)
2. At start the server writes one line: `MLflow tracing: off`, or `on host=<host> experiment=<id>`. It never logs the full URL.
3. The `OPENSTYLE_` prefix stops a global `MLFLOW_TRACKING_URI` from enabling the export. The server reads the variables once, at start. No old-name alias (Okto Neuron has one: `/Users/maheidem/Documents/dev/OktoLabsAI/okto-neuron/src/okto_neuron/_compat.py:105-127`).
4. The server child inherits the app environment (`apps/electron/src/main/server-host.ts:201-206`). A Finder launch does not read shell variables. UNVERIFIED on this Mac.
5. Update `AGENTS.md:9` in the same PR: the opt-in MLflow export is an outbound call, off unless both variables are set. The one HEAD probe before a cloud resume (Decided 2026-10-17, Q15; section 3) is the other. It sends no key and no meeting data. The probe is not traced and not exported.

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

Do not install `@mlflow/core` (19.9 MB, `npm:@mlflow/core/0.4.0`); `@mlflow/vercel` inlines the span type names (`unpkg:@mlflow/vercel@0.4.0/dist/translate.js`, line 5). 6.6 F1 covers the ESM case; the build check is WP8 (9.8).

#### 9.5.3 Wiring

New file `apps/server/src/lib/llm/tracing.ts` (WP8; planned, absent at c47cd80d).

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

- `register()` is required. Without a context manager `context.active()` is empty (`unpkg:@opentelemetry/api@1.9.1/build/src/context/NoopContextManager.js:10-11`). The integration starts each root span with no explicit context (`ai:otel/src/legacy-open-telemetry.ts#L380-L381`, also `#L317`, `#L448`, `#L620`, `#L1213`, `#L1314`), so no node span becomes its parent. Child spans pass an explicit context (`#L510`, `#L696`, `#L728`, `#L1145`, `#L1257`, `#L1401`). One AI SDK call gives one trace.
- `MLflowSpanProcessor` batches itself: add no second batch processor (`unpkg:@mlflow/vercel@0.4.0/dist/processor.js:28-39`). Use the v7 key `telemetry`, not the deprecated `experimental_telemetry` (`unpkg:ai@7.0.143/dist/index.d.ts`, lines 5387-5393).

#### 9.5.4 Why the integration is per call (T2)

Dictation cleanup calls the AI SDK outside the gateway (`packages/stt/src/post-process.ts:125`). Remix did the same at c47cd80d (`apps/server/src/lib/remix-transform.ts:132`; `apps/server/src/lib/remix-agent.ts:103`); its removal (9.11) leaves dictation cleanup as the only such site. A global `registerTelemetry` integration (https://ai-sdk.dev/docs/ai-sdk-core/telemetry) would send dictated text to MLflow, which T8 forbids. A per-call integration overrides global ones and the code registers none, so a call without one emits nothing (`ai:ai/src/telemetry/create-telemetry-dispatcher.ts#L108-L133`); `{ isEnabled: false }` returns no integration (`#L123-L127`).

#### 9.5.5 Why `LegacyOpenTelemetry` (T3)

`MLflowSpanProcessor` acts only on spans with `ai.operationId` (`unpkg:@mlflow/vercel@0.4.0/dist/translate.js`, lines 15-29, 72-131). `LegacyOpenTelemetry` sets it (`ai:otel/src/assemble-operation-name.ts#L18`). The new `OpenTelemetry` integration does not (`ai:otel/src/open-telemetry.ts`, 0 hits); it emits `gen_ai.*` spans, whose rendering in MLflow 3.16.1 is UNVERIFIED. Revisit T3 when `@mlflow/vercel` supports `gen_ai.*`. Removal date of the legacy integration: UNVERIFIED.

#### 9.5.6 Endpoint and header (T4)

Probe on the owner's MLflow 3.16.1, 2026-10-17 (twice, same codes; empty POST body; nothing stored):

| Path | Documented in | Result |
|---|---|---|
| `/v1/traces` | https://mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest/ | Route exists. HTTP 422, header `x-mlflow-experiment-id` required. |
| `/api/2.0/otel/v1/traces` | `unpkg:@mlflow/vercel@0.4.0/README.md`, lines 41, 60 | HTTP 404 (same as the control `/v1/does-not-exist`). |

Decision: use `/v1/traces`, not the README path. The 3.16.1 source agrees: POST only, header required, body protobuf or JSON, no spans gives 400, a batch is all or nothing (`mlflow:server/otel_api.py#L97,#L100,#L139-L143,#L168-L171,#L117-L119`). Minimum MLflow is 3.6.0, OTLP/HTTP only (docs URL above). Test: C1.

### 9.6 Span model (T5, T6)

#### 9.6.1 Tree and rules

```text
meeting.<kind>                        run span, root, WORKFLOW. <scope>.<kind>; <kind> is enhance or summarize (llm_runs.kind)
  node.prepare                        CHAIN, code node, no LLM child
  node.correctChunk (chunk:0)         CHAIN, step_key in brackets; one sibling for each chunk
    ai.generateText                   LLM, from the AI SDK
      ai.generateText.doGenerate      LLM, from the AI SDK
  node.identifySpeakers               CHAIN
  node.verifyEvidence                 CHAIN, code node
  node.summarize                      CHAIN, one node call. Its single, map and reduce calls are its LLM children
  node.save                           CHAIN, code node
```

Node ids are `NodeId` (section 4); step keys are `llm_run_steps.step_key` (section 7). A chained Enhance run adds `node.summarize` and `node.save` after `node.verifyEvidence` (section 3). A Summarize button run has `node.prepare`, `node.summarize`, `node.save` only.

1. The run span is the root, started with `ROOT_CONTEXT`. The code keeps run contexts in an in-memory `Map<runId, Context>`. Graph state holds only the run id, because the checkpoint saver serializes state (section 7).
2. **Where spans open (WP8).** `guardNode` in `W/unit.ts` wraps every node body (4.0.2). It calls `inNode(t, runId, node, attrs, body)` around the body, inside its own `try`. A throw in the body ends the span with ERROR first, then `guardNode` turns it into a typed `internal` failure. WP8 edits no node file. The runner in `W/runner.ts` (WP5b) opens and ends the run span: `execute` calls `startRunSpan` before `graph.invoke` and `endRunSpan` after it writes the final status (3.4.6 step 3). `resumeRun` calls `startRunSpan` again (rule 5).
3. `inNode` starts its span with `startActiveSpan(name, options, context, fn)` and the stored context (`unpkg:@opentelemetry/api@1.9.1/build/src/trace/tracer.d.ts`, line 71). It does not rely on LangGraph propagation. AI SDK spans still need the registered context manager (9.5.3).
4. A retry is a new LLM call under the same node span. `callUnit` is the single retry layer (one retry per call, AI SDK `maxRetries` 0). It adds event `attempt.failed` (`attempt`, `error_kind`, `delay_ms`) per failed attempt. No hidden attempt exists below it.
5. A resumed run (D6) starts a new trace with the same `openstyle.run_id` and `openstyle.resume_count` above 0. The first trace stays IN_PROGRESS, because state comes from the root span (`mlflow:store/tracking/sqlalchemy_store.py#L5386`, v3.16.1: `trace_status=root_span_status or TraceState.IN_PROGRESS.value`). UI display: UNVERIFIED. A Summarize resume that finds a changed transcript fails with `transcript_changed` before any node runs (Decided 2026-10-17, Q13). It still starts a run span and ends it with outcome `failed` and `openstyle.error_kind` `transcript_changed`. The user then starts a new run.
6. `mlflow.spanType` is `WORKFLOW` (run) and `CHAIN` (node). MLflow allows custom strings (`mlflow:entities/span.py#L71-L91`); the processor keeps an existing value (`translate.js`, line 80).

#### 9.6.2 Attributes

Our code sets only these `openstyle.*` attributes.

| Attribute | On | Value |
|---|---|---|
| `run_id`, `scope`, `scope_id`, `meeting_id` | run | `llm_runs.id`, `scope`, `scope_id`, `meeting_id` (opaque). `meeting_id` only when `scope` is `meeting`. |
| `kind` | run | `enhance` or `summarize`: `llm_runs.kind`. Lets a query find Summarize runs without the span name. |
| `outcome` | run | final `llm_runs.status`: `succeeded`, `partial`, `failed`, `cancelled`. An `interrupted` run never ends its span. |
| `started_by` | run | `auto` or `button`: `llm_runs.started_by`, the original trigger |
| `resume_count` | run | `llm_runs.resume_count`. 0 for the first trace of a run, above 0 after a resume |
| `node`, `step_key`, `attempts` | node | `NodeId`; `llm_run_steps.step_key` (e.g. `chunk:3`), absent on `node.summarize` because it opens several rows; sum of the final `llm_run_steps.attempts` over the rows of the node call |
| `llm_call_ids` | node | string array of `llm_calls.id`, one per attempt. Join key to the local record. |
| `finish_reason`, `raw_finish_reason` | node | `llm_calls.finish_unified`, `finish_raw`, last attempt. The AI SDK span holds only the unified one (`rawFinishReason` has 0 hits in `ai:otel/src/legacy-open-telemetry.ts` and `ai:otel/src/open-telemetry.ts`). |
| `model_requested`, `model_served` | node | `llm_calls.requested_model`, `served_model`. A mismatch is an error (section 5). |
| `param_ledger` | node | `llm_calls.params_json`, last attempt. No prompt text. |
| `error_kind` | node | `llm_run_steps.error_kind` of the first failed row of the node call (sections 4, 5, 7) |

MLflow keeps only input, output and total tokens (`translate.js`, lines 187-208).

#### 9.6.3 Status rules

The AI SDK sets ERROR for three causes only (`ai:otel/src/legacy-open-telemetry.ts`): finish reason `error` on the step span (`#L776-L778`) and the root span (`#L991-L993`), confirmed by an SDK test (`ai:otel/src/finish-reason-status.test.ts#L140-L168`); a tool error (`#L765`, `#L58-L71`; the nodes send no tools, 5.2.1, so it does not occur); an error thrown out of `generateText` while call state exists (`#L1469-L1501`, from `ai:ai/src/generate-text/generate-text.ts#L1638-L1639`).

Every other finish reason sets no status. A `length` stop with valid JSON leaves its span UNSET, so the gateway sets status itself (D4). MLflow takes trace state from the root span only: ERROR gives ERROR, any other status gives OK (`mlflow:store/tracking/sqlalchemy_store.py#L5841-L5857`, function `_get_trace_status_from_root_span`, v3.16.1; the line numbers differ on MLflow master). So the run span needs ERROR when a node fails. The code never sets UNSET; on success it leaves status alone.

| Event | Node span | Run span |
|---|---|---|
| `stop` and valid schema | untouched | untouched |
| `length`, recovery works (split input or raise budget, D4) | untouched, event `attempt.failed` | untouched |
| `length`, recovery fails | ERROR | ERROR, outcome `partial` or `failed` |
| `content-filter` (no retry); unexpected `tool-calls`; `error`, `other`, schema error or transient provider error after the one retry; reasoning leak (`<think>` in content, section 5); auth or invalid request (no retry); `model_mismatch`; `model_unavailable`; `deadline_exceeded`; `save_failed`; `internal` | ERROR | ERROR |
| A Summarize resume with a changed transcript (`transcript_changed`) | no node span | ERROR, outcome `failed`, `openstyle.error_kind` `transcript_changed` |
| A unit `skipped` after a run-wide stop (3.4.5) | untouched | ERROR comes from the failure that stopped the run |
| Cancel by the user (not a failure) | untouched | untouched, outcome `cancelled` |

A partial run has at least one node call in ERROR. The status message holds only the code, no transcript text. For a schema error, which AI SDK span shows ERROR: UNVERIFIED; reading suggests none (parse runs after `onEnd`, `ai:ai/src/generate-text/generate-text.ts#L1609-L1630`; `onEnd` removes call state, `ai:otel/src/legacy-open-telemetry.ts#L1060-L1061`; `onError` returns without it, `#L1471-L1474`). Read the node span (C6).

Helper interface (same file as 9.5.3). With the export off, `tracer` is a no-op tracer that returns `NonRecordingSpan` (`unpkg:@opentelemetry/api@1.9.1/build/src/trace/NoopTracer.js`).

```ts
export function startRunSpan(t: Tracing, runId: string, attrs: Attrs & { scope: string; scopeId: string; kind: LlmRunKind }): Span;   // span name `${scope}.${kind}`, WORKFLOW, ROOT_CONTEXT; stores the context. `W/runner.ts` calls it. Differs from `startRun` of the recorder (7.7) and of the runner (3.4.2)
export function inNode<T>(t: Tracing, runId: string, node: string, attrs: Attrs, fn: (s: Span) => Promise<T>): Promise<T>;
  // `guardNode` (W/unit.ts) calls it around each node body (9.6.1 rule 2). startActiveSpan(`node.${node}`, CHAIN, stored context); on throw: markError, rethrow; always end
export function markError(s: Span, err: unknown): void;   // error_kind = err.code ?? "unknown"; recordException; ERROR, message = code
export function endRunSpan(s: Span, runId: string, outcome: "succeeded" | "partial" | "failed" | "cancelled"): void;   // `W/runner.ts` calls it. ERROR only if partial or failed
```

### 9.7 Privacy and failure isolation (T7, T8)

- Content: the AI SDK records inputs and outputs by default (`ai:ai/src/telemetry/telemetry-options.ts#L34-L48`). With the export on, each Enhance or Summarize prompt (transcript, speaker names) and answer goes to the configured host. Setting both variables accepts this (Q9.2).
- Secrets: provider keys live on the provider, not the call (`registry.ts:173-177`). The legacy integration copies call `headers` into `ai.request.headers.*` (`ai:otel/src/get-base-telemetry-attributes.ts#L30-L35`), so the gateway must never pass `headers`. The exporter sends only the experiment id header (C7).
- Isolation copies the trace log pattern (`trace.ts:148-159`). The run path never awaits a flush: at run end it calls `void tracing.forceFlush().catch(() => {})`. The batch queue holds 2048 spans, drops new ones when full, exports every 5 s in batches of 512, 30 s timeout (`unpkg:@opentelemetry/sdk-trace@2.12.0/build/esm/export/BatchSpanProcessorBase.js`, lines 27-30, 79-84). An exporter wrapper reports a failed send at most once per minute, with the HTTP status and no span data.
- Planned change: `shutdown` (`apps/electron/src/server-host/entry.ts:78-94`) calls `stopWhisperServer()` and `stopMlxServer()` (line 82), no tracing call. Add `stopTracing()` (2 s cap) to that `Promise.allSettled` list, imported from `@openstyle/server` (`entry.ts:7-16`). Do not rely on the `unhandledRejection` handler, which only logs (`entry.ts:58-60`).
- Deleting a meeting removes its local records (D10), not MLflow traces or trace log lines.

### 9.8 Bundle size and load cost

The asar target is about 9 MiB (`AGENTS.md:87`). Sizes come from the npm registry and unpkg, read 2026-10-17 (two reads, same numbers), no build or install. The five new packages plus 10 dependencies make 15 packages (not counting `ai`, `@ai-sdk/provider*`, `@opentelemetry/api`); no other dependency or peer is listed. Totals are an upper bound; the real chunk size is UNVERIFIED. Unpacked bytes = `dist.unpackedSize` of `https://registry.npmjs.org/<pkg>/<version>`. JS bytes = sum of `.js`, `.mjs`, `.cjs` sizes of one build folder (`build/esm`, else `build/src`, else `dist`; no `.d.ts`, no `.map`) in `https://unpkg.com/<pkg>@<version>/?meta`.

| Package | Version | Unpacked bytes | JS bytes |
|---|---|---|---|
| `@ai-sdk/otel` | 1.0.143 | 503,760 | 96,837 |
| `@mlflow/vercel` | 0.4.0 | 20,532 | 11,264 |
| `@opentelemetry/api-logs` | 0.223.0 | 136,913 | 9,160 |
| `@opentelemetry/context-async-hooks` | 2.12.0 | 62,640 | 14,893 |
| `@opentelemetry/core` | 2.12.0 | 583,971 | 56,429 |
| `@opentelemetry/exporter-trace-otlp-proto` | 0.223.0 | 57,561 | 3,546 |
| `@opentelemetry/otlp-exporter-base` | 0.223.0 | 647,539 | 59,162 |
| `@opentelemetry/otlp-transformer` | 0.223.0 | 1,053,804 | 101,901 |
| `@opentelemetry/resources` | 2.12.0 | 440,928 | 40,855 |
| `@opentelemetry/sdk-logs` | 0.223.0 | 679,622 | 60,368 |
| `@opentelemetry/sdk-metrics` | 2.12.0 | 1,846,700 | 165,216 |
| `@opentelemetry/sdk-trace` | 2.12.0 | 832,043 | 74,183 |
| `@opentelemetry/sdk-trace-base` | 2.12.0 | 123,728 | 9,368 |
| `@opentelemetry/sdk-trace-node` | 2.12.0 | 32,087 | 5,461 |
| `@opentelemetry/semantic-conventions` | 1.43.0 | 12,006,437 | 1,207,603 |
| Total | 15 packages | 19,028,265 | 1,916,246 |

Without `semantic-conventions` the JS total is 708,643 bytes. Without `semantic-conventions`, `sdk-logs` and `sdk-metrics` it is 483,059 bytes.

1. The export code loads through `import()` only when on (as `apps/server/src/lib/llm/registry.ts:175` does for providers; `externalizeDeps: false`, `apps/electron/electron.vite.config.ts:75`). Off means zero start cost; the bytes stay in the asar.
2. `apps/electron/scripts/check-bundled-requires.mjs` reads only files directly in `out/main` and `out/preload` (lines 24, 31-34), not `out/main/chunks`. The lazy code most likely lands in a chunk (UNVERIFIED until a build exists). BC3 of 10.14 (WP1) makes the guard scan chunks. Until then a stray `require()` there passes CI.
3. Build the same commit with and without the tracing code. Record bytes of `out/main/server-process.js`, every file in `out/main/chunks`, `app.asar`, and `du -sk apps/electron/out`. Put the numbers in the PR.
4. There is no fixed size limit (Decided 2026-10-17, Q6). The PR reports the growth. The release notes report the `app.asar` size.

### 9.9 Verification

The live proof has not run; only the 9.5.6 probes ran. How MLflow 3.16.1 renders AI SDK spans is UNVERIFIED (D8). These checks realize G10 (section 1) and WP8 (section 11).

A trace counts only after read-back from the server (`/Users/maheidem/.claude/CLAUDE.md:77-81`). Both span families must land: ours and the AI SDK `LLM` spans. The owner creates one named experiment; write its id and name in the PR and ask before deleting it. Read-back uses `locations` (`experiment_ids` is deprecated: https://mlflow.org/docs/latest/api_reference/python_api/mlflow.client.html; fields in `mlflow:entities/trace_info.py`, `mlflow:entities/span.py`):

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
| C3 Our spans | Root `meeting.enhance` for an Enhance run and `meeting.summarize` for a Summarize button run, type `WORKFLOW`, `openstyle.kind` equal to `llm_runs.kind`, `openstyle.scope` equal to `meeting`. The count of `node.*` spans equals the node calls of the run: `prepare` 1, `correctChunk` one per chunk, `identifySpeakers` 1, `verifyEvidence` 1, `summarize` 1, `save` 1, for the nodes that ran. A chained Enhance run has a `node.summarize` span. |
| C4 AI SDK spans | Each LLM call gives at least one `ai.generateText` span, type `LLM`. A successful call gives two: root `ai.generateText` and step `ai.generateText.doGenerate`. Root name: SDK operation id (`operationId: 'ai.generateText'` at `ai:ai/src/generate-text/generate-text.ts#L688`; the root span starts with `event.operationId` at `ai:otel/src/legacy-open-telemetry.ts#L380`); step name is a literal (`ai:otel/src/legacy-open-telemetry.ts#L645-L648`: `ai.generateText.doGenerate` or `ai.streamText.doStream`). The SDK test asserts only the count: 2 for `LegacyOpenTelemetry`, 3 for `OpenTelemetry` (`ai:otel/src/finish-reason-status.test.ts#L157-L158`). |
| C5 Join | Every id in `openstyle.llm_call_ids` exists in `llm_calls` for that run. LLM calls in the trace equal `llm_calls` rows. |
| C6 Typed errors | One live run per typed error that the owner's local oMLX can produce (section 10 lists them), including `length` with valid JSON, and one `transcript_changed` resume. A typed error that needs a cloud provider has a scripted-model test only; its live result is UNVERIFIED (Decided 2026-10-17, Q5). The failing node span shows ERROR and `openstyle.error_kind`. The root state is ERROR. |
| C7 No secret | A canary API key on the local oMLX provider entry appears in no span attribute. No cloud provider receives a live proof. |
| C8 Off by default | Variables unset: 0 new traces, log says `MLflow tracing: off`, `lsof -nP -i @192.168.31.154:5000` prints nothing during the run (weak check; a short connection can be missed). |
| C9 Dictation out | One dictation cleanup with the export on gives 0 new traces. |
| C10 Isolation | Export on, MLflow host unreachable: same run result and about the same run time as with the export off. |

Command for the "no code" fact in 9.2:

```text
$ cd /Users/maheidem/Documents/dev/openstyle-spec-185
$ grep -rIil -E "mlflow|opentelemetry" apps packages scripts package.json pnpm-workspace.yaml | grep -v node_modules
(no output)
```

Tests for section 10 (`apps/server/tests/tracing.test.ts`, planned new file, absent at c47cd80d):

1. `startTracing`: no variables, one variable and a bad scheme give `on: false`; one variable warns once; unset variables load no export module and open no socket.
2. Spans: `BasicTracerProvider`, `SimpleSpanProcessor`, `InMemorySpanExporter` (`ai:otel/src/finish-reason-status.test.ts#L26-L36`) and an AsyncLocalStorage context manager. A fake model returns `length` with valid JSON. Expect one trace id, node span as parent of the AI SDK span, ERROR on node and run span.
3. Translation: an AI SDK span through `MLflowSpanProcessor` gives `mlflow.spanType = LLM`. It fails when a version bump breaks the `ai.operationId` link.
4. Privacy: with the export off the fake model gets `telemetry.isEnabled = false`; a dictation call gets no `integrations`.
5. Server tests use fake timers (`apps/server/tests/setup.ts:16`); a flush test may need `vi.useRealTimers()` (UNVERIFIED).
6. Run kinds: Enhance gives root `meeting.enhance`, Summarize gives `meeting.summarize`, both with `openstyle.kind` equal to `llm_runs.kind`. A resumed run gives a second trace with `openstyle.resume_count` above 0 and the original `openstyle.started_by`. `guardNode` opens one node span per node call; a throwing body ends its span with ERROR before the typed `internal` failure returns.
7. Live: C1 to C10 against the owner's MLflow, the owner's oMLX with Qwen3.8-27B only, and quiet E2E (`scripts/test-runner/run.sh`). Mocks alone do not count. No cloud provider gets a live proof (Q5).
8. Chain and resume: a chained Enhance run gives one trace with `node.summarize`. A Summarize resume on a changed transcript gives a run span with ERROR and `openstyle.error_kind` `transcript_changed`.

### 9.10 Hand-offs to other sections

- Sections 3 and 4: `W/runner.ts` calls `startRunSpan` and `endRunSpan` (run id, `kind`, `started_by`, `resume_count`, final status). `guardNode` (`W/unit.ts`) runs each node body inside `inNode`; no node file changes. `RunStatus` (section 4) and `llm_runs.status` (section 7) both use `succeeded` (R16, 11.4).
- Section 5: set `telemetry` and `maxRetries: 0` on every call; `callUnit` emits `attempt.failed` and the 9.6.2 attributes; return typed error kinds, raw finish reason, served model, param ledger; never pass `headers`.
- Section 6: pins in 9.5.2 match the v7 `ai` version; `@opentelemetry/api` becomes a direct dependency of `apps/server`.
- Section 7: `llm_runs` carries `scope` and `scope_id`. Answer to O7-4: remove column `llm_calls.trace_id`; the join runs from MLflow to the local record through `openstyle.run_id` and `openstyle.llm_call_ids`.
- Section 10: the 9.9 tests, C1 to C10, a guard that scans `out/main/chunks`, the list of typed-error live runs. Section 8 needs nothing.
- Section 11: the Remix removal is its own work package and touches no tracing file. WP8 creates `apps/server/src/lib/llm/tracing.ts` and `apps/server/tests/tracing.test.ts`; edits `apps/server/src/index.ts`, `apps/server/package.json`, `apps/electron/src/server-host/entry.ts`, `AGENTS.md:9`, `W/unit.ts`, `W/runner.ts`. No node file, no settings file (T1).
- Section 12 (R16, R20): real chunk size UNVERIFIED (9.8); MLflow request size limit for a very long meeting UNVERIFIED; a resumed run leaves an unfinished trace (9.6.1 rule 5); the legacy integration may leave the AI SDK (9.5.5); a Finder launch may not pass the variables (9.5.1 rule 4).

### 9.11 Decisions (2026-10-17)

No question stays open. The owner answered in round 2, or the decision follows the owner's viewpoint.

| ID | Question | Decision |
|---|---|---|
| Q9.1 | Setting key and UI instead of environment variables? | No. Variables only (T1). A setting key touches five files; a dead key shipped once (`CHANGELOG.md:301`). |
| Q9.2 | Switch for metadata-only export? | No. Traces hold content. The server is the owner's own. |
| Q9.3 | Experiment id or name? | The id. A name needs two more REST calls and the server never creates an experiment. |
| Q9.4 | Is 1 MiB of asar growth an acceptable limit? | (Owner, Q6) No fixed limit. Report the growth in the PR (9.8). |
| Q9.5 | Dictation cleanup or Remix in MLflow later? | No. T8 stays. Remix is removed in this work; the owner redoes it later on the generic LLM platform. Dictation text is private. |
| Q9.6 | Summarize runs in MLflow? | Yes. Both kinds are exported when both variables are set. A Summarize prompt holds the transcript as an Enhance prompt does. |
| O7-4 | Keep `llm_calls.trace_id`? | Remove it. The join runs through `openstyle.run_id` and `openstyle.llm_call_ids`. |
| Generic | Where does the tracing code live? | (Owner, Q16) `apps/server/src/lib/llm/tracing.ts`, domain-agnostic (T9). |
| No flag | Does the export depend on a feature flag? | (Owner, Q1) No. The two environment variables are the only gate. |

---

## 10. Test plan and definition of done

This section owns the tests and the definition of done (DoD). It proves goals G1 to G15 (1.2) and closes each work package (WP, section 11). Sections 3 to 9 own the code under test and the floor check lists. Unit tests alone never close a WP (1.3). The new path replaces the old Enhance and Summary path directly: no feature flag, no dual contract (decided 2026-10-17, 10.19). A WP that switches a route proves the new behavior only.

Cite prefixes: `S`=`apps/server/src`, `T`=`apps/server/tests`, `W`=`S/lib/meetings/workflow`, `GW`=`S/lib/llm/workflow`, `LL`=`S/lib/llm` (generic platform layer), `M`=`S/lib/meetings`, `E`=`apps/electron`, `LT`/`MB`/`CS`=`.claude/skills/{live-testing,meeting-benchmarks,council}/SKILL.md`, `CI`=`.github/workflows/build.yml`, `MV2`=`specs/meeting-transcription-v2.md`, `MC`=`E/tests/meeting-cancel-transcribe.test.ts`, `CM`=`~/.claude/CLAUDE.md`, `OM`=`~/Documents/dev/omlx-management/docs/troubleshooting.md`, `ON`=`~/Documents/dev/OktoLabsAI/okto-neuron/src/okto_neuron/`, `ai:`=https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/ai/src/ , `pv:`=https://unpkg.com/@ai-sdk/provider@4.0.29/dist/index.d.ts , `lgv:`=https://unpkg.com/@langchain/langgraph-checkpoint-validation@1.2.0/ , `lgd:`=https://docs.langchain.com/oss/javascript/langgraph/checkpointers.md . Other bare paths are in the repo at `c47cd80d`. The WP card of section 11 wins over a name marked "proposal".

### 10.1 Levels of proof

A WP passes every level that applies (10.17).

```mermaid
flowchart LR
  L1["1 Unit, scripted model"] --> L2["2 Wire: real provider code, stubbed fetch"] --> L3["3 Graph, saver, migration on a SQLite file"] --> L4["4 E2E in the real app, fake own server"] --> L5["5 Live run on the owner's oMLX, fictional transcript"] --> L6["6 Benchmarks on real meetings"] --> L7["7 Council: Claude, pi, Codex"]
```

Levels 1 to 3 run in CI job `test-server` (`CI:144,147,150`). Renderer tests and level 4 run in `test-electron` (`CI:152-155,174-175,203-205`). Both run on a pull request only when Electron, server, packages, scripts or build config paths change (`CI:62-63,130,155`). Levels 5 to 7 run on the owner's Mac only.

### 10.2 Rules for every test

1. **Fictional data.** One builder serves all levels: `apps/server/tests/helpers/meeting-fixture.ts` (WP3 owns it, 11.4; WP5a, WP6, WP7, WP9 reuse it). Input: chunk count, speakers, optional self-introduction line. Output: meeting row, segment rows with ids, segment ids per chunk, calendar link with attendees. A second function writes them with `node:sqlite` (pattern `scripts/site-captures/seed-data.mjs:167-221`). It imports no vitest and no server module except types. The electron test tsconfig has no `include` entry for `apps/server/tests` (`apps/electron/tsconfig.tests.json:3-13`), so WP9 adds this file (11.4). Real meetings appear only in 10.15, as numbers (`MB:12-19`).
2. **The fake sits below the code under test.** The timeout test (`T/meeting-llm-timeouts.test.ts:372-406`: the `describe.each` and its `it` blocks; lines 60-94 hold the `postProcess` spy fake it uses) moves to the gateway and must reach `AbortSignal.timeout` (`M/llm-call.ts:153`). Today `vi.mock` of `postProcess` (`:94`) and route tests that replace Enhance (`S/routes/meetings.ts:172-182`) hide the call record (5.1, 7.7). Only node tests fake the gateway, through `WorkflowDeps.callStructured` (3.4.2). `callUnit` is the single retry layer: one retry per call (`gatewayRetryOn`). The AI SDK runs with `maxRetries` 0 and no node has a `RetryPolicy`; a request-count test proves all three (10.5.1, GR7). Other tests use the real gateway over a scripted `MockLanguageModelV4`, which enters through the `createModel` seam (`CallStructuredInput.createModel`, `WorkflowDeps.createModel`; 5.1), or over a fake HTTP server. Wire tests (10.5.2) leave the seam unset.
3. **Red proof.** A typed-error test fails once with its check removed. The PR names the removed check. Reason: a simulated error does not prove the handler sits on the real error path (`~/.claude/projects/-Users-maheidem-Documents-dev-OktoLabsAI/memory/MEMORY.md:36`). The rule is new in this spec.
4. **Time.** `T/setup.ts:16` fakes timers in all server tests. A run on 2026-10-17 (vitest 4.1.7) showed `setTimeout` sleeps never resolve. `callUnit` takes an injectable `sleep` (`WorkflowDeps.sleep`; WP5a, 3.4.2, 5.6); other retry tests call `vi.advanceTimersByTimeAsync`. The gateway has no retry wait. A test that needs real timers opts out per file (`T/trace.test.ts:31-41`). Do not edit `T/setup.ts`.
5. **Read back every write** with a separate query (`CM:47`).
6. **Isolation.** No port 4649, real profile or `~/.cache/huggingface`. Only Qwen3-ASR and Qwen3.8-27B on the owner's oMLX (`LT:12-20,65`).
7. **Keep behavior tests.** No test runs both paths. A test of the old 200 or 502 Enhance body changes to the 202 contract in the PR that switches the route (WP5b). Tests of unchanged behavior (for example `fakeLlm` groups, `T/meeting-enhance.test.ts:65-88,108-128`) move to their new node. The PR lists each deleted `it(` with successor or reason. Five `describe(` blocks of `T/meeting-enhance.test.ts` start at lines 162, 334, 403, 861, 1015; their first `it(` is at 163, 346, 410, 862, 1040.
8. **Node.** CI runs Node 22 (`.node-version:1`). Electron 39.8.10 ships 22.22.1 (https://artifacts.electronjs.org/headers/dist/index.json). The dev Mac ran 26.5.0. `node:sqlite` is stability 1.1 on Node 22 (https://nodejs.org/docs/latest-v22.x/api/sqlite.html). A green Node 26 run does not close the saver or migration: CI and E2E (Node 22) must pass.
9. **One workflow harness.** `apps/server/tests/helpers/workflow-harness.ts` is new; WP5a owns it (11.4); it imports `helpers/fake-model.ts` and `helpers/meeting-fixture.ts` (WP3). WP5b and WP6 import it, never edit it; they ask the coordinator to widen the WP5a row in 11.4 first. Exports (working shape):

```ts
// apps/server/tests/helpers/workflow-harness.ts (WP5a)
export const instantSleep: WorkflowDeps["sleep"]; // resolves at once; rejects with CancelledError when the signal is aborted
export interface TestRunContext extends RunContext {
  cancel(): void; stop(kind: FailureKind): void;       // set the flags that isCancelled() and isStopped() read
  readonly startedNodes: NodeId[];                    // onNodeStart calls, in order
  readonly progress: { total: number; done: number; failed: number };
  readonly lostRecords: number; readonly inputHash: string | null; // what recordLost and setInputHash received
}
export function makeTestRunContext(o?: { runId?: string; meetingId?: string; signal?: AbortSignal }): TestRunContext;
export function makeFakeRecorder(): LlmRecorder & { steps: Map<string, { status: LlmStepStatus; attempts: number; seq: number }>; calls: CallRecord[]; links: NewLink[] };
  // in memory; follows 7.7 for seq and attempt. A test that needs real rows passes the WP2 recorder on a temp file
export function makeTestDeps(o?: Partial<WorkflowDeps>): { deps: WorkflowDeps; contexts: RunContextRegistry<RunContext> };
  // defaults: temp-file DatabaseSync, makeFakeRecorder(), instantSleep, counter clock, own registry, real gateway
export function runScriptedGraph(o: { deps: WorkflowDeps; meetingId: string; stages: Stage[]; script: ScriptedAnswer[]; ctx?: TestRunContext }): Promise<{ finalState: WorkflowStateType; requests: RecordedRequest[]; ctx: TestRunContext }>;
  // opens the run row, registers the context, calls buildGraph(deps).invoke with the 3.4.2 config (thread_id, durability "sync", maxConcurrency WORKFLOW_FANOUT_CAP), drops the context in a finally
```

`runScriptedGraph` has no runner, job registry or route, so WP5a and WP6 use it before WP5b exists. WP5b tests use the real runner and only `makeTestDeps` and `instantSleep`. The uncommitted live scripts of WP5a and WP6 call `productionDeps()` then `runContexts.register(makeTestRunContext({ runId, meetingId }))` (3.4.2) and run through `node --import ./scripts/meeting-v2/ts-register.mjs` (`MB:65`). That this loader reads the server source tree is UNVERIFIED until WP5a runs it.

### 10.3 What exists today

Section 2 owns the current state. Test facts sit where used.

### 10.4 Goal-to-proof map

Each goal closes only with real-system evidence.

- G1: `git grep -n extractJsonObject -- apps/server/src/lib/meetings/workflow` is empty (10.5.4); live node requests carry `response_format.type` `json_schema` (10.12 step 5).
- G2: matrix 10.5.1; fake own server (10.11); capped live call gives typed `length` (LP1).
- G3: replay GR5; 6 of 6 runs on the 8-chunk meeting finish (10.15).
- G4: route tests (10.9); typed failure survives reload and restart (10.11).
- G5: `maxRetries` 0, counts of 10.5.1 and GR7; same counts at the fake server.
- G6: saver suite (10.7), GR10 to GR12; `SIGKILL` five runs in a row plus a live kill (10.11.3, WP9 acceptance 3).
- G7: recorder and route tests (10.9); read-back (10.12); panel equals wire (10.11.2); delete leaves 0 rows. Every run writes records.
- G8: ledger equals stubbed body (10.5.2); equals trace log (10.12 step 4).
- G9: wire-body test 6.9.2; one `ai` version in the lock file; one real dictation run and one real meeting run (WP1). No Remix run exists.
- G10: tests of 9.9; C1 to C10 on the owner's MLflow (10.13).
- G11: guard scans `out/main/chunks`; build, asar size, packaged start (10.14). Each PR reports `du -sk apps/electron/out` and the asar size, with no fixed limit.
- G12: no unit proof (`MB:117-119`); benchmarks and council (10.15).
- G13: RM1 to RM10 (10.14.1).
- G14: `git grep -n -E "lib/meetings|meetings/workflow" -- apps/server/src/lib/llm` prints nothing after the WP that owns `LL` rewords two comments (Check P, 11.4). At `c47cd80d` the grep prints two lines, both comments in `S/lib/llm/lane.ts` (`:32`, `:76`) that name `lib/meetings/job-registry.ts`; Check P in the spec does not mention them. GR2 layer test; scope test of 10.9 check 7.
- G15: `summary_json` write and schema check: 10.9 checks 1 and 8, SW3 of 4.6.1, 4.5.6 checks, 10.15.

### 10.5 Gateway tests (sections 5 and 6)

This matrix is the source of the WP3 test cases (11.5).

#### 10.5.1 Scripted model matrix

Use `MockLanguageModelV4` from `ai/test` (`doGenerate` takes a function, one result or a list; `doGenerateCalls` records calls: https://unpkg.com/ai@7.0.143/dist/test/index.d.ts:135,142). A result needs `finishReason: { unified, raw }` and V4 usage (`pv:654-666,694-740,746-791`). WP3 builds `T/helpers/fake-model.ts`. No file imports `ai/test` today; the hand-made `v3` model in `packages/stt/src/post-process.test.ts:4-11` stays until WP1. `ai` 6.0.191 has only V3 mocks (https://unpkg.com/ai@6.0.191/dist/test/index.d.ts:53), so gateway tests wait for WP1.

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

The SDK retry loop wraps `doGenerate` (`ai:generate-text/generate-text.ts#L1056-L1061`). A model that always throws a retryable error must see one call per gateway call: that proves `maxRetries` 0. "One gateway call" is a WP3 test of `callStructured` over the scripted model. "Req" counts requests through `callUnit` and the gateway (G5); it is a WP5a test in `workflow-requests.test.ts`, because WP3 cannot run `callUnit`. Rows with a length route (A4, A5, HE11) count requests in GR6 and LR1 to LR8. Names: 5.2. Routes and advice: 5.2.1.

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
| A13 | `stop` + `end_turn` (Anthropic key), then `pause_turn` | `end_turn` passes; `pause_turn` fails `unknown_raw` (gate rule 5.3.2; the page names no failure: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons); `end_turn` under the `openai_chat` key fails | 1, then 2 |
| A14, A15 | `stop` + `<think>`; `stop` + empty text + reasoning | `ReasoningLeakError` (`think_tag`; `empty_content_with_reasoning`) | 1 reasoning off; 2 on |
| A16, A17 | Served model differs; absent | `ModelMismatchError`; object with `served_model` NULL + warning | 1 |
| A18 | Usage reasoning 600, cached 40; then none | Stored; missing is NULL, not 0 (7.4). Today unknown usage gives 0 (`M/llm-call.ts:45`); summary sums still add 0 (4.5 rule 1); `meeting_summaries` token columns accept NULL (`S/lib/schema.ts:795-796`) | 1 |

Thrown errors use `APICallError` with `statusCode`, `responseHeaders`, `isRetryable` (`pv:2132`). Level 2 repeats each row with a real HTTP reply (10.5.2).

| # | Error | One gateway call | Req |
|---|---|---|---|
| HE1, HE2 | 429 `Retry-After: 3`; `retry-after-ms: 1500` + `retry-after: 9` | `provider_rate_limited`. Wait 3000 ms; 1500 ms | 2 |
| HE3 | 429, HTTP date (RFC 9110 section 10.2.3, https://www.rfc-editor.org/rfc/rfc9110.txt: the value is an HTTP-date or delay-seconds) | Wait = distance, max 60 s | 2 |
| HE4, HE5 | 429 `Retry-After: 90`; no header | No retry advice (5-P3); 1 s + jitter | 1; 2 |
| HE6 | 500, 502, 503, 504, 409, network error | `provider_unavailable`. Advice | 2 |
| HE7 | 408 or call timeout | `provider_timeout`. Retry on cloud only (5-P2) | 2 or 1 |
| HE8 | 401, 403 | `provider_auth`. No retry | 1 |
| HE9, HE10 | 400 naming `response_format`, `json_schema` or `schema`; other 400, 404, 422 | `provider_invalid_request`. Advice: lower structured mode; none | 2; 1 |
| HE11 | 413; 400 with `prefill_memory_exceeded`, `context_length_exceeded` or `maximum context length` | `LengthError` `input`: `split` only, no `raise`, no `lowerReasoning`. Phrases other than the oMLX one: UNVERIFIED | As LR8 |
| HE12 | Persistent 503 | No advice on the 2nd failure | Exactly 2 per call, never 6 (SDK default: `ai:util/retry-with-exponential-backoff.ts#L66-L68`). A split chunk whose second half has a persistent 503: 4 |
| HE13 | Abort queued; in flight; `stopped()` true when the lease opens (5.1 step 4) | `CancelledError`, phase `queued`; `in_flight`; `queued` | 0; 1; 0 |
| HE14 | `RetryError` | Gateway reads `lastError`. Not expected at `maxRetries` 0: UNVERIFIED | 1 |
| HE15 | No model set up; unsupported provider; no key; server removed | `ModelUnavailableError`, no request | 0 |
| HE16 | Caller signal aborts with `TimeoutError`; with another reason | `DeadlineExceededError`; `CancelledError` | 1 or 0 |

A `Record<Unified, Route>` constant fails the type check when the SDK adds a seventh unified value (`pv:666`).

#### 10.5.2 Wire tests through the real provider code

Wire tests build the model with `createChatModel("server", ...)` and stub `globalThis.fetch`, so the real `@ai-sdk/openai` and fetch wrapper run (pattern `T/llm-task-profiles.test.ts:493-526`).

| # | Case | Pass when |
|---|---|---|
| W1 | Normal `server` call body | Holds `response_format.type` `json_schema`, node schema name, `chat_template_kwargs.enable_thinking` `false`, `temperature`, `max_tokens`. Ledger equals the body key by key (G8). `dropped` keys are absent. |
| W2 | Preset sets `response_format`, `stop`, `guided_json` | Ledger: dropped, reason `denylist`. Body keeps the SDK schema. Today the denylist lacks them and preset keys spread last (`packages/validations/src/llm-task-profiles.ts:199-206`, `S/lib/llm/registry.ts:125`). |
| W2b | Dictation cleanup preset with `stop` | `resolveTaskCall` keeps `stop` for dictation cleanup, drops it for the two meeting tasks (5.5.3). |
| W3 | Wire finish `stop`, `length`, `content_filter`, `tool_calls`, `function_call`, unknown | SDK gives `stop`, `length`, `content-filter`, `tool-calls`, `tool-calls`, `other` (https://unpkg.com/@ai-sdk/openai@4.0.96/dist/index.js:690-699). The wire never gives `error`. |
| W4 | 429 `Retry-After: 3`, `maxRetries` 0 | `APICallError`: `statusCode` 429, `isRetryable` true, `responseHeaders["retry-after"]` `"3"`, one call (offline run 2026-10-17, `ai` 6.0.191, `@ai-sdk/openai` 3.0.65). Repeat on v7. |
| W5 | Each status of HE1 to HE10 | Kind, advice and count match. |
| W6 | 400 naming `response_format` | Mode cache drops to `prompt_only` for that server and model. Next call succeeds. New process relearns (5.9 check 6). |
| W7 | Reply `model`: equal, differs, missing, date suffix (`gpt-4o-mini-2024-07-18`) | Equal and suffix pass; different fails; missing passes with a warning. Suffix rule 5-P4: record served ids first (5.3.4). |
| W8 | `reasoning_content` with empty `content`; `<think>` in `content`; `reasoning_tokens` in usage | `empty_content_with_reasoning`; `think_tag`; tokens recorded, NULL if oMLX omits them (UNVERIFIED). |
| W9 | SDK warns it ignored a setting | Ledger: dropped, reason `sdk_unsupported`. |
| W10 | Held socket, small `timeoutMs` | `provider_timeout`; user signal first gives `CancelledError` (5.7). Real timers. `AbortSignal.timeout` under fake timers: UNVERIFIED. |
| W11 | Body is not a string | Wrapper returns it untouched (`S/lib/llm/registry.ts:161-163`; 6.8 row 6). New canary: existing tests send a string (`T/llm-task-profiles.test.ts:474-486`). |
| W12 | Each provider and mode of the 5.4 table, table-driven (as 6.9.2 WB1 to WB8) | Body holds that row's structured-output field: `response_format` `json_schema` with `strict`, `output_config.format`, forced `json` tool, `providerOptions.*` or `provider.require_parameters`. |
| W13 | Each input-overflow phrase of 5.2.1 as HTTP 400, and HTTP 413 | `LengthError` `input`. |
| W15 | `probeEndpoint` (5.7) over stubbed `fetch` | `server`: `GET <base>/models` on the server entry base; HTTP 200, 401, 404, 503 give true; rejected fetch and 3 s timeout give false (real timers or injected `timeoutMs`). Cloud (`openai`, `anthropic`, `google`, `mistral`, `groq`, `openrouter`, `vercel`): `HEAD` on the base URL of the 5.7 table; same statuses true; rejected fetch false. No request holds an `Authorization` header or key. Missing server entry, missing key, provider not in the table: true. |

#### 10.5.3 Profile and ledger tests

A table-driven test checks the 5.5 reasoning profile per provider and model: wire shape with reasoning off, then the bounded shape where one exists. Local `server` Qwen: `chat_template_kwargs.enable_thinking` `false` (`T/llm-task-profiles.test.ts:146-155`). Groq `qwen/qwen3-32b`: `hidden`, `none`; `openai/gpt-oss-20b`, `-120b`: `hidden`, `low`; byte for byte as today (`S/lib/llm/registry.ts:72-97`). Unknown model: default profile. No control: ledger reason `no_reasoning_control`. The setting goes out on every call (L2). A preset that turns thinking on wins, with ledger warning "reasoning on by preset" (4.7, N5).

**W14 Registry read is best effort (5.1).** Make `fetchModelsFromRegistry` reject (network fault; bad status in a second case). (a) `resolveModels` for a `server` model resolves with `contextWindow` and `maxOutputTokens` `null` and no `registry_unavailable` warning; a `server` Enhance over stubbed fetch runs end to end; the stub sees no models.dev request. (b) For a cloud model it resolves with the first mode of the 5.4 row, the hand row of 5.5, both limits `null` and warning `registry_unavailable`; every call record of that run holds the warning in `params_json`. (c) Neither case throws `ModelUnavailableError`. (d) The registry is read once for the three profiles. Red proof for (c): if `resolveModels` lets the rejection escape, `prepare` fails the run with `model_unavailable`.

#### 10.5.4 Schema tests

WP3 builds `assertPortableSchema` (5.4 owns the provider schema rules) and runs it on every node schema of `W/schemas.ts` (new, WP3, 11.4; folder `W` absent at `c47cd80d`). The input is the SDK output `await asSchema(zod).jsonSchema` from `ai` (4.0.3 rule 7); the gateway adds no normalize step. A check on 2026-10-17 (`ai` 6.0.191, zod 4.4.3) gave 0 violations for the schemas of 4.2.1, 4.3.1, 4.5.1, and `z.object({ a: z.string().optional() })` printed `$.a: not required`. Flag any `$ref`. Repeat on v7 in WP3. At the v7 commit `@ai-sdk/provider-utils` exports `asSchema(schema)` with one argument (https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/provider-utils/src/schema.ts, line 142). The zod 4 options (`useReferences`) belong to `zodSchema` and `zod4Schema` in the same file, not to `asSchema`. That `ai` v7 re-exports `asSchema` is UNVERIFIED (`ai@6.0.191` does: `dist/index.d.ts:8`, https://unpkg.com/ai@6.0.191/dist/index.d.ts).

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

Section 6.9 owns this proof: the wire-body snapshot is made on v6 first and shows no diff after the bump; `vitest -u` never runs in the bump commit (6.9.1). The lock file holds one `ai` version, two today (`pnpm-lock.yaml:2884,2890`; WP1 acceptance 2, 3). Remix is removed before the bump (WP-R), so `@ai-sdk/react` goes only if no other file imports it (WP1 card, `git grep`). Dictation cleanup passes one real run (WP1 acceptance 5): `POST /api/post-process` (`S/routes/index.ts:52-53`). Cloud transcription has no live proof (no keys, 6.11 U6-6; decided 10.19); its evidence is wire tests WB12 to WB14 of 6.9.2. `T/openai-cloud-provider.test.ts` is no evidence: it stubs `createOpenAI` and `experimental_transcribe` (`:5-21`) and checks the config passed to `createOpenAI` (`:56,66`) and the stubbed text `result.text` (`:55`).

### 10.6 Node tests (section 4)

Level 1, real node code, scripted gateway. This is the check list of section 4.

| Node | Required tests |
|---|---|
| `prepare` | No diarization: `labels.all` empty. All labels named: `toIdentify` empty. A chunk never splits a segment; chunk ids never overlap. Empty transcript: `empty_input`, no call. Chunk size shrinks when the fit check fails (4.0.5). `prepared.summary` holds the two settings: a later change of `meeting_summary_context_budget` does not change the state. `inputHash` (WP2 test of `M/input-hash.ts`; planned, absent at `c47cd80d`, 4.1 P11): `prepare` and the reader of 7.8 give the same string for the same database; a blank-text row and a failed-status row do not change it; a merged speaker (`merged_into`), re-diarize and re-transcribe change it; a confirmed name changes it for variants `chain` and `summarize` but not `enhance`; `enhanced_text` changes it for `summarize` only; `hashVariantOf` gives `enhance`, `summarize` or `chain` from the stage list. |
| `correctChunk` | `length` on a 1200-token chunk splits it and succeeds with halves. One test per drop reason: `unknown_id`, `duplicate_id` (first wins), `empty_text`, `unchanged`. Echoed `Speaker:` prefix removed. Prompt asks for corrections only; no speaker field (D1). A drop keeps its call id and `seq` (4.2). Answer segment ids `[A, B, A]` give `seq` 0 and 1 to the two applied entries and `seq` 2 to the `duplicate_id` drop. |
| `identifySpeakers` | Line-1 self-introduction in a 3-hour fixture stays in the candidate set (anchor rule). A `segmentId` the call did not show is dropped. `length` with reasoning on reruns with it off. No attendee name in the prompt. After a split each half checks `segmentId` against its own `shown` lines. One failed half: node `partial`, step `candidates` stored `partial`, good proposals stay. Each proposal has the `seq` of its place in the `speakers` array. |
| `verifyEvidence` | One test per drop reason of 4.4.2 (10). The four normalization cases of 4.4.1 (`Hi, this is José`, curly apostrophe, `banana` against `ana`, unchanged `Hi, this is Ana`). `Thank you, Ana.` is no introduction. An early role loses to a later self-introduced name. `Anna` and `Ana` with attendee `Ana Lima`: one winner, `respelledFrom`. Each verdict has status and reason (D10). |
| `summarize` | Five-field schema (overview, key points, decisions, action items, open questions; 4.5.1); code renders the Markdown. Empty summary: five headings, `None.` under four. Rendered Markdown equals the render function applied to the stored `summary_json`. `\n## Fake` in a string makes no heading. Six map chunks that do not fit one reduce are grouped, at most 24 calls. Keys (4.0.7): short `single`; long `map:0` to `map:N-1` then `reduce:1:0`, or with two levels `reduce:1:0`, `reduce:1:1`, `reduce:2:0`. **Two reduce levels use two different keys.** After a kill between the level-1 and level-2 call, a resume sends 0 requests for finished level-1 calls and the level-2 call gets the level-1 results as input. One call under budget, map then reduce above it. A `single` call ending `length` replans into `map` and `reduce` keys; step row `single` ends `succeeded` when the summary is made. The node reads `prepared.summary.instructions` and `contextBudget`, not the settings (4.1). Job deadline holds: a small ceiling gives `deadline_exceeded`, not `cancelled`. A failure writes no summary. A summarize-only run uses stored `enhanced_text` and the "Unidentified" label of `prepare` (4.5); the Summarize node of a chained run (GR24) reads the same input. |
| `save` | Same state twice, same database. Chunk `ok` with no correction resets `enhanced_text` to NULL; a failed chunk keeps its old one. A delete between SW1 and SW2 (4.6.1) ends the run without error. SW2 never changes `confirmed_at` or `display_name`. A write that throws `SQLITE_BUSY` once succeeds on retry; twice gives `save_failed` and the others stay. A rolled-back SW1 leaves no link. `save` twice leaves one link row per (call, target, seq). **Link keys (4.6.1):** a correction answer with the same segment id twice (one applied, one `duplicate_id` drop) leaves two link rows with different `seq`; the 7.8 segment query returns the `applied` row, also after a second `save`. Two proposals for one label in one call (one kept, one `conflict_lost`) leave two link rows with different `seq`; the 7.8 speaker query returns the kept call. A summary link has `target_id` equal to the meeting id and `seq` 0, one row per summary call. **`summary_json` (migration 40):** SW3 (4.6.1) writes the summary object into `meeting_summaries.summary_json` in the same transaction as the Markdown. The test (WP5a, `workflow-save.test.ts`) feeds `save` a hand-built `SummarizeResult` with status `ok` (the real `summarize` arrives in WP6) and compares the stored Markdown with `renderSummaryMarkdown(JSON.parse(summary_json))` from `W/summary-pure.ts` (WP5a writes it in full; 4.5.6, GR26). A separate query reads it back, `JSON.parse` succeeds, the object passes the 4.5.1 schema and holds the same decisions and action items as the Markdown. A failed Summarize run leaves the old `summary_json` and Markdown. `save` twice leaves the same value. |

Also: no attendee in any request (10.5.4); per provider row the node output limit equals the 4.0.5 formula. The benchmark tunes the values 4.0.5 marks "new" (`IDENTIFY_ANCHOR_LINES` 8, factor 2 of `CORRECT_ANSWER_FACTOR`), never unit tests (D12). The `meeting_summaries` row keeps summed tokens of all calls, the profile provider and the served model of the last call; cost is tokens times price, or NULL (4.5 rules 1 to 4). Today `summarizeMeeting` keeps the requested model (`M/summarize.ts:435-439,512-515`; `M/llm-call.ts:177`; `packages/stt/src/post-process.ts:87-94,164`), although the comment at `M/llm-call.ts:50` says "served". The new node keeps the served model (4.5 rule 3). WP6 writes these cost cases in `workflow-summarize.test.ts` (new; WP6 card, 11.5): (a) priced model: a stub answers the models.dev request with a price, `fetchModelsFromRegistry()` warms the cache, a scripted `openai` model reports 1000 input and 200 output tokens; `meeting_summaries.cost_usd` is not NULL and equals `1000 × price.input + 200 × price.output`, read back separately. (b) `server` model: `cost_usd` NULL. (c) models.dev stub rejects: `cost_usd` NULL, the node does not fail. (d) Resume in a new process with a cold cache and a working stub: `cost_usd` not NULL. (e) `llm_model` is the served model of the last call when named, else the requested model; `llm_provider` is `profile.provider`.

### 10.7 Saver tests (WP4)

The saver is `NodeSqliteSaver` (3.1, 7.9) in the generic layer (`LL`); its tests import no meeting module. The conformance suite is `@langchain/langgraph-checkpoint-validation` 1.2.0 (D6):

- `validate(initializer)` (`lgv:dist/index.js`) calls `specTest`, which runs five suites: `put`, `putWrites`, `getTuple`, `list`, `deleteThread` (`lgv:dist/spec/index.js`, object `testTypeMap`). The check read the published 1.2.0 files, not a local install. It uses `describe`, `it`, `expect`, `beforeAll`, `afterAll` as globals; the server config has `globals: true` (`apps/server/vitest.config.ts:20`). It depends on `vitest ^4.1.11`; the repo locks 4.1.7 (`pnpm-lock.yaml:4987`). Install it as a dev dependency of `apps/server` only. If the peer range blocks the install or the suite fails on 4.1.7, WP4 applies the vitest fallback of its card (11.5).
- `getDeltaChannelHistory` tests are opt-in (`lgv:dist/spec/delta_channel_history.js`): call `deltaChannelHistoryTests(initializer)` in the same file. The saver does not override that method (7.9), so this checks the base-class walk on our storage.
- **Skip list.** The suite skips the `put` test "should only store channel_values that have changed" for the official SQLite saver, by name (`lgv:dist/spec/put.js:102-106`). Give the initializer `checkpointerName` `NodeSqliteSaver`, so it runs. If our saver stores full state per checkpoint it fails, and the PR adds the same skip with a written reason. 7.11 assumes the text repeats in every checkpoint, so expect the skip. Result 2026-10-18: with `NodeSqliteSaver` exactly this test fails (731 pass); the test file uses `checkpointerName` `@langchain/langgraph-checkpoint-sqlite` to get the official skip, with the reason in a comment. WP4 runs the suite first and records the result. No unexplained skip.
- **Foreign keys (O7-3).** Thread ids are unknown in advance: `uuid6(3)` (`lgv:dist/spec/put.js:10`), `"thread-1"` in `getTuple` and `list`, `"1"` and `"2"` in `deleteThread` (`lgv:dist/spec/delete_thread.js`). The initializer wraps the saver: on the first `put` or `putWrites` for an unknown thread id it inserts one `llm_runs` row with `id` equal to the thread id, `scope` `test`, `meeting_id` NULL (section 7). Production DDL stays unchanged. `destroyCheckpointer` is an optional teardown (`lgv:README.md`, section `destroyCheckpointer`); it deletes the test run rows. The rule for fresh storage per checkpointer sits in the `createCheckpointer` section of the same README. That production foreign keys stay intact is UNVERIFIED.

Own cases: **S1** `sqlite_master` lists `llm_checkpoints` and `llm_checkpoint_writes` after migration 40. **S2 to S5** `Uint8Array` round-trips through `BLOB`; `deleteThread` leaves 0 rows for the thread and keeps others; a failed write rolls back with no partial checkpoint; a write for a deleted run inserts 0 rows and does not throw (7.9, C6). **S6** dropped: `node:sqlite` is synchronous, so a second handle in one process throws `database is locked` (probe 2026-10-17, Node 26.5.0, 1096 ms); production uses one cached handle (`S/lib/db.ts:15-47`). **S7** nodes A, B, C: B throws after A is checkpointed; close the handle, drop the saver, open new ones on the same file; resume with the same `thread_id` and `durability: "sync"`; counters A 1, B 2, C 1 (WP4 acceptance). **S8** a self-killing child process is not planned (needs its own Knip entry and a TypeScript loader); the E2E kill test (10.11.3) covers it. **S9** the suite and S1 to S7 pass on Node 22 (rule 8).

The first WP4 test runs a small graph with a retry under the `T/setup.ts` fake timers. A hang means the sleep needs `vi.advanceTimersByTimeAsync` or a per-file opt-out (rule 4). A graph with no retry under fake timers: UNVERIFIED (3.7 U7, R4).

### 10.8 Graph and runner tests (WP5)

Graph tests use the real graph, the real saver on a temp SQLite file, and the real gateway over a scripted model or stubbed `fetch`. Section 3 lists the tests to add (3.7 X5).

- **GR1 to GR3.** GR1: `drawMermaid()` names exactly the six nodes of Figure 1 (3.7 X5). GR2: only files in `W` and `GW` import `@langchain/*` (3.1 layout rule 1), and a scan of the static `import` graph from `S/index.ts` reaches no module that imports `@langchain/*` (3.1 rule 2). Layer rule: no file under `LL` imports a module of `M` (`git grep -n "lib/meetings" -- apps/server/src/lib/llm` prints nothing; a test in `workflow-graph.test.ts` repeats the scan). GR3: set `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING`, `LANGCHAIN_TRACING` to `true`. (a) `stripTracingEnv` of `GW/env-guard.ts` removes all four from `process.env`. (b) `W/load-graph.ts` in a fresh registry calls `stripTracingEnv` before the graph module loads (a spy checks the order).
- **GR4 Fan-out.** `N` chunks give `N` runs of `correctChunk`; at most 3 alive (`WORKFLOW_FANOUT_CAP`; counter +1 at entry, -1 at exit); a local fake server sees at most 1 request in flight (`S/lib/llm/lane.ts:106-107`); results return in chunk order. Settles 3.7 U3.
- **GR5 One failed chunk.** Chunk 2 ends `content_filter`, others succeed: run `partial`, the failed chunk keeps its raw text, `identifySpeakers` still runs. #163 replay: chunk 0 ends `length`, the speaker suggestions of other chunks survive.
- **GR6 Length route.** Table below.
- **GR7 Total requests.** Persistent 503: 2. `content-filter`: 1. HTTP 401: 1. Invalid JSON: 2. Whole graph, real retry settings (G5). Proves the one retry layer of 5.6 (3.2 edge rule 7).
- **GR8, GR9 Cancel.** Soft: 2 calls queued, 1 in flight; queued calls stop, the in-flight call aborts, the graph reaches `save`, finished chunks are saved, run `cancelled` (3.4.5). Hard: a node ignores its signal; after `HARD_STOP_GRACE_MS` (30 s, advance the fake clock) the run ends `cancelled` and `save` does not run.
- **GR10 Resume, in process.** (a) `correctChunk`: throw inside a node after chunk 2 ends; new graph and saver on the same file; `invoke(null, config)`. Chunks 1 and 2 send 0 new requests. The reducer keeps one entry per chunk (3.3). (b) `identifySpeakers`: 0 requests for a finished half. (c) `summarize`: throw after map call 2: 0 requests for maps 0 and 1 (4.0.7 keys); with two reduce levels, throw after the level-1 calls: 0 requests for them, and the level-2 call gets the level-1 results.
- **GR11 Resume guards.** One test per guard of 3.4.7 (6). A failed guard gives 409 with a `ResumeConflict` whose `reason` is that of its guard (3.4.2). Guards 4 and 6 end the run `failed` and delete its checkpoints; guards 1, 2, 3, 5 leave the run row as it was. Changed `graph_version`: `failed`, `graph_changed`. Re-transcribe or re-diarize between kill and resume: `transcript_changed`. A stopped Summarize run gets `transcript_changed` on resume when a name is confirmed or an Enhance run writes `enhanced_text` meanwhile (decided 10.19); the run ends `failed`, checkpoints go (GR17), the user starts a new run. 3.4.7 owns which stopped runs this covers (summarize-only run, summarize stage of a chained run). A name confirmed while an `enhance`-only run is stopped does not fail it, because SW2 writes only `suggested_*` (guard 6, 4.1 P11).
- **GR12 Boot sweep.** A `running` row with a checkpoint becomes `interrupted`; without one, `failed` `interrupted_before_checkpoint`. Boot resume runs once (`MAX_AUTO_RESUMES` 1); a second crash leaves `interrupted`. The sweep uses synchronous SQL only. With the endpoint down, the boot resume waits, does not count and leaves the row `interrupted`. Run this twice: a `server` profile over a fake server that refuses connections, and a cloud profile (`openai`) over a stubbed `fetch` that rejects. A stubbed HTTP 404 or 503 means the endpoint is up: the probe passes and the resume runs. The cloud probe is one `HEAD` to the base URL the run already used; the test asserts no `Authorization` header, no key, no body, and the URL equals the base URL of the run's profile (decided 10.19). Probe tries and waits use the injected `sleep` (3.4.2). A graph error also leaves `interrupted`, with its `failure`, and the boot resume skips it.
- **GR13 Delete during a run.** Delete the meeting between two nodes: recorder, saver and `save` catch the foreign key error, the run ends with no error, and the six `llm_*` tables hold 0 rows for it (3.4.8). Trigger and FK behavior on Node 22.22.1 is 3.7 U5; the E2E run settles it (10.11.3).
- **GR14 Checkpoint size.** After the first fan-out step no checkpoint row holds the system prompt text, and row size stays near transcript size, not 40 times it (3.7 U10, 3.3).
- **GR15 Durability.** The runner passes `durability: "sync"` to every `invoke` (config spy; kill tests prove the effect).
- **GR16 `save` twice.** Same state twice gives the same database (4.6.2): same rows in `meeting_segments`, `meeting_speakers`, `meeting_summaries` and link rows (key `(call_id, target_type, target_id, seq)`).
- **GR17 Checkpoint deletion.** One rule, 3.4.6 step 5 (O7-2 closed, 7.15). After `succeeded`, `partial`, `failed` or `cancelled`, the thread has 0 rows in `llm_checkpoints` and `llm_checkpoint_writes`; this holds after a hard stop and after a failed guard 4 or 6 of 3.4.7. After `interrupted` (boot sweep, or graph error with a checkpoint), the thread has more than 0 rows in `llm_checkpoints`. One test per status (five).
- **GR18 Run-wide stop.** First request gets HTTP 401 (or the key is missing): 1 request in all (0 for a missing key), every other unit is `skipped`, also units that waited in the lane (5.1 step 4), `save` runs, run `failed`. Three `schema` failures in a row stop the node (`BREAKER_N`).
- **GR19 Two units, one node run.** Chunks 1 and 2 each get one retryable error: each is retried once, none escapes, run `succeeded`.
- **GR20 Many calls in one node (X7).** (a) A split chunk whose second half has a persistent 503 sends 4 requests: original, first half, second half twice. (b) A persistent 503 on the reduce call after N map calls sends N + 2 requests, and no map call is sent again.
- **GR21 Faults.** (a) No API key at the first call: `model_unavailable`, 0 requests, run `failed`. A node that throws a plain `Error` (try `verifyEvidence` and one `correctChunk` task): `internal`, the failed result shows in the final state (4.0.2), the graph reaches `save`, the run is `partial` when another write committed. A `save` write that throws twice: `save_failed` in `SaveResult.failures`, run `partial` (3.4.3 rule 6); if SW1 and SW2 both fail twice, run `failed`. (b) A graph error with a checkpoint: run `interrupted` with its `failure`, checkpoint kept.
- **GR22 Deadline.** A Summarize run with a small ceiling ends `deadline_exceeded`, run `failed`, no summary, no step marked `cancelled`.
- **GR23 Status tables.** Pure tests, no database, runner or model. (a) `foldStatus` (4.0.7): each of its five rows, a `partial` entry as both `ok` and `failed`, the empty list (`skipped`), and `ok` plus `skipped` (gives `skipped`). (b) `deriveRunStatus` (3.4.3): one hand-built `FinalState` per each of the 7 rules and each example of its table. Chained rows: Enhance `ok` with `summary.status` `failed` gives `partial` (rule 6); every node `ok` gives `succeeded` (rule 5). Summarize-only with `summary.status` `failed` gives `failed`, not `partial` (4.6.3).
- **GR24 Chain.** The Enhance start (auto-run and button) chains into Summarize in the same run (decided 10.19). Scripted model: one `runId`; steps of `correctChunk`, `identifySpeakers`, `verifyEvidence`, `save` end before `summarize` starts; summary calls read the `enhanced_text` the same run saved (3.2, 4.5). One run row and one `meeting_summaries` row. A Summarize failure leaves the Enhance results and gives the `deriveRunStatus` status (3.4.3), `partial` when another write committed. The Summarize button alone starts a run with stage `summarize` only. A name confirmed after a chained run makes the summary stale: the existing stale warning shows (8.9), no new run starts. A kill between the stages resumes at `summarize` with 0 new requests for Enhance units (GR10).
- **GR25 Step rows and run context.** Pure graph tests with the harness (rule 9). (a) Each node run opens and closes its step row (4.0.2, "Step ownership"): `prepare`, one `chunk:<i>` per task, `candidates`, `verify`, `save` get one row each, `seq` follows start order; a `summarize` node with a `runStep` body gets `single`, or `map:<i>` and `reduce:<level>:<group>`, and no row named `summarize`. A node that throws a plain `Error` closes its row `failed` with kind `internal`; for `prepare` the error is rethrown. (b) `ctx.onNodeStart` is called once per node run, in node order, with the node id; a throw in it is ignored. (c) Running `guardNode` twice for the same key, as a resume does: one row, `seq` and `attempts` kept, status `running` then closed again. (d) `createRunContextRegistry`: `get` of an unknown run id throws, a second `register` for one run id throws, `drop` removes, `size` follows. `productionDeps().getRunContext` throws for an unregistered run (WP5a, no runner).
- **GR26 Pure summary functions.** (a) `renderSummaryMarkdown` of `W/summary-pure.ts` (4.5.6): empty summary gives five headings and `None.` under four lists; `\n## Fake` makes no heading; an action item with owner and due prints `(Owner: ...; Due: ...)`; line breaks inside an item become spaces. The `save` test compares the stored `meeting_summaries.markdown` with this real function (10.6). (b) `plannedSummaryCalls` (4.5.3): under budget plans 1 call; six map chunks that do not fit one reduce plan map calls plus grouped reduce calls; a plan over `MAX_SUMMARIZE_CALLS` and a group of fewer than 2 partials give `budget_exceeded`.

The length route (4.0.6) has four steps: `lowerReasoning`, `split`, `raise`, `fail`. Run each path against a scripted model and count requests.

| # | Scripted answers | Req | Result |
|---|---|---|---|
| LR1 | 1200-token chunk `length`; both halves `stop` | 3 | Chunk `ok`. Halves saved in order. Segment ids intact. |
| LR2 | Every call `length` for a 1200-token chunk | 11 | Unit fails with `length`, other chunks fine. 11 is the 4.0.6 maximum: 1 call, 2 halves, 4 quarters, 4 raises. |
| LR3 | One-segment chunk `length`, also after the raise | 2 | Cannot split. Raises once. A second `length` fails the unit. |
| LR4 | `identifySpeakers`, reasoning on (`reasoningSteps` hook of 5.5 rule 4: `{ identifySpeakers: "bounded" }`), `length` | 2 | Step 1 runs. 1st body: `enable_thinking` `true` and `thinking_budget` (5.5.2). 2nd body: `enable_thinking` `false`, no `reasoning_effort`, no `thinking_budget` (5.5.2). |
| LR5 | The raise step | 2nd | `max_tokens` = `min(profile.maxOutputTokens, 2 x maxOutput)`; the wrapper keeps the larger `max_tokens`, so the raise reaches the wire under a lower preset (`S/lib/llm/registry.ts:127-138`). |
| LR6 | `reasoning_leak`, reasoning on (hook as LR4), then off | 2, then 1 | On: step 1. Off: the unit fails at once (5-P6). |
| LR7 | 1200-token chunk `length`; first half `stop`, second half `content_filter` | 3 | Chunk `partial`. `save` writes the first half and keeps the old text of the second. |
| LR8 | HTTP 413 on a 1200-token chunk; then both halves `stop` | 3 | `split` only: no `lowerReasoning`, no `raise`. |
| LR9 | `summarize`: `single` call ends `length`; every call of the replanned map and reduce `stop` | 1 + planned calls | Keys `single`, then `map:<i>` and `reduce:<level>:<group>` (4.0.7). Step `single` ends `succeeded`. Summary saved. Total at most 24. |
| LR10 | `summarize`: call `map:2` ends `length`; both halves `stop` | 3 for this chunk | Keys `map:2`, `map:2/0`, `map:2/1`. The reduce reads both half results in order. |
| LR11 | `summarize`: call `reduce:1:0` ends `length`; the raise `stop` | 2 for this call | Same key `reduce:1:0`, attempt 2, `max_tokens` = `min(profile.maxOutputTokens, 2 x maxOutput)`. |

A node with a failed unit never throws. The unit gets a `NodeFailure` with a `FailureKind` (4.0.7). A test per kind checks the kind reaches the run row and call record unchanged.

**Owner of each test.** Each test has one WP and one file in `apps/server/tests/`. That WP writes it and passes it before its PR is ready (11.5, 10.17). The H1 check of 11.6 lists these files as owned paths. WP5a tests use the test `RunContext` and the harness (rule 9) and read `deriveRunStatus` output (3.4.3). WP5b tests use the runner and the run row. "10.6 rows" are the node rows of 10.6 without `summarize`.

| File | WP | Tests |
|---|---|---|
| `workflow-graph.test.ts` | WP5a | GR1, GR2 (with layer rule), GR3, U6 (3.7; the acceptance step names the four variables in the installed `@langchain/core`, 11.5), GR5, GR7, GR14, GR18, GR19, GR21 (a) no key and plain `Error`, GR25; stability and "no attendee in any request" (10.5.4) |
| `workflow-requests.test.ts` | WP5a | "Req" column of 10.5.1: A1 to A3, A6 to A18, HE1 to HE10, HE12 to HE16 (G5) |
| `workflow-prepare.test.ts` | WP5a | 10.6 row `prepare` without `inputHash` cases (those are the WP2 test `input-hash.test.ts`, 10.9 check 6; both files planned and absent at `c47cd80d`, 4.1 P11) |
| `workflow-correct.test.ts` | WP5a | 10.6 row `correctChunk`; GR6; LR1 to LR3, LR5, LR7, LR8; GR20 (a) |
| `workflow-identify.test.ts` | WP5a | 10.6 row `identifySpeakers`; LR4, LR6 |
| `workflow-verify.test.ts` | WP5a | 10.6 row `verifyEvidence` |
| `workflow-save.test.ts` | WP5a | 10.6 row `save`; GR16; GR21 (a) `save` case; GR23; GR26 (a) |
| `workflow-runner.test.ts` | WP5b | GR4 (fan-out cap is a runner setting, 3.5 rule 2), GR8, GR9, GR13, GR15, GR17, GR21 (b), GR24 (a) (chain: one run id and row, node order, job kind change, kill between stages, Summarize-only start; runs with the WP5a `summarize` stub) |
| `workflow-resume.test.ts` | WP5b | GR10 (a), (b), GR11, GR12 |
| `workflow-chain.test.ts` | WP5b | GR24 (b): needs the real WP6 `summarize`; summary reads the same run's `enhanced_text`, one `meeting_summaries` row, failed summary step gives `partial`. Uses `describe.skipIf(SUMMARIZE_IS_STUB)`: skips on the WP5b branch alone, runs on the candidate branch and after the rebase on the WP6 merge (11.7) |
| `workflow-summarize.test.ts` | WP6 | LR9 to LR11; GR10 (c), GR20 (b), GR22; GR26 (b); 10.6 row `summarize` and the cost and token cases |

Live probe owners (10.12): WP3: LP1, LP4, LP6. WP5a: LP2, LP3, LP7. WP5b: LP5 (settles U4, 3.7). WP5a settles U6.

### 10.9 Migration, store and route tests (WP2)

Section 7.3 lists the migration tests, 8.12 the route and lookup tests, 11.5 WP2 the acceptance checks. Two tests pin schema version 39 (`T/schema-meetings.test.ts:7`, `T/migration-servers.test.ts:91`): raise both to 40. Migration 40 also adds `meeting_summaries.summary_json` (decided 10.19). Ten checks:

1. **A real v39 file.** Run the branch build once on a `.backup` copy of the real database in the scratch folder: `sqlite3 -readonly "<db>" ".backup <scratch>/copy.db"` (`LT:14`). Print counts only. Server start runs the meeting retention sweep at once (`S/index.ts:216`; `S/lib/daily-sweep.ts:23-26`; `M/retention.ts:65-67`), which deletes `mic.wav` and `system.wav` at each expired row's `audio_dir` (`M/retention.ts:41-58`); on a copy those paths point into the real profile. So after the `.backup` and before boot, run `UPDATE meetings SET audio_dir = NULL` on the copy. Then `SELECT count(*) FROM meetings WHERE audio_dir IS NOT NULL AND audio_dir NOT LIKE '/tmp/%'` must print 0 (query new; `MB:17` gives the manual `/tmp/` check).

```sql
SELECT version FROM schema_version WHERE id = 1;   -- the new SCHEMA_VERSION (40)
SELECT count(*) FROM meetings;                     -- equals the count before the upgrade
PRAGMA foreign_key_check;                          -- no rows
SELECT count(*) FROM pragma_table_info('meeting_summaries') WHERE name = 'summary_json';  -- 1
SELECT count(*) FROM meeting_summaries WHERE summary_json IS NOT NULL;  -- 0 for every row made before the upgrade
```

2. **No prompt text in meeting routes.** `GET /api/meetings` and `/api/meetings/:id` read with `SELECT *`: the list reads `meetings` (`S/routes/meetings.ts:1333`); the detail route reads `meetings` through `getMeetingRow` (`M/store.ts:92`, called at `S/routes/meetings.ts:2217`) and `meeting_summaries` (`S/routes/meetings.ts:2227`). Neither carries run data; `llm-runs` carries statuses and failure kinds only. A sentinel word seeded in `messages_json` and `raw_text` appears in none of the three responses.
3. **Start contract** (3.4.2 HTTP table). `POST /:id/enhance` and `/:id/summarize` answer 202 with `runId`; guards keep 404 (unknown meeting) and 409 (wrong status, running job, empty transcript). `POST /:id/runs/:runId/resume` answers 202 `StartRunResponse`, 404, or 409 `ResumeConflict` with the `reason` of the failed guard (WP5b). The old 200 and 502 bodies are gone; no setting selects a path (decided 10.19). The Enhance start runs the Summarize stage in the same run (GR24).
4. **No server gate.** The server has no `advanced_mode` gate (D10): call records answer with it off. The renderer sends no request when it is off (10.11.2).
5. **Recorder** (7.7; WP2, real file; run once with scope `meeting` and once with scope `test`). `startStep` for three keys in order gives `seq` 1, 2, 3; a second `startStep` of the first key keeps `seq` 1 and `attempts`; after `sweepInterrupted` and a new `startStep` for a fourth key the value is 4. Three `recordCall` calls for one run and unit key return `attempt` 1, 2, 3; another key returns 1. A call not recorded takes no number. `finishedCall` returns the newest row with `error_kind` NULL, and `null` for a cut marker, a missing `finish_raw` or a `params_json` that does not parse. `linkCall` with the same `(call_id, target_type, target_id, seq)` twice leaves one row; two links with different `seq` leave two.
6. **Input hash** (4.1 P11; WP2, real file). The `prepare` row tests of 10.6 that name `inputHash`.
7. **Scope-generic tables** (WP2, real file). A run with scope `meeting` and `scope_id` equal to a meeting id has `meeting_id` set. A run with scope `test` has `meeting_id` NULL and survives any meeting delete. `llm_calls` carries `scope` and `scope_id`. A link row uses `(target_type, target_id)` and names no meeting table. The inspector data route and types name no meeting field except through `scope_id` (the inspector screen stays meeting-only, 8.3).
8. **Call record round trip** (WP2, real file; closes the WP2/WP3 interface). Insert a run of scope `meeting`. Call `recordCall` with a `CallRecord` with every field set to a distinct non-null value (no `scope`, `scopeId` or `meetingId` field exists). Read the row with `SELECT *` and compare each column: `run_id`, `step_key` (= `unitKey`), `node`, `attempt` (= returned value), `retry_reason`, `provider`, `requested_model`, `served_model`, `messages_json` (system turn first), `schema_name`, `schema_version`, `schema_json`, `params_json`, `raw_text`, `parsed_json`, `finish_unified`, `finish_raw`, the four token columns, `reasoning_chars`, `queued_ms`, `latency_ms`, `error_kind`, `error_detail`, `started_at`, `finished_at`. `scope` and `scope_id` equal those of the run row. `PRAGMA table_info(llm_calls)` has no `meeting_id`. A second case uses scope `test`. A third uses null token counts and shows NULL columns, not 0. The test sits in `llm-record.test.ts` (11.4).
9. **Step counts** (WP2, real file). Seed one run with steps: `prepare` (succeeded), `chunk:0` and `chunk:1` (succeeded), `chunk:2` (failed), `chunk:3` (partial), `candidates`, `verify`, `save` (succeeded). `GET llm-runs?latest=1` returns `llmStepCount` 5 and `failedStepCount` 2, and `steps` lists only `chunk:2` and `chunk:3`. The same run read with `run_id` returns the same counts. A run with no step row returns 0 and 0. Read back with `sqlite3` and the two `count(*)` queries of 8.3. The test sits in `meetings-runs.test.ts` (11.4).
10. **Summary object** (WP2 column, WP6 writer). The `summary_json` checks of the `save` row in 10.6 run on a real file and are read back separately.

Cascade read-back after a real delete (table names: 7.4):

```sql
-- :runIds = the run ids read before the delete: SELECT id FROM llm_runs WHERE scope = 'meeting' AND scope_id = :id
SELECT 'llm_runs', count(*) FROM llm_runs WHERE scope = 'meeting' AND scope_id = :id
UNION ALL SELECT 'llm_run_steps', count(*) FROM llm_run_steps WHERE run_id IN (:runIds)
UNION ALL SELECT 'llm_calls', count(*) FROM llm_calls WHERE scope = 'meeting' AND scope_id = :id
UNION ALL SELECT 'llm_call_links', count(*) FROM llm_call_links WHERE scope = 'meeting' AND scope_id = :id
UNION ALL SELECT 'llm_checkpoints', count(*) FROM llm_checkpoints WHERE thread_id IN (:runIds)
UNION ALL SELECT 'llm_checkpoint_writes', count(*) FROM llm_checkpoint_writes WHERE thread_id IN (:runIds);
-- before the delete: rows. after DELETE /api/meetings/<id>: six rows with count 0.
SELECT 'orphan_calls', count(*) FROM llm_calls WHERE run_id NOT IN (SELECT id FROM llm_runs)
UNION ALL SELECT 'orphan_checkpoints', count(*) FROM llm_checkpoints WHERE thread_id NOT IN (SELECT id FROM llm_runs);
-- both rows 0 after the delete. Only `llm_runs` carries `meeting_id` (cascade root, 7.4). Step and checkpoint tables reach the meeting only through the run row. A run of scope `test` with `meeting_id` NULL is not counted and survives (check 7).
```

### 10.10 Renderer tests and locales (WP5b and WP7)

Vitest runs `.ts` tests in a node environment with no `jsdom`, `happy-dom` or `testing-library`, so renderer tests check pure logic (`E/vitest.config.ts:16-21`; style `E/src/renderer/src/pages/meetings/speakers.test.ts:1-18`). Components get E2E proof. Two pure `.ts` helpers hold the rules, each with a test file. **WP5b** owns `E/src/renderer/src/pages/meetings/run-notice.ts` and `run-notice.test.ts`: the notice lines of 8.9 (one line per error kind, the chunk list, the `run.errorKind` fallback, and the partial text `{{failed}} of {{total}}` from `failedStepCount` and `llmStepCount`: a run with 3 and 12 gives "3 of 12", and a `steps` array shorter than `llmStepCount` shows the helper does not count it) and the buttons per run status. **WP7** owns `llm-inspector-model.ts` and `llm-inspector-model.test.ts` in the same folder: ledger grouping and the "Current" mark; error kind to text key with the `unknown` fallback; choice of the producing call for an edit (8.12). One pure gate function sits in the WP7 helper: `advanced_mode` equal to `"true"` (`E/src/renderer/src/shell.tsx:178-179`); test `"true"`, `"false"`, missing, garbage. Strings every user sees go into a `KEY_GROUPS` entry of `locales.test.ts` (8.10, group `enhance-honesty`; WP5b; `KEY_GROUPS` starts at `E/src/renderer/src/locales/locales.test.ts:67`). The loop at `:439-455` runs each group over `template.json` and the 7 locale files (8 files). Advanced-only strings go into `en.json` and `template.json` (WP7; the plan of 8.10). `locales.test.ts:10-15` says locale files may lag `template.json` and `en.json`; `:461-474` checks the placeholders of `meetings.*` keys. CI runs renderer tests after the server build (`CI:172-175`). Group `enhance-honesty` loses the three `enhanceFailed*` keys in the PR that switches the renderer (WP5b, 8.10), and the new `meetings.llmRun.*` and `meetings.llmError.*` keys join it. No toggle row and no `enhanceWorkflow` key exist, so no test covers them. The inspector UI proof also covers an imported meeting (10.11.2 item 6).

### 10.11 End-to-end tests in the real app

An E2E test starts the built app with `launchOpenstyle` (`E/tests/helpers/e2e-app.ts:36-58`). The server runs from the bundle `out/main/server-process.js` (`E/electron.vite.config.ts:78-83`), which only E2E exercises. No spec covers transcript rows, the Enhance switch (`E/src/renderer/src/pages/meetings/detail.tsx:802-806`) or the Summary tab (`detail.tsx:793`). A search of `apps/electron/tests` on 2026-10-17 found only the onboarding skip of the Enhance step (`E/tests/app.test.ts:158-171`) and the Models page task rows (`E/tests/preset-crud-evidence.test.ts:673-683`); `meeting-import.test.ts` and `MC` do not assert on those screens.

The fake own server follows `MC:103-146`: `GET /v1/models`, `/v1/models/status`, `POST /v1/chat/completions` by script. The script reads node and segment ids from the request, not a request counter (fan-out and retries break counters). It logs every request body.

Setup (`MC`, `LT`): (1) `settings.json` with `onboardingComplete: true`; `config.freestyle.json` with the `meetings` flag (`MC:215-229`); `meeting_enhance_prompt_seen` `"true"` (`LT:213-214`). (2) Launch; wait for the dashboard window and the boot orphan sweep (`setTimeout(..., 3000)` after server host start, `E/src/main/index.ts:243,254-257`; the test waits 3.5 s, `MC:258-263`). (3) `POST /api/servers` for the fake server; `POST /api/models/configured` with `type` `llm`, `is_default` true (`MC:271-290`); `PUT /api/settings/advanced_mode` (`E/tests/model-picker-groups.test.ts:342`). (4) Seed the fictional meeting with `node:sqlite` as `scripts/site-captures/seed-data.mjs:167-221`: status `transcribed` (Enhance accepts `transcribed` and `summarized`, `S/routes/meetings.ts:2105`), no audio. Run locally only through the Test Runner in quiet mode (10.11.4).

#### 10.11.1 Spec A: the workflow in the real app

File (WP9): `E/tests/meeting-enhance-workflow.test.ts`. One meeting, 11 chunks. A local fake server has one lane slot, so calls run one at a time (`S/lib/llm/lane.ts:106-107`). The script keys on the set of segment ids in a request. Each chunk replays one row of 10.5.1 and 10.8 and expects that row's request count: 1 and 2 `stop` (A1; one correction, none); 3 LR1; 4 LR2 (11 requests); 5 A6; 6 A8; 7 A10 twice; 8 A2 then valid; 9 A2 twice; 10 HE6 then `stop`; 11 HE1 with `Retry-After: 1`.

On screen and in the record, chunk 1 shows edited text; chunk 2 no edit; chunks 3, 8, 10 show every attempt; chunks 4 to 7 and 9 show the typed failure (`length`, `content_filter`, `unexpected_tool_calls`, `abnormal_stop`, `schema`) and keep the raw text. A run-wide failure stops the other chunks (3.4.5), so each run-wide kind runs in its own meeting of 3 chunks: A14 (`reasoning_leak`, reasoning off), A16 (`model_mismatch`), HE8 (`provider_auth`), and a 400 without `response_format` (`provider_invalid_request`). Each sends 1 request and ends `failed`; the other chunks show `skipped`; the notice shows one line with the kind. The speaker call has its own script: one valid self-introduction, one quote not in the transcript, one unknown label. A second meeting repeats 429 twice (`provider_rate_limited`) and 503 twice (`provider_unavailable`). `provider_timeout` is not in the E2E (minimum timeout 30 s, `packages/validations/src/settings.ts:400-402`): W10 covers it.

- Every request body holds `response_format.type` `json_schema` and `chat_template_kwargs` (WP9 floor).
- Each typed failure stays on screen after reload and restart (G4), with `advanced_mode` off: the 8.9 notice shows one line per kind (5 lines in the first meeting, 1 in each run-wide meeting) with the text of `meetings.llmError.<kind>`. A later run keeps old failures in the run list.
- A summary run with a small `meeting_summary_context_budget` (minimum 100, `packages/validations/src/settings.ts:257-266`) shows map and reduce calls.
- Chain: the Enhance button fills the Summary tab in the same run, with no second click. Auto-run starts only at the end of `runTranscribeJob` (`S/routes/meetings.ts:1039-1045`), so it needs a second meeting imported from a short fictional WAV (`helpers/wav`, as `MC`); the default `voice` model points at a local fake STT server that answers `POST /v1/audio/transcriptions` with fixed fictional text (the hold server of `MC:105-134` answers the model probe and parks transcription requests, so the test needs a variant that answers with fixed text; `MC:271-291` only configures the model); `meeting_enhance_auto_run` is `true`; the test calls `POST /api/meetings/<id>/transcribe`. Expected: one run with `started_by` `auto`, `kind` `enhance` and a filled Summary tab. The live version on the owner's oMLX is WP5b accept (13). The Summarize button alone still starts a summary alone. After the test confirms a speaker name, the stale warning shows on the summary (decided 10.19).
- CI time (R13): 1 worker, and 2 retries when the `CI` env var is set (0 locally), 5 minutes for the E2E step (`E/playwright.config.ts:14-15`, `CI:203-205`). Measure before and after. No fixed limit: if the step goes above 4 minutes, WP9 raises the step timeout in the same PR and reports both numbers. Kill tests set `test.describe.configure({ retries: 0 })`: a retry hides a race.

#### 10.11.2 Spec B: the inspector in the real app

File (WP9): `E/tests/meeting-llm-inspector.test.ts`, on the meeting and script of spec A. A segment row has no wrapper or test id today (`E/src/renderer/src/pages/meetings/detail.tsx:830-872`); WP7 adds test ids (precedent `getByTestId("onboarding-enhance-skip")`, `E/tests/app.test.ts:160`).

1. Gate off: 0 inspector controls in the DOM and 0 requests for call records (`page.on("request")`).
2. Gate on: click an edited text (chunk 1). The panel's system message, user message and response text equal the body the fake server logged.
3. The panel shows top-level params `temperature`, `max_tokens`, `response_format` and extra body param `chat_template_kwargs.enable_thinking`, equal to the logged body keys; both finish reasons, tokens, latency, attempt number, served and requested model; every attempt of chunks 3, 8, 10 in order; a failed or retried chunk with no edit (D10).
4. Speakers: kept suggestion with quote and verdict; dropped suggestion with reason. Summary tab: link to the single call, or to the map calls and the reduce call.
5. `advanced_mode` off with the panel open: the panel disappears. Delete the meeting: the six-table query of 10.9 gives six zeros (G7).
6. Imported meeting (decided 10.19): import by the route of `E/tests/meeting-import.test.ts`, run Enhance, click an edited text. The panel shows the same fields as for a recorded meeting, including the system and user message the fake server logged.
7. Screenshots to `OPENSTYLE_EVIDENCE_DIR`: gate off, edit panel, failed-chunk panel, speaker verdicts, summary calls, at 1152x648 and 720x480 (8.12). Claude opens each before it reports (`LT:179`).

#### 10.11.3 Spec A, part 2: kill and resume

Pattern `E/tests/server-host-restart.test.ts:54-96`: read the PID with `app.evaluate` and `__openstyleServerHostPid` (`E/src/main/server-host.ts:256-260`), send `SIGKILL`. Main restarts the process after a 1 s backoff (`E/src/main/server-host.ts:27`).

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
3. Each answered chunk reached the fake server exactly once in the whole test; the held chunk twice. A second spec repeats this for the speaker call (the held request is `identifySpeakers`) and for a Summarize run with a small budget (kill after map call 2): a finished call reaches the fake server once (call reuse, 5.6). A second request for an answered chunk means the checkpoint was lost: this proves `durability: "sync"` (G6; `lgd:385-387`).
4. No call record stays non-final. Step rows show `succeeded`. The run row shows its final status.
5. The main-process sweep (`transcribingOnly`) leaves the meeting `transcribed` (`E/src/main/server-host.ts:100-104`, `E/src/main/meeting-recorder.ts:818-830`).
6. **Second kill** during the resumed run: boot resume runs once, the run stays `interrupted`, the screen shows the notice and the Resume button (8.9), and a click on Resume completes the run.
7. **Delete during a run** while a chunk is held: no run error, the six-table query shows 0 rows. This runs in the Electron server process on Node 22.22.1 and settles 3.7 U5 (3.4.8).
8. Repeat 1 to 5 five times in a row on the Mac; all five pass. Under `async` durability a lost last checkpoint is a race (`lgd:386`). CI runs it once.
9. **Endpoint down at boot.** Kill the server and stop the fake server. The boot resume waits, the run stays `interrupted` and `resume_count` stays 0 (3.4.7). Start the fake server again. A click on Resume completes the run. The cloud case has no E2E run (needs a cloud key and a cut network); GR12 and W15 cover it with a stubbed `fetch`. The cloud probe stays UNVERIFIED against a real provider (10.19).

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

Real server, seeded fictional meeting, the owner's oMLX at `127.0.0.1:8123`, Qwen3.8-27B requests only. Before and after, `timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models` prints `200` (`LT:229`). A guard hook blocks other models (`LT:65`). Send only the fixed node schemas (a new schema costs about 0.45 GB of grammar cache, 10.5.4). WP3 probes use the real schemas of `W/schemas.ts` (new, absent at `c47cd80d`), never a throwaway one.

1. Build `pnpm turbo build --filter=@openstyle/server`; source `scripts/isolated-env.sh`, which sets the env and defines `isolated_run` only (`scripts/isolated-env.sh:1-12,87-93`), then start from `apps/electron` with `PORT=4651` and `isolated_run` (`LT:74-75`; `LT:70-76,87-100`). Set `OPENSTYLE_LOG_DIR` to the scratch folder for fictional text only (`packages/utils/src/logger.ts:38-41`; never a real meeting, `MB:19`). `LT:102` says leave it unset, but the proofs read the trace log (step 4; 4.2.6, 4.5.6, 5.9, 8.12): this spec plans a skill change (WP9).
2. `POST /api/servers {"url":"http://127.0.0.1:8123"}`; default LLM `Qwen3.8-27B` via `POST /api/models/configured` (`LT:125-126`). Seed a fictional meeting (6 chunks, 3 speakers, one made-up self-introduction) with `node:sqlite`. Start the run (3.4.2); poll `GET /api/meetings/<id>` until it ends.
3. Read back with `sqlite3 -readonly "$OPENSTYLE_DB_PATH"`. For a run with no failed call, `calls` is above 0 and the rest are 0 (G7):

```sql
SELECT count(*) AS calls,
       sum(finish_unified IS NULL)  AS no_finish,
       sum(finish_raw IS NULL)      AS no_raw,
       sum(input_tokens IS NULL)    AS no_input_tokens,
       sum(latency_ms IS NULL)      AS no_latency,
       sum(parsed_json IS NULL)     AS no_object
FROM llm_calls WHERE scope = 'meeting' AND scope_id = :id AND error_kind IS NULL;
```

4. Ledger against wire: one call's `params_json` and messages equal the body of its `llm.request` entry in `openstyle-trace.log` (8.12 item 3; `S/lib/trace.ts:257-277`; `server` provider only).
5. Schema on the wire: every LLM node request holds `response_format.type` `json_schema`; `correctChunk` holds `chat_template_kwargs.enable_thinking` `false` (WP5a acceptance). Result: `enhanced_text` count and speaker rows above 0, `chunksFailed` 0.
6. Probes run from a throwaway `.mts` script in the scratch folder that calls the gateway with the real node schema through `scripts/meeting-v2/ts-register.mjs` (`scripts/meeting-v2/compare.mts:11`, `package.json:9-10`; `compare-speakers.mts` also uses it: `package.json:9-10`). That the gateway loads under it is UNVERIFIED: the hook only retries relative `.js` specifiers as `.ts`, and `apps/server/tsconfig.json` has `paths` aliases plain Node does not apply. WP3 checks the load first. Fallback: a separate vitest config outside the default run, with real timers. Delete the script after.

Each probe has one owner WP, which runs it and reports the result in its PR (11.5, 10.17).

- **LP1** (WP3; G2) typed `length`: one call, `maxOutputTokens` 16 (5.9 check 2). Expect `LengthError`, `rawFinishReason` `length`, the cut text in the record.
- **LP2** (WP5a; 5.10 R5-5, 4.0.6, 4.7 N10) does oMLX stop at the limit with a strict schema? Long prompt wanting a long answer; record the length. If it runs past the limit, the length route cannot work on oMLX: say so. UNVERIFIED.
- **LP3** (WP5a; 4.7 N10) does oMLX apply the strict schema, also to reasoning? Tempting prompt, reasoning on and off (via the `reasoningSteps` hook of `resolveCallProfile`, 5.5 rule 4). Record only: the gate parses every answer. Also record whether the top-level `thinking_budget` of the bounded plan (5.5.2) changes reasoning length. UNVERIFIED.
- **LP4** (WP3; 5.5.3) a preset with `response_format`, `stop`, `guided_json` on `meetingEnhance`: the ledger lists the three as dropped and the body keeps the SDK `response_format`.
- **LP5** (WP5b; 3.7 U4) does a cancel stop generation? (1) T0: a one-token request (`max_tokens` 1, Qwen3.8-27B only) to the idle model. (2) Start an Enhance run with a long answer on a fictional meeting. (3) Cancel with `POST /api/meetings/<id>/cancel-transcribe` (3.4.5). (4) At once, send the same one-token request and time it as R. R close to T0 means the engine stopped; R much larger means it kept generating. The PR gives T0, R and the oMLX log lines, not a pass line. UNVERIFIED.
- **LP6** (WP3; L4, 5-P4) record the `served_model` oMLX reports; empty or equal are valid. **LP7** (WP5a; L1) reasoning leak: thinking on (the hook), small budget; if none occurs, the fake own server is the only proof.

Not reachable on the owner's oMLX with a safe request: `content_filter`, `unexpected_tool_calls`, unified `error`, HTTP 429 and 5xx, `model_mismatch`. Only the fake own server (10.11) and the scripted model (10.5) prove them; the PR says so. Cloud providers: no live proof (decided 10.19); only the local oMLX with Qwen3.8-27B gets live proofs. Cloud paths keep scripted-model and wire tests, and their rows stay UNVERIFIED, including stop aliases and served ids (5.3.4). W12 still checks each request body. Cleanup: kill only your PIDs; delete the scratch folder and script; `git status --short` is empty; the oMLX check prints `200`.

### 10.13 Tracing proof (WP8)

Section 9.9 holds the tests and checks C1 to C10. The gate uses `OPENSTYLE_MLFLOW_TRACKING_URI` and `OPENSTYLE_MLFLOW_EXPERIMENT_ID` (9.5.1). A trace counts only after a read-back from the server.

- **Typed-error runs for C6.** Run each once against the real MLflow with the fake own server of 10.11: `length` with valid JSON, `content_filter`, `unexpected_tool_calls`, `abnormal_stop`, `reasoning_leak`, `schema`, `model_mismatch`, `provider_rate_limited`, `provider_unavailable`, `provider_auth`, `provider_invalid_request`, `cancelled`. Run `provider_timeout` once by hand (30 s or more). One more run uses the real oMLX and LP1. Fictional text only. A `length` call that lands as `OK` is the failure to avoid (another project had it until it set ERROR: `ON` `llm/_telemetry.py:418-438`).
- **Read back** with `MlflowClient.search_traces` (9.9; `CM:77-81`): both span families (our run and node spans, AI SDK spans). Name the experiment in the PR. Ask the owner before you delete it. A tracing test that needs a flush opts out of fake timers (rule 4; 9.9 test 5).
- The owner can waive the read-back for one round, as for r9, r9b, r9c (rounds in `MV2:483-486`; the word "waiver" is not there, the waiver rule is this spec's). The waiver goes into the round record. No agent waives it alone: it is the Q18 default, which becomes the owner's decision when he approves this spec at S0 (12.2).

### 10.14 Bundle and packaging checks (WP1, WP5, WP8, WP9)

The app ships no `node_modules`, so main, preload and the server bundle stay self-contained (`AGENTS.md:87`, `E/electron-builder.yml:20-28`). A run from `out/` hides a missing dependency (the repo has `node_modules`), so only the guard and a packaged run catch it. The standalone server also builds with `pkgroll` (`apps/server/package.json:5`); the 10.12 proof runs that build. Both builds must pass.

| # | Check | Command | Pass when |
|---|---|---|---|
| BC1 | Build | `cd apps/electron && OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build` | Exit 0; also type-checks (`E/package.json:19`) |
| BC2 | Guard | `node scripts/check-bundled-requires.mjs` | Last line starts with `ok:` (`E/scripts/check-bundled-requires.mjs:71-72`) |
| BC3 | Guard reads chunks | WP1 extends it to `out/main/chunks` and `commonjsRequire(`; today it reads top-level files only (`E/scripts/check-bundled-requires.mjs:34`) and a literal `require("x")` only (`:26`) | A build with a planted dynamic `require(variable)` in a chunk fails the guard (red proof, rule 3) |
| BC4 | Dead stubs | `grep -c 'commonjsRequire(' out/main/*.js out/main/chunks/*.js` | Not above the `c47cd80d` baseline. A local build printed 0 for all 10 files on 2026-10-17; its commit is unrecorded, so WP1 measures the baseline |
| BC5 | One SDK copy | `grep -o 'AI_NoObjectGeneratedError' out/main/server-process.js \| wc -l` | 1, as on v6 (6.9.5) |
| BC6 | Sizes | `ls -l out/main/*.js`, `du -sk out/main/chunks`, `app.asar` | Recorded on `main` and the branch with one recipe, and `du -sk apps/electron/out` too. Target near 9 MiB (`AGENTS.md:87`). No fixed bundle limit (decided 10.19): each PR reports the growth, the release reports the asar size. WP-R should shrink the bundle; its PR reports the numbers |
| BC7 | Packaged build | `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openstyle/electron build:unpack`; `find apps/electron/dist -name app.asar -exec ls -l {} +` | Size reported (WP9 acceptance 5). That it runs on this Mac is UNVERIFIED |
| BC8 | Packaged start | Start `dist/mac-arm64/Openstyle.app` with `OPENSTYLE_E2E=1`, `OPENSTYLE_USER_DATA`, `OPENSTYLE_SERVER_PORT` through the Test Runner; wait for `GET /api/health` 200; run one Enhance against the fake own server by API; read back the records; kill only that PID | Exit as above. That Playwright can drive the packaged binary is UNVERIFIED (the repo sets no Electron fuse: search of `E/electron-builder.yml`, `E/package.json`, `E/scripts`); if not, use this API-only start |

#### 10.14.1 Remix removal checks (WP-R)

The owner removes the Remix feature (decided 10.19). WP-R has its own PR and exclusive file ownership (11.1). It lands before WP1, so the SDK bump has no Remix code. The inventory is `specs/remix-removal-inventory.md`, a file of the spec PR; the WP-R card names its sections.

**The one Remix grep and the one allow list.** WP-R accept (1), RM1, RM10 and R19 (12.1) use this command and list only. It searches the whole tracked tree (`.claude`, `AGENTS.md`, `README.md`, `knip.jsonc`, `site`, `scripts`, `apps`, `packages`):

```bash
git grep -n -i -I remix -- . ':(exclude)specs' ':(exclude)CHANGELOG.md' ':(exclude).lore.md' ':(exclude)apps/server/src/lib/schema.ts' ':(exclude)apps/server/tests/v20-merge-reconciliation.test.ts' ':(exclude)apps/server/tests/schema-llm.test.ts'   # RMGREP: prints nothing
git grep -l -i -I remix -- specs                                  # prints only spec files (allow-list item 6)
```

| # | Path | Why `remix` stays there |
|---|---|---|
| 1 | `apps/server/src/lib/schema.ts` | Migration 20 creates the Remix tables and stays as written (WP-R card). Migration 40 drops them (WP2, 7.3) |
| 2 | `apps/server/tests/v20-merge-reconciliation.test.ts` | Tests migration 20. WP2 edits only its version pins |
| 3 | `apps/server/tests/schema-llm.test.ts` (new, WP2; absent at `c47cd80d`; migration 40 is planned, the last guard in `S/lib/schema.ts` is `currentVersion < 39` at `:997`, UNVERIFIED until WP2) | WP2 test that migration 40 drops the three `remix_*` tables and three settings rows (11.5 WP2 accept 1) |
| 4 | `CHANGELOG.md` | Release history. The release process writes it; no WP rewrites old entries |
| 5 | `.lore.md` | The lore tool owns this file (`AGENTS.md:1-4`, `.lore.md:1`); no WP edits it. Decided 2026-10-17 (owner viewpoint): its Remix entries stay in the WP-R PR (a hand edit of a tool file is outside the owner's rule; entries are history). After the WP-R merge the coordinator tells the owner how many lines still name Remix (`grep -c -i remix .lore.md`). This does not block G13 |
| 6 | `specs/**` | Dated history. `specs/remix.md` gets the RETIRED notice (WP-R card). This spec and `specs/remix-removal-inventory.md` name Remix on purpose. WP-R edits no other spec file |

If the inventory (section 15.4 item 1) names another command or list, this table decides, and the spec PR aligns the inventory.

| # | Check | Command | Pass when |
|---|---|---|---|
| RM1 | No code left | RMGREP | Prints nothing. A file outside the allow list needs the coordinator to widen the list first; the PR cannot add a path |
| RM2 | No routes | Start the built server; `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/api/remix/transform` | `404`. The same for `/api/remix/agent` |
| RM3 | Task id and settings gone | `git grep -n -E "\"remix\"|remix_" -- packages/validations apps/server/src ':(exclude)apps/server/src/lib/schema.ts'` and the model-picker tests | Prints nothing; the Models page task list has no Remix row (screenshot) |
| RM4 | Locales | `locales.test.ts` on `template.json` and the 7 locale files | No `remix` key in any of the 8 files; 0 failures |
| RM5 | Old user data still boots | Boot the branch build on a `.backup` copy of the real database (10.9 check 1), plus a copy with a stored Remix task assignment and a stored Remix hotkey setting | Server and app start; `GET /api/health` 200; `PRAGMA foreign_key_check` no rows; no app error. How stored rows are handled (ignored or deleted) is the WP-R card's choice: UNVERIFIED until the card names it |
| RM6 | Windows and hotkeys | Start the app through the Test Runner (10.11.4) | No Remix bar window and no Remix global shortcut. TCC count equal before and after |
| RM7 | Tests removed | `git grep -l -i remix -- apps/*/tests apps/electron/tests` | Prints only the two allow-list tests (items 2 and 3, the second after WP2). The PR lists each deleted test and E2E spec by name with the reason |
| RM8 | Dependencies | `git grep -n -E "@ai-sdk/react" -- apps packages` and `pnpm why @ai-sdk/react` | If nothing else imports `@ai-sdk/react`, it leaves `package.json` and the lock file; else the PR names the importer |
| RM9 | Bundle | BC1 to BC6 on `main` and the branch | Build and guard pass; sizes reported, no limit (BC6) |
| RM10 | Docs and site | RMGREP (covers `site`, `README.md`, `AGENTS.md`, `.claude`), then `head -12 specs/remix.md` and a look at the `site/` screenshots | RMGREP prints nothing; `specs/remix.md` starts with a retired notice; no site page or screenshot shows Remix. The look is a manual check and the PR says it was done |

### 10.15 Quality gate: benchmarks and the council (WP10a, WP10b)

D12 asks for a before and after run on the owner's real meetings, then the council. The council must reach consensus before the merge of the PR that switches the Enhance and Summary routes (WP5b): no flag hides the change, so a release cut after that merge ships it (decided 10.19). The skills hold the base procedures (`MB`, `CS`). Tool gaps: `scripts/meeting-v2/metrics.mjs:636` sets `enhanceSeconds` 0; no committed script calls the Enhance route; `CS:14` names only `compare.mts`, whose dump has no `enhanced_text` and no `meeting_speakers` row (`scripts/meeting-v2/dump-chunks.mjs:1-3,19-22`). `dump-speakers.mjs` and `compare-speakers.mts` fit (rounds r9, r9b, r9c: `MV2:483-486`). WP10a adds `scripts/meeting-v2/run-enhance.mjs`; WP10b updates the council skill.

**Data sets.** `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6` (8 chunks) was the only set of r9, r9b, r9c. It reproduces #163: VERIFIED by the owner on 2026-10-17. `/tmp/meeting-v2/r9b.log` lines 3, 8, 23, 28, 48, 53 show `chunksAttempted` 8 and `chunksFailed` 2 in 6 of 6 arm A tries; `/tmp/meeting-v2/run-arms.mts:10` sets this id; `MV2:483-486` records the same rounds. Issue #163 names no meeting id (https://github.com/Maheidem/openstyle/issues/163), so the link rests on these files. WP10a records the failed chunks of each baseline run and a hash of the meeting context (`contextHash`). G3 counts only if the old path fails at least one chunk in each baseline run; earlier rounds show it for arm A (2 of 8 failed in r9 and every r9b run, 1 or 2 of 8 in every r9c run: `MV2:483,485,486`). Arm C had 8 of 8 chunks in r9b (`MV2:485`); the other rounds give no arm C count. If a baseline run fails no chunk, report it and prove the fix with the forced-failure replay GR5 on the same meeting. The new arm needs 0 failed chunks in 6 of 6 runs with the same `contextHash`. `2943c36a-532e-4db9-af09-b5e66f0bdf2d` (425 s): short control (`MB:24`). `9243bea0-567f-443b-bf3b-9980f69993fd` (3580 s): long, summary path (`MB:25`); if it fits the summary budget (8000 tokens default: `packages/validations/src/settings.ts:185`, `M/summarize.ts:49`; setting read at `M/summarize.ts:365-369`), lower `meeting_summary_context_budget` in the scratch database. `parseMeetingSummaryContextBudget` accepts 100 to 200000 and gives 8000 for a missing, malformed or out-of-range value (`packages/validations/src/settings.ts:214-221,257-266`).

**Procedure.**

1. Levels 1 to 5 pass; oMLX answers 200; tracing variables are unset, so no meeting text leaves the Mac (11.1 B12). Arm X is the old path (WP10a, built from `main` at `c47cd80d`), arm Y the new path (WP10b, built from the candidate SHA of 11.7: WP5b head merged with WP6 head, no setting to flip), in separate worktrees (the coordinator makes them, 11.1 B1), one port per arm, never 4649.
2. `./scripts/meeting-v2/setup-scratch.sh <ids>` (`MB:31`); transcribe once; take a `.backup` copy; start every run from it. The `text` column of the X and Y dumps hashes equal before comparing: `jq -S '[.segments[].text]' <dump> | shasum` (command new; it fits the `dump-speakers.mjs` format, `scripts/meeting-v2/dump-speakers.mjs:7-8,32-39`). `MV2:485` records the transcript was the same in all runs and gives no command. `textHash` is a second check (`MB:98`); it hashes ordered segment rows, not text only (`scripts/meeting-v2/metrics.mjs:142-150`).
3. 3 runs per arm per meeting, 6 on the #163 meeting (a choice of this spec). oMLX with MTP is not deterministic at temperature 0 (`OM:145`; https://github.com/jundot/omlx/issues/4089, https://github.com/jundot/omlx/issues/4214). That the app uses the MTP model `Qwen3.8-27B-oQ4e-mtp` (`OM:133`) is UNVERIFIED.
4. After each run: `node scripts/meeting-v2/dump-speakers.mjs <db> <meetingId> <out.json>` and numbers to `metrics-enhance.json`. Arm Y adds record counts: calls by finish reason, retries, typed failures, dropped suggestions by reason, tokens (the old path stores none). Dumps hold private text: never print or commit them.
5. `pnpm meeting:compare-speakers --x <X dump> --y <Y dump> --x-name <A> --y-name <B> --out <file.md>` re-reads both dumps and the output, deletes the output and exits 1 on any mismatch (`scripts/meeting-v2/compare-speakers.mts:9-13`). Read only its files.
6. Approval. The owner stated on 2026-10-17 that the benchmark meetings are safe for the cloud judges in this development. So pi (on the current pin `openai-codex/gpt-6.1-sol`) and Codex may read the compare files of the three meetings above with no per-data-set question. The statement covers these three only; any other meeting needs a new question (`CS:27` is the old rule; WP10b updates the council skill, D12, `CS:26` and `.claude/skills/pi-briefs/SKILL.md:8`). WP10b runs `pi_list_agents` with `doctor` first and records the pin. Then `bash scripts/council.sh prepare <round> <compare-file>...`; Claude writes its verdict first, pi from `brief-pi.md`, then Codex; `bash scripts/council.sh collect <round>` prints `CONSENSUS: yes` or `no` (exit 0 all SHIP, 2 disagreement, 3 missing file: `CS:15-33`, `scripts/council.sh:24-27`). Judge files start with `VERDICT: <SHIP, FIX-FIRST or REVERT> BETTER=<n> WORSE=<n> SAME=<n>`.
7. The coordinator records the round in this spec (WP10b): round, candidate SHA, compare files, verdict lines, decision and tracing waiver. Tracing variables stay unset for real meetings (B12), which breaks the rule that every LLM run is traced and read back (`CM`). Rounds r9, r9b, r9c had a waiver (`MV2:483-486`, 10.13). The waiver is one owner decision for all rounds of #185 on the three named meetings; it is the default of Q18 (12.2): yes, one waiver. The owner approves it with the spec at S0 and may change it in the Q18 row before the spec PR merges. WP10b asks nothing at run time. A round repeats after every FIX-FIRST (11.7 step 7); the one answer covers each repeat. If the Q18 row names another choice (trace to the owner's MLflow, with his approval of the privacy trade-off), WP10b follows it (WP10b step 0). No agent waives it alone.

**Metrics** (numbers only, `MB:12-19`; gates decided 2026-10-17 (owner viewpoint) are start values; the council may tighten them after a regression). Metrics pass first; the council judges the text (`CS:38`). Report a disagreement with the diverging regions; do not re-run until it agrees (`CS:39`). The route-switch merge (12.3) needs consensus.

| Metric | Gate |
|---|---|
| Failed chunks, untyped failures | #163 meeting: 0 failed chunks in 6 of 6 runs (G3). Untyped failures: 0 on every meeting. |
| Corrections applied (`enhanced_text` count) | Not lower than arm X, without a written reason. |
| Speaker suggestions kept | Not lower than arm X; a label X names in 3 of 3 runs, Y names in 3 of 3 (r9c table, `MV2:486`). |
| Hallucinated suggestions kept (kept quote not a substring of a segment text) | 0. Report a count only. |
| Calls, tokens, seconds | No gate. Y adds one speaker call plus retry and length-route calls; the owner judges the cost. |
| Summary (automatic checks only) | Five fields (overview, key points, decisions, action items, open questions: 4.5.1). `scripts/meeting-v2/check-summary.mts` (owner WP10a; command and output in 4.5.6) implements the five checks and the Markdown-based counts for the old arm. `run-enhance.mjs --summarize` calls it after each run and adds `summarySections`, `summaryKeyPoints`, `summaryDecisions`, `summaryActionItems`, `summaryOpenQuestions`, `summaryChars`, `summaryRenderMatches` to `metrics-enhance.json`. It prints no text. Gate on the new arm: `pass` true on every data set; key points, decisions and action items not below arm X without a written reason (the old arm has no open-questions section, so no gate there). No owner side-by-side read (decided 10.19). The script is in no commit at `c47cd80d`: UNVERIFIED until WP10a. |

WP10a's `check-enhance-metrics.mjs` makes the numbers no other tool makes: `hallucinatedKept`, `untypedFailures` and `namedRuns` per label. The WP10a card says it re-reads its output and exits 1 on a mismatch, as `compare-speakers.mts` does (11.5; `MB`, "Compare tools must check themselves"); whether it also re-reads the dumps is WP10a's decision. The script is in no commit at `c47cd80d`: UNVERIFIED until WP10a.

### 10.16 Evidence, who runs what, cleanup

**Evidence counts:** the exact command and its real output; a screenshot Claude looked at; a count read back from the real database or MLflow. The coordinator pastes it into the PR (11.1 B1). **Does not count:** green unit tests; a type check; a scripted model where the row asks for the owner's oMLX; an HTTP 200 with no read-back; a screenshot nobody opened; a pass with no output. A step the agent could not run is reported, and the PR marks it UNVERIFIED (a convention of this spec; the duty to say plainly what was not run comes from the discipline rules that the `disciplined-agent` plugin injects, which `CM:7` names; `CM:7` itself does not state it). **Who runs what:** Claude runs a proof first; the procedure then goes into a project skill and a script; later runs go to a pi child whose brief names the skill files to read first and, for app, server or E2E runs, the line "Read `.claude/skills/live-testing/SKILL.md` first and follow it" (`LT:225`). Stop pi after 2 failed rounds and finish with a Claude agent (`CM`, "Distill repeatable work for pi"). Haiku agents take mechanical checks (11.6). The coordinator reads every screenshot and re-runs the key commands. **Cleanup:** kill only your PIDs, delete the scratch folder and each throwaway `zz-proof-*` spec, then `git status --short` shows only the card's files (`LT:184-190,210`).

### 10.17 Definition of done for each work package

A WP is done when its section 11 card passes and each applicable row below has its evidence. The card holds the commands.

| WP | Levels | Real-system evidence in the PR | Added by this section |
|---|---|---|---|
| WP-R Remix removal | 1, 4 | RM1 to RM10 (10.14.1) with output; build and guard pass; remaining E2E specs pass through the Test Runner | RM5 on a `.backup` copy; TCC count equal before and after; bundle sizes reported |
| WP1 SDK v7 | 1, 2, 4, bundle | Two lock greps; wire-body snapshot, no diff; a real dictation run (acceptance 5); BC1 to BC6 | BC3 red proof. Negative control: it fails when `packages/stt` keeps `ai` 6.0.191 (6.9.4) |
| WP2 Call record | 1, 3 | Acceptance 1 to 6: real v39 file migrates, route answers, cascade empties the tables, older build opens the v40 file, a `running` run becomes `interrupted`, recorder and hash tests pass; `summary_json` column exists; runs and calls carry `scope` and `scope_id` | `.backup` copy run (10.9 check 1); six-table query after a real delete; 10.9 checks 5 to 10 |
| WP3 Gateway | 1, 2, 5 | Live checks 2, 3, 9 of 5.9; ledger equals wire | Matrix 10.5.1 ("One gateway call" column; "Req" is WP5a), wire tests 10.5.2 (with W15), W14, red proof per typed error, probes LP1, LP4, LP6, `maxRetries` check, Check B of 11.4, the layer rule; no served-id proof for cloud (10.19); `meeting-fixture.ts` (rule 1) |
| WP4 Saver | 1, 3, 4 | Suite output with five groups plus delta tests; S1 to S5 and S7 (S6 dropped, S8 not planned); spike SP1 to SP5 with output (11.5 WP4) | Node 22 run; skip decision. The kill test (10.11.3) belongs to WP9 and closes G6 |
| WP5a Graph and nodes | 1, 3, 5 | Seven `workflow-*.test.ts` files (`graph`, `requests`, `prepare`, `correct`, `identify`, `verify`, `save`; owner table, 10.8); live 6-chunk run; wire capture | GR1, GR2, GR3, GR5, GR7, GR14, GR16, GR18, GR19, GR20 (a), GR21 (a), GR23, LR1 to LR8; "Req" rows of 10.5.1; all 10.6 rows except `summarize`; LP2, LP3, LP7; #163 replay; 3.7 U6 (with GR3), U7, U10, U11 settled in the PR |
| WP5b Runner and renderer switch | 1, 3, 4, 5 | `workflow-runner`, `-resume`, `-chain` tests; kill and resume by API (11.5 WP5b acceptance 3); seeded failed and interrupted runs show notices and Resume in the real app (acceptance 12); council `CONSENSUS: yes` before this PR merges (10.15); candidate-only checks rerun after the rebase (11.7 step 8) | GR4, GR24, GR8, GR9, GR10 (a, b), GR11, GR12, GR13, GR15, GR17, GR21 (b); LP5; 3.7 U2, U3, U4, U8 settled in the PR |
| WP6 Summarize | 1, 5 | Acceptance: single call and map/reduce live; `summary_json` read back and equal to the rendered Markdown | Token reconcile and priced-model cost tests (10.6); map/reduce run with a lowered budget; two reduce levels with two keys; GR10 (c), GR20 (b), GR22, LR9 to LR11 |
| WP7 Inspector UI | 1, 4 | Acceptance 1 to 5 with screenshots | Spec B (10.11.2) in CI; panel equals logged body; inspector key-set test; imported meeting shows the same prompts; no flag row in Settings |
| WP8 Tracing | 1, 5 | Acceptance 1 and 2 | 9.9 C1 to C10 and typed-error runs (10.13); the coordinator reads back |
| WP9 E2E | 4, 5 | Acceptance 1 to 5 | Spec A (11 chunks, four run-wide meetings), kill tests, delete test, five local repeats, CI step time, packaged start BC8 |
| WP10a Harness | 6 | Baseline numbers, 3 runs of the old path | `text` hash check of both arms; no text printed (a Haiku reader lists every `console.log` and `writeFileSync`, acceptance 3) |
| WP10b Council | 6, 7 | `CONSENSUS: yes`, exit 0 | Metrics table of 10.15; round record in this spec |
| WP11 Close-out | 1, 5 | Acceptance 1 to 6: `WIP_LIMIT=2`, leftover grep prints nothing, one live chained Enhance and one live Summarize | Harness run on the final build within the WP10a spread; bundle and asar growth of the whole build reported. No flag to remove; WP5b already deleted the old path |

Process check: `grep -n WIP_LIMIT scripts/branch-status.sh` prints `WIP_LIMIT=` followed by the value: the script holds `WIP_LIMIT=2` at `scripts/branch-status.sh:21`, and the grep also matches line 48 (the test line), so it prints two lines at `c47cd80d`. The plan sets the value to 4 while the build runs (4 open PRs) and back to 2 after the last WP merges (decided 10.19). One release ships all WPs together; no WP has its own release.

### 10.18 Open points

Name conflicts between sections are in 11.4. Other checks for sections 3 to 9 are in 3.7. None blocks the build. Q18 (12.2), the tracing waiver of the council rounds, has a default (yes, one waiver) that applies unless the owner changes it at S0. The owner answered every other earlier question on 2026-10-17 (10.19). UNVERIFIED items are marked in place: cloud rows (no live proof), BC7 and BC8 on this Mac (if they fail, the asar size comes from a CI artifact), the foreign key wrapper of 10.7 (a run settles it; the 7.9 fallback changes the DDL), the E2E step time (WP9 measures it), and the handling of stored Remix settings (RM5).

### 10.19 Decisions applied in this section (2026-10-17)

| Decision | Effect on the tests |
|---|---|
| No feature flag; direct replacement (Q1 C). Q11-flag and Q14 are moot. | No test sets or reads a flag. Route tests use the 202 contract only. The council reaches consensus before the route-switch merge (10.15). |
| Enhance chains into Summarize (Q2 B). | GR24, chain check of 10.11.1. The stale warning stays. |
| The inspector shows prompts for imported meetings (Q3 A). | 10.11.2 item 6. |
| 4 open PRs during the build (Q4). | Process check after 10.17. |
| No cloud live proof (Q5). Local oMLX only. | 10.12; cloud rows stay UNVERIFIED. |
| No fixed bundle limit (Q6). | BC6 and RM9 measure and report. |
| Meeting `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6` reproduces #163 (Q7, VERIFIED). | 10.15 data sets. |
| One release for everything (Q8). | Note after 10.17. |
| `callUnit` is the single retry layer; `maxRetries` 0; no `RetryPolicy` (Q9). | Rule 2, GR7. |
| pi and Codex may read the three benchmark meetings (Q10). D12 changes to match. | 10.15 step 6. |
| The summary schema has fields; automatic checks only (Q11). | 10.15 metrics row; 10.6. |
| `meeting_summaries.summary_json` in migration 40 (Q12 B). | 10.6 `save`; 10.9 checks 1 and 10. |
| A confirmed name or new `enhanced_text` fails a Summarize resume with `transcript_changed` (Q13 A). | GR11. |
| One `HEAD` probe, no key, no meeting data, before a cloud resume (Q15 A). | GR12, W15. |
| Generic LLM platform in `LL`; `scope` and `scope_id` on runs and calls (Q16). | Layer rule (GR2); 10.9 check 7; saver wrapper (10.7). |
| Remove Remix now, as WP-R, before WP1. | 10.14.1; 10.5.5; W2b. |

---

## 11. Work breakdown and build orchestration

One work package (WP) has one branch, one draft PR and one implementer. Design is in sections 3 to 9; D1 to D12 are in 1.1; owner decisions of round 2 are in 11.8.

**Path key.** `S` = `apps/server/src`. `E` = `apps/electron/src`. `V` = `packages/validations/src`. `L` = `S/lib/llm` (generic platform; no import of `S/lib/meetings`). `LW` = `S/lib/llm/workflow` (generic saver, env guard, run registry). `M` = `S/lib/meetings`. `W` = `S/lib/meetings/workflow` (first consumer, 3.1). `SK` = `.claude/skills`. `UI` = `E/renderer/src/pages/meetings`. `build.yml` = `.github/workflows/build.yml`. No prefix = repo root.

### 11.1 Build rules

- **B1** Only the coordinator creates, pushes and merges branches (`SK/branch-lifecycle/SKILL.md:15`). The skill limits only these three actions to the coordinator. Creating issues, worktrees and draft PRs is also the coordinator's job; this is a rule of this spec (D11), not of the skill (`:12,16`). Checked at HEAD `078a358c`; the two commits after `c47cd80d` change only spec files.
- **B2** One WP = one branch `type/short-topic` and one draft PR born with the branch (`SK/branch-lifecycle/SKILL.md:12,14`). A WP in a parallel lane also gets a worktree; the skill allows worktrees only for parallel lanes (`:16`).
- **B3** PR body: Goal, Spec, Owner, Done when (`SK/branch-lifecycle/SKILL.md:12`), and `Refs #185` (allowed for partial work, same line). `AGENTS.md:97`: each branch links its issue; Project 1 tracks work. One child issue per WP is a rule of this spec.
- **B4** Worktree: `git worktree add -b <branch> ../openstyle-<topic> origin/main`; remove on merge.
- **B5** Cut a branch only after all hard dependencies merge (rule of this spec; solid arrows in 11.3). A PR idle 2 days is finished or closed (`SK/branch-lifecycle/SKILL.md:20`). The WP5b PR waits for the council (B16); its CI passes before that, because tests that need the real `summarize` body skip while `SUMMARIZE_IS_STUB` is true. The coordinator posts round status on it daily. UNVERIFIED: whether a comment resets the idle clock; if not, the coordinator pushes a status commit.
- **B6** The owner allows 4 open PRs during the build (11.8 row 4). At HEAD `078a358c`, `scripts/branch-status.sh:21` sets `WIP_LIMIT=2`, and `SK/branch-lifecycle/SKILL.md:3,13` give 2. WP0 changes all three to 4 (a plan). The script flags more open PRs than the limit (`scripts/branch-status.sh:48`). WP11 sets 2 again. Peak: WP6, WP5b, candidate PR (B18), WP10b docs PR. A fifth PR waits.
- **B7** Ready = gates + own acceptance pass (defined here; the skill does not define it). Then `gh pr ready` and `gh pr merge --squash --auto` (`SK/branch-lifecycle/SKILL.md:19`).
- **B8** Every `gh` call uses `GH_TOKEN="$(gh auth token -u Maheidem)"` (`AGENTS.md:99`).
- **B9** A new file or dependency is imported in the same PR, or knip fails (`AGENTS.md:85`; `build.yml:91-100`). A file that loses its last importer is deleted in the same PR. **Test imports count (MEASURED 2026-10-17, knip 6.23.0, `knip.jsonc` at `c47cd80d`, scratch copy, nothing committed).** `pnpm run knip` exited 0 when a new module under `S/lib/llm/` or `S/lib/llm/workflow/` had only a test in `apps/server/tests/` as importer (entry `tests/**/*.test.ts`, `knip.jsonc:85,100`), when a new `UI/` module had only a beside `*.test.ts` (`apps/electron/vitest.config.ts:15-19`; `knip.jsonc` has no entry for these, reason UNVERIFIED, result is the evidence), and when a `tests/helpers/` file had one test importer. Controls failed as expected (`Unused files`, exit 1). So WP2 to WP5a files (`L/recorder.ts`, `M/input-hash.ts`, `L/gateway.ts`, `L/model-profiles.ts`, `LW/checkpoint-saver.ts`, `W/graph.ts`, `W/nodes/*.ts`, `L/call-unit.ts`) pass GT2 when a test of the same PR imports them, directly or through a file a test imports. No WP edits `knip.jsonc` for this. A source file with no test and no importer still fails. The reviewer (11.6) runs GT2 on each PR.
- **B10** Only the coordinator edits `pnpm-lock.yaml`; after each rebase run `pnpm install` and read the diff. No repo doc states this. [pnpm](https://pnpm.io/git) says to run `pnpm install` after a lockfile conflict and review the result; it does not mention rebase or ownership.
- **B11** Unit tests never close a WP; each card names the real run (section 10).
- **B12** Only WP10a and WP10b read real meetings (proof P4). Report counts, durations, hashes and ids only, never transcript text (`SK/meeting-benchmarks/SKILL.md:15`). Use no cloud model on the meetings (`:16`). The pi and Codex judges may read compare files of the benchmark meetings with no per-data-set approval, in this development only (11.8 row 10). Leave `OPENSTYLE_LOG_DIR` unset (`SK/meeting-benchmarks/SKILL.md:19`) and the WP8 MLflow variables unset (D8). That breaks the always-trace rule of `CM`, so WP10b applies the Q18 tracing waiver (12.2; default yes, one waiver, stands unless the owner changed it before the spec PR merged). No agent waives alone.
- **B13** Local app runs, E2E and UI proofs use quiet mode via `scripts/test-runner/run.sh` (`SK/live-testing/SKILL.md:20,202`).
- **B14** After each oMLX run, `timeout 8 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/v1/models` prints `200`. Send only Qwen3-ASR and Qwen3.8-27B requests: this is a standing rule of the skill (`SK/live-testing/SKILL.md:229`), and the same line asks for the `200` check after any test. No cloud live proof (11.8 row 5).
- **B15** WP-R lands before WP1. WP1 lands before any gateway, node, record or inspector code (M1, 6.1). WP2 may start early and merges after WP1.
- **B16** No feature flag; one path (11.8 row 1). WP5b switches routes and renderer and deletes the old path. The council must print `CONSENSUS: yes` before the WP5b merge (D12). The coordinator holds WP5b and WP6 as ready drafts, builds the candidate and runs the rounds (11.7). After consensus: merge WP6, rebase WP5b on `main`, re-run its full acceptance, merge WP5b. A release cut between merges ships what has merged.
- **B17** Everything ships in one release (11.8 row 8). The owner starts it after WP11.
- **B18** Candidate branch. The council needs WP5b and WP6 together and neither is merged, so the coordinator makes `chore/enhance-candidate` from the two heads, with worktree and draft PR "Candidate, never merged" (`Refs #185`; B2 to B4). It counts as one open PR (B6). Nobody merges it. Procedure: 11.7.

**Gates** (repo root; all must pass).

| Gate | Command | Pass |
|---|---|---|
| GT1 | `pnpm biome check .` | exit 0 (`AGENTS.md:69`) |
| GT2 | `pnpm run knip` | exit 0 (`AGENTS.md:71`) |
| GT3 | `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck:web && pnpm --filter @openstyle/electron typecheck:tests && pnpm --filter @openstyle/server typecheck:tests` | exit 0 (`build.yml:112-125`; `AGENTS.md:72` omits server `typecheck:tests`, `build.yml:123-125`) |
| GT4 | `NODE_OPTIONS=--expose-gc pnpm --filter @openstyle/server test`, then `pnpm --filter @openstyle/stt test`, `pnpm --filter @openstyle/validations test`, `pnpm --filter @openstyle/electron test` | each exit 0; CI sets `--expose-gc` for the server step only (`build.yml:137-150`) |
| GT5 | `cd apps/electron && pnpm run build && node scripts/check-bundled-requires.mjs` | last line `ok:` (`check-bundled-requires.mjs:71-72`); when a WP changes dependencies or bundle |
| GT6 | `gh pr checks <n>` | `CI Status` passes; it fails only when a needed job failed or was cancelled; skipped counts as pass (`build.yml:534-551`) |

One test file: `pnpm --filter @openstyle/server test tests/<file>.test.ts` (never add `--`, `AGENTS.md:81`).

**Proof types.** P1 command. P2 live LLM (Qwen3.8-27B on the owner's oMLX, fictional text). P3 screen (real app via test runner, fictional meeting). P4 real meetings, numbers only. P5 trace read back from MLflow.

**Size rule.** No fixed bundle limit (11.8 row 6). Each PR that adds or removes a dependency or large module reports `du -sk apps/electron/out` before and after, and `app.asar` at release (target about 9 MiB, `AGENTS.md:87`). The owner decides if a number is too large.

### 11.2 Work packages at a glance

| WP | Title | Spec | Hard deps | Branch |
|---|---|---|---|---|
| WP0 | WIP limit 4 | B6 | none | `chore/wip-limit-4` |
| WP-R | Remove Remix | `specs/remix-removal-inventory.md` | none | `chore/remove-remix` |
| WP1 | AI SDK v7, no behavior change | 6 | WP-R | `chore/ai-sdk-v7` |
| WP2 | Migration 40, scope-generic recorder, read routes | 7, 8.3, 8.4 | WP-R (merges after WP1, M1) | `feat/llm-record` |
| WP3 | Gateway, model profiles, typed errors | 5 | WP1, WP2 | `feat/llm-gateway` |
| WP4 | `node:sqlite` checkpoint saver | 3, 7.9 | WP2 | `feat/llm-sqlite-saver` |
| WP5a | Graph, `callUnit`, six node slots, nodes except `summarize` body | 3, 4 | WP2, WP3, WP4 | `feat/enhance-workflow` |
| WP6 | `summarize` node | 4.5 | WP5a (WP10a merges first) | `feat/enhance-summary-node` |
| WP5b | Runner, routes + renderer switch, chain, resume, boot sweep, old path deleted | 3.4 to 3.6, 8.5, 8.9, 8.10 | WP4, WP5a; candidate-only tests need WP6; council before merge | `feat/enhance-runner` |
| WP7 | Inspector UI (advanced mode) | 8.1 to 8.8, 8.12 | WP2, WP5b | `feat/llm-inspector-ui` |
| WP8 | Tracing, opt-in | 9 | WP1, WP3, WP5b | `feat/llm-tracing` |
| WP9 | Committed E2E specs, whole-feature proofs | 10 | WP5b, WP7 | `test/enhance-e2e` |
| WP10a | Benchmark harness, old-path baseline | 10, 12 | WP-R | `chore/enhance-benchmark-harness` |
| WP10b | After-run, compare files, council | 10, 12 | WP10a; candidate build; merges after WP5b | `docs/enhance-council-record` |
| WP11 | Close-out: limit 2, docs | 12 | WP7, WP8, WP9, WP10b | `chore/enhance-closeout` |

Spec PR #186 merges before any WP branch is cut. WP-R is a hard dependency of WP1, WP2 (edits `S/routes/index.ts`, `S/index.ts`, `AGENTS.md` after it; migration 40 drops Remix tables that `remix-store.ts` reads until WP-R merges) and WP10a (edits `knip.jsonc` after it). Only WP0 shares wave 1 with WP-R. "WP5" elsewhere = WP5a + WP5b. No WP5c and no old WP11 exist: there is no flag. WP6 precedes WP5b because Enhance chains into Summarize (11.8 row 2) and the council judges both.

### 11.3 Dependency graph and waves

```mermaid
flowchart TD
  SPEC["Spec PR 186"] --> WP0
  SPEC --> WPR["WP-R Remix"]
  WPR --> WP1
  WPR --> WP2
  WPR --> WP10a
  WP1 -.->|merge order M1| WP2
  WP1 --> WP3
  WP2 --> WP3
  WP2 --> WP4
  WP2 --> WP5a
  WP3 --> WP5a
  WP4 --> WP5a
  WP5a --> WP6
  WP10a --> WP6
  WP6 -.->|ready draft too| WP5b["WP5b branch ready"]
  WP4 --> WP5b
  WP5a --> WP5b
  WP6 -.->|merged into| CAND["candidate branch, never merged"]
  WP5b -.->|merged into| CAND
  CAND -.->|council round| WP10b
  WP10a --> WP10b
  WP10b -->|consensus gate| WP6M["WP6 merge"]
  WP6M --> WP5bM["WP5b merge"]
  WP5b --> WP5bM
  WP5bM --> WP10bM["WP10b merge"]
  WP5bM --> WP7
  WP2 --> WP7
  WP5bM --> WP8
  WP1 --> WP8
  WP3 --> WP8
  WP5bM --> WP9
  WP7 --> WP9
  WP7 --> WP11
  WP8 --> WP11
  WP9 --> WP11
  WP0 --> WP11
  WP10b --> WP10bM
  WP10bM -->|cut WP11 only after| WP11
```

Solid = hard dependency (cut after the merge). Dashed = soft (merge order or test build). "Consensus gate" is a merge gate, not a branch cut: WP5b exists and is green during the council. The WP10b branch is cut when the candidate exists and merges after WP5b. WP11 is cut after that merge, because both edit `SK/council/SKILL.md` and `SK/meeting-benchmarks/SKILL.md`. WP4 is a hard dependency of WP5a: WP5a imports `@langchain/langgraph` (added by WP4) and its graph tests use the WP4 saver (10.8).

Waves: 1 WP0, WP-R; 2 WP1, WP2, WP10a; 3 WP3, WP4; 4 WP5a; 5 WP6 (ready draft); 6 WP5b (ready draft), candidate, council round; 7 WP6 merge, WP5b rebase and merge, WP10b merge, then WP7, WP8; 8 WP9; 9 WP11, then the one release. Cap: 4 open PRs, candidate included.

### 11.4 File ownership and conflict matrix

One WP writes a file at a time; several writers go in the listed order. New files have one owner (register below). WP-R owns every Remix file.

| File | WPs in order |
|---|---|
| `pnpm-lock.yaml` | R, 1, 4, 8 |
| `apps/server/package.json` | 4, 8 |
| `apps/electron/package.json` | R (removes `@ai-sdk/react`, `ai`, `motion`, `remark-gfm`), 1 |
| `pnpm-workspace.yaml`, `check-bundled-requires.mjs` | 1; then 4 for the `vitest` catalog line only (`pnpm-workspace.yaml:24`), only if the vitest fallback of the WP4 card applies (`specs/meeting-enhance-agentic.md:407,3528`) |
| `packages/stt/**` | 1; 3 for `src/text.ts`, `src/index.ts` only (`THINK_TAG`, 5.3.3) |
| `L/registry.ts` | R (one comment), 1, 3 (`LlmTaskContext` callback, `gatewayOverrides`) |
| `L/lane.ts` | R (deletes `releaseLeaseOnResponseBodyEnd`), 1, 3 (`signal` in `Pick`) |
| `L/task-profiles.ts` | R (deletes `remix`), 3 (`pin`, `droppedKeys`, `source`, scoped denylist) |
| `L/gateway.ts` | 3, 8 |
| `V/llm-task-profiles.ts` | R (removes `remix` task id), 3 |
| `S/lib/schema.ts`, the two tests pinning 39 (`tests/schema-meetings.test.ts:7`, `tests/migration-servers.test.ts:91`), `tests/v20-merge-reconciliation.test.ts` (its Remix-table asserts, `:107-109,141`) | 2 |
| `L/call-record.ts` (base types, 5.1 rule B), `L/recorder.ts`, `L/record-read.ts`, `M/llm-record.ts`, `M/llm-record-read.ts`, `M/input-hash.ts` | 2 (`recorder.ts`: then 5b) |
| `S/routes/index.ts` | R (removes Remix route), 2 |
| `S/routes/meetings-runs.ts` (8.3, 3.4.2) | 2, 5b |
| `V/llm-types.ts` (`LlmScope`, `LlmMessage`, `LlmParamsLedger`, 8.4 types), `V/meeting-types.ts` (WP2: `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason`; WP5b: `StartRunResponse`, resume types) | 2, 5b |
| `S/index.ts` | R (two timeout entries), 2, 5b, 8 |
| `S/lib/trusted-origin.ts`, `S/lib/history-store.ts`, `S/lib/trace.ts`, `S/routes/settings.ts`, `V/index.ts`, `V/settings-keys.ts`, `packages/utils/src/logger.ts`, `E/renderer/src/pages/settings.tsx` | R |
| `LW/checkpoint-saver.ts` | 4 |
| `L/call-unit.ts`, `LW/env-guard.ts`, `LW/run-context-registry.ts`, `W/load-graph.ts`, `W/graph.ts`, `state.ts`, `types.ts`, `context.ts`, `W/chunking.ts`, `W/nodes/*`, `S/lib/meetings/transcript-io.ts`, `tests/helpers/workflow-harness.ts` (WP5b, WP6 import, not edit) | 5a |
| `W/unit.ts` (`guardNode`) | 5a, 8 (one edit: `guardNode` calls `inNode`, 9.10) |
| `W/summary-pure.ts` (4.5.3, 4.5.6) | 5a (full bodies), 6 (only if its 4.5.3 plan tests show a `plannedSummaryCalls` defect; the PR names the line) |
| `W/nodes/summarize.ts` (stub exports `SUMMARIZE_IS_STUB = true`) | 5a, 6 (sets `false`) |
| `W/schemas.ts`, `tests/helpers/meeting-fixture.ts`, `helpers/fake-model.ts` | 3 |
| `W/prompts.ts` | 5a (`correctChunk`, `identifySpeakers`), 6 (`summarize`) |
| `W/runner.ts` (also `getMeetingEnhanceAutoRunSetting`, moved from `enhance.ts:51`) | 5b, 8 |
| `LW/run-registry.ts`, `M/job-registry.ts`, `tests/workflow-runner.test.ts` | 5b |
| `M/enhance.ts`, `summarize.ts`, `llm-call.ts` | 5a (import lines of moved helpers only), 5b (delete) |
| `M/enhance-prompt.ts`, `summary-prompt.ts` | 5b (delete) |
| `tests/{meeting-enhance,meeting-summarize,meeting-llm-timeouts,llm-task-profiles,meetings-calendar}.test.ts` | 5b (each `it(` rewritten or deleted with successor or reason, 10.2 rule 7). WP-R edits `llm-task-profiles.test.ts` and `meeting-llm-timeouts.test.ts` for the Remix task id first. WP3 puts W2b, W14 in new files |
| `tests/meetings-routes.test.ts` (imports `enhance.js`, `:29, :3122`), `helpers/meetings-db.ts` | 2, 5b |
| `S/routes/meetings.ts` | 5a (move three functions), 5b |
| `UI/detail.tsx` | 5b (202 and polling; notices, Resume, Start again; success note; removes old failure state, 502 branch, old notice, `job_error` use, 8.9), 7 (inspector entry points, panel mount) |
| `UI/speakers.tsx` | R, 7 |
| `E/renderer/src/lib/query.ts` | R, 5b (`llmRunsLatest`, `resumeRun`, invalidation), 7 (`llmRuns`, `llmCalls`) |
| `E/renderer/src/locales/*.json`, `locales.test.ts` | R (139 Remix keys in each of 8 files), 5b (`meetings.llmRun.*`, `meetings.llmError.*` join group `enhance-honesty`; removes `enhanceFailedTimeout`, `enhanceFailedParse`, `enhanceFailedProvider`), 7 (`meetings.inspector.*`, key-set test) |
| `apps/electron/tsconfig.tests.json`, `apps/electron/tests/meeting-enhance-workflow.test.ts`, `meeting-llm-inspector.test.ts` | 9 (tsconfig `include` gets the fixture builder, 10.2 rule 1) |
| `E/server-host/entry.ts` | 8 |
| `AGENTS.md` | R (7 places), 2 (`AGENTS.md:50`, the Persistence paragraph: `SCHEMA_VERSION = 39` and the table list; `S/lib/schema.ts:14`), 8 (`AGENTS.md:9` "no telemetry", 9.5.1 item 5), 11 (pipeline paragraph) |
| `knip.jsonc` | R (`remix-bar.tsx` entry), 10a |
| `SK/meeting-benchmarks/SKILL.md`, `SK/council/SKILL.md` | 10a, 10b (dated #185 exception line), 11 (removes it) |
| `scripts/meeting-v2/run-enhance.mjs`, `check-enhance-metrics.mjs` | 10a, 10b |
| `scripts/meeting-v2/check-summary.mts`, root `package.json` (`meeting:check-summary`) | 10a |
| `SK/pi-briefs/SKILL.md`, `specs/meeting-enhance-agentic.md` | 10b. `specs/remix-removal-inventory.md` belongs to spec PR #186; no WP edits it |
| `SK/live-testing/SKILL.md` | R (line 156, names the remix bar window `bar.html`), 9 |
| `SK/site-captures/SKILL.md`, `README.md`, `site/index.html`, `specs/remix.md`, `electron.vite.config.ts`, `scripts/site-captures/capture.mjs` | R |
| `scripts/branch-status.sh`, `SK/branch-lifecycle/SKILL.md` | 0, 11 |

- The graph does not order the lockfile and `apps/server/package.json` (WP3, WP4 parallel); B10 and 11.7 settle that.
- WP8 edits only `W/unit.ts`, `W/runner.ts` (`startRunSpan`, `endRunSpan`) of `LW/` and `W/`; no node file (9.10), no settings file (T1).
- **Check B** (5.1 rule B), run by the reviewer on the WP2 PR and again on WP3, WP5a, WP5b: `git grep -n -E "^export (type|interface) (LlmStepId|ChatTurn|TokenUsage|UnifiedFinishReason|StructuredMode|GatewayErrorKind|SpeakerVerdict|DropReason|EvidenceType|VerdictStatus|CorrectionDropReason|LlmMessage|LlmParamsLedger|LlmScope)( |<|=)" -- apps packages` prints 14 lines: `call-record.ts` (6), `meeting-types.ts` (5), `llm-types.ts` (3). A 15th line is a second declaration; the PR fails. UNVERIFIED: the files do not exist at `c47cd80d`.
- **Check P**, run on every PR that touches `L/`: `git grep -n -E "lib/meetings|meetings/workflow" -- apps/server/src/lib/llm` prints nothing. UNVERIFIED until the files exist.
- No WP edits `apps/server/tests/setup.ts` (fake timers, `:16`); a test needing real timers opts out in its own file (10.2 rule 4, R4). No WP edits `.lore.md` (lore tool owns it, `AGENTS.md:1-4`, `.lore.md:1`); its Remix entries stay (10.14.1 allow list item 5) and the coordinator reports their count after the WP-R merge.
- H1 (11.6) fails a diff that touches a file the card does not list.

**New files by WP (H1 register).** A `zz-proof-*` spec is never committed. Tests are in `apps/server/tests/` unless a path is given. Snapshots: `tests/__snapshots__/<test>.snap`.

| WP | New source files | New test and helper files |
|---|---|---|
| WP0, WP-R, WP10b, WP11 | none | none |
| WP1 | none | `ai-sdk-wire.test.ts` + snapshot (6.9.2, WB1 to WB14) |
| WP2 | `L/call-record.ts`, `L/recorder.ts`, `L/record-read.ts`, `M/llm-record.ts`, `M/llm-record-read.ts`, `M/input-hash.ts`, `S/routes/meetings-runs.ts`, `V/llm-types.ts` | `schema-llm.test.ts` (10.9 checks 1, 7, 10), `llm-record.test.ts` (checks 5, 8; scope `meeting` and `test`), `input-hash.test.ts` (check 6), `meetings-runs.test.ts` (checks 2, 4, 9) |
| WP3 | `L/gateway.ts`, `L/gateway-errors.ts`, `L/model-profiles.ts`, `W/schemas.ts` | `helpers/fake-model.ts`, `helpers/meeting-fixture.ts`, `gateway-matrix.test.ts` (10.5.1), `gateway-wire.test.ts` + snapshot (10.5.2, W1 to W13, W2b, W15), `model-profiles.test.ts` (10.5.3, W14), `node-schemas.test.ts` + snapshot (10.5.4) |
| WP4 | `LW/checkpoint-saver.ts` | `checkpoint-saver.test.ts` (S1 to S5, S7), `checkpoint-saver.conformance.test.ts` (validation suite, delta tests, FK wrapper with scope `test`), `langgraph-send-spike.test.ts` (3.7, SP1 to SP5) |
| WP5a | `L/call-unit.ts`, `LW/env-guard.ts`, `LW/run-context-registry.ts`, `W/summary-pure.ts`, `W/unit.ts`, `W/load-graph.ts`, `W/graph.ts`, `W/state.ts`, `W/types.ts`, `W/context.ts`, `W/prompts.ts`, `W/chunking.ts`, `W/nodes/*.ts`, `M/transcript-io.ts` | `helpers/workflow-harness.ts` (10.2 rule 9), `workflow-{graph,requests,prepare,correct,identify,verify,save}.test.ts` (owner table 10.8) |
| WP5b | `W/runner.ts`, `LW/run-registry.ts`, `UI/run-notice.ts` | `workflow-runner.test.ts`, `workflow-resume.test.ts`, `workflow-chain.test.ts`, `UI/run-notice.test.ts` |
| WP6 | none | `workflow-summarize.test.ts` |
| WP7 | `UI/llm-inspector.tsx`, `UI/llm-call-view.tsx`, `UI/llm-inspector-model.ts` | `UI/llm-inspector-model.test.ts` |
| WP8 | `L/tracing.ts` | `tracing.test.ts` |
| WP9 | none | `apps/electron/tests/meeting-enhance-workflow.test.ts`, `meeting-llm-inspector.test.ts` |
| WP10a | `scripts/meeting-v2/run-enhance.mjs`, `check-enhance-metrics.mjs`, `check-summary.mts` | none |

**Name conflicts between sections.** The owning WP may rename in its own PR and edits 11.4 in the same commit. This column decides.

| Item | Decision |
|---|---|
| Checkpoint saver (`W/`, `S/lib/meetings/llm-checkpointer.ts`, `srv/lib/llm/` in 3.1, 7.9) | `LW/checkpoint-saver.ts`; generic (11.8 row 15). 3.1, 7.9, 7.14 follow. |
| Retry layer, guard, loader, env guard (3.1, 5.6, old card text) | `L/call-unit.ts`: `callUnit`, `gatewayRetryOn`. `W/unit.ts`: `guardNode`. `LW/env-guard.ts`: `stripTracingEnv`. `W/load-graph.ts` calls it, loads the graph. Only `LW/` and `W/` import LangGraph (GR2, GR3). |
| Recorder SQL, reads, hash (3.1, 7.7, 7.14) | `L/recorder.ts` (only writer of `llm_*` rows; WP2, WP5b extends), `L/record-read.ts` (generic reader, 8.3), `L/call-record.ts` (types, `CallSink`). In `M/`: `llm-record.ts` (scope helper, link targets), `llm-record-read.ts` (stale-label queries, 7.8), `input-hash.ts` (4.1 P11). No `run-store.ts`. |
| Run and call scope (`meeting_id` only owner key, 7.4, 7.2 P2) | `llm_runs`, `llm_calls` carry `scope`, `scope_id`; links by (`target_type`, `target_id`); nullable `meeting_id` FK on `llm_runs` only keeps ON DELETE CASCADE (11.8 row 15). 7.4, 8.3 follow. |
| Inspector routes (`llm-runs.ts` in old card text) | `S/routes/meetings-runs.ts` calls `L/record-read.ts` with `scope = 'meeting'` (8.3). Cards use `$RUNS`, `$CALLS`. |
| Inspector UI (3.1 vs 8.11) | 8.11 files. `run-status.tsx` does not exist. |
| Error kinds | Kinds of 5.2.1. 7.6, 8.10 follow. |
| Deleted meeting outcome (`ended` 3.4.3 vs `meeting_deleted` 4.0.7, 4.6.3) | `meeting_deleted`. |
| Run status (`ok` vs `succeeded`) | `succeeded` for runs and steps; node status `ok` is stored as `succeeded` (3.4.3). |
| Speaker verdict (4.4 `DropReason` 10 codes vs 7.5 `SpeakerVerdictReason` 11 codes) | 4.4 shape: 10 drop codes, 3 evidence types (7.5, 8.10 follow). |
| Step key (4.0.7 `unitKey` vs 7.4 `step_key`) | `step_key` = `unitKey`, grammar of 4.0.7: `single`, `map:<i>`, `reduce:<level>:<group>`, `<key>/<n>` for halves. A step row holds the top key (7.4). `seq` = start order (7.7 rule 3). |
| Call record contract (`CallSink.begin/finish` string id vs `startAttempt`/`recordCall` number id) | `startAttempt`, `recordCall`, id `number \| null`; null = lost record (5.1, 7.7). |
| Base types (WP3 snippet vs WP2 need; `GatewayErrorKind` and `FailureKind` defined each other; `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason` no home) | Rule B (5.1): WP2 declares them. `L/call-record.ts`: `LlmStepId`, `ChatTurn`, `TokenUsage`, `UnifiedFinishReason`, `StructuredMode`, `GatewayErrorKind` (union of the 15 kinds of 7.6). `V/meeting-types.ts`: `SpeakerVerdict`, `DropReason`, `EvidenceType`, `VerdictStatus`, `CorrectionDropReason`. `V/llm-types.ts`: `LlmMessage`, `LlmParamsLedger`, `LlmScope` (`"meeting" \| "test"`). WP3, WP5a, WP5b import them. `FailureKind` extends `GatewayErrorKind`. Check B enforces it. |
| Retry layer (AI SDK `maxRetries`, node `RetryPolicy`, `callUnit`) | `callUnit` only, one retry per call, `gatewayRetryOn`; `maxRetries` 0; no `RetryPolicy` (11.8 row 9). 5.6 follows. |

### 11.5 Work package cards

Every card passes GT1 to GT4 and its new test files (`pnpm --filter @openstyle/server test tests/<files>` prints `Test Files  N passed (N)`), and runs B14 after any oMLX call. Design and test lists are in the spec sections each card names. `$S` = `/tmp/<task-name>` (`SK/live-testing/SKILL.md:92`; scratch rule `:17`). `$BASE` = `http://127.0.0.1:$PORT`. `$RUNS` / `$CALLS` = the 8.3 run list / call list route for `scope=meeting`. Isolated server: `SK/live-testing/SKILL.md:87-102`.

**WP0.** Edits `scripts/branch-status.sh:21` and the two limit statements in `SK/branch-lifecycle/SKILL.md` (`:3`, `:13`). Must not change any other rule.
Accept: `grep -n 'WIP_LIMIT=' scripts/branch-status.sh` prints `21:WIP_LIMIT=4`. `grep -n -E 'at most 4|WIP limit: 4' SK/branch-lifecycle/SKILL.md` prints two lines (wording UNVERIFIED). GT1. P1.

**WP-R. Remove Remix** (owner, 2026-10-17). Inventory `specs/remix-removal-inventory.md` (spec PR #186; read first) holds the delete list (15.1: 42 files), edit lists (15.2, 15.3: 94 files; STATIC counts, UNVERIFIED until the PR), keep list (12.1), kept server helpers (2.3), locale keys (7), dependencies (10), left-behind data (13) and D1 to D9 (16). One PR removes the Remix renderer, main-process, server, task-id, settings, onboarding/help, tutorial, locale (139 keys in each of 8 files), test, E2E, site (`site/index.html:492-495`), README, 7 `AGENTS.md` places and electron deps `@ai-sdk/react`, `ai`, `motion`, `remark-gfm`; `specs/remix.md` stays, status RETIRED 2026-10-17. Decided (owner viewpoint): D2 delete `components/agents/`; D3 onboarding draft-step label `onboarding.tutorial.finish` when Meeting Mode is off, "Continue" when the Enhance step follows; D4 remove `PROTECTED_READ_PREFIXES` in `S/lib/trusted-origin.ts`; D5 delete `releaseLeaseOnResponseBodyEnd`; D6 delete `macos-ax.swift`, `mac-ax.ts`, dead copy/paste helpers in `paste.ts`, `getFrontmostContext`. D1 (DROP of three `remix_*` tables and three settings rows) goes into WP2 migration 40 (11.8 row 21). Keep migration 20 (`S/lib/schema.ts:585-636`) and every inventory 12.1 item. Must not: edit `specs/meeting-enhance-agentic.md`, the inventory, `.lore.md`, `S/lib/schema.ts`, `v20-merge-reconciliation.test.ts`; add any feature.
Accept: (1) Grep `RMGREP` (10.14.1) over the tracked tree prints nothing; allow list: `apps/server/src/lib/schema.ts`, `apps/server/tests/v20-merge-reconciliation.test.ts`, `apps/server/tests/schema-llm.test.ts`, `CHANGELOG.md`, `.lore.md`, `specs/**`. `git grep -l -i -I remix -- specs` prints spec files only. The coordinator widens the list before the PR adds a file (UNVERIFIED until run; baseline lists 111 files). (2) `grep -c -i remix apps/electron/src/renderer/src/locales/*.json` prints `0` for 8 files. (3) `grep -E '"(@ai-sdk/react|ai|motion|remark-gfm)"' apps/electron/package.json` prints nothing. After `pnpm install`: `grep -c 'ai@6.0.240' pnpm-lock.yaml` prints `0`; `grep -E '^  ai@6' pnpm-lock.yaml` prints exactly `ai@6.0.191:` and `ai@6.0.191(zod@4.4.3):`. At `c47cd80d` (VERIFIED by run) it prints four lines: `pnpm-lock.yaml:2884` `ai@6.0.191:`, `:2890` `ai@6.0.240:`, `:7348` `ai@6.0.191(zod@4.4.3):`, `:7356` `ai@6.0.240(zod@4.4.3):`; the `ai@6.0.240` count is `2`. Only `@ai-sdk/react@3.0.242` needs 6.0.240 (`:5204-5207`). Importer lines of 6.0.191 stay: `:91-93` (electron, removed by WP-R), `:242-244` (server), `:315-317` (stt). New line numbers UNVERIFIED until install. (4) GT1 to GT6; no unused file; growth reported. (5) Real app via test runner (B13), fictional data: dictation starts, shows the pill, pastes; Models page has no Remix row (screenshot); `ls apps/electron/out/renderer/bar.html` fails; TCC count 0 (`SK/live-testing/SKILL.md:219`). (6) A stored `llm_task_assignments` value with a `remix` key loads without error; the next Models save drops it (inventory 3; `GET $BASE/api/settings`). (7) `head -12 specs/remix.md` shows RETIRED 2026-10-17. P1 P3.

**WP1. AI SDK v7** (6, 6.4; D7). Same request bodies and results for dictation and meetings. `check-bundled-requires.mjs` also scans `out/main/chunks` and fails on `commonjsRequire(` (today top-level files only, `:34`). Must not: anything in 6.10 (M3); `vitest -u` in CP2 (M7).
Accept: (1) `git grep -l -E "from \"(ai|@ai-sdk/[a-z-]+)\"|import\(\"(ai|@ai-sdk/[a-z-]+)\"\)|vi\.mock\(\"(ai|@ai-sdk[^\"]*)\"" -- apps packages scripts` = 16 paths (the 18 at `c47cd80d` minus `remix-chat.tsx`, `remix-agent.ts`, `remix-transform.ts`, plus the new `apps/server/tests/ai-sdk-wire.test.ts`; inventory 14.1, STATIC). (2) `grep -E '^  ai@[0-9]' pnpm-lock.yaml` = `ai@7.0.N:` and `ai@7.0.N(zod@4.4.3):`, same N (143 on 2026-10-17); `grep -E '^  ai@6' pnpm-lock.yaml` empty (start state: the two 6.0.191 lines, WP-R accept 3). (3) Wire test passes on v6 (CP1) and v7 (CP2); `git diff --stat <CP1>..<CP2> -- apps/server/tests/__snapshots__` empty; CP3 is PR evidence only (6.9.1). (4) GT5; `grep -o 'AI_NoObjectGeneratedError' apps/electron/out/main/server-process.js | wc -l` = 1; `grep -rc 'commonjsRequire(' apps/electron/out/main` = 0 per file; a planted `require(variable)` fails the guard (BC3, 10.14). (5) Real app, baseline vs branch (proofs A, B of 6.9.3): `diff <(jq -S . baseline.json) <(jq -S . package.json)` of `/api/post-process` empty, `inputTokens` 40, `outputTokens` 9; TCC `AUTHREQ_PROMPTING` 0 (`SK/live-testing/SKILL.md:219`). (6) Negative control (6.9.4): `ai` 6.0.191 in `packages/stt/package.json` alone must break proof A (UNVERIFIED until run); if A passes, WP1 does not merge. Report bundle and asar sizes. P1 (1-4), P3 (5-6).

**WP2. Persistence, scope-generic** (7, 8.3, 8.4; D10; 11.8 row 15). Migration 40: the six tables of 7.4; `llm_runs`, `llm_calls` carry `scope`, `scope_id` (recorder copies both from the run row; no WP3 input carries them); links by (`target_type`, `target_id`); nullable `meeting_id` FK ON DELETE CASCADE on `llm_runs` only (D10); (a) adds `meeting_summaries.summary_json` (11.8 row 12); (b) drops `remix_threads`, `remix_messages`, `remix_runs`, deletes settings rows `remix_hotkey`, `remix_bar_enabled`, `remix_enabled` (inventory D1; created `S/lib/schema.ts:589-619,626-635`), outside the `tableExists(db, "meetings")` guard. `SCHEMA_VERSION` 39 (`S/lib/schema.ts:14`) becomes 40; the block goes between the migration 39 end (`:1007`) and the version upsert (`:1009`). Fix tests pinning 39: `apps/server/tests/schema-meetings.test.ts:7`, `migration-servers.test.ts:91`, `v20-merge-reconciliation.test.ts:107-109,141`. The last file does not pin 39: those lines assert the Remix tables exist (`apps/server/tests/v20-merge-reconciliation.test.ts`), and migration 40 drops them. Adds `sweepInterrupted()` to the recorder (7.12; a plan, absent at `c47cd80d`); `S/index.ts` calls it beside `startHistoryRetentionSweep()`, `startMeetingRetentionSweep()` (`S/index.ts:215-216`). It differs from `sweepOrphans` (`E/main/meeting-recorder.ts:803`, marks `meetings` rows of killed jobs). WP5b replaces the call (3.4.7). WP2 declares every base type, so its branch compiles without WP3. A run on a `.backup` copy of a real database first sets `audio_dir` NULL (10.9 check 1). Must not: plain FKs to segments, speakers, summaries; a table or column named for one consumer except nullable `meeting_id`. Re-transcribe deletes segments (`S/routes/meetings.ts:1546`), speakers (`:1552`), diarizer turns (`:1556-1558`), not summaries; Summarize uses `INSERT OR REPLACE` (`:1213-1225`).
Accept: (1) Seed a fictional meeting with `main` on `$S/db.sqlite`: `select version from schema_version` = 39, then 40 on the branch; `select count(*) from sqlite_master where type='table' and name like 'llm_%'` = 6; `... name like 'remix_%'` = 0; `pragma table_info(meeting_summaries)` lists `summary_json`; meeting count unchanged; `PRAGMA foreign_key_check` empty. (2) `curl -s -H "Authorization: Bearer $TOKEN" "$RUNS" | jq -e '.runs | length == 0'` true; `$CALLS` with `.calls` likewise; unknown id 404. After a seeded run with 5 LLM steps, 2 failed or partial: `curl -s -H "Authorization: Bearer $TOKEN" "$RUNS?latest=1" | jq -e '.runs[0] | .llmStepCount == 5 and .failedStepCount == 2'` true. (3) `DELETE $BASE/api/meetings/<id>` for one of two seeded meetings (`audio_dir` under `/tmp/`, `SK/meeting-benchmarks/SKILL.md:17`) leaves only the other's rows in all six tables; a seeded run with `scope` `'test'`, `meeting_id` NULL survives both deletes. (4) `main` build on the v40 file: `GET $BASE/api/meetings` prints 200 (manual; `main` returns early when the stored version is 39 or more, `S/lib/schema.ts:168`). Rollback: a pre-WP-R build opens the v40 file and only Remix routes fail (inventory 13). (5) `running` run and step become `interrupted` after restart (7.12). (6) 10.9 checks 5, 6 pass: `seq`, `attempt`, `finishedCall`, link keys, equal hashes in `prepare` and reader. (6b) Check 8: every `CallRecord` field reads back from its column, `scope`, `scope_id` equal the run row, `llm_calls` has no `meeting_id` column. (7) Check B prints 14 lines, Check P nothing, GT3 passes on the WP2 branch alone. P1 on a real server and file; 10.9 adds a `.backup` run, counts only.

**WP3. Gateway, profiles, typed errors** (5). `callStructured` checks finish reasons (D4), reasoning params (D3, L2), served model (L4), params sent; never loops (5.0). All under `L/` (Check P). `V/llm-task-profiles.ts` gets `LLM_MEETING_DENYLIST_KEYS` (5.5.3; old set at `packages/validations/src/llm-task-profiles.ts:199-206` stays). New: `gateway.ts` (+ `probeEndpoint`, 5.7), `gateway-errors.ts`, `model-profiles.ts` (+ `reasoningSteps`, 5.5 rule 4), `W/schemas.ts` (4.2.1, 4.3.1, 4.5.1), `createModel` seam of `CallStructuredInput` (5.1), bounded-plan rule of `gatewayOverrides` (5.5.2). Gateway passes the zod schema unchanged (4.0.3 rule 7); models.dev read is best effort (5.1). WP3 edits no existing test. Must not: touch `postProcess`, the old path, dictation; add a retry loop (one retry is `callUnit`, 5.6, 11.8 row 9) or a dependency (5.4 Option A).
Accept: live checks 2, 3, 9 of 5.9 on the owner's oMLX, fictional chunk, script in `$S`. Check 2: `maxOutputTokens: 16` gives `LengthError`, `rawFinishReason` `length`, ledger `max_tokens`. Check 3: reasoning off gives `stop`, served model `Qwen3.8-27B`, ledger with `chat_template_kwargs.enable_thinking` false and `response_format`, equal to the body a local listener captured (`OPENSTYLE_LOG_DIR` unset). Check 9: `sqlite3` read-back shows every D10 field. Mock-only (PR says so): `content-filter`, `tool-calls`, `reasoning_leak`. Cloud paths: scripted tests, UNVERIFIED (11.8 row 5); W12 (10.5.2) checks every provider body. Checks send the real `CorrectChunkSchema`. W14 passes: models.dev rejects, a `server` profile still resolves, no `model_unavailable` (5.1, 10.5.3). W15 passes: `probeEndpoint` for `server` and each cloud provider over a stubbed `fetch`. Check B 14 lines; Check P nothing. Probes LP1, LP4, LP6 (10.12) in the PR. P1 P2.

**WP4. `node:sqlite` checkpoint saver** (3.1, 7.9; D6). `NodeSqliteSaver` passes `@langchain/langgraph-checkpoint-validation`; no native module; generic (Check P). Planned exact pins (R11; no `@langchain` entry exists in any `package.json` of the repo at HEAD `078a358c`): `@langchain/langgraph` 1.5.1, `@langchain/core` 1.2.18 (peer of all three; resume test needs `StateGraph`), `@langchain/langgraph-checkpoint` 1.2.0, dev `@langchain/langgraph-checkpoint-validation` 1.2.0. Each version exists on npm: [langgraph](https://registry.npmjs.org/@langchain/langgraph/1.5.1), [core](https://registry.npmjs.org/@langchain/core/1.2.18), [checkpoint](https://registry.npmjs.org/@langchain/langgraph-checkpoint/1.2.0), [validation](https://registry.npmjs.org/@langchain/langgraph-checkpoint-validation/1.2.0). `@langchain/core` peer ranges `^1.1.48`, `^1.1.48`, `^1.1.44`; 1.2.18 meets all. `latest` of all four equals these on 2026-10-17.
**Spike** (U2, U3, U9, U10, U11 in 3.7 are UNVERIFIED; no later card settles them). One test graph: a router sends 3 tasks with `Send` to one node, a reducer merges, a `save` node follows; real `NodeSqliteSaver` on a temp file, no LLM. SP1 (U2): one task throws after two ended; new graph and saver on the same file; `invoke(null, config)`; the two ended tasks run 0 more times, the third runs again, the reducer holds 3 entries. A manual script in `$S` (not committed) repeats SP1 with `process.kill(process.pid, "SIGKILL")` in the third task, in a child process, and the parent resumes. SP2 (U3): `maxConcurrency: 1` gives at most 1 task alive, `2` at most 2 (counter +1 at entry, -1 at exit). SP3 (U11): a node with `errorHandler` and no retry policy that throws routes to `save` with `Command({ goto: "save" })`; final state holds the failure marker. SP4 (U10): read `llm_checkpoints` rows after the fan-out; report row size and whether the 3 payloads (100 KB marker strings each) are inside. SP5 (U9): the 3.3 state snippet (`StateSchema`, `ReducedValue`) is in the spike and `pnpm --filter @openstyle/server typecheck:tests` passes. The PR records the five results. If SP1 to SP4 fail, WP4 does not merge and WP5a is not cut; the coordinator amends 3.2, 3.3 and the cards in a docs PR (3.2 rule 8 fallback), and WP4 merges with the spike changed. If SP5 fails, the snippet uses the installed export names in the same PR (the README shows `@langchain/langgraph-validation`; read the real export first, [README](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint-validation/README.md)).
**Vitest fallback** (decided 2026-10-17, owner viewpoint: replace directly, no dual path). The validation package needs `vitest ^4.1.11`; the repo catalog range is `^4.1.7` (`pnpm-workspace.yaml:24`) and the lock entry is `vitest@4.1.7` (`pnpm-lock.yaml:4987`). If `pnpm install` reports a peer error or the suite does not start, the WP4 implementer, in the WP4 PR: (1) sets the catalog line `vitest: "^4.1.11"` (registry `V4` dist-tag 4.1.12, [npm](https://registry.npmjs.org/vitest); publish date UNVERIFIED); (2) runs `pnpm install`, `pnpm -r test` (`apps/electron`, `apps/server`, `packages/stt`, `packages/validations`) and `pnpm --filter @openstyle/server typecheck:tests`; (3) prints old and new version and the result in the PR body; (4) if an existing test fails, stops and asks the coordinator; does not edit those tests.
Accept: every conformance group passes; `grep -c 'better-sqlite3' pnpm-lock.yaml` = 0; graph A, B, C on a file, B throws after A is checkpointed, reopen handle and saver, resume with the same `thread_id` ([docs](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) put `thread_id` in `configurable` when a graph with a checkpointer runs; for resume they only call `thread_id` required, so its place there is UNVERIFIED), both invokes `durability: "sync"` (a choice of this spec, 3.4.2; the docs say `"sync"` saves before the next step and `"async"` can miss a checkpoint in a crash, not that `"sync"` is needed to resume): counters A 1, B 2, C 1. No GT5. The PR reports dependency growth and SP1 to SP5 output. P1; the real-runner `SIGKILL` proof is WP5b and WP9 (G6).

**WP5a. Graph, `callUnit`, six node slots, nodes except `summarize` body** (3.1 to 3.3, 4). Adds no dependency (WP4 did). Files: register. Notes: `W/nodes/verify-evidence.ts` holds the functions of 4.4.1 to 4.4.4. `L/call-unit.ts`: `callUnit`, one retry layer, `gatewayRetryOn` (5.6). `stripTracingEnv` deletes `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`, `LANGSMITH_TRACING`, `LANGCHAIN_TRACING` from `process.env`; `W/load-graph.ts` calls it, then loads `W/graph.ts` by dynamic `import()` (3.1 rule 2 sets this load order; it is a rule of this spec). The four variable names come from [this source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/utils/callbacks.ts); that file has no load-order logic. `W/unit.ts`: `guardNode(deps, node, fn)`, `runStep` (4.0.2; `guardNode` calls `ctx.onNodeStart`, `startStep`, `finishStep`). `W/types.ts`: `WORKFLOW_GRAPH_VERSION` = 1 (3.4.7), `foldStatus` (4.0.7), `deriveRunStatus` (3.4.3), `SaveResult` (4.6). `W/context.ts`: `WorkflowDeps`, `RunContext` with `onNodeStart`, `productionDeps`, registry `runContexts` (3.4.2). `helpers/workflow-harness.ts`: `makeTestRunContext`, `makeTestDeps`, `instantSleep`, `makeFakeRecorder`, `runScriptedGraph`. `W/chunking.ts`: `chunkForEnhance`, `chunkTranscript`, `estimateTokens`, `overlapTokens`, moved with no behavior change (old files import them back until WP5b). `W/nodes/summarize.ts`: stub returns `skipped`, exports `SUMMARIZE_IS_STUB = true`. `save.ts` writes `meeting_summaries.summary_json` when state holds a summary (4.6.1). `W/summary-pure.ts` full bodies, because the `save` test needs them before WP6. `workflow-save.test.ts` is planned to hold the #163 replay and the G5 request counts (no such test exists at HEAD; [issue #163](https://github.com/Maheidem/openstyle/issues/163) is open and titled meeting enhance speaker-block bug; that it matches the save node is UNVERIFIED); GR25, GR26 (a) join the seven test files (content: 10.8, "Req" rows of 10.5.1, 10.6 rows except `summarize`). Must not: change old path behavior, write `confirmed_at` or `display_name` (4.6.1), set an AI SDK retry or node `RetryPolicy`.
Accept: old tests `meeting-enhance`, `meeting-speaker-names` stay green. `git grep -l -E "@langchain/(langgraph|core)" -- apps/server/src` shows only `S/lib/llm/workflow/` and `S/lib/meetings/workflow/` paths. Live script (`productionDeps()` on the isolated scratch database, real saver; no runner exists, so it calls `runContexts.register(makeTestRunContext({ runId, meetingId }))` and `deps.recorder.startRun`; 6 chunks, 3 speakers as in 10.12 step 2; fictional names, seed step `SK/live-testing/SKILL.md:215`; Qwen3.8-27B is an allowed oMLX model, `:229`): `select count(*) from meeting_segments where enhanced_text is not null` > 0; `llm_calls` has one `correctChunk` per chunk and one `identifySpeakers`; a listener sees `response_format.type` `json_schema` and `chat_template_kwargs`. GT5 names the LangGraph chunk (UNVERIFIED until built, 9.8 rule 2), `commonjsRequire(` 0, growth reported. Every WP5a row of 10.8 passes, including GR18, GR19, GR20 (a), GR21 (a), GR23 (X7). One retry layer: a fake server that always answers 503 sees exactly 2 requests per call. Each of the seven files passes alone (`Test Files  1 passed (1)`). Check B 14 lines; Check P nothing. U6 (3.7), next to GR3: `grep -rn -E 'LANGSMITH_TRACING|LANGCHAIN_TRACING' $(find node_modules/.pnpm -path '*@langchain/core/dist/utils/callbacks.js' | head -1)` prints the four names; the PR pastes the lines (file name in 1.2.18 UNVERIFIED). If the list differs, `LW/env-guard.ts` and GR3 follow the installed list. Probes LP2, LP3, LP7 (10.12) in the PR. P1 P2.

**WP6. `summarize` node** (4.5; hard dep WP5a; WP10a merges before it, because the card runs `check-summary.mts`; ready draft during the council, merges just before WP5b, B16). Single call, or map then reduce, with the fixed five-field `MeetingSummarySchema` (overview, key points, decisions, action items, open questions) rendered to Markdown by code (11.8 row 11). Today's limits stay. Edits `W/nodes/summarize.ts` (sets `SUMMARIZE_IS_STUB` `false`) and `W/prompts.ts` (new single, map, reduce prompts for 4.5.1, 4.5.2; it does not import the old prompt builders, which say "Return only the markdown summary", `summary-prompt.ts:91, 108`). New: `workflow-summarize.test.ts` (WP6 rows of 10.8, 10.6 row `summarize`). The node fills `llmProvider`, `llmModel`, `costUsd` by 4.5, because WP5b deletes the old price reader (`S/lib/meetings/llm-call.ts:165-167`). From old code it keeps `chunkTranscript`, `estimateTokens` (`W/chunking.ts`) behind a mapper from `PreparedSegment` fields (`text`, `enhancedText`, `speaker`, `speakerName`, `speakerLabel`). It uses `plannedSummaryCalls` (24-call limit, job deadline) and `renderSummaryMarkdown`, opens a step row per `single`/`map`/`reduce` unit with `runStep` (4.0.2; `guardNode` opens none), and reads `prepared.summary` (4.1), not settings. It starts no route or run.
Accept (uses only parts that exist after WP5a, WP2, WP3, WP4, WP10a; no `W/runner.ts`, `resumeRun`, route). Live script in `$S`: `deps = productionDeps()`; `runContexts.register(makeTestRunContext({ runId, meetingId }))`; `deps.recorder.startRun` (scope `meeting`, 7.7); `loadGraph(deps)`; `graph.invoke({ runId, meetingId, stages: ["summarize"] }, { configurable: { thread_id: runId }, durability: "sync", maxConcurrency: 3 })`; status from `deriveRunStatus(finalState)` (3.4.3); `deps.recorder.finishRun`. Resume: `graph.invoke(null, { configurable: { thread_id: runId }, durability: "sync" })` on the real saver in a new process. (1) Short fictional meeting: `deriveRunStatus` gives `succeeded`; `select status from llm_runs where id='<runId>'` reads `succeeded`; `select json_valid(summary_json), length(summary_json) from meeting_summaries where meeting_id='<id>'` prints `1|` and a number above 0; the Markdown column is non-empty and equals the code rendering of `summary_json` (SW3, 4.6.1). `select cost_usd, llm_provider, llm_model from meeting_summaries where meeting_id='<id>'`: on the owner's oMLX `cost_usd` NULL, `llm_provider` `server`, `llm_model` = `served_model` of the last `llm_calls` row of the run, else `requested_model` (4.5 rules 2 to 4). A priced model gives non-NULL `cost_usd`: 10.6 cases (a) to (e) pass with a stubbed models.dev answer. Cloud: UNVERIFIED (11.8 row 5). (2) With `meeting_summary_context_budget` = `2000` (min 100, `packages/validations/src/settings.ts:257-266`) and about 6000 tokens: N map calls (N = chunks of `chunkTranscript`), at least 1 reduce call, at most 24 and at most `plannedSummaryCalls(...)`. Budget 300 cannot hold two partials: `budget_exceeded` (4.5.3). (3) `kill -9` the script during map calls, resume: no finished map call is sent again (GR10 (c), GR20 (b)); `select step_key, count(*) from llm_calls where run_id='<runId>' and node='summarize' and error_kind is null group by step_key having count(*) > 1` returns no rows. Two reduce levels use keys `reduce:1:0`, `reduce:2:0`. Every WP6 row of 10.8 passes, including LR9 to LR11, GR22. (4) A 5-second ceiling ends `deadline_exceeded`: final state holds the failed summary result with that kind, `deriveRunStatus` gives `failed`, no summary row is written. Notice text: WP5b accept 12. (5) `pnpm meeting:check-summary --db $S/db.sqlite --meeting <id> --arm new --out $S/cs.json` (4.5.6) on three fictional summaries (single, map+reduce, empty lists) exits 0 and `jq -e '.pass == true and .summarySections == 5' $S/cs.json` holds. Negative control: append `# x` to the Markdown column of a scratch copy; exit 1, `strayHashLines` 1. Check B 14 lines; Check P nothing. Checks that need the runner or a route belong to WP5b (accept 1, 2, 3, 7) on the candidate build. P1 P2.

**WP5b. Runner, routes switch, renderer switch, chain, resume, boot sweep, old path deleted** (3.4, 3.5, 3.6, 8.5, 8.9, 8.10). No flag (B16). New: `W/runner.ts` (`startRun`, `resumeRun`, `sweepOrphanRuns`, `resumeInterruptedRuns`, `getMeetingEnhanceAutoRunSetting` moved from `M/enhance.ts:51-58`), `LW/run-registry.ts` (claims and cancel controllers). The runner builds the real `RunContext`; its `onNodeStart` calls `setJobKind(meetingId, "summarize")` for node `summarize` (3.4.2, 3.6); it registers the context with `runContexts.register` before each `invoke` and drops it in the `finally` of `execute`. Tests: `workflow-runner.test.ts`, `workflow-resume.test.ts`, `workflow-chain.test.ts` (WP5b rows of 10.8; GR24 (b) needs the real `summarize` body and skips while `SUMMARIZE_IS_STUB`). Edits `L/recorder.ts` (resume methods, 7.7), `S/routes/meetings-runs.ts` (resume route), `V/meeting-types.ts` (`StartRunResponse`, `ResumeConflict`, `ResumeConflictReason`, 3.4.2). Routes: `POST /:id/enhance` starts one run with `stages = ["enhance", "summarize"]` (the route is at `S/routes/meetings.ts:2101`; the auto-run handoff that starts `runEnhanceJob` is at `:1039-1045`; the Enhance button is in `UI/detail.tsx`; 11.8 row 2); `POST /:id/summarize` starts `["summarize"]` (`:2068`; button stays); both answer 202 `{ ok, id, runId }`. A later speaker-name confirmation makes the summary stale; the warning stays (3.6). A confirmed speaker name or new `enhanced_text` while a Summarize or chained run is interrupted fails its resume with `transcript_changed`; the user starts again (3.4.7 guard 6, 11.8 row 13). Before the boot resume of a cloud run the app may send one `HEAD` (no key, no meeting data) to that run's base URL (3.4.7, 5.7, 11.8 row 14). Renderer switch (8.9, 8.10): `UI/detail.tsx` handles 202 and polls; adds failure and interrupted notices, lines, Resume and Start again, success note; removes the old failure state (`detail.tsx:87-89`), its reset in `runAction` (`:223`), the non-2xx branch of `enhance()` (`:364-375`), the old notice (`:763-786`), the `!enhanceFailure` condition (`:719-721`) and the `job_error` use for Summarize (O8-2, 11.8 row 17). `query.ts` (`llmRunsLatest`, `resumeRun`, 8.5 invalidation); 8 locale files and `locales.test.ts` (`meetings.llmRun.*`, `meetings.llmError.*` in group `enhance-honesty`, translated for de, es, fr, it, ja, pt with `en.json` placeholders, checked by `pnpm --filter @openstyle/electron test locales.test.ts`, 8.10 item 1; `enhanceFailedTimeout`, `enhanceFailedParse`, `enhanceFailedProvider` leave). New `UI/run-notice.ts` (pure: notice lines per error kind, chunk list, `run.errorKind` fallback, buttons per run status) and `run-notice.test.ts` (node env, `apps/electron/vitest.config.ts:16-21`). Deletes the old path: `M/{enhance,enhance-prompt,summarize,summary-prompt,llm-call}.ts`, `runEnhanceJob`, `runSummarizeJob`, 200/502 handling (`S/routes/meetings.ts:2161-2195`), `job_error` writes for Summarize (`:1240`). Rewrites or deletes each `it(` of the six test files that import deleted files: `meeting-enhance`, `meeting-summarize`, `meeting-llm-timeouts`, `llm-task-profiles` (`apps/server/tests/llm-task-profiles.test.ts:123-128` imports `DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS` from `summarize.js`; it moves to `SUMMARY_ANSWER_TOKENS`), `meetings-calendar` (`:8` imports `EnhanceMeetingOptions`), `meetings-routes` (`:29, :3122`); the PR lists each deleted `it(` with successor or reason (10.2 rule 7). Must not: change meeting status in a run (`:1073-1076`); start a run before the first request or the boot resume (3.1 rule 3); merge before `CONSENSUS: yes`.
Accept (plus `tests/meetings-routes.test.ts`). **Where checks run.** The WP5b branch holds the `summarize` stub (returns `skipped`). Checks marked "candidate build" need the WP6 body: the last two parts of (1), all of (2), the second part of (7), GR24 (b). They run on the candidate (11.7 step 4) and again after the rebase on the WP6 merge (step 8). Others run on the WP5b branch. On the stub, (1) holds up to: run `succeeded`, step `summarize` `skipped`.
(1) 6-chunk fictional meeting: `POST $BASE/api/meetings/<id>/enhance` = 202 with `runId`; poll `GET /api/meetings/<id>` until `job` is null; `$RUNS?latest=1` shows one run `succeeded` whose steps include `summarize`; one `llm_calls` row per chunk; (candidate build) status `summarized` and non-empty `summary.markdown` (the renderer polls while `status` is `transcribing` or `job.kind` is `summarize` or `enhance`, `UI/detail.tsx:122-127`; the combined check is an acceptance rule of this spec). (2) (candidate build) `POST $BASE/api/meetings/<id>/summarize` = 202; the new run has the `summarize` stage only; `select cost_usd, llm_provider, llm_model, json_valid(summary_json) from meeting_summaries where meeting_id='<id>'` as in WP6. (3) Kill and resume (G6, U2): `kill -9 $(cat "$S/server.pid")` after the first chunks save; restart on the same DB; run `interrupted`, `running`, then success; `select step_key, count(*) from llm_calls where run_id='<runId>' and node='correctChunk' and error_kind is null group by step_key having count(*) > 1` returns no rows. The WP4 spike (SP1) settles U2 first. Repeat with the kill during `identifySpeakers` (5.6). (4) `POST $BASE/api/meetings/<id>/cancel-transcribe` ends the run `cancelled`; finished chunks keep `enhanced_text`. (5) Every WP5b row of 10.8 passes, including GR17: 0 checkpoint rows for a `succeeded`, `partial`, `failed`, `cancelled` run; more than 0 for an `interrupted` run. (6) Soft cancel on the live model (probe LP5 settles U4, 3.7; oMLX, fictional text, Qwen3.8-27B): time a one-token request on the idle model (T0), start an Enhance run with a long answer, cancel with `cancel-transcribe`, time the same request at once (R). The PR gives T0, R and the oMLX log lines (10.12 LP5); B14 prints `200`. (7) Stale resume: interrupt a Summarize run, confirm a speaker name through the API, restart; the resume ends `transcript_changed` and starts no model call. (Candidate build) Repeat with a chained Enhance run killed in its Summarize stage. (8) HEAD probe: a test over a stubbed `fetch` shows exactly one `HEAD`, no `Authorization` header, no body, to the interrupted cloud run's base URL before its resume; no live cloud proof. (9) `git grep -n -E "meeting_enhance_workflow|parseMeetingEnhanceWorkflow|meetingEnhanceWorkflow|enhanceWorkflow|checkEnhanceFlag" -- apps packages scripts`, `git grep -n -E "defaultChatCallFor|extractJsonObject|enhanceMeetingTranscript|runEnhanceJob|runSummarizeJob" -- apps packages` and `git grep -n -E "meetings/(enhance|enhance-prompt|summarize|summary-prompt|llm-call)\.js" -- apps packages scripts` each print nothing. (10) GT1 to GT6; no unused file; `git grep -n getModelCostCached -- apps/server/src` lists `post-process.ts`, `model-registry.ts`, `W/nodes/summarize.ts` (4.5 rule 4); 10.6 cost cases pass. (11) Council gate: the PR body holds the WP10b round, candidate SHA, compare files, printed `CONSENSUS: yes` and the empty output of 11.7 step 8 (c); the WP10a harness on the same meeting stays in the recorded run-to-run range. (12) Renderer switch: real app via test runner (B13), fictional meeting, throwaway `apps/electron/tests/zz-proof-run-notice.test.ts` (recipe `SK/live-testing/SKILL.md:206-221`: write the config before launch, `:213`; after launch set `meeting_enhance_prompt_seen` by `PUT` on the isolated server, `:214`; then seed, `:215`). A seeded `failed` run shows its lines after reload; `partial` shows its count line; `interrupted` shows Resume and Start again and a Resume click calls `POST $BASE/api/meetings/<id>/runs/<runId>/resume`; a failed summary step with kind `deadline_exceeded` shows "The summary took longer than its time limit." Screenshots at 1152x648, 900x600, 720x480; TCC count 0. `grep -c -E 'enhanceFailed(Timeout|Parse|Provider)' apps/electron/src/renderer/src/locales/*.json` prints `0` for 8 files. `pnpm --filter @openstyle/electron test` passes with `run-notice.test.ts` and `locales.test.ts`. Delete the throwaway spec; `git status --short` shows only card files. GT5; growth reported.
(13) Auto-run handoff after the real transcribe job (replaces `S/routes/meetings.ts:1039-1045`). The auto-run starts only at the end of `runTranscribeJob`; a meeting seeded `transcribed` never reaches it, so run the real job on an imported file (no microphone or system audio; isolated server `SK/live-testing/SKILL.md:87-102`; fictional data). (a) Clip: macOS `say` with `-o` (without it, it plays through the speakers, `:233`), two fictional sentences; `afconvert -f WAVE -d LEI16@16000 "$S/en.aiff" "$S/en.wav"` (`:133-137`). (b) `POST /api/servers {"url":"http://127.0.0.1:8123"}`; `POST /api/models/configured` twice: default `voice` model `server/<id>/Qwen3-ASR`, default `llm` model `server/<id>/Qwen3.8-27B` (`:125-126`). (c) `PUT $BASE/api/settings/meeting_enhance_auto_run` `{"value":"true"}` (`true`/`false` valid, `S/lib/setting-validators.ts:88-89, 212`); `PUT $BASE/api/settings/meeting_diarization_enabled` `{"value":"false"}`, so no diarizer pass and no aligner download (`runDiarizer` is skipped when the flag is false, `S/routes/meetings.ts:828-831`; `S/lib/mlx-asr/aligner.ts:118-125`; aligner start `S/routes/meetings.ts:787`); the boot call `S/index.ts:222` finds no meeting in a fresh scratch database and starts no download (`aligner.ts:109-125`). That the PUT accepts the key and no download starts is UNVERIFIED by a run. (d) `POST $BASE/api/meetings/import` multipart with `audio`, `id` (UUID), `audio_dir` (`$S/audio/<id>`), `title`, and optional `started_at` (`S/routes/meetings-import.ts:149,156,161,178,190-192`), then `POST $BASE/api/meetings/<id>/transcribe` (`S/routes/meetings.ts:1528-1566`): the real job on Qwen3-ASR. (e) Poll `GET $BASE/api/meetings/<id>` until `job` is null. (f) `sqlite3 -readonly`: `select started_by, kind from llm_runs where scope = 'meeting' and scope_id = '<id>'` prints `auto|enhance`; `select count(distinct node) from llm_calls where scope_id = '<id>' and node in ('correctChunk','summarize')` prints `2` (one run held both stages; the run row has no stage list; candidate build); `select count(*) from meeting_summaries where meeting_id = '<id>'` prints `1`; `select status from meetings where id = '<id>'` prints `summarized` (candidate build). (g) Negative control: `PUT` the setting `false`, import a second clip, transcribe; `select count(*) from llm_runs where scope_id = '<id2>'` prints `0`; status stays `transcribed`. (h) B14 prints `200`. Qwen3-ASR on synthetic speech may differ from the sentences; the check needs a non-empty transcript. **Fallback.** If oMLX or Qwen3-ASR is unavailable or the transcript is empty, the proof is a route test in `meetings-routes.test.ts`: the real `POST /:id/transcribe` with the stubbed transcriber of the existing override (`createTranscriberDeps`, `S/routes/meetings.ts:139, 440`) and a scripted model. The `enhance` override (`S/routes/meetings.ts:175`; it serves `POST /:id/enhance` and the auto-run call) is live at HEAD and goes away with `runEnhanceJob` in this PR, so WP5b adds `workflowDeps?: Partial<WorkflowDeps>` to `MeetingsTestOverrides`; the runner merges it into `productionDeps()`. The test expects one `llm_runs` row with `started_by` `auto`. The PR and final report then mark the end-to-end auto-run claim UNVERIFIED. P1 P2 P3 P4 (via WP10b).

**WP7. Inspector UI** (8.1 to 8.8, 8.12; hard deps WP2, WP5b). Hidden unless `advanced_mode` is `"true"`; the server has no gate (I1, 8.2). Data API and types are generic; the screen is meeting-only. It shows prompts of imported meetings as of recorded ones (11.8 row 3). WP5b already carries notices, Resume, old-state deletion and notice keys; WP7 touches none. New: `UI/llm-inspector.tsx`, `llm-call-view.tsx`, `llm-inspector-model.ts` (pure: ledger grouping and "Current" mark, error-kind to text-key map with `unknown` fallback, producing call for an edit (8.12), the one gate function `advanced_mode` equal to `"true"` (10.10)), `llm-inspector-model.test.ts` (node env). Edits: `detail.tsx` (entry points, panel mount of 8.6), `query.ts` (`llmRuns`, `llmCalls`), `speakers.tsx`, 8 locale files and `locales.test.ts` (`meetings.inspector.*`, key-set test). No flag toggle, no Settings change.
Accept (plus `pnpm --filter @openstyle/electron test`): (1) Throwaway `apps/electron/tests/zz-proof-llm-inspector.test.ts` on seeded rows (recipe `SK/live-testing/SKILL.md:206-221`; the `meeting_enhance_prompt_seen` step is `:214`); screenshots at 1152x648, 900x600, 720x480 (8.12 item 1) for a recorded and an imported meeting; TCC count 0. (2) Row counts of the six tables are 0 after deleting the meeting by API (8.12 item 2). (3) With `advanced_mode` `"false"` no inspector element shows and the renderer sends no `llm-calls` request and no Runs view list request; the `llmRunsLatest` request (8.5) still runs. (4) `llm-inspector-model.test.ts` and the `meetings.inspector.*` key-set test pass. (5) Delete the throwaway spec; `git status --short` shows only card files. P3 via test runner (B13); the prover views every screenshot (`SK/live-testing/SKILL.md:179`).

**WP8. Tracing, opt-in** (9; D8, G10). Variables unset = no tracer, no connection; set = one MLflow trace per run, one span per node call. `@ai-sdk/otel` pins `ai` 7.0.143 ([npm](https://registry.npmjs.org/@ai-sdk/otel/latest)). Edit sites (9.10): `W/unit.ts` (`guardNode` calls `inNode` inside its `try`), `W/runner.ts` (`startRunSpan` before `graph.invoke`, `endRunSpan` after final status, `resumeRun` too); no node file. WP8 edits `AGENTS.md:9` (the architecture paragraph; today it states there is no telemetry) so that it states: export is off unless both variables are set (`specs/meeting-enhance-agentic.md:3050,3061`, 9.5.1 item 5). New `L/tracing.ts`, `tracing.test.ts`. Variables `OPENSTYLE_MLFLOW_TRACKING_URI`, `OPENSTYLE_MLFLOW_EXPERIMENT_ID`, no setting key (T1); a tracing failure never changes a run (T7); Enhance and Summarize runs export, dictation cleanup never (T8, Q9.6, 11.8 row 18); OTLP needs MLflow 3.6.0+ ([MLflow](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest/)); fictional text only.
Accept: (1) Live checks C1 to C10 of 9.9 on the owner's MLflow (3.16.1 on 2026-10-17), oMLX Qwen3.8-27B only; app spans and AI SDK spans both land. The coordinator reads back with `MlflowClient(...).search_traces(locations=[<experiment id>])`: state `OK` for the normal run, ERROR for typed-error runs; a trace counts only once read back. (2) Same commit with and without tracing (9.8 rule 3): record `out/main/server-process.js`, each `out/main/chunks` file, `app.asar`; report growth (no cap). GT5. P1 P5.

**WP9. Committed E2E specs, whole-feature live proofs** (10, 10.11). New `apps/electron/tests/meeting-enhance-workflow.test.ts`, `meeting-llm-inspector.test.ts` (fake own server as `meeting-cancel-transcribe.test.ts:103-146`; `launchOpenstyle`, `helpers/e2e-app.ts:36`); no flag. Floor: happy path (`response_format.type` `json_schema`, `chat_template_kwargs`, all steps done, Enhance chains into Summarize); fake `length` answer (notice live and after reload); `SIGKILL` of the utility process in `correctChunk` (as `server-host-restart.test.ts:54-84`; no second request for a finished chunk, G6); inspector gate. Edits `SK/live-testing/SKILL.md`: a rule (10.12 step 1) to set `OPENSTYLE_LOG_DIR` only for fictional text (today: leave unset, `SKILL.md:102`; a plan of this spec).
Accept: (1) CI `pnpm --filter @openstyle/electron run test:e2e` passes inside the 5-minute limit (`build.yml:203-204`); above 4 minutes, tell the owner (R13). (2) Local: build per `SK/live-testing/SKILL.md:211`, then `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false scripts/test-runner/run.sh "$PWD/apps/electron" -- timeout 600 pnpm exec playwright test tests/meeting-enhance-workflow.test.ts tests/meeting-llm-inspector.test.ts`: all pass, TCC count 0. (3) Live on the owner's oMLX, fictional meeting (`SK/live-testing/SKILL.md:206-221`): Enhance (chains into Summarize), Summarize button, inspector in advanced mode; three screenshots; the panel equals the `llm.request` body in the trace log (8.12 item 3); kill the utility process during Enhance: the run completes, no second call for a finished chunk. (4) Distinct schemas in records = number of structured steps (R8); record text size after a long run (about 0.6 MiB per 40 chunks, 7.11; R14). (5) `OPENSTYLE_DEV_SIGN=0 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openstyle/electron build:unpack`; `find apps/electron/dist -name app.asar -exec ls -l {} +`; compare with `main`, report growth (target about 9 MiB, `AGENTS.md:87`); run one Enhance in the packaged app (BC8, 10.14); local viability of `build:unpack` UNVERIFIED. P1 P2 P3.

**WP10a. Benchmark harness and old-path baseline** (10, 12). Edits `knip.jsonc` (`ignoreFiles` `:34-45`; knip treatment of `compare-speakers.mts` UNVERIFIED; the new `.mts` script gets the same), `package.json` (adds `meeting:check-summary`, absent at HEAD; `:10` is `meeting:compare-speakers`), `SK/meeting-benchmarks/SKILL.md`. New `scripts/meeting-v2/run-enhance.mjs`: copies the transcribed scratch meeting; `--arm old|new` is a label only (the arm is the server build: `main` for `old`, the WP5b branch build for `new`); `POST /api/meetings/<id>/enhance`, accepts 200 (old) and 202 (new), polls `GET /api/meetings/<id>` until the job ends; writes `metrics-enhance.json` (numbers only: `seconds`, `chunksAttempted`, `chunksSucceeded`, `chunksFailed`, `correctedCount`, `speakerSuggestions`, `namesRespelled`, failure reasons, `contextHash`) and a `dump-speakers.mjs` dump; prints no text. `--summarize` posts `/summarize` for the old arm; on the new arm the run already summarizes and the script reads the summary. After each run it calls `pnpm meeting:check-summary` and merges the numbers. New `check-summary.mts` (4.5.6): five checks on `meeting_summaries.markdown` and `summary_json`, counts the old arm's Markdown, prints numbers only, exits 0, 1 or 2; `pnpm meeting:check-summary --db <db> --meeting <id> --arm <old|new> --out <metrics.json>`; used by WP6 and WP10b. New `check-enhance-metrics.mjs` (`--dumps <d1> <d2> <d3>`) prints `hallucinatedKept` (a kept quote that is no substring of a segment text in the dump), `untypedFailures`, `namedRuns` per label; it re-reads its output and exits 1 on a mismatch. Privacy: `SK/meeting-benchmarks/SKILL.md:14-19`. 3 runs per arm (oMLX with MTP is not deterministic at temperature 0, `/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:145`, [omlx#4089](https://github.com/jundot/omlx/issues/4089)). Meetings: the short and long proof meetings (`SK/meeting-benchmarks/SKILL.md:24-25`) plus the #163 meeting `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6` (VERIFIED 2026-10-17: `/tmp/meeting-v2/r9b.log` lines 3, 8, 23, 28, 48, 53 show `chunksAttempted` 8, `chunksFailed` 2 in 6 of 6 arm A tries; `/tmp/meeting-v2/run-arms.mts:1-12` is a temp runner of 3 enhance arms on one scratch meeting and does not name #163; line 9 sets the DB path and line 10 sets the meeting id; `specs/meeting-transcription-v2.md:483-486`). Transcribe once, `.backup`, start each run from it; `text` of both arms hashes equal before any compare (10.15 step 3).
Accept: (1) `jq -e 'has("seconds") and has("chunksAttempted") and has("chunksSucceeded") and has("chunksFailed") and has("correctedCount") and has("speakerSuggestions") and has("contextHash")' $S/enhance/*/metrics-enhance.json` exit 0 per file. (1b) `node scripts/meeting-v2/check-enhance-metrics.mjs --dumps <d1> <d2> <d3> --out $S/m.json` exits 0 and `jq -e 'has("hallucinatedKept") and has("untypedFailures") and has("namedRuns")' $S/m.json` exits 0; the baseline shows whether the old path fails a chunk in each run (G3). (1c) On a fictional scratch database with one new-style summary row, `pnpm meeting:check-summary --db $S/db.sqlite --meeting <id> --arm new --out $S/cs.json` exits 0 and `jq -e '.pass == true and .summarySections == 5 and .summaryRenderMatches == true' $S/cs.json` exits 0. Negative controls: Markdown with an extra line `# x` exits 1, `strayHashLines` 1; a `summary_json` that differs from the Markdown exits 1, `summaryRenderMatches` false; an old-style row (four sections, `summary_json` NULL) with `--arm old` exits 0, `summarySections` 4, `summaryOpenQuestions` null. (2) `pnpm meeting:compare-speakers --x <run1 dump> --y <run2 dump> --x-name run1 --y-name run2 --out $S/self.md` exit 0 (usage `scripts/meeting-v2/compare-speakers.mts:15-17`; name `package.json:10`; self-check `compare-speakers.mts:9-13`). (3) A Haiku reader lists every `console.log` and `writeFileSync` in `run-enhance.mjs` and `check-summary.mts`; each writes only counts, durations, hashes, ids or paths. (4) GT1, GT2 only. (5) Baseline numbers exist in `$S/enhance/`; the PR names runs and numbers, no text. (6) `SK/meeting-benchmarks/SKILL.md` carries a dated line (2026-10-17, issue #185 only) that the pi and Codex judges may read the benchmark meetings; WP11 removes it. P4.

**WP10b. After-run, compare files, council** (10, 12; D12). Runs on the candidate build (11.7: WP5b head merged with WP6 head, unmerged ready drafts, B16) in a scratch profile, from the SHA the coordinator recorded. The branch is cut when the candidate exists, with two commits: harness and skill edits first, council record after `CONSENSUS: yes`. Its PR merges after WP5b. Edits: `specs/meeting-enhance-agentic.md` (council record; skill names `specs/meeting-transcription-v2.md`, `SK/council/SKILL.md:34`); `SK/council/SKILL.md` names `compare.mts` (`:14`), which reads the `dump-chunks.mjs` format without `enhanced_text` (`dump-chunks.mjs:2-4,19`), so add the speakers compare tool for Enhance arms, plus a dated line (2026-10-17, issue #185 only) that replaces the Codex approval rule (`:27`) for the benchmark meetings; `scripts/meeting-v2/run-enhance.mjs` (its `--arm new` branch runs first here, so a round can fix it); `SK/pi-briefs/SKILL.md`; both skills are corrected about the pi pin (10.15 step 6).
Procedure: (0) Read the Q18 row in 12.2 (default yes, one waiver, or the owner's changed answer); apply it, never ask the owner. If it names tracing to the owner's MLflow, set the 9.5.1 variables for those runs and read each trace back before the round. If the row is missing, stop; the coordinator reports it. (1) `run-enhance.mjs --arm new --summarize`, 3 runs per meeting, #163 meeting 6 runs (G3), tracing variables unset (B12). (2) `pnpm meeting:compare-speakers`; `pnpm meeting:check-summary` per run (4.5.6, 11.8 row 11). (3) `pi_list_agents` with `doctor`. pi judges on the pin `openai-codex/gpt-6.1-sol`, Codex judges too; no per-data-set approval (11.8 row 10). (4) `bash scripts/council.sh prepare <round> <compare-file>...`; judges write `/tmp/meeting-v2/council/<round>/judge-<who>.md`, line 1 `VERDICT: <SHIP|FIX-FIRST|REVERT> BETTER=<n> WORSE=<n> SAME=<n>`; Claude writes first (`SK/council/SKILL.md:20-25`). (5) `bash scripts/council.sh collect <round>`. FIX-FIRST or REVERT returns the fix to the owning branch (WP5b or WP6); the coordinator builds a new candidate and runs a new round (11.7 step 7).
Accept: (1) The PR shows per arm failed chunks, speaker suggestions kept, seconds; tokens for the new arm only (the old path stores none, `M/enhance.ts:630-635,658-672,684-693`); no metric worse without a written reason; #163 meeting: 6 of 6 runs with 0 failed chunks. (2) `collect` prints `CONSENSUS: yes`, exit 0 (`SK/council/SKILL.md:32`). (3) The spec record lists the round number, the measured candidate SHA, the WP5b and WP6 head SHAs in it, compare files, verdict lines, decision, and the date of the Q18 tracing waiver. After the merges, a second commit adds the two squash-merge SHAs on `main` and the output of 11.7 step 8 (c). (4) `check-summary.mts` prints `pass` true on all data sets; no owner side-by-side read. Judges: Claude (coordinator), pi (brief via `pi-briefs`, `SK/council/SKILL.md:26`), Codex; Sonnet and Haiku only run scripts. P4.

**WP11. Close-out** (12; after WP7, WP8, WP9, WP10b). Sets `WIP_LIMIT` to 2 in `scripts/branch-status.sh:21` and the skill (B6). Removes the dated #185 lines from `SK/meeting-benchmarks/SKILL.md` and `SK/council/SKILL.md`. Updates the `AGENTS.md` pipeline paragraph. Marks `specs/meeting-enhance-agentic.md` implemented. Edits no source file.
Accept: (1) `grep -n 'WIP_LIMIT=' scripts/branch-status.sh` prints `21:WIP_LIMIT=2`. (2) `git grep -n -E "meeting_enhance_workflow|parseMeetingEnhanceWorkflow|enhanceWorkflow|defaultChatCallFor|extractJsonObject|enhanceMeetingTranscript|runEnhanceJob|runSummarizeJob" -- apps packages scripts .claude AGENTS.md` prints nothing. (3) The WP10a harness on the same meeting with the final build stays in the recorded run-to-run range. (4) One live Enhance (with chained Summarize) and one live Summarize on a fictional meeting pass (P2); WP9 specs pass. (5) GT1 to GT6. (6) The coordinator reports bundle and asar growth of the whole build to the owner. P1 P2.

### 11.6 Agent roles and the three Haiku checks

The coordinator (main session) runs one workflow per WP. The script starts agents only. The coordinator does the git and GitHub steps (B1), re-runs key acceptance commands, reads output and screenshots, and accepts no agent report as proof.

- **Implementer** (Sonnet): code and tests in the WP worktree; gates; reports commands and real output. Does not create, push, merge or delete a branch; touches no file outside the card.
- **Reviewer** (Sonnet): reads the diff against the spec; finds scope creep, overbuilding, wrong comments, STE errors; runs Check B and Check P. Edits no file.
- **Prover** (Sonnet): runs P2, P3, P5 from the PR branch; writes only to `$S`; reports commands, output, screenshot paths. The implementer is not the prover.
- **H1 scope, H2 tests, H3 citations** (Haiku): read-only checks below.

Implementer, reviewer and prover stop after 2 failed rounds on the same problem; the coordinator reports to the owner and proposes a card change.

**H1.** Write owned paths into `$S/owned-wpN.txt` (a path ending `/` is a prefix). Expected: no output.

```bash
git diff --name-only origin/main...HEAD | awk 'NR==FNR{o[$0]=1; next} {ok=0; for (p in o) if (p==$0 || (p ~ /\/$/ && index($0,p)==1)) ok=1; if(!ok) print}' "$S/owned-wpN.txt" -
```

**H2.** On the branch point and the branch:

```bash
pnpm --filter @openstyle/server exec vitest run --reporter=json --outputFile="$S/server-after.json"
jq '[.numTotalTests,.numPassedTests,.numFailedTests,.numPendingTests,.numTodoTests]' "$S/server-after.json"
```

Pass: `numFailedTests` 0; `numPendingTests` not above baseline; `numTotalTests` at least baseline plus the card's new cases ([Vitest reporters](https://vitest.dev/guide/reporters.html)). WP-R and WP5b delete tests; their `numTotalTests` may fall by the deleted cases, and the PR lists each. Also `git diff origin/main...HEAD -- '*.test.ts' | grep -E '^\+.*(\.only\(|\.skip\(|it\.todo|xit\(|xdescribe\()'` prints nothing.

**H3.** For each `path:line`, run `sed -n "<line>p" <path>` and compare with the claim; fetch each URL and check the claim. Report claim, result, evidence line.

### 11.7 Merge order

0 Spec PR #186 (the contract; carries the Remix inventory). 1 WP0 and WP-R (frees lockfile and locale files). 2 WP1 (lockfile and SDK for all lanes, B15). 3 WP2. 4 WP10a (before WP6, which runs `check-summary.mts`). 5 WP3 (after WP1, WP2). 6 WP4 (after WP2; spike passes first). 7 WP5a (after WP2, WP3, WP4). 8 WP6 as ready draft (after WP5a, WP10a). 9 WP5b as ready draft (after WP4, WP5a). 10 Candidate branch and council (below). 11 WP6 merge, then WP5b rebase and merge, only after `CONSENSUS: yes` (D12, B16). 12 WP10b docs PR merge (after WP5b). 13 WP7, WP8 (after WP5b). 14 WP9 (after WP5b, WP7). 15 WP11 (cut after the WP10b merge). Then the owner starts the one release (B17).

**WP10b docs branch.** Cut when the candidate exists (step 10). Commit 1, before the first round: harness fixes and skill edits (`run-enhance.mjs --arm new`, `SK/council/SKILL.md`, `SK/pi-briefs/SKILL.md`), so a failed round can fix them. Commit 2, after `CONSENSUS: yes`: the council record. The PR merges right after WP5b (step 12) so the record names merged commits. WP11 edits the same two skills (11.4), so its branch is cut after the WP10b merge. No other order is allowed.

**Candidate build and council procedure** (B18). The coordinator runs it; no agent runs a git step (B1).

1. Entry. WP6 and WP5b are ready drafts. Each passes GT1 to GT4 and its own acceptance; for WP5b that excludes "candidate build" checks.
2. Freeze. From step 3 until the WP5b merge, the coordinator merges no PR except WP6 and WP5b (the PRs that make candidate `S`), and no PR that changes a file under `apps/` or `packages/`, so `main` keeps the base `S` was built on. The WP6 merge (step 8 (a)) is allowed because its head is part of `S`; step 8 (c) proves it. The WP10b PR changes nothing under `apps/` or `packages/` (11.4), so the freeze does not block it. A fix on the WP6 or WP5b head (step 7) makes a new `S`; the freeze then applies to it.
3. Make the branch. `git fetch origin`; `git worktree add -b chore/enhance-candidate ../openstyle-candidate <WP5b head SHA>`; in that worktree `git merge --no-ff <WP6 head SHA>`. Draft PR at birth (B18). 11.4 gives WP5b and WP6 disjoint files, so the merge has no conflict; a conflict means the matrix was broken: fix it in the owning branch, redo step 3.
4. Build and prove. In the worktree: `pnpm install`, GT1 to GT5, full acceptance of WP6 and WP5b including candidate-only checks. CI runs on the candidate PR, so tests that skip on the WP5b PR run there.
5. Record. `git rev-parse HEAD` prints the candidate SHA. The coordinator writes it, with the two head SHAs, in the candidate PR body and in a comment on the WP5b and WP6 PRs. The build under test comes from this SHA only (`--arm new`).
6. Round. WP10b runs its procedure on that build in a scratch profile (10.15).
7. FIX-FIRST or REVERT. The fix is a new commit on the owning branch (WP5b or WP6, 11.4). The coordinator pushes it and repeats steps 3 to 6: `git worktree remove ../openstyle-candidate`, `git branch -D chore/enhance-candidate`, then step 3 with the new heads. The new SHA gets a new round number and new judge files. An old `CONSENSUS: yes` never carries to a new SHA.
8. After `CONSENSUS: yes` for `S`: (a) merge WP6; (b) rebase WP5b on `main`, run `pnpm install` if the lockfile changed (B10), re-run the full WP5b acceptance with no check skipped; (c) `git diff --name-only S HEAD -- apps packages` in the rebased WP5b worktree must print nothing (merged code equals measured code; after squash merges the SHAs differ but the tree under `apps/` and `packages/` is equal); if it prints a file, repeat the round on a new candidate; (d) merge WP5b; (e) close the candidate PR unmerged, remove its worktree, delete its local and remote branch. `bash scripts/branch-closeout.sh` needs a merge, so (e) is manual.

The coordinator merges one PR at a time. After each merge it rebases open lanes, runs `pnpm install` on lockfile conflicts (B10) and `bash scripts/branch-closeout.sh <pr>` (`SK/branch-lifecycle/SKILL.md:34-38`). A quality change needs the council verdict in the PR before `--auto` (`:19`). WP5b is the first PR that changes transcript output and carries the whole renderer switch (8.9), so users see failure notices and Resume from the WP5b merge on. The inspector arrives with WP7. A failed run never shows nothing, and B17 keeps a release out of the gap.

### 11.8 Decisions that shape this section (2026-10-17)

Source: owner statements of round 2 (chat, 2026-10-17; each row carries its text). Each row removes a question from the open list of 12.2. "Owner" = stated by the owner; "viewpoint" = decided from the owner viewpoint.

| # | Decision | Effect |
|---|---|---|
| 1 | Owner: no feature flag. The new workflow replaces the old Enhance and Summary path directly. WP5b switches routes and renderer. Council consensus before the WP5b merge. | No flag key, toggle, dual contract, WP5c. B16, WP5b, WP7, 11.7. |
| 2 | Owner: the Enhance trigger (auto-run and button) chains into Summarize in the same run. The Summarize button stays. A later speaker name makes the summary stale; the warning stays. | WP6 before WP5b; WP5b starts `["enhance","summarize"]`. |
| 3 | Owner: the inspector shows prompts of imported meetings as of recorded ones. | WP7. |
| 4 | Owner: 4 open PRs during the build. `WIP_LIMIT` 4, then 2. | B6, WP0, WP11. |
| 5 | Owner: no cloud live proof. Only the owner's oMLX with Qwen3.8-27B. Cloud paths keep scripted tests and stay UNVERIFIED. | B14, WP3, WP6, WP5b. |
| 6 | Owner: no fixed bundle limit. Each PR reports growth. | Size rule; WP4, WP5a, WP8, WP9, WP11. |
| 7 | Owner: meeting `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6` reproduces #163 (VERIFIED, WP10a card). | WP10a, WP10b. |
| 8 | Owner: no separate release for WP1 and WP2. One release. | B17; 11.3. |
| 9 | Owner: `callUnit` is the single retry layer, one retry per call, `gatewayRetryOn`. No node `RetryPolicy`. AI SDK `maxRetries` 0. | WP5a, WP3 "must not". |
| 10 | Owner: pi judges on the pin `openai-codex/gpt-6.1-sol`. Benchmark meetings go to pi and Codex with no per-data-set approval, in this development. | B12, WP10a, WP10b; D12 (1.1). |
| 11 | Owner: the summary schema has five fields (overview, key points, decisions, action items, open questions), rendered to Markdown under five headings by code. The pre-merge check is automatic only. No owner side-by-side read. | WP6, WP10b. |
| 12 | Owner: the structured summary is also stored in `meeting_summaries.summary_json`; migration 40 adds the column; `save` writes it. | WP2, WP5a, WP6. |
| 13 | Owner: a confirmed speaker name or new `enhanced_text` while a Summarize run is interrupted fails its resume with `transcript_changed`; same for a confirmed name while a chained run is interrupted (3.4.7 guard 6). | WP5b accept (7). |
| 14 | Owner: before the boot resume of an interrupted cloud run, the app may send one `HEAD` (no key, no meeting data) to that run's base URL. | WP5b accept (8). |
| 15 | Owner: the LLM framework is a generic platform under `S/lib/llm/` (gateway, model profiles, typed errors, `callUnit`, recorder, run registry, checkpoint saver, workflow helpers, tracing). `llm_runs`, `llm_calls` carry `scope`, `scope_id`; links by (`target_type`, `target_id`); nullable `meeting_id` FK on `llm_runs` only keeps delete-with-meeting. Meetings are the first consumer. The inspector UI stays meeting-only; its data API and types are generic. | Path key; 11.4; Check P; WP2 to WP5b. |
| 16 | Owner: remove Remix now, as its own WP with exclusive file ownership; it also leaves the AI SDK v7 migration. Inventory D1 to D6 are in the WP-R card. | WP-R, WP1, B15. |
| 17 | Viewpoint: `job_error` for Summarize goes away (O8-2); the run record holds the failure. | WP5b. |
| 18 | Viewpoint: Summarize runs export traces like Enhance runs; dictation cleanup never exports (Q9.6). | WP8. |
| 19 | Viewpoint: WP5b deletes the old path in the same PR that switches the routes; one path, no dead file (B9). Helpers move first, in WP5a. | WP5a, WP5b. |
| 20 | Viewpoint: WP5b is a ready draft during the council and merges after `CONSENSUS: yes`; a switch with no flag must not reach `main` before the judges agree. | B16, 11.3, 11.7. |
| 21 | Viewpoint: the Remix `DROP TABLE` and settings-row delete sit in migration 40 of WP2; one migration per release; user text in `remix_runs` leaves the disk. | WP-R, WP2. |

Unverified items: the WP0 skill line wording; whether a PR comment resets the idle clock (B5); the commands of Check B and Check P; the Remix counts of the inventory (STATIC); the lockfile effect of WP-R; local viability of `build:unpack` (WP9).

---

## 12. Risks, decisions and rollout

### 12.1 Risks

UNVERIFIED = not proved in this repo. Last column = WP that proves the control. WP-R removes Remix (11.2). No feature flag, no second code path (Q1).

| ID | Risk and evidence | Control | WP |
|---|---|---|---|
| R1 | WP1 breaks dictation for all users (D7 is global): a v7 model in a v6 `generateText` fails and dictation pastes raw text silently. | Wire snapshots pinned to v6; real-app dictation proof with negative control; WP-R lands before WP1; proof runs before the one release (Q8) | 1 |
| R2 | Asar growth. Target about 9 MiB (`AGENTS.md:87`); last measure 8.98 MiB, 2026-09-03 (`specs/lean-audit-2026-09.md:257`), not re-run at c47cd80d (UNVERIFIED). `@langchain/langgraph` 1.5.1 is 4.57 MB unpacked ([npm](https://registry.npmjs.org/@langchain/langgraph/latest)); a research run counted 22 packages, 54.6 MB with `@langchain/core` (upper bound; bundled size UNVERIFIED). Tracing adds 19.0 MB, 3.70 MB JS. | No fixed limit (Q6). Each dependency PR reports `du -sk apps/electron/out` and asar size before and after. Tracing loads by `import()` only when on. | WP-R, 1, 4, 5a, 8, 9 |
| R3 | ESM-only v7 packages or dynamic requires fail in the CJS bundle ([guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)). The guard reads top-level files and literal `require("x")` only (`apps/electron/scripts/check-bundled-requires.mjs:34,26`). A real v7 and LangGraph build is UNVERIFIED. | WP1 extends the guard with a red proof; GT5 per dependency WP; packaged build in WP9 | 1, 5a, 9 |
| R4 | `apps/server/tests/setup.ts:16` fakes timers for every server test; Vitest fakes `setTimeout`, not `nextTick` ([Vitest](https://vitest.dev/api/vi.html)). Other LangGraph parts UNVERIFIED (U7, 3.7). | `vi.advanceTimersByTimeAsync`; per-file opt out (`apps/server/tests/trace.test.ts:34` calls `vi.useRealTimers` in `beforeAll`; line 40 restores fake timers in `afterAll`); no WP edits `setup.ts` (11.4); first test of WP4, 5a, 8 uses a timer | 3, 4, 5a, 8 |
| R5 | oMLX may keep `json_schema` best effort (peer report, not verified: `/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/omlx-structured-output-peer-finding.md`); it reports `tool_calls` when `max_tokens` cuts a tool call (`/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:131`). | zod-validate every answer; handle `length` (4.0.6); send no tools; live probe on the owner's oMLX (N10) | 3, 5a, 9 |
| R6 | Some providers do not enforce a strict schema ([Groq](https://console.groq.com/docs/structured-outputs), [OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs)). `@ai-sdk/openai-compatible` drops the schema when `supportsStructuredOutputs` is false ([source](https://github.com/vercel/ai/blob/b7f6255acaae7724adc0fd37aac3dae3f3466578/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts#L250-L306)). The Groq error for an unsupported model is UNVERIFIED. | Mode table and cache; OpenRouter `require_parameters`. No cloud live proof (Q5); scripted-model tests only; release notes say so. | 3 |
| R7 | Mixed `ai` copies: `ai@6.0.191` and `ai@6.0.240` (`pnpm-lock.yaml:2884,2890`); `packages/stt/package.json:53` has its own `ai`; `@ai-sdk/otel` pins `ai` 7.0.143 ([npm](https://registry.npmjs.org/@ai-sdk/otel/latest)). | WP1 moves all copies in one PR | 1 |
| R8 | New schemas fill the oMLX grammar cache, about 0.45 GB each (`/Users/maheidem/Documents/dev/omlx-management/docs/troubleshooting.md:140`). | One fixed schema per node (L5), including the summary schema (Q11); test compares schema sets of two meetings | 5a, 9 |
| R9 | Transcript quality gets worse. #163: 2 of 8 chunks failed, zero speaker rows ([issue](https://github.com/Maheidem/openstyle/issues/163)); no Enhance metric today (`scripts/meeting-v2/metrics.mjs:636`). No flag, so a bad change ships on merge. | D12: benchmarks and council, 3 runs per arm, on a candidate branch. WP5b and WP6 merge only after council `SHIP` (S3). | 10a, 10b |
| R10 | Retries multiply. SDK default is 2 ([docs](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)); default LangGraph `retryOn` ignores `statusCode` ([docs](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)). | `maxRetries: 0`; one layer, `callUnit` (Q9, 5.6); no node `RetryPolicy`; request counts at a fake server through the whole graph (G5) | 3, 5a |
| R11 | Saver drifts from the base class. `node:sqlite` is "Stability: 1.1 - Active development" ([Node](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)); the suite may reject our FKs (O7-3). | Exact `@langchain/*` pins; conformance suite in CI; saver is a platform part in `apps/server/src/lib/llm` (Q16) | 4 |
| R12 | A resumed run repeats an LLM call, or resume fails after a kill in a fan-out. `async` durability can lose the last checkpoint ([docs](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)); `invoke(null, config)` after a kill in a `Send` super-step is UNVERIFIED (U2, 3.7). | `durability: "sync"`; attempt number in the record; WP4 spike settles U2 first (SP1, manual `SIGKILL` script, 3.7); live kill in WP5b | 4, 5b, 9 |
| R13 | New E2E specs may pass the CI E2E 5-minute limit (`.github/workflows/build.yml:203-204`). Run times are UNVERIFIED. The earlier claim of 64 to 75 s in 11 runs on 2026-10-17 is not supported. Run [39054313843](https://github.com/Maheidem/openstyle/actions/runs/39054313843) (2026-10-17, success) took 10 m 13 s in total. Its E2E job took 2 m 49 s. WP-R deletes Remix specs. | Fake-server specs, few specs, read step time | WP-R, 9 |
| R14 | Records grow the DB: about 0.6 MiB per 40-chunk run; D10 sets no age limit; retention keeps DB rows (`apps/server/src/lib/meetings/retention.ts:12-17`). Decided: no limit (O7-1). | WP9 measures a long run and reports size | 9 |
| R15 | Prompts leave the machine, or LangSmith turns on. App promises no telemetry (`AGENTS.md:9`); the server child gets all env of main (`apps/electron/src/main/server-host.ts:200-215`); LangChain tracing turns on when one of four variables is `true` ([source](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/utils/callbacks.ts)). | OTel needs both variables; a planned file `load-graph.ts` removes the four (not in the baseline repo, UNVERIFIED; 3.1 rule 2); test GR3 (10.8); WP8 updates `AGENTS.md:9` (the telemetry line; the WP8 plan text is UNVERIFIED); real-meeting runs keep variables unset (B12) | 5a, 8 |
| R16 | Enum words drift. P7 (7.2) puts no `CHECK` on enums, so a wrong word is stored and the UI shows `unknown`. 11.4 settles run status (`succeeded`), verdict codes, step keys; `scope` word `meeting` is one more. | Reviewer checks every enum word against 11.4 | 2 |
| R17 | Parallel lanes conflict on shared files; up to 4 PRs open (Q4). | Matrix, 11.7 order, H1, B10 | all |
| R18 | A release cut between merges ships a half-done change (no flag). | Merge order (12.3): dark parts first; WP5b and WP6 (route switch) last, after council `SHIP`. No release until all WPs merge (Q8). | 5b, 6 |
| R19 | Remix removal breaks a shared file (dictation, Settings, task registry, locales, onboarding, tests, site); a dangling import fails the build late. | WP-R has exclusive file ownership (11.4). Gates: `tsc`, `knip`, Remix grep and allow list (10.14.1), locale key check, real-app run of dictation, Settings, onboarding (10.11). | WP-R |
| R20 | Tracing: large trace for a long meeting; unfinished trace after a resume; legacy integration may leave the SDK; a Finder launch may not pass the variables. | Live checks C1 to C10 (9.9) | 8 |
| R21 | Meeting-specific code enters the generic platform layer (Q16). | `apps/server/src/lib/llm/` imports nothing from `lib/meetings` today (only comments name it: `apps/server/src/lib/llm/lane.ts:32,76`). The import-check test is planned. No such test exists in the baseline (UNVERIFIED). Tables carry `scope`, `scope_id`; meetings link by nullable `meeting_id` FK (7.2). | 2, 3, 4, 5a |
| R22 | Summary changes from free Markdown to a schema that code renders (Q11); pre-merge check is automatic only. | planned script `check-summary.mts` (4.5.6; not in the baseline repo) on every data set: five checks and counts (`specs/meeting-enhance-agentic.md:4271`). Five headings: today's four names and `Open Questions`. Revert of WP6 restores the old path. | 6, 10b |
| R23 | A Summarize run is interrupted; then a name is confirmed or Enhance writes new `enhanced_text`; resume fails with `transcript_changed` (Q13). | Typed, visible failure; screen offers a new run; test in WP5b (guard 6, 3.4.7) | 5b |

### 12.2 Owner decisions

All answers are dated 2026-10-17. No question blocks the build. Q18 carries a default that stands unless the owner changes it. The coordinator shows it once with `AskUserQuestion` at S0; a change is edited into the Q18 row before the spec PR merges. No question is asked at run time. IDs Q1 to Q18 stay, because other sections cite them.

| ID | Decision | Reason and effect | Applies to |
|---|---|---|---|
| Q1 | C. No feature flag. WP5b replaces the old Enhance and Summary path directly. No key `meeting_enhance_workflow`, no toggle row, no dual contract. | Council consensus BEFORE WP5b and WP6 merge (`SK/branch-lifecycle/SKILL.md:19`). The renderer reads one contract: 202 (3.4.2). | WP5b, WP6, WP7 |
| Q2 | B. The Enhance trigger chains into Summarize in the same run, for auto-run (`meeting_enhance_auto_run`) and the Enhance button. The Summarize button stays. | A confirmed name later makes the summary stale; the stale warning stays (3.6). A chained auto-run adds up to 24 long calls. | WP6 |
| Q3 | A. The inspector shows prompts for imported meetings as for recorded ones. | Records stay on the Mac; advanced mode needed. | WP7 |
| Q4 | Up to 4 open PRs during the build. `WIP_LIMIT` is 2 today (`scripts/branch-status.sh:21`). The build raises it to 4, then returns it to 2. | Script prints `!!` above the limit (`scripts/branch-status.sh:48`). The coordinator makes both edits as small PRs. | wave 2, end of build |
| Q5 | No cloud live proof. Only the owner's local oMLX (Qwen3.8-27B) gets live proofs. | Cloud paths: scripted-model tests, UNVERIFIED (R6). Agents never enter keys. | WP3 cloud rows |
| Q6 | No fixed bundle limit. Each PR reports `du -sk apps/electron/out` and asar size (G11, 1.2). | The owner reads the growth. The 1 MiB proposal for WP8 (Q9.4) is withdrawn. | all dependency WPs |
| Q7 | Meeting `ca70f895-ebe9-47e3-b663-eeb2c7bd97a6` reproduces #163. VERIFIED: `/tmp/meeting-v2/r9b.log` lines 3, 8, 23, 28, 48, 53 show `chunksAttempted` 8, `chunksFailed` 2 in 6 of 6 arm A tries; `/tmp/meeting-v2/run-arms.mts:10` sets this id; see `specs/meeting-transcription-v2.md:483-486`. | Data set for WP10a, 10b. | WP10a, 10b |
| Q8 | No separate release for WP1 and WP2. One release for all work, triggered by the owner. | WP1 proofs (R1) run before it. | release |
| Q9 | Single retry layer: `callUnit`, one retry per call, `gatewayRetryOn` rule. No node `RetryPolicy`. AI SDK `maxRetries` is 0. | A node `RetryPolicy` would re-run finished calls of a many-call node (5.6, X7). | WP5a |
| Q10 | pi judges on the current pin `openai-codex/gpt-6.1-sol`. The owner says the benchmark meetings are safe for that provider in this development; no approval per data set. Pin file is outside this repo (no `file:line`). Source: `pi_list_agents` with `doctor`, 2026-10-17, and `/Users/maheidem/.claude/projects/-Users-maheidem-Documents-dev-openstyle/memory/keep-using-pi.md:17`. That `openai-codex` is a cloud provider is UNVERIFIED. | WP10b corrects the council skill line that calls pi local (`SK/council/SKILL.md:26`). This development only. | WP10b |
| Q10b | Codex: the benchmark meetings (`ca70f895` and control meetings) may go to Codex without approval per data set in this development (owner statement, 2026-10-17). Changes D12 ("Codex only with owner approval per data set") and `SK/council/SKILL.md:27`. | Other meetings still need an owner decision. WP10b updates the skill text. | WP10b |
| Q11 | No flag. The summary uses a schema with five fields: overview, key points, decisions, action items, open questions. Code renders them to Markdown (4.5). Pre-merge check is automatic only: section and count checks (10.15). | One fixed schema (L5). R22 records the cost. | WP6, WP10b |
| Q12 | B. The summary object is also stored in new column `meeting_summaries.summary_json`. Migration 40 adds it (7.4); the save step writes it (4.6.1). | Later code reads decisions and action items as data (P8). `INSERT OR REPLACE` (`S/routes/meetings.ts:1214-1216`; table `S/lib/schema.ts:790-799`) gets one more column. | WP2, WP6 |
| Q13 | A. A confirmed speaker name, or new `enhanced_text`, while a Summarize or chained run is interrupted fails the resume with `transcript_changed` (3.4.7 guard 6). The user starts again. | The summary prints the confirmed name and enhanced text (4.5); a resume would mix old and new. The screen already warns when names change after a summary (3.6). | WP2, WP5b |
| Q14 | Withdrawn. No flag, so no toggle row. | Moot (Q1). | none |
| Q15 | A. Before the boot resume of an interrupted cloud run, the app may send one `HEAD` request to the provider base URL the run already used. No key, no meeting data. | No new host. `AGENTS.md:9` says outbound calls go only to configured STT and LLM providers, but code differs today: update check calls the GitHub release feed every 5 minutes with Automatic updates on by default (`E/main/updater.ts:26,33-34,69-71,175-182`; the switch is `readSettings().autoUpdate !== false` at `E/main/updater.ts:82`; `apps/electron/electron-builder.yml:90-93` only sets the publish provider); after an update download, main starts an MLX worker prefetch from GitHub (`E/main/updater.ts:150`; `S/lib/mlx-asr/runtime.ts:469-493`), only on Apple Silicon with an MLX model on disk (`S/lib/mlx-asr/runtime.ts:472`); a Whisper model download calls huggingface.co (`S/lib/whisper/models.ts:220`). | WP3, WP5b |
| Q16 | Generic platform layer. Domain-agnostic parts live in `apps/server/src/lib/llm/` (today it holds only `lane.ts`, `registry.ts` and `task-profiles.ts`; the rest is a planned layout): gateway, model profiles, typed errors, `callUnit` retry, call recorder, run registry, checkpoint saver, workflow helpers, tracing. `llm_runs` and `llm_calls` carry `scope` (for example `meeting`) and `scope_id`. Links use `(target_type, target_id)`. Meetings keep `ON DELETE CASCADE` through a nullable `meeting_id` FK, so delete with the meeting (D10) holds. Meetings are the first consumer, under the planned path `apps/server/src/lib/meetings/workflow/` (does not exist today; meeting code is flat in `apps/server/src/lib/meetings/`). Inspector UI stays meeting-only; its data API and types are generic. | The owner will extend agentic features to other areas. R21 is the control. | WP2 to WP8 |
| Q17 | Remove Remix now, in WP-R, with exclusive file ownership: renderer pages and components, remix bar window, main-process windows, hotkeys, IPC, server routes and libs, the `remix` task id and profile UI, settings keys, onboarding, help and tutorial text, locale keys, tests, E2E specs, spec and doc references (`specs/remix.md:3` is marked Stale, not a current spec), any site mention. | The owner will redo Remix later on the new platform. No Remix code moves to v7; `@ai-sdk/react` stays only if another file imports it (Q-A). R19 is the control. | WP-R, WP1 |
| Q18 | DEFAULT 2026-10-17 (owner viewpoint), stands unless changed at S0. May the council rounds of #185 run on the three benchmark meetings (`ca70f895-ebe9-47e3-b663-eeb2c7bd97a6`, `2943c36a-532e-4db9-af09-b5e66f0bdf2d`, `9243bea0-567f-443b-bf3b-9980f69993fd`) with MLflow variables unset? Default: yes, one waiver for every round of #185 on these meetings, as rounds r9, r9b, r9c had (`MV2:483-486`). Other choice: trace to the owner's MLflow (`http://192.168.31.154:5000`) and read each trace back. Owner change (answer and date): none recorded. | The owner already accepts that benchmark meetings go to his own providers in this development (11.8 row 10). B12 keeps variables unset, which breaks the always-trace rule of `CM`; that rule is the owner's, so the default needs his approval at S0. One answer covers all rounds, including repeats after FIX-FIRST (11.7 step 7). WP10b asks nothing and applies the row as it reads at merge (WP10b step 0). | WP10b |

#### Sub-questions of sections 3 to 9

Decided 2026-10-17 by the coordinator with the owner's viewpoint: favor the generic platform, replace directly, chain stages, store structured data, measure instead of setting limits, keep local-first, keep D1 to D12.

| ID | Decision |
|---|---|
| OQ-1 (3.7) | Resume once at launch, then wait for the Resume button (G6). A cloud run first passes the `HEAD` probe (Q15) and can cost money (S5). |
| OQ-2 (3.7) | Same as Q2: chained. The job kind changes at the stage change (`setJobKind`, 3.6). |
| N1 (4.7) | Keep `keyPoints` beside the Q11 fields: prompts need them (`M/summary-prompt.ts:12-18,34,50`). |
| N2 | Keep today's rules; send no "Me" lines. The benchmark measures a turn-taking rule first. |
| N3 | Keep English cues. A pattern list per language is a later change. |
| N4 | Title and user context go to `identifySpeakers` only. |
| N5 | A user preset wins and the call record shows a warning (5.5.2). |
| N6 | A re-run resets `enhanced_text` of an `ok` chunk with no correction to `NULL`. |
| N7 | The benchmark tunes the starting constants (D12). |
| N8 | The spelling fix runs before the conflict policy, so two spellings of one person join. |
| N9 | Two task ids (section 4 sets which nodes use which). A new id needs only a registry row. The registry stays generic (Q16). |
| N10 | A live probe on the owner's oMLX settles whether a strict schema also covers the reasoning part (10.12 LP2). |
| O7-1 (7.15) | No limit on the record (D10). WP9 measures and reports growth (Q6). |
| O7-2 | Closed: the runner deletes checkpoints at every final status and keeps them only for `interrupted` (3.4.6 step 5). |
| O7-3 | Run the validation suite with production FKs first. If it fails, use the 7.9 fallback: drop the FK from `thread_id` to `llm_runs`, add an `AFTER DELETE` trigger, record it in R11. |
| O7-4 | No `trace_id` in `llm_calls` (9.10). |
| 5-Q1 (5.10) | Keep the always-on full-body trace log for `server` unchanged; outside this work, stays on the owner's Mac. |
| 5-Q3 | Do not change the owner's oMLX settings. The live proof reads the served model and fails on a mismatch (L4). |
| Q-A (6.11) | Put `ai` and `@ai-sdk/provider-utils` in the pnpm catalog. `@ai-sdk/react` goes there only if `knip` and `pnpm why` show another importer after WP-R (RM8, 10.14.1). The inventory expects none. |
| Q-B | Keep the CJS output of the stt package; WP1 does not change its build. |
| Q-C | Moot. `toUIMessageStreamResponse` is called only in `S/lib/remix-agent.ts:123`; WP-R deletes it. |
| O8-1 (8.13) | Keep the bottom-docked panel. The live proof can still move it to a full pane. |
| O8-2 | `job_error` for Summarize goes away; the persisted run holds the failure. |
| O8-3 | No "Inspect" entry on speaker chips. |
| Q9.1 (9.11) | Variables only. No setting key, no UI. |
| Q9.2 | Traces hold content; the MLflow server is the owner's. |
| Q9.3 | The variable holds the experiment id. |
| Q9.4 | No fixed limit. WP8 reports asar growth (Q6). |
| Q9.5 | No dictation cleanup in MLflow. Remix is gone (Q17). T8 stays. |
| Q9.6 | Both kinds export when both variables are set. |
| X0 to X8 (3.7, 11.4) | Checks between sections, run by the reviewer. Open facts keep UNVERIFIED until a live run settles them. |

### 12.3 Rollout plan

One release, triggered by the owner (Q8). Main can receive PRs before it, but no release is cut until S1 to S4 and close-out WP11 are done. The old path goes away in the PR that replaces it. WP5b and WP6 are the only PRs that change user-visible Enhance and Summarize behavior (R18). Every run writes call records from the first merged run (G7). After the build, `WIP_LIMIT` returns to 2 (Q4).

| Stage | What happens | Entry gate | Rollback |
|---|---|---|---|
| S0 | Spec PR #186 merges. Open draft today (`specs/meeting-enhance-agentic.md:6`; `gh pr view 186` on 2026-10-17: state OPEN, `mergedAt` null; [PR #186](https://github.com/Maheidem/openstyle/pull/186)) | Owner approves; he may change the Q18 default | Close the PR |
| S1 | Dark and removal parts merge: WP-R, WP1 (SDK v7), WP2 (migration 40, recorder, read routes), WP3 (gateway), WP4 (saver), WP5a (graph). No route calls the new code. Remix is gone. | Each card passes. Dictation proof after WP1. Bundle growth reported (Q6). | Revert the PR. Migration 40 is additive; an older build opens a v40 file (`S/lib/schema.ts:168`) |
| S2 | Benchmarks. WP10a records the old-path baseline on `ca70f895` and control meetings before any route change. A CANDIDATE branch holds the WP5b head merged with the WP6 head (11.7); nothing is merged. WP10b runs after-runs on it in a scratch profile (live-testing skill: use a scratch profile, not the owner's installed app or data; UNVERIFIED line ref. Benchmark rule 1 at `.claude/skills/meeting-benchmarks/SKILL.md:14` lets runs read the owner's real folder and DB read only), then the council. | WP10a baseline exists; candidate build runs | Stop. Fix the branch and repeat. |
| S3 | Council decision. Claude, pi and Codex all say `SHIP` (D12; Q10, Q10b). Summary gate: automatic section and count checks pass (10.15, Q11). Then WP6 merges, WP5b is rebased on `main` and its full acceptance runs again (11.7 step 8), then WP5b merges. `FIX-FIRST` or `REVERT` blocks the merge. | Council consensus; own acceptance of WP5b and WP6 passes on the candidate build; W12 passes | `git revert` of the WP5b and WP6 PRs restores the old routes. Data model unchanged. |
| S4 | WP7 (inspector UI) and WP8 (tracing) merge after WP5b. WP9 (E2E specs) merges after WP7 and must pass on `main`. The owner runs the real flow once by hand. | S3 done | Revert the PR |
| S5 | The owner triggers the one release. Cloud paths ship with scripted-model tests only, UNVERIFIED (Q5); release notes say so. | S1 to S4 and WP11 done; no open regression issue; owner decision | Revert and re-release; `git revert` of WP5b and WP6 PRs |

### 12.4 Data compatibility

| Item | What happens |
|---|---|
| Old `enhanced_text` rows | Stay. The transcript shows `enhancedText ?? text` (`E/renderer/src/pages/meetings/detail.tsx:862-866`). |
| Old meetings and summaries in the inspector | No records; empty lists; "No LLM record" (8.7). Old `meeting_summaries` rows keep `summary_json` as `NULL`; the renderer shows their Markdown as today. |
| Records of new runs | Carry `scope` and `scope_id`. Link to segments, speakers and summary by generic keys `(target_type, target_id)`, not FKs (P3, 7.2). A re-transcribe deletes those rows and the records stay (WP2 test). The nullable `meeting_id` FK cascades, so deleting the meeting deletes its records (D10). |
| New run on an old meeting | Rewrites `enhanced_text`; an `ok` chunk with no correction resets its segments to `NULL` (N6); never writes `confirmed_at` or `display_name` (4.6.1). A chained run then writes a new summary and `summary_json` (Q2, Q12). |
| Downgrade | An older build opens a v40 DB (`S/lib/schema.ts:168`) and ignores new tables and column; meeting delete still cascades. Migration 40 also drops `remix_*` tables and Remix settings rows, so a pre-removal build fails only on Remix routes. |
| Remix data | Migration 40 (WP2) drops `remix_messages`, `remix_runs`, `remix_threads` and deletes settings rows `remix_hotkey`, `remix_bar_enabled`, `remix_enabled` (11.8 row 21), outside the `tableExists(meetings)` guard. Text the user selected in other apps (`remix_runs`) leaves the disk. The drop cannot be undone; the owner accepted it with Q17. A stored `remix` key in `llm_task_assignments` is ignored on read and dropped on the next Models save (WP-R accept 6). |
| Job kind, settings, exports | Kinds stay `enhance` and `summarize`; the one-second poll works (`detail.tsx:122-127`). No new flag key. `save` rewrites `transcript.md` and `transcript-enhanced.md` as today (4.6.5). `meeting_summaries` gets nullable `summary_json` (Q12); the object is also in `llm_calls.parsed_json` of the final call. |
| Checkpoint data | Run state, not user data. Deleted at every final status (`succeeded`, `partial`, `failed`, `cancelled`); kept only for an `interrupted` run, the only run that can resume (3.4.6 step 5, 7.9, O7-2). A Summarize resume fails with `transcript_changed` after a name confirm or new `enhanced_text` (Q13). GR17 tests the deletion rule (10.8). |
