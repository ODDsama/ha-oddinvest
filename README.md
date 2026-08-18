# ha-oddinvest

Кастомна інтеграція Home Assistant для [ODD Invest](https://github.com/ODDsama/oddinvest):
стан портфеля приходить push-ом через MQTT (retained `{prefix}/state`),
команди йдуть у REST сервіса.

Це **інтеграція, а не інтерфейс**: вона дає сутності, сповіщення, сервіси
й налаштування — тобто те, з чим працюють автоматизації, дашборди й
довга статистика. Сам застосунок живе в `oddinvest` і відкривається за
тією ж адресою, яку тут вказують як REST (`http://lxc-host:8080`).

Наразі покривається клас ОВДП; інтеграція побудована так, щоб додавати
інші інструменти без зміни контракту.

## Вимоги

- Home Assistant ≥ 2024.6 з налаштованою інтеграцією **MQTT**
  (той самий брокер, куди публікує `oddinvestd`).
- Запущений `oddinvestd` з увімкненим MQTT (`ODDINVEST_MQTT_ADDR`).

## Встановлення

**HACS**: додати цей репозиторій як custom repository (категорія
Integration) → встановити → перезавантажити HA.

**Вручну**: скопіювати `custom_components/oddinvest` у `config/custom_components/`.

Далі: Налаштування → Пристрої та служби → Додати інтеграцію → «ODD Invest».
Вказати адресу REST (`http://lxc-host:8080`) і префікс топіків
(типово `oddinvest`, має збігатися з `ODDINVEST_MQTT_PREFIX`).

## Сутності

Тридцять штук. Префікс `entity_id` — `odd_invest_` (від імені пристрою
«ODD Invest»); нижче — ключі, бо саме вони стабільні, а `entity_id`
залежить від транслітерації назви.

**Скільки в мене є** (`sensor`)

| Ключ | Що показує |
|---|---|
| `invested_uah` | вартість входу залишків, грн-екв. |
| `nominal_uah_eq` | номінал портфеля; атрибут `ladder` — драбина погашень |
| `total_capital_uah` | увесь капітал: папери + гроші + фонди + вклади + резерв |
| `account_uah` | гроші на рахунках брокерів, грн-екв. |
| `uninvested_uah` | надійшло і не перевкладено |
| `accrued_uah` | накопичений, ще не виплачений купон |

**Скільки це приносить**

| Ключ | Що показує |
|---|---|
| `blended_yield_pct` | дохідність портфеля; атрибути: `real_pct`, `bonds_pct`, `funds_pct` |
| `income_monthly_now` | скільки портфель приносить щомісяця вже зараз |
| `xirr_uah` / `xirr_usd` / `xirr_eur` | фактична річна дохідність по валютах |

**Куди це йде**

| Ключ | Що показує |
|---|---|
| `next_payment_date` | дата; атрибути: `isin`, `type`, `amount`, `currency`, `top_payments` |
| `independence_date` | коли дохід покриє ціль; атрибути: `plan_months`, `actual_date`… |
| `liquidity_in_30_uah` | скільки грошей стане доступно за 30 днів |
| `reserve_months` | на скільки місяців життя вистачить резерву |
| `month_invested_uah` | внески поточного місяця; атрибут `target_uah` |
| `month_progress_pct` | % виконання місячної цілі |
| `month_incoming_uah` | купони + погашення в поточному місяці |
| `usd_share_pct` / `eur_share_pct` | валютні частки капіталу |

**Що вимагає уваги** (`binary_sensor`)

`device_class: problem` мають не всі: `reinvest_ready` і `reserve_ready` кажуть
протилежне — «те, чого чекали, настало», — і червоний колір у HA був би там
рівно навпаки.

| Ключ | `on` означає | `device_class` |
|---|---|---|
| `has_uninvested` | є гроші, що чекають перевкладення | `problem` |
| `reinvest_ready` | на рахунку вистачає щонайменше на один папір | — |
| `npf_contribution_due` | внеску в НПФ за цей місяць ще немає; гасне саме, щойно внесок зʼявиться в журналі | `problem` |
| `concentration_breach` | заданий ліміт концентрації перевищено; атрибут `breaches` | `problem` |
| `reserve_ready` | подушку зібрано до заданої цілі; `unknown`, якщо цілі резерву немає | — |
| `data_stale` | числа старші за 36 год — сервіс живий, але дані стоять | `problem` |

**Що можна змінити звідси**

| Ключ | Тип |
|---|---|
| `usd_target_share_pct`, `eur_target_share_pct` | `number`, повзунки цільових часток |
| `goal_amount_uah` | `number`, цільова сума |
| `goal_date` | `date`, дедлайн цілі |
| `refresh` | `button`, оновити довідник НБУ й курс |

Плюс `calendar.*` — усі майбутні виплати all-day подіями, тобто працює з
calendar-тригерами й офсетами.

Доступність усіх сутностей прив'язана до LWT `{prefix}/availability`:
коли сервіс лягає, вони стають `unavailable`, а не показують останнє
відоме число як поточне.

## Чого тут свідомо немає

- **Таблиць як сутностей.** Фонди, брокери, ребаланс, рядки концентрації,
  проєкція, крива первинного ринку — усе це в контракті є, і сутностей із
  них немає. Сутність Home Assistant — це скаляр з історією; таблиця в
  `extra_state_attributes` пише повну копію в recorder на КОЖНЕ оновлення
  документа, а документ перевидається на кожну мутацію портфеля. Наявний
  атрибут `ladder` — це межа патерну, а не зразок, і саме тому він
  виключений з recorder. Хто хоче таблицю — відкриває веб-інтерфейс.
- **Сповіщення про дрейф ребалансу.** `rebalance` — це пропозиція, а
  застосунок порад щодо стратегії не дає (див. «Чого тут свідомо немає» в
  README сервіса). Push-сповіщення — найнаполегливіша форма поради, і
  саме її тут бути не повинно.
- **Сповіщення «сервіс недоступний».** Кожна сутність уже стає
  `unavailable` через LWT, і це видно без нас; окреме сповіщення ще й
  спрацьовувало б на кожних перегонах при перезапуску HA. Справді бракує
  іншого — «стан не оновлювався», коли сервіс живий, а числа стоять; це
  `data_stale` і опція `notify_stale`.
- **Сенсорів `drawdown` і `rate_risk`.** Числа для роздумів, а не для
  тригерів: за ними не будують автоматизацію й не дивляться графік.
- **Окремих сутностей під кожну дохідність.** `portfolio_yield_pct`,
  `funds_yield_pct` і `blended_yield_real_pct` приходять атрибутами
  `blended_yield_pct`. Три сусідні числа, кожне на імʼя «моя дохідність»,
  — це рівно та хвороба, від якої в контракті зʼявився `capital_uah`.
- **Оптимістичних оновлень.** Команда йде в REST, підтверджене значення
  повертається з MQTT. На екрані те, що реально збережено.

## Сервіси

- `oddinvest.refresh` — оновити довідник НБУ і курс на боці сервіса,
  зробити знімок і републікувати стан.
- `oddinvest.mark_payment` — позначити виплату `received`/`reinvested`
  (isin + pay_date); знімає її з лічильника неперевкладених.

## Blueprints

`blueprints/automation/oddinvest/`:
- `uninvested_reminder.yaml` — нагадування перевкласти виплати;
- `payment_tomorrow.yaml` — сповіщення о 18:00 напередодні виплати
  (calendar-тригер з офсетом).

Приклад дашборда — `examples/dashboard.yaml`.

## Приклади автоматизацій

```yaml
# Нагадування перевкласти виплату
automation:
  - alias: "ODD Invest: є неперевкладені гроші"
    trigger:
      - platform: state
        entity_id: binary_sensor.odd_invest_ie_neperevkladeni
        to: "on"
        for: "24:00:00"
    action:
      - service: notify.mobile_app
        data:
          message: >-
            На рахунку {{ state_attr('binary_sensor.odd_invest_ie_neperevkladeni',
            'uninvested_uah') | round(0) }} грн з виплат — час перевкласти.
```

```yaml
# Виплата завтра
automation:
  - alias: "ODD Invest: завтра виплата"
    trigger:
      - platform: template
        value_template: >-
          {{ states('sensor.odd_invest_nastupna_vyplata') ==
             (now().date() + timedelta(days=1)) | string }}
    action:
      - service: notify.mobile_app
        data:
          message: >-
            Завтра {{ state_attr('sensor.odd_invest_nastupna_vyplata','type') }}
            {{ state_attr('sensor.odd_invest_nastupna_vyplata','amount') }}
            {{ state_attr('sensor.odd_invest_nastupna_vyplata','currency') }}
            по {{ state_attr('sensor.odd_invest_nastupna_vyplata','isin') }}.
```

## Контракт

Інтеграція розуміє `schema: 1`. Парсер (`models.py`) — чистий Python;
CI щотижня і на кожен PR ганяє його проти актуальних фікстур з
`oddinvest/contract/` (нові поля сервіса не ламають стару
інтеграцію; зміна семантики = нова версія схеми = явна помилка в лог).

Сенсори XIRR (`xirr_uah`/`xirr_usd`) з'являються після 30 днів
історії портфеля. Приклад apexcharts «факт vs план» —
у `examples/dashboard.yaml`.

## Де інтерфейс

У `oddinvest`, за адресою сервіса. Розділів п'ять, і кожен відповідає
рівно на одне питання: **Огляд** — що робити зараз, **Портфель** — що в
мене є, **Гроші** — де вони лежать, **Майбутнє** — куди це йде,
**Налаштування** — як воно налаштоване.

Донедавна та сама збірка їхала й сюди — бічною панеллю HA, з проксі
`/api/oddinvest/*` і вендором у `custom_components/oddinvest/www/shared/`.
Панель прибрана: нею не користувались, а платив за неї кожен дотик до
UI — тридцять файлів дубля в git, скрипт синхронізації, манiфест sha256
і окрема джоба CI, яка звіряла копію з оригіналом. Одна поверхня
дешевша за дві, поки другою ніхто не ходить.

Кому потрібен пункт у бічній панелі — це робиться нульовим кодом,
штатним `panel_iframe` у власному `configuration.yaml`:

```yaml
panel_iframe:
  oddinvest:
    title: "ODD Invest"
    icon: mdi:chart-box-outline
    url: "http://lxc-host:8080"
```

Це конфігурація Home Assistant, не відповідальність інтеграції. Зверніть
увагу: iframe ходить у бекенд **з браузера**, тож адреса має бути
досяжна з пристрою, і на HA за HTTPS такий iframe заблокує mixed
content — це та ціна, яку раніше платила за нас проксі.

## Перевірки

```sh
pip install pytest jsonschema ruff
pytest -q                # contract-тести проти фікстур
ruff check . && ruff format --check .
```

Те саме ганяє CI, плюс `hassfest` і валідацію HACS. Форматування —
гейт, а не порада: діф, у якому перемішані правка й перенесення рядків,
читати неможливо.
