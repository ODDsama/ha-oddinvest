"""Дедлайн цілі як date-сутність.

Та сама механіка, що й у number.py: значення живе на боці oddinvestd,
set → PUT /api/settings, підтверджене значення повертається з MQTT.
Оптимістичних оновлень нема навмисно — на екрані те, що реально
збережено.

Чому окрема платформа, а не текстове поле чи атрибут. Дедлайн — це дата,
і саме як дату її хочуть узяти автоматизації й картки: порівняти з
сьогодні, порахувати місяці, показати в календарі. Текстовий рядок
змусив би кожного споживача розбирати ISO самотужки, а атрибут не можна
було б редагувати з інтерфейсу зовсім.

Ціль зі СУМИ й ДЕДЛАЙНУ — пара: сума живе в number.py, дедлайн тут.
Обидві приходять із settings того самого документа.
"""

from __future__ import annotations

from datetime import date

from homeassistant.components.date import DateEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import OddInvestConfigEntry, async_put_setting
from .entity import OddInvestEntity

SETTING_KEY = "goal_date"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OddInvestConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([GoalDate(entry.runtime_data, entry.entry_id)])


class GoalDate(OddInvestEntity, DateEntity):
    """Дата, до якої треба зібрати цільову суму."""

    _attr_translation_key = "goal_date"

    def __init__(self, data, entry_id: str) -> None:
        super().__init__(data, entry_id)
        self._attr_unique_id = f"{entry_id}_goal_date"

    @property
    def native_value(self) -> date | None:
        st = self._data.state
        if st is None or st.settings is None or not st.settings.goal_date:
            return None
        try:
            return date.fromisoformat(st.settings.goal_date)
        except ValueError:
            # Сервіс віддав щось, що не є датою. Показати unknown чесніше,
            # ніж упасти: решта сутностей від цього не мусить постраждати.
            return None

    async def async_set_value(self, value: date) -> None:
        await async_put_setting(self.hass, self._data.base_url, SETTING_KEY, value.isoformat())
