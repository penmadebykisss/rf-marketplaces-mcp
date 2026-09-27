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
  const dist = fullDistribution(d);
  const hiddenNeg = maxStars && !list.length ? Object.entries(dist).filter(([k]) => k <= maxStars).reduce((a, [, v]) => a + v, 0) : 0;
  return {
    average: d?.valuation ? Number(d.valuation) : null,
    total: d?.feedbackCount ?? (d?.feedbacks || []).length,
    loaded: (d?.feedbacks || []).length,
    stars_distribution: dist,
    note: hiddenNeg ? `WB отдаёт только последние ${(d?.feedbacks || []).length} отзывов; среди них нет оценок ≤${maxStars}, хотя всего таких ${hiddenNeg} — они более старые.` : undefined,
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

// ---------- Аналитика поверх данных: аудит карточки и жалобы из отзывов ----------

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
  'теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ' +
  'ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один ' +
  'почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них ' +
  'какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это очень товар ' +
  'товара товаром пришел пришла пришло пришли заказ заказала заказал заказывала вообще просто всё весь вся брала взяла купила купил').split(' '));

function words(text) {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]{4,}/g) || []).filter(w => !STOP.has(w));
}

/** Частые слова и пары слов в текстах (грубая, но быстрая выжимка тем). */
export function topTerms(texts, n = 15) {
  const uni = new Map(), bi = new Map();
  for (const t of texts) {
    const w = words(t), seenU = new Set(), seenB = new Set();
    w.forEach((x, i) => {
      if (!seenU.has(x)) { seenU.add(x); uni.set(x, (uni.get(x) || 0) + 1); }
      if (i && !seenB.has(w[i - 1] + ' ' + x)) { const b = w[i - 1] + ' ' + x; seenB.add(b); bi.set(b, (bi.get(b) || 0) + 1); }
    });
  }
  const top = m => [...m].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([term, reviews]) => ({ term, reviews }));
  return { phrases: top(bi), words: top(uni) };
}

/** Распределение оценок по всем отзывам карточки (WB считает его сам), иначе — по загруженным. */
export function fullDistribution(d) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  if (d?.valuationDistribution) for (const k in dist) dist[k] = Number(d.valuationDistribution[k]) || 0;
  else for (const f of d?.feedbacks || []) if (dist[f.productValuation] != null) dist[f.productValuation]++;
  return dist;
}

/** Теги отзывов, которые WB выделяет сам (например «Качество»: плюсов/минусов). */
export async function getReviewTags(cardId) {
  return cached('tags:' + cardId, 3_600_000, async () => {
    const [host] = await request(`https://feedback-bt.wildberries.ru/feedback/api/v2/host?imt=${cardId}`, { headers: WB_HEADERS }).catch(() => []);
    const d = await request(`${host || 'https://feedback-view-03.wb.ru'}/feedbacks/tags/v1/${cardId}?lang=ru`, { headers: WB_HEADERS });
    return (d?.summary || []).map(t => ({ tag: t.name, plus: t.plus_count, minus: t.minus_count }))
      .sort((a, b) => b.minus - a.minus || b.plus - a.plus);
  });
}

/** Негатив и ответы продавца по сырому ответу отзывов. */
export function reviewStats(d, maxStars = 3) {
  const all = d?.feedbacks || [];
  const neg = all.filter(f => f.productValuation <= maxStars);
  const answered = all.filter(f => f.answer?.text).length;
  const dist = fullDistribution(d), total = Object.values(dist).reduce((a, b) => a + b, 0);
  const negTotal = Object.entries(dist).filter(([k]) => k <= maxStars).reduce((a, [, v]) => a + v, 0);
  return {
    loaded: all.length,
    negative: negTotal,
    negative_in_loaded: neg.length,
    negative_pct: total ? Math.round(negTotal / total * 1000) / 10 : null,
    seller_answer_pct: all.length ? Math.round(answered / all.length * 1000) / 10 : null,
    negTexts: neg.map(f => [f.cons, f.text].filter(Boolean).join('. ')).filter(Boolean),
    negSamples: neg.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate)).slice(0, 5)
      .map(f => ({ date: f.createdDate?.slice(0, 10), stars: f.productValuation, text: [f.cons, f.text].filter(Boolean).join(' | ').slice(0, 300) })),
  };
}

const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Метрики одной карточки для аудита. */
export async function cardMetrics(p) {
  const s = summarizeCard(p);
  const [info, fb] = await Promise.all([
    getCardInfo(p.id).catch(() => null),
    getReviews(p.root).catch(() => null),
  ]);
  const rs = fb ? reviewStats(fb) : null;
  return {
    article: s.article, name: s.name, seller: s.seller, price_rub: s.price_rub, discount_pct: s.discount_pct,
    rating: s.rating, reviews: s.reviews, in_stock: s.in_stock_total, delivery_hours: s.delivery_hours,
    photos: info?.media?.photo_count ?? p.pics ?? null, has_video: !!info?.media?.has_video, has_rich_content: !!info?.has_rich,
    description_chars: info?.description?.length ?? null, characteristics: info?.options?.length ?? null,
    negative_pct: rs?.negative_pct ?? null, seller_answer_pct: rs?.seller_answer_pct ?? null,
  };
}

/** Рекомендации по карточке относительно конкурентов (медиан). */
export function auditAdvice(me, rivals) {
  const tips = [], m = k => median(rivals.map(r => r[k]));
  const bench = {};
  for (const k of ['price_rub', 'rating', 'reviews', 'photos', 'description_chars', 'characteristics', 'negative_pct', 'seller_answer_pct', 'delivery_hours'])
    bench[k] = rivals.length ? m(k) : null;
  const lt = (k, f = 1) => me[k] != null && bench[k] != null && me[k] < bench[k] * f;
  const gt = (k, f = 1) => me[k] != null && bench[k] != null && me[k] > bench[k] * f;
  if ((me.photos ?? 0) < 5 || lt('photos', 0.8)) tips.push(`Мало фото: ${me.photos ?? 0}${bench.photos != null ? ` против ~${bench.photos} у конкурентов` : ''}. Добавьте фото в использовании, детали, размеры/инфографику.`);
  if (!me.has_video && rivals.some(r => r.has_video)) tips.push('У конкурентов есть видео, у вас нет — добавьте короткий ролик.');
  if (!me.has_rich_content && rivals.some(r => r.has_rich_content)) tips.push('У конкурентов есть рич-контент — стоит добавить.');
  if ((me.description_chars ?? 0) < 500 || lt('description_chars', 0.6)) tips.push(`Короткое описание (${me.description_chars ?? 0} знаков${bench.description_chars != null ? `, у конкурентов ~${bench.description_chars}` : ''}): раскройте выгоды и ключевые запросы.`);
  if (lt('characteristics', 0.7)) tips.push(`Заполнено ${me.characteristics} характеристик против ~${bench.characteristics}: заполните все — они влияют на фильтры и поиск.`);
  if (gt('price_rub', 1.15)) tips.push(`Цена ${me.price_rub} ₽ выше медианы конкурентов (${bench.price_rub} ₽) больше чем на 15% — нужна причина платить больше (фото, отзывы, комплектация) или корректировка цены.`);
  if (lt('rating', 1) && bench.rating - me.rating >= 0.2) tips.push(`Рейтинг ${me.rating} ниже, чем у конкурентов (~${bench.rating}). Разберите жалобы через wb_review_insights.`);
  if (me.negative_pct != null && (me.negative_pct >= 15 || gt('negative_pct', 1.5))) tips.push(`Доля отзывов 1–3★: ${me.negative_pct}%${bench.negative_pct != null ? ` (у конкурентов ~${bench.negative_pct}%)` : ''} — проверьте частые жалобы.`);
  if (me.seller_answer_pct != null && me.seller_answer_pct < 50) tips.push(`Продавец отвечает только на ${me.seller_answer_pct}% отзывов — ответы повышают доверие.`);
  if (lt('reviews', 0.3)) tips.push(`Отзывов ${me.reviews} против ~${bench.reviews} у конкурентов — стимулируйте отзывы (вкладыш, баллы за отзыв).`);
  if (gt('delivery_hours', 1.5)) tips.push(`Доставка дольше конкурентов (${me.delivery_hours} ч против ~${bench.delivery_hours} ч) — разместите товар на ближних складах.`);
  if (!me.in_stock) tips.push('Товара нет в наличии — карточка теряет позиции.');
  return { benchmark_median: bench, recommendations: tips.length ? tips : ['Явных слабых мест по сравнению с конкурентами не найдено.'] };
}
