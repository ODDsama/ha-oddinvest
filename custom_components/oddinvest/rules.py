"""Чисті правила сповіщень і календаря: коли слати, як назвати, що показати.

Вільний від залежностей HA навмисно, як і models.py та actions.py: саме
тут жили дві вади, які без тестів прожили довго, — місячне нагадування,
що стріляло щодня, і календар, що губив подію дня на межі вікна.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

# SENT_KEEP_DAYS — скільки днів журнал надісланого памʼятає ключ. Ключ
# несе свій ПЕРІОД (день, місяць, дату погашення), тож «ключ уже є» і
# означає «у цьому періоді вже надіслано». Тридцять пʼять — щоб місячний
# ключ пережив увесь свій місяць навіть надісланим першого числа.
SENT_KEEP_DAYS = 35


def prune_sent(sent: dict[str, str], today: date) -> dict[str, str]:
    """Журнал без записів, старших за SENT_KEEP_DAYS."""
    cutoff = (today - timedelta(days=SENT_KEEP_DAYS)).isoformat()
    return {k: v for k, v in sent.items() if v >= cutoff}


def payment_key(prefix: str, isin: str, pay_type: str, pay_date: str) -> str:
    """Ключ дедупу виплати: з ТИПОМ.

    Купон і погашення одного паперу приходять одного дня двома рядками, і
    ключ без типу гасив друге повідомлення першим: людина дізнавалась про
    купон, а про повернення тіла — ні.
    """
    return f"{prefix}:{isin}:{pay_type}:{pay_date}"


def prefix_matches_portfolio(prefix: str, portfolio: str) -> bool:
    """Чи дивиться MQTT-префікс на той самий портфель, що й slug для REST.

    Сервіс публікує сателіт під «<prefix>/<slug>» (oddinvestd, main.go), а
    дії шле за X-Portfolio: slug. Запис, де вони розійшлись, показував би
    сенсори одного портфеля, а «Отримано» й «Оновити» відправляв би в
    інший. Порожній slug тут не перевіряється: головний префікс законно
    буває з «/» усередині, і відрізнити його від сателіта нема за чим.
    """
    if not portfolio:
        return True
    return prefix.endswith("/" + portfolio)


def day_overlaps(day: date, start: datetime, end: datetime) -> bool:
    """Чи перетинає вікно [start, end) цілодобову подію дня day.

    start і end — у ЛОКАЛЬНОМУ поясі (dt_util.as_local): подія дня — це
    доба за місцевим годинником. Доти вікно різалось .date() від часу в
    UTC, і вікно, що закінчується в середині дня, відкидало подію цього ж
    дня, а вікно близько опівночі зсувалось на добу.
    """
    tz = start.tzinfo
    lo = datetime(day.year, day.month, day.day, tzinfo=tz)
    hi = lo + timedelta(days=1)
    return lo < end and hi > start
