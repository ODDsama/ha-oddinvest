"""Числові налаштування сервіса як number-сутності.

Значення живе на боці oddinvestd: set -> PUT /api/settings, сервіс
перепубліковує стан у MQTT, звідки прилітає підтверджене значення.
Оптимістичних оновлень нема навмисно — бачиш те, що реально збережено.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from homeassistant.components.number import (
    NumberDeviceClass,
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


NUMBERS: tuple[OddInvestNumberDescription, ...] = (
    OddInvestNumberDescription(
        key="monthly_target_uah",
        translation_key="monthly_target_uah",
        setting_key="monthly_target_uah",
        native_unit_of_measurement="UAH",
        device_class=NumberDeviceClass.MONETARY,
        mode=NumberMode.BOX,
        native_min_value=0,
        native_max_value=10_000_000,
        native_step=100,
        value_fn=lambda s: s.monthly_target_uah,
    ),
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
