#!/usr/bin/env node
/**
 * Neo Pipeline · Этап 1 — проверка и улучшение запроса пользователя.
 *
 * Вход:  текст заявки (аргумент --request "…" или файл --request-file path)
 * Выход: JSON с финальным промптом: {"ok":true,"finalPrompt":"…","summary":"…"}
 *        либо {"ok":false,"reason":"…"} — заявка отклонена.
 *
 * Результат печатается в stdout и сохраняется в файл --out (final-prompt.json).
 */
'use strict';

const fs = require('fs');
const {log, die, askDshJson, normalizeModel, parseModelFromText, pickWorkingModel, DEFAULT_MODEL} = require('./lib/common');

/* ------------------------- разбор аргументов ------------------------- */
function parseArgs(argv) {
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request') args.request = argv[++i];
    else if (a === '--request-file') args.requestFile = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

let request = args.request;
if (!request && args.requestFile) request = fs.readFileSync(args.requestFile, 'utf8');
if (!request) die('Не передан запрос: используйте --request "…" или --request-file <файл>');

request = String(request).trim();
if (request.length > 6000) request = request.slice(0, 6000);

/* ------------------------ выбор модели ------------------------------- */
/* --model = уже проверенная оркестратором — доверяем без повторной пробы;
   иначе подбираем рабочую: env NEO_MODEL или упоминание из текста заявки. */
let model = normalizeModel(args.model) || null;
if (!model) {
  model = pickWorkingModel(normalizeModel(process.env.NEO_MODEL) || parseModelFromText(request));
  log(`Модель для генерации: ${model}`);
}

/* ---------------------- метапромпт для улучшения --------------------- */
const META_PROMPT = `
Ты — промпт-инженер сервиса Neo (подкомпания CBS5M). Neo создаёт СТАТИЧНЫЕ сайты
(визитки, портфолио, лендинги, страницы услуг, приглашения) с помощью ИИ.

Твоя задача — проверить заявку клиента и улучшить её до качественного финального
промпта для ИИ-генератора одностраничных сайтов.

ШАГ 1 — ПРОВЕРКА. Отклони заявку (ok=false), если она:
- пустая или бессмысленная;
- не про сайт (например, просит написать программу, текст курсовой, пост в соцсети);
- требует серверной части: интернет-магазин с оплатой, личный кабинет, базу данных,
  регистрацию пользователей, динамический бэкенд;
- нарушает закон или содержит запрещённый контент.

ШАГ 2 — УЛУЧШЕНИЕ. Если заявка подходит (ok=true), составь финальный промпт:
- уточни тип сайта, назначение и целевую аудиторию;
- придумай структуру: шапка, герой-блок, разделы, преимущества, контакты, футер —
  по смыслу заявки; недостающие детали добей разумными значениями по умолчанию;
- зафиксируй стиль: цветовая палитра, настроение, шрифтовая пара;
- всё содержание пиши на русском языке (если клиент явно не попросил иначе);
- тексты разделов сформулируй конкретно, не оставляй заглушек вида «здесь будет текст»;
- сайт должен быть одностраничным и статичным: один index.html со встроенными CSS/JS;
- в финальном промпте НЕ упоминай, что сайт создаёт ИИ, и не пиши служебных пометок.

Верни СТРОГО один JSON-объект без markdown-обёртки, по схеме:
{
  "ok": true|false,
  "reason": "причина отказа (только если ok=false)",
  "siteTitle": "короткое название сайта (если ok=true)",
  "summary": "1-2 предложения о том, что получится (если ok=true)",
  "finalPrompt": "полный промпт для генератора сайта на русском (если ok=true)"
}

ЗАЯВКА КЛИЕНТА:
<<<
${request}
>>>
`.trim();

/* ---------------------------- выполнение ----------------------------- */
try {
  const result = askDshJson(META_PROMPT, {timeoutMs: 10 * 60_000, model});

  if (result.ok !== true) {
    const out = {ok: false, reason: result.reason || 'Заявка отклонена валидатором.'};
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf8');
    log('Заявка отклонена:', out.reason);
    process.exit(2);
  }

  if (!result.finalPrompt || !result.siteTitle) {
    die('Модель вернула ok=true, но без finalPrompt/siteTitle.');
  }

  const out = {
    ok: true,
    siteTitle: String(result.siteTitle).slice(0, 80),
    summary: String(result.summary || '').slice(0, 300),
    finalPrompt: String(result.finalPrompt),
    model: model || DEFAULT_MODEL,
    rawRequest: request
  };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf8');
  log('Финальный промпт готов:', out.siteTitle);
  console.log(out.summary);
} catch (e) {
  die(e.message);
}
