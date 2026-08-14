"""Самостійні сповіщення ODD Invest.

Інтеграція сама шле пуші на обраний notify-сервіс (Telegram, мобільний
застосунок HA тощо) — без ручних автоматизацій. Події оцінюються на
кожен MQTT-апдейт стану і раз на добу; дедуп — щоб не спамити.
"""

from __future__ import annotations

import calendar as _cal
import logging
from datetime import date, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_STATE_UPDATED, STALE_AFTER_H

_LOGGER = logging.getLogger(__name__)

STORE_VERSION = 2


class _NotifyStore(Store):
    """Сховище дедупу зі зміненою формою даних.

    Версія 1 тримала пласку мапу «ключ → дата надсилання». Версія 2
    загортає її в {"sent": ..., "ready": ...}, бо тут зʼявилось друге,
    геть інше за природою: множина валют, на яких реінвест уже був
    можливий минулого разу.
    """

    async def _async_migrate_func(self, old_major_version, old_minor_version, old_data):
        if old_major_version == 1:
            return {"sent": old_data or {}, "ready": [], "auction": ""}
        return old_data


class NotificationManager:
    def __init__(self, hass: HomeAssistant, entry) -> None:
        self._hass = hass
        self._entry = entry
        self._store = _NotifyStore(hass, STORE_VERSION, f"{DOMAIN}_notify_{entry.entry_id}")
        self._sent: dict[str, str] = {}
        # Стан «на що вже вистачало» ПЕРЕЖИВАЄ перезапуск.
        #
        # Симптом був точковий, і саме тому довго лишався непоміченим. Ключ
        # дедупу в _send — "reinvest:{валюта}:{сьогодні}", тож перезапуск у
        # ТОЙ САМИЙ день нічого не дублював. Повторно стріляла ПЕРША оцінка
        # нової доби після перезапуску: у памʼяті множина порожня, різниця
        # ready - _prev_ready дорівнює всій множині, і людина діставала
        # «вистачає на реінвестицію» про гроші, які лежать там тижнями.
        self._prev_ready: set[str] = set()
        # Дата найсвіжішого аукціону, про який уже сповіщали.
        self._last_auction: str = ""
        self._unsubs: list = []

    async def async_setup(self) -> None:
        if not self._service:
            return  # сповіщення вимкнено (сервіс не заданий)
        data = await self._store.async_load() or {}
        self._sent = dict(data.get("sent") or {})
        self._prev_ready = set(data.get("ready") or ())
        self._last_auction = str(data.get("auction") or "")
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
            ready = {c for c, m in st.reinvest_min.items() if m > 0 and st.accounts.get(c, 0) >= m}
            for c in sorted(ready - self._prev_ready):
                bal = st.accounts.get(c, 0)
                await self._send(
                    f"reinvest:{c}:{today_s}",
                    f"💰 На {c}-рахунку вистачає на реінвестицію ({bal:,.0f} {c}).",
                )
            if ready != self._prev_ready:
                self._prev_ready = ready
                await self._persist()

        # p.title() всюди замість p.isin: вклад ходить у розкладі під
        # синтетичним "deposit:7", і сповіщення «виплата по deposit:7»
        # людині не каже нічого. Підпис приходить з документа готовим.
        if self._opt("notify_coupon"):
            for p in st.calendar:
                if p.date == today_s:
                    await self._send(
                        f"coupon:{p.isin}:{today_s}",
                        f"📥 Сьогодні виплата: {p.amount:,.0f} {p.currency} по {p.title()}.",
                    )

        if self._opt("notify_tomorrow"):
            for p in st.calendar:
                if p.date == tomorrow_s:
                    await self._send(
                        f"tomorrow:{p.isin}:{tomorrow_s}",
                        f"📅 Завтра виплата: {p.amount:,.0f} {p.currency} по {p.title()}.",
                    )

        # Погашення — не купон. Купон приходить і йде далі; погашення
        # повертає ТІЛО, і воно або піде за новою ставкою, або ляже
        # мертвим вантажем на рахунку. Сім днів — щоб було коли вибрати,
        # у що перекласти, а не дізнатись постфактум.
        if self._opt("notify_maturity"):
            for p in st.redemptions_within(7, today):
                await self._send(
                    f"maturity:{p.isin}:{p.date}",
                    f"⏳ {p.date}: погашення {p.amount:,.0f} {p.currency} "
                    f"по {p.title()} — час вирішити, куди перекласти.",
                )

        # Тихе старіння. Недоступність сервіса видно й без нас (LWT робить
        # усі сутності unavailable), а це протилежний випадок: усе на
        # місці, все відповідає, просто числа вчорашні.
        if self._opt("notify_stale"):
            now = dt_util.utcnow()
            doc_age, nbu_age = st.age_hours(now), st.nbu_age_hours(now)
            if doc_age is not None and doc_age > STALE_AFTER_H:
                await self._send(
                    f"stale:state:{today_s}",
                    f"🕸 Стан портфеля не оновлювався {doc_age:.0f} год "
                    f"(поріг {STALE_AFTER_H}). Сервіс публікує, але дані стоять.",
                )
            elif nbu_age is not None and nbu_age > STALE_AFTER_H:
                await self._send(
                    f"stale:nbu:{today_s}",
                    f"🕸 Довідник НБУ не оновлювався {nbu_age:.0f} год "
                    f"(поріг {STALE_AFTER_H}). Курси й дохідності рахуються за старими.",
                )

        # Перевищений ліміт нагадує РАЗ НА МІСЯЦЬ, а не щодня: він може
        # бути порушений навмисно й місяцями, і щоденне нагадування про
        # рішення, яке людина вже ухвалила, привчає ігнорувати сповіщення.
        if self._opt("notify_concentration"):
            month = today.strftime("%Y-%m")
            for c in st.breaches():
                await self._send(
                    f"limit:{c.dimension}|{c.key}:{month}",
                    f"⚠ {c.label or c.key}: {c.share_pct:.0f}% при ліміті "
                    f"{c.limit_pct:.0f}% (перебір {c.over_uah:,.0f} ₴).",
                )

        # Аукціон Мінфіну як сигнал до реінвестиції.
        #
        # Формулювання зафіксоване: «розмістив під X%», ніколи «коштує».
        # Це середньозважена ставка ПЕРВИННИХ ДИЛЕРІВ у дилерських обсягах
        # того дня — твердження про ринок, не ціна для тебе й не порада.
        # Порівняння йде з НОМІНАЛЬНОЮ дохідністю портфеля, бо рівень
        # розміщення теж до податку й до знецінення; різницю рахує сервіс.
        if self._opt("notify_auction"):
            offer = st.best_market_offer()
            if offer is not None and offer.date > self._last_auction:
                await self._send(
                    f"auction:{offer.currency}|{offer.bucket}:{offer.date}",
                    f"📈 Мінфін {offer.date} розмістив {offer.bucket} під {offer.pct:.2f}% "
                    f"— на {offer.vs_portfolio_pp:.2f} в.п. вище за твою {offer.currency}.",
                )
                self._last_auction = offer.date
                await self._persist()

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
        # Відсічка стосується ЛИШЕ журналу надісланого. Множина «на що вже
        # вистачало» і дата останнього аукціону віку не мають: вони
        # описують стан, а не подію, і зістарити їх означало б повернути
        # той самий повтор після перезапуску.
        cutoff = (date.today() - timedelta(days=2)).isoformat()
        self._sent = {k: v for k, v in self._sent.items() if v >= cutoff}
        await self._persist()

    async def _persist(self) -> None:
        data: dict[str, Any] = {
            "sent": self._sent,
            "ready": sorted(self._prev_ready),
            "auction": self._last_auction,
        }
        await self._store.async_save(data)
