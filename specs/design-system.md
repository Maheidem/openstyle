# Design system — reskin foundation

Status: foundation landed (tokens, fonts, base component shapes). Screen-by-screen
application to individual pages is a follow-up pass — see "What's NOT done yet"
at the bottom.

Reference mockups: [`specs/design/reskin-mockups.html`](design/reskin-mockups.html)
(approved direction, copied verbatim from the design exploration — do not edit,
treat as source of truth for pixel-level details not captured here).

## Token sheet

### Light

| Token | Value | Role |
|---|---|---|
| `--background` (ground) | `#F6F7F9` | Window/sidebar background |
| `--card` (surface) | `#FFFFFF` | Cards, content panes, popovers |
| `--foreground` (ink) | `#1D2129` | Primary text |
| `--muted-foreground` (muted) | `#6B7280` | Secondary text |
| `--border` / `--input` (hairline) | `#E5E7EB` | Dividers, card borders |
| `--secondary` / `--muted` | `#EEF0F2` | Neutral fill (secondary buttons, muted chips) |
| `--accent` | `#E5E7EB` | **Neutral** hover/focus tint (dropdown items, combobox rows) — deliberately NOT blue, see "Accent discipline" |
| `--primary` | `#1D2129` (ink) | Default button fill — mirrors the mockup's `.btn-ink` primary action |
| `--destructive` | `#DC2626` | Danger actions — deliberately distinct from the live coral, see "Accent discipline" |
| `--ring` | `#2563EB` | Focus ring — the one blue usage outside the accent-passive fence, treated as a system affordance |
| `--chart-1..5` | `#2563EB` `#1D4ED8` `#3B4E6B` `#6B8CAE` `#1D2129` | Calm speaker/series ramp, all blue/ink family, zero coral (see "Speaker chart ramp") |
| `--sidebar-primary` | `#2563EB` | Reserved for identity/selected affordances inside the sidebar |
| `--accent-passive-tint` (new) | `#E8F1FC` | Selected-nav background, identity/diarization-speaker chip fill |
| `--accent-passive-ink` (new) | `#1D4ED8` | Text/icon color on `--accent-passive-tint` |
| `--live` (new) | `#E4574D` | Recording / live / in-progress ONLY |
| `--live-tint` (new) | `#FBEAE8` | Background for live badges |

### Dark

Derived light-first: same roles, ground/surface/ink swap, accent hues lifted for contrast.

| Token | Value |
|---|---|
| `--background` | `#17181B` |
| `--card` | `#1F2126` |
| `--foreground` | `#E8E9EB` |
| `--muted-foreground` | `#8B8F98` |
| `--border` / `--input` | `#2E3138` |
| `--secondary` / `--muted` / `--accent` | `#2A2D33` |
| `--primary` | `#E8E9EB` (light ink, inverted) |
| `--destructive` | `#F87171` |
| `--ring` / `--chart-1` | `#5B8DEF` (lifted accent blue) |
| `--chart-2..5` | `#7DA2F5` `#7C8CA6` `#4D6A8F` `#E8E9EB` |
| `--sidebar-primary` | `#5B8DEF` |
| `--accent-passive-tint` | `rgba(91, 141, 239, 0.16)` |
| `--accent-passive-ink` | `#8FB4F5` |
| `--live` | `#E86A60` |
| `--live-tint` | `rgba(232, 106, 96, 0.16)` |

All existing var **names** were kept stable (Tailwind's `@theme inline` mapping and
every `bg-*`/`text-*`/`border-*` utility class in components keep working unchanged)
— only values changed, plus a small set of new, additive tokens
(`--accent-passive-tint`, `--accent-passive-ink`, `--live`, `--live-tint`) for the
blue/coral fences that didn't have a prior equivalent.

## Type roles

- **Display** (`Space Grotesk`, self-hosted, weight 500, `-0.02em` tracking,
  `line-height: 1`) — the `.display` utility class, replacing `.serif`/`.serif-italic`.
  Headlines, page titles, hero copy.
- **Body / UI** (`Urbanist`, self-hosted, weight range 300–800, italic included) —
  the default `body` font and Tailwind's `font-sans` utility (now mapped via
  `--font-sans` in `@theme inline`, previously unmapped and falling back to
  Tailwind's system stack).
- **Mono / data** (`JetBrains Mono`, self-hosted, unchanged from before) — the
  `.mono` utility class and Tailwind's `font-mono` utility (now mapped via
  `--font-mono`, same fix as above).

### Font-related decisions made without a live human sign-off (subagent, no interactive user)

1. **`.serif` + `.serif-italic` collapsed into one `.display` class, and the
   two-tone headline treatment is now fully retired, not just de-italicized.**
   Space Grotesk ships no italic weight, so `serif-italic` had nowhere to go —
   dropping italic was the easy part. The bigger effect: this pass also sets
   `--primary` equal to `--foreground` (both are ink, in light and dark), which
   several call sites paired as `serif text-foreground` heading +
   `serif-italic text-primary` inner span for a two-tone effect. With `--primary`
   now identical to `--foreground`, that inner span is the same color as the rest
   of the heading — the two-tone effect is gone entirely, not preserved via color.
   This actually matches the approved mockup, which has **no** two-tone headline
   at all (`.content h2.page-title` is single-color `var(--ink)`), so the
   retirement is correct, not a regression to paper over — but the now-redundant
   inner `<span className="display text-primary">` wrapper at these 7 call sites
   should be flattened into the parent heading during the screen pass:
   `dictionary.tsx:420`, `settings.tsx:811`, `vocabulary.tsx:568`,
   `meetings.tsx:1180`, `models/page-chrome.tsx:42`, `onboarding.tsx:945`.
   (`models/pair-card.tsx:150` uses `text-muted-foreground` instead of
   `text-primary`, so it still contrasts and needs no follow-up.)
   `history.tsx`/`remix.tsx`/`onboarding/coach-strip.tsx` used
   `serif-italic`/`display` standalone (no adjacent `text-foreground` sibling), so
   they're unaffected by this specific collapse. Flagging here for sign-off,
   not silently absorbed.
2. All 15 files that used `.serif`/`.serif-italic` (40 call sites total) were
   mechanically renamed to `.display` as part of this foundation pass (task item 3
   explicitly asked for this, not deferred to the screen pass):
   `shell.tsx`, `onboarding.tsx`, `components/error-boundary.tsx`,
   `components/tutorial-demo.tsx`, `components/markdown.tsx`,
   `components/onboarding/coach-strip.tsx`, `pages/settings.tsx`,
   `pages/dictionary.tsx`, `pages/vocabulary.tsx`, `pages/history.tsx`,
   `pages/meetings.tsx`, `pages/tone.tsx`, `pages/remix.tsx`,
   `pages/models/pair-card.tsx`, `pages/models/page-chrome.tsx`. Their surrounding
   Tailwind size/tracking/leading utility classes were left untouched.
3. `components/remix-chat.tsx` had a literal `font-family: "Instrument Serif", Georgia, serif;`
   inside a template-literal `<style>` block (not a `.serif` class reference, so the
   grep in item 3 wouldn't have caught it) — fixed to Space Grotesk before the old
   woff2 files were deleted, otherwise it would have silently fallen back to Georgia.

## Shape & shadow

- `--radius: 0.625rem` (10px) — unchanged, already matched the mockup's
  `--radius-card`. `--radius-xl` (`1.4 * radius` = 14px) already matches the
  mockup's `--radius-window`.
- **Pills (999px) for buttons and toggles.** `components/ui/button.tsx` base class
  changed `rounded-lg` → `rounded-full`; the `xs`/`sm`/`icon-xs`/`icon-sm` size
  variants previously overrode this with `rounded-[min(var(--radius-md),10|12px)]`
  (a rounded-rect, not a pill) — those overrides were removed so every button size
  is a true pill. No other shape/toggle components were touched (out of scope for
  this pass — see below).
- `button.tsx`'s `default` variant (`bg-primary text-primary-foreground`) and
  `ink` variant (`bg-foreground text-background`) now render as the same ink fill
  (`--primary` and `--foreground` are both `#1D2129`/`#E8E9EB`), with text that's
  visually near-identical but not literally the same value
  (`--primary-foreground` is pure white `#FFFFFF`, `--background` is the ground
  tone `#F6F7F9`/`#17181B`). Not a bug — just means one of the two variants is now
  redundant in practice; worth consolidating in the screen pass rather than
  carrying two names for one look.
- **Cards / chips / badges keep the 10px (`--radius`) and smaller radii** — per
  the mockup, `.chip`/`.badge` use a 5px radius, not a pill; pills are for
  buttons/toggles only. No component work landed here yet; this is guidance for
  the screen pass.
- Single soft shadow: `0 4px 16px rgba(29,33,41,.08)` (mockup's `--shadow`) — not
  yet wired into a shared token/utility; components currently use ad hoc
  `box-shadow` values (e.g. `.glass-topbar`). Introducing a `--shadow-card` token
  is screen-pass work.

## Accent discipline (the fences)

Two colors are load-bearing signals in this system and must not leak into decoration:

- **Accent-passive** (`#E8F1FC` tint / `#2563EB`–`#1D4ED8` ink family) — **only**
  selected-nav state, identity/diarization-speaker chips, and (added by
  specs/llm-task-profiles.md §9.2, approved as part of that spec's brief) the
  `Badge`'s new `passive` variant for a task's "Customized" params-assignment
  chip (`components/ui/badge.tsx`) — a third, explicitly-approved consumer of
  this fence, recorded here per this doc's own practice of tracking every
  fence exception rather than letting them accumulate silently.
  - Landed in this pass: `.glass-nav-active` (globals.css) now uses
    `--accent-passive-tint` for background instead of the old neutral `--card`,
    both in the solid and `html.glass` variants, and in the
    `prefers-reduced-transparency` fallback. This is the actual selected-nav
    surface used by `shell.tsx`'s `NavLink`.
  - **Known gap, deferred to the screen pass**: `shell.tsx`'s active-nav icon color
    (`isActive ? "text-primary" : "text-muted-foreground"`) reads `--primary`,
    which this pass sets to ink (`#1D2129`), not blue. The mockup wants the active
    nav icon to be `--accent-blue`. Fixing this by changing `--primary` globally
    would leak blue into every default button and every `text-primary` headline
    accent word across the app — a much bigger fence violation. The correct fix is
    a dedicated class on that one `isActive` branch in `shell.tsx` (a page/component
    file), out of scope for a token-only foundation pass.
  - `--ring` (focus ring) is blue and is **not** gated by this fence — treated as a
    system affordance (focus visibility), not decoration.
- **Accent-live** (`#E4574D` / dark `#E86A60`) — **only** record/live/in-progress
  indicators. New `--live`/`--live-tint` tokens added; nothing currently consumes
  them (no live/recording UI was touched in this pass) — they exist for the screen
  pass to wire up.
- **`--accent` was deliberately kept neutral** (`#E5E7EB` light / `#2A2D33` dark),
  NOT the blue tint. `--accent`/`--accent-foreground` is shadcn's generic
  hover/focus-state token, consumed by `select.tsx` (`focus:bg-accent`),
  `language-combobox.tsx`, and every "selected preview" treatment in
  `components/tone-previews/*`, `onboarding.tsx`, `tutorial-demo.tsx`,
  `onboarding/coach-strip.tsx`, `pages/tone.tsx`, `pages/vocabulary.tsx`, plus the
  icon-badge circles in `dictionary.tsx`/`history.tsx`/`vocabulary.tsx`/`meetings.tsx`.
  Setting `--accent` to blue would have turned every dropdown-item hover and every
  "this option is selected" preview blue app-wide — the fence would have been
  broken on day one of the foundation. The two dedicated
  `--accent-passive-tint`/`--accent-passive-ink` tokens exist precisely so the
  screen pass can apply blue to the *specific* selected-nav/identity-chip spots
  the approved system calls for, without touching the shared `--accent` token.
- **`--destructive` was deliberately NOT set to the live coral.** The mockup has no
  danger/delete treatment to crib from, so `#DC2626` (light) / `#F87171` (dark) was
  chosen as a standard, clearly-distinct-from-`#E4574D` red, specifically so a
  delete button never reads as "recording."

## Speaker chart ramp (invented, not in the mockup)

The mockup's diarization UI (`.chip`) uses one flat accent-tint blue for every
non-"me" speaker plus a transparent/ink treatment for "me" — it does not define a
5-step categorical ramp. `--chart-1..5` needed 5 distinguishable values for the
existing chart/diarization consumers, so this pass **invented** a 5-step ramp,
constrained to stay inside the blue/ink family per the task brief (which explicitly
sanctions blue for diarization speaker chips):

```
--chart-1: #2563EB   accent blue (mid)
--chart-2: #1D4ED8   accent blue, deeper
--chart-3: #3B4E6B   desaturated blue-ink slate, darker
--chart-4: #6B8CAE   desaturated blue-ink slate, lighter
--chart-5: #1D2129   ink (darkest)
```

Dark-mode values lift each step for contrast against the dark ground; hues are
preserved. **This ramp was not part of the approved mockup and should get an
explicit design look before it ships on a real speaker-diarization screen** — flag
for sign-off.

## Migration map — old token → new token

Old tokens were the warm cream/olive editorial palette (see the removed comment
block this replaced in `globals.css`, preserved here for the historical mapping):

| Old (light) | Old role | New (light) | Notes |
|---|---|---|---|
| `#F4F0E4` canvas | `--background` | `#F6F7F9` | ground |
| `#FBF8EE` elevated | `--card`/`--popover` | `#FFFFFF` | surface |
| `#16140F` ink | `--foreground` | `#1D2129` | ink |
| `#7B7461` mute | `--muted-foreground` | `#6B7280` | muted |
| `#D6CDB8` rule | `--border`/`--input` | `#E5E7EB` | hairline |
| `#ECE7D6` paper | `--secondary`/`--muted` | `#EEF0F2` | neutral fill |
| `#E8EFC9` olive-soft | `--accent` | `#E5E7EB` | kept neutral, see Accent discipline above — this is NOT where the new blue accent lives |
| `#6B8F12` olive | `--primary`/`--ring`/`--sidebar-primary` | `--primary` → `#1D2129` (ink); `--ring`/`--sidebar-primary` → `#2563EB` (accent blue) | olive's three consumers split: primary buttons go ink (matches mockup `.btn-ink`), focus ring and sidebar-identity go blue |
| `#DD6E4E` blush | `--destructive` | `#DC2626` | deliberately NOT the live coral — see Accent discipline |
| `#6B8F12`/`#4A6309`/`#5E4E78`/`#DD6E4E`/`#7B7461` | `--chart-1..5` | `#2563EB`/`#1D4ED8`/`#3B4E6B`/`#6B8CAE`/`#1D2129` | new calm blue/ink ramp, invented — see above |
| `#6B8F12` (`::selection`) | inline `rgba(107,143,18,.25)` | `rgba(37,99,235,.18)` | selection tint now blue-family instead of olive |
| (none) | — | `--accent-passive-tint` `#E8F1FC`, `--accent-passive-ink` `#1D4ED8` | new, additive |
| (none) | — | `--live` `#E4574D`, `--live-tint` `#FBEAE8` | new, additive |

Dark-mode old→new follows the same role mapping (see the token sheet dark table
above); the old dark palette's `#8AB62A` (lifted olive) role splits the same way
`#6B8F12` did in light mode.

## Fonts

Self-hosted, downloaded from Google Fonts (variable-weight woff2, latin + latin-ext
subsets, `unicode-range`-split to match the existing file layout) into
`apps/electron/src/renderer/src/assets/fonts/`:

- `space-grotesk-latin.woff2`, `space-grotesk-latin-ext.woff2` — weight `300 700`,
  normal only (no italic exists for this family)
- `urbanist-latin.woff2`, `urbanist-latin-ext.woff2`,
  `urbanist-italic-latin.woff2`, `urbanist-italic-latin-ext.woff2` — weight
  `300 800`, normal + italic
- `jetbrains-mono-latin.woff2`, `jetbrains-mono-latin-ext.woff2` — **unchanged**,
  kept as-is

Removed: all 8 `dm-sans-*`/`instrument-serif-*` woff2 files, and every remaining
`"Instrument Serif"`/`"DM Sans"` reference in the renderer source (confirmed via
repo-wide grep after the rename pass — the only hit left is this doc's own prose
and a code comment).

`apps/electron/src/renderer/src/fonts.css` was rewritten 1:1 in the same
`@font-face` shape as before, just swapping which families the rules declare.

## What's NOT done yet (explicitly out of scope for this foundation pass)

Per the task's item 5, individual page/screen files were **not** touched for their
old-palette hex leftovers — see the leftovers list in the task's return payload.
Additionally, out of scope for this pass and left for the screen pass:

- Wiring `--live`/`--live-tint` into any actual recording/live UI.
- Fixing `shell.tsx`'s active-nav icon color (currently reads `--primary`, wants
  `--accent-blue`) — see "Known gap" under Accent discipline above.
- Applying `--accent-passive-tint`/`--accent-passive-ink` to identity/diarization
  speaker chips in `remix-chat.tsx`, `history.tsx`, or wherever transcript speaker
  labels render.
- Pill/shape treatment for toggles, segmented controls, and switches beyond
  `components/ui/button.tsx` (task item 4 named only `button.tsx`).
- A shared `--shadow-card` token for the mockup's single soft shadow.
- The invented `--chart-1..5` speaker ramp has not been validated against a real
  diarization screen.
- The 7 now-redundant `<span className="display text-primary">` inner spans left
  over from the retired two-tone headline treatment (list above, under "Font
  decisions" item 1) — flattening these into their parent heading is cosmetic
  cleanup, not a correctness fix, so it was left for the screen pass rather than
  bundled into a token-only foundation change.
- Consolidating `button.tsx`'s now-near-duplicate `default`/`ink` variants (see
  Shape & shadow above).

## Verification performed

- `pnpm turbo build --filter=@openstyle/server && pnpm --filter @openstyle/electron typecheck`
  (both `typecheck:node` and `typecheck:web`) — clean, no errors.
- `pnpm --filter @openstyle/electron build` (Vite production build, not a launch)
  — succeeded; confirmed the compiled output actually bundles all 6 new font
  files and that `.font-sans`/`.font-mono` Tailwind utilities resolve to the new
  families. This caught a real bug: `body`'s `font-family` was initially wired to
  `var(--font-sans)`, a token declared inside `@theme inline` — which inlines
  values into generated utilities and does **not** reliably emit the custom
  property to `:root`. The compiled CSS confirmed `--font-sans` is indeed absent
  from `:root` (0 occurrences), which would have made `body`'s font silently fall
  back to the browser default with no typecheck or grep able to catch it. Fixed
  by giving `body` its own literal Urbanist stack, matching how `.display` and
  `.mono` already hardcode theirs.
