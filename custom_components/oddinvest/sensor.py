"""Сенсори портфеля поверх документа oddinvest/state."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry
from .entity import OddInvestEntity
from .models import StateDoc


@dataclass(frozen=True, kw_only=True)
class OddInvestSensorDescription(SensorEntityDescription):
    value_fn: Callable[[StateDoc], Any]
    attrs_fn: Callable[[StateDoc], dict[str, Any] | None] | None = None


def _next_payment_date(doc: StateDoc) -> date | None:
    if doc.next_payment is None:
        return None
    return date.fromisoformat(doc.next_payment.date)


def _next_payment_attrs(doc: StateDoc) -> dict[str, Any] | None:
    if doc.next_payment is None:
        return None
    p = doc.next_payment
    return {
        "isin": p.isin,
        "type": p.type,
        "amount": p.amount,
        "currency": p.currency,
        "top_payments": [
            {
                "date": t.date,
                "isin": t.isin,
                "type": t.type,
                "amount": t.amount,
                "currency": t.currency,
            }
            for t in doc.top_payments
        ],
    }


def _ladder_attrs(doc: StateDoc) -> dict[str, Any]:
    return {
        "ladder": [
            {"year": r.year, "uah": r.uah, "usd": r.usd, "eur": r.eur}
            for r in doc.ladder
        ]
    }


SENSORS: tuple[OddInvestSensorDescription, ...] = (
    OddInvestSensorDescription(
        key="invested_uah",
        translation_key="invested_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.invested_uah,
    ),
    OddInvestSensorDescription(
        key="nominal_uah_eq",
        translation_key="nominal_uah_eq",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.nominal_uah_eq,
        attrs_fn=_ladder_attrs,
    ),
    OddInvestSensorDescription(
        key="usd_share_pct",
        translation_key="usd_share_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda d: d.usd_share_pct,
    ),
    OddInvestSensorDescription(
        key="eur_share_pct",
        translation_key="eur_share_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda d: d.eur_share_pct,
    ),
    OddInvestSensorDescription(
        key="uninvested_uah",
        translation_key="uninvested_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.uninvested_uah,
    ),
    OddInvestSensorDescription(
        key="account_uah",
        translation_key="account_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.account_uah,
    ),
    OddInvestSensorDescription(
        key="month_invested_uah",
        translation_key="month_invested_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.month_invested_uah,
        attrs_fn=lambda d: {"target_uah": d.month_target_uah},
    ),
    OddInvestSensorDescription(
        key="month_progress_pct",
        translation_key="month_progress_pct",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.month_progress_pct,
    ),
    OddInvestSensorDescription(
        key="month_incoming_uah",
        translation_key="month_incoming_uah",
        native_unit_of_measurement="UAH",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        suggested_display_precision=0,
        value_fn=lambda d: d.month_incoming_uah,
    ),
    OddInvestSensorDescription(
        key="next_payment_date",
        translation_key="next_payment_date",
        device_class=SensorDeviceClass.DATE,
        value_fn=_next_payment_date,
        attrs_fn=_next_payment_attrs,
    ),
    OddInvestSensorDescription(
        key="xirr_uah",
        translation_key="xirr_uah",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.xirr.get("UAH"),
    ),
    OddInvestSensorDescription(
        key="xirr_usd",
        translation_key="xirr_usd",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.xirr.get("USD"),
    ),
    OddInvestSensorDescription(
        key="xirr_eur",
        translation_key="xirr_eur",
        native_unit_of_measurement="%",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=2,
        value_fn=lambda d: d.xirr.get("EUR"),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_add_entities(
        OddInvestSensor(data, entry.entry_id, desc) for desc in SENSORS
    )


class OddInvestSensor(OddInvestEntity, SensorEntity):
    entity_description: OddInvestSensorDescription

    def __init__(self, data, entry_id: str, desc: OddInvestSensorDescription) -> None:
        super().__init__(data, entry_id)
        self.entity_description = desc
        self._attr_unique_id = f"{entry_id}_{desc.key}"

    @property
    def native_value(self):
        if self._data.state is None:
            return None
        return self.entity_description.value_fn(self._data.state)

    @property
    def extra_state_attributes(self):
        if self._data.state is None or self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self._data.state)
