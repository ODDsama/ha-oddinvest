"""Дії в сповіщенні: рядок кнопки читається назад без втрат."""

import importlib.util
import pathlib

_PATH = pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest" / "actions.py"
_spec = importlib.util.spec_from_file_location("oddinvest_actions", _PATH)
actions = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(actions)


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


def test_uri_action_shape():
    assert actions.uri_action("Відкрити", "http://x/#/work/buy/main") == {
        "action": "URI",
        "title": "Відкрити",
        "uri": "http://x/#/work/buy/main",
    }
