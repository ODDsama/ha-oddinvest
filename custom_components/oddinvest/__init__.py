"""Інтеграція ODD Invest: стан з MQTT (push), команди через REST."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import aiohttp
from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import (
    CONF_BASE_URL,
    CONF_TOPIC_PREFIX,
    DOMAIN,
    SERVICE_MARK_PAYMENT,
    SERVICE_REFRESH,
    SIGNAL_AVAILABILITY,
    SIGNAL_STATE_UPDATED,
)
from .alerts import NotificationManager
from .models import ContractError, StateDoc
from .panel import async_setup_panel

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor", "binary_sensor", "calendar", "button", "number"]

type OddInvestConfigEntry = ConfigEntry[OddInvestData]


@dataclass
class OddInvestData:
    """Спільний стан інтеграції для всіх платформ."""

    base_url: str
    prefix: str
    state: StateDoc | None = None
    available: bool = False
    unsubscribers: list = field(default_factory=list)
    alerts: object | None = None


async def async_setup_entry(hass: HomeAssistant, entry: OddInvestConfigEntry) -> bool:
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("MQTT-інтеграція недоступна")

    data = OddInvestData(
        base_url=entry.data[CONF_BASE_URL].rstrip("/"),
        prefix=entry.data[CONF_TOPIC_PREFIX],
    )
    entry.runtime_data = data

    @callback
    def state_received(msg: mqtt.ReceiveMessage) -> None:
        try:
            data.state = StateDoc.from_payload(msg.payload)
        except ContractError as err:
            _LOGGER.error("Повідомлення %s не відповідає контракту: %s", msg.topic, err)
            return
        async_dispatcher_send(hass, SIGNAL_STATE_UPDATED)

    @callback
    def availability_received(msg: mqtt.ReceiveMessage) -> None:
        data.available = msg.payload == "online"
        async_dispatcher_send(hass, SIGNAL_AVAILABILITY)

    # retained-повідомлення прилетять одразу після підписки
    data.unsubscribers.append(
        await mqtt.async_subscribe(hass, f"{data.prefix}/state", state_received, qos=1)
    )
    data.unsubscribers.append(
        await mqtt.async_subscribe(
            hass, f"{data.prefix}/availability", availability_received, qos=1
        )
    )

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _register_services(hass)
    await async_setup_panel(hass)

    data.alerts = NotificationManager(hass, entry)
    await data.alerts.async_setup()
    entry.async_on_unload(entry.add_update_listener(_options_updated))
    return True


async def _options_updated(hass: HomeAssistant, entry: OddInvestConfigEntry) -> None:
    """Зміна опцій (сповіщення) → перезавантажити запис."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: OddInvestConfigEntry) -> bool:
    if entry.runtime_data.alerts is not None:
        entry.runtime_data.alerts.async_unload()
    for unsub in entry.runtime_data.unsubscribers:
        unsub()
    entry.runtime_data.unsubscribers.clear()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _post(hass: HomeAssistant, url: str, json_body: dict | None = None,
                timeout_s: int = 120) -> None:
    """POST у REST oddinvestd з нормальними помилками для UI."""
    session = async_get_clientsession(hass)
    try:
        async with session.post(
            url, json=json_body, timeout=aiohttp.ClientTimeout(total=timeout_s)
        ) as resp:
            if resp.status >= 400:
                body = await resp.text()
                raise HomeAssistantError(f"oddinvestd відповів {resp.status}: {body[:200]}")
    except aiohttp.ClientError as err:
        raise HomeAssistantError(f"Не досягли oddinvestd за {url}: {err}") from err


async def async_refresh_service(hass: HomeAssistant, base_url: str) -> None:
    await _post(hass, base_url + "/api/refresh")


async def async_put_setting(hass: HomeAssistant, base_url: str, key: str, value: str) -> None:
    """PUT одного налаштування; сервіс сам перепублікує стан у MQTT."""
    session = async_get_clientsession(hass)
    url = base_url + "/api/settings"
    try:
        async with session.put(
            url, json={key: value}, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            if resp.status >= 400:
                body = await resp.text()
                raise HomeAssistantError(f"oddinvestd відповів {resp.status}: {body[:200]}")
    except aiohttp.ClientError as err:
        raise HomeAssistantError(f"Не досягли oddinvestd за {url}: {err}") from err


def _loaded_entries(hass: HomeAssistant) -> list[OddInvestConfigEntry]:
    return [
        e
        for e in hass.config_entries.async_entries(DOMAIN)
        if e.state is ConfigEntryState.LOADED
    ]


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_REFRESH):
        return

    async def handle_refresh(call: ServiceCall) -> None:
        """oddinvest.refresh — оновити довідник НБУ і курс на боці сервіса."""
        for entry in _loaded_entries(hass):
            await async_refresh_service(hass, entry.runtime_data.base_url)

    async def handle_mark_payment(call: ServiceCall) -> None:
        """oddinvest.mark_payment — позначити виплату received/reinvested,
        або зняти позначку (status=none)."""
        body = {
            "isin": call.data["isin"],
            "pay_date": str(call.data["pay_date"]),
            "status": call.data["status"],
        }
        for entry in _loaded_entries(hass):
            await _post(
                hass,
                entry.runtime_data.base_url + "/api/payments/status",
                json_body=body,
                timeout_s=30,
            )

    hass.services.async_register(DOMAIN, SERVICE_REFRESH, handle_refresh)
    hass.services.async_register(DOMAIN, SERVICE_MARK_PAYMENT, handle_mark_payment)
