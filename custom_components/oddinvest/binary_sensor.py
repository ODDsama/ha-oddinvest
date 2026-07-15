"""Бінарні сенсори портфеля."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry
from .entity import OddInvestEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([UninvestedCashSensor(entry.runtime_data, entry.entry_id)])


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
