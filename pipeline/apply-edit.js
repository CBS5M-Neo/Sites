#!/usr/bin/env node
/**
 * Neo Pipeline · Этап 3 — правка существующего сайта.
 *
 * Вход:  --slug имя-сайта  --instruction "что изменить"  --workdir <клон репозитория Sites>
 *
 * Логика учёта:
 *   первые 8 правок бесплатны (входят в стоимость сайта),
 *   каждая следующая списывает 10 ₽ с баланса (sites.json).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {PRICING, log, die, askDsh, readRegistry, saveRegistry, findSite, isoDay, git} = require('./lib/common');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--instruction') args.instruction = argv[++i];
    else if (argv[i] === '--instruction-file') args.instructionFile = argv[++i];
    else if (argv[i] === '--workdir') args.workdir = argv[++i];
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

try {
  const answer = askDsh(EDIT_PROMPT, {timeoutMs: 20 * 60_000, workdir: repo});

  if (!fs.existsSync(indexFile)) {
    console.error('--- ответ модели ---\n' + answer.slice(-3000));
    die('Модель удалила index.html — правка отменена (откатите изменения в git).');
  }

  // фиксируем правку
  site.edits = site.edits || [];
  site.edits.push({date: isoDay(), instruction: String(args.instruction).slice(0, 500)});
  site.balance = (site.balance || 0) - cost;

  saveRegistry(repo, reg);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m',
    `Neo: правка сайта ${args.slug}${cost ? ` (−${cost} ₽)` : ' (бесплатно)'} [skip ci]`]);

  log(`Правка применена. Использовано правок: ${site.edits.length}` +
      (cost ? `, списано ${cost} ₽` : ' (в пределах включённых)'));
} catch (e) {
  die(e.message);
}
