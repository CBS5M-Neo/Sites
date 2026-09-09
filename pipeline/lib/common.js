#!/usr/bin/env node
/**
 * Neo Pipeline · общие утилиты
 * Подкомпания CBS5M — автоматическая генерация статичных сайтов с помощью ИИ.
 *
 * Все дочерние процессы запускаются синхронно, чтобы сценарии GitHub Actions
 * были простыми и предсказуемыми.
 */
'use strict';

const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

/* ------------------------------- цены ------------------------------- */
const PRICING = {
  currency: 'RUB',
  sitePrice: 100,        // сайт под ключ (8 правок включено)
  includedEdits: 8,      // бесплатные правки
  editPrice: 10,         // каждая правка сверх включённых
  idleWeekPrice: 20,     // списание за неделю без посетителей (если опция включена)
  idleWeekDays: 7        // период проверки посещаемости
};

/* ------------------------------ логи -------------------------------- */
function log(...args) {
  console.log('\x1b[35m[neo]\x1b[0m', ...args);
}

function die(msg, code = 1) {
  console.error('\x1b[31m[neo:error]\x1b[0m', msg);
  process.exit(code);
}

/* --------------------------- shell / git ----------------------------- */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  });
  if (r.error) throw r.error;
  return {
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim()
  };
}

function git(repoDir, args) {
  const r = sh('git', ['-C', repoDir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

/* ------------------------- DeepSeek Harness -------------------------- */
/**
 * Один запрос к модели через DeepSeek Harness (headless-профиль).
 * Модель по умолчанию — GLM-5.3-flash (провайдер bai, задаётся патчем/ENV).
 */
function askDsh(prompt, {timeoutMs = 15 * 60_000, workdir} = {}) {
  const args = ['--profile', 'headless'];
  const patch = process.env.DSH_PATCH;
  if (patch) args.push('--patch', patch);
  args.push(prompt);

  log(`dsh headless → ${process.env.DSH_MODEL || 'glm-5.3-flash'} …`);
  const r = sh('dsh', args, {timeout: timeoutMs, cwd: workdir || process.cwd()});
  if (r.code !== 0) {
    throw new Error(`dsh exited with code ${r.code}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`);
  }
  return r.stdout;
}

/**
 * Просит модель вернуть строго JSON и достаёт его из ответа.
 * Модель может обернуть JSON в ```json-блок или текст — вырезаем аккуратно.
 */
function askDshJson(prompt, opts) {
  const raw = askDsh(prompt, opts);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Модель не вернула JSON. Ответ:\n' + raw.slice(0, 1500));
  }
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    throw new Error('Не удалось разобрать JSON от модели: ' + e.message + '\n' + match[0].slice(0, 1500));
  }
}

/* ----------------------------- slug ---------------------------------- */
const TRANSLIT = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',
  ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  ' ':'-', '_':'-'
};

function slugify(name) {
  const s = String(name).toLowerCase().trim()
    .split('').map(ch => (ch in TRANSLIT) ? TRANSLIT[ch] : ch).join('')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || 'site';
}

/**
 * Уникальный slug: если базовый занят — добавляем -2, -3, …
 * reserved — имена, запрещённые в корне репозитория.
 */
function uniqueSlug(base, taken, reserved = RESERVED_DIRS) {
  let slug = base, n = 2;
  while (taken.has(slug) || reserved.includes(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

/** Папки, которые нельзя занимать сайтом (служебные). */
const RESERVED_DIRS = ['sites', 'pipeline', 'docs', 'assets', 'tools', 'scripts'];

/* --------------------------- registry -------------------------------- */
function readRegistry(repoDir) {
  const p = path.join(repoDir, 'sites.json');
  if (!fs.existsSync(p)) return {version: 1, sites: []};
  try {
    const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(reg.sites)) throw new Error('sites.json: sites не массив');
    return reg;
  } catch (e) {
    throw new Error(`sites.json повреждён: ${e.message}`);
  }
}

function saveRegistry(repoDir, reg) {
  fs.writeFileSync(
    path.join(repoDir, 'sites.json'),
    JSON.stringify(reg, null, 2) + '\n',
    'utf8'
  );
}

function findSite(reg, slug) {
  return reg.sites.find(s => s.slug === slug);
}

/* ------------------------------ dates -------------------------------- */
function isoDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/* ------------------------------ gh CLI ------------------------------- */
function gh(args, opts = {}) {
  const env = {...process.env};
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;
  const r = sh('gh', args, {...opts, env});
  if (r.code !== 0) throw new Error(`gh ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

module.exports = {
  PRICING, RESERVED_DIRS,
  log, die, sh, git,
  askDsh, askDshJson,
  slugify, uniqueSlug,
  readRegistry, saveRegistry, findSite,
  isoDay, gh
};
