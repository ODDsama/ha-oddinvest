"""Contract-тести: парсер інтеграції проти фікстур з oddinvest.

У CI фікстури перезавантажуються з main-гілки репозиторію сервіса —
локальна копія в tests/fixtures потрібна лише для офлайн-розробки.
"""

import importlib.util
import json
import pathlib
import sys
from datetime import date, datetime, timezone

import pytest

# models.py навмисно вільний від залежностей HA; завантажуємо його напряму,
# щоб contract-тести бігали без встановленого homeassistant.
_MODELS_PATH = pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest" / "models.py"
_spec = importlib.util.spec_from_file_location("oddinvest_models", _MODELS_PATH)
models = importlib.util.module_from_spec(_spec)
sys.modules["oddinvest_models"] = models  # потрібно dataclasses для резолву анотацій
_spec.loader.exec_module(models)

ContractError = models.ContractError
StateDoc = models.StateDoc

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_fixture_matches_schema():
    """Фікстура сервіса валідна проти його ж JSON Schema (самоперевірка)."""
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(load("oddinvest-state.schema.json"))
    doc = json.loads(load("basic.json"))
    jsonschema.validate(doc, schema)


def test_parse_tasks():
    """Черга задач читається з фікстури й лишається в порядку сервіса.

    Порядок тут перевіряється навмисно: інтеграція його НЕ відтворює, вона
    його ДОВІРЯЄ — сервіс уже впорядкував (спершу sev, далі rank). Якби
    парсер колись почав сортувати сам, HA й застосунок показували б різні
    «найтерміновіші» задачі, і помітили б це не одразу.
    """
    doc = StateDoc.from_payload(load("basic.json"))
    assert len(doc.tasks) == 2
    first, second = doc.tasks
    assert first.id == "reserve-fill"
    assert first.sev == "now"
    assert first.kind == "reserve"
    assert first.action == "fill-reserve"
    assert first.amount_uah == 12400
    # Друга — без kind: задача про довідник НБУ не про інструмент, і
    # порожній рядок тут означає саме це, а не «забули заповнити».
    assert second.id == "nbu"
    assert second.sev == "watch"
    assert second.kind == ""


def test_tasks_absent_is_empty():
    """Бекенд без черги — не помилка, а старіший сервіс.

    Те саме правило, що для funds_uah і решти адитивних полів: інтеграція
    переживає відсутність нулем, а не падінням.
    """
    raw = json.loads(load("basic.json"))
    del raw["tasks"]
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.tasks == ()


def test_parse_basic_fixture():
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.schema == 1
    assert doc.invested_uah == 137305.57
    assert doc.nominal_uah_eq == 138246.8
    assert doc.month_progress_pct == 90
    assert doc.uninvested_uah == 0
    assert doc.eur_share_pct == 0

    # Найближча виплата у фікстурі — відсотки ВКЛАДУ, а не купон паперу.
    # Вклад ходить у розкладі під синтетичним "deposit:<id>", і саме на
    # ньому схема сервіса колись сама себе не проходила (вимагала від isin
    # патерн UA[0-9A-Z]{10}). Тепер цей випадок у фікстурі є, тож
    # test_fixture_matches_schema вище його й перевіряє.
    assert doc.next_payment is not None
    assert doc.next_payment.date == "2026-07-18"
    assert doc.next_payment.isin == "deposit:1"
    assert doc.next_payment.type == "coupon"
    assert doc.next_payment.amount == 300
    assert doc.next_payment.currency == "UAH"

    assert len(doc.ladder) == 1
    assert doc.ladder[0].year == 2027
    assert doc.ladder[0].uah == 50000
    assert doc.ladder[0].usd == 2000
    assert doc.ladder[0].eur == 0

    assert len(doc.top_payments) == 4
    assert doc.top_payments[-1].type == "redemption"

    # v0.2: повний календар (у фікстурі збігається з top_payments)
    assert len(doc.calendar) == 4
    assert doc.calendar[0].date == "2026-07-18"


def test_capital_uah_parsed():
    """Капітал приходить готовим числом і береться саме воно."""
    doc = StateDoc.from_payload(load("basic.json"))
    # 138 246.80 номіналу + 60 000 резерву + 45 000 НПФ.
    #
    # Число переїхало з 198 246.80 тоді, коли НПФ увійшов у капітал на боці
    # сервіса. Це не регресія фікстури, а те, заради чого він туди
    # заводився: доти будь-яка частка, порахована при наявному пенсійному
    # рахунку, була заниженою.
    assert doc.capital_uah == 243246.8
    assert doc.capital() == 243246.8


def test_capital_falls_back_to_sum():
    """Без capital_uah капітал складається з частин — але лише тоді.

    Це шлях для СТАРІШОГО сервіса. Перевіряємо його на тій самій фікстурі
    з видаленим полем, щоб сума звірялась із числом, яке сервіс і сам
    порахував: якщо вони розійдуться, розійшлись саме визначення капіталу,
    а це рівно та вада, заради якої поле й зʼявилось у контракті.
    """
    raw = json.loads(load("basic.json"))
    expected = raw.pop("capital_uah")
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.capital_uah is None
    assert doc.capital() == expected


def test_capital_zero_is_not_absent():
    """Нуль від сервіса — це нуль, а не «поля немає».

    Порожній портфель законно має капітал 0. Якби capital_uah зберігалось
    як 0.0 замість None, цей випадок був би невідрізнимий від старого
    сервіса, і сенсор мовчки перейшов би на складання частин — тобто на
    друге визначення капіталу, саме там, де перевірити його найважче.
    """
    raw = json.loads(load("basic.json"))
    raw["capital_uah"] = 0
    # Частини лишаємо ненульовими: сума дала б 243 246.80, і якби запасний
    # шлях увімкнувся помилково, це було б видно.
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.capital_uah == 0
    assert doc.capital() == 0


def test_payment_label_parsed():
    """Підпис виплати читається з документа, а не вигадується клієнтом."""
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.next_payment.label == "вклад"
    # В облігації підпис порожній: її ISIN і є назвою.
    bond = next(p for p in doc.calendar if p.isin.startswith("UA"))
    assert bond.label == ""


def test_payment_label_absent_on_old_service():
    """Старіший сервіс label не надсилає — рядок лишається без підпису."""
    raw = json.loads(load("basic.json"))
    for p in raw["calendar"] + raw["top_payments"]:
        p.pop("label", None)
    raw["next_payment"].pop("label", None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.next_payment.label == ""
    assert all(p.label == "" for p in doc.calendar)


def test_rich_scalars_parsed():
    """Показники, що доти жили лише у веб-інтерфейсі."""
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.income_monthly_now == 1240.5
    assert doc.accrued_uah == 812.33
    assert doc.blended_yield_pct == 14.10
    assert doc.blended_yield_real_pct == 6.85
    assert doc.portfolio_yield_pct == 14.93
    assert doc.funds_yield_pct == 11.20
    assert doc.nbu_refreshed_at == "2026-07-15T06:10:00Z"


def test_nested_objects_parsed():
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.independence is not None
    assert doc.independence.plan_date == "2044-05-15"
    assert doc.independence.target_from == "expenses"
    # plan_months — саме int, хоч JSON не розрізняє цілих і дробових.
    assert isinstance(doc.independence.plan_months, int)

    assert doc.liquidity is not None
    assert doc.liquidity.in_30_uah == 5637.5
    assert doc.liquidity.locked_uah == 120000

    assert doc.reserve is not None
    assert doc.reserve.months == 2
    assert doc.reserve.gap_uah == 30000

    assert len(doc.concentration) == 2
    over = [c for c in doc.concentration if c.over_uah > 0]
    assert len(over) == 1
    assert over[0].dimension == "isin"
    assert over[0].label == "валютні військові"


def test_nested_objects_absent_on_old_service():
    """Старіший сервіс цих обʼєктів не надсилає — None, а не порожній обʼєкт.

    Різниця має значення: None читається сутністю як unknown, а обʼєкт із
    нулями показав би «резерв на 0 місяців» там, де про резерв просто не
    питали.
    """
    raw = json.loads(load("basic.json"))
    for k in ("independence", "liquidity", "reserve", "concentration"):
        raw.pop(k, None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.independence is None
    assert doc.liquidity is None
    assert doc.reserve is None
    assert doc.concentration == ()


def test_nested_object_ignores_unknown_fields():
    """Нове поле сервіса всередині вкладеного обʼєкта не валить парсер.

    Правило «тільки додавання» на боці сервіса стосується й вкладених
    обʼєктів, а не лише верхнього рівня.
    """
    raw = json.loads(load("basic.json"))
    raw["liquidity"]["in_7_uah"] = 123.45
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.liquidity.in_30_uah == 5637.5


def test_empty_fixture_has_no_nested_objects():
    """Порожній портфель: обʼєктів немає, і це не помилка."""
    doc = StateDoc.from_payload(load("empty.json"))
    assert doc.independence is None
    assert doc.reserve is None
    assert doc.income_monthly_now == 0


def test_age_hours_distinguishes_absent_from_fresh():
    """Немає мітки — це None, а не «нуль годин».

    Плутати їх означало б тихо вважати старіший сервіс, який
    nbu_refreshed_at не надсилає, вічно свіжим — тобто сенсор
    «дані застаріли» ніколи б на ньому не спрацював.
    """
    doc = StateDoc.from_payload(load("basic.json"))
    now = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
    # generated_at = 2026-07-15T10:00:00Z → дві години
    assert doc.age_hours(now) == pytest.approx(2.0)
    # nbu_refreshed_at = 06:10 того ж дня
    assert doc.nbu_age_hours(now) == pytest.approx(5.833, abs=0.01)

    raw = json.loads(load("basic.json"))
    raw.pop("nbu_refreshed_at")
    old = StateDoc.from_payload(json.dumps(raw))
    assert old.nbu_age_hours(now) is None
    assert old.age_hours(now) == pytest.approx(2.0)


def test_age_hours_survives_garbage_stamp():
    """Зіпсована мітка не валить інтеграцію — вона просто невідома."""
    raw = json.loads(load("basic.json"))
    raw["nbu_refreshed_at"] = "не-дата"
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.nbu_age_hours(datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)) is None


def test_breaches_only_over_limit():
    """Перевищення — це over_uah > 0, а не «є ліміт»."""
    doc = StateDoc.from_payload(load("basic.json"))
    assert len(doc.concentration) == 2
    br = doc.breaches()
    assert len(br) == 1
    assert br[0].key == "UA4000230114"
    # Рядок у межах ліміту показується, але порушенням не рахується:
    # «45% при ліміті 50%» теж варте знання.
    assert any(c.over_uah == 0 for c in doc.concentration)


def test_reserve_not_ready_while_gap_open():
    """Фікстура: 60 000 ₴ при цілі 90 000 ₴ — розрив 30 000, тобто НЕ зібрано."""
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.reserve is not None
    assert doc.reserve.gap_uah == 30000
    assert doc.reserve.is_ready() is False


def test_reserve_ready_when_gap_closed():
    """Зібраний резерв приїжджає БЕЗ gap_uah, а не з нулем: у сервіса omitempty."""
    raw = json.loads(load("basic.json"))
    raw["reserve"].pop("gap_uah", None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.reserve.is_ready() is True


def test_reserve_ready_unknown_without_target():
    """Цілі немає — питання не ставили. None, а не False.

    False сказало б «не зібрано» тому, хто резерв не планує, і в HA це
    світило б сталим off замість чесного unknown.
    """
    raw = json.loads(load("basic.json"))
    raw["reserve"].pop("target_uah", None)
    raw["reserve"].pop("gap_uah", None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.reserve.is_ready() is None


def test_reserve_absent_on_old_service():
    """Сервіс без обʼєкта reserve — сенсор мовчить (unknown), а не каже «не зібрано»."""
    raw = json.loads(load("basic.json"))
    raw.pop("reserve", None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.reserve is None


def test_redemptions_within_ignores_coupons():
    """Погашення ≠ купон.

    Купон приходить і йде далі; погашення повертає ТІЛО, і воно або піде
    за новою ставкою, або ляже мертвим вантажем. Сповіщати варто про друге.
    """
    doc = StateDoc.from_payload(load("basic.json"))
    # У фікстурі погашення одне — 2027-03-17.
    assert doc.redemptions_within(7, date(2026, 7, 15)) == ()
    soon = doc.redemptions_within(7, date(2027, 3, 15))
    assert len(soon) == 1
    assert soon[0].type == "redemption"
    assert soon[0].date == "2027-03-17"
    # Купони в найближчі дні є, але сюди не потрапляють.
    assert doc.redemptions_within(400, date(2026, 7, 15))[0].type == "redemption"


def test_best_market_offer_takes_newest_not_biggest():
    """Сповіщення про подію бере НАЙСВІЖІШЕ розміщення, а не найвигідніше.

    Інакше воно щодня переказувало б той самий піврічної давнини рядок із
    найбільшим розривом — і перестало б означати «щойно сталось».
    """
    raw = json.loads(load("basic.json"))
    raw["market_yield"] = [
        # Найбільший розрив, але давно.
        {
            "currency": "UAH",
            "bucket": "3y",
            "pct": 20.0,
            "date": "2026-01-10",
            "isin": "UA1",
            "vs_portfolio_pp": 5.0,
        },
        # Найсвіжіше.
        {
            "currency": "UAH",
            "bucket": "2y",
            "pct": 16.1,
            "date": "2026-07-14",
            "isin": "UA2",
            "vs_portfolio_pp": 1.2,
        },
    ]
    doc = StateDoc.from_payload(json.dumps(raw))
    best = doc.best_market_offer()
    assert best.date == "2026-07-14"
    assert best.bucket == "2y"


def test_best_market_offer_ignores_worse_than_portfolio():
    """«Ринок дає менше за твій портфель» — не привід нікого будити."""
    raw = json.loads(load("basic.json"))
    raw["market_yield"] = [
        {
            "currency": "USD",
            "bucket": "2y",
            "pct": 3.15,
            "date": "2026-07-14",
            "isin": "UA3",
            "vs_portfolio_pp": -0.4,
        },
    ]
    assert StateDoc.from_payload(json.dumps(raw)).best_market_offer() is None


def test_market_yield_absent_on_old_service():
    raw = json.loads(load("basic.json"))
    raw.pop("market_yield", None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.market_yield == ()
    assert doc.best_market_offer() is None


def test_market_yield_parsed_from_fixture():
    """У фікстурі є і вищий за портфель рядок, і нижчий."""
    doc = StateDoc.from_payload(load("basic.json"))
    assert len(doc.market_yield) == 2
    assert doc.best_market_offer().currency == "UAH"
    assert doc.best_market_offer().vs_portfolio_pp == 0.72


def test_settings_parsed():
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.settings is not None
    assert doc.settings.monthly_target_uah == 5000
    assert doc.settings.usd_target_share_pct == 50


def test_xirr_parsed():
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.xirr == {"UAH": 16.51, "USD": 3.22}


def test_xirr_absent_on_old_service():
    raw = json.loads(load("basic.json"))
    del raw["xirr"]
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.xirr == {}


def test_empty_portfolio_fixture():
    """Свіжа інсталяція: нуль лотів, все по нулях — нічого не падає."""
    doc = StateDoc.from_payload(load("empty.json"))
    assert doc.invested_uah == 0
    assert doc.next_payment is None
    assert doc.calendar == ()
    assert doc.ladder == ()
    assert doc.settings is None
    assert doc.xirr == {}


def test_settings_absent_on_old_service():
    raw = json.loads(load("basic.json"))
    del raw["settings"]
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.settings is None


def test_settings_partial():
    raw = json.loads(load("basic.json"))
    raw["settings"] = {"monthly_target_uah": 4000}
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.settings.monthly_target_uah == 4000


def test_calendar_absent_on_old_service():
    """Сервіс 0.1 не шле calendar — інтеграція має жити з порожнім."""
    raw = json.loads(load("basic.json"))
    del raw["calendar"]
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.calendar == ()


def test_unknown_fields_are_ignored():
    """Сервіс має право додавати поля — стара інтеграція не ламається."""
    raw = json.loads(load("basic.json"))
    raw["brand_new_field"] = {"anything": 1}
    raw["next_payment"]["extra"] = True
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.schema == 1


def test_wrong_schema_rejected():
    raw = json.loads(load("basic.json"))
    raw["schema"] = 2
    with pytest.raises(ContractError, match="schema=2"):
        StateDoc.from_payload(json.dumps(raw))


def test_missing_required_field_rejected():
    raw = json.loads(load("basic.json"))
    del raw["invested_uah"]
    with pytest.raises(ContractError, match="invested_uah"):
        StateDoc.from_payload(json.dumps(raw))


def test_garbage_rejected():
    with pytest.raises(ContractError):
        StateDoc.from_payload("не json взагалі")
    with pytest.raises(ContractError):
        StateDoc.from_payload("[1,2,3]")


def test_null_next_payment():
    raw = json.loads(load("basic.json"))
    raw["next_payment"] = None
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.next_payment is None


def test_npf_parsed():
    """Пенсійні поля доїжджають з документа цілими.

    Усі три разом, бо кожне має свого споживача: npf_uah іде в атрибути
    капіталу й у резервну суму capital(), npf_cost_uah — у пару приросту
    (у НПФ вартість і собівартість РІЗНІ, на відміну від вкладу), а
    npf_contrib_due — у власний binary_sensor.
    """
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.npf_uah == 45_000
    assert doc.npf_cost_uah == 40_000
    assert doc.npf_contrib_due is True
    # Замкнене в НПФ — ПІДПОЛЕ locked_uah, а не додаток до нього: сума
    # понад locked_uah описувала б неможливий портфель.
    assert doc.liquidity is not None
    assert doc.liquidity.locked_npf_uah == 45_000
    assert doc.liquidity.locked_npf_uah <= doc.liquidity.locked_uah


def test_npf_absent_on_old_service():
    """Сервіс без НПФ не валить парсер — поля просто нулі.

    Той самий контракт, що з фондами, вкладами й резервом: усе, що
    зʼявилось у схемі пізніше, читається за замовчуванням. Для
    npf_contrib_due це саме False, тобто нагадування мовчить, а не
    спрацьовує на порожньому місці.
    """
    raw = json.loads(load("basic.json"))
    for k in ("npf_uah", "npf_cost_uah", "npf_contrib_due"):
        raw.pop(k, None)
    raw["liquidity"].pop("locked_npf_uah", None)
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.npf_uah == 0.0
    assert doc.npf_cost_uah == 0.0
    assert doc.npf_contrib_due is False
    assert doc.liquidity.locked_npf_uah == 0.0


def test_capital_fallback_includes_npf():
    """Резервна сума не має губити пенсійну частину.

    Окремо від test_capital_falls_back_to_sum, хоч той і звіряється з
    числом сервіса: цей ловить ІНШУ помилку — коли npf_uah забули додати в
    capital(), але фікстуру ще не оновили, тож обидва числа збігаються й
    перший тест лишається зеленим, будучи хибним.

    Тут різниця вимірюється прямо: сума без НПФ мусить бути МЕНШОЮ рівно на
    пенсійний баланс.
    """
    raw = json.loads(load("basic.json"))
    expected = raw.pop("capital_uah")
    with_npf = StateDoc.from_payload(json.dumps(raw))
    assert with_npf.capital() == expected

    raw_no_npf = dict(raw)
    raw_no_npf["npf_uah"] = 0
    without = StateDoc.from_payload(json.dumps(raw_no_npf))
    assert expected - without.capital() == with_npf.npf_uah
