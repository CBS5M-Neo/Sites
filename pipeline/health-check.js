#!/usr/bin/env node
/**
 * Neo Pipeline · Проверка целостности репозитория.
 * Падает с ошибкой, если sites.json повреждён или у активного сайта нет index.html.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {log, die, readRegistry} = require('./lib/common');

const repo = path.resolve(__dirname, '..');
let failed = false;

try {
  const reg = readRegistry(repo);
  log(`sites.json валиден, сайтов: ${reg.sites.length}`);

  for (const site of reg.sites) {
    const indexFile = path.join(repo, site.slug, 'index.html');
    if (site.status === 'active' && !fs.existsSync(indexFile)) {
      console.error(`✖ ${site.slug}: активен, но index.html отсутствует`);
      failed = true;
    } else if (!fs.existsSync(path.join(repo, site.slug))) {
      console.error(`✖ ${site.slug}: папка сайта отсутствует`);
      failed = true;
    } else {
      log(`✔ ${site.slug}`);
    }

    // у отключённых сайтов должен быть бэкап оригинала
    if (site.status === 'suspended' &&
        !fs.existsSync(path.join(repo, site.slug, 'index.suspended.html'))) {
      console.error(`✖ ${site.slug}: отключён, но нет index.suspended.html`);
      failed = true;
    }
  }

  // у активных сайтов дубликаты slug невозможны по построению — проверим на всякий случай
  const slugs = reg.sites.map(s => s.slug);
  if (new Set(slugs).size !== slugs.length) {
    console.error('✖ найдены дубликаты slug в sites.json');
    failed = true;
  }
} catch (e) {
  die(e.message);
}

process.exit(failed ? 1 : 0);
