# Kotkoa Shopify Pinterest Flow

Minimal, stage-gated automation for testing whether Pinterest Pins can drive measurable organic traffic to Kotkoa's Shopify product pages.

## Status

**MVP Gate 0.** The full publisher is not implemented or production-ready. The repository currently contains validated queue/UTM primitives, state invariants, tests, and a read-only Buffer Pinterest inspector.

The first MVP tests one path only:

```text
Shopify product → automated Pin → Pinterest outbound click → Shopify session
```

See:

- [`PLAN.md`](PLAN.md) — preliminary architecture, implementation stages, verification criteria, and risks;
- [`AGENTS.md`](AGENTS.md) — scope and engineering instructions for coding agents.

## Current Gate 0 commands

Requirements: Node.js 22 and npm.

```bash
npm install
npm run typecheck
npm test
```

Copy one real product into `products.json` using `products.example.json` as the shape, then preview deterministic queue allocation and UTM URLs:

```bash
npm run queue:preview
```

To inspect connected Pinterest channels and boards without publishing anything, create a local `.env` from `.env.example`, set only `BUFFER_API_KEY`, and run this command locally (it intentionally refuses to run when `CI=true`):

```bash
npm run buffer:inspect
```

Never commit `.env`. The inspector prints channel and board IDs so they can be copied into the local configuration.

## Planned MVP after Gate 0

- OpenAI structured outputs for Pin copy
- Buffer GraphQL mutation for Pinterest publishing
- `published.json` for minimal state
- GitHub Actions for scheduled runs

Before this work is enabled, one manually prepared Pin must become live on Pinterest and a separately marked technical click must be observable in Shopify. The technical click will not count as organic MVP traffic.

The MVP intentionally excludes Shopify Admin API integration, databases, dashboards, image generation, winner scoring, and autonomous optimization.

## Public repository safety

Do not commit API keys or `.env` files. Runtime credentials will be stored in GitHub Actions secrets. `.env.example` contains names and safe defaults only.

## License

No license has been granted yet. Public visibility does not imply permission to copy, modify, or redistribute this project.
