// Бічна панель ODD Invest для Home Assistant.
//
// Сам застосунок — у shared/js/app.js: це вендор із репозиторію oddinvest,
// той самий код, що віддає веб-UI бекенда (синхронізується
// scripts/sync-ui.sh, руками не правиться). Тут лишається рівно те, чим
// панель відрізняється від вебу:
//
//   транспорт — /api/oddinvest/* через hass.fetchWithAuth, тож працює
//               HA-авторизація, не потрібен CORS і адреса бекенда не
//               світиться в браузері;
//   тема      — токени беруться зі змінних теми Home Assistant, тож
//               панель іде за темою користувача;
//   контракт  — HA ставить елементу властивості hass/panel/narrow/route.

import { OddInvestApp } from "./shared/js/app.js";
import { hassTransport } from "./shared/js/transport.js";

class OddInvestPanel extends OddInvestApp {
  constructor() {
    super();
    this.theme = "ha";
  }

  // HA віддає об'єкт hass одразу після створення елемента й далі оновлює
  // його на кожну зміну стану. Транспорт нам потрібен один раз: він
  // тримає посилання на hass, а не його копію.
  set hass(hass) {
    if (!this._transportSet) {
      this._transportSet = true;
      this.transport = hassTransport(hass);
    }
  }

  // Решта властивостей панелі нам не потрібна, але HA їх ставить —
  // без сетерів вони б осіли на елементі як звичайні поля.
  set panel(_) {}
  set narrow(_) {}
  set route(_) {}
}

if (!customElements.get("odd-invest-panel")) {
  customElements.define("odd-invest-panel", OddInvestPanel);
}
