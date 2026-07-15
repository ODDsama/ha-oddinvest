"""Базовий клас сутностей."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, SIGNAL_AVAILABILITY, SIGNAL_STATE_UPDATED


class OddInvestEntity(Entity):
    """Сутність, що живиться зі спільного OddInvestData через dispatcher."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, data, entry_id: str) -> None:
        self._data = data
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="ODD Invest",
            manufacturer="ODDsama",
            configuration_url=data.base_url,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_STATE_UPDATED, self.async_write_ha_state
            )
        )
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_AVAILABILITY, self.async_write_ha_state
            )
        )

    @property
    def available(self) -> bool:
        return self._data.available and self._data.state is not None
