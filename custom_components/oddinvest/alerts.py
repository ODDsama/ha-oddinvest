"""Самостійні сповіщення ODD Invest.

Інтеграція сама шле пуші на обраний notify-сервіс (Telegram, мобільний
застосунок HA тощо) — без ручних автоматизацій. Події оцінюються на
кожен MQTT-апдейт стану і раз на добу; дедуп — щоб не спамити.
"""

from __future__ import annotations

import calendar as _cal
import logging
from datetime import date, timedelta

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store

from .const import DOMAIN, SIGNAL_STATE_UPDATED

_LOGGER = logging.getLogger(__name__)


class NotificationManager:
    def __init__(self, hass: HomeAssistant, entry) -> None:
        self._hass = hass
        self._entry = entry
        self._store = Store(hass, 1, f"{DOMAIN}_notify_{entry.entry_id}")
        self._sent: dict[str, str] = {}
        self._prev_ready: set[str] = set()
        self._unsubs: list = []

    async def async_setup(self) -> None:
        if not self._service:
            return  # сповіщення вимкнено (сервіс не заданий)
        self._sent = await self._store.async_load() or {}
        self._unsubs.append(
            async_dispatcher_connect(self._hass, SIGNAL_STATE_UPDATED, self._on_state)
        )
        self._unsubs.append(
            async_track_time_change(self._hass, self._on_daily, hour=9, minute=5, second=0)
        )

    def async_unload(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()

    @property
    def _service(self) -> str:
        return str(self._entry.options.get("notify_service", "")).strip()

    def _opt(self, key: str, default: bool = True) -> bool:
        return bool(self._entry.options.get(key, default))

    @callback
    def _on_state(self) -> None:
        self._hass.async_create_task(self._evaluate())

    @callback
    def _on_daily(self, now) -> None:
        self._hass.async_create_task(self._evaluate())

    async def _evaluate(self) -> None:
        if not self._service:
            return
        st = self._entry.runtime_data.state
        if st is None:
            return
        today = date.today()
        today_s = today.isoformat()
        tomorrow_s = (today + timedelta(days=1)).isoformat()

        if self._opt("notify_reinvest"):
            ready = {
                c
                for c, m in st.reinvest_min.items()
                if m > 0 and st.accounts.get(c, 0) >= m
            }
            for c in sorted(ready - self._prev_ready):
                bal = st.accounts.get(c, 0)
                await self._send(
                    f"reinvest:{c}:{today_s}",
                    f"💰 На {c}-рахунку вистачає на реінвестицію ({bal:,.0f} {c}).",
                )
            self._prev_ready = ready

        if self._opt("notify_coupon"):
            for p in st.calendar:
                if p.date == today_s:
                    await self._send(
                        f"coupon:{p.isin}:{today_s}",
                        f"📥 Сьогодні виплата: {p.amount:,.0f} {p.currency} по {p.isin}.",
                    )

        if self._opt("notify_tomorrow"):
            for p in st.calendar:
                if p.date == tomorrow_s:
                    await self._send(
                        f"tomorrow:{p.isin}:{tomorrow_s}",
                        f"📅 Завтра виплата: {p.amount:,.0f} {p.currency} по {p.isin}.",
                    )

        if self._opt("notify_goal"):
            last = _cal.monthrange(today.year, today.month)[1]
            threshold = int(self._entry.options.get("goal_threshold", 80))
            if today.day >= last - 5 and st.month_progress_pct < threshold:
                await self._send(
                    f"goal:{today.year}-{today.month}",
                    f"📉 Місячна ціль виконана на {st.month_progress_pct}%. "
                    f"Лишилось {last - today.day} дн.",
                )

    async def _send(self, key: str, message: str) -> None:
        if self._sent.get(key) == date.today().isoformat():
            return
        try:
            await self._hass.services.async_call(
                "notify", self._service, {"message": message}, blocking=False
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("сповіщення через notify.%s не надіслано: %s", self._service, err)
            return
        self._sent[key] = date.today().isoformat()
        cutoff = (date.today() - timedelta(days=2)).isoformat()
        self._sent = {k: v for k, v in self._sent.items() if v >= cutoff}
        await self._store.async_save(self._sent)
