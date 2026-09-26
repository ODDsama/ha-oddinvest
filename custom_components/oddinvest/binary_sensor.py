"""Бінарні сенсори портфеля.

Таблицею описів, як і sensor.py: доти кожен сенсор був окремим класом з
тим самим конструктором, тією самою перевіркою «документа ще немає» у
двох властивостях і тим самим рядком unique_id — вісім разів.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import timedelta
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from . import OddInvestConfigEntry
from .const import CARD_DUE_SOON_DAYS, CARD_MARK_STALE_DAYS, STALE_AFTER_H
from .entity import OddInvestEntity
from .models import StateDoc


@dataclass(frozen=True, kw_only=True)
class OddInvestBinaryDescription(BinarySensorEntityDescription):
    is_on_fn: Callable[[StateDoc], bool | None]
    attrs_fn: Callable[[StateDoc], dict[str, Any] | None] | None = None


# ---------------------------------------------------------------- картки


def _card_due_soon(st: StateDoc) -> bool | None:
    """ON = до розрахункової дати картки ≤ 7 днів і принести ще є що.

    Це те саме, від чого в сервісі задача card-due-* переходить у «зараз»
    (state_tasks.go). Тут окремою сутністю, бо саме її беруть у тригер
    автоматизації: «увімкни світло червоним» не читає чергу задач.

    Самогасне без нашої участі: платіж на картку зменшує bring_by_due, і
    щойно він нуль — сенсор off. None без звіреної картки: без звірки
    сума невідома, і off сказав би «все сплачено» там, де «не знаю».
    """
    near = st.debt.nearest() if st.debt is not None else None
    if near is None:
        return None
    return near.days_to_due <= CARD_DUE_SOON_DAYS and near.bring_by_due_uah > 0


def _card_due_soon_attrs(st: StateDoc) -> dict[str, Any] | None:
    near = st.debt.nearest() if st.debt is not None else None
    if near is None:
        return None
    return {
        "name": near.name,
        "due_date": near.due_date,
        "days_to_due": near.days_to_due,
        "bring_by_due_uah": near.bring_by_due_uah,
        "min_due_uah": near.min_due_uah,
    }


def _stale_cards(st: StateDoc) -> list[str]:
    return [
        c.name for c in st.debt.cards if (not c.known) or c.mark_age_days > CARD_MARK_STALE_DAYS
    ]


def _card_mark_stale(st: StateDoc) -> bool | None:
    """ON = хоч одна картка звірена понад два тижні тому або не звірена зовсім.

    Лікуємо ПОКАЗОМ, як price_stale і data_stale: числа лишаються на
    екрані, але вік названий. Незвірена картка — той самий стан у
    граничному вигляді: віку немає, бо немає й числа.
    """
    if st.debt is None or not st.debt.cards:
        return None
    return bool(_stale_cards(st))


def _card_mark_stale_attrs(st: StateDoc) -> dict[str, Any] | None:
    if st.debt is None:
        return None
    return {"stale": _stale_cards(st), "threshold_days": CARD_MARK_STALE_DAYS}


# ---------------------------------------------------------------- гроші


def _reinvest_ready_attrs(st: StateDoc) -> dict[str, Any]:
    n = int(st.account_uah // st.reinvest_min_uah) if st.reinvest_min_uah > 0 else 0
    return {
        "account_uah": st.account_uah,
        "reinvest_min_uah": st.reinvest_min_uah,
        "affordable_count": n,
    }


def _reserve_ready_attrs(st: StateDoc) -> dict[str, Any] | None:
    r = st.reserve
    if r is None:
        return None
    # Ціль і розрив поруч зі станом: «зібрано» без «скільки саме» —
    # число, яке нема чим перевірити. Місяці теж: подушку задають
    # саме в них, і частка капіталу без них бреше.
    return {
        "reserve_uah": r.uah,
        "target_uah": r.target_uah,
        "gap_uah": r.gap_uah,
        "months": r.months,
        "target_months": r.target_months,
    }


# ---------------------------------------------------------------- свіжість


def _ages(st: StateDoc) -> tuple[float | None, float | None]:
    now = dt_util.utcnow()
    return st.age_hours(now), st.nbu_age_hours(now)


def _data_stale(st: StateDoc) -> bool:
    return any(a is not None and a > STALE_AFTER_H for a in _ages(st))


def _data_stale_attrs(st: StateDoc) -> dict[str, Any]:
    doc_age, nbu_age = _ages(st)
    stale = []
    if doc_age is not None and doc_age > STALE_AFTER_H:
        stale.append("state")
    if nbu_age is not None and nbu_age > STALE_AFTER_H:
        stale.append("nbu")
    return {
        "state_age_hours": round(doc_age, 1) if doc_age is not None else None,
        "nbu_age_hours": round(nbu_age, 1) if nbu_age is not None else None,
        "threshold_hours": STALE_AFTER_H,
        "stale": stale,
    }


PROBLEM = BinarySensorDeviceClass.PROBLEM

BINARY_SENSORS: tuple[OddInvestBinaryDescription, ...] = (
    # ON = є виплати, які надійшли і не перевкладені. currency — щоб
    # сповіщення (blueprint uninvested_reminder) казало суму в тій валюті,
    # у якій вона є, а не «грн» наосліп.
    OddInvestBinaryDescription(
        key="has_uninvested",
        translation_key="has_uninvested",
        device_class=PROBLEM,
        is_on_fn=lambda st: st.uninvested_uah > 0,
        attrs_fn=lambda st: {"uninvested_uah": st.uninvested_uah, "currency": st.currency},
    ),
    # ON = на рахунку вистачає щонайменше на один папір (заклик до реінвестиції).
    OddInvestBinaryDescription(
        key="reinvest_ready",
        translation_key="reinvest_ready",
        is_on_fn=lambda st: st.reinvest_min_uah > 0 and st.account_uah >= st.reinvest_min_uah,
        attrs_fn=_reinvest_ready_attrs,
    ),
    # ON = числа на екрані старіші, ніж мають бути.
    #
    # Дві різні відмови під однією сутністю, і це навмисно. Перша: сервіс
    # живий і публікує, але довідник НБУ не оновлюється (мережа, зміна
    # формату на боці банку) — тоді дохідності рахуються за вчорашніми
    # курсами. Друга: сам сервіс перестав публікувати — тоді старіє все.
    # Дія в обох випадках одна — піти подивитись, чому; яка саме відмова,
    # кажуть атрибути.
    #
    # Це НЕ те саме, що недоступність. Коли сервіс лягає, LWT робить усі
    # сутності unavailable, і це видно й без нас. Тут ловиться протилежне —
    # ТИХЕ старіння: усе на місці, все відповідає, просто числа вчорашні.
    OddInvestBinaryDescription(
        key="data_stale",
        translation_key="data_stale",
        device_class=PROBLEM,
        is_on_fn=_data_stale,
        attrs_fn=_data_stale_attrs,
    ),
    # ON = хоча б один заданий ліміт концентрації перевищено. Порожній ліміт
    # означає, що вимір не міряють, а не що там стоїть чиясь уява про
    # норму: без жодного ліміта сенсор мовчить (off), а не кричить.
    OddInvestBinaryDescription(
        key="concentration_breach",
        translation_key="concentration_breach",
        device_class=PROBLEM,
        is_on_fn=lambda st: bool(st.breaches()),
        attrs_fn=lambda st: {"breaches": [asdict(c) for c in st.breaches()]},
    ),
    # ON = внеску в пенсійний за цей місяць ще немає.
    #
    # Єдина дія, якої НПФ вимагає від власника, — вчасно внести. Купити його
    # «вигідніше» не можна, продати не можна, перевкласти не можна: гроші
    # замкнені до пенсійного віку. Тому в застосунку він не стоїть у
    # пропозиціях реінвесту — його місце саме тут.
    #
    # Самогасне, і стану «я вже бачив» тут немає навмисно: щойно в журналі
    # зʼявиться внесок за поточний місяць, сервіс шле npf_contrib_due=false.
    # PROBLEM, бо пропущений внесок — не стан портфеля, а невиконана дія.
    # Собівартість поруч із вартістю: у НПФ вони РІЗНІ, на відміну від
    # вкладу чи резерву, тож без пари приросту не побачити.
    OddInvestBinaryDescription(
        key="npf_contribution_due",
        translation_key="npf_contribution_due",
        device_class=PROBLEM,
        is_on_fn=lambda st: st.npf_contrib_due,
        attrs_fn=lambda st: {"npf_uah": st.npf_uah, "npf_cost_uah": st.npf_cost_uah},
    ),
    # ON = подушку зібрано до заданої цілі; unknown без цілі (Reserve.is_ready).
    #
    # БЕЗ device_class: problem, і це навмисно: решта кажуть «щось треба
    # зробити», а цей — «те, що збирали, зібрано». Одягнений у problem, він
    # світив би червоним саме тоді, коли все добре. Похідне, а не поле
    # документа: gap_uah і target_uah сервіс уже шле, і reserve_ready поруч
    # був би другою відповіддю на те саме питання.
    OddInvestBinaryDescription(
        key="reserve_ready",
        translation_key="reserve_ready",
        is_on_fn=lambda st: st.reserve.is_ready() if st.reserve is not None else None,
        attrs_fn=_reserve_ready_attrs,
    ),
    OddInvestBinaryDescription(
        key="card_due_soon",
        translation_key="card_due_soon",
        device_class=PROBLEM,
        is_on_fn=_card_due_soon,
        attrs_fn=_card_due_soon_attrs,
    ),
    OddInvestBinaryDescription(
        key="card_mark_stale",
        translation_key="card_mark_stale",
        device_class=PROBLEM,
        is_on_fn=_card_mark_stale,
        attrs_fn=_card_mark_stale_attrs,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities(
        (DataStaleSensor if d.key == "data_stale" else OddInvestBinarySensor)(
            entry.runtime_data, entry.entry_id, d
        )
        for d in BINARY_SENSORS
    )


class OddInvestBinarySensor(OddInvestEntity, BinarySensorEntity):
    entity_description: OddInvestBinaryDescription

    # Перелік порушень концентрації — це таблиця, і в recorder їй місця
    # немає: документ перевидається на кожну мутацію портфеля.
    _unrecorded_attributes = frozenset({"breaches"})

    def __init__(self, data, entry_id: str, desc: OddInvestBinaryDescription) -> None:
        super().__init__(data, entry_id, desc.key)
        self.entity_description = desc

    @property
    def is_on(self) -> bool | None:
        st = self._data.state
        return None if st is None else self.entity_description.is_on_fn(st)

    @property
    def extra_state_attributes(self):
        st = self._data.state
        if st is None or self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(st)


class DataStaleSensor(OddInvestBinarySensor):
    async def async_added_to_hass(self) -> None:
        """Переоцінка за ГОДИННИКОМ, а не лише за новим документом.

        Вік рахується від «зараз», але стан HA переписувався тільки на
        MQTT-оновлення. Тобто саме та тиша, яку сенсор мав ловити, його й
        заморожувала: сервіс замовк — і сенсор назавжди лишався «ок». Раз на
        15 хвилин — досить для порогу в години і не шумить у журналі.
        """
        await super().async_added_to_hass()
        self.async_on_remove(
            async_track_time_interval(self.hass, self._tick, timedelta(minutes=15))
        )

    @callback
    def _tick(self, _now) -> None:
        self.async_write_ha_state()
