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


def received_action(isin: str, pay_date: str, entry_id: str) -> str:
    """Ідентифікатор кнопки «Отримано» для виплати по isin у день pay_date.

    entry_id — запис інтеграції (портфель), якому належить виплата. Доти
    кнопка його не несла, і натискання розсилалось УСІМ записам: з двома
    портфелями «отримано» лягало й туди, де цієї виплати немає. Запис —
    одразу після префікса через «@»: id записів HA не містять ні «@», ні
    «:», тож розбір лишається однозначним.

    isin може бути синтетичним («deposit:7») — двокрапка всередині
    законна, і саме тому розбір нижче ріже з КІНЦЯ: дата двокрапок не
    містить, а все до неї — isin, скільки б двокрапок у ньому не було.
    """
    return f"{ACTION_RECEIVED}@{entry_id}:{isin}:{pay_date}"


def parse_received(action: str) -> tuple[str, str, str] | None:
    """(entry_id, isin, pay_date) з рядка дії або None, якщо це не наша кнопка.

    entry_id порожній для кнопки старого формату («oi_received:isin:дата»):
    такі сповіщення вже лежать на телефонах, і вони мусять працювати й далі.
    """
    entry = ""
    if action.startswith(ACTION_RECEIVED + "@"):
        entry, sep, body = action[len(ACTION_RECEIVED) + 1 :].partition(":")
        if not sep or not entry:
            return None
    elif action.startswith(ACTION_RECEIVED + ":"):
        body = action[len(ACTION_RECEIVED) + 1 :]
    else:
        return None
    isin, sep, pay_date = body.rpartition(":")
    if not sep or not isin or len(pay_date) != 10:
        return None
    return entry, isin, pay_date


def pick_targets(entry_ids: list[str], wanted: str) -> list[str]:
    """Які записи інтеграції виконують дію.

    Названий — лише він; неназваний — єдиний. Із кількома записами без
    назви — відмова (ValueError), а не розсилка всім: доти refresh і
    mark_payment ішли в кожен запис, і позначка «отримано» лягала в
    портфель, якому ця виплата не належить.
    """
    if wanted:
        if wanted not in entry_ids:
            raise ValueError(f"запису інтеграції {wanted} немає серед завантажених")
        return [wanted]
    if len(entry_ids) > 1:
        raise ValueError("записів інтеграції кілька — вкажи config_entry_id, якому портфелю це")
    return list(entry_ids)


def uri_action(title: str, uri: str) -> dict[str, str]:
    """Кнопка «відкрити»: mobile_app розуміє action=URI з полем uri."""
    return {"action": "URI", "title": title, "uri": uri}
