# Contributing

Thanks for considering a contribution. Bug reports, fixes, and improvements are all welcome.

## Prerequisites

- **Node.js 22+**
- **pnpm 10+**

## Setup

1. Fork and clone the repo

   ```bash
   git clone https://github.com/Maheidem/openstyle.git
   cd openstyle
   ```

2. Install dependencies

   ```bash
   pnpm install
   ```

3. Start development

   ```bash
   pnpm dev
   ```

   This starts the Electron app with hot-reloading via `electron-vite`. The embedded Hono server starts automatically on a local port.

   On first launch, macOS will prompt for:
   1. **Microphone** access
   2. **Accessibility** access (required for paste simulation and global key listener)

## Build

```bash
# macOS
pnpm --filter @openstyle/electron build:mac

# Windows
pnpm --filter @openstyle/electron build:win

# Linux
pnpm --filter @openstyle/electron build:linux
```

## Project structure

- `apps/electron` — Electron desktop app (main process + React renderer)
- `apps/server` — Hono API server (embedded in the Electron app)

## Development workflow

1. Create a branch from `main`
2. Make your changes
3. Run `pnpm biome check .` to verify lint and formatting
4. Run `pnpm --filter @openstyle/electron typecheck:web` to verify types
5. Commit — husky runs biome on staged files automatically
6. Open a PR against `main`

## Code style

- **Biome** for linting and formatting (not ESLint/Prettier)
- 2-space indentation, 80-char line width
- Imports are auto-sorted by Biome

## Commit messages

Follow conventional commits:

```
feat: add new feature
fix: resolve a bug
chore: maintenance task
```

## Pull request titles

PR titles must follow the [Conventional Commits](https://www.conventionalcommits.org/) format. We squash-merge PRs and use the PR title for the squash commit and the release changelog, so a clean title matters.

```
type(scope): short imperative summary
```

The scope is optional. Allowed types:

`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, `revert`

Examples:

```
fix: prevent duplicate settings requests
feat(plugins): add update checks
docs: clarify local development setup
refactor(server): simplify plugin loading
```

A CI check validates PR titles automatically. If it fails, edit your PR title to match the format above — no need to open a new PR.
