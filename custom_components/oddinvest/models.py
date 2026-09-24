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
from dataclasses import dataclass, field, fields
from datetime import date, datetime, timedelta
from typing import Any

# 2 (2026-09-07): із документа ЗНИКЛИ поля, а не додались.
#
# Контракт дозволяє лише додавання, тож видалення йде разом з інкрементом
# мажорної версії — саме для того, щоб інтеграція побачила це явно, а не
# дізналась із мовчазного нуля. Прибрані month_plan.plan_debt_uah і
# settings.debt_fill_from: дострокове погашення боргу більше не забирає
# портфельних грошей, тож числа «скільки з плану дозволено боргу» не буває.
#
# Читачів у цих полів тут не було (debt_uah у CardState — це використаний
# ліміт КАРТКИ, інше поле), тож розбір нижче не змінився ніяк.
#
# ОЗНАЧЕННЯ ТУТ ОДНЕ, і це не випадковість. Дубль жив у const.py і тихо
# розійшовся: інкремент 1 → 2 зробили тут, а там лишилась одиниця. Обійшлось
# лише тому, що імпортерів у дубля не було. Межа контракту звіряється в
# одному місці (from_payload нижче), тож і число мусить бути одне —
# наступний, кому знадобиться схема, імпортує звідси.
# 3 (2026-09-10): усі грошові поля документа — у валюті поля currency
# (валюта звітності, settings.report_currency на сервісі): гривня, долар чи
# євро. Суфікс _uah у назвах лишився історичним; сенс задає currency, і
# саме звідти сенсори беруть одиницю. Поля лише для гривні (реальна
# дохідність, ІСЦ, цілі «у майбутніх грошах») при валюті ≠ UAH можуть
# бути порожніми.
SUPPORTED_SCHEMA = 3

# Книжкова валюта: у ній сервіс веде облік і в ній документ приходить, поки
# валюти звітності не задано. Символи — для прози сповіщень.
BOOK_CURRENCY = "UAH"
CURRENCY_SYMBOL = {"UAH": "₴", "USD": "$", "EUR": "€"}


def _age_hours(stamp: str, now: datetime) -> float | None:
    """Вік мітки часу RFC3339 у годинах. None, якщо мітки немає.

    None і 0 тут різні речі: перше означає «сервіс такого не надсилає»
    (старіша версія), друге — «щойно оновлено». Плутати їх означало б
    тихо вважати старий сервіс завжди свіжим.
    """
    if not stamp:
        return None
    try:
        t = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=now.tzinfo)
    return (now - t).total_seconds() / 3600


class ContractError(ValueError):
    """Документ стану не відповідає контракту."""


class SchemaMismatch(ContractError):
    """Сервіс говорить іншою версією контракту.

    Окремий тип, бо лікується інакше за будь-яку іншу поломку документа:
    не правкою даних, а оновленням одного з двох боків. __init__ перетворює
    його на запис у «Ремонтах» Home Assistant — інакше сутності мовчки
    замерзали на останньому значенні, а причина жила рядком у журналі.
    """

    def __init__(self, got: object, want: int) -> None:
        super().__init__(f"непідтримувана версія контракту schema={got}, інтеграція розуміє {want}")
        self.got = got
        self.want = want


@dataclass(frozen=True)
class NextPayment:
    date: str
    isin: str
    type: str
    amount: float
    currency: str
    # label — людська назва, коли ISIN мовчить: «вклад» для синтетичного
    # "deposit:<id>". Правило живе в сервісі й приходить готовим — доти
    # воно було записане у фронтенді, і сповіщення тут написали б його
    # втретє, третьою мовою.
    label: str = ""


@dataclass(frozen=True)
class LadderRow:
    year: int
    uah: float
    usd: float
    eur: float = 0.0


@dataclass(frozen=True)
class PaymentRow:
    date: str
    isin: str
    type: str
    amount: float
    currency: str
    label: str = ""  # див. NextPayment.label

    def title(self) -> str:
        """Як називати цей рядок людині."""
        return self.label or self.isin


@dataclass(frozen=True)
class Independence:
    """Коли портфель почне утримувати сам себе.

    plan_* — за плановим внеском, actual_* — за фактичним темпом
    поповнень. plan_months == -1 означає «дохід уже покриває», 0 — «не
    досягається за 60 років»; дата в обох випадках порожня.
    """

    target_uah: float = 0.0
    income_now_uah: float = 0.0
    target_from: str = ""
    plan_months: int = 0
    plan_date: str = ""
    actual_months: int = 0
    actual_date: str = ""


@dataclass(frozen=True)
class Liquidity:
    """Коли гроші стають доступні — питання не про дохідність.

    reserve_uah окремо від now_uah навмисно: на боці сервіса на цьому
    тримається інваріант now_uah == account_uah.
    """

    now_uah: float = 0.0
    in_30_uah: float = 0.0
    in_90_uah: float = 0.0
    reserve_uah: float = 0.0
    # goals_uah — гроші під цілями накопичення. Так само окремо від
    # now_uah і так само не в locked_uah: ламати нічого не треба, вони
    # просто чекають своєї дати.
    goals_uah: float = 0.0
    locked_uah: float = 0.0
    unlock_date: str = ""
    # locked_npf_uah — скільки із замкненого сидить у НПФ. Підполе, а не
    # додаток: unlock_date бере НАЙБЛИЖЧУ дату, тобто вклад, тож без цього
    # числа «замкнено X, розблокується <дата>» читалось би як правда про
    # гроші, недоступні ще двадцять п'ять років.
    locked_npf_uah: float = 0.0


@dataclass(frozen=True)
class Reserve:
    """Матрац: скільки відкладено й на скільки місяців життя цього стане."""

    uah: float = 0.0
    share_pct: float = 0.0
    months: float = 0.0
    target_months: float = 0.0
    target_uah: float = 0.0
    gap_uah: float = 0.0
    monthly_expenses_uah: float = 0.0

    def is_ready(self) -> bool | None:
        """Чи зібрано подушку. None = цілі немає, тобто питання не ставили.

        Три стани, а не два, і середній тут головний. Ціль резерву задають
        не всі: без неї «зібрано» ні з чим порівнювати, і False сказало б
        «не зібрано» тому, хто подушку взагалі не планує. У HA None
        читається як unknown, і це рівно потрібне. Той самий вибір, що в
        ConcentrationBreachSensor: вимір без заданого ліміту не міряють, а
        не підставляють чиюсь уяву про норму.

        Зібрано = розриву немає, а НЕ uah >= target_uah. Розрив рахує
        сервіс, і повторити тут його арифметику означало б завести другу
        відповідь на те саме питання.

        Нуль тут — це ВІДСУТНЄ поле: gap_uah і target_uah у сервіса
        omitempty, тож зібраний резерв приїжджає без gap_uah зовсім, а не
        з нулем.
        """
        if self.target_uah <= 0:
            return None
        return self.gap_uah <= 0


@dataclass(frozen=True)
class DebtCard:
    """Кредитна картка на сьогодні: умови договору й похідні останньої звірки.

    Джерело балансу — звірка з додатком банку, і вік звірки
    (mark_age_days) їде поруч із числами навмисно: сенсор, що показує
    тиждень тому звірене «принести 15 400», каже й те, що йому тиждень.
    Порожня due_date означає, що число місяця в договорі не задане, — тоді
    days_to_due нічого не означає, і читати його не треба.
    """

    name: str = ""
    known: bool = False
    mark_date: str = ""
    mark_age_days: int = 0
    due_date: str = ""
    days_to_due: int = 0
    bring_by_due_uah: float = 0.0
    min_due_uah: float = 0.0
    free_uah: float = 0.0
    debt_uah: float = 0.0
    used_pct: float = 0.0
    exit_by: str = ""

    def due(self) -> date | None:
        return date.fromisoformat(self.due_date) if self.due_date else None


@dataclass(frozen=True)
class DebtPlan:
    """Борг: те, що він змінює в чужих числах, плюс картки поштучно.

    total_uah — лише борг ПІД СТАВКОЮ (розстрочки й непільгова частина
    картки); пільговий оборот картки сюди не входить, тож нуль при живій
    картці — правильна відповідь. Саме тому картки лежать окремим списком:
    «скільки принести до розрахункової дати» — питання про оборот, а не
    про борг, і в total_uah його немає.
    """

    total_uah: float = 0.0
    top_rate_pct: float = 0.0
    top_name: str = ""
    due_this_month_uah: float = 0.0
    cards: tuple[DebtCard, ...] = field(default_factory=tuple)

    def bring_by_due_uah(self) -> float:
        """Скільки принести на всі картки разом, щоб відсотків не було."""
        return sum(c.bring_by_due_uah for c in self.cards if c.known)

    def nearest(self) -> DebtCard | None:
        """Картка з найближчою розрахунковою датою — або None без дат.

        Лише звірені картки: без звірки дата є, а суми немає, і сенсор
        «принести до дати» показував би нуль там, де насправді «не знаю».
        """
        dated = [c for c in self.cards if c.known and c.due_date]
        if not dated:
            return None
        return min(dated, key=lambda c: c.days_to_due)


@dataclass(frozen=True)
class IdleCash:
    """Простій: вільні гроші брокера, на які квиток уже є.

    investable_uah — скільки можна вкласти вже; since/days — відколи
    лежить. Ціна — в окремому IdleCost: сервіс розводить факт про гаманець
    і пораду про сьогоднішній ринок. Розріз по парах (by_pair) інтеграція
    не читає: це таблиця для веб-інтерфейсу.
    """

    investable_uah: float = 0.0
    since: str = ""
    days: int = 0
    age_days: float = 0.0


@dataclass(frozen=True)
class IdleCost:
    """Що коштує простій за сьогоднішньою порадою: на місяць, від дат
    надходжень, і звідки ставка."""

    cost_month_uah: float = 0.0
    cost_so_far_uah: float = 0.0
    rate_pct: float = 0.0
    rate_label: str = ""


@dataclass(frozen=True)
class CapitalDelta:
    """Рух капіталу за 30 днів проти добового знімка.

    Два числа, а не одне: delta_uah — на скільки змінився капітал,
    contributed_uah — скільки з цього внесено ззовні. Без другого «+12 000
    за місяць» читалось би як заробіток, коли 11 000 — власний внесок.
    """

    from_date: str = ""
    from_uah: float = 0.0
    delta_uah: float = 0.0
    delta_pct: float = 0.0
    contributed_uah: float = 0.0


@dataclass(frozen=True)
class ConcentrationRow:
    """Один вимір концентрації: папір, установа або рік погашень.

    over_uah > 0 означає перевищення заданого ліміту. Ліміт — це стеля,
    а не ціль, і перевищення нічого не забороняє: сервіс порад не дає.
    """

    dimension: str = ""
    key: str = ""
    amount_uah: float = 0.0
    share_pct: float = 0.0
    limit_pct: float = 0.0
    over_uah: float = 0.0
    label: str = ""


@dataclass(frozen=True)
class Task:
    """Один рядок черги «що робити»: рівно одне рішення, яке чекає.

    Черга приходить ГОТОВОЮ й уже впорядкованою — сервіс складає і порядок,
    і саму прозу (internal/api/state_tasks.go). Інтеграція її не перебирає й
    не переформульовує: те саме питання, зібране двічі, дало б два різні
    списки — у застосунку й тут, — а це рівно та розбіжність, проти якої в
    сервісі існує state/capital.go.

    sev — це ЧАС, а не важливість: "now" (можна зробити сьогодні), "soon"
    (дата в межах місяця), "watch" (стан без дедлайну).

    action — сталий ТОКЕН дії, а не підпис кнопки: натискати тут нічого, і
    саме тому підпису немає. Він потрібен автоматизації, яка хоче реагувати
    на конкретний вид задачі, не розбираючи текст.
    """

    id: str = ""
    sev: str = ""
    rank: int = 0
    kind: str = ""
    title: str = ""
    why: str = ""
    when: str = ""
    action: str = ""
    amount_uah: float = 0.0


@dataclass(frozen=True)
class FXWindowRow:
    """Де стоїть сьогоднішній курс валюти серед власної історії.

    По три рядки на валюту (1, 3 і 10 років) — вони РІЗНІ, бо гривня
    падає стрибками, і коротке вікно ловить або стрибок, або затишшя між
    ними. points каже, скільки точок реально знайшлось: вікно «10 років»
    на базі, якій три місяці, існувати не може.

    ЦЕ ФАКТ, А НЕ СИГНАЛ — сповіщень із цих рядків немає й не буде, з тієї
    ж причини, з якої їх немає з market_yield про кожен рух ринку:
    найвищий за десять років курс був найвищим рівно до наступного тижня.
    Довгий аргумент лежить у сервісі (internal/domain/fxwindow.go).
    """

    currency: str = ""
    years: int = 0
    points: int = 0
    percentile: float = 0.0
    now_rate: float = 0.0
    median_rate: float = 0.0
    min_rate: float = 0.0
    max_rate: float = 0.0
    vs_median_native: float = 0.0


@dataclass(frozen=True)
class MarketYieldRow:
    """Що ПЕРВИННИЙ ринок платить за строк — останнє розміщення Мінфіну.

    vs_portfolio_pp — на скільки п.п. рівень вищий за дохідність портфеля
    в ЦІЙ САМІЙ валюті. Порівняння саме з номінальною дохідністю: рівень
    розміщення йде до податку й до знецінення. Різницю рахує сервіс, щоб
    кожен споживач не обирав базу самотужки.
    """

    currency: str = ""
    bucket: str = ""
    pct: float = 0.0
    date: str = ""
    isin: str = ""
    vs_portfolio_pp: float = 0.0


@dataclass(frozen=True)
class Realized:
    """Результат за фактом по одній валюті — і причина, з якої XIRR поруч
    може мовчати.

    Не дублює xirr, а тримає його порожнечу поясненою: gain нічим не
    ануалізований, тож правдивий з першого дня, а money_days проти
    min_days каже, чого бракує річній ставці. Поріг приходить із сервіса,
    а не вписаний тут: те саме число в двох репозиторіях розійшлося б.
    """

    gain: float = 0.0
    gain_pct: float = 0.0
    money_days: float = 0.0
    min_days: int = 0


@dataclass(frozen=True)
class Settings:
    # monthly_target_uah — місячний план. ПОХІДНЕ значення: виводиться з
    # цілі й дедлайну, задати його не можна. Довго воно й не приходило
    # зовсім — гілка, що його публікувала, у бекенді була недосяжна.
    monthly_target_uah: float | None = None
    usd_target_share_pct: float | None = None
    eur_target_share_pct: float | None = None
    # assumed_rate_pct прибрано разом із полем у бекенді: воно не
    # читалось ніким, а ставку проєкції давно дає portfolio_yield.
    goal_amount_uah: float | None = None
    goal_date: str | None = None
    # public_url — адреса, з якої застосунок відкривається ЗЗОВНІ. Її
    # задає сам сервіс, коли власник підключає тунель на сторінці «Доступ
    # ззовні», і саме тому вона приходить документом, а не питається
    # вдруге в майстрі інтеграції: два джерела однієї адреси розійшлися б
    # мовчки, і розійшлися б саме тоді, коли адресу міняли.
    public_url: str | None = None


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
    eur_share_pct: float = 0.0
    account_uah: float = 0.0
    # funds_uah — сертифікати фондів у грн-екв. Необов'язкове: старіший
    # бекенд поля не надсилає, і інтеграція має пережити це нулем, а не
    # падінням.
    funds_uah: float = 0.0
    # deposits_uah — тіло діючих банківських вкладів у грн-екв. Так само
    # необов'язкове: бекенд без вкладів поля не надсилає.
    deposits_uah: float = 0.0
    # reserve_uah — резерв («матрац»), грн-екв. Частина капіталу, але не
    # інструмент: дохідності в нього немає, і в купівельну спроможність він
    # не входить. Необов'язкове з тієї ж причини, що й попередні два.
    reserve_uah: float = 0.0
    # npf_uah — пенсійні активи (НПФ) у грн-екв. Частина капіталу, але не
    # купівельна спроможність: до 50 років звідси не приходить нічого.
    # Необовʼязкове з тієї ж причини, що й три попередні.
    npf_uah: float = 0.0
    # goals_uah — цілі накопичення разом, грн-екв.: гроші, відкладені на
    # названу річ у названу дату. Як і резерв, частина капіталу, але не
    # купівельна спроможність. Окремо від reserve_uah, бо доля різна:
    # подушку тримають, ЩОБ НЕ витратити, ціль — щоб витратити.
    # Необовʼязкове з тієї ж причини, що й чотири попередні.
    goals_uah: float = 0.0
    # npf_cost_uah — сума внесків. Тримається поруч, бо без неї приріст
    # пенсійної частини не порахувати: вартість і собівартість тут
    # РІЗНІ, на відміну від вкладу чи резерву.
    npf_cost_uah: float = 0.0
    # npf_contrib_due — чи прострочений внесок цього місяця.
    #
    # Єдина дія, якої НПФ вимагає від власника, — вчасно внести, і саме тому
    # це поле, а не пропозиції реінвесту, є його місцем в інтеграції.
    # Самогасне на боці сервіса: щойно внесок за поточний місяць зʼявиться в
    # журналі, поле стає false, тож стану «я вже бачив» тут тримати не треба.
    npf_contrib_due: bool = False
    # capital_uah — УВЕСЬ капітал одним числом від сервіса.
    #
    # None, а НЕ 0.0, і це не педантизм: порожній портфель законно має
    # капітал нуль, тож нулем не відрізнити «сервіс сказав 0» від «сервіс
    # старий і поля не надсилає». Саме на цій різниці стоїть capital()
    # нижче.
    capital_uah: float | None = None
    reinvest_min_uah: float = 0.0
    accounts: dict[str, float] = field(default_factory=dict)
    reinvest_min: dict[str, float] = field(default_factory=dict)
    ladder: tuple[LadderRow, ...] = field(default_factory=tuple)
    top_payments: tuple[PaymentRow, ...] = field(default_factory=tuple)
    # v0.2+ сервіса; за старого сервіса 0.1 — порожній
    calendar: tuple[PaymentRow, ...] = field(default_factory=tuple)
    # v0.3+: сирі налаштування сервіса (для number/date-сутностей)
    settings: Settings | None = None
    # v1.0+: річний XIRR по валютах, %; порожній dict = нерахований
    xirr: dict[str, float] = field(default_factory=dict)
    # Результат за фактом по валютах. На відміну від xirr, приходить і
    # тоді, коли річна ставка ще прихована порогом, — саме він дає
    # сутності зміст, доки її стан unknown.
    realized: dict[str, Realized] = field(default_factory=dict)

    # Нижче — те, що доти жило лише у веб-інтерфейсі. Усе необовʼязкове:
    # старіший сервіс цих полів не надсилає, і сутність тоді читається як
    # unknown, що чесніше за нуль.
    #
    # income_monthly_now — скільки портфель приносить ЩОМІСЯЦЯ вже зараз.
    income_monthly_now: float = 0.0
    # accrued_uah — накопичений, ще не виплачений купон.
    accrued_uah: float = 0.0
    # Дохідності. У сутність іде ОДНА (blended_*), решта — атрибутами:
    # три сусідні числа, кожне з яких зветься «моя дохідність», — це рівно
    # та хвороба, від якої лікує capital_uah.
    blended_yield_pct: float = 0.0
    blended_yield_real_pct: float = 0.0
    portfolio_yield_pct: float = 0.0
    funds_yield_pct: float = 0.0
    # nbu_refreshed_at — коли востаннє оновлювався довідник НБУ, RFC3339.
    # Порожній рядок = сервіс поля не надсилає (див. nbu_age_hours).
    nbu_refreshed_at: str = ""
    independence: Independence | None = None
    liquidity: Liquidity | None = None
    reserve: Reserve | None = None
    # net_worth_uah — ЧИСТИЙ капітал: capital_uah мінус усе, що винен,
    # включно з пільговим боргом картки. None, а не 0.0, з того самого
    # доводу, що в capital_uah: чистий капітал законно буває нулем (і
    # відʼємним), тож нулем не відрізнити «сервіс сказав» від «сервіс
    # старий». Без боргів сервіс поля не надсилає (omitempty), і тоді
    # чистий капітал дорівнює капіталу — див. net_worth().
    net_worth_uah: float | None = None
    # capital_delta_30 — рух капіталу за 30 днів. None, доки в сервіса
    # немає знімка місячної давнини або сервіс старший за поле.
    capital_delta_30: CapitalDelta | None = None
    # idle — простій. None = простою немає (жодна пара брокер × валюта не
    # дотягує до квитка) або сервіс старший за поле; сенсор тоді unknown,
    # а не 0: нуль тут означав би «порахували, лежить нічого».
    idle: IdleCash | None = None
    # idle_cost — ціна простою. None = простою немає, поради для цих
    # грошей немає або сервіс старший.
    idle_cost: IdleCost | None = None
    # debt — борг і картки. None = боргів немає або сервіс старший.
    debt: DebtPlan | None = None
    concentration: tuple[ConcentrationRow, ...] = field(default_factory=tuple)
    # market_yield — крива первинного ринку. Сутностей із неї немає (це
    # таблиця), але сповіщення читає з неї найсвіжіший рядок.
    market_yield: tuple[MarketYieldRow, ...] = field(default_factory=tuple)
    # fx_window — де стоїть курс серед історії. Сутностей із неї теж немає
    # (це таблиця): рядки йдуть атрибутами до частки валюти, бо саме там
    # їх і читають — поруч із питанням «скільки валюти вже маю».
    fx_window: tuple[FXWindowRow, ...] = field(default_factory=tuple)
    # tasks — черга «що робити», вже впорядкована сервісом.
    #
    # Порожня в двох випадках, і обидва законні: робити справді нічого або
    # бекенд старший за це поле. Розрізняти їх інтеграції нічим, та й
    # незачем: в обох випадках правильна відповідь одна — нуль задач.
    tasks: tuple[Task, ...] = field(default_factory=tuple)
    # currency — валюта, у якій показані ВСІ суми документа (schema 3).
    # Обов'язкове: сенсор із грошима без одиниці брехав би мовчки.
    # currency_note — чому показано не те, що просили (курсу ще немає).
    currency: str = BOOK_CURRENCY
    currency_note: str = ""

    def currency_symbol(self) -> str:
        """Символ валюти документа для прози сповіщень: ₴, $ чи €."""
        return CURRENCY_SYMBOL.get(self.currency, self.currency)

    REQUIRED = (
        "schema",
        "generated_at",
        "currency",
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

    def net_worth(self) -> float:
        """Чистий капітал: готове число сервіса, а без нього — капітал.

        Без боргів сервіс net_worth_uah не надсилає (omitempty), і тоді
        чистий капітал дорівнює капіталу за означенням — це не запасний
        шлях для старого бекенда, а відповідь. Старий бекенд без поля
        нічим не відрізнити, і для нього відповідь та сама.
        """
        if self.net_worth_uah is not None:
            return self.net_worth_uah
        return self.capital()

    def capital(self) -> float:
        """Увесь капітал, грн-екв.

        Бере ГОТОВЕ число сервіса, коли воно є. Складання лишається
        запасним шляхом для старішого бекенда — і саме запасним, а не
        основним.

        Різниця тут не косметична. Поле capital_uah зʼявилось у контракті
        рівно тому, що капітал збирали чотирма способами водночас, і плитка
        на екрані казала 57.6%, а картка ребалансу поруч — 0%. У JS цей
        висновок уже застосований (web/js/format.js, capitalUAH: спершу
        готове поле, сума лише як запасний шлях), а тут та сама сума
        складалась заново — тобто та сама вада, відтворена другою мовою.

        Метод живе на StateDoc, а не в sensor.py, щоб правило було в межах
        pytest: у цьому репозиторії тестується парсер, а не сутності.
        """
        if self.capital_uah is not None:
            return self.capital_uah
        return (
            self.nominal_uah_eq
            + self.account_uah
            + self.funds_uah
            + self.deposits_uah
            + self.reserve_uah
            + self.goals_uah
            + self.npf_uah
        )

    def age_hours(self, now: datetime) -> float | None:
        """Скільки годин минуло відколи сервіс зібрав цей документ."""
        return _age_hours(self.generated_at, now)

    def nbu_age_hours(self, now: datetime) -> float | None:
        """Скільки годин довіднику НБУ. None = сервіс поля не надсилає."""
        return _age_hours(self.nbu_refreshed_at, now)

    def breaches(self) -> tuple[ConcentrationRow, ...]:
        """Виміри, де заданий ліміт концентрації перевищено.

        Перевищення нічого не забороняє й нічого не ховає — сервіс порад
        не дає. Це спостереження, і воно варте сповіщення саме тому, що
        інакше лишається непоміченим до наступного погляду на екран.
        """
        return tuple(c for c in self.concentration if c.over_uah > 0)

    def best_market_offer(self) -> MarketYieldRow | None:
        """Найсвіжіше розміщення, що ВИЩЕ за дохідність портфеля.

        Саме найсвіжіше, а не найвигідніше: сповіщення про подію («Мінфін
        сьогодні розмістив…») мусить казати про те, що щойно сталось.
        Вибір «найбільшого розриву» дав би рядок піврічної давнини й
        повторював би його щодня.

        Рядки з vs_portfolio_pp <= 0 сюди не потрапляють: «ринок дає менше
        за твій портфель» — не привід нікого будити.
        """
        better = [r for r in self.market_yield if r.vs_portfolio_pp > 0 and r.date]
        if not better:
            return None
        return max(better, key=lambda r: (r.date, r.vs_portfolio_pp))

    def redemptions_within(self, days: int, now: date) -> tuple[PaymentRow, ...]:
        """Погашення (паперів і вкладів) у найближчі `days` днів.

        Саме погашення, не купони: купон приходить і йде далі, а погашення
        повертає ТІЛО — і воно або піде за новою ставкою, або ляже мертвим
        вантажем на рахунку. Це рішення, а не подія.
        """
        limit = now + timedelta(days=days)
        out = []
        for p in self.calendar:
            if p.type != "redemption":
                continue
            try:
                d = date.fromisoformat(p.date)
            except ValueError:
                continue
            if now <= d <= limit:
                out.append(p)
        return tuple(out)

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
            raise SchemaMismatch(schema, SUPPORTED_SCHEMA)

        # Будь-яке поле не того вигляду (рядок замість числа, null замість
        # обʼєкта, відсутній ключ у вкладеному рядку) — теж порушення
        # контракту, а не падіння інтеграції. Доти TypeError/KeyError звідси
        # летіли повз ContractError: оновлення стану тихо зупинялось зі
        # стеком у журналі, а config_flow показував «невідома помилка»
        # замість «сервіс віддає не той документ».
        try:
            return cls._build(raw, schema)
        except ContractError:
            raise
        except (TypeError, KeyError, ValueError, AttributeError) as err:
            raise ContractError(f"поле не того вигляду: {type(err).__name__}: {err}") from err

    @classmethod
    def _build(cls, raw: dict[str, Any], schema: Any) -> "StateDoc":
        np = None
        if raw.get("next_payment"):
            p = raw["next_payment"]
            np = NextPayment(
                date=str(p["date"]),
                isin=str(p["isin"]),
                type=str(p["type"]),
                amount=float(p["amount"]),
                currency=str(p["currency"]),
                label=str(p.get("label", "")),
            )

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
            eur_share_pct=float(raw.get("eur_share_pct", 0.0)),
            account_uah=float(raw.get("account_uah", 0.0)),
            currency=str(raw["currency"]),
            currency_note=str(raw.get("currency_note", "")),
            funds_uah=float(raw.get("funds_uah", 0.0)),
            deposits_uah=float(raw.get("deposits_uah", 0.0)),
            reserve_uah=float(raw.get("reserve_uah", 0.0)),
            goals_uah=float(raw.get("goals_uah", 0.0)),
            npf_uah=float(raw.get("npf_uah", 0.0)),
            npf_cost_uah=float(raw.get("npf_cost_uah", 0.0)),
            npf_contrib_due=bool(raw.get("npf_contrib_due", False)),
            capital_uah=(float(raw["capital_uah"]) if raw.get("capital_uah") is not None else None),
            reinvest_min_uah=float(raw.get("reinvest_min_uah", 0.0)),
            accounts={str(k): float(v) for k, v in (raw.get("accounts") or {}).items()},
            reinvest_min={str(k): float(v) for k, v in (raw.get("reinvest_min") or {}).items()},
            ladder=tuple(
                LadderRow(
                    year=int(r["year"]),
                    uah=float(r["uah"]),
                    usd=float(r["usd"]),
                    eur=float(r.get("eur", 0.0)),
                )
                for r in raw["ladder"]
            ),
            top_payments=tuple(_payment_row(p) for p in raw["top_payments"]),
            calendar=tuple(_payment_row(p) for p in raw.get("calendar", ())),
            settings=_settings(raw.get("settings")),
            xirr={str(k): float(v) for k, v in (raw.get("xirr") or {}).items()},
            realized={
                str(k): _dc(Realized, v) for k, v in (raw.get("realized") or {}).items() if v
            },
            income_monthly_now=float(raw.get("income_monthly_now", 0.0)),
            accrued_uah=float(raw.get("accrued_uah", 0.0)),
            blended_yield_pct=float(raw.get("blended_yield_pct", 0.0)),
            blended_yield_real_pct=float(raw.get("blended_yield_real_pct", 0.0)),
            portfolio_yield_pct=float(raw.get("portfolio_yield_pct", 0.0)),
            funds_yield_pct=float(raw.get("funds_yield_pct", 0.0)),
            nbu_refreshed_at=str(raw.get("nbu_refreshed_at", "")),
            independence=_dc(Independence, raw.get("independence")),
            liquidity=_dc(Liquidity, raw.get("liquidity")),
            reserve=_dc(Reserve, raw.get("reserve")),
            net_worth_uah=(
                float(raw["net_worth_uah"]) if raw.get("net_worth_uah") is not None else None
            ),
            capital_delta_30=_dc(CapitalDelta, raw.get("capital_delta_30")),
            idle=_dc(IdleCash, raw.get("idle")),
            idle_cost=_dc(IdleCost, raw.get("idle_cost")),
            debt=_debt(raw.get("debt")),
            concentration=tuple(_dc(ConcentrationRow, r) for r in (raw.get("concentration") or ())),
            market_yield=tuple(_dc(MarketYieldRow, r) for r in (raw.get("market_yield") or ())),
            fx_window=tuple(_dc(FXWindowRow, r) for r in (raw.get("fx_window") or ())),
            tasks=tuple(_dc(Task, r) for r in (raw.get("tasks") or ())),
        )


def _debt(raw: dict[str, Any] | None) -> DebtPlan | None:
    """Блок debt: скаляри через _dc, картки — руками.

    _dc уміє лише плоскі скаляри, а cards — список обʼєктів; той самий
    випадок, що next_payment і calendar. Поля exit і fill_* сервіса тут
    не читаються: вони проєкція плану виходу й стелі дострокового, і
    сутності з них немає — атрибути без читача були б порожнім швом.
    """
    if not raw:
        return None
    plan = _dc(DebtPlan, raw)
    return DebtPlan(
        total_uah=plan.total_uah,
        top_rate_pct=plan.top_rate_pct,
        top_name=plan.top_name,
        due_this_month_uah=plan.due_this_month_uah,
        cards=tuple(_card(c) for c in (raw.get("cards") or ()) if c),
    )


def _card(raw: dict[str, Any]) -> DebtCard:
    # known — bool, а _dc зводить усе до int/float/str: рядок "False" був
    # би істинним. Тому картка збирається явно, полем за полем.
    return DebtCard(
        name=str(raw.get("name", "")),
        known=bool(raw.get("known", False)),
        mark_date=str(raw.get("mark_date", "")),
        mark_age_days=int(raw.get("mark_age_days", 0)),
        due_date=str(raw.get("due_date", "")),
        days_to_due=int(raw.get("days_to_due", 0)),
        bring_by_due_uah=float(raw.get("bring_by_due_uah", 0.0)),
        min_due_uah=float(raw.get("min_due_uah", 0.0)),
        free_uah=float(raw.get("free_uah", 0.0)),
        debt_uah=float(raw.get("debt_uah", 0.0)),
        used_pct=float(raw.get("used_pct", 0.0)),
        exit_by=str(raw.get("exit_by", "")),
    )


def _dc(cls, raw: dict[str, Any] | None):
    """Обʼєкт контракту → дата-клас, полями лише з нього.

    Один помічник на всі вкладені обʼєкти замість чотирьох майже
    однакових функцій. Робить рівно те, що вимагають правила читання
    контракту в шапці модуля:

    - НЕВІДОМІ поля документа ігноруються (сервіс еволюціонує додаванням,
      і нове поле не має валити стару інтеграцію);
    - ВІДСУТНІ поля лишаються дефолтами дата-класу, тобто старіший сервіс
      теж читається;
    - тип береться з анотації поля, тож float залишається float навіть
      коли JSON приніс ціле.

    None на вході означає «сервіс цього не надсилає» і дає None на виході —
    відрізнити це від «усі нулі» важливо, бо перше означає старий бекенд,
    а друге — порожній портфель.
    """
    if not raw:
        return None
    kinds = {f.name: f.type for f in fields(cls)}
    kwargs: dict[str, Any] = {}
    for name, kind in kinds.items():
        if name not in raw or raw[name] is None:
            continue
        v = raw[name]
        # Анотації тут рядкові (from __future__ import annotations), тож
        # звіряємось із назвою типу, а не з самим типом.
        kwargs[name] = int(v) if kind == "int" else float(v) if kind == "float" else str(v)
    return cls(**kwargs)


def _settings(raw: dict[str, Any] | None) -> Settings | None:
    if not raw:
        return None

    def num(key: str) -> float | None:
        v = raw.get(key)
        return float(v) if v is not None else None

    gd = raw.get("goal_date")
    pu = raw.get("public_url")
    return Settings(
        monthly_target_uah=num("monthly_target_uah"),
        usd_target_share_pct=num("usd_target_share_pct"),
        eur_target_share_pct=num("eur_target_share_pct"),
        goal_amount_uah=num("goal_amount_uah"),
        goal_date=str(gd) if gd else None,
        public_url=str(pu) if pu else None,
    )


def _payment_row(p: dict[str, Any]) -> PaymentRow:
    return PaymentRow(
        date=str(p["date"]),
        isin=str(p["isin"]),
        type=str(p["type"]),
        amount=float(p["amount"]),
        currency=str(p["currency"]),
        label=str(p.get("label", "")),
    )
