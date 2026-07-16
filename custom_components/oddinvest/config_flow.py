"""Config flow: адреса REST oddinvestd + префікс MQTT-топіків."""

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

from .const import CONF_BASE_URL, CONF_TOPIC_PREFIX, DEFAULT_PREFIX, DOMAIN
from .models import ContractError, StateDoc

DATA_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_BASE_URL, default="http://"): str,
        vol.Required(CONF_TOPIC_PREFIX, default=DEFAULT_PREFIX): str,
    }
)


class OddInvestConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return OddInvestOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            base = user_input[CONF_BASE_URL].rstrip("/")
            prefix = user_input[CONF_TOPIC_PREFIX].strip().strip("/")
            await self.async_set_unique_id(prefix)
            self._abort_if_unique_id_configured()

            session = async_get_clientsession(self.hass)
            try:
                async with session.get(
                    f"{base}/api/summary", timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status != 200:
                        errors["base"] = "cannot_connect"
                    else:
                        StateDoc.from_payload(await resp.text())
            except aiohttp.ClientError:
                errors["base"] = "cannot_connect"
            except ContractError:
                errors["base"] = "bad_contract"

            if not errors:
                return self.async_create_entry(
                    title=f"ODD Invest ({prefix})",
                    data={CONF_BASE_URL: base, CONF_TOPIC_PREFIX: prefix},
                )

        return self.async_show_form(
            step_id="user", data_schema=DATA_SCHEMA, errors=errors
        )


class OddInvestOptionsFlow(OptionsFlow):
    """Налаштування сповіщень: notify-сервіс + які події слати."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
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
