import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZodError } from "zod";
import type { GoogleGenAI } from "@google/genai";
import {
  bufferGraphql,
  buildTrackingUrl,
  createInitialState,
  fingerprintProducts,
  formatPinId,
  generatePinContent,
  inspectPinterestChannels,
  intentTypeForVariant,
  nextPinNumber,
  parseProducts,
  parsePublishedState,
  PinContentIncompleteError,
  PinContentRefusalError,
  type PinRecord,
  type Product,
  type PublishedState,
  selectCandidates,
  writePublishedStateAtomic,
} from "../src/pinterest.js";

const products: Product[] = [
  {
    id: "lemon-pillow-01",
    name: "Mediterranean Lemon Pillow",
    url: "https://shop.kotkoa.com/products/lemon-pillow",
    image: "https://cdn.shopify.com/lemon-pillow.jpg",
  },
  {
    id: "lavender-towel-01",
    name: "Lavender Kitchen Towel",
    url: "https://shop.kotkoa.com/products/lavender-towel?variant=123",
    image: "https://cdn.shopify.com/lavender-towel.jpg",
  },
];

function makePin(
  product: Product,
  variant: 1 | 2 | 3,
  number: number,
  status: PinRecord["status"] = "buffer_queued",
): PinRecord {
  const pinId = formatPinId(number);
  const common = {
    pinId,
    productId: product.id,
    variant,
    intentType: intentTypeForVariant(variant),
    searchIntent: `${product.name} intent ${variant}`,
    title: `${product.name} ${variant}`,
    description: `Description for ${product.name} variant ${variant}`,
    altText: `Product image of ${product.name}`,
    destinationUrl: buildTrackingUrl(product.url, pinId),
    imageUrl: product.image,
  };

  if (status === "buffer_outcome_unknown") {
    return {
      ...common,
      status,
      attemptedAt: "2026-08-16T12:00:00.000Z",
    };
  }

  return {
    ...common,
    status,
    bufferPostId: `buffer-${number}`,
    queuedAt: "2026-08-16T12:00:00.000Z",
  };
}

function makeState(
  pins: PinRecord[] = [],
  catalog: Product[] = products,
  campaign = "pinterest_mvp",
): PublishedState {
  return {
    schemaVersion: 1,
    campaign,
    catalogFingerprint: fingerprintProducts(catalog),
    pins,
  };
}

test("parseProducts accepts valid products", () => {
  assert.deepEqual(parseProducts(products), products);
});

test("parseProducts rejects duplicate IDs", () => {
  assert.throws(
    () => parseProducts([products[0], products[0]]),
    (error: unknown) =>
      error instanceof ZodError &&
      error.issues.some((issue) => issue.message.includes("Duplicate product id")),
  );
});

test("parseProducts rejects an empty catalog and non-HTTPS URLs", () => {
  assert.throws(() => parseProducts([]), ZodError);
  assert.throws(
    () =>
      parseProducts([
        {
          ...products[0],
          url: "http://shop.kotkoa.com/products/lemon-pillow",
        },
      ]),
    ZodError,
  );
});

test("parseProducts rejects credentials embedded in URLs", () => {
  assert.throws(
    () =>
      parseProducts([
        {
          ...products[0],
          image: "https://user:password@cdn.shopify.com/lemon-pillow.jpg",
        },
      ]),
    ZodError,
  );
});

test("buildTrackingUrl preserves unrelated parameters and replaces UTM values", () => {
  const result = new URL(
    buildTrackingUrl(
      "https://shop.kotkoa.com/products/item?variant=42&utm_source=old",
      "pin_007",
      "campaign test",
    ),
  );

  assert.equal(result.searchParams.get("variant"), "42");
  assert.equal(result.searchParams.get("utm_source"), "pinterest");
  assert.equal(result.searchParams.get("utm_medium"), "organic");
  assert.equal(result.searchParams.get("utm_campaign"), "campaign test");
  assert.equal(result.searchParams.get("utm_content"), "pin_007");
});

test("createInitialState freezes the catalog and validates campaign constraints", () => {
  const state = createInitialState(products, "pinterest_mvp");

  assert.equal(state.catalogFingerprint, fingerprintProducts(products));
  assert.equal(state.campaign, "pinterest_mvp");
  assert.deepEqual(state.pins, []);
  assert.throws(() => createInitialState(products, ""), ZodError);
  assert.throws(() => createInitialState(products, "x".repeat(101)), ZodError);
});

test("formatPinId validates numbers and nextPinNumber uses the greatest ID", () => {
  assert.equal(formatPinId(1), "pin_001");
  assert.equal(formatPinId(1_234), "pin_1234");
  assert.throws(() => formatPinId(0));

  const state = makeState([
    makePin(products[0]!, 1, 2),
    makePin(products[1]!, 1, 9),
  ]);
  assert.equal(nextPinNumber(state), 10);
});

test("selectCandidates follows variant-major product order and reserves a batch", () => {
  const firstBatch = selectCandidates(products, makeState(), 2);

  assert.deepEqual(
    firstBatch.map(({ pinId, product, variant, intentType }) => ({
      pinId,
      productId: product.id,
      variant,
      intentType,
    })),
    [
      {
        pinId: "pin_001",
        productId: "lemon-pillow-01",
        variant: 1,
        intentType: "product_type",
      },
      {
        pinId: "pin_002",
        productId: "lavender-towel-01",
        variant: 1,
        intentType: "product_type",
      },
    ],
  );

  const secondState = makeState([
    makePin(products[0]!, 1, 1),
    makePin(products[1]!, 1, 2),
  ]);
  const secondBatch = selectCandidates(products, secondState, 2);
  assert.deepEqual(
    secondBatch.map(({ product, variant }) => [product.id, variant]),
    [
      ["lemon-pillow-01", 2],
      ["lavender-towel-01", 2],
    ],
  );
});

test("a 40-product catalog produces exactly 120 unique candidates", () => {
  const catalog = Array.from({ length: 40 }, (_, index): Product => ({
    id: `product-${index + 1}`,
    name: `Product ${index + 1}`,
    url: `https://shop.kotkoa.com/products/product-${index + 1}`,
    image: `https://cdn.shopify.com/product-${index + 1}.jpg`,
  }));
  const state = makeState([], catalog);

  for (let offset = 0; offset < 120; offset += 7) {
    const candidates = selectCandidates(catalog, state, Math.min(7, 120 - offset));
    for (const candidate of candidates) {
      state.pins.push(
        makePin(candidate.product, candidate.variant, state.pins.length + 1),
      );
    }
  }

  assert.equal(state.pins.length, 120);
  assert.equal(
    new Set(state.pins.map((pin) => `${pin.productId}:${pin.variant}`)).size,
    120,
  );
  assert.equal(selectCandidates(catalog, state, 1).length, 0);
});

test("selectCandidates halts when a Buffer outcome is unknown", () => {
  const state = makeState([
    makePin(products[0]!, 1, 1, "buffer_outcome_unknown"),
  ]);

  assert.throws(
    () => selectCandidates(products, state, 1),
    /reconcile it manually/,
  );
});

test("unknown Buffer outcomes require only attemptedAt and halt selection", () => {
  const unknown = makePin(
    products[0]!,
    1,
    1,
    "buffer_outcome_unknown",
  );
  const state = makeState([unknown]);

  assert.equal(unknown.status, "buffer_outcome_unknown");
  assert.equal("bufferPostId" in unknown, false);
  assert.equal("queuedAt" in unknown, false);
  assert.deepEqual(parsePublishedState(state, products), state);
});

test("parsePublishedState enforces references, intent mapping, image freeze, and UTM", () => {
  const valid = makeState([makePin(products[0]!, 1, 1)]);
  assert.deepEqual(parsePublishedState(valid, products), valid);

  assert.throws(
    () =>
      parsePublishedState(
        makeState([
          {
            ...makePin(products[0]!, 1, 1),
            productId: "missing-product",
          },
        ]),
        products,
      ),
    /references missing product/,
  );

  assert.throws(
    () =>
      parsePublishedState(
        makeState([
          {
            ...makePin(products[0]!, 1, 1),
            intentType: "theme_style",
          },
        ]),
        products,
      ),
    /variant 1 requires product_type/,
  );

  assert.throws(
    () =>
      parsePublishedState(
        makeState([
          {
            ...makePin(products[0]!, 1, 1),
            imageUrl: "https://cdn.shopify.com/changed.jpg",
          },
        ]),
        products,
      ),
    /image does not match frozen product/,
  );

  assert.throws(
    () =>
      parsePublishedState(
        makeState([
          {
            ...makePin(products[0]!, 1, 1),
            destinationUrl: buildTrackingUrl(products[0]!.url, "pin_999"),
          },
        ]),
        products,
      ),
    /destination does not match product lemon-pillow-01/,
  );
});

test("parsePublishedState freezes catalog order and exact destination campaign", () => {
  const state = makeState([makePin(products[0]!, 1, 1)]);

  assert.throws(
    () => parsePublishedState(state, [...products].reverse()),
    /catalog was frozen/,
  );
  assert.throws(
    () =>
      parsePublishedState(
        {
          ...state,
          pins: [
            {
              ...state.pins[0]!,
              destinationUrl: buildTrackingUrl(
                products[0]!.url,
                "pin_001",
                "different-campaign",
              ),
            },
          ],
        },
        products,
      ),
    /destination does not match/,
  );
});

test("parsePublishedState rejects non-canonical or unsafe Pin IDs", () => {
  for (const pinId of ["pin_000", "pin_0001", "pin_999999999999999999999999"]) {
    const pin = makePin(products[0]!, 1, 1);
    assert.throws(
      () =>
        parsePublishedState(
          makeState([
            {
              ...pin,
              pinId,
              destinationUrl: buildTrackingUrl(products[0]!.url, pinId),
            },
          ]),
          products,
        ),
      ZodError,
    );
  }
});

test("parsePublishedState rejects duplicate IDs and product variants", () => {
  const duplicate = makeState([
    makePin(products[0]!, 1, 1),
    {
      ...makePin(products[0]!, 1, 2),
      pinId: "pin_001",
      destinationUrl: buildTrackingUrl(products[0]!.url, "pin_001"),
    },
  ]);

  assert.throws(() => parsePublishedState(duplicate, products), ZodError);
});

test("writePublishedStateAtomic writes valid JSON and leaves no temp file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kotkoa-state-"));
  const statePath = join(directory, "published.json");
  const state = makeState([makePin(products[0]!, 1, 1)]);

  try {
    await writePublishedStateAtomic(statePath, state, products);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
    assert.deepEqual(await readdir(directory), ["published.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writePublishedStateAtomic cannot bypass product-aware invariants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kotkoa-invalid-state-"));
  const statePath = join(directory, "published.json");
  const state = makeState([
    {
      ...makePin(products[0]!, 1, 1),
      destinationUrl:
        "https://unrelated.example/item?utm_source=pinterest&utm_medium=organic&utm_campaign=pinterest_mvp&utm_content=pin_001",
    },
  ]);

  try {
    await assert.rejects(
      writePublishedStateAtomic(statePath, state, products),
      /destination does not match/,
    );
    await assert.rejects(readFile(statePath, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bufferGraphql returns data and sends the key only in Authorization", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await bufferGraphql<{ ok: boolean }>(
    "buffer-secret",
    "query { ok }",
    mockFetch,
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(requests[0]?.url, "https://api.buffer.com");
  assert.equal(requests[0]?.init?.headers instanceof Headers, false);
  assert.deepEqual(requests[0]?.init?.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer buffer-secret",
  });
  assert.doesNotMatch(String(requests[0]?.init?.body), /buffer-secret/);
});

test("bufferGraphql rejects HTTP, GraphQL, and missing-data responses", async () => {
  const responseFetch = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

  await assert.rejects(
    bufferGraphql("key", "query", responseFetch({}, 401)),
    /HTTP 401/,
  );
  await assert.rejects(
    bufferGraphql(
      "key",
      "query",
      responseFetch({ errors: [{ message: "Unauthorized" }] }),
    ),
    /GraphQL error: Unauthorized/,
  );
  await assert.rejects(
    bufferGraphql("key", "query", responseFetch({})),
    /did not contain data/,
  );
  await assert.rejects(
    bufferGraphql("key", "query", responseFetch({ data: null })),
    /did not contain data/,
  );
});

test("inspectPinterestChannels discovers Pinterest boards and ignores other services", async () => {
  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };

    if (body.query.includes("GetOrganizations")) {
      return new Response(
        JSON.stringify({
          data: {
            account: { organizations: [{ id: "org-1", name: "Kotkoa" }] },
          },
        }),
      );
    }

    if (body.query.includes("GetChannels")) {
      return new Response(
        JSON.stringify({
          data: {
            channels: [
              { id: "pin-channel", name: "Kotkoa Pins", service: "pinterest" },
              { id: "ig-channel", name: "Kotkoa IG", service: "instagram" },
            ],
          },
        }),
      );
    }

    if (body.query.includes("GetPinterestBoards")) {
      return new Response(
        JSON.stringify({
          data: {
            channel: {
              metadata: {
                boards: [
                  {
                    serviceId: "board-1",
                    name: "Mediterranean Decor",
                    url: "https://pinterest.com/kotkoa/mediterranean-decor",
                  },
                ],
              },
            },
          },
        }),
      );
    }

    return new Response(JSON.stringify({ errors: [{ message: "Unexpected query" }] }));
  }) as typeof fetch;

  const result = await inspectPinterestChannels("key", mockFetch);

  assert.deepEqual(result, [
    {
      id: "pin-channel",
      name: "Kotkoa Pins",
      service: "pinterest",
      organization: { id: "org-1", name: "Kotkoa" },
      boards: [
        {
          serviceId: "board-1",
          name: "Mediterranean Decor",
          url: "https://pinterest.com/kotkoa/mediterranean-decor",
        },
      ],
    },
  ]);
});

function mockGeminiClient(
  generateContent: (...args: unknown[]) => unknown,
): GoogleGenAI {
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

test("generatePinContent returns validated content on success", async () => {
  const parsedContent = {
    searchIntent: "citrus throw pillow",
    title: "Mediterranean Lemon Pillow",
    description: "A bright lemon-print pillow for a Mediterranean-style room.",
    altText: "Yellow lemon-print throw pillow on a linen sofa",
  };
  const client = mockGeminiClient(() =>
    Promise.resolve({
      text: JSON.stringify(parsedContent),
      candidates: [{ finishReason: "STOP" }],
    }),
  );

  const result = await generatePinContent(
    client,
    products[0]!,
    "product_type",
    "gemini-2.5-flash",
  );

  assert.deepEqual(result, parsedContent);
});

test("generatePinContent throws PinContentRefusalError on refusal", async () => {
  const client = mockGeminiClient(() =>
    Promise.resolve({
      text: undefined,
      candidates: [{ finishReason: "SAFETY" }],
    }),
  );

  await assert.rejects(
    generatePinContent(client, products[0]!, "product_type", "gemini-2.5-flash"),
    PinContentRefusalError,
  );
});

test("generatePinContent throws PinContentIncompleteError on incomplete status", async () => {
  const client = mockGeminiClient(() =>
    Promise.resolve({
      text: undefined,
      candidates: [{ finishReason: "MAX_TOKENS" }],
    }),
  );

  await assert.rejects(
    generatePinContent(client, products[0]!, "product_type", "gemini-2.5-flash"),
    PinContentIncompleteError,
  );
});

test("generatePinContent rejects output that fails local Zod validation", async () => {
  const client = mockGeminiClient(() =>
    Promise.resolve({
      text: JSON.stringify({ searchIntent: "", title: "", description: "", altText: "" }),
      candidates: [{ finishReason: "STOP" }],
    }),
  );

  await assert.rejects(
    generatePinContent(client, products[0]!, "product_type", "gemini-2.5-flash"),
    ZodError,
  );
});
