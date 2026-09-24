"""Правила сповіщень і календаря — без HA."""

import importlib.util
import pathlib
from datetime import date, datetime, timedelta, timezone

_PATH = pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest" / "rules.py"
_spec = importlib.util.spec_from_file_location("oddinvest_rules", _PATH)
rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rules)


def test_month_key_sent_once_per_month():
    """Ключ із місяцем, надісланий першого числа, стоїть до кінця місяця:
    доти перевірка «надіслано сьогодні» пропускала його щодня."""
    sent = {"npf:2026-09": "2026-09-01"}
    assert rules.already_sent(sent, "npf:2026-09")
    kept = rules.prune_sent(sent, date(2026, 9, 30))
    assert rules.already_sent(kept, "npf:2026-09")
    assert not rules.already_sent(kept, "npf:2026-10")


def test_prune_forgets_old_keys():
    sent = {"coupon:UA1:coupon:2026-07-01": "2026-07-01", "npf:2026-09": "2026-09-01"}
    kept = rules.prune_sent(sent, date(2026, 9, 24))
    assert "coupon:UA1:coupon:2026-07-01" not in kept
    assert "npf:2026-09" in kept


def test_payment_key_carries_type():
    """Купон і погашення одного дня — два повідомлення, а не одне."""
    a = rules.payment_key("coupon", "UA1", "coupon", "2026-09-24")
    b = rules.payment_key("coupon", "UA1", "redemption", "2026-09-24")
    assert a != b


KYIV = timezone(timedelta(hours=3))


def test_day_overlaps_window_ending_midday():
    """Вікно до полудня тієї ж доби подію дня бачить (доти — ні)."""
    start = datetime(2026, 9, 24, 0, 0, tzinfo=KYIV)
    end = datetime(2026, 9, 24, 12, 0, tzinfo=KYIV)
    assert rules.day_overlaps(date(2026, 9, 24), start, end)
    assert not rules.day_overlaps(date(2026, 9, 25), start, end)
    assert not rules.day_overlaps(date(2026, 9, 23), start, end)


def test_day_overlaps_in_local_time():
    """Вікно, задане в UTC близько опівночі, міряється місцевою добою."""
    start_utc = datetime(2026, 9, 23, 22, 0, tzinfo=timezone.utc)  # 01:00 24.09 у Києві
    end_utc = datetime(2026, 9, 24, 21, 0, tzinfo=timezone.utc)  # 00:00 25.09 у Києві
    start, end = start_utc.astimezone(KYIV), end_utc.astimezone(KYIV)
    assert rules.day_overlaps(date(2026, 9, 24), start, end)
    assert not rules.day_overlaps(date(2026, 9, 25), start, end)
