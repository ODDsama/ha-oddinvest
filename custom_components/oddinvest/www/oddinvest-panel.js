// Бічна панель ODD Invest для Home Assistant.
// Власний веб-компонент: читає стан і виконує всі операції (лоти,
// продажі, виплати, налаштування) через проксі /api/oddinvest/* -> REST.

const PAY_TYPES = { 0: "купон", 1: "погашення", 2: "дострокове погашення" };
const TABS = [
  ["portfolio", "Портфель"],
  ["sales", "Продажі"],
  ["payments", "Виплати"],
  ["settings", "Налаштування"],
];

const fmtUAH = (v) =>
  (Number(v) || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴";
const fmtMoney = (m) =>
  m ? `${Number(m.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${m.currency}` : "—";
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

class OddInvestPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "portfolio";
    this._inited = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._inited) {
      this._inited = true;
      this._renderShell();
      this._loadTab();
    }
  }
  set panel(_) {}
  set narrow(_) {}
  set route(_) {}

  // ---- REST через проксі-в'юшку HA ----
  async _api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await this._hass.fetchWithAuth("/api/oddinvest/" + path, opts);
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`${resp.status}: ${txt.slice(0, 300)}`);
    }
    const ct = resp.headers.get("content-type") || "";
    if (resp.status === 204 || !ct.includes("application/json")) return null;
    return resp.json();
  }

  _toast(msg, ok = true) {
    const t = this.shadowRoot.getElementById("toast");
    t.textContent = msg;
    t.className = ok ? "toast ok" : "toast err";
    t.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; background:var(--primary-background-color); min-height:100vh;
                color:var(--primary-text-color); font-family:var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
        header { display:flex; align-items:center; gap:16px; padding:12px 20px;
                 background:var(--app-header-background-color, var(--primary-color));
                 color:var(--app-header-text-color, #fff); position:sticky; top:0; z-index:2; }
        header h1 { font-size:20px; margin:0; font-weight:500; flex:0 0 auto; }
        header .sp { flex:1; }
        button { cursor:pointer; border:none; border-radius:8px; padding:8px 14px; font-size:14px;
                 background:var(--primary-color); color:#fff; }
        button.ghost { background:rgba(255,255,255,.18); }
        button.sm { padding:4px 10px; font-size:13px; }
        button.warn { background:var(--error-color, #db4437); }
        button:disabled { opacity:.5; cursor:default; }
        nav { display:flex; gap:4px; padding:0 16px; background:var(--card-background-color); position:sticky; top:56px; z-index:2;
              border-bottom:1px solid var(--divider-color); overflow-x:auto; }
        nav a { padding:12px 16px; cursor:pointer; border-bottom:3px solid transparent; white-space:nowrap; color:var(--secondary-text-color); }
        nav a.active { color:var(--primary-color); border-bottom-color:var(--primary-color); font-weight:500; }
        main { padding:20px; max-width:1100px; margin:0 auto; }
        .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; margin-bottom:20px; }
        .tile { background:var(--card-background-color); border-radius:12px; padding:16px;
                box-shadow:var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.1)); }
        .tile .lbl { font-size:13px; color:var(--secondary-text-color); }
        .tile .val { font-size:22px; font-weight:600; margin-top:6px; }
        .card { background:var(--card-background-color); border-radius:12px; padding:16px; margin-bottom:20px;
                box-shadow:var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.1)); }
        .card h2 { font-size:16px; margin:0 0 12px; }
        table { width:100%; border-collapse:collapse; font-size:14px; }
        th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--divider-color); }
        th { color:var(--secondary-text-color); font-weight:500; }
        td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
        .muted { color:var(--secondary-text-color); }
        form { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; align-items:end; }
        label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--secondary-text-color); }
        input,select { padding:8px; border-radius:8px; border:1px solid var(--divider-color);
                       background:var(--secondary-background-color); color:var(--primary-text-color); font-size:14px; }
        .progress { height:10px; border-radius:6px; background:var(--divider-color); overflow:hidden; margin-top:8px; }
        .progress>span { display:block; height:100%; background:var(--primary-color); }
        .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(80px);
                 padding:12px 20px; border-radius:10px; color:#fff; opacity:0; transition:.25s; z-index:9; max-width:80vw; }
        .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
        .toast.ok { background:var(--success-color, #43a047); } .toast.err { background:var(--error-color, #db4437); }
        .row-actions { display:flex; gap:6px; }
        .pill { padding:2px 8px; border-radius:10px; font-size:12px; background:var(--divider-color); }
        .pill.reinv { background:var(--success-color,#43a047); color:#fff; }
        .pill.recv { background:var(--info-color,#039be5); color:#fff; }
      </style>
      <header>
        <h1>ODD Invest</h1>
        <span class="sp"></span>
        <span id="avail" class="muted" style="color:inherit;opacity:.85"></span>
        <button class="ghost" id="refresh">↻ Оновити НБУ</button>
      </header>
      <nav>${TABS.map(([k, t]) => `<a data-tab="${k}">${t}</a>`).join("")}</nav>
      <main id="main"></main>
      <div id="toast" class="toast"></div>
    `;
    this.shadowRoot.querySelectorAll("nav a").forEach((a) =>
      a.addEventListener("click", () => {
        this._tab = a.dataset.tab;
        this._loadTab();
      })
    );
    this.shadowRoot.getElementById("refresh").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await this._api("POST", "refresh");
        this._toast("Довідник НБУ оновлено");
        this._loadTab();
      } catch (err) {
        this._toast(String(err.message || err), false);
      } finally {
        e.target.disabled = false;
      }
    });
  }

  _syncNav() {
    this.shadowRoot.querySelectorAll("nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.tab === this._tab)
    );
  }

  async _loadTab() {
    this._syncNav();
    const main = this.shadowRoot.getElementById("main");
    main.innerHTML = `<div class="muted">Завантаження…</div>`;
    try {
      if (this._tab === "portfolio") await this._renderPortfolio(main);
      else if (this._tab === "sales") await this._renderSales(main);
      else if (this._tab === "payments") await this._renderPayments(main);
      else if (this._tab === "settings") await this._renderSettings(main);
    } catch (err) {
      main.innerHTML = `<div class="card err">Помилка: ${esc(err.message || err)}</div>`;
    }
  }

  // ---------- ПОРТФЕЛЬ ----------
  async _renderPortfolio(main) {
    const [sum, positions, lots] = await Promise.all([
      this._api("GET", "summary"),
      this._api("GET", "positions"),
      this._api("GET", "lots"),
    ]);
    const avail = this.shadowRoot.getElementById("avail");
    avail.textContent = sum.generated_at ? "стан на " + new Date(sum.generated_at).toLocaleString("uk-UA") : "";

    const xirr = sum.xirr || {};
    const xirrStr = Object.keys(xirr).length
      ? Object.entries(xirr).map(([k, v]) => `${v}% ${k}`).join(" · ")
      : "—";

    main.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="lbl">Вкладено</div><div class="val">${fmtUAH(sum.invested_uah)}</div></div>
        <div class="tile"><div class="lbl">Номінал портфеля</div><div class="val">${fmtUAH(sum.nominal_uah_eq)}</div></div>
        <div class="tile"><div class="lbl">Частка USD</div><div class="val">${(sum.usd_share_pct || 0).toFixed(1)}%</div></div>
        <div class="tile"><div class="lbl">Не перевкладено</div><div class="val">${fmtUAH(sum.uninvested_uah)}</div></div>
        <div class="tile"><div class="lbl">XIRR</div><div class="val">${xirrStr}</div></div>
        <div class="tile"><div class="lbl">Ціль місяця (${(sum.month_progress_pct||0)}%)</div>
          <div class="val">${fmtUAH(sum.month_invested_uah)} / ${fmtUAH(sum.month_target_uah)}</div>
          <div class="progress"><span style="width:${Math.min(100, sum.month_progress_pct || 0)}%"></span></div></div>
      </div>

      <div class="card">
        <h2>Позиції</h2>
        ${positions.length ? `<table><thead><tr>
          <th>ISIN</th><th class="num">К-сть</th><th class="num">Вкладено</th><th class="num">Номінал</th>
          <th>Погашення</th><th class="num">Днів</th><th>Найближча виплата</th></tr></thead><tbody>
          ${positions.map((p) => `<tr>
            <td>${esc(p.isin)}</td><td class="num">${p.qty}</td>
            <td class="num">${fmtMoney(p.invested)}</td><td class="num">${fmtMoney(p.nominal)}</td>
            <td>${esc(p.maturity)}</td><td class="num">${p.days_to_maturity}</td>
            <td>${p.next_pay_date ? esc(p.next_pay_date) + " · " + fmtMoney(p.next_pay_amount) : "—"}</td>
          </tr>`).join("")}</tbody></table>`
          : `<div class="muted">Позицій немає. Додайте перший лот нижче.</div>`}
      </div>

      <div class="card">
        <h2>Лоти</h2>
        ${lots.length ? `<table><thead><tr>
          <th>ISIN</th><th class="num">К-сть</th><th class="num">Залишок</th><th class="num">Ціна</th>
          <th class="num">Комісія</th><th>Куплено</th><th>Канал</th><th></th></tr></thead><tbody>
          ${lots.map((l) => `<tr>
            <td>${esc(l.isin)}</td><td class="num">${l.qty}</td><td class="num">${l.remaining}</td>
            <td class="num">${fmtMoney(l.price_per_bond)}</td><td class="num">${fmtMoney(l.fee)}</td>
            <td>${esc(l.buy_date)}</td><td>${esc(l.channel || "")}</td>
            <td class="row-actions"><button class="sm warn" data-del="${l.id}">✕</button></td>
          </tr>`).join("")}</tbody></table>`
          : `<div class="muted">Лотів ще немає.</div>`}
      </div>

      <div class="card">
        <h2>Додати лот</h2>
        <form id="lotForm">
          <label>ISIN<input name="isin" list="bondlist" required placeholder="UA4000..." autocomplete="off"></label>
          <datalist id="bondlist"></datalist>
          <label>Кількість<input name="qty" type="number" min="1" step="1" required></label>
          <label>Ціна за папір (брудна)<input name="price_per_bond" type="text" inputmode="decimal" placeholder="995.00" required></label>
          <label>Комісія (сумарно)<input name="fee" inputmode="decimal" placeholder="0.00"></label>
          <label>Валюта<input name="currency" placeholder="авто з довідника" maxlength="3"></label>
          <label>Дата купівлі<input name="buy_date" type="date" value="${today()}" required></label>
          <label>Канал<input name="channel" placeholder="напр. Приват"></label>
          <label>Нотатка<input name="note"></label>
          <button type="submit">Додати лот</button>
        </form>
      </div>
    `;

    main.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Видалити лот #" + b.dataset.del + "?")) return;
        try {
          await this._api("DELETE", "lots/" + b.dataset.del);
          this._toast("Лот видалено");
          this._loadTab();
        } catch (err) {
          this._toast(String(err.message || err), false);
        }
      })
    );

    // автокомпліт паперів НБУ
    const isinInput = main.querySelector('input[name="isin"]');
    const dl = main.querySelector("#bondlist");
    let dbt;
    isinInput.addEventListener("input", () => {
      clearTimeout(dbt);
      const q = isinInput.value.trim();
      if (q.length < 2) return;
      dbt = setTimeout(async () => {
        try {
          const bonds = await this._api("GET", "bonds/search?q=" + encodeURIComponent(q));
          dl.innerHTML = bonds
            .map((b) => `<option value="${esc(b.isin)}">${esc(b.descr || "")} · ${b.rate_pct}% · до ${esc(b.maturity)}</option>`)
            .join("");
        } catch (_) {}
      }, 300);
    });

    main.querySelector("#lotForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        isin: f.isin.value.trim(),
        qty: parseInt(f.qty.value, 10),
        price_per_bond: f.price_per_bond.value.trim(),
        fee: f.fee.value.trim(),
        currency: f.currency.value.trim(),
        buy_date: f.buy_date.value,
        channel: f.channel.value.trim(),
        note: f.note.value.trim(),
      };
      try {
        await this._api("POST", "lots", body);
        this._toast("Лот додано");
        this._loadTab();
      } catch (err) {
        this._toast(String(err.message || err), false);
      }
    });
  }

  // ---------- ПРОДАЖІ ----------
  async _renderSales(main) {
    const [sales, lots] = await Promise.all([
      this._api("GET", "sales"),
      this._api("GET", "lots"),
    ]);
    main.innerHTML = `
      <div class="card">
        <h2>Продажі</h2>
        ${sales.length ? `<table><thead><tr>
          <th>Дата</th><th>ISIN</th><th class="num">К-сть</th><th class="num">Ціна (чиста)</th>
          <th class="num">НКД</th><th class="num">Результат</th></tr></thead><tbody>
          ${sales.map((s) => `<tr>
            <td>${esc(s.sale_date)}</td><td>${esc(s.isin)}</td><td class="num">${s.qty}</td>
            <td class="num">${fmtMoney(s.clean_per_bond)}</td><td class="num">${fmtMoney(s.accrued)}</td>
            <td class="num">${fmtMoney(s.realized_result)}</td>
          </tr>`).join("")}</tbody></table>`
          : `<div class="muted">Продажів ще немає.</div>`}
      </div>
      <div class="card">
        <h2>Оформити продаж</h2>
        <form id="saleForm">
          <label>Лот<select name="lot_id" required>
            <option value="">— оберіть лот —</option>
            ${lots.filter((l) => l.remaining > 0).map((l) =>
              `<option value="${l.id}" data-cur="${l.price_per_bond.currency}">#${l.id} · ${esc(l.isin)} · залишок ${l.remaining}</option>`).join("")}
          </select></label>
          <label>Дата продажу<input name="sale_date" type="date" value="${today()}" required></label>
          <label>Кількість<input name="qty" type="number" min="1" step="1" required></label>
          <label>Чиста ціна/папір<input name="clean_per_bond" inputmode="decimal" placeholder="1001.50" required></label>
          <label>НКД (сумарно, опц.)<input name="accrued" inputmode="decimal" placeholder="0.00"></label>
          <label>Нотатка<input name="note"></label>
          <button type="submit">Додати продаж</button>
        </form>
      </div>
    `;
    main.querySelector("#saleForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const opt = f.lot_id.selectedOptions[0];
      const body = {
        lot_id: parseInt(f.lot_id.value, 10),
        sale_date: f.sale_date.value,
        qty: parseInt(f.qty.value, 10),
        clean_per_bond: f.clean_per_bond.value.trim(),
        accrued: f.accrued.value.trim(),
        currency: opt ? opt.dataset.cur : "UAH",
        note: f.note.value.trim(),
      };
      try {
        await this._api("POST", "sales", body);
        this._toast("Продаж додано");
        this._loadTab();
      } catch (err) {
        this._toast(String(err.message || err), false);
      }
    });
  }

  // ---------- ВИПЛАТИ ----------
  async _renderPayments(main) {
    const cal = await this._api("GET", "calendar?from=1970-01-01");
    const now = today();
    const rows = cal.slice().sort((a, b) => a.date.localeCompare(b.date));
    main.innerHTML = `
      <div class="card">
        <h2>Виплати</h2>
        <div class="muted" style="margin-bottom:10px">Минулі виплати можна позначати як отримані / перевкладені.</div>
        ${rows.length ? `<table><thead><tr>
          <th>Дата</th><th>ISIN</th><th>Тип</th><th class="num">Сума</th><th>Статус</th><th></th></tr></thead><tbody>
          ${rows.map((c) => {
            const past = c.date <= now;
            const st = c.status || "";
            const pill = st === "reinvested" ? `<span class="pill reinv">перевкладено</span>`
              : st === "received" ? `<span class="pill recv">отримано</span>` : `<span class="pill">—</span>`;
            return `<tr>
              <td>${esc(c.date)}</td><td>${esc(c.isin)}</td><td>${PAY_TYPES[c.type] || c.type}</td>
              <td class="num">${fmtMoney(c.amount)}</td><td>${pill}</td>
              <td class="row-actions">${past ? `
                <button class="sm" data-isin="${esc(c.isin)}" data-date="${esc(c.date)}" data-st="received">Отримано</button>
                <button class="sm" data-isin="${esc(c.isin)}" data-date="${esc(c.date)}" data-st="reinvested">Перевкладено</button>` : ""}</td>
            </tr>`;
          }).join("")}</tbody></table>`
          : `<div class="muted">Виплат немає.</div>`}
      </div>
    `;
    main.querySelectorAll("[data-st]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await this._api("POST", "payments/status", {
            isin: b.dataset.isin, pay_date: b.dataset.date, status: b.dataset.st,
          });
          this._toast("Статус збережено");
          this._loadTab();
        } catch (err) {
          this._toast(String(err.message || err), false);
        }
      })
    );
  }

  // ---------- НАЛАШТУВАННЯ ----------
  async _renderSettings(main) {
    const s = await this._api("GET", "settings");
    main.innerHTML = `
      <div class="card">
        <h2>Налаштування</h2>
        <form id="setForm">
          <label>Ціль на місяць, ₴<input name="monthly_target_uah" inputmode="decimal" value="${esc(s.monthly_target_uah || "")}"></label>
          <label>Цільова частка USD, %<input name="usd_target_share_pct" inputmode="decimal" value="${esc(s.usd_target_share_pct || "")}"></label>
          <label>Продовження страховки<input name="insurance_renewal" type="date" value="${esc(s.insurance_renewal || "")}"></label>
          <label>Премія страховки, ₴<input name="insurance_premium_uah" inputmode="decimal" value="${esc(s.insurance_premium_uah || "")}"></label>
          <button type="submit">Зберегти</button>
        </form>
      </div>
    `;
    main.querySelector("#setForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        monthly_target_uah: f.monthly_target_uah.value.trim(),
        usd_target_share_pct: f.usd_target_share_pct.value.trim(),
        insurance_renewal: f.insurance_renewal.value.trim(),
        insurance_premium_uah: f.insurance_premium_uah.value.trim(),
      };
      try {
        await this._api("PUT", "settings", body);
        this._toast("Налаштування збережено");
      } catch (err) {
        this._toast(String(err.message || err), false);
      }
    });
  }
}

customElements.define("odd-invest-panel", OddInvestPanel);
