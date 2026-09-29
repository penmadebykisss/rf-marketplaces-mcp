// Дымовой тест: запускает сервер как MCP-клиент и вызывает инструменты на реальных товарах WB.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ARTICLE = Number(process.argv[2] || 1470151551);
const env = { ...process.env }; delete env.WB_API_TOKEN;
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.js'], env }));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map(t => t.name).join(', '));

let failed = 0;
if (tools.length !== 17) { console.log(`FAIL ожидалось 17 инструментов, получено ${tools.length}`); failed++; }
// SMOKE_OFFLINE=1 — только запуск сервера и список инструментов (для CI: WB может не пускать зарубежные IP)
const OFFLINE = process.env.SMOKE_OFFLINE === '1';
async function run(name, args, check) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  let ok;
  try { ok = check(r.isError ? null : JSON.parse(text), text, r.isError); } catch (e) { ok = false; }
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} (${Date.now() - t0} мс): ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
}

if (!OFFLINE) {
await run('wb_product', { articles: [ARTICLE, 250000000] }, d => d.products.length >= 1 && d.products[0].price_rub > 0);
await run('wb_product_details', { article: ARTICLE }, d => d.name && d.characteristics.length > 0);
await run('wb_price_history', { article: ARTICLE }, d => Array.isArray(d.history));
await run('wb_reviews', { article: ARTICLE, limit: 3 }, d => d.total > 0 && d.reviews.length > 0);
await run('wb_reviews', { article: ARTICLE, limit: 3, max_stars: 2 }, d => d.reviews.every(x => x.stars <= 2) && (d.reviews.length > 0 || !!d.note));
await run('wb_compare', { articles: [ARTICLE, 1453309500, 1337936355] }, d => d.table.length >= 2 && d.leaders);
await run('wb_price_watch', { articles: [ARTICLE, 1453309500, 1337936355] }, d => d.products.length >= 2 && d.cheapest_now);
await run('wb_review_insights', { articles: [ARTICLE, 1453309500] }, d => d.products.length >= 1 && d.across_all.words && d.products[0].negative_pct != null);
await run('wb_card_audit', { article: ARTICLE, competitors: [1453309500, 1337936355] }, d => d.card.photos > 0 && d.recommendations.length > 0);
}
await run('wb_seller_info', {}, (d, text, isErr) => isErr && text.includes('WB_API_TOKEN'));
// Без токена каждый инструмент кабинета продавца должен отказать с понятной подсказкой, не обращаясь к WB
const noToken = (d, text, isErr) => isErr && text.includes('WB_API_TOKEN');
await run('wb_seller_sales', {}, noToken);
await run('wb_seller_orders', {}, noToken);
await run('wb_seller_stocks', {}, noToken);
await run('wb_seller_feedbacks', {}, noToken);
await run('wb_seller_answer_feedback', { id: 'x', text: 'Спасибо за отзыв' }, noToken);
await run('wb_seller_questions', {}, noToken);
await run('wb_seller_answer_question', { id: 'x', text: 'Здравствуйте' }, noToken);
await run('wb_seller_prices', {}, noToken);

await client.close();
console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
