---
name: cloud-models
description: Update the cloud model line-up of Openstyle (Anthropic, OpenAI, Google, Groq, Mistral LLMs and the cloud speech-to-text models) - lists, retired ids, legacy notes, sampling rules. Use when the owner says the cloud lists are behind, when a provider ships or retires a model, or before a claim that a cloud model "works".
---

# Cloud models

## Where the lists live

- `apps/server/src/lib/cloud-models.ts`: the curated line-up (`CLOUD_LLM_LINEUP`, `CLOUD_VOICE_LINEUP`) and the lifecycle table (`LIFECYCLE`: retired or legacy ids, with the shutdown date and the replacement).
- The LLM list in the picker comes from the models.dev registry (`model-registry.ts`). The line-up is merged on top, so a new model shows when models.dev is late or offline.
- `apps/electron/src/renderer/src/lib/models.ts`: `VOICE_META` (speed, quality, cost, note) for each cloud speech model.
- Wire rules per provider: `llm/model-profiles.ts` (`reasoningWire`) and `llm/registry.ts` (`googleIgnoresSampling`). The AI SDK already removes the sampling parameters of Claude 4.7 and later and of GPT-6. Check `getModelCapabilities` in the installed `@ai-sdk/anthropic` before you add a rule.

## Steps

1. Read the provider pages as raw text (`timeout 20 curl -sL`). OpenAI and Mistral give `.md` pages. Google gives `.md.txt`. Anthropic pages need an HTML strip. Sources are named at the top of `cloud-models.ts`.
2. For each provider write down: newest ids, context, max output, price, modalities, retired ids, legacy ids, and which parameters the model rejects (temperature, top_p, top_k, thinking switch, reasoning effort levels).
3. Edit the line-up and the lifecycle table. Mark an id `retired` only when the provider page says it no longer works. Otherwise mark it `legacy`.
4. Run `cd apps/server && pnpm test` (the wire test `cloud-models-wire.test.ts` builds each request with the real SDK) and `cd apps/electron && pnpm test`.
5. Prove the picker in the real app (see `live-testing`, UI proof recipe). Use no real key.

## Known facts (2026-10-30)

- A retired id is replaced in the saved default and in `createChatModel` (same provider, same tier). The log line says so.
- Claude Fable 5.x and Opus 5.5 cannot stop thinking: the app sends effort `low`. Sonnet 5.5 takes `between_tools`. Claude 4.7 and later reject `temperature`, `top_p` and `top_k`.
- Mistral Large 4 and GLM 5.3 have no `none` reasoning effort. Small 4 has.
- `gpt-live-transcribe` has no file endpoint. A file call uses `gpt-transcribe`. Both take `languages`, not `language`.
- Groq lists Llama 3.1 8B and Llama 3.3 70B only for Enterprise after 2026-08-16. They stay `legacy`.
