"""Парсер контракту oddinvest/state.

Чистий Python без залежностей від Home Assistant — саме цей модуль
тестується проти фікстур з contract/ репозиторію oddinvest
(рішення №5 концепції: contract-тести через фікстури).

Правила читання контракту:
- schema перевіряється строго (підтримуємо лише відому мажорну версію);
- невідомі ПОЛЯ ігноруються (еволюція «тільки додавання» на боці
  сервіса не має ламати стару інтеграцію).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

SUPPORTED_SCHEMA = 1


class ContractError(ValueError):
    """Документ стану не відповідає контракту."""


@dataclass(frozen=True)
class NextPayment:
    date: str
    isin: str
    type: str
    amount: float
    currency: str


@dataclass(frozen=True)
class LadderRow:
    year: int
    uah: float
    usd: float


@dataclass(frozen=True)
class PaymentRow:
    date: str
    isin: str
    type: str
    amount: float
    currency: str


@dataclass(frozen=True)
class Settings:
    monthly_target_uah: float | None = None
    usd_target_share_pct: float | None = None
    eur_target_share_pct: float | None = None
    insurance_renewal: str | None = None
    insurance_premium_uah: float | None = None


@dataclass(frozen=True)
class StateDoc:
    schema: int
    generated_at: str
    invested_uah: float
    nominal_uah_eq: float
    usd_share_pct: float
    uninvested_uah: float
    month_invested_uah: float
    month_target_uah: float
    month_progress_pct: int
    month_incoming_uah: float
    next_payment: NextPayment | None = None
    insurance_days_left: int | None = None
    ladder: tuple[LadderRow, ...] = field(default_factory=tuple)
    top_payments: tuple[PaymentRow, ...] = field(default_factory=tuple)
    # v0.2+ сервіса; за старого сервіса 0.1 — порожній
    calendar: tuple[PaymentRow, ...] = field(default_factory=tuple)
    # v0.3+: сирі налаштування сервіса (для number/date-сутностей)
    settings: Settings | None = None
    # v1.0+: річний XIRR по валютах, %; порожній dict = нерахований
    xirr: dict[str, float] = field(default_factory=dict)

    REQUIRED = (
        "schema",
        "generated_at",
        "invested_uah",
        "nominal_uah_eq",
        "usd_share_pct",
        "uninvested_uah",
        "month_invested_uah",
        "month_target_uah",
        "month_progress_pct",
        "month_incoming_uah",
        "ladder",
        "top_payments",
    )

    @classmethod
    def from_payload(cls, payload: str | bytes) -> "StateDoc":
        try:
            raw: dict[str, Any] = json.loads(payload)
        except (json.JSONDecodeError, TypeError) as err:
            raise ContractError(f"невалідний JSON: {err}") from err
        if not isinstance(raw, dict):
            raise ContractError("очікували JSON-об'єкт")

        missing = [k for k in cls.REQUIRED if k not in raw]
        if missing:
            raise ContractError(f"відсутні обов'язкові поля: {missing}")

        schema = raw["schema"]
        if schema != SUPPORTED_SCHEMA:
            raise ContractError(
                f"непідтримувана версія контракту schema={schema}, "
                f"інтеграція розуміє {SUPPORTED_SCHEMA}"
            )

        np = None
        if raw.get("next_payment"):
            p = raw["next_payment"]
            np = NextPayment(
                date=str(p["date"]),
                isin=str(p["isin"]),
                type=str(p["type"]),
                amount=float(p["amount"]),
                currency=str(p["currency"]),
            )

        ins = raw.get("insurance_days_left")

        return cls(
            schema=int(schema),
            generated_at=str(raw["generated_at"]),
            invested_uah=float(raw["invested_uah"]),
            nominal_uah_eq=float(raw["nominal_uah_eq"]),
            usd_share_pct=float(raw["usd_share_pct"]),
            uninvested_uah=float(raw["uninvested_uah"]),
            month_invested_uah=float(raw["month_invested_uah"]),
            month_target_uah=float(raw["month_target_uah"]),
            month_progress_pct=int(raw["month_progress_pct"]),
            month_incoming_uah=float(raw["month_incoming_uah"]),
            next_payment=np,
            insurance_days_left=int(ins) if ins is not None else None,
            ladder=tuple(
                LadderRow(year=int(r["year"]), uah=float(r["uah"]), usd=float(r["usd"]))
                for r in raw["ladder"]
            ),
            top_payments=tuple(
                _payment_row(p) for p in raw["top_payments"]
            ),
            calendar=tuple(
                _payment_row(p) for p in raw.get("calendar", ())
            ),
            settings=_settings(raw.get("settings")),
            xirr={str(k): float(v) for k, v in (raw.get("xirr") or {}).items()},
        )


def _settings(raw: dict[str, Any] | None) -> Settings | None:
    if not raw:
        return None

    def num(key: str) -> float | None:
        v = raw.get(key)
        return float(v) if v is not None else None

    ins = raw.get("insurance_renewal")
    return Settings(
        monthly_target_uah=num("monthly_target_uah"),
        usd_target_share_pct=num("usd_target_share_pct"),
        eur_target_share_pct=num("eur_target_share_pct"),
        insurance_renewal=str(ins) if ins else None,
        insurance_premium_uah=num("insurance_premium_uah"),
    )


def _payment_row(p: dict[str, Any]) -> PaymentRow:
    return PaymentRow(
        date=str(p["date"]),
        isin=str(p["isin"]),
        type=str(p["type"]),
        amount=float(p["amount"]),
        currency=str(p["currency"]),
    )
