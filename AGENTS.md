# AGENTS.md

## Project mission

Build the smallest verifiable system that can turn Kotkoa Shopify products into Pinterest Pins and measure whether those Pins drive real traffic back to Shopify.

The MVP hypothesis is deliberately narrow:

> An automated process can regularly publish product Pins and generate measurable Pinterest outbound clicks and Shopify sessions.

Sales, product scoring, winner detection, product generation, and autonomous optimization are not part of the MVP.

## Current status

The repository is in the planning/scaffolding phase. Read `PLAN.md` before changing code. Do not implement later stages unless the current stage has met its explicit verification criterion and the user has approved the next stage.

## Stage gate rule

Every change must answer:

> Which concrete hypothesis does this change test?

If the change is not necessary to test the current hypothesis, defer it.

## MVP scope

The MVP should:

1. Read approximately 40 products from `products.json`.
2. Create three Pins per product, each targeting a distinct search-intent angle.
3. Generate Pin title, description, search intent, and alt text through OpenAI.
4. Build a unique UTM destination URL for every Pin.
5. Send each Pin to a connected Pinterest channel through Buffer.
6. Record successful Buffer submissions in `published.json`.
7. Avoid resubmitting a recorded `productId + variant` combination.
8. Run on a schedule through GitHub Actions at approximately six Pins per day.

## Explicitly out of scope for the MVP

Do not add:

- Shopify Admin API integration;
- Supabase, Postgres, or another database;
- dashboards;
- product generation;
- image generation or automated image editing;
- competitor analysis;
- direct Pinterest API integration while Buffer is sufficient;
- scoring, winner/weak classification, or ML;
- autonomous agent loops or MCP;
- Instagram, Facebook, or other publishing channels;
- keyword databases;
- complex queues or distributed workers;
- automated store modification.

These belong to later stages described in `PLAN.md`.

## Planned technical baseline

- Node.js 22
- TypeScript with strict type checking
- ESM modules
- Official OpenAI Node SDK and Responses API structured outputs
- Zod for runtime validation
- Native `fetch` for Buffer's GraphQL API
- Node's built-in test runner, executed through `tsx`
- JSON files for product input and state
- GitHub Actions for scheduling

Avoid adding dependencies when Node.js standard APIs are sufficient.

## Planned repository layout

```text
.github/workflows/publish-pinterest.yml
src/pinterest.ts
tests/pinterest.test.ts
products.json
published.json
.env.example
AGENTS.md
PLAN.md
README.md
package.json
tsconfig.json
```

Keep the runtime implementation centered in `src/pinterest.ts` during the MVP. Extract modules only when the single file becomes demonstrably difficult to test or maintain.

## Data contracts

### Product

Each `products.json` entry must contain:

```ts
type Product = {
  id: string;    // Stable, unique slug-like identifier
  name: string;
  url: string;   // Public HTTPS Shopify product URL
  image: string; // Public HTTPS image URL accessible by Buffer
};
```

Reject duplicate IDs, malformed URLs, non-HTTPS URLs, and missing fields before making any external API call.

### Pin variants

Each product receives exactly three initial variants:

1. `product_type` — what the product is;
2. `theme_style` — visual motif, theme, or aesthetic;
3. `use_case` — room, occasion, recipient, project, or intended use.

The deterministic code chooses the variant type. AI generates the concrete search intent and content. AI must not control queueing, identifiers, UTM generation, persistence, or retry rules.

### Published state

`published.json` is the MVP source of truth for completed Buffer submissions. Each record should contain at least:

- `pinId`;
- `productId`;
- variant number and intent type;
- generated search intent and content;
- destination URL and image URL;
- Buffer post ID;
- Buffer state such as `buffer_queued`;
- queue and scheduled timestamps when available.

Do not describe a queued Buffer post as confirmed published on Pinterest. Persist state atomically with a temporary file and rename.

## Queue selection

Use a deterministic fair queue: choose products with the fewest completed variants first, preserving `products.json` order as the tie-breaker. This produces the first Pin for all products before the second and third rounds.

A normal completed rerun must never submit an already recorded `productId + variant` pair.

Exactly-once delivery cannot be guaranteed transactionally across Buffer and a Git-committed JSON file. Keep this limitation explicit; do not introduce a database solely to hide it during the MVP.

## UTM rules

Generate URLs with the standard `URL` API. Preserve unrelated existing query parameters and set:

```text
utm_source=pinterest
utm_medium=organic
utm_campaign=pinterest_mvp
utm_content=pin_XXX
```

Every `utm_content` and `pinId` must be unique and traceable to one state record. Do not concatenate query strings manually.

## Buffer integration

Use the current Buffer GraphQL API:

```text
POST https://api.buffer.com
Authorization: Bearer <BUFFER_API_KEY>
```

Pinterest posts require:

- the Pinterest Buffer channel ID;
- the Pinterest board `serviceId`;
- public image URL;
- Pin title and description;
- Pin destination URL;
- optional image alt text metadata.

Prefer `mode: addToQueue` for the MVP. Buffer's channel schedule controls the actual publication slots. Always handle both GraphQL transport errors and Buffer's `MutationError` union response.

Relevant documentation:

- https://developers.buffer.com/guides/your-first-post.html
- https://developers.buffer.com/guides/posts-and-scheduling.html
- https://developers.buffer.com/examples/create-image-post.html
- https://developers.buffer.com/reference.html

## OpenAI integration

Use one structured-output request per Pin. Validate the returned data locally even when structured outputs are enabled.

Prompts must:

- use the product name and selected intent type;
- produce English Pinterest content unless requirements change;
- avoid claims not supported by product data;
- avoid keyword stuffing;
- keep all three intent angles meaningfully distinct;
- return only the requested schema.

Make the model configurable through `OPENAI_MODEL`; do not hard-code credentials.

## Environment and secrets

Expected runtime secrets:

```text
OPENAI_API_KEY
BUFFER_API_KEY
BUFFER_CHANNEL_ID
BUFFER_BOARD_ID
```

Expected non-secret configuration:

```text
OPENAI_MODEL
PINS_PER_RUN
UTM_CAMPAIGN
DRY_RUN
```

Never commit real API keys, tokens, credentials, `.env` files, private keys, Shopify customer data, or GitHub tokens. Never print secret values or authorization headers in logs.

This is a public repository. Before every commit, inspect staged changes for secrets and personal data.

## GitHub Actions constraints

The publishing workflow should:

- support both `schedule` and `workflow_dispatch`;
- use minimal permissions, with `contents: write` only because state must be committed;
- use one non-cancelling concurrency group for publisher runs;
- use Node.js 22 and `npm ci`;
- enforce a timeout;
- never echo secrets;
- commit only expected state changes after a successful run;
- avoid triggering itself recursively.

GitHub cron uses UTC and can be delayed. Buffer queue slots, not exact GitHub start times, should determine final Pinterest publication timing.

## Dry-run behavior

A dry run may call OpenAI and display a redacted Pin preview, but it must not:

- call Buffer's create-post mutation;
- change `published.json`;
- create Git commits.

## Quality requirements

Before considering an implementation complete, run:

```bash
npm run typecheck
npm test
```

Critical tests should cover:

- malformed and duplicate product data;
- deterministic fair selection;
- all 120 unique product/variant combinations;
- no selection after the catalog is complete;
- stable unique Pin IDs;
- UTM creation with and without existing query parameters;
- duplicate-state rejection;
- OpenAI output validation;
- Buffer success and error response parsing;
- dry-run immutability;
- atomic state updates.

Mock external APIs in automated tests. Never use production credentials in tests.

## Error handling

Fail before publishing when inputs or configuration are invalid. If Buffer rejects a Pin, do not record it as queued. If one item in a batch fails after earlier items succeeded, preserve the successful local state and exit non-zero so the failure remains visible.

Logs should contain safe operational identifiers such as `pinId`, `productId`, and Buffer post ID, but no secrets.

## Public repository hygiene

- Keep `.env.example` limited to placeholders and safe defaults.
- Keep `.gitignore` updated for Node.js, editors, local state, and credentials.
- Do not claim the publisher is production-ready before the real Buffer smoke test passes.
- Keep `README.md` status and setup instructions accurate.
- Record architecture or scope changes in `PLAN.md`.
- Do not commit real customer, order, checkout, or analytics exports.

## Later stages

Stage 2 and beyond may add Shopify discovery, product states, constrained slot allocation, analytics storage, and winner analysis. Those are not extensions to implement opportunistically. Each requires explicit evidence from the previous stage and user approval.
