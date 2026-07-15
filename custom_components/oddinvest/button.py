"""Кнопка «Оновити дані» — той самий ефект, що сервіс oddinvest.refresh."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry, async_refresh_service
from .entity import OddInvestEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([RefreshButton(entry.runtime_data, entry.entry_id)])


class RefreshButton(OddInvestEntity, ButtonEntity):
    _attr_translation_key = "refresh"

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_refresh"

    @property
    def available(self) -> bool:  # кнопка живе, поки живий REST, не MQTT
        return True

    async def async_press(self) -> None:
        await async_refresh_service(self.hass, self._data.base_url)
