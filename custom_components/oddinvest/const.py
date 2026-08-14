"""Константи інтеграції ODD Invest."""

DOMAIN = "oddinvest"

CONF_BASE_URL = "base_url"
CONF_TOPIC_PREFIX = "topic_prefix"

DEFAULT_PREFIX = "oddinvest"

SIGNAL_STATE_UPDATED = f"{DOMAIN}_state_updated"
SIGNAL_AVAILABILITY = f"{DOMAIN}_availability"

SUPPORTED_SCHEMA = 1

SERVICE_REFRESH = "refresh"
SERVICE_MARK_PAYMENT = "mark_payment"

# STALE_AFTER_H — за скільки годин стан вважається несвіжим.
#
# Арифметика така. Добова джоба сервіса ходить у НБУ о 06:10 за Києвом,
# тобто між двома успішними оновленнями рівно 24 години, і найтугіша
# чесна межа — приблизно 30 (24 плюс запас на довгий бекфіл і на те, що
# документ публікується не миттєво). 36 лишає зверху ще один пропущений
# запуск: одна невдала спроба — не привід будити людину, дві поспіль —
# уже привід.
#
# Живе тут, а не в binary_sensor.py, бо поріг спільний для сенсора й для
# сповіщень: два числа розійшлись би, і сутність казала б одне, а пуш —
# інше про ту саму відмову.
STALE_AFTER_H = 36
