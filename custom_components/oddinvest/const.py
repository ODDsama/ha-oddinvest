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
