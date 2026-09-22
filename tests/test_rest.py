"""Заголовки REST: дія з запису другого портфеля мусить іти в ТОЙ портфель."""

import importlib.util
import pathlib

_PATH = pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest" / "rest.py"
_spec = importlib.util.spec_from_file_location("oddinvest_rest", _PATH)
rest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rest)


def test_main_portfolio_sends_no_portfolio_header():
    """Порожній slug = головний: сервіс так і поводиться без заголовка."""
    assert rest.rest_headers("", "") == {}
    assert rest.rest_headers("tok", "") == {"Authorization": "Bearer tok"}


def test_other_portfolio_sends_its_slug():
    assert rest.rest_headers("tok", "mmr") == {
        "Authorization": "Bearer tok",
        "X-Portfolio": "mmr",
    }


def test_portfolio_without_token():
    """Сервіс без пароля: токена немає, а портфель однаково мусить дійти."""
    assert rest.rest_headers("", "mmr") == {"X-Portfolio": "mmr"}
