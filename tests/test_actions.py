"""Дії в сповіщенні: рядок кнопки читається назад без втрат."""

from . import load_module

actions = load_module("actions")


def test_received_round_trip():
    a = actions.received_action("UA4000227748", "2026-07-20", "01JABC")
    assert actions.parse_received(a) == ("01JABC", "UA4000227748", "2026-07-20")


def test_received_keeps_synthetic_isin_with_colon():
    """«deposit:7» — двокрапка всередині isin не ламає розбір: дата ріжеться з кінця."""
    a = actions.received_action("deposit:7", "2026-07-18", "01JABC")
    assert actions.parse_received(a) == ("01JABC", "deposit:7", "2026-07-18")


def test_received_legacy_button_without_entry():
    """Кнопка зі старого сповіщення (до запису в ідентифікаторі) читається й
    далі — із порожнім записом: її вже доставлено на телефон."""
    assert actions.parse_received("oi_received:deposit:7:2026-07-18") == (
        "",
        "deposit:7",
        "2026-07-18",
    )


def test_pick_targets():
    """Дія йде в ОДИН запис: названий, або єдиний. Із кількома без назви —
    помилка, а не розсилка всім (позначка «отримано» в чужому портфелі)."""
    assert actions.pick_targets(["a"], "") == ["a"]
    assert actions.pick_targets(["a", "b"], "b") == ["b"]
    assert actions.pick_targets([], "") == []
    for entries, wanted in ((["a", "b"], ""), (["a"], "zzz")):
        try:
            actions.pick_targets(entries, wanted)
        except ValueError:
            continue
        raise AssertionError(f"pick_targets({entries}, {wanted!r}) мало відмовити")


def test_parse_ignores_foreign_actions():
    assert actions.parse_received("URI") is None
    assert actions.parse_received("oi_received:") is None
    assert actions.parse_received("oi_received:UA4000227748") is None
    assert actions.parse_received("other:UA4000227748:2026-07-20") is None


# ---- заголовки REST: дія з запису другого портфеля мусить іти в ТОЙ портфель


def test_main_portfolio_sends_no_portfolio_header():
    """Порожній slug = головний: сервіс так і поводиться без заголовка."""
    assert actions.rest_headers("", "") == {}
    assert actions.rest_headers("tok", "") == {"Authorization": "Bearer tok"}


def test_other_portfolio_sends_its_slug():
    assert actions.rest_headers("tok", "mmr") == {
        "Authorization": "Bearer tok",
        "X-Portfolio": "mmr",
    }


def test_portfolio_without_token():
    """Сервіс без пароля: токена немає, а портфель однаково мусить дійти."""
    assert actions.rest_headers("", "mmr") == {"X-Portfolio": "mmr"}
