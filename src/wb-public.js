// Публичные данные Wildberries по артикулу — без авторизации.
// Используются те же открытые JSON, что загружает витрина WB: карточка, CDN-файлы и отзывы.

import { request, cached, exists, HttpError } from './http.js';

const DEST = -1257786; // регион доставки: Москва
const WB_HEADERS = { Origin: 'https://www.wildberries.ru', Referer: 'https://www.wildberries.ru/' };
const rub = kop => (typeof kop === 'number' ? Math.round(kop) / 100 : null);

/** Карточки товаров (до 100 артикулов за запрос). Отдаёт только товары, которые сейчас есть в продаже. */
export async function getCards(articles) {
  const ids = [...new Set(articles.map(Number))];
  const url = `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${DEST}&spp=30&nm=${ids.join(';')}`;
  const data = await cached('cards:' + ids.join(';'), 60_000, () => request(url, { headers: WB_HEADERS }));
  return data?.products || [];
}

export function summarizeCard(p) {
  const sizes = p.sizes || [];
  const priced = sizes.find(s => s.price) || {};
  const stocks = {};
  let total = 0;
  for (const s of sizes) for (const st of s.stocks || []) { total += st.qty || 0; stocks[st.wh] = (stocks[st.wh] || 0) + (st.qty || 0); }
  return {
    article: p.id,
    card_id: p.root,
    name: p.name,
    brand: p.brand,
    seller: p.supplier,
    seller_id: p.supplierId,
    seller_rating: p.supplierRating,
    rating: p.reviewRating ?? p.rating,
    reviews: p.feedbacks,
    price_rub: rub(priced.price?.product),
    price_before_discount_rub: rub(priced.price?.basic),
    discount_pct: priced.price?.basic ? Math.round((1 - priced.price.product / priced.price.basic) * 100) : null,
    in_stock_total: p.totalQuantity ?? total,
    warehouses: Object.keys(stocks).length,
    sizes: sizes.filter(s => s.name).map(s => ({ size: s.name, qty: (s.stocks || []).reduce((a, x) => a + (x.qty || 0), 0) })),
    delivery_hours: priced.time1 != null ? (priced.time1 || 0) + (priced.time2 || 0) : null,
    url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
  };
}

// ---- CDN (basket-XX.wbbasket.ru): номер сервера зависит от «тома» артикула (vol = артикул / 100 000) ----
// Известные границы томов; для новых томов оцениваем номер и уточняем перебором соседних, результат кэшируем.
const BASKET_TABLE = [143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485,
  3701, 3917, 4133, 4349, 4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605];
const MAX_BASKET = 72;
const hostByVol = new Map();
function guessBasket(vol) {
  const i = BASKET_TABLE.findIndex(max => vol <= max);
  if (i >= 0) return i + 1;
  // ближайший уже найденный том точнее грубой оценки
  let best = null;
  for (const [v, h] of hostByVol) if (!best || Math.abs(v - vol) < Math.abs(best[0] - vol)) best = [v, h];
  if (best) return Math.min(MAX_BASKET, Math.max(1, best[1] + Math.round((vol - best[0]) / 700)));
  return Math.min(MAX_BASKET, 40 + Math.round((vol - 9605) / 700));
}
async function basketUrl(article, file) {
  const nm = Number(article), vol = Math.floor(nm / 1e5), part = Math.floor(nm / 1e3);
  const path = h => `https://basket-${String(h).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/${file}`;
  if (hostByVol.has(vol)) return path(hostByVol.get(vol));
  // Проверяем серверы от наиболее вероятного к менее вероятным небольшими пачками:
  // массовый параллельный перебор забивает DNS-резолвер и тормозит остальные запросы.
  const guess = guessBasket(vol);
  const order = [];
  for (let d = 0; order.length < MAX_BASKET; d++) {
    for (const h of d ? [guess - d, guess + d] : [guess]) if (h >= 1 && h <= MAX_BASKET) order.push(h);
    if (guess - d < 1 && guess + d > MAX_BASKET) break;
  }
  for (let i = 0; i < order.length; i += 6) {
    const batch = order.slice(i, i + 6);
    try {
      const h = await Promise.any(batch.map(h => exists(path(h).replace(file, 'ru/card.json'), WB_HEADERS, 6000).then(ok => (ok ? h : Promise.reject()))));
      hostByVol.set(vol, h);
      return path(h);
    } catch { /* следующая пачка */ }
  }
  throw new Error(`Не удалось найти файлы товара ${nm} на CDN Wildberries (товар удалён или артикул неверный)`);
}

/** Полное описание и характеристики из карточки продавца. */
export async function getCardInfo(article) {
  return cached('info:' + article, 3_600_000, async () => request(await basketUrl(article, 'ru/card.json'), { headers: WB_HEADERS }));
}

/** История цен (еженедельные точки, как на графике в карточке WB). */
export async function getPriceHistory(article) {
  return cached('ph:' + article, 3_600_000, async () => {
    try {
      const rows = await request(await basketUrl(article, 'price-history.json'), { headers: WB_HEADERS });
      return (rows || []).map(r => ({ date: new Date(r.dt * 1000).toISOString().slice(0, 10), price_rub: rub(r.price?.RUB) }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return []; // у новых товаров истории ещё нет
      throw e;
    }
  });
}

/** Отзывы по карточке (card_id = root). */
export async function getReviews(cardId) {
  return cached('fb:' + cardId, 600_000, async () => {
    // Отзывы карточки лежат на одном из двух серверов; пустой ответ с первого — не повод сдаваться
    let fallback = null, lastErr = null;
    for (const host of ['feedbacks1.wb.ru', 'feedbacks2.wb.ru']) {
      try {
        const d = await request(`https://${host}/feedbacks/v1/${cardId}`, { headers: WB_HEADERS });
        if (d?.feedbacks?.length) return d;
        fallback ??= d;
      } catch (e) { lastErr = e; }
    }
    if (fallback) return fallback;
    throw lastErr || new Error('Отзывы не найдены');
  });
}

export function summarizeReviews(d, { limit = 20, maxStars } = {}) {
  let list = (d?.feedbacks || []).slice().sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  if (maxStars) list = list.filter(f => f.productValuation <= maxStars);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const f of d?.feedbacks || []) if (dist[f.productValuation] != null) dist[f.productValuation]++;
  return {
    average: d?.valuation ? Number(d.valuation) : null,
    total: d?.feedbackCount ?? (d?.feedbacks || []).length,
    loaded: (d?.feedbacks || []).length,
    stars_distribution: dist,
    reviews: list.slice(0, limit).map(f => ({
      date: f.createdDate?.slice(0, 10),
      stars: f.productValuation,
      text: f.text || '',
      pros: f.pros || '',
      cons: f.cons || '',
      size: f.size || undefined,
      color: f.color || undefined,
      seller_answer: f.answer?.text || undefined,
    })),
  };
}
