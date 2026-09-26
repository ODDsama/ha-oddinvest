"""Базовий клас сутностей."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN


class OddInvestEntity(CoordinatorEntity):
    """Сутність, що живиться зі спільного координатора OddInvestData."""

    _attr_has_entity_name = True

    def __init__(self, data, entry_id: str, key: str) -> None:
        super().__init__(data)
        self._data = data
        self._attr_unique_id = f"{entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="ODD Invest",
            manufacturer="ODDsama",
            # Посилання з картки пристрою відкриває людина — тож публічна
            # адреса, якщо сервіс її вже знає (OddInvestData.open_url).
            #
            # Читається ОДИН раз, при створенні сутності: HA не оновлює
            # DeviceInfo сам. Тобто адреса, яка зʼявилась після підключення
            # тунелю, дійде сюди після перезавантаження запису — а от
            # посилання у сповіщеннях (alerts._open) беруть її щоразу.
            configuration_url=data.open_url,
        )

    @property
    def available(self) -> bool:
        return self._data.available and self._data.state is not None
