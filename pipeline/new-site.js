#!/usr/bin/env node
/**
 * Neo Pipeline · Оркестратор нового сайта (этапы 1→2→публикация).
 *
 * Используется GitHub Actions (issue-заявка или ручной запуск).
 *
 * Вход:
 *   --request-file файл с текстом заявки
 *   --issue номер issue (для комментария о результате, опционально)
 *   --repo owner/repo (для gh-комментариев, опционально)
 *   --workdir клон репозитория Sites
 *   --weekly-charge true|false  (настройка списания 20 ₽ за простой)
 *
 * Что делает:
 *   1. Проверяет и улучшает промпт (enhance-prompt.js)
 *   2. Генерирует сайт в отдельной временной папке (generate-site.js)
 *   3. Переносит папку <slug>/ в корень репозитория, обновляет sites.json
 *   4. Коммитит и пушит; при успехе комментирует issue ссылкой на сайт
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  log, die, sh, git, gh,
  slugify, uniqueSlug, RESERVED_DIRS,
  readRegistry, saveRegistry, isoDay
} = require('./lib/common');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--request-file') a.requestFile = argv[++i];
    else if (argv[i] === '--issue') a.issue = argv[++i];
    else if (argv[i] === '--repo') a.repo = argv[++i];
    else if (argv[i] === '--workdir') a.workdir = argv[++i];
    else if (argv[i] === '--weekly-charge') a.weeklyCharge = argv[++i] !== 'false';
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.requestFile || !args.workdir) {
  die('Использование: node new-site.js --request-file f.txt --workdir <dir> [--issue N --repo owner/repo] [--weekly-charge true]');
}

const repo = path.resolve(args.workdir);
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neo-gen-'));
const promptFile = path.join(tmp, 'final-prompt.json');

function comment(issue, body) {
  if (!issue || !args.repo) return;
  try {
    gh(['issue', 'comment', String(issue), '--repo', args.repo, '--body', body]);
  } catch (e) { log('Не удалось прокомментировать issue:', e.message); }
}

function closeIssue(issue, body) {
  if (!issue || !args.repo) return;
  comment(issue, body);
  try { gh(['issue', 'close', String(issue), '--repo', args.repo]); }
  catch (e) { log('Не удалось закрыть issue:', e.message); }
}

try {
  const rawRequest = fs.readFileSync(args.requestFile, 'utf8').trim();

  /* ---- 0. антиспам: заявка не должна быть тривиально короткой ---- */
  if (rawRequest.length < 20) {
    closeIssue(args.issue, `🤖 **Neo:** заявка слишком короткая — опишите сайт подробнее (хотя бы пару предложений), и я всё сделаю.`);
    log('Заявка отклонена: слишком короткая');
    process.exit(0);
  }

  /* ---- 1. проверка и улучшение промпта ---- */
  log('Этап 1: проверка и улучшение промпта…');
  const r1 = sh('node', [path.join(__dirname, 'enhance-prompt.js'),
    '--request-file', args.requestFile, '--out', promptFile]);

  if (r1.code !== 0 || !fs.existsSync(promptFile)) {
    const rejected = r1.code === 2; // валидатор отклонил заявку
    if (rejected) {
      const why = JSON.parse(fs.readFileSync(promptFile, 'utf8')).reason;
      closeIssue(args.issue,
        `🤖 **Neo:** к сожалению, заявку не получилось принять.\n\n> ${why}\n\n` +
        `Neo создаёт только статичные сайты (визитки, портфолио, лендинги). ` +
        `Отредактируйте заявку и попробуйте снова.`);
      log('Заявка отклонена валидатором');
      process.exit(0);
    }
    throw new Error('Этап улучшения промпта упал:\n' + r1.stderr);
  }

  const final = JSON.parse(fs.readFileSync(promptFile, 'utf8'));

  /* ---- 2. slug ---- */
  const reg = readRegistry(repo);
  const taken = new Set([
    ...reg.sites.map(s => s.slug),
    ...RESERVED_DIRS,
    ...fs.readdirSync(repo).filter(f => fs.statSync(path.join(repo, f)).isDirectory())
  ]);
  const slug = uniqueSlug(slugify(final.siteTitle), taken);

  /* ---- 3. генерация сайта во временной папке ---- */
  log(`Этап 2: генерация сайта (папка "${slug}")…`);
  const r2 = sh('node', [path.join(__dirname, 'generate-site.js'),
    '--prompt-file', promptFile, '--slug', slug, '--workdir', tmp]);

  if (r2.code !== 0) throw new Error('Генерация сайта не удалась:\n' + r2.stderr);

  /* ---- 4. перенос в репозиторий ---- */
  const src = path.join(tmp, slug);
  const dst = path.join(repo, slug);
  fs.cpSync(src, dst, {recursive: true});
  if (!fs.existsSync(path.join(dst, 'index.html'))) {
    throw new Error('После переноса не найден index.html');
  }
  fs.rmSync(tmp, {recursive: true, force: true});

  /* ---- 4b. счётчик посещений (если настроен) ---- */
  const snippet = process.env.NEO_ANALYTICS_SNIPPET;
  if (snippet) {
    const indexFile = path.join(dst, 'index.html');
    let html = fs.readFileSync(indexFile, 'utf8');
    if (html.includes('</body>')) {
      html = html.replace('</body>', snippet + '\n</body>');
      fs.writeFileSync(indexFile, html, 'utf8');
      log('Счётчик посещений подключён');
    }
  }

  /* ---- 5. запись в реестр ---- */
  reg.sites.push({
    slug,
    name: final.siteTitle,
    description: final.summary,
    url: `https://cbs5m-neo.github.io/Sites/${slug}/`,
    createdAt: isoDay(),
    status: 'active',
    weeklyCharge: args.weeklyCharge !== false,
    visits: 0,
    lastWeeklyCheck: null,
    balance: 0,
    edits: [],
    issue: args.issue ? Number(args.issue) : null
  });
  saveRegistry(repo, reg);

  /* ---- 6. коммит и пуш ---- */
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', `Neo: новый сайт "${final.siteTitle}" (${slug})`]);
  try {
    git(repo, ['push', 'origin', 'HEAD']);
  } catch (e) {
    log('push не прошёл, пробую pull --rebase и повтор…');
    git(repo, ['pull', '--rebase', 'origin']);
    git(repo, ['push', 'origin', 'HEAD']);
  }

  const url = `https://cbs5m-neo.github.io/Sites/${slug}/`;
  log('Сайт опубликован:', url);
  console.log('URL=' + url);

  if (args.issue) {
    comment(args.issue,
      `🤖 **Neo:** сайт готов! 🎉\n\n` +
      `**Название:** ${final.siteTitle}\n` +
      `**Ссылка:** ${url}\n\n` +
      `В стоимость входят 8 бесплатных правок — откройте issue с шаблоном «Правка сайта», ` +
      `когда захотите что-то изменить. Спасибо, что выбрали Neo!`);
  }
} catch (e) {
  if (args.issue) {
    comment(args.issue,
      `🤖 **Neo:** при обработке заявки произошла ошибка, оператор уже видит её в журнале ` +
      `и свяжется с вами. Попробуйте повторить позже.`);
  }
  die(e.message);
}
