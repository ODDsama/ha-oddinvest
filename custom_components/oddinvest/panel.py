"""Бічна панель ODD Invest: власний frontend + проксі до REST бекенда.

Панель реєструється в коді (panel_custom) — окремий пункт «ODD Invest» у
меню HA. Її JS-елемент звертається до `/api/oddinvest/*`, а ця в'юшка
форвардить запити в REST `oddinvestd` (той самий, що в config-entry).
Так браузер не ходить у бекенд напряму: немає CORS, адреса бекенда не
світиться, працює HA-авторизація.
"""

from __future__ import annotations

import logging
import pathlib
import time
from http import HTTPStatus

import aiohttp
from aiohttp import web

from homeassistant.components import panel_custom
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "odd-invest"
JS_URL = "/oddinvest_static/oddinvest-panel.js"
_SETUP_FLAG = f"{DOMAIN}_panel_ready"


def _base_url(hass: HomeAssistant) -> str | None:
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is ConfigEntryState.LOADED:
            return entry.runtime_data.base_url
    return None


class OddInvestProxyView(HomeAssistantView):
    """Форвардить /api/oddinvest/<path> у REST бекенда."""

    url = "/api/oddinvest/{path:.*}"
    name = "api:oddinvest"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def _forward(self, request: web.Request, path: str, method: str) -> web.Response:
        base = _base_url(self._hass)
        if base is None:
            return self.json_message(
                "ODD Invest не налаштовано", HTTPStatus.SERVICE_UNAVAILABLE
            )
        session = async_get_clientsession(self._hass)
        url = f"{base}/api/{path}"
        body = await request.read() if method in ("POST", "PUT", "PATCH") else None
        headers = {}
        if "Content-Type" in request.headers:
            headers["Content-Type"] = request.headers["Content-Type"]
        try:
            async with session.request(
                method,
                url,
                params=request.query,
                data=body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                payload = await resp.read()
                return web.Response(
                    body=payload,
                    status=resp.status,
                    content_type=resp.content_type,
                )
        except aiohttp.ClientError as err:
            _LOGGER.warning("проксі до %s не вдалось: %s", url, err)
            return self.json_message(f"бекенд недосяжний: {err}", HTTPStatus.BAD_GATEWAY)

    async def get(self, request: web.Request, path: str) -> web.Response:
        return await self._forward(request, path, "GET")

    async def post(self, request: web.Request, path: str) -> web.Response:
        return await self._forward(request, path, "POST")

    async def put(self, request: web.Request, path: str) -> web.Response:
        return await self._forward(request, path, "PUT")

    async def delete(self, request: web.Request, path: str) -> web.Response:
        return await self._forward(request, path, "DELETE")


async def async_setup_panel(hass: HomeAssistant) -> None:
    """Один раз на процес HA: в'юшка-проксі, статика JS, ресурс, панель."""
    if hass.data.get(_SETUP_FLAG):
        return

    # view і статику реєструємо толерантно — щоб повторна спроба після
    # невдачі не падала на «вже зареєстровано».
    try:
        hass.http.register_view(OddInvestProxyView(hass))
    except Exception:  # noqa: BLE001
        _LOGGER.debug("proxy view вже зареєстрована")

    js_file = pathlib.Path(__file__).parent / "www" / "oddinvest-panel.js"
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(JS_URL, str(js_file), False)]
        )
    except Exception:  # noqa: BLE001
        _LOGGER.debug("static path вже зареєстрований")

    # cache-bust: нова адреса модуля на кожен старт HA
    module_url = f"{JS_URL}?v={int(time.time())}"

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="odd-invest-panel",
        module_url=module_url,
        sidebar_title="ODD Invest",
        sidebar_icon="mdi:chart-box-outline",
        require_admin=False,
        config={},
    )
    hass.data[_SETUP_FLAG] = True
    _LOGGER.info("Панель ODD Invest зареєстрована (/%s)", PANEL_URL_PATH)
