"""Модулі інтеграції вантажаться напряму, без homeassistant.

models.py, actions.py і rules.py навмисно вільні від його залежностей,
тож тести бігають без встановленого HA. Завантажувач один на всі тести:
доти кожен файл тримав свою копію цих п'яти рядків.
"""

import importlib.util
import pathlib
import sys

_PKG = pathlib.Path(__file__).parents[1] / "custom_components" / "oddinvest"


def load_module(name: str):
    spec = importlib.util.spec_from_file_location(f"oddinvest_{name}", _PKG / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    # dataclasses резолвлять рядкові анотації через sys.modules.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod
