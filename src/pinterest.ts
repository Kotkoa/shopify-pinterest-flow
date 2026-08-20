import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const BUFFER_API_URL = "https://api.buffer.com";
const BUFFER_TIMEOUT_MS = 15_000;

export const INTENT_TYPES = [
  "product_type",
  "theme_style",
  "use_case",
] as const;

const intentTypeSchema = z.enum(INTENT_TYPES);
const variantSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

function httpsUrlSchema(label: string) {
  return z
    .url(`${label} must be a valid URL`)
    .refine(
      (value) => new URL(value).protocol === "https:",
      `${label} must use HTTPS`,
    )
    .refine((value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    }, `${label} must not contain credentials`);
}

export const productSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Product id must be a lowercase slug",
      ),
    name: z.string().trim().min(1).max(200),
    url: httpsUrlSchema("Product URL"),
    image: httpsUrlSchema("Product image URL"),
  })
  .strict();

export const productsSchema = z
  .array(productSchema)
  .min(1, "products.json must contain at least one product")
  .superRefine((products, context) => {
    const seen = new Set<string>();

    products.forEach((product, index) => {
      if (seen.has(product.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate product id: ${product.id}`,
          path: [index, "id"],
        });
      }

      seen.add(product.id);
    });
  });

const pinRecordBaseSchema = z
  .object({
    pinId: z.string().regex(/^pin_\d{3,}$/, "Invalid Pin id"),
    productId: z.string().min(1),
    variant: variantSchema,
    intentType: intentTypeSchema,
    searchIntent: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(800),
    altText: z.string().trim().min(1).max(500),
    destinationUrl: httpsUrlSchema("Pin destination URL"),
    imageUrl: httpsUrlSchema("Pin image URL"),
  })
  .strict();

const queuedPinRecordSchema = pinRecordBaseSchema.extend({
  status: z.literal("buffer_queued"),
  bufferPostId: z.string().min(1),
  queuedAt: z.iso.datetime(),
  dueAt: z.iso.datetime().nullable().optional(),
});

const unknownPinRecordSchema = pinRecordBaseSchema.extend({
  status: z.literal("buffer_outcome_unknown"),
  attemptedAt: z.iso.datetime(),
});

export const pinRecordSchema = z.discriminatedUnion("status", [
  queuedPinRecordSchema,
  unknownPinRecordSchema,
]);

export const publishedStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaign: z.string().trim().min(1).max(100),
    catalogFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "Invalid catalog fingerprint")
      .nullable(),
    pins: z.array(pinRecordSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const pinIds = new Set<string>();
    const productVariants = new Set<string>();
    const utmContentValues = new Set<string>();

    if (state.pins.length > 0 && state.catalogFingerprint === null) {
      context.addIssue({
        code: "custom",
        message: "catalogFingerprint is required when state contains Pins",
        path: ["catalogFingerprint"],
      });
    }

    state.pins.forEach((pin, index) => {
      const pair = `${pin.productId}:${pin.variant}`;
      const utmContent = new URL(pin.destinationUrl).searchParams.get(
        "utm_content",
      );
      const numericPinId = Number(pin.pinId.slice("pin_".length));

      if (
        !Number.isSafeInteger(numericPinId) ||
        numericPinId < 1 ||
        formatPinId(numericPinId) !== pin.pinId
      ) {
        context.addIssue({
          code: "custom",
          message: `Non-canonical pinId: ${pin.pinId}`,
          path: ["pins", index, "pinId"],
        });
      }

      if (pin.intentType !== intentTypeForVariant(pin.variant)) {
        context.addIssue({
          code: "custom",
          message: `variant ${pin.variant} requires ${intentTypeForVariant(pin.variant)}`,
          path: ["pins", index, "intentType"],
        });
      }

      if (pinIds.has(pin.pinId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate pinId: ${pin.pinId}`,
          path: ["pins", index, "pinId"],
        });
      }

      if (productVariants.has(pair)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate product variant: ${pair}`,
          path: ["pins", index, "variant"],
        });
      }

      if (utmContent === null) {
        context.addIssue({
          code: "custom",
          message: "destinationUrl must contain utm_content",
          path: ["pins", index, "destinationUrl"],
        });
      } else if (utmContentValues.has(utmContent)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate utm_content: ${utmContent}`,
          path: ["pins", index, "destinationUrl"],
        });
      }

      pinIds.add(pin.pinId);
      productVariants.add(pair);
      if (utmContent !== null) utmContentValues.add(utmContent);
    });
  });

export type Product = z.infer<typeof productSchema>;
export type PinRecord = z.infer<typeof pinRecordSchema>;
export type PublishedState = z.infer<typeof publishedStateSchema>;
export type IntentType = (typeof INTENT_TYPES)[number];
export type Variant = 1 | 2 | 3;

export function intentTypeForVariant(variant: Variant): IntentType {
  switch (variant) {
    case 1:
      return "product_type";
    case 2:
      return "theme_style";
    case 3:
      return "use_case";
  }
}

export type PinCandidate = {
  pinId: string;
  product: Product;
  variant: Variant;
  intentType: IntentType;
  destinationUrl: string;
};

export const pinContentSchema = z
  .object({
    searchIntent: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(800),
    altText: z.string().trim().min(1).max(500),
  })
  .strict();

export type PinContent = z.infer<typeof pinContentSchema>;

const INTENT_ANGLE_GUIDANCE: Record<IntentType, string> = {
  product_type:
    "Focus on what the product concretely is (category, material, form).",
  theme_style:
    "Focus on its visual motif, aesthetic, or decorating style.",
  use_case:
    "Focus on a room, occasion, recipient, or intended use for the product.",
};

function buildPinContentPrompt(
  productName: string,
  intentType: IntentType,
): string {
  return [
    "Write Pinterest Pin content in English for a Shopify product.",
    `Product name: ${productName}`,
    `Intent angle: ${intentType}. ${INTENT_ANGLE_GUIDANCE[intentType]}`,
    "Keep this angle meaningfully distinct from the other two possible angles (product_type, theme_style, use_case).",
    "Do not make claims that are not supported by the product name.",
    "Do not stuff keywords.",
    "Return only the requested fields: searchIntent, title, description, altText.",
  ].join("\n");
}

export class PinContentRefusalError extends Error {
  constructor(reason: string) {
    super(`Gemini refused to generate Pin content: ${reason}`);
    this.name = "PinContentRefusalError";
  }
}

export class PinContentIncompleteError extends Error {
  constructor(reason: string) {
    super(`Gemini returned incomplete Pin content: ${reason}`);
    this.name = "PinContentIncompleteError";
  }
}

const pinContentJsonSchema = z.toJSONSchema(pinContentSchema);

export async function generatePinContent(
  client: GoogleGenAI,
  product: Product,
  intentType: IntentType,
  model: string,
): Promise<PinContent> {
  const response = await client.models.generateContent({
    model,
    contents: buildPinContentPrompt(product.name, intentType),
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: pinContentJsonSchema,
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
    throw new PinContentRefusalError(finishReason);
  }
  if (finishReason && finishReason !== "STOP") {
    throw new PinContentIncompleteError(finishReason);
  }

  const text = response.text;
  if (text === undefined || text.trim() === "") {
    throw new Error("Gemini response did not contain Pin content");
  }

  return pinContentSchema.parse(JSON.parse(text));
}

export function parseProducts(input: unknown): Product[] {
  return productsSchema.parse(input);
}

export function fingerprintProducts(products: Product[]): string {
  const snapshot = products.map(({ id, name, url, image }) => ({
    id,
    name,
    url,
    image,
  }));

  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function createInitialState(
  products: Product[],
  campaign = "pinterest_mvp",
): PublishedState {
  return publishedStateSchema.parse({
    schemaVersion: 1,
    campaign,
    catalogFingerprint: fingerprintProducts(products),
    pins: [],
  });
}

export function parsePublishedState(
  input: unknown,
  products: Product[],
): PublishedState {
  const state = publishedStateSchema.parse(input);
  const expectedFingerprint = fingerprintProducts(products);

  if (
    state.catalogFingerprint !== null &&
    state.catalogFingerprint !== expectedFingerprint
  ) {
    throw new Error(
      "products.json changed after the MVP catalog was frozen; restore it or start a new state file",
    );
  }

  const productsById = new Map(products.map((product) => [product.id, product]));

  state.pins.forEach((pin, index) => {
    const product = productsById.get(pin.productId);

    if (product === undefined) {
      throw new Error(
        `published.json pins[${index}] references missing product: ${pin.productId}`,
      );
    }

    if (pin.imageUrl !== product.image) {
      throw new Error(
        `published.json pins[${index}] image does not match frozen product ${product.id}`,
      );
    }

    const expectedDestination = buildTrackingUrl(
      product.url,
      pin.pinId,
      state.campaign,
    );
    if (pin.destinationUrl !== expectedDestination) {
      throw new Error(
        `published.json pins[${index}] destination does not match product ${product.id} and campaign ${state.campaign}`,
      );
    }
  });

  return state;
}

export function buildTrackingUrl(
  productUrl: string,
  pinId: string,
  campaign = "pinterest_mvp",
): string {
  if (campaign.trim() === "") throw new Error("UTM campaign must not be empty");

  const url = new URL(productUrl);
  url.searchParams.set("utm_source", "pinterest");
  url.searchParams.set("utm_medium", "organic");
  url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_content", pinId);
  return url.toString();
}

export function nextPinNumber(state: PublishedState): number {
  const greatestExistingNumber = state.pins.reduce((greatest, pin) => {
    const numericPart = Number.parseInt(pin.pinId.slice("pin_".length), 10);
    return Math.max(greatest, numericPart);
  }, 0);

  return greatestExistingNumber + 1;
}

export function formatPinId(pinNumber: number): string {
  if (!Number.isSafeInteger(pinNumber) || pinNumber < 1) {
    throw new Error("Pin number must be a positive safe integer");
  }

  return `pin_${pinNumber.toString().padStart(3, "0")}`;
}

export function selectCandidates(
  products: Product[],
  state: PublishedState,
  limit: number,
  campaign = state.campaign,
): PinCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Candidate limit must be a positive safe integer");
  }

  if (campaign !== state.campaign) {
    throw new Error(
      `Configured campaign ${campaign} does not match frozen state campaign ${state.campaign}`,
    );
  }

  const unknown = state.pins.find(
    (pin) => pin.status === "buffer_outcome_unknown",
  );
  if (unknown !== undefined) {
    throw new Error(
      `Buffer outcome is unknown for ${unknown.pinId}; reconcile it manually before continuing`,
    );
  }

  const reservedPairs = new Set(
    state.pins.map((pin) => `${pin.productId}:${pin.variant}`),
  );
  const candidates: PinCandidate[] = [];
  let pinNumber = nextPinNumber(state);

  for (const variant of [1, 2, 3] as const) {
    for (const product of products) {
      const pair = `${product.id}:${variant}`;
      if (reservedPairs.has(pair)) continue;

      const pinId = formatPinId(pinNumber);
      candidates.push({
        pinId,
        product,
        variant,
        intentType: intentTypeForVariant(variant),
        destinationUrl: buildTrackingUrl(product.url, pinId, campaign),
      });
      reservedPairs.add(pair);
      pinNumber += 1;

      if (candidates.length === limit) return candidates;
    }
  }

  return candidates;
}

export async function writePublishedStateAtomic(
  filePath: string,
  state: PublishedState,
  products: Product[],
): Promise<void> {
  const validated = parsePublishedState(state, products);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not exist. Preserve the original error.
    }
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");

  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse ${path}: ${message}`);
  }
}

const graphQlEnvelopeSchema = z
  .object({
    data: z.unknown().optional(),
    errors: z
      .array(z.object({ message: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export async function bufferGraphql<T>(
  apiKey: string,
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<T> {
  if (apiKey.trim() === "") throw new Error("BUFFER_API_KEY is required");

  const response = await fetchImplementation(BUFFER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(BUFFER_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Buffer API returned HTTP ${response.status}`);
  }

  const parsedEnvelope = graphQlEnvelopeSchema.safeParse(await response.json());
  if (!parsedEnvelope.success) {
    throw new Error("Buffer GraphQL response had an invalid envelope");
  }

  const envelope = parsedEnvelope.data;
  if (envelope.errors !== undefined && envelope.errors.length > 0) {
    const messages = envelope.errors.map(
      (error) => error.message ?? "Unknown GraphQL error",
    );
    throw new Error(`Buffer GraphQL error: ${messages.join("; ")}`);
  }

  if (envelope.data === undefined || envelope.data === null) {
    throw new Error("Buffer GraphQL response did not contain data");
  }

  return envelope.data as T;
}

const bufferOrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
const bufferChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  service: z.string().min(1),
});
const pinterestBoardSchema = z.object({
  serviceId: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
});

type BufferOrganization = z.infer<typeof bufferOrganizationSchema>;
type BufferChannel = z.infer<typeof bufferChannelSchema>;
type PinterestBoard = z.infer<typeof pinterestBoardSchema>;

export type PinterestChannelInspection = BufferChannel & {
  organization: BufferOrganization;
  boards: PinterestBoard[];
};

export async function inspectPinterestChannels(
  apiKey: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<PinterestChannelInspection[]> {
  const organizationsData = z
    .object({
      account: z.object({
        organizations: z.array(bufferOrganizationSchema),
      }),
    })
    .parse(
      await bufferGraphql<unknown>(
        apiKey,
        `query GetOrganizations {
          account {
            organizations { id name }
          }
        }`,
        fetchImplementation,
      ),
    );

  const inspections: PinterestChannelInspection[] = [];

  for (const organization of organizationsData.account.organizations) {
    const organizationId = JSON.stringify(organization.id);
    const channelsData = z
      .object({ channels: z.array(bufferChannelSchema) })
      .parse(
        await bufferGraphql<unknown>(
          apiKey,
          `query GetChannels {
            channels(input: { organizationId: ${organizationId} }) {
              id
              name
              service
            }
          }`,
          fetchImplementation,
        ),
      );

    for (const channel of channelsData.channels) {
      if (channel.service !== "pinterest") continue;

      const channelId = JSON.stringify(channel.id);
      const channelData = z
        .object({
          channel: z.object({
            metadata: z
              .object({ boards: z.array(pinterestBoardSchema) })
              .nullable(),
          }),
        })
        .parse(
          await bufferGraphql<unknown>(
            apiKey,
            `query GetPinterestBoards {
              channel(input: { id: ${channelId} }) {
                metadata {
                  ... on PinterestMetadata {
                    boards { serviceId name url }
                  }
                }
              }
            }`,
            fetchImplementation,
          ),
        );

      inspections.push({
        ...channel,
        organization,
        boards: channelData.channel.metadata?.boards ?? [],
      });
    }
  }

  return inspections;
}

function positiveIntegerConfig(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

async function previewQueue(): Promise<void> {
  const products = parseProducts(await readJson("products.json"));
  const state = parsePublishedState(await readJson("published.json"), products);
  const limit = positiveIntegerConfig("PINS_PER_RUN", "2");
  const campaign = process.env["UTM_CAMPAIGN"] ?? "pinterest_mvp";
  const candidates = selectCandidates(products, state, limit, campaign);

  console.log(
    JSON.stringify(
      candidates.map((candidate) => ({
        pinId: candidate.pinId,
        productId: candidate.product.id,
        variant: candidate.variant,
        intentType: candidate.intentType,
        destinationUrl: candidate.destinationUrl,
      })),
      null,
      2,
    ),
  );
}

function requiredConfig(name: string): string {
  const value = process.env[name] ?? "";
  if (value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

async function openaiDryRunCommand(): Promise<void> {
  const products = parseProducts(await readJson("products.json"));
  const state = parsePublishedState(await readJson("published.json"), products);
  const limit = positiveIntegerConfig("PINS_PER_RUN", "2");
  const campaign = process.env["UTM_CAMPAIGN"] ?? "pinterest_mvp";
  const model = process.env["GEMINI_MODEL"] ?? "gemini-3.6-flash";
  const candidates = selectCandidates(products, state, limit, campaign);

  const client = new GoogleGenAI({ apiKey: requiredConfig("GEMINI_API_KEY") });

  for (const candidate of candidates) {
    const content = await generatePinContent(
      client,
      candidate.product,
      candidate.intentType,
      model,
    );

    console.log(
      JSON.stringify(
        {
          pinId: candidate.pinId,
          productId: candidate.product.id,
          variant: candidate.variant,
          intentType: candidate.intentType,
          searchIntent: content.searchIntent,
          title: content.title,
          description: content.description,
          altText: content.altText,
        },
        null,
        2,
      ),
    );
  }
}

async function inspectBufferCommand(): Promise<void> {
  if (process.env["CI"] === "true") {
    throw new Error("buffer:inspect is a local-only command and cannot run in CI");
  }

  const apiKey = process.env["BUFFER_API_KEY"] ?? "";
  const channels = await inspectPinterestChannels(apiKey);

  if (channels.length === 0) {
    throw new Error("No Pinterest channels are connected to this Buffer account");
  }

  for (const channel of channels) {
    console.log(`Organization: ${channel.organization.name}`);
    console.log(`Pinterest channel: ${channel.name}`);
    console.log(`BUFFER_CHANNEL_ID=${channel.id}`);

    if (channel.boards.length === 0) {
      console.log("Boards: none returned by Buffer");
    } else {
      console.log("Boards:");
      channel.boards.forEach((board) => {
        console.log(`- ${board.name}`);
        console.log(`  BUFFER_BOARD_ID=${board.serviceId}`);
        console.log(`  ${board.url}`);
      });
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "preview":
      await previewQueue();
      return;
    case "inspect-buffer":
      await inspectBufferCommand();
      return;
    case "openai-dry-run":
      await openaiDryRunCommand();
      return;
    default:
      throw new Error(
        "Usage: npm run queue:preview | npm run buffer:inspect | npm run openai:dry-run",
      );
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
