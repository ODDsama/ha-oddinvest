"""Config flow: адреса REST oddinvestd + префікс MQTT-топіків (+ токен і
публічна адреса, коли сервіс закритий паролем і виведений назовні)."""

from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_BASE_URL,
    CONF_PORTFOLIO,
    CONF_TOKEN,
    CONF_TOPIC_PREFIX,
    DEFAULT_PREFIX,
    DOMAIN,
)
from .models import ContractError, StateDoc
from .rest import rest_headers
from .rules import prefix_matches_portfolio


def _schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    """Одна схема на перше налаштування й на переналаштування: поля ті самі,
    різняться лише типові значення."""
    d = defaults or {}
    return vol.Schema(
        {
            vol.Required(CONF_BASE_URL, default=d.get(CONF_BASE_URL, "http://")): str,
            vol.Required(CONF_TOPIC_PREFIX, default=d.get(CONF_TOPIC_PREFIX, DEFAULT_PREFIX)): str,
            # Необовʼязковий і типово порожній: сервіс без пароля працює
            # як досі, і міграції запису не треба — читається через
            # entry.data.get(...). Публічної адреси тут немає: її дає сам
            # сервіс документом стану (const.py).
            vol.Optional(CONF_TOKEN, default=d.get(CONF_TOKEN, "")): str,
            # Порожньо = головний портфель (довід у const.py).
            vol.Optional(CONF_PORTFOLIO, default=d.get(CONF_PORTFOLIO, "")): str,
        }
    )


def _normalize(user_input: dict[str, Any]) -> dict[str, str]:
    return {
        CONF_BASE_URL: user_input[CONF_BASE_URL].rstrip("/"),
        CONF_TOPIC_PREFIX: user_input[CONF_TOPIC_PREFIX].strip().strip("/"),
        CONF_TOKEN: str(user_input.get(CONF_TOKEN, "")).strip(),
        CONF_PORTFOLIO: str(user_input.get(CONF_PORTFOLIO, "")).strip(),
    }


async def _probe(hass, data: dict[str, str]) -> str | None:
    """Чи відповідає сервіс за base_url і чи наш у нього контракт.
    Повертає ключ помилки або None."""
    # Префікс і портфель — ДО мережі: розбіжність видно з самих полів.
    if not prefix_matches_portfolio(data[CONF_TOPIC_PREFIX], data[CONF_PORTFOLIO]):
        return "prefix_mismatch"
    session = async_get_clientsession(hass)
    headers = rest_headers(data[CONF_TOKEN], data[CONF_PORTFOLIO])
    try:
        async with session.get(
            f"{data[CONF_BASE_URL]}/api/summary",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            # 401 окремо від «не зʼєднались»: сервіс є, це токен не той
            # (або його забули), і людині треба саме це, а не «перевір
            # адресу».
            if resp.status == 401:
                return "invalid_auth"
            # Невідомий slug сервіс віддає 404 (і лише після замка) —
            # окремою помилкою, бо «не зʼєднались» тут вело б не туди.
            if resp.status == 404 and data[CONF_PORTFOLIO]:
                return "unknown_portfolio"
            if resp.status != 200:
                return "cannot_connect"
            StateDoc.from_payload(await resp.text())
    except aiohttp.ClientError:
        return "cannot_connect"
    except ContractError:
        return "bad_contract"
    return None


class OddInvestConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return OddInvestOptionsFlow()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            data = _normalize(user_input)
            await self.async_set_unique_id(data[CONF_TOPIC_PREFIX])
            self._abort_if_unique_id_configured()

            err = await _probe(self.hass, data)
            if err:
                errors["base"] = err
            else:
                return self.async_create_entry(
                    title=f"ODD Invest ({data[CONF_TOPIC_PREFIX]})", data=data
                )

        return self.async_show_form(step_id="user", data_schema=_schema(), errors=errors)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Переналаштувати наявний запис — дописати токен чи публічну адресу,
        не видаляючи інтеграцію (з нею зникла б історія сутностей)."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data = _normalize(user_input)
            # Префікс — це unique_id запису; змінити його означало б інший
            # запис. Тут він лише звіряється.
            await self.async_set_unique_id(data[CONF_TOPIC_PREFIX])
            self._abort_if_unique_id_mismatch()
            err = await _probe(self.hass, data)
            if err:
                errors["base"] = err
            else:
                return self.async_update_reload_and_abort(entry, data_updates=data)

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_schema({**entry.data, **(user_input or {})}),
            errors=errors,
        )


class OddInvestOptionsFlow(OptionsFlow):
    """Налаштування сповіщень: notify-сервіс + які події слати."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        o = self.config_entry.options
        notify_services = sorted(self.hass.services.async_services().get("notify", {}))
        schema = vol.Schema(
            {
                vol.Optional(
                    "notify_service", default=o.get("notify_service", "")
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=notify_services,
                        custom_value=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Optional("notify_coupon", default=o.get("notify_coupon", True)): bool,
                vol.Optional("notify_reinvest", default=o.get("notify_reinvest", True)): bool,
                vol.Optional("notify_tomorrow", default=o.get("notify_tomorrow", True)): bool,
                vol.Optional("notify_goal", default=o.get("notify_goal", True)): bool,
                vol.Optional("notify_maturity", default=o.get("notify_maturity", True)): bool,
                vol.Optional("notify_stale", default=o.get("notify_stale", True)): bool,
                vol.Optional(
                    "notify_concentration", default=o.get("notify_concentration", True)
                ): bool,
                vol.Optional("notify_auction", default=o.get("notify_auction", True)): bool,
                vol.Optional(
                    "notify_npf_contribution",
                    default=o.get("notify_npf_contribution", True),
                ): bool,
                # Типово вимкнено: кнопки розуміє лише mobile_app (довід —
                # у alerts._send).
                vol.Optional("notify_actions", default=o.get("notify_actions", False)): bool,
                vol.Optional("notify_card_due", default=o.get("notify_card_due", True)): bool,
                vol.Optional("notify_card_stale", default=o.get("notify_card_stale", True)): bool,
                vol.Optional(
                    "goal_threshold", default=o.get("goal_threshold", 80)
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=0, max=100, step=5, mode=selector.NumberSelectorMode.SLIDER
                    )
                ),
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
