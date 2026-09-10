#!/usr/bin/env node
/**
 * Neo Pipeline · Этап 3 — правка существующего сайта.
 *
 * Вход:  --slug имя-сайта  --instruction "что изменить" (или --instruction-file)
 *        --workdir <клон репозитория Sites>  --model имя-модели (опционально)
 *
 * Логика учёта:
 *   первые 8 правок бесплатны (входят в стоимость сайта),
 *   каждая следующая списывает 10 ₽ с баланса (sites.json).
 *
 * Модель правки: явная --model, упоминание в тексте инструкции, env NEO_MODEL,
 * модель исходного сайта — и проверка жива ли она; при исчерпанном лимите
 * Neo автоматически переключается на любую отвечающую модель из списка.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  PRICING, log, die, askDsh, readRegistry, saveRegistry, findSite, isoDay, git,
  normalizeModel, parseModelFromText, pickWorkingModel, probeModel, AVAILABLE_MODELS
} = require('./lib/common');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--instruction') args.instruction = argv[++i];
    else if (argv[i] === '--instruction-file') args.instructionFile = argv[++i];
    else if (argv[i] === '--workdir') args.workdir = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.instructionFile && !args.instruction) {
  args.instruction = fs.readFileSync(args.instructionFile, 'utf8');
}
if (!args.slug || !args.instruction || !args.workdir) {
  die('Использование: node apply-edit.js --slug name --instruction "…"|--instruction-file f --workdir <dir>');
}

const repo = path.resolve(args.workdir);
const siteDir = path.join(repo, args.slug);
const indexFile = path.join(siteDir, 'index.html');

if (!fs.existsSync(indexFile)) {
  die(`Сайт "${args.slug}" не найден (${indexFile}).`);
}

const reg = readRegistry(repo);
const site = findSite(reg, args.slug) ||
  {slug: args.slug, edits: [], balance: 0, status: 'active'}; // сайт из легаси без записи

const usedEdits = (site.edits || []).length;
const isPaid = usedEdits >= PRICING.includedEdits;
const cost = isPaid ? PRICING.editPrice : 0;

const EDIT_PROMPT = `
Ты — редактор сайтов сервиса Neo. Внеси правку в существующий статичный сайт.

Папка сайта: ${siteDir}
Запрос клиента на правку:
<<<
${args.instruction}
>>>

Правила:
- вноси минимальные, точные изменения; не переписывай сайт с нуля без необходимости;
- сохраняй текущий стиль и структуру, если клиент не просит обратного;
- весь контент — на русском языке;
- файлы сайта не создавай вне ${siteDir};
- если запрос противоречит возможностям статичного сайта — сделай максимально близкую
  статичную реализацию.

Когда правка внесена и файлы сохранены, ответь последней строкой ровно: EDITED ${args.slug}
`.trim();

/* -------------------------- выбор модели ------------------------------- */
let model = pickWorkingModel(
  normalizeModel(args.model) || parseModelFromText(args.instruction) ||
  process.env.NEO_MODEL || normalizeModel(site.model));
log(`Правка моделью: ${model}`);

const tried = new Set();
let lastErr = null;
for (;;) {
  if (!model || tried.has(model)) break;
  tried.add(model);
  try {
    const answer = askDsh(EDIT_PROMPT, {timeoutMs: 20 * 60_000, workdir: repo, model});

    if (!fs.existsSync(indexFile)) {
      console.error('--- ответ модели ---\n' + answer.slice(-3000));
      throw new Error('Модель удалила index.html — повторяем на другой модели');
    }

    // фиксируем правку
    site.edits = site.edits || [];
    site.edits.push({date: isoDay(), instruction: String(args.instruction).slice(0, 500), model});
    site.balance = (site.balance || 0) - cost;

    saveRegistry(repo, reg);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m',
      `Neo: правка сайта ${args.slug}${cost ? ` (−${cost} ₽)` : ' (бесплатно)'} [skip ci]`]);

    log(`Правка применена моделью ${model}. Использовано правок: ${site.edits.length}` +
        (cost ? `, списано ${cost} ₽` : ' (в пределах включённых)'));
    process.exit(0);
  } catch (e) {
    lastErr = e;
    log(`Сбой на модели ${model}: ${String(e.message).split('\n')[0]}`);
    if (e.message.includes('git')) break; // git-проблемы повтором на другой модели не решить
    model = null;
    for (const m of AVAILABLE_MODELS.filter(x => !tried.has(x))) {
      if (probeModel(m)) { model = m; log(`Повторяю правку на модели ${m}`); break; }
    }
  }
}
die(lastErr ? lastErr.message : 'Правка не удалась');
