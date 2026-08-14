"""Числові налаштування сервіса як number-сутності.

Значення живе на боці oddinvestd: set -> PUT /api/settings, сервіс
перепубліковує стан у MQTT, звідки прилітає підтверджене значення.
Оптимістичних оновлень нема навмисно — бачиш те, що реально збережено.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from homeassistant.components.number import (
    NumberEntity,
    NumberEntityDescription,
    NumberMode,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry, async_put_setting
from .entity import OddInvestEntity
from .models import Settings


@dataclass(frozen=True, kw_only=True)
class OddInvestNumberDescription(NumberEntityDescription):
    setting_key: str
    value_fn: Callable[[Settings], float | None]
    to_payload: Callable[[float], str] = lambda v: f"{v:g}"


# Тут лише те, що справді МОЖНА задати.
#
# `monthly_target_uah` звідси прибрано: бекенд перестав приймати цей ключ
# (місячний план тепер виводиться з цілі й дедлайну, а не вводиться), тож
# кожен рух повзунка давав 400. Сутність жила далі й показувала порожнє —
# зламана з обох боків. Саме значення нікуди не зникло: воно приходить
# атрибутом target_uah на сенсорі month_invested_uah. Окремої сутності
# під нього немає й не треба — це ПОХІДНЕ число, а сутність, яку не можна
# ні задати, ні використати тригером, лише повторює те, що вже видно.
#
# (Цей коментар довго обіцяв «сенсор „Місячний план“ у sensor.py». Такого
# сенсора не було ніколи — обіцянку виправлено, а не виконано.)
NUMBERS: tuple[OddInvestNumberDescription, ...] = (
    OddInvestNumberDescription(
        key="usd_target_share_pct",
        translation_key="usd_target_share_pct",
        setting_key="usd_target_share_pct",
        native_unit_of_measurement="%",
        mode=NumberMode.SLIDER,
        native_min_value=0,
        native_max_value=100,
        native_step=5,
        value_fn=lambda s: s.usd_target_share_pct,
    ),
    OddInvestNumberDescription(
        key="eur_target_share_pct",
        translation_key="eur_target_share_pct",
        setting_key="eur_target_share_pct",
        native_unit_of_measurement="%",
        mode=NumberMode.SLIDER,
        native_min_value=0,
        native_max_value=100,
        native_step=5,
        value_fn=lambda s: s.eur_target_share_pct,
    ),
    OddInvestNumberDescription(
        key="goal_amount_uah",
        translation_key="goal_amount_uah",
        setting_key="goal_amount_uah",
        native_unit_of_measurement="UAH",
        # BOX, не SLIDER: ціль — це сума, яку вводять, а не підкручують.
        # Повзунок від нуля до мільйонів не має корисного кроку.
        mode=NumberMode.BOX,
        native_min_value=0,
        native_max_value=1_000_000_000,
        native_step=1000,
        value_fn=lambda s: s.goal_amount_uah,
        # Ціль у гривнях — ціле число: копійки в семизначній сумі шум, а
        # "%g" на мільйоні дав би "1e+06", чого бекенд не розбере.
        to_payload=lambda v: f"{int(round(v))}",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_add_entities(OddInvestNumber(data, entry.entry_id, d) for d in NUMBERS)


class OddInvestNumber(OddInvestEntity, NumberEntity):
    entity_description: OddInvestNumberDescription

    def __init__(self, data, entry_id: str, desc: OddInvestNumberDescription) -> None:
        super().__init__(data, entry_id)
        self.entity_description = desc
        self._attr_unique_id = f"{entry_id}_{desc.key}"

    @property
    def native_value(self) -> float | None:
        st = self._data.state
        if st is None or st.settings is None:
            return None
        return self.entity_description.value_fn(st.settings)

    async def async_set_native_value(self, value: float) -> None:
        await async_put_setting(
            self.hass,
            self._data.base_url,
            self.entity_description.setting_key,
            self.entity_description.to_payload(value),
        )
