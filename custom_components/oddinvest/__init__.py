"""Інтеграція ODD Invest: стан з MQTT (push), команди через REST."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import aiohttp
from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import Event, HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import (
    ConfigEntryNotReady,
    HomeAssistantError,
    ServiceValidationError,
)
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import (
    CONF_BASE_URL,
    CONF_PORTFOLIO,
    CONF_TOKEN,
    CONF_TOPIC_PREFIX,
    DOMAIN,
    SERVICE_MARK_PAYMENT,
    SERVICE_REFRESH,
    SIGNAL_AVAILABILITY,
    SIGNAL_STATE_UPDATED,
)
from .actions import parse_received, pick_targets, rest_headers
from .alerts import NotificationManager
from .models import ContractError, SchemaMismatch, StateDoc

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor", "binary_sensor", "calendar", "button", "number", "date"]

type OddInvestConfigEntry = ConfigEntry[OddInvestData]


@dataclass
class OddInvestData:
    """Спільний стан інтеграції для всіх платформ."""

    base_url: str
    prefix: str
    # token — Bearer для REST, коли на сервісі стоїть замок; порожньо =
    # без заголовка (сервіс без пароля). Довід у const.py.
    token: str = ""
    # portfolio — slug НЕ головного портфеля; порожньо = головний. Довід —
    # у const.py (CONF_PORTFOLIO).
    portfolio: str = ""
    state: StateDoc | None = None
    available: bool = False
    unsubscribers: list = field(default_factory=list)
    alerts: object | None = None

    @property
    def open_url(self) -> str:
        """Звідки застосунок відкриває ЛЮДИНА.

        Публічна адреса приходить ДОКУМЕНТОМ (settings.public_url): її
        задає сам сервіс, коли власник підключає тунель на сторінці
        «Доступ ззовні». Питати ту саму адресу вдруге, полем інтеграції,
        означало б два джерела однієї правди — і друге лишалось би старим
        рівно тоді, коли адресу міняли. Немає тунелю — лишається локальна
        адреса REST.
        """
        s = self.state.settings if self.state else None
        return (s.public_url if s and s.public_url else "") or self.base_url


async def async_setup_entry(hass: HomeAssistant, entry: OddInvestConfigEntry) -> bool:
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("MQTT-інтеграція недоступна")

    data = OddInvestData(
        base_url=entry.data[CONF_BASE_URL].rstrip("/"),
        prefix=entry.data[CONF_TOPIC_PREFIX],
        token=str(entry.data.get(CONF_TOKEN, "")),
        portfolio=str(entry.data.get(CONF_PORTFOLIO, "")),
    )
    entry.runtime_data = data

    issue_id = f"unsupported_schema_{entry.entry_id}"

    @callback
    def state_received(msg: mqtt.ReceiveMessage) -> None:
        # Порожній retained — сервіс стер стан видаленого портфеля
        # (mqtt.Publisher.Retire). Це не поломка контракту, а кінець
        # портфеля: сутності лишаються недоступними, лог не засмічується.
        if not msg.payload:
            _LOGGER.info("Стан %s стерто сервісом — портфель видалено?", msg.topic)
            return
        try:
            data.state = StateDoc.from_payload(msg.payload)
        except SchemaMismatch as err:
            # У «Ремонти», а не лише в журнал: сутності від цього мовчки
            # замерзають на останньому значенні, і шукати причину в лозі —
            # останнє, що людина здогадається зробити.
            ir.async_create_issue(
                hass,
                DOMAIN,
                issue_id,
                is_fixable=False,
                severity=ir.IssueSeverity.ERROR,
                translation_key="unsupported_schema",
                translation_placeholders={"got": str(err.got), "want": str(err.want)},
            )
            _LOGGER.error("Повідомлення %s не відповідає контракту: %s", msg.topic, err)
            return
        except ContractError as err:
            _LOGGER.error("Повідомлення %s не відповідає контракту: %s", msg.topic, err)
            return
        ir.async_delete_issue(hass, DOMAIN, issue_id)
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


async def _request(
    hass: HomeAssistant,
    data: OddInvestData,
    method: str,
    path: str,
    json_body: dict | None = None,
    timeout_s: int = 120,
) -> None:
    """Запит у REST oddinvestd з нормальними помилками для UI.

    Один на POST і PUT: доти їх було два близнюки, і токен довелося б
    додавати в обидва. 401 названий окремо — «сервіс відповів 401» читалось
    би як його поломка, а це наш токен не той (або сервіс щойно закрили
    паролем, а інтеграцію не переналаштували)."""
    session = async_get_clientsession(hass)
    url = data.base_url + path
    headers = rest_headers(data.token, data.portfolio)
    try:
        async with session.request(
            method,
            url,
            json=json_body,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=timeout_s),
        ) as resp:
            if resp.status == 401:
                raise HomeAssistantError(
                    "oddinvestd не приймає токен: сервіс закритий паролем. "
                    "Візьми токен у застосунку («Налаштування → Доступ ззовні») "
                    "і встав його в «Переналаштувати» цієї інтеграції"
                )
            if resp.status >= 400:
                body = await resp.text()
                raise HomeAssistantError(f"oddinvestd відповів {resp.status}: {body[:200]}")
    except aiohttp.ClientError as err:
        raise HomeAssistantError(f"Не досягли oddinvestd за {url}: {err}") from err


async def async_refresh_service(hass: HomeAssistant, data: OddInvestData) -> None:
    await _request(hass, data, "POST", "/api/refresh")


async def _mark_payment(hass: HomeAssistant, data: OddInvestData, body: dict) -> None:
    await _request(hass, data, "POST", "/api/payments/status", json_body=body, timeout_s=30)


async def async_put_setting(hass: HomeAssistant, data: OddInvestData, key: str, value: str) -> None:
    """PUT одного налаштування; сервіс сам перепублікує стан у MQTT."""
    await _request(hass, data, "PUT", "/api/settings", json_body={key: value}, timeout_s=30)


def _loaded_entries(hass: HomeAssistant) -> list[OddInvestConfigEntry]:
    return [
        e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED
    ]


def _targets(hass: HomeAssistant, wanted: str) -> list[OddInvestConfigEntry]:
    """Записи, які виконують дію сервісу: названий або єдиний.

    Доти дія йшла в УСІ завантажені записи: з двома портфелями mark_payment
    ставив «отримано» й туди, де цієї виплати немає. Правило — у
    actions.pick_targets (тестується без HA); тут лише переклад помилки в
    ту, яку HA покаже людині біля виклику.
    """
    loaded = {e.entry_id: e for e in _loaded_entries(hass)}
    try:
        ids = pick_targets(list(loaded), wanted)
    except ValueError as err:
        raise ServiceValidationError(str(err)) from err
    return [loaded[i] for i in ids]


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_REFRESH):
        return

    async def handle_refresh(call: ServiceCall) -> None:
        """oddinvest.refresh — оновити довідник НБУ і курс на боці сервіса."""
        for entry in _targets(hass, str(call.data.get("config_entry_id", ""))):
            await async_refresh_service(hass, entry.runtime_data)

    async def handle_mark_payment(call: ServiceCall) -> None:
        """oddinvest.mark_payment — позначити виплату отриманою (received)
        або зняти позначку (none).

        Статусу «reinvested» більше немає: сервіс скасував його міграцією
        0017 і від того часу відповідає на нього помилкою. Аргумент
        записаний у самій міграції, коротко — купон на 82 ₴ не купує
        нічого, тож у покупку він потрапляє змішаним із власними
        внесками, і простій тепер рахується сам."""
        body = {
            "isin": call.data["isin"],
            "pay_date": str(call.data["pay_date"]),
            "status": call.data["status"],
        }
        for entry in _targets(hass, str(call.data.get("config_entry_id", ""))):
            await _mark_payment(hass, entry.runtime_data, body)

    hass.services.async_register(DOMAIN, SERVICE_REFRESH, handle_refresh)
    hass.services.async_register(DOMAIN, SERVICE_MARK_PAYMENT, handle_mark_payment)

    async def handle_notification_action(event: Event) -> None:
        """Кнопка в сповіщенні mobile_app — та сама ручка, що mark_payment.

        Слухач один на домен (реєструється разом із сервісами) і чужі
        кнопки пропускає мовчки: подія спільна для всіх інтеграцій, і
        сюди прилітає кожна натиснута кнопка кожного застосунку. Своя
        впізнається за префіксом (actions.py); URI-кнопки подію не
        кидають узагалі — їх обробляє сам застосунок HA.
        """
        parsed = parse_received(str(event.data.get("action", "")))
        if parsed is None:
            return
        entry_id, isin, pay_date = parsed
        body = {"isin": isin, "pay_date": pay_date, "status": "received"}
        # Кнопка несе свій запис — і йде лише в нього. Кнопка старого
        # формату (без запису) вже лежить на телефонах: вона, як і доти,
        # іде в усі записи — інакше натискання мовчки не робило б нічого.
        entries = _loaded_entries(hass)
        if entry_id:
            entries = [e for e in entries if e.entry_id == entry_id]
        for entry in entries:
            try:
                await _mark_payment(hass, entry.runtime_data, body)
            except HomeAssistantError as err:
                # Кнопка — не сервіс: помилку нема кому показати, крім журналу.
                _LOGGER.warning("«Отримано» по %s за %s не записано: %s", isin, pay_date, err)

    hass.bus.async_listen("mobile_app_notification_action", handle_notification_action)
