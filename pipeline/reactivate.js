#!/usr/bin/env node
/**
 * Neo Pipeline · Повторное включение отключённого сайта.
 * Вызывается Actions по issue-шаблону «Включить сайт».
 * Сайт возвращается в строй; при долге баланс обнуляется оператором вручную.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {log, die, readRegistry, saveRegistry, isoDay, git, gh} = require('./lib/common');

const [,, slugArg, workdirArg, repoArg, issueArg] = process.argv.slice(2);
if (!slugArg || !workdirArg) die('Использование: node reactivate.js <slug> <workdir> [owner/repo] [issue]');

const repo = path.resolve(workdirArg);
const reg = readRegistry(repo);
const site = reg.sites.find(s => s.slug === slugArg);

if (!site) die(`Сайт "${slugArg}" не найден в sites.json`);
if (site.status !== 'suspended') {
  log(`Сайт "${slugArg}" уже активен — действий не требуется`);
  process.exit(0);
}

const backupFile = path.join(repo, slugArg, 'index.suspended.html');
if (fs.existsSync(backupFile)) {
  fs.copyFileSync(backupFile, path.join(repo, slugArg, 'index.html'));
  fs.rmSync(backupFile);
}
site.status = 'active';
site.suspendedAt = null;
site.reactivatedAt = isoDay();
saveRegistry(repo, reg);

git(repo, ['add', '-A']);
git(repo, ['commit', '-m', `Neo: сайт ${slugArg} снова включён`]);
try { git(repo, ['push', 'origin', 'HEAD']); } catch { git(repo, ['pull', '--rebase', 'origin']); git(repo, ['push', 'origin', 'HEAD']); }

const url = `https://cbs5m-neo.github.io/Sites/${slugArg}/`;
log('Сайт включён:', url);

if (repoArg && issueArg) {
  try {
    gh(['issue', 'comment', issueArg, '--repo', repoArg, '--body',
      `🤖 **Neo:** сайт «${site.name || slugArg}» снова включён!\n\nСсылка: ${url}`]);
    gh(['issue', 'close', issueArg, '--repo', repoArg]);
  } catch (e) { log('Не удалось прокомментировать issue:', e.message); }
}
