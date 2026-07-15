"""Config flow: адреса REST oddinvestd + префікс MQTT-топіків."""

from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
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
