# rf-marketplaces-mcp — аналитика Wildberries для ИИ-агентов

[![penmadebykisss/rf-marketplaces-mcp MCP server](https://glama.ai/mcp/servers/penmadebykisss/rf-marketplaces-mcp/badges/score.svg)](https://glama.ai/mcp/servers/penmadebykisss/rf-marketplaces-mcp)
[![CI](https://github.com/penmadebykisss/rf-marketplaces-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/penmadebykisss/rf-marketplaces-mcp/actions/workflows/ci.yml)
[![M8ven Score](https://m8ven.ai/badge/mcp/penmadebykisss/rf-marketplaces-mcp)](https://m8ven.ai/mcp/penmadebykisss/rf-marketplaces-mcp)

MCP-сервер, который даёт Claude, Cursor и другим ИИ-ассистентам данные о **любом товаре Wildberries по артикулу —
без регистрации и без токена**: цена и скидка, рейтинг и отзывы (в том числе только негативные), остатки и сроки доставки,
история цены, описание и характеристики, сравнение с конкурентами. Подходит для разведки конкурентов, выбора ниши,
анализа отзывов и ИИ-помощников покупателя.

Для продавцов есть и кабинет через официальное API WB (продажи, заказы, остатки, ответы на отзывы) — достаточно добавить токен.

Спросите ассистента: *«Сравни эти три товара конкурентов по цене и отзывам»*, *«За что ругают артикул 1470151551?»*,
*«Какие товары у меня заканчиваются на складах?»*, *«Ответь вежливо на новые отзывы без ответа»* — и он сам вызовет нужные инструменты.

## Инструменты

### Аналитика товаров (токен не нужен)

| Инструмент | Что делает |
|---|---|
| `wb_product` | Цена, скидка, рейтинг, отзывы, продавец, остатки, срок доставки — до 50 артикулов разом |
| `wb_product_details` | Описание, характеристики, состав |
| `wb_price_history` | История цены: минимум, максимум, изменение |
| `wb_reviews` | Распределение оценок и свежие отзывы, можно только негативные |
| `wb_compare` | Сравнение нескольких товаров и лидеры по каждому показателю |
| `wb_price_watch` | Мониторинг цен нескольких товаров: текущая цена против истории, снижения, минимумы, распродажи |
| `wb_review_insights` | Частые жалобы из негативных отзывов сразу по нескольким товарам, доля негатива и ответов продавца |
| `wb_card_audit` | Аудит карточки против конкурентов (фото, видео, описание, характеристики, цена, негатив) с рекомендациями |

### Кабинет продавца (нужен токен WB)

| Инструмент | Что делает |
|---|---|
| `wb_seller_info` | Проверка токена: имя и ID продавца |
| `wb_seller_sales` | Продажи и возвраты за период, выплата продавцу, топ артикулов |
| `wb_seller_orders` | Заказы, отмены, разбивка по дням |
| `wb_seller_stocks` | Остатки по складам, закончившиеся и заканчивающиеся товары |
| `wb_seller_feedbacks` / `wb_seller_answer_feedback` | Отзывы без ответа и публикация ответа |
| `wb_seller_questions` / `wb_seller_answer_question` | Вопросы покупателей и ответ на них |
| `wb_seller_prices` | Текущие цены и скидки |

Ответы на отзывы и вопросы публикуются на WB — ассистент должен показать текст и получить ваше согласие.

## Установка

Нужен только [Node.js](https://nodejs.org) 18+ — сервер запускается прямо с GitHub через `npx`, клонировать ничего не нужно.

### Claude Desktop

Добавьте в `claude_desktop_config.json` (Настройки → Разработчик → Изменить конфиг) и перезапустите Claude:

```json
{
  "mcpServers": {
    "rf-marketplaces": {
      "command": "npx",
      "args": ["-y", "github:penmadebykisss/rf-marketplaces-mcp"],
      "env": { "WB_API_TOKEN": "токен продавца (необязательно)" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add rf-marketplaces -e WB_API_TOKEN=токен -- npx -y github:penmadebykisss/rf-marketplaces-mcp
```

### Cursor, Windsurf и другие клиенты

Любой клиент с поддержкой MCP по stdio: команда `npx`, аргументы `-y github:penmadebykisss/rf-marketplaces-mcp`.
Без токена продавца работают все инструменты аналитики товаров.

### Из исходников

```bash
git clone https://github.com/penmadebykisss/rf-marketplaces-mcp.git
cd rf-marketplaces-mcp && npm install
node src/index.js
```

## Токен продавца Wildberries

Кабинет продавца → Профиль → Настройки → **Доступ к API** → Создать токен. Отметьте категории:
«Статистика», «Отзывы и вопросы», «Цены и скидки». Для ответов на отзывы не ставьте «Только чтение».
Без токена работают все инструменты аналитики товаров.

## Ограничения

- Аналитика товаров использует открытые данные витрины WB; поиск по ключевым словам WB закрыл для внешних запросов, поэтому товары задаются артикулами.
- WB отдаёт только последние ~1000 отзывов товара: распределение оценок и доля негатива считаются по всем отзывам, а тексты жалоб — по последним 1000.
- Статистика продавца: лимит WB — 1 запрос в минуту на метод (сервер кэширует ответы на минуту).
- Ozon и Яндекс Маркет — в планах.

## Проверка

```bash
npm test
```

## English

**rf-marketplaces-mcp** gives Claude, Cursor and other AI assistants data on **any Wildberries product by article
number — no account or API token needed**: price and discount, rating and reviews (including negative-only), stock and
delivery time, price history, description and specs, and side-by-side competitor comparison. Useful for competitor
research, niche selection, review analysis and shopping assistants. Sellers can also connect their dashboard through the
official WB API (sales, orders, warehouse stock, replies to reviews and questions, prices).

```bash
npx -y github:penmadebykisss/rf-marketplaces-mcp
```

Set `WB_API_TOKEN` to a Wildberries seller API token to enable the `wb_seller_*` tools. Ozon and Yandex Market are planned.

## Лицензия

MIT
