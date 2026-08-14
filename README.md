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

| Сутність | Опис |
|---|---|
| `sensor.*_vkladeno` | вартість входу залишків, грн-екв. |
| `sensor.*_nominal_portfelia` | номінал портфеля, грн-екв.; атрибут `ladder` — драбина погашень |
| `sensor.*_chastka_usd` | частка валютних паперів, % |
| `sensor.*_ne_perevkladeno` | надійшло і не перевкладено, грн-екв. |
| `sensor.*_vnesky_za_misiats` | покупки поточного місяця; атрибут `target_uah` |
| `sensor.*_prohres_misiatsia` | % виконання місячної цілі |
| `sensor.*_nadkhodzhennia_misiatsia` | купони+погашення в поточному місяці |
| `sensor.*_nastupna_vyplata` | дата; атрибути: isin, type, amount, currency, `top_payments` |
| `sensor.*_strakhovka_dniv` | днів до продовження ризикової страховки |
| `binary_sensor.*_ie_neperevkladeni` | `on` = є гроші, що чекають перевкладення |

Доступність усіх сутностей прив'язана до LWT `{prefix}/availability`.

Також: `calendar.*_vyplaty` — календар усіх майбутніх виплат
(all-day події, працює з calendar-тригерами) і `button.*_onovyty_dani`.

Префікс `entity_id` — `odd_invest_` (від імені пристрою «ODD Invest»).

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
