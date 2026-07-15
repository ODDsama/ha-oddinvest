"""Contract-тести: парсер інтеграції проти фікстур з oddinvest.

У CI фікстури перезавантажуються з main-гілки репозиторію сервіса —
локальна копія в tests/fixtures потрібна лише для офлайн-розробки.
"""

import importlib.util
import json
import pathlib
import sys

import pytest

# models.py навмисно вільний від залежностей HA; завантажуємо його напряму,
# щоб contract-тести бігали без встановленого homeassistant.
_MODELS_PATH = (
    pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest" / "models.py"
)
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


def test_parse_basic_fixture():
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.schema == 1
    assert doc.invested_uah == 137305.57
    assert doc.nominal_uah_eq == 138246.8
    assert doc.month_progress_pct == 90
    assert doc.uninvested_uah == 0
    assert doc.insurance_days_left == 45

    assert doc.next_payment is not None
    assert doc.next_payment.date == "2026-07-20"
    assert doc.next_payment.type == "coupon"
    assert doc.next_payment.amount == 4137.5
    assert doc.next_payment.currency == "UAH"

    assert len(doc.ladder) == 1
    assert doc.ladder[0].year == 2027
    assert doc.ladder[0].uah == 50000
    assert doc.ladder[0].usd == 2000

    assert len(doc.top_payments) == 3
    assert doc.top_payments[-1].type == "redemption"

    # v0.2: повний календар (у фікстурі збігається з top_payments)
    assert len(doc.calendar) == 3
    assert doc.calendar[0].date == "2026-07-20"


def test_settings_parsed():
    doc = StateDoc.from_payload(load("basic.json"))
    assert doc.settings is not None
    assert doc.settings.monthly_target_uah == 5000
    assert doc.settings.usd_target_share_pct == 50
    assert doc.settings.insurance_renewal == "2026-08-29"
    assert doc.settings.insurance_premium_uah == 8000


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
    assert doc.settings.insurance_renewal is None


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


def test_null_next_payment_and_insurance():
    raw = json.loads(load("basic.json"))
    raw["next_payment"] = None
    del raw["insurance_days_left"]
    doc = StateDoc.from_payload(json.dumps(raw))
    assert doc.next_payment is None
    assert doc.insurance_days_left is None
