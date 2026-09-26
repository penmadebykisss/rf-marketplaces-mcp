// Кабинет продавца Wildberries через официальное API (https://dev.wildberries.ru).
// Токен создаётся в личном кабинете продавца: Профиль → Настройки → Доступ к API.

import { request, cached } from './http.js';

export function wbToken() {
  const t = process.env.WB_API_TOKEN;
  if (!t) {
    throw new Error('Не задан токен WB. Создайте его в кабинете продавца (Профиль → Настройки → Доступ к API, ' +
      'категории «Статистика», «Отзывы и вопросы», «Цены и скидки»; для ответов на отзывы — не «Только чтение») ' +
      'и передайте серверу в переменной окружения WB_API_TOKEN.');
  }
  return t;
}

async function call(url, opts = {}) {
  try {
    return await request(url, { ...opts, headers: { Authorization: wbToken(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  } catch (e) {
    if (e.status === 401) throw new Error('Токен WB недействителен или истёк. Создайте новый в кабинете продавца (Профиль → Настройки → Доступ к API).');
    if (e.status === 403) throw new Error(`У токена WB нет доступа к этому разделу (${new URL(url).host}). Создайте токен с нужной категорией.`);
    if (e.status === 429) throw new Error('Wildberries ограничил частоту запросов. Подождите минуту и повторите (для статистики — не чаще раза в минуту).');
    throw e;
  }
}

export const sellerInfo = () => cached('seller-info', 600_000, () => call('https://common-api.wildberries.ru/api/v1/seller-info'));

// Статистика: лимит WB — 1 запрос в минуту на метод, поэтому кэшируем на 60 секунд.
const STAT = 'https://statistics-api.wildberries.ru/api/v1/supplier';
export const getSales = dateFrom => cached('sales:' + dateFrom, 60_000, () => call(`${STAT}/sales?dateFrom=${dateFrom}`, { timeout: 60000 }));
export const getOrders = dateFrom => cached('orders:' + dateFrom, 60_000, () => call(`${STAT}/orders?dateFrom=${dateFrom}`, { timeout: 60000 }));
export const getStocks = () => cached('stocks', 60_000, () => call(`${STAT}/stocks?dateFrom=2019-06-20`, { timeout: 60000 }));

export function summarizeSales(rows, dateTo) {
  rows = (rows || []).filter(r => !dateTo || r.date.slice(0, 10) <= dateTo);
  const sales = rows.filter(r => String(r.saleID || '').startsWith('S'));
  const returns = rows.filter(r => String(r.saleID || '').startsWith('R'));
  const sum = (a, k) => Math.round(a.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
  const byArticle = {};
  for (const r of sales) {
    const k = r.nmId;
    byArticle[k] ??= { article: r.nmId, vendor_code: r.supplierArticle, subject: r.subject, sold: 0, payout_rub: 0 };
    byArticle[k].sold++; byArticle[k].payout_rub += Number(r.forPay) || 0;
  }
  const top = Object.values(byArticle).map(x => ({ ...x, payout_rub: Math.round(x.payout_rub) })).sort((a, b) => b.payout_rub - a.payout_rub);
  return {
    sales_count: sales.length,
    returns_count: returns.length,
    buyer_paid_rub: sum(sales, 'finishedPrice'),
    payout_to_seller_rub: sum(sales, 'forPay'),
    returns_rub: sum(returns, 'forPay'),
    top_articles: top.slice(0, 15),
  };
}

export function summarizeOrders(rows, dateTo) {
  rows = (rows || []).filter(r => !dateTo || r.date.slice(0, 10) <= dateTo);
  const active = rows.filter(r => !r.isCancel), cancelled = rows.filter(r => r.isCancel);
  const byDay = {}, byArticle = {};
  for (const r of active) {
    const d = r.date.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
    byArticle[r.nmId] ??= { article: r.nmId, vendor_code: r.supplierArticle, orders: 0, sum_rub: 0 };
    byArticle[r.nmId].orders++; byArticle[r.nmId].sum_rub += Number(r.priceWithDisc) || 0;
  }
  return {
    orders_count: active.length,
    cancelled_count: cancelled.length,
    orders_sum_rub: Math.round(active.reduce((s, r) => s + (Number(r.priceWithDisc) || 0), 0)),
    by_day: byDay,
    top_articles: Object.values(byArticle).map(x => ({ ...x, sum_rub: Math.round(x.sum_rub) })).sort((a, b) => b.orders - a.orders).slice(0, 15),
  };
}

export function summarizeStocks(rows, lowThreshold = 5) {
  const by = {};
  for (const r of rows || []) {
    const k = r.nmId;
    by[k] ??= { article: r.nmId, vendor_code: r.supplierArticle, subject: r.subject, qty: 0, to_client: 0, from_client: 0, warehouses: {} };
    by[k].qty += r.quantity || 0;
    by[k].to_client += r.inWayToClient || 0;
    by[k].from_client += r.inWayFromClient || 0;
    if (r.quantity) by[k].warehouses[r.warehouseName] = (by[k].warehouses[r.warehouseName] || 0) + r.quantity;
  }
  const items = Object.values(by).sort((a, b) => a.qty - b.qty);
  return {
    articles: items.length,
    total_qty: items.reduce((s, x) => s + x.qty, 0),
    out_of_stock: items.filter(x => x.qty === 0).map(x => x.article),
    low_stock: items.filter(x => x.qty > 0 && x.qty <= lowThreshold).map(x => ({ article: x.article, vendor_code: x.vendor_code, qty: x.qty })),
    items,
  };
}

// Отзывы и вопросы
const FB = 'https://feedbacks-api.wildberries.ru/api/v1';
export async function listFeedbacks({ answered = false, take = 30, skip = 0 }) {
  const d = await call(`${FB}/feedbacks?isAnswered=${answered}&take=${take}&skip=${skip}&order=dateDesc`);
  return (d?.data?.feedbacks || []).map(f => ({
    id: f.id, date: f.createdDate?.slice(0, 10), stars: f.productValuation,
    text: f.text || '', pros: f.pros || '', cons: f.cons || '', buyer: f.userName,
    article: f.productDetails?.nmId, product: f.productDetails?.productName, vendor_code: f.productDetails?.supplierArticle,
    answer: f.answer?.text || undefined,
  }));
}
export async function answerFeedback(id, text) {
  try {
    await call(`${FB}/feedbacks/answer`, { method: 'POST', body: { id, text } });
  } catch (e) {
    // у части кабинетов ещё действует прежний метод
    if (e.status === 404 || e.status === 405) await call(`${FB}/feedbacks`, { method: 'PATCH', body: { id, text } });
    else throw e;
  }
  return { ok: true, id };
}
export async function listQuestions({ answered = false, take = 30, skip = 0 }) {
  const d = await call(`${FB}/questions?isAnswered=${answered}&take=${take}&skip=${skip}&order=dateDesc`);
  return (d?.data?.questions || []).map(q => ({
    id: q.id, date: q.createdDate?.slice(0, 10), text: q.text,
    article: q.productDetails?.nmId, product: q.productDetails?.productName, answer: q.answer?.text || undefined,
  }));
}
export async function answerQuestion(id, text) {
  await call(`${FB}/questions`, { method: 'PATCH', body: { id, answer: { text }, state: 'wbRu' } });
  return { ok: true, id };
}

// Цены и скидки
export async function listPrices({ limit = 100, offset = 0 }) {
  const d = await call(`https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=${limit}&offset=${offset}`);
  return (d?.data?.listGoods || []).map(g => ({
    article: g.nmID, vendor_code: g.vendorCode, discount_pct: g.discount,
    price_rub: g.sizes?.[0]?.price, price_with_discount_rub: g.sizes?.[0]?.discountedPrice,
  }));
}
