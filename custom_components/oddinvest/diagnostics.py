"""Діагностика запису: що інтеграція бачить просто зараз.

«Завантажити діагностику» на сторінці інтеграції — єдине місце, де без
журналу видно, чи приходив документ, наскільки він свіжий і чи живий
сервіс. Токен вирізається; сам документ не вивантажується — це весь
фінансовий стан, а файл діагностики пишуть, щоб комусь його показати.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.core import HomeAssistant

from . import OddInvestConfigEntry
from .const import CONF_TOKEN
from .models import SUPPORTED_SCHEMA


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: OddInvestConfigEntry
) -> dict[str, Any]:
    data = entry.runtime_data
    doc = data.state
    return {
        "entry": async_redact_data(dict(entry.data), {CONF_TOKEN}),
        "options": dict(entry.options),
        "supported_schema": SUPPORTED_SCHEMA,
        "service_online": data.available,
        "incompatible_schema": data.incompatible,
        "service_version": doc.app_version if doc is not None else None,
        "has_state": doc is not None,
        "generated_at": doc.generated_at if doc is not None else None,
        "last_update_success": data.last_update_success,
    }
