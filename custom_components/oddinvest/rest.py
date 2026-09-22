"""Заголовки REST-запитів до oddinvestd.

Окремий модуль без жодних імпортів навмисно — ні Home Assistant, ні
сусідів по пакету: заголовки потрібні і діям (__init__._request), і
перевірці в config flow (_probe), а тест вантажить файл напряму, як
models.py, і мусить перевіряти саме той код, що їде в запит, а не копію.
"""

from __future__ import annotations

# Назва заголовка — з боку сервіса internal/api/hub.go (portfolioHeader).
PORTFOLIO_HEADER = "X-Portfolio"


def rest_headers(token: str, portfolio: str) -> dict[str, str]:
    """Bearer, коли сервіс закритий паролем, і X-Portfolio, коли запис
    дивиться на НЕ головний портфель.

    Без другого заголовка сервіс вважає запит головним. Запис, що читає
    MQTT другого портфеля (префікс «oddinvest/<slug>»), слав би «Отримано»
    й «Оновити» в головний — дія мовчки змінювала б не той портфель, який
    людина бачить у сенсорах.
    """
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if portfolio:
        headers[PORTFOLIO_HEADER] = portfolio
    return headers
