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
 * Определяет, как запускать dsh: на Windows глобальный dsh — это .cmd-шим,
 * который spawnSync без shell не находит, поэтому запускаем bin.js через node.
 */
function dshCommand(args) {
  const bin = process.env.DSH_BIN;
  if (bin) {
    if (/\.c?js$/i.test(bin)) return {cmd: process.execPath, args: [bin, ...args]};
    return {cmd: bin, args};
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    ];
    const found = candidates.find(c => fs.existsSync(c));
    if (found) return {cmd: process.execPath, args: [found, ...args]};
  }
  return {cmd: 'dsh', args};
}

/**
 * Модель по умолчанию и список моделей, из которых можно выбирать.
 * Все они доступны у провайдера bai (api.b.ai) — см. dsh-settings.yaml.
 */
const DEFAULT_MODEL = 'glm-5.3-flash';
const AVAILABLE_MODELS = ['glm-5.3-flash', 'hy3', 'qwen3.8-flash', 'mimo-v2.5'];

/** Приводит любое написание (из формы заявки, ENV и т.п.) к id модели или null. */
function normalizeModel(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/\s+/g, '');
  if (/^glm[-.]?5\.3/.test(s)) return 'glm-5.3-flash';
  if (/^hy3/.test(s)) return 'hy3';
  if (/^qwen3\.?8/.test(s)) return 'qwen3.8-flash';
  if (/^mimo[-.]?v2\.?5?/.test(s)) return 'mimo-v2.5';
  if (AVAILABLE_MODELS.includes(s)) return s;
  return null;
}

/** Ищет упоминание модели в произвольном тексте (тело issue, instruction…). */
function parseModelFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const checks = [
    ['glm[-.]?5[.-]?3', 'glm-5.3-flash'],
    ['\\bhy3\\b', 'hy3'],
    ['qwen3[.-]?8', 'qwen3.8-flash'],
    ['mimo[-.]?v2', 'mimo-v2.5']
  ];
  for (const [re, model] of checks) {
    if (new RegExp(re).test(t)) return model;
  }
  return null;
}

/**
 * Патч с настройками выбранной модели. Формат — как у рабочего патча лаунчера:
 * запись id: settings с config.path на полноценный YAML (agent-default-model
 * + определение провайдера bai). Передаётся ПОСЛЕ основного DSH_PATCH, поэтому
 * выбранная Neo модель всегда побеждает базовые настройки.
 */
function modelPatchPath(model) {
  const os = require('os');
  const dir = path.join(os.tmpdir(), 'neo-dsh');
  fs.mkdirSync(dir, {recursive: true});
  const stamp = `${process.pid}-${Date.now()}`;
  const settingsFile = path.join(dir, `settings-${stamp}.yaml`);
  fs.writeFileSync(settingsFile, [
    `agent-default-model:`,
    `  provider: bai`,
    `  model: ${model || DEFAULT_MODEL}`,
    ``,
    `llm-pi-ai:`,
    `  providers:`,
    `    bai:`,
    `      displayName: B.AI`,
    `      apiKeyEnv: BAI_API_KEY`,
    `      api: openai-completions`,
    `      baseURL: https://api.b.ai/v1`,
    `      models:`,
    `        - id: ${model || DEFAULT_MODEL}`
  ].join('\n'), 'utf8');

  const patchFile = path.join(dir, `patch-${stamp}.yaml`);
  fs.writeFileSync(patchFile,
    `- config:\n    path: ${settingsFile.replace(/\\/g, '/')}\n  id: settings\n`, 'utf8');
  return patchFile;
}

/**
 * Один запрос к модели через DeepSeek Harness (headless-профиль).
 * model — одна из AVAILABLE_MODELS; по умолчанию glm-5.3-flash.
 */
function askDsh(prompt, {timeoutMs = 15 * 60_000, workdir, model} = {}) {
  const args = ['--profile', 'headless'];
  const patch = process.env.DSH_PATCH;
  if (patch) args.push('--patch', patch);
  args.push('--patch', modelPatchPath(model || DEFAULT_MODEL));
  args.push(prompt);

  log(`dsh headless → ${model || DEFAULT_MODEL} …`);
  const {cmd, args: finalArgs} = dshCommand(args);
  const r = sh(cmd, finalArgs, {timeout: timeoutMs, cwd: workdir || process.cwd()});
  if (r.code !== 0) {
    throw new Error(`dsh exited with code ${r.code}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`);
  }
  return r.stdout;
}

/** Быстрая проверка: отвечает ли модель (лимиты API у некоторых заканчиваются). */
function probeModel(model, timeoutMs = 90_000) {
  try {
    const out = askDsh('Ответь ровно одним словом: OK', {timeoutMs, model});
    return /\bOK\b/i.test(out);
  } catch (e) {
    log(`модель ${model} недоступна: ${String(e.message).split('\n')[0]}`);
    return false;
  }
}

/**
 * Возвращает первую работающую модель: сначала предпочтительную
 * (из заявки/env), затем остальные из списка. Бросает, если не ответила ни одна.
 */
function pickWorkingModel(preferred) {
  const norm = normalizeModel(preferred || process.env.NEO_MODEL) || DEFAULT_MODEL;
  const order = [norm, ...AVAILABLE_MODELS.filter(m => m !== norm)];
  for (const m of order) {
    if (probeModel(m)) {
      if (m !== norm) log(`⚠ предпочтительная модель «${norm}» недоступна — переключаюсь на «${m}»`);
      return m;
    }
  }
  throw new Error(`Ни одна ИИ-модель не отвечает: ${order.join(', ')} — лимиты исчерпаны или нет сети. Попробуйте позже.`);
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
  DEFAULT_MODEL, AVAILABLE_MODELS,
  log, die, sh, git,
  askDsh, askDshJson,
  normalizeModel, parseModelFromText, probeModel, pickWorkingModel,
  slugify, uniqueSlug,
  readRegistry, saveRegistry, findSite,
  isoDay, gh
};
