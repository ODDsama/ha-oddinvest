"""Дії в сповіщенні: як кнопка називає себе і як її потім упізнати.

Вільний від залежностей HA навмисно, як і models.py: розбір рядка дії
тестується без встановленого homeassistant.

Механізм — лише mobile_app. Застосунок HA на телефоні приймає
data.actions[] у notify і, коли людина натискає кнопку, кидає подію
mobile_app_notification_action з полем action. Telegram має інший
механізм (inline_keyboard + telegram_callback), і його тут немає: власник
користується mobile_app, а кнопки для сервісу, яким не користуються,
були б порожнім швом.

ОДНА дія з наслідком — «отримано» для виплати. Решта кнопок — URI, тобто
«відкрити застосунок на потрібному екрані»: задачі сервіса називають ДІЮ,
а не сутність (tasks.js: «бекенд називає дію, веб знає місця»), тож
«розкласти» чи «внести на картку» з кнопки виконати нема чим — там
потрібні числа, які людина вводить сама.
"""

from __future__ import annotations

ACTION_RECEIVED = "oi_received"


def received_action(isin: str, pay_date: str) -> str:
    """Ідентифікатор кнопки «Отримано» для виплати по isin у день pay_date.

    isin може бути синтетичним («deposit:7») — двокрапка всередині
    законна, і саме тому розбір нижче ріже з КІНЦЯ: дата двокрапок не
    містить, а все до неї — isin, скільки б двокрапок у ньому не було.
    """
    return f"{ACTION_RECEIVED}:{isin}:{pay_date}"


def parse_received(action: str) -> tuple[str, str] | None:
    """(isin, pay_date) з рядка дії або None, якщо це не наша кнопка."""
    prefix = ACTION_RECEIVED + ":"
    if not action.startswith(prefix):
        return None
    body = action[len(prefix) :]
    isin, sep, pay_date = body.rpartition(":")
    if not sep or not isin or len(pay_date) != 10:
        return None
    return isin, pay_date


def uri_action(title: str, uri: str) -> dict[str, str]:
    """Кнопка «відкрити»: mobile_app розуміє action=URI з полем uri."""
    return {"action": "URI", "title": title, "uri": uri}
