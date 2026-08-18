"""Бінарні сенсори портфеля."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import OddInvestConfigEntry
from .const import STALE_AFTER_H
from .entity import OddInvestEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities(
        [
            UninvestedCashSensor(entry.runtime_data, entry.entry_id),
            ReinvestReadySensor(entry.runtime_data, entry.entry_id),
            DataStaleSensor(entry.runtime_data, entry.entry_id),
            ConcentrationBreachSensor(entry.runtime_data, entry.entry_id),
            NPFContributionDueSensor(entry.runtime_data, entry.entry_id),
            ReserveReadySensor(entry.runtime_data, entry.entry_id),
        ]
    )


class ReinvestReadySensor(OddInvestEntity, BinarySensorEntity):
    """ON = на рахунку вистачає щонайменше на один папір (заклик до реінвестиції)."""

    _attr_translation_key = "reinvest_ready"

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_reinvest_ready"

    @property
    def is_on(self) -> bool | None:
        st = self._data.state
        if st is None:
            return None
        return st.reinvest_min_uah > 0 and st.account_uah >= st.reinvest_min_uah

    @property
    def extra_state_attributes(self):
        st = self._data.state
        if st is None:
            return None
        n = int(st.account_uah // st.reinvest_min_uah) if st.reinvest_min_uah > 0 else 0
        return {
            "account_uah": st.account_uah,
            "reinvest_min_uah": st.reinvest_min_uah,
            "affordable_count": n,
        }


class UninvestedCashSensor(OddInvestEntity, BinarySensorEntity):
    """ON = є виплати, які надійшли і не перевкладені."""

    _attr_translation_key = "has_uninvested"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_has_uninvested"

    @property
    def is_on(self) -> bool | None:
        if self._data.state is None:
            return None
        return self._data.state.uninvested_uah > 0

    @property
    def extra_state_attributes(self):
        if self._data.state is None:
            return None
        return {"uninvested_uah": self._data.state.uninvested_uah}


class NPFContributionDueSensor(OddInvestEntity, BinarySensorEntity):
    """ON = внеску в пенсійний за цей місяць ще немає.

    Єдина дія, якої НПФ вимагає від власника, — вчасно внести. Купити його
    «вигідніше» не можна, продати не можна, перевкласти не можна: гроші
    замкнені до пенсійного віку. Тому в застосунку він не стоїть у
    пропозиціях реінвесту (там питання «куди подіти прибулий купон», і
    двадцятип'ятирічний замок на нього не відповідає) — його місце саме тут.

    Самогасне, і стану «я вже бачив» тут немає навмисно. Сервіс питає до
    журналу внесків: щойно зʼявиться внесок за поточний календарний місяць,
    npf_contrib_due стає false. Прапорець «нагадав» довелось би десь
    тримати й якось скидати першого числа — а журнал і є відповіддю.

    PROBLEM, а не звичайний бінарний: пропущений внесок — це не стан
    портфеля, а невиконана дія, і в HA це саме проблема.
    """

    _attr_translation_key = "npf_contribution_due"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_npf_contribution_due"

    @property
    def is_on(self) -> bool | None:
        if self._data.state is None:
            return None
        return self._data.state.npf_contrib_due

    @property
    def extra_state_attributes(self):
        st = self._data.state
        if st is None:
            return None
        # Собівартість поруч із вартістю: у НПФ вони РІЗНІ, на відміну від
        # вкладу чи резерву, тож без пари приросту не побачити.
        return {"npf_uah": st.npf_uah, "npf_cost_uah": st.npf_cost_uah}


class DataStaleSensor(OddInvestEntity, BinarySensorEntity):
    """ON = числа на екрані старіші, ніж мають бути.

    Дві різні відмови під однією сутністю, і це навмисно. Перша: сервіс
    живий і публікує, але довідник НБУ не оновлюється (мережа, зміна
    формату на боці банку) — тоді дохідності рахуються за вчорашніми
    курсами. Друга: сам сервіс перестав публікувати — тоді старіє все.

    Розділяти їх на дві сутності нема сенсу: дія в обох випадках одна —
    піти подивитись, чому. Яка саме відмова, кажуть атрибути.

    Це НЕ те саме, що недоступність. Коли сервіс лягає, LWT робить усі
    сутності unavailable, і це видно й без нас. Тут ловиться протилежне —
    ТИХЕ старіння: усе на місці, все відповідає, просто числа вчорашні.
    """

    _attr_translation_key = "data_stale"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_data_stale"

    def _ages(self):
        st = self._data.state
        now = dt_util.utcnow()
        return st.age_hours(now), st.nbu_age_hours(now)

    @property
    def is_on(self) -> bool | None:
        if self._data.state is None:
            return None
        doc_age, nbu_age = self._ages()
        return any(a is not None and a > STALE_AFTER_H for a in (doc_age, nbu_age))

    @property
    def extra_state_attributes(self):
        if self._data.state is None:
            return None
        doc_age, nbu_age = self._ages()
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


class ReserveReadySensor(OddInvestEntity, BinarySensorEntity):
    """ON = подушку зібрано до заданої цілі.

    БЕЗ device_class: problem, і це навмисно. Решта бінарних сенсорів тут
    кажуть «щось треба зробити»; цей каже протилежне — «те, що збирали,
    зібрано». Одягнений у problem, він світив би червоним саме тоді, коли
    все добре, і мовчав, коли подушки немає, тобто рівно навпаки. Той
    самий випадок, що ReinvestReadySensor вище: можливість, а не хиба.

    unknown, коли цілі резерву немає — див. Reserve.is_ready.

    ПОХІДНЕ, а не поле документа. Сервіс уже надсилає gap_uah і target_uah,
    і завести поруч reserve_ready означало б другу відповідь на те саме
    питання. Прецедент — ConcentrationBreachSensor нижче: він теж
    виводиться з наявних чисел, а не читає готовий прапорець.
    """

    _attr_translation_key = "reserve_ready"

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_reserve_ready"

    @property
    def is_on(self) -> bool | None:
        st = self._data.state
        if st is None or st.reserve is None:
            return None
        return st.reserve.is_ready()

    @property
    def extra_state_attributes(self):
        st = self._data.state
        if st is None or st.reserve is None:
            return None
        r = st.reserve
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


class ConcentrationBreachSensor(OddInvestEntity, BinarySensorEntity):
    """ON = хоча б один заданий ліміт концентрації перевищено.

    Сутність зʼявляється, лише коли ліміти взагалі задані: порожній ліміт
    означає, що вимір не міряють, а не що там стоїть чиясь уява про норму.
    Без жодного ліміта сенсор мовчить (off), а не кричить.
    """

    _attr_translation_key = "concentration_breach"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    # Перелік порушень — це таблиця, і в recorder їй місця немає:
    # документ перевидається на кожну мутацію портфеля.
    _unrecorded_attributes = frozenset({"breaches"})

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_concentration_breach"

    @property
    def is_on(self) -> bool | None:
        if self._data.state is None:
            return None
        return bool(self._data.state.breaches())

    @property
    def extra_state_attributes(self):
        st = self._data.state
        if st is None:
            return None
        return {
            "breaches": [
                {
                    "dimension": c.dimension,
                    "key": c.key,
                    "label": c.label,
                    "share_pct": c.share_pct,
                    "limit_pct": c.limit_pct,
                    "over_uah": c.over_uah,
                }
                for c in st.breaches()
            ]
        }
