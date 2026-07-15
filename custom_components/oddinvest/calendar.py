"""Календар майбутніх виплат портфеля (з поля calendar документа стану)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry
from .entity import OddInvestEntity
from .models import PaymentRow

TYPE_NAMES = {"coupon": "Купон", "redemption": "Погашення", "early": "Дострокове погашення"}


def _to_event(row: PaymentRow) -> CalendarEvent:
    d = date.fromisoformat(row.date)
    kind = TYPE_NAMES.get(row.type, row.type)
    return CalendarEvent(
        start=d,
        end=d + timedelta(days=1),  # all-day
        summary=f"{kind} {row.amount:,.2f} {row.currency}".replace(",", " "),
        description=f"ISIN: {row.isin}",
        uid=f"{row.isin}_{row.date}_{row.type}",
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([OddInvestCalendar(entry.runtime_data, entry.entry_id)])


class OddInvestCalendar(OddInvestEntity, CalendarEntity):
    _attr_translation_key = "payments"

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_payments_calendar"

    @property
    def event(self) -> CalendarEvent | None:
        """Найближча виплата."""
        if self._data.state is None or not self._data.state.calendar:
            return None
        today = date.today().isoformat()
        for row in self._data.state.calendar:
            if row.date >= today:
                return _to_event(row)
        return None

    async def async_get_events(
        self, hass: HomeAssistant, start_date: datetime, end_date: datetime
    ) -> list[CalendarEvent]:
        if self._data.state is None:
            return []
        lo, hi = start_date.date(), end_date.date()
        return [
            _to_event(row)
            for row in self._data.state.calendar
            if lo <= date.fromisoformat(row.date) < hi
        ]
