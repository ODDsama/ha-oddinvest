"""Сенсори портфеля поверх документа oddinvest/state."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry
from .entity import OddInvestEntity
from .models import StateDoc


@dataclass(frozen=True, kw_only=True)
class OddInvestSensorDescription(SensorEntityDescription):
    value_fn: Callable[[StateDoc], Any]
    attrs_fn: Callable[[StateDoc], dict[str, Any] | None] | None = None


def _next_payment_date(doc: StateDoc) -> date | None:
    if doc.next_payment is None:
        return None
    return date.fromisoformat(doc.next_payment.date)


def _xirr_attrs(cur: str) -> Callable[[StateDoc], dict[str, Any] | None]:
    """Чому число порожнє — поруч із самим числом.

    Стан сенсора лишається unknown, доки вкладені гроші не попрацюють
    min_days у середньому, і доти картка не мала чим це пояснити:
    «зламалось» було єдиним, що з неї читалось. Тут же лежить заробок за
    фактом — відповідь на «скільки я заробив» без жодної ануалізації,
    тобто саме те, чого від показника й чекають.

    Окремих сутностей під це не заводимо: чотири скаляри при вже наявному
    сенсорі коштують recorder-у копійки, а три нові сутності на одне
    пояснення провалюють критерій відбору нижче.
    """

    def attrs(doc: StateDoc) -> dict[str, Any] | None:
        r = doc.realized.get(cur)
        if r is None:
            return None
        return {
            "gain": r.gain,
            "gain_pct": r.gain_pct,
            "money_days": r.money_days,
            "min_days": r.min_days,
        }

    return attrs


def _next_payment_attrs(doc: StateDoc) -> dict[str, Any] | None:
    if doc.next_payment is None:
        return None
    p = doc.next_payment
    return {
        "isin": p.isin,
        "type": p.type,
        "amount": p.amount,
        "currency": p.currency,
        "top_payments": [
            {
                "date": t.date,
                "isin": t.isin,
                "type": t.type,
                "amount": t.amount,
                "currency": t.currency,
            }
            for t in doc.top_payments
        ],
    }


def _ladder_attrs(doc: StateDoc) -> dict[str, Any]:
    return {
        "ladder": [{"year": r.year, "uah": r.uah, "usd": r.usd, "eur": r.eur} for r in doc.ladder]
    }


def _independence_date(doc: StateDoc) -> date | None:
    """Дата, коли дохід покриє ціль, — за ПЛАНОВИМ внеском.

    Порожня в двох випадках, і обидва законні: дохід уже покриває
    (plan_months == -1) або ціль не досягається за 60 років (0). Обидва
    читаються як unknown, і це чесніше за вигадану дату.
    """
    i = doc.independence
    if i is None or not i.plan_date:
        return None
    return date.fromisoformat(i.plan_date)


def _independence_attrs(doc: StateDoc) -> dict[str, Any] | None:
    i = doc.independence
    if i is None:
        return None
    return {
        "target_uah": i.target_uah,
        "income_now_uah": i.income_now_uah,
        "target_from": i.target_from,
        "plan_months": i.plan_months,
        "actual_months": i.actual_months,
        "actual_date": i.actual_date,
    }


def _yield_attrs(doc: StateDoc) -> dict[str, Any]:
    """Решта дохідностей — атрибутами, а не сусідніми сутностями.

    Три сутності підряд, кожна на імʼя «моя дохідність», були б рівно тією
    хворобою, від якої в контракті зʼявився capital_uah: людина дивиться на
    екран і не знає, котре з трьох чисел її.
    """
    return {
        "real_pct": doc.blended_yield_real_pct,
        "bonds_pct": doc.portfolio_yield_pct,
        "funds_pct": doc.funds_yield_pct,
    }


def _liquidity_attrs(doc: StateDoc) -> dict[str, Any] | None:
    lq = doc.liquidity
    if lq is None:
        return None
    # locked_npf_uah — ПІДПОЛЕ locked_uah, і без нього пара
    # «замкнено / розблокується» вводить в оману: unlock_date бере
    # найближчу дату, тобто вклад, а більша частина замкненого може бути
    # пенсійною й недоступною ще двадцять пʼять років.
    return {
        "now_uah": lq.now_uah,
        "in_90_uah": lq.in_90_uah,
        "reserve_uah": lq.reserve_uah,
        "locked_uah": lq.locked_uah,
        "locked_npf_uah": lq.locked_npf_uah,
        "unlock_date": lq.unlock_date,
    }


def _reserve_attrs(doc: StateDoc) -> dict[str, Any] | None:
    r = doc.reserve
    if r is None:
        return None
    return {
        "uah": r.uah,
        "target_months": r.target_months,
        "target_uah": r.target_uah,
        "gap_uah": r.gap_uah,
        "share_pct": r.share_pct,
        "monthly_expenses_uah": r.monthly_expenses_uah,
    }


def _tasks_attrs(doc: StateDoc) -> dict[str, Any]:
    """Черга задач атрибутом, у порядку, який дав сервіс.

    ОДИН сенсор із кількістю, а не сутність на задачу, і це не економія.
    Задачі приходять і зникають самі — внесок записали, виплату відмітили, —
    а сутність, яка зникає, ламає і графіки, і автоматизації, що на неї
    посилаються. Кількість же лишається числом завжди, навіть коли вона нуль.

    Найтерміновіше винесене окремими полями: автоматизації «скажи вголос, що
    робити» потрібен один рядок, а не список, і діставати його шаблоном із
    масиву щоразу було б переписуванням тієї самої умови в кожній автоматизації.
    """
    first = doc.tasks[0] if doc.tasks else None
    return {
        "now": sum(1 for t in doc.tasks if t.sev == "now"),
        "soon": sum(1 for t in doc.tasks if t.sev == "soon"),
        "watch": sum(1 for t in doc.tasks if t.sev == "watch"),
        "top_title": first.title if first else "",
        "top_why": first.why if first else "",
        "top_action": first.action if first else "",
        "top_kind": first.kind if first else "",
        "tasks": [
            {
                "id": t.id,
                "sev": t.sev,
                "kind": t.kind,
                "title": t.title,
                "why": t.why,
                "when": t.when,
                "action": t.action,
                "amount_uah": t.amount_uah,
            }
            for t in doc.tasks
        ],
    }


SENSORS: tuple[OddInvestSensorDescription, ...] = (
    OddInvestSensorDescription(
        key="invested_uah",
        translation_key="invested_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.invested_uah,
    ),
    OddInvestSensorDescription(
        key="nominal_uah_eq",
        translation_key="nominal_uah_eq",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.nominal_uah_eq,
        attrs_fn=_ladder_attrs,
    ),
    OddInvestSensorDescription(
        key="usd_share_pct",
        translation_key="usd_share_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda d: d.usd_share_pct,
    ),
    OddInvestSensorDescription(
        key="eur_share_pct",
        translation_key="eur_share_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda d: d.eur_share_pct,
    ),
    OddInvestSensorDescription(
        key="uninvested_uah",
        translation_key="uninvested_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.uninvested_uah,
    ),
    OddInvestSensorDescription(
        key="account_uah",
        translation_key="account_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.account_uah,
    ),
    OddInvestSensorDescription(
        key="total_capital_uah",
        translation_key="total_capital_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        # Капітал — усе, що в тебе є: папери, гроші, сертифікати фондів,
        # тіло банківських вкладів, резерв і пенсійні активи. Резерв входить
        # попри те, що не працює: це твої гроші, і вони або в капіталі, або
        # ніде. НПФ — попри те, що забрати його не можна до 50 років: капітал
        # відповідає на «скільки в мене є», а не на «скільки я можу зняти».
        #
        # Сума ЖИВЕ НЕ ТУТ. Сервіс публікує capital_uah готовим числом, і
        # StateDoc.capital() бере саме його, лишаючи складання запасним
        # шляхом для старішого бекенда. Доти цей рядок складав ту саму суму
        # самостійно — тобто був пʼятим визначенням капіталу в застосунку,
        # де поле capital_uah зʼявилось якраз щоб визначення було одне.
        value_fn=lambda d: d.capital(),
        # Складники, які варто бачити поруч із сумою, але які не варті
        # власної сутності — за критерієм у шапці цього переліку: ні часовий
        # ряд, ні тригер, ні числовий бейдж. Сутності немає ні в funds_uah,
        # ні в deposits_uah, і НПФ тут не виняток.
        attrs_fn=lambda d: {
            k: v for k, v in (("reserve_uah", d.reserve_uah), ("npf_uah", d.npf_uah)) if v
        }
        or None,
    ),
    OddInvestSensorDescription(
        key="month_invested_uah",
        translation_key="month_invested_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.month_invested_uah,
        attrs_fn=lambda d: {"target_uah": d.month_target_uah},
    ),
    OddInvestSensorDescription(
        key="month_progress_pct",
        translation_key="month_progress_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.month_progress_pct,
    ),
    OddInvestSensorDescription(
        key="month_incoming_uah",
        translation_key="month_incoming_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.month_incoming_uah,
    ),
    OddInvestSensorDescription(
        key="next_payment_date",
        translation_key="next_payment_date",
        device_class=SensorDeviceClass.DATE,
        value_fn=_next_payment_date,
        attrs_fn=_next_payment_attrs,
    ),
    OddInvestSensorDescription(
        key="xirr_uah",
        translation_key="xirr_uah",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.xirr.get("UAH"),
        attrs_fn=_xirr_attrs("UAH"),
    ),
    OddInvestSensorDescription(
        key="xirr_usd",
        translation_key="xirr_usd",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.xirr.get("USD"),
        attrs_fn=_xirr_attrs("USD"),
    ),
    OddInvestSensorDescription(
        key="xirr_eur",
        translation_key="xirr_eur",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.xirr.get("EUR"),
        attrs_fn=_xirr_attrs("EUR"),
    ),
    # Нижче — те, що доти було видно лише у веб-інтерфейсі.
    #
    # Критерій відбору один: сутність варта місця, якщо картка дашборда або
    # автоматизація візьме її як РЯД У ЧАСІ, ТРИГЕР або ЧИСЛОВИЙ БЕЙДЖ.
    # Таблиці (фонди, брокери, ребаланс, проєкція, крива ринку) провалюють
    # його втричі: сутність HA — це скаляр з історією, а таблиця в
    # extra_state_attributes пише повну копію в recorder на КОЖНЕ оновлення
    # документа, тобто на кожну мутацію портфеля. Наявний атрибут ladder —
    # це межа патерну, а не зразок; звідси _unrecorded_attributes нижче.
    OddInvestSensorDescription(
        key="income_monthly_now",
        translation_key="income_monthly_now",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        # MEASUREMENT, не TOTAL: це ТЕМП (₴ на місяць), а не накопичена
        # сума. TOTAL змусив би HA рахувати з нього приріст.
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
        value_fn=lambda d: d.income_monthly_now,
    ),
    OddInvestSensorDescription(
        key="accrued_uah",
        translation_key="accrued_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        # Єдина величина, що росте ПЛАВНО між виплатами і падає в нуль на
        # виплаті — тобто пилка, а не монотонний підсумок.
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
        value_fn=lambda d: d.accrued_uah,
    ),
    OddInvestSensorDescription(
        key="blended_yield_pct",
        translation_key="blended_yield_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.blended_yield_pct or None,
        attrs_fn=_yield_attrs,
    ),
    OddInvestSensorDescription(
        key="independence_date",
        translation_key="independence_date",
        device_class=SensorDeviceClass.DATE,
        value_fn=_independence_date,
        attrs_fn=_independence_attrs,
    ),
    OddInvestSensorDescription(
        key="liquidity_in_30_uah",
        translation_key="liquidity_in_30_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
        value_fn=lambda d: d.liquidity.in_30_uah if d.liquidity else None,
        attrs_fn=_liquidity_attrs,
    ),
    OddInvestSensorDescription(
        key="reserve_months",
        translation_key="reserve_months",
        native_unit_of_measurement="міс.",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        # Місяці, а не частка капіталу: резерв збирають заради питання «на
        # скільки протримаюсь без доходу», і саме на нього це число
        # відповідає. Частка капіталу поруч, атрибутом.
        value_fn=lambda d: d.reserve.months if d.reserve else None,
        attrs_fn=_reserve_attrs,
    ),
    OddInvestSensorDescription(
        key="tasks",
        translation_key="tasks",
        native_unit_of_measurement="задач",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
        # Число — скільки рішень чекає. Саме воно годиться і для картки, і
        # для умови автоматизації; сам список лежить атрибутом.
        value_fn=lambda d: len(d.tasks),
        attrs_fn=_tasks_attrs,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_add_entities(OddInvestSensor(data, entry.entry_id, desc) for desc in SENSORS)


class OddInvestSensor(OddInvestEntity, SensorEntity):
    entity_description: OddInvestSensorDescription

    # Таблиці в атрибутах у recorder НЕ пишуться.
    #
    # Документ перевидається в MQTT на кожну мутацію портфеля, а не раз на
    # добу, і без цього кожна купівля паперу записувала б у базу історії
    # повну копію драбини погашень і переліку найближчих виплат. Самі
    # атрибути лишаються видимими в шаблонах і картках — не пишеться лише
    # їхня історія, якої ніхто не читає.
    # tasks сюди ж, і причина та сама, лише гостріша: черга перебудовується
    # на КОЖНУ мутацію портфеля, а її рядки — це проза, тобто найдорожче з
    # усього, що могло б потрапити в базу історії. Число задач лишається
    # станом сенсора й пишеться нормально — саме його й будують у графік.
    _unrecorded_attributes = frozenset({"ladder", "top_payments", "tasks"})

    def __init__(self, data, entry_id: str, desc: OddInvestSensorDescription) -> None:
        super().__init__(data, entry_id)
        self.entity_description = desc
        self._attr_unique_id = f"{entry_id}_{desc.key}"

    @property
    def native_value(self):
        if self._data.state is None:
            return None
        return self.entity_description.value_fn(self._data.state)

    @property
    def extra_state_attributes(self):
        if self._data.state is None or self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self._data.state)
