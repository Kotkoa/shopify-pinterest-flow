# Предварительный план Kotkoa Pinterest Flow

## Статус

**Gate 0 / blocked by storefront access.** Defaults подтверждены. Buffer Pinterest channel и board обнаруживаются через API; импортировано 38 active + published товаров (114 вариантов), все 38 CDN images публичны. Product URLs сейчас перенаправляют на `/password`, поэтому живой Pin нельзя публиковать до открытия storefront или предоставления другого публичного домена.

## 1. Проверяемая гипотеза MVP

> Может ли автоматизированный процесс регулярно публиковать Pinterest-пины товаров Kotkoa и приводить измеримый реальный трафик на соответствующие страницы Shopify?

Проверяем только цепочку:

```text
Shopify product
→ automated Pin
→ Pinterest impression
→ outbound click
→ Shopify session
```

Продажи, качество ассортимента, winner scoring и генерация новых продуктов не являются условиями успеха первого MVP.

## 2. Минимальная структура репозитория

```text
shopify-pinterest-flow/
├── .github/
│   └── workflows/
│       └── publish-pinterest.yml
├── src/
│   └── pinterest.ts
├── tests/
│   └── pinterest.test.ts
├── products.json
├── products.example.json
├── published.json
├── .env.example
├── .gitignore
├── AGENTS.md
├── PLAN.md
├── README.md
├── package.json
├── package-lock.json
└── tsconfig.json
```

В MVP не добавляются база данных, dashboard, Shopify API или генератор изображений.

## 3. Проверенная техническая основа

Buffer предоставляет GraphQL API:

- endpoint: `https://api.buffer.com`;
- авторизация: Bearer API key;
- Pinterest поддерживается;
- Pinterest Pin может содержать изображение, title, description, destination URL, board и alt text;
- режим `addToQueue` добавляет пост в следующий доступный слот расписания Buffer.

Документация:

- https://developers.buffer.com/guides/your-first-post.html
- https://developers.buffer.com/guides/posts-and-scheduling.html
- https://developers.buffer.com/examples/create-image-post.html
- https://developers.buffer.com/reference.html

Для генерации структурированных текстов планируется официальный OpenAI Node SDK и Responses API structured outputs.

## 4. Credentials и configuration

### GitHub Secrets

```text
OPENAI_API_KEY
BUFFER_API_KEY
BUFFER_CHANNEL_ID
BUFFER_BOARD_ID
```

- `BUFFER_CHANNEL_ID` — ID подключённого Pinterest channel в Buffer.
- `BUFFER_BOARD_ID` — `serviceId` выбранной Pinterest board.
- `GITHUB_TOKEN` автоматически предоставляет GitHub Actions.

### Несекретная конфигурация

```text
OPENAI_MODEL=gpt-5-mini
PINS_PER_RUN=2
UTM_CAMPAIGN=pinterest_mvp
DRY_RUN=false
```

Shopify credentials в MVP не нужны.

## 5. Data model MVP

### `products.json`

```json
[
  {
    "id": "lemon-pillow-01",
    "name": "Mediterranean Lemon Pillow",
    "url": "https://shop.kotkoa.com/products/lemon-pillow",
    "image": "https://cdn.shopify.com/example.jpg"
  }
]
```

Ограничения:

- стабильный уникальный `id`;
- публичные HTTPS URL;
- изображение доступно Buffer без авторизации;
- около 40 реальных товаров.

### `published.json`

```json
{
  "schemaVersion": 1,
  "campaign": "pinterest_mvp",
  "catalogFingerprint": "sha256-of-ordered-catalog",
  "pins": [
    {
      "pinId": "pin_001",
      "productId": "lemon-pillow-01",
      "variant": 1,
      "intentType": "product_type",
      "searchIntent": "Mediterranean pillow",
      "title": "Mediterranean Lemon Pillow",
      "description": "...",
      "altText": "...",
      "destinationUrl": "https://shop.kotkoa.com/products/lemon-pillow?utm_source=pinterest&utm_medium=organic&utm_campaign=pinterest_mvp&utm_content=pin_001",
      "imageUrl": "https://cdn.shopify.com/example.jpg",
      "bufferPostId": "...",
      "status": "buffer_queued",
      "queuedAt": "2026-08-16T12:00:00.000Z",
      "dueAt": "2026-08-16T14:00:00.000Z"
    }
  ]
}
```

`buffer_queued` означает, что Buffer принял Pin. Это ещё не подтверждение фактической публикации в Pinterest. `catalogFingerprint` замораживает ordered snapshot из `id`, `name`, `url` и `image`. При неопределённом результате Buffer сохраняется `buffer_outcome_unknown` с `attemptedAt`, но без обязательных `bufferPostId` и `queuedAt`.

## 6. Search intents

Чтобы не создавать три почти одинаковых описания, каждый вариант использует отдельный фиксированный угол:

1. `product_type` — что это за товар;
2. `theme_style` — мотив, стиль или эстетика;
3. `use_case` — комната, событие, получатель или сценарий применения.

Пример:

```text
product_type → Mediterranean pillow
theme_style  → Lemon home decor
use_case     → Summer Mediterranean decor
```

Детерминированный TypeScript выбирает тип intent. OpenAI генерирует конкретный search intent и текст, но не управляет очередью, идентификаторами, UTM или состоянием.

## 7. Правило очереди

Используется справедливый детерминированный порядок:

```text
variant 1 для всех товаров
→ variant 2 для всех товаров
→ variant 3 для всех товаров
```

Технически выбирается товар с минимальным количеством завершённых вариантов; порядок в `products.json` используется как tie-breaker.

Так один товар не занимает три последовательных публикационных слота, а весь каталог быстрее получает первый тест.

## 8. Поведение `src/pinterest.ts`

За один запуск скрипт должен:

1. прочитать и валидировать `products.json` и `published.json`;
2. выбрать до `PINS_PER_RUN` следующих вариантов;
3. создать последовательный уникальный `pin_XXX`;
4. определить `intentType`;
5. вызвать OpenAI Responses API со structured output;
6. проверить ограничения title, description и alt text;
7. сформировать UTM URL стандартным `URL` API;
8. отправить GraphQL mutation в Buffer;
9. после успешного ответа записать Pin в `published.json`;
10. сохранить JSON атомарно;
11. не выбирать уже записанную комбинацию `productId + variant`.

### Dry run

```bash
DRY_RUN=true npm run publish
```

Dry run может вызвать OpenAI и показать preview, но не вызывает Buffer и не изменяет `published.json`.

## 9. UTM tracking

Каждый Pin получает:

```text
utm_source=pinterest
utm_medium=organic
utm_campaign=pinterest_mvp
utm_content=pin_XXX
```

URL создаётся через стандартный `URL` API с сохранением посторонних существующих query parameters.

Связь должна быть однозначной:

```text
utm_content
↔ pinId
↔ productId + variant
↔ Buffer post ID
```

## 10. GitHub Actions

Предварительная схема:

- три запуска в день;
- два Pin за запуск;
- около шести Pin в день;
- Buffer `addToQueue`;
- в Buffer настроено шесть ежедневных Pinterest slots.

Пример cron:

```text
07:00 UTC
13:00 UTC
19:00 UTC
```

Workflow должен:

- поддерживать `schedule` и `workflow_dispatch`;
- использовать Node.js 22 и `npm ci`;
- иметь `permissions: contents: write` только для сохранения состояния;
- использовать единый concurrency group с `cancel-in-progress: false`;
- после каждого принятого Buffer post атомарно обновлять локальный state;
- коммитить изменённый `published.json` даже если следующий элемент batch завершился ошибкой, после чего сохранять исходный non-zero exit status;
- не выводить секреты;
- иметь timeout.

GitHub cron может запускаться с задержкой. Реальное время публикации определяет расписание Buffer.

## 11. MVP Gates и критерии проверки

### Gate 0 — capability and observability smoke test

**Гипотеза:** конкретные аккаунты Kotkoa технически поддерживают путь Buffer → live Pinterest Pin → Shopify session, а результат можно измерить.

Порядок:

1. Read-only запросом проверить Buffer API key, Pinterest channel и доступные boards.
2. Выбрать один реальный товар и публичный Shopify CDN image.
3. Создать один Pin с вручную подготовленным текстом без OpenAI.
4. Дождаться фактического появления Pin в Pinterest, а не только `buffer_queued`.
5. Проверить board, изображение, title и destination URL живого Pin.
6. Выполнить один маркированный технический переход.
7. Проверить сохранение UTM после redirect и появление сессии в заранее выбранном Shopify report.
8. Зафиксировать задержку появления данных и доступные dimensions.

Для технического перехода использовать отдельную атрибуцию:

```text
utm_campaign=pinterest_technical_test
utm_content=technical_pin_001
```

Этот переход исключается из organic MVP result.

Gate пройден только если существует живой Pinterest Pin и его техническая сессия наблюдаема в выбранном инструменте аналитики. Если `utm_content` недоступен, отдельно решить, достаточно ли агрегированной атрибуции или требуется GA4.

### Gate 1 — локальная детерминированная очередь

**Гипотеза:** система правильно выбирает следующий вариант и не повторяет зарезервированные комбинации.

Реализовать:

- runtime validation JSON;
- формальный variant-major order;
- in-memory reservation внутри batch;
- три intent slots;
- Pin ID;
- UTM generation;
- atomic state write;
- остановку при `buffer_outcome_unknown`.

Проверка:

- unit tests проходят;
- `products.length × 3` даёт ровно столько уникальных комбинаций;
- fixture из 40 товаров даёт 120 комбинаций;
- повторный завершённый запуск не выбирает записанный вариант;
- после завершения каталога очередь пуста;
- нарушенные state invariants отклоняются до API calls.

### Gate 2 — один OpenAI dry run

**Гипотеза:** выбранная OpenAI model возвращает безопасный структурированный контент для одного товара.

Проверка:

- ответ соответствует зафиксированной schema;
- title, description и alt text находятся в лимитах;
- content использует только подтверждённые product facts;
- refusal, incomplete output и rate limit обрабатываются;
- `published.json` не меняется.

### Gate 3 — один автоматически созданный live Pin

**Гипотеза:** автоматизированный путь создаёт живой Pinterest Pin с основной UTM attribution.

Проверка:

- Buffer вернул post ID;
- Pin фактически появился в Pinterest;
- выбрана правильная board;
- content, image и destination URL корректны;
- UTM сохранились;
- технический результат не засчитывается как organic traffic.

### Gate 4 — малая выборка

**Гипотеза:** путь устойчив на нескольких Pins до масштабирования каталога.

Запустить 5–10 Pins и проверить:

- live publication rate;
- отсутствие известных дублей;
- корректность state при partial failures;
- обработку ambiguous Buffer outcome без слепого retry;
- появление не-тестовых outbound clicks и Shopify sessions либо честный результат `inconclusive` при недостаточной экспозиции.

### Gate 5 — GitHub Actions и полный каталог

**Гипотеза:** процесс устойчиво создаёт около шести queue submissions в день без ручного запуска.

Проверка:

- workflow запускается три раза в день;
- Buffer получает до шести Pins;
- фактические live publications считаются отдельно от queue submissions;
- состояние сохраняется и при частично успешном batch;
- `GITHUB_TOKEN` может писать state с текущими repository rules;
- отсутствуют известные повторные `productId + variant`;
- ошибки видны как failed workflow.

### Gate 6 — результат полного каталога

Техническое завершение MVP:

- `products.length × 3` уникальных Pins поставлены в очередь;
- фактически опубликованные Pins посчитаны отдельно;
- все UTM URLs уникальны;
- нет известных дублей;
- ссылки ведут на правильные Shopify products.

Operational result и traffic result оцениваются отдельно.

Основная traffic-гипотеза подтверждена только если существуют не-тестовые:

- Pinterest outbound clicks;
- Shopify Pinterest organic sessions.

Контролируемый технический клик не считается подтверждением organic traffic. Нулевая экспозиция или слишком мало impressions дают результат `inconclusive`, а не автоматический failure.

## 12. Технические риски

### 12.1 Buffer plan limits

У тарифа Buffer может быть ограничен размер очереди. Шесть ежедневных slots должны предотвращать накопление backlog. Лимиты необходимо проверить на фактическом аккаунте до полного запуска.

### 12.2 Pinterest board обязателен

Buffer требует `boardServiceId` при создании Pinterest Pin.

### 12.3 JSON state, partial batches и неопределённый Buffer outcome

Между Buffer и Git нет общей транзакции. Возможны два разных случая:

- один Pin в batch принят, а следующий завершился ошибкой;
- Buffer принял Pin, но клиент получил timeout и не знает результат.

После каждого подтверждённого успеха state записывается локально. Workflow обязан сохранить этот state даже при последующей ошибке batch, а затем завершиться с исходным non-zero status.

Неопределённый результат сохраняется как `buffer_outcome_unknown`. Новые submissions блокируются до ручной сверки; Buffer create mutation нельзя повторять вслепую. Supabase не добавляется заранее.

### 12.4 Одинаковые изображения

Три Pins одного товара используют одно product image. Pinterest может слабее распространять визуальные дубли. В MVP это контролируемая переменная. Creative variations и Sharp не добавляются до доказательства базового трафика.

### 12.5 Shopify attribution

Доступность детального `utm_content` зависит от Shopify plan и reporting. UTM всё равно передаётся корректно. Дополнительную аналитику следует добавлять только после проверки фактического ограничения.

### 12.6 Shopify CDN

Buffer принимает только публично доступные media URLs. URL и тип ответа должны проверяться до публикации.

### 12.7 AI не является keyword research

Сгенерированные intents — тестируемые гипотезы, а не доказанная поисковая статистика.

## 13. Что не входит в MVP

Не реализовывать:

- Shopify Admin API;
- Supabase/Postgres;
- dashboard;
- Product Test Queue и статусы `NEW/TESTING/WINNER/WEAK`;
- winner scaling;
- automated analytics ingestion;
- product scoring;
- winner pattern analysis;
- генерацию продуктов или изображений;
- прямой Pinterest API;
- keyword database;
- AI agent loop;
- MCP;
- дополнительные social networks.

## 14. Подтверждённые defaults

1. Язык Pinterest content — английский.
2. Публикация — Buffer `addToQueue`.
3. Workflow — 3 запуска × 2 Pins.
4. Состояние — commit `published.json` в default branch.
5. Pin IDs — последовательные `pin_001`, `pin_002`, … без привязки к фиксированному размеру каталога.
6. OpenAI model по умолчанию — `gpt-5-mini`, с возможностью изменить через env.
7. Источник MVP — около 40 реальных товаров в `products.json` без Shopify Admin API.

## 15. Stage 2+ после доказанного MVP

Только после подтверждения traffic path:

1. Stage 2 — получение новых активных товаров через Shopify API.
2. Stage 3 — состояния `NEW`, `TESTING`, `WINNER`, `WEAK`.
3. Stage 4 — распределение ограниченных ежедневных slots между новыми товарами и Product Winners.
4. Stage 5 — переход с JSON на Supabase/Postgres, когда JSON реально перестанет быть удобным.
5. Stage 6 — AI-анализ структуры побед: product type, design, style, color, search intent и mockup type.

Content Winner и Product Winner должны оставаться разными понятиями. Решения о новых товарах принимаются по коммерческим сигналам с приоритетом:

```text
Orders
↓
Checkout
↓
Add to cart
↓
Outbound clicks
↓
Shopify sessions
↓
Saves
↓
Impressions
```

Новый товар, даже созданный из доказанной winner-гипотезы, всегда проходит тест заново.
