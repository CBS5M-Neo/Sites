# Система Neo — подробное описание

Автоматическая генерация статичных сайтов силами ИИ: **заявка → проверка и улучшение
промпта → генерация → публикация → сопровождение**. Всё без серверов: GitHub Issues
+ GitHub Actions + DeepSeek Harness (модель GLM-5.3-flash).

---

## 1. Поток заявки

```
Клиент                            GitHub                         ИИ
  │  issue по шаблону «Заказ сайта»  │                             │
  ├─────────────────────────────────►│  ярлык «новый-сайт»         │
  │                                  ├──► workflow new-site.yml    │
  │                                  │    ┌────────────────────────▼──────────────────┐
  │                                  │    │ Этап 1. enhance-prompt.js                 │
  │                                  │    │  • проверка: про сайт ли это, законно ли, │
  │                                  │    │    статичен ли (JSON ok=false → отказ)    │
  │                                  │    │  • улучшение: структура, стиль, тексты,   │
  │                                  │    │    добор недостающих деталей по умолчанию │
  │                                  │    ├───────────────────────────────────────────┤
  │                                  │    │ Этап 2. generate-site.js                  │
  │                                  │    │  headless-агент DSH создаёт <slug>/       │
  │                                  │    │  с index.html (все стили/JS инлайн)       │
  │                                  │    ├───────────────────────────────────────────┤
  │                                  │    │ Этап 3. new-site.js                       │
  │                                  │    │  • уникальный slug (транслитерация)       │
  │                                  │    │  • запись в sites.json                    │
  │                                  │    │  • коммит + push + комментарий в issue    │
  │  ◄── ссылка на готовый сайт ─────┤    └───────────────────────────────────────────┘
```

**Отказ валидатора** (ok=false) закрывает issue с вежливым объяснением — деньги
в этом случае не берутся.

## 2. Финальный промпт

Промпт-инженер (этап 1) обязан вернуть строгий JSON:

```json
{
  "ok": true,
  "siteTitle": "Портфолио фотографа Анны",
  "summary": "Одностраничное портфолио с галереей и формой связи",
  "finalPrompt": "Полное ТЗ для генератора: структура, разделы, палитра, шрифты, тексты…"
}
```

Генератор (этап 2) работает как агент DeepSeek Harness headless с доступом к файлам:
он **сам создаёт папку**, названную транслитерацией имени сайта, и кладёт туда сайт.
Скрипт после этого проверяет, что `index.html` существует и не пуст.

Slug строится из названия сайта: `Мой сайт` → `moy-sayt`; конфликты получают
суффикс `-2`, `-3`, …; служебные имена (`pipeline`, `docs`, …) занять нельзя.

## 3. Учёт денег (`sites.json`)

| Поле | Смысл |
|---|---|
| `weeklyCharge` | подключена ли опция «20 ₽ за неделю без посетителей» |
| `visits` | визиты с прошлой недельной проверки |
| `balance` | доплаты: правки сверх 8 и простои (минус = долг оператору) |
| `edits[]` | журнал правок: дата + инструкция |
| `status` | `active` / `suspended` |

Правило правок: первые **8** — включены в цену сайта (100 ₽), далее **−10 ₽**
за каждую. Правило простоя: см. ниже.

## 4. Еженедельная проверка (`weekly-check.js`, cron: понедельник 06:00 UTC)

Для каждого активного сайта:

```
были посетители за неделю?
├─ да  → ничего не делаем
└─ нет
   ├─ weeklyCharge = true  → balance −= 20 ₽
   │    └─ balance < −20 ₽ → сайт отключается за неуплату
   └─ weeklyCharge = false → сайт сразу отключается
```

Отключение: `index.html` сохраняется как `index.suspended.html`, вместо него
публикуется заглушка «Сайт временно отключён». Включение обратно — бесплатное,
через шаблон «Включить сайт» (`reactivate.js`).

## 5. Подсчёт посещений

GitHub Pages не отдаёт статистику по папкам, поэтому счётчик — подключаемый:

**Вариант A (рекомендуется): Google Apps Script + Google Таблицы (бесплатно).**

1. Создайте таблицу с листом `visits`, колонки: `date, site, ua`.
2. Extensions → Apps Script, вставьте:

```javascript
function doGet(e) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('visits');
  sh.appendRow([new Date(), e.parameter.site || '?', e.parameter.ref || '']);
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}
```

3. Deploy → New deployment → Web app → Execute as: **Me**, Access: **Anyone**.
   Скопируйте URL деплоя.
4. Секрет репозитория `NEO_ANALYTICS_SNIPPET` (Settings → Secrets and variables → Actions):

```html
<script>fetch('https://script.google.com/macros/s/XXXX/exec?site='+location.pathname.split('/')[2]+'&ref='+encodeURIComponent(document.referrer),{mode:'no-cors'})</script>
```

Конвейер (`new-site.js`) сам вставит сниппет в каждый новый сайт.

5. Секрет `VISITS_CSV_URL` — ссылка «Publish to web → CSV» сводного листа вида
   `slug,visits` (например, формулой `=QUERY(A:B,"select B, count(B) group by B")`).
   Его читает `weekly-check.yml`.

**Вариант B:** без счётчика поле `visits` правится вручную раз в неделю —
weekly-check использует его как есть.

## 6. Безопасность

- Ключ модели живёт только в секретах (`BAI_API_KEY`); в логи не попадает.
- Генерация запускается **только по ярлыкам** (`новый-сайт`, `правка`, `включить-сайт`)
  — случайные issues расход не инициируют.
- `concurrency: neo-sites` — заказы обрабатываются строго по одному.
- Агент генератора ограничен инструкцией «работать только в своей папке»;
  валидатор (`health-check.js`) на каждом пуше проверяет целостность реестра.

## 7. Локальный запуск (без CI)

```bash
# нужен установленный dsh и ключ провайдера (см. dsh-settings.yaml)
export DSH_PATCH="$PWD/pipeline/dsh-patch-local.yaml"   # см. ниже
export BAI_API_KEY="sk-…"
git clone https://github.com/CBS5M-Neo/Sites && cd Sites

node pipeline/new-site.js --request-file request.txt --workdir .
node pipeline/apply-edit.js --slug my-site --instruction "тёмная тема" --workdir .
node pipeline/weekly-check.js --workdir .
```

`dsh-patch-local.yaml` — однострочный патч (аналог `setup-dsh.sh`):

```yaml
- config:
    path: /абсолютный/путь/до/pipeline/dsh-settings.yaml
  id: settings
```

## 8. Дорожная карта

- [ ] интеграция GoatCounter/Plausible как готовый провайдер статистики
- [ ] приём оплаты (ЮKassa) с автопополнением баланса
- [ ] многостраничные сайты (тариф «Продвинутый»)
- [ ] восстановление сайта из `index.suspended.html` вручную оператором при споре
