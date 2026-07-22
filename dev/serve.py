#!/usr/bin/env python3
"""Статичний сервер для стенда — з забороною кешування.

`python3 -m http.server` не шле заголовків кешу, і браузер вирішує сам:
ES-модулі й CSS він тримає евристично, тож після правки файла сторінка
показує стару версію без жодного натяку на це. Ловити таке в UI, який
малюється рядками, — найдорожчий спосіб змарнувати годину.

Запуск із каталогу, де поруч лежать oddinvest і ha-oddinvest:

    python3 ha-oddinvest/dev/serve.py

далі http://localhost:8099/ha-oddinvest/dev/harness.html
(`?surface=web` — та сама збірка в оформленні веб-UI).
"""

import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # тихо: цікавлять лише помилки
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    handler = partial(NoCacheHandler, directory=".")
    print(f"стенд: http://localhost:{port}/ha-oddinvest/dev/harness.html")
    HTTPServer(("127.0.0.1", port), handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
