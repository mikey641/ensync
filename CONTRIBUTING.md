# Contributing to Ensync

Thanks for your interest. Ensync is MIT-licensed, and contributions are welcome.

## Context before you start

Read these before touching code:

- `.ensync/project.md` — cross-feature product rules.
- `.ensync/architecture.md` — runtime, routing, and isolation boundaries.
- The relevant file in `.ensync/features/` for the feature you are changing.

Root `AGENTS.md` and `CLAUDE.md` point coding agents at the same sources, so humans and agents work from one set of decisions.

## Local development

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

This starts the Vite interface, the Node Ensync Host, and a development-only account-sync service on loopback.

## Verification

Run the checks that cover the area you changed before opening a pull request:

```bash
npm run build          # UI/Vite build
npm run build:mobile   # mobile PWA build
npm run test:host      # Host unit tests
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix site test
```

The mobile client lives in `mobile/`; `npm run build` there produces the installable PWA in `mobile/dist`.

## Pull requests

- Keep changes small and scoped to one feature area.
- Update the relevant `.ensync/features/*.md` file when you change durable behavior; do not create competing memory documents.
- Preserve the conversation-first interface, the subscription-only routing guarantee, the safe pre-mutation fallback rule, and equal macOS/Windows and iOS/Android support.
- Do not commit secrets, API keys, signing material, or device/config state.

## License

By contributing you agree your work is licensed under the same MIT license as the project. See [LICENSE](LICENSE).
