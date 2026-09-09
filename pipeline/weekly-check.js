#!/usr/bin/env node
/**
 * Neo Pipeline · Этап 4 — еженедельная проверка посещаемости.
 *
 * Правило Neo:
 *   • на сайт не пришёл НИ ОДНОГО посетителя за неделю:
 *       - если у сайта включена опция списания → −20 ₽ на балансе;
 *         при балансе ниже −20 ₽ сайт отключается за неуплату;
 *       - если опция отключена → сайт сразу выключается.
 *   • были посетители → ничего не происходит.
 *
 * Источник посещений: CSV Google Apps Script (см. docs/SYSTEM.md) либо
 * ручная правка поля visits в sites.json. Сайты с visits=null пропускаются.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {PRICING, log, die, readRegistry, saveRegistry, isoDay, git} = require('./lib/common');

const STUB_TITLE = 'Сайт временно отключён';

function makeStub(name) {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${STUB_TITLE} — Neo</title>
<style>
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#08080d;color:#f2f2f8;font-family:system-ui,sans-serif;text-align:center;padding:24px}
  .card{max-width:480px;background:#12121d;border:1px solid rgba(255,255,255,.1);
    border-radius:20px;padding:48px 36px}
  h1{font-size:22px;margin:18px 0 10px}
  p{color:#9b9bb0;font-size:15px;line-height:1.6}
  a{color:#8f7bff;text-decoration:none;font-weight:700}
  .logo{width:56px;height:56px;border-radius:14px;object-fit:contain}
</style></head>
<body><div class="card">
  <img class="logo" src="https://cbs5m-neo.github.io/logo.png" alt="Neo">
  <h1>${STUB_TITLE}</h1>
  <p>Сайт «${name}» приостановлен сервисом Neo, так как в течение недели
  на него не заходили посетители и опция продления не активна.</p>
  <p>Владелец сайта может включить его обратно —
  <a href="https://github.com/CBS5M-Neo/Sites/issues/new?template=reactivate-site.yml">создав заявку на включение</a>.</p>
  <p style="margin-top:22px"><a href="https://cbs5m-neo.github.io/">← На главную Neo</a></p>
</div></body></html>`;
}

/** Заменяет index.html заглушкой, сохраняя оригинал в index.suspended.html. */
function suspendSite(siteDir, name) {
  const indexFile = path.join(siteDir, 'index.html');
  const backupFile = path.join(siteDir, 'index.suspended.html');
  if (fs.existsSync(indexFile) && !fs.existsSync(backupFile)) {
    fs.copyFileSync(indexFile, backupFile);
  }
  fs.writeFileSync(indexFile, makeStub(name || ''), 'utf8');
}

/** Возвращает сайт в строй после оплаты/продления. */
function unsuspendSite(siteDir) {
  const indexFile = path.join(siteDir, 'index.html');
  const backupFile = path.join(siteDir, 'index.suspended.html');
  if (fs.existsSync(backupFile)) {
    fs.copyFileSync(backupFile, indexFile);
    fs.rmSync(backupFile);
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workdir') a.workdir = argv[++i];
    else if (argv[i] === '--visits-csv') a.visitsCsv = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.workdir) die('Использование: node weekly-check.js --workdir <dir> [--visits-csv url|файл]');

const repo = path.resolve(args.workdir);

try {
  /* ---- 0. необязательный внешний источник посещений ---- */
  const visits = {};
  if (args.visitsCsv) {
    let csv;
    if (/^https?:\/\//.test(args.visitsCsv)) {
      const r = await fetch(args.visitsCsv);
      if (!r.ok) throw new Error(`CSV недоступен: HTTP ${r.status}`);
      csv = await r.text();
    } else {
      csv = fs.readFileSync(args.visitsCsv, 'utf8');
    }
    // формат: slug,visits  (одна строка — один сайт)
    for (const line of csv.split(/\r?\n/).slice(1)) {
      const [slug, count] = line.split(',').map(s => s && s.trim());
      if (slug && count !== undefined && !isNaN(+count)) visits[slug] = +count;
    }
  }

  /* ---- 1. обход сайтов ---- */
  const reg = readRegistry(repo);
  const today = isoDay();
  const report = [];

  for (const site of reg.sites) {
    if (site.status === 'suspended') {
      report.push(`⏸ ${site.slug}: уже отключён, пропущен`);
      continue;
    }
    const hadVisits = visits[site.slug] !== undefined
      ? visits[site.slug] > 0
      : (site.visits || 0) > 0;

    if (site.visits === null && visits[site.slug] === undefined) {
      report.push(`❔ ${site.slug}: нет данных о посещениях — пропуск`);
      continue;
    }

    if (hadVisits) {
      report.push(`✅ ${site.slug}: ${visits[site.slug] ?? site.visits} визит(ов) — всё хорошо`);
    } else if (site.weeklyCharge) {
      site.balance = (site.balance || 0) - PRICING.idleWeekPrice;
      if (site.balance < -PRICING.idleWeekPrice) {
        site.status = 'suspended';
        site.suspendedAt = today;
        suspendSite(path.join(repo, site.slug), site.name);
        report.push(`🚫 ${site.slug}: долг ${(site.balance).toFixed(0)} ₽ — сайт отключён за неуплату`);
      } else {
        report.push(`💳 ${site.slug}: посетителей не было — списано ${PRICING.idleWeekPrice} ₽ (баланс ${site.balance} ₽)`);
      }
    } else {
      site.status = 'suspended';
      site.suspendedAt = today;
      suspendSite(path.join(repo, site.slug), site.name);
      report.push(`🚫 ${site.slug}: посетителей не было, опция продления отключена — сайт выключен`);
    }

    site.visits = 0;              // сброс счётчика до следующей недели
    site.lastWeeklyCheck = today;
  }

  saveRegistry(repo, reg);

  /* ---- 2. отчёт и коммит ---- */
  const reportText = report.join('\n') || 'Сайтов нет — проверять нечего.';
  fs.mkdirSync(path.join(repo, 'docs'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'docs', 'weekly-report.md'),
    `# Еженедельный отчёт Neo — ${today}\n\n${reportText}\n`, 'utf8');
  log(reportText);

  git(repo, ['add', '-A']);
  const changed = git(repo, ['status', '--porcelain']);
  if (changed) {
    git(repo, ['commit', '-m', `Neo: еженедельная проверка посещаемости (${today}) [skip ci]`]);
    try { git(repo, ['push', 'origin', 'HEAD']); }
    catch { git(repo, ['pull', '--rebase', 'origin']); git(repo, ['push', 'origin', 'HEAD']); }
    log('Изменения отправлены в репозиторий');
  } else {
    log('Изменений нет');
  }
} catch (e) {
  die(e.message);
}
