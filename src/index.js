#!/usr/bin/env node
// MCP-сервер «Маркетплейсы РФ»: Wildberries — публичная аналитика по артикулу и кабинет продавца.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as pub from './wb-public.js';
import * as seller from './wb-seller.js';

const server = new McpServer({ name: 'rf-marketplaces', version: '0.1.0' });

const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: 'Ошибка: ' + (e?.message || String(e)) }] });
const safe = fn => async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const Article = z.number().int().positive().describe('Артикул Wildberries (nmId), число из ссылки wildberries.ru/catalog/<артикул>/detail.aspx');
const readOnly = { readOnlyHint: true, openWorldHint: true };

// ================= Публичные данные WB (без токена) =================

server.registerTool('wb_product', {
  title: 'Товар Wildberries по артикулу',
  description: 'Цена, скидка, рейтинг, число отзывов, продавец, остатки и срок доставки для одного или нескольких товаров WB по артикулу. ' +
    'Работает без токена. Товары, которых нет в продаже, в ответ не попадают.',
  inputSchema: { articles: z.array(Article).min(1).max(50).describe('Список артикулов (до 50)') },
  annotations: readOnly,
}, safe(async ({ articles }) => {
  const cards = (await pub.getCards(articles)).map(pub.summarizeCard);
  const found = new Set(cards.map(c => c.article));
  return { products: cards, not_available: articles.filter(a => !found.has(a)) };
}));

server.registerTool('wb_product_details', {
  title: 'Описание и характеристики товара WB',
  description: 'Полное описание, характеристики и состав товара Wildberries из карточки продавца. Работает без токена.',
  inputSchema: { article: Article },
  annotations: readOnly,
}, safe(async ({ article }) => {
  const c = await pub.getCardInfo(article);
  return {
    article, name: c.imt_name, subject: c.subj_name, category: c.subj_root_name, vendor_code: c.vendor_code,
    description: c.description,
    characteristics: (c.options || []).map(o => ({ name: o.name, value: o.value })),
    composition: c.compositions?.map(x => x.name) || undefined,
  };
}));

server.registerTool('wb_price_history', {
  title: 'История цен товара WB',
  description: 'Недельная история цены товара Wildberries (как график цены на сайте) и сводка: минимум, максимум, текущая, изменение. Работает без токена.',
  inputSchema: { article: Article },
  annotations: readOnly,
}, safe(async ({ article }) => {
  const h = await pub.getPriceHistory(article);
  if (!h.length) return { article, history: [], note: 'Истории цен нет (новый товар или WB её не публикует)' };
  const prices = h.map(x => x.price_rub);
  const first = prices[0], last = prices[prices.length - 1];
  return {
    article, points: h.length, from: h[0].date, to: h[h.length - 1].date,
    min_rub: Math.min(...prices), max_rub: Math.max(...prices), last_rub: last,
    change_pct: first ? Math.round((last / first - 1) * 1000) / 10 : null,
    history: h,
  };
}));

server.registerTool('wb_reviews', {
  title: 'Отзывы о товаре WB',
  description: 'Распределение оценок и последние отзывы покупателей о товаре Wildberries (текст, достоинства, недостатки, ответ продавца). ' +
    'Полезно, чтобы понять, за что хвалят и ругают товар или конкурента. Работает без токена.',
  inputSchema: {
    article: Article,
    limit: z.number().int().min(1).max(100).default(20).describe('Сколько отзывов вернуть'),
    max_stars: z.number().int().min(1).max(5).optional().describe('Только отзывы с оценкой не выше этой (например 3 — только негатив)'),
  },
  annotations: readOnly,
}, safe(async ({ article, limit, max_stars }) => {
  const [card] = await pub.getCards([article]);
  const cardId = card?.root ?? (await pub.getCardInfo(article)).imt_id;
  return { article, ...pub.summarizeReviews(await pub.getReviews(cardId), { limit, maxStars: max_stars }) };
}));

server.registerTool('wb_compare', {
  title: 'Сравнение товаров WB',
  description: 'Сравнивает несколько товаров Wildberries (например, свой и конкурентов): цена, скидка, рейтинг, отзывы, остатки, срок доставки — ' +
    'и отмечает лидеров по каждому показателю. Работает без токена.',
  inputSchema: { articles: z.array(Article).min(2).max(20) },
  annotations: readOnly,
}, safe(async ({ articles }) => {
  const rows = (await pub.getCards(articles)).map(pub.summarizeCard);
  const pick = (key, dir) => rows.filter(r => r[key] != null).sort((a, b) => dir * (a[key] - b[key]))[0]?.article ?? null;
  return {
    table: rows.map(r => ({ article: r.article, name: r.name, seller: r.seller, price_rub: r.price_rub, discount_pct: r.discount_pct,
      rating: r.rating, reviews: r.reviews, in_stock: r.in_stock_total, delivery_hours: r.delivery_hours })),
    leaders: {
      cheapest: pick('price_rub', 1), best_rating: pick('rating', -1), most_reviews: pick('reviews', -1),
      most_stock: pick('in_stock_total', -1), fastest_delivery: pick('delivery_hours', 1),
    },
    not_available: articles.filter(a => !rows.some(r => r.article === a)),
  };
}));

// ================= Кабинет продавца WB (нужен WB_API_TOKEN) =================

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Дата в формате ГГГГ-ММ-ДД');

server.registerTool('wb_seller_info', {
  title: 'Кабинет продавца WB: данные продавца',
  description: 'Название и ID продавца, к которому относится токен. Удобно проверить, что токен WB_API_TOKEN работает.',
  inputSchema: {},
  annotations: readOnly,
}, safe(() => seller.sellerInfo()));

server.registerTool('wb_seller_sales', {
  title: 'Кабинет продавца WB: продажи',
  description: 'Продажи и возвраты продавца за период: количество, сколько заплатили покупатели, сколько придёт продавцу, топ артикулов по выручке. ' +
    'Нужен WB_API_TOKEN с категорией «Статистика». Лимит WB — 1 запрос в минуту.',
  inputSchema: { date_from: DateStr.optional().describe('С какой даты (по умолчанию 7 дней назад)'), date_to: DateStr.optional().describe('По какую дату включительно (по умолчанию сегодня)') },
  annotations: readOnly,
}, safe(async ({ date_from, date_to }) => {
  const from = date_from || daysAgo(7), to = date_to || today();
  return { period: { from, to }, ...seller.summarizeSales(await seller.getSales(from), to) };
}));

server.registerTool('wb_seller_orders', {
  title: 'Кабинет продавца WB: заказы',
  description: 'Заказы продавца за период: количество, сумма, отмены, разбивка по дням и топ артикулов. Нужен WB_API_TOKEN («Статистика»). Лимит WB — 1 запрос в минуту.',
  inputSchema: { date_from: DateStr.optional().describe('С какой даты (по умолчанию 7 дней назад)'), date_to: DateStr.optional() },
  annotations: readOnly,
}, safe(async ({ date_from, date_to }) => {
  const from = date_from || daysAgo(7), to = date_to || today();
  return { period: { from, to }, ...seller.summarizeOrders(await seller.getOrders(from), to) };
}));

server.registerTool('wb_seller_stocks', {
  title: 'Кабинет продавца WB: остатки',
  description: 'Остатки товаров продавца на складах WB: по артикулам и складам, в пути к клиенту и от клиента, список закончившихся и заканчивающихся. ' +
    'Нужен WB_API_TOKEN («Статистика»).',
  inputSchema: { low_threshold: z.number().int().min(0).default(5).describe('Сколько штук и меньше считать «заканчивается»') },
  annotations: readOnly,
}, safe(async ({ low_threshold }) => seller.summarizeStocks(await seller.getStocks(), low_threshold)));

server.registerTool('wb_seller_feedbacks', {
  title: 'Кабинет продавца WB: отзывы',
  description: 'Отзывы покупателей на товары продавца (по умолчанию — без ответа), с id для ответа. Нужен WB_API_TOKEN («Отзывы и вопросы»).',
  inputSchema: {
    answered: z.boolean().default(false).describe('false — только без ответа, true — только отвеченные'),
    take: z.number().int().min(1).max(5000).default(30), skip: z.number().int().min(0).default(0),
  },
  annotations: readOnly,
}, safe(args => seller.listFeedbacks(args)));

server.registerTool('wb_seller_answer_feedback', {
  title: 'Кабинет продавца WB: ответить на отзыв',
  description: 'Публикует ответ продавца на отзыв покупателя (ответ будет виден всем на WB). Перед вызовом покажите текст пользователю и получите согласие. ' +
    'Нужен WB_API_TOKEN («Отзывы и вопросы», не только чтение).',
  inputSchema: { id: z.string().describe('id отзыва из wb_seller_feedbacks'), text: z.string().min(2).max(5000).describe('Текст ответа') },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, safe(({ id, text }) => seller.answerFeedback(id, text)));

server.registerTool('wb_seller_questions', {
  title: 'Кабинет продавца WB: вопросы покупателей',
  description: 'Вопросы покупателей о товарах продавца (по умолчанию — без ответа). Нужен WB_API_TOKEN («Отзывы и вопросы»).',
  inputSchema: { answered: z.boolean().default(false), take: z.number().int().min(1).max(10000).default(30), skip: z.number().int().min(0).default(0) },
  annotations: readOnly,
}, safe(args => seller.listQuestions(args)));

server.registerTool('wb_seller_answer_question', {
  title: 'Кабинет продавца WB: ответить на вопрос',
  description: 'Публикует ответ продавца на вопрос покупателя (виден всем на WB). Перед вызовом покажите текст пользователю и получите согласие. ' +
    'Нужен WB_API_TOKEN («Отзывы и вопросы», не только чтение).',
  inputSchema: { id: z.string().describe('id вопроса из wb_seller_questions'), text: z.string().min(2).max(5000) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, safe(({ id, text }) => seller.answerQuestion(id, text)));

server.registerTool('wb_seller_prices', {
  title: 'Кабинет продавца WB: цены и скидки',
  description: 'Текущие цены и скидки продавца по артикулам. Нужен WB_API_TOKEN («Цены и скидки»).',
  inputSchema: { limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).default(0) },
  annotations: readOnly,
}, safe(args => seller.listPrices(args)));

await server.connect(new StdioServerTransport());
