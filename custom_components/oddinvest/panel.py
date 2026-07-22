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

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "odd-invest"
# Під цим префіксом монтується каталог www/ — з версією між ним і файлом:
# /oddinvest_static/<version>/oddinvest-panel.js
#                            /shared/js/app.js
#                            /shared/css/base.css
STATIC_BASE = "/oddinvest_static"
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


def _www_version(www_dir: pathlib.Path) -> int:
    """Найсвіжіший mtime серед файлів панелі.

    Саме серед УСІХ, а не лише самого oddinvest-panel.js: він тепер лише
    тонкий адаптер, а весь застосунок лежить у www/shared/. Версія за
    одним файлом не змінювалась би при оновленні спільного коду — тобто
    рівно тоді, коли змінюється майже все.
    """
    newest = 0
    try:
        for path in www_dir.rglob("*"):
            if path.is_file():
                newest = max(newest, int(path.stat().st_mtime))
    except OSError:
        pass
    return newest or int(time.time())


async def async_setup_panel(hass: HomeAssistant) -> None:
    """В'юшка-проксі, статика панелі й сама панель.

    Cache-bust — версійним ПРЕФІКСОМ шляху, а не параметром `?v=`.
    Раніше вистачало параметра, бо файл був один. Тепер панель — це дерево
    ES-модулів, які тягнуть одне одного відносними шляхами
    (`./shared/js/app.js`), а відносний імпорт запит-параметр не успадковує:
    сам вхідний файл приїхав би свіжий, а всі його імпорти — зі старого
    кешу. Версія в префіксі змінює адресу цілому дереву разом.
    """
    www_dir = pathlib.Path(__file__).parent / "www"
    version = _www_version(www_dir)
    static_root = f"{STATIC_BASE}/{version}"
    module_url = f"{static_root}/oddinvest-panel.js"

    if hass.data.get(_SETUP_FLAG) == module_url:
        return  # нічого не змінилось — перереєстрація нічого не дасть

    # view і статику реєструємо толерантно — щоб повторна спроба після
    # невдачі не падала на «вже зареєстровано».
    try:
        hass.http.register_view(OddInvestProxyView(hass))
    except Exception:  # noqa: BLE001
        _LOGGER.debug("proxy view вже зареєстрована")

    # Каталог, а не файл: під цим префіксом мають віддаватись і сам
    # адаптер, і все дерево shared/ (js/ та css/).
    #
    # Помилку не ковтаємо мовчки. Раніше сюди потрапляла хіба що повторна
    # реєстрація того самого шляху, і debug-рядка вистачало. Тепер від цієї
    # реєстрації залежить УВЕСЬ застосунок: якщо каталог не змонтувався,
    # браузер отримає 404 на ./shared/js/app.js, і панель буде просто
    # порожньою — без сліду в логах, за яким це можна знайти.
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(static_root, str(www_dir), False)]
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "не вдалось змонтувати %s -> %s: %s. Якщо панель порожня — причина тут",
            static_root, www_dir, err,
        )

    # Панель уже могла бути зареєстрована зі старою адресою — знімаємо,
    # інакше async_register_panel впаде на дублікаті.
    if hass.data.get(_SETUP_FLAG):
        try:
            frontend.async_remove_panel(hass, PANEL_URL_PATH)
        except Exception:  # noqa: BLE001
            _LOGGER.debug("панель не була зареєстрована")

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
    hass.data[_SETUP_FLAG] = module_url
    _LOGGER.info("Панель ODD Invest зареєстрована (/%s, v=%s)", PANEL_URL_PATH, version)
