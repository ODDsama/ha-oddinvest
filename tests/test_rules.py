"""Правила сповіщень і календаря — без HA."""

from datetime import date, datetime, timedelta, timezone

from . import load_module

rules = load_module("rules")


def test_month_key_sent_once_per_month():
    """Ключ із місяцем, надісланий першого числа, стоїть до кінця місяця:
    доти перевірка «надіслано сьогодні» пропускала його щодня."""
    sent = {"npf:2026-09": "2026-09-01"}
    kept = rules.prune_sent(sent, date(2026, 9, 30))
    assert "npf:2026-09" in kept
    assert "npf:2026-10" not in kept


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


def test_prefix_matches_portfolio():
    """Сенсори й дії — про той самий портфель."""
    assert rules.prefix_matches_portfolio("oddinvest", "")
    assert rules.prefix_matches_portfolio("home/oddinvest", "")
    assert rules.prefix_matches_portfolio("oddinvest/wife", "wife")
    assert not rules.prefix_matches_portfolio("oddinvest", "wife")
    assert not rules.prefix_matches_portfolio("oddinvest/son", "wife")
