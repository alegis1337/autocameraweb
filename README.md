# AutoCamera Monitor

Автоматическая проверка камер видеонаблюдения по расписанию с отправкой отчётов
на email и заявок в helpdesk. Запускается на отдельной VM по расписанию Windows
Task Scheduler — человек не нужен.

**Версия 3.5** (этапы 0–2 из 4) · Windows 10/11 · Node.js ≥ 22.5 · ES modules

---

## Что делает

- Проверяет онлайн/офлайн статус всех камер по списку систем из `config/systems.json`
- Контролирует, идёт ли запись на регистраторе
- Проверяет свежесть и качество записей на SMB-шарах
- Снимает кадры с камер и кладёт миниатюры в HTML-отчёт
- Архивирует полноразмерные снимки в Bitrix24 Disk
- Рассылает email-отчёты по группам объектов (группы задаются в `.env`)
- Создаёт заявки в helpdesk **при новой поломке**, без шумных писем о
  восстановлении. О том, что не подняли, напоминает: объект, лежащий целиком, —
  каждое утро, отдельная камера — раз в `HELPDESK_RENOTIFY_DAYS` дней. В письме
  перечислены все актуально сломанные камеры группы, разбитые по разделам
- Накапливает журнал событий за день — отчёт за период (день / неделя / месяц)
- **(v3)** Веб-карта в браузере: камеры точками на Яндекс-карте, клик по точке —
  статус «работает / не работает» и снимок с камеры. В шапке — кнопки объектов:
  клик показывает камеры только этого объекта и подводит карту к его площадке.
  Где у объекта есть второй этаж, на кнопке появляется выпадающий список этажей

## Что умеет проверять

Объекты описываются в `config/systems.json` (в репозиторий не входит — это
данные заказчика; образец: [config/systems.example.json](config/systems.example.json)).
Поле `type` выбирает способ проверки:

| `type` | Как проверяется | Чем полезен |
|---|---|---|
| `trassir-sdk` | TRASSIR SDK HTTP API | статусы каналов сервера TRASSIR, скриншоты |
| `hiwatch` | Hikvision/HiWatch ISAPI (digest) | статусы каналов NVR + кадр с канала |
| `hikvision-multi` | ISAPI по каждой камере отдельно | одиночные камеры без общего NVR |
| `ipanda-rtsp` | RTSP DESCRIBE (напрямую или через NVR) | NVR без пригодного HTTP API |
| `smb-recordings` | папки записей на SMB-шаре | пишется ли архив и не битые ли файлы |
| `beward-smb` | свежесть файлов на SMB-шаре | удалённые точки без доступа к камере |
| `rt-portal` | личный кабинет оператора связи (Playwright) | камеры, доступные только через ЛК |
| `tplink-tapo` | RTSP + ffmpeg | Wi-Fi камера, прицепленная к чужому NVR (`extraCameras`) |

## Изменения и версии

Датированная история изменений ведётся во внутренней документации проекта —
она лежит на рабочей машине и в репозиторий не публикуется. Текущая версия —
**v3.5** (этажи на карте камер).

## Стек

Node.js 22.5+ (ES modules) · Playwright (headless Chromium) · nodemailer · ffmpeg
· PowerShell (меню + планировщик задач Windows) · Bitrix24 Disk REST API.

Никакого облачного AI — все проверки детерминированные (HTTP API / SMB / RTSP /
ISAPI). Headless-браузер используется только для личного кабинета оператора связи.

## Режимы запуска

| Команда | Когда вызывается | Что делает |
|---|---|---|
| `node src/index.js --light` | каждые 15 мин, круглосуточно (24/7) | статусы + timeline + `monitor.db` + `reports/live.html` |
| `node src/index.js --daily` | раз в день в 07:00 МСК | + снимки + email-отчёты + helpdesk |
| `node src/index.js` | ручной запуск | как `--daily` |

Дополнительные флаги: `--dry-run`, `--debug`, `--only <id>`, `--reset-state`,
`--no-snapshots`, `--test-email`.

**Веб-карта (v3)** — отдельный долгоживущий процесс:

| Команда | Что делает |
|---|---|
| `npm run web` | Разовый запуск в текущей консоли. Закроете консоль — сервер остановится |
| `.\setup-web-task.ps1` | Сделать постоянным на хосте: задача Планировщика `AutoCameraWeb` (старт при загрузке, самолечение раз в 5 мин). `-Remove` — удалить. Требует прав администратора |
| `npm run add-user -- <логин> <пароль> admin` | Создать учётку (роли `viewer` / `admin`) |
| `npm run build-points` | Пересобрать `public/points.json` из `geo.txt` |
| `npm run backfill` | Перенести `state/timeline-*.json` в `state/monitor.db` (разово, идемпотентно) |

Прогоны мониторинга и веб живут независимо: веб только читает `monitor.db`,
поэтому его перезапуск ничего не ломает и наоборот.

## Меню (menu.ps1)

| Клавиша | Действие |
|---|---|
| `1` | Полная проверка всех систем (daily) |
| `T` | Тестовая проверка (dry-run) |
| `2`…`N` | Отдельная система: список строится по `config/systems.json` |
| `R` | Открыть последний отчёт |
| `V` | Live-монитор (auto-refresh 30 сек) |
| `H` | Отчёт за период (день / 3д / 7д / 30д / произвольно) |
| `L` | Папка логов |
| `S` | Настройка расписания |
| `E` | Email-адреса (по группам / Helpdesk / fallback) |
| `G` | Управление камерами (gray / delete / **A** — добавить устройство) |
| `0` | Выход |

## Структура

```
autocamera/
├── menu.ps1                 интерактивное меню
├── setup-schedule.ps1       настройка задач Light + Daily
├── setup-web-task.ps1       регистрация постоянной задачи веб-карты (v3)
├── run-web.ps1              разовый запуск веб-карты в консоли (отладка)
├── AutoCamera.bat           ярлык для рабочего стола
├── .env                     секреты (не в git)
├── .env.example             шаблон всех переменных окружения
├── .gitattributes           переносы строк: LF в репо, CRLF у .ps1/.bat
├── geo.txt                  координаты ОБЪЕКТОВ (не в git); центры, вокруг которых карта раскладывает камеры
├── docs/                    README.txt для оператора; мануал сотрудникам (не в git)
├── config/
│   ├── systems.json         список систем и камер (не в git)
│   ├── systems.example.json образец конфигурации
│   └── schedule.json        расписание light + daily
├── src/
│   ├── index.js             оркестратор (light / daily / manual)
│   ├── reporter.js          HTML-отчёт + sendReport + helpdesk
│   ├── config-loader.js     подстановка ${VAR} из .env в config/*.json
│   ├── logger.js            логгер: файл + консоль
│   ├── isapi.js             Hikvision/HiWatch ISAPI (digest auth)
│   ├── hikvision-multi.js   одиночные камеры — per-camera ISAPI
│   ├── trassir-check.js     TRASSIR SDK HTTP API
│   ├── rtsp-check.js        NVR по RTSP DESCRIBE
│   ├── tplink-tapo-check.js TP-Link Tapo — RTSP+ffmpeg (новое в v2.1)
│   ├── rostelecom-check.js  личный кабинет оператора — Playwright
│   ├── beward-check.js      свежесть файлов на SMB-шаре
│   ├── recordings-check.js  записи на SMB + контроль качества
│   ├── smb-utils.js         общие SMB-примитивы (сессия, вызов PowerShell)
│   ├── snapshots.js         захват кадра по типу системы
│   ├── bitrix-disk.js       загрузка снимков в Bitrix24
│   ├── last-good.js         кэш последнего рабочего кадра
│   ├── timeline.js          журнал событий offline/online
│   ├── monitor-db.js        state/monitor.db на node:sqlite (v3)
│   ├── detector.js          статистика: нестабильные камеры, сбой объекта (v3)
│   ├── stats.js             пороги и выборки статистики из БД (v3.1)
│   ├── attention-state.js   дедупликация заявок на нестабильные камеры (v3.1)
│   ├── image-quality.js     метрики кадра и классификация дефектов (v3.1)
│   ├── quality-check.js     разбор кадров прогона + дедупликация заявок (v3.1)
│   ├── state.js             helpdesk-state и дедупликация
│   ├── lock.js              лок «один прогон за раз» (daily/light не пересекаются)
│   ├── daily-state.js       статус рассылки + авто-досылка писем
│   ├── period-report.js     CLI отчёта за период
│   ├── detect-device.js     автоопределение типа устройства
│   └── manage-cameras.mjs   CLI для меню (add/gray/delete)
├── server/                  веб-карта (v3): app, config, auth, web-db, status, add-user
├── public/                  фронт без сборки (v3): index.html, app.js, styles.css, login.html
├── tools/                   build-points.js (geo.txt → points.json), backfill-timeline.js
├── state/                   timeline-*.json, monitor.db, web.db, camera-points.json, helpdesk-/daily-/attention-/quality-state.json, autocamera.lock (не в git)
├── screenshots/last-good/   кэш миниатюр для отчётов
├── logs/                    дневные логи (хранятся 14 дней) + web-*.log
├── reports/                 HTML-отчёты + live.html
└── test/                    юнит-тесты (node:test) — npm test
```

## Быстрый старт

```powershell
git clone https://github.com/alegis1337/autocameraweb.git
cd autocameraweb
npm install
npm test                          # юнит-тесты (node:test, без доп. зависимостей)
Copy-Item .env.example .env       # затем заполнить креды
Copy-Item config\systems.example.json config\systems.json   # описать свои объекты
.\setup-schedule.ps1              # создать задачи Light + Daily в Планировщике
.\menu.ps1                        # интерактивное меню
```

Веб-карта (v3) — после того, как прошёл хотя бы один прогон мониторинга:

```powershell
npm run backfill                            # перенести историю в monitor.db (разово)
npm run add-user -- <логин> <пароль> admin  # учётка для входа
npm run web                                 # http://127.0.0.1:8081
```

Доступ по локальной сети: `WEB_HOST=0.0.0.0` в `.env` (сервер слушает все
интерфейсы) + правило брандмауэра на входящий TCP 8081, ограниченное локальной
подсетью. С других машин сеть открывает карту по `http://<IP-хоста>:8081`; на
самом хосте `http://127.0.0.1:8081` тоже работает. Веб отдаётся по HTTP без TLS —
для внутренней сети приемлемо, за периметр — только через HTTPS.

Задачи Планировщика: `AutoCamera Light` (каждые 15 мин) и `AutoCamera Daily`
(07:00 МСК). Постоянный веб на хосте — задача `AutoCameraWeb` через
`.\setup-web-task.ps1` (от администратора).

Для карты: задайте `YANDEX_API_KEY` и `MAP_CENTER_LAT/LON` в `.env`, объекты —
в `WEB_MAP_SYSTEMS` (список id через запятую). Координаты объектов — в `geo.txt`,
после правки обязательно `npm run build-points` (сервер читает собранный
`public/points.json`). Камеры каждого объекта сначала лежат кучкой у его центра —
расставьте их мышью в режиме редактора, координаты сохранятся в
`state/camera-points.json`.

Требования: **Node.js 22.5+** (для встроенного `node:sqlite`), ffmpeg,
Playwright Chromium (`npm install` скачает автоматически), сетевой доступ
к камерам, inbound webhook в Bitrix24 для заливки снимков. Для карты —
`YANDEX_API_KEY` (Yandex Maps JS API, ограничить по домену-referer) и доступ
браузера зрителя к `api-maps.yandex.ru`.

## Документация

- [.env.example](.env.example) — шаблон конфигурации со всеми переменными окружения
- `docs/README.txt` — текстовая версия README для оператора на рабочей машине.
  **В репозиторий не входит:** там конкретика по объектам заказчика
- `docs/autocamera-manual.docx` — инструкция для сотрудников (как смотреть
  отчёты, добавить камеру, действия при поломке). **В репозиторий не входит:**
  внутри реальные адреса, почта заказчика и контакты инженера сопровождения.
  Лежит на рабочей машине и раздаётся сотрудникам напрямую

