# Kotkoa Shopify Pinterest Flow

Minimal, stage-gated automation for testing whether Pinterest Pins can drive measurable organic traffic to Kotkoa's Shopify product pages.

## Status

**Planning and repository preparation.** The publisher is not implemented or production-ready yet.

The first MVP tests one path only:

```text
Shopify product → automated Pin → Pinterest outbound click → Shopify session
```

See:

- [`PLAN.md`](PLAN.md) — preliminary architecture, implementation stages, verification criteria, and risks;
- [`AGENTS.md`](AGENTS.md) — scope and engineering instructions for coding agents.

## Planned MVP

- TypeScript and Node.js 22
- `products.json` as the product source
- OpenAI structured outputs for Pin copy
- Buffer GraphQL API for Pinterest publishing
- unique UTM tracking per Pin
- `published.json` for minimal state
- GitHub Actions for scheduled runs

The MVP intentionally excludes Shopify Admin API integration, databases, dashboards, image generation, winner scoring, and autonomous optimization.

## Public repository safety

Do not commit API keys or `.env` files. Runtime credentials will be stored in GitHub Actions secrets. `.env.example` contains names and safe defaults only.

## License

No license has been granted yet. Public visibility does not imply permission to copy, modify, or redistribute this project.
