"""Дії в сповіщенні: рядок кнопки читається назад без втрат."""

import importlib.util
import pathlib

_PATH = pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest" / "actions.py"
_spec = importlib.util.spec_from_file_location("oddinvest_actions", _PATH)
actions = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(actions)


def test_received_round_trip():
    a = actions.received_action("UA4000227748", "2026-07-20")
    assert actions.parse_received(a) == ("UA4000227748", "2026-07-20")


def test_received_keeps_synthetic_isin_with_colon():
    """«deposit:7» — двокрапка всередині isin не ламає розбір: дата ріжеться з кінця."""
    a = actions.received_action("deposit:7", "2026-07-18")
    assert actions.parse_received(a) == ("deposit:7", "2026-07-18")


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
