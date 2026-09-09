#!/usr/bin/env node
/**
 * Neo Pipeline · Этап 2 — генерация сайта моделью через DeepSeek Harness.
 *
 * Вход:  --prompt-file final-prompt.json (результат этапа 1)
 *        --slug имя-сайта (имя папки)
 *        --workdir рабочая папка, в которой модель создаёт <slug>/index.html
 * Выход: код 0 и папка <workdir>/<slug>/index.html
 *
 * Модель (GLM-5.3-flash) работает как агент с доступом к файловой системе:
 * она сама создаёт папку сайта и складывает туда готовые файлы.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {log, die, askDsh} = require('./lib/common');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt-file') args.promptFile = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--workdir') args.workdir = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.promptFile || !args.slug || !args.workdir) {
  die('Использование: node generate-site.js --prompt-file final.json --slug name --workdir dir');
}

const promptData = JSON.parse(fs.readFileSync(args.promptFile, 'utf8'));
if (!promptData.ok || !promptData.finalPrompt) {
  die('В prompt-file нет ok=true/finalPrompt — сначала выполните enhance-prompt.js');
}

const slug = args.slug;
const workdir = path.resolve(args.workdir);
fs.mkdirSync(workdir, {recursive: true});

const GEN_PROMPT = `
Ты — генератор сайтов сервиса Neo (подкомпания CBS5M). Ты работаешь как агент
с доступом к файловой системе.

Рабочая папка: ${workdir}

Создай в ней папку "${slug}", а внутри неё — законченный одностраничный статичный сайт:
- index.html — единственный обязательный файл; все стили и скрипты встроены в него;
- язык страницы — русский;
- адаптивная вёрстка (телефон/десктоп), семантическая разметка, заполненные meta-теги;
- современный аккуратный дизайн строго в стиле, указанном в промпте ниже;
- вместо фотографий используй бесплатные картинки https://picsum.photos или
  CSS-градиенты и SVG; НЕ создавай бинарных файлов;
- не используй сборщики, npm, серверный код — только чистые HTML/CSS/JS;
- в папке "${slug}" не должно быть ничего, кроме файлов сайта;
- ничего вне рабочей папки не меняй.

ПРОМПТ САЙТА:
<<<
${promptData.finalPrompt}
>>>

Когда сайт готов, проверь index.html на целостность (все теги закрыты, нет заглушек)
и ответь последней строкой ровно: DONE ${slug}
`.trim();

try {
  const answer = askDsh(GEN_PROMPT, {timeoutMs: 25 * 60_000, workdir});

  const siteDir = path.join(workdir, slug);
  const indexFile = path.join(siteDir, 'index.html');

  if (!fs.existsSync(indexFile)) {
    console.error('--- ответ модели ---\n' + answer.slice(-3000));
    die(`Модель не создала ${slug}/index.html`);
  }

  const html = fs.readFileSync(indexFile, 'utf8');
  if (html.length < 500) {
    die(`index.html подозрительно мал (${html.length} байт) — считаем генерацию неудачной`);
  }

  const files = fs.readdirSync(siteDir);
  log(`Сайт сгенерирован: ${slug}/ (${files.length} файл(ов), index.html ${(html.length / 1024).toFixed(1)} КБ)`);
  console.log(files.join('\n'));
} catch (e) {
  die(e.message);
}
