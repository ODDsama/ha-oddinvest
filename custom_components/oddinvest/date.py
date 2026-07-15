"""Дата продовження ризикової страховки як date-сутність."""

from __future__ import annotations

from datetime import date

from homeassistant.components.date import DateEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry, async_put_setting
from .entity import OddInvestEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([InsuranceRenewalDate(entry.runtime_data, entry.entry_id)])


class InsuranceRenewalDate(OddInvestEntity, DateEntity):
    _attr_translation_key = "insurance_renewal"

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_insurance_renewal"

    @property
    def native_value(self) -> date | None:
        st = self._data.state
        if st is None or st.settings is None or not st.settings.insurance_renewal:
            return None
        return date.fromisoformat(st.settings.insurance_renewal)

    async def async_set_value(self, value: date) -> None:
        await async_put_setting(
            self.hass, self._data.base_url, "insurance_renewal", value.isoformat()
        )
