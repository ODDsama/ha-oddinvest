// Бічна панель ODD Invest для Home Assistant.
// Повторює концепцію веб-UI бекенда (Портфель / Календар / Драбина /
// Динаміка / Налаштування + постійний рядок зведення), але операції
// йдуть через проксі /api/oddinvest/* -> REST, з HA-авторизацією і темою.

const PAY_TYPES = { 1: "купон", 2: "погашення", 3: "дострокове" };
const PAY_CLASS = { 1: "coupon", 2: "redemption", 3: "early" };
const TABS = [
  ["portfolio", "Портфель"],
  ["account", "Рахунок"],
  ["calendar", "Календар"],
  ["ladder", "Драбина"],
  ["dynamics", "Динаміка"],
  ["projection", "Проєкції"],
  ["settings", "Налаштування"],
];

const fmtUAH = (v) =>
  (Number(v) || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴";
const fmtCur = (v, cur) =>
  (Number(v) || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + cur;
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
    this._reinvestAll = [];
    this._rv = { cur: "", year: "", minRate: "", q: "", sortKey: "", sortDir: -1, page: 1, pageSize: 10 };
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
    t.className = ok ? "toast ok show" : "toast err show";
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
                 color:var(--app-header-text-color, #fff); position:sticky; top:0; z-index:3; }
        header h1 { font-size:20px; margin:0; font-weight:500; }
        header .sp { flex:1; }
        button { cursor:pointer; border:none; border-radius:8px; padding:8px 14px; font-size:14px;
                 background:var(--primary-color); color:#fff; }
        button.ghost { background:rgba(255,255,255,.18); }
        button.sm { padding:4px 10px; font-size:13px; }
        button.warn { background:var(--error-color, #db4437); }
        button:disabled { opacity:.5; cursor:default; }
        nav { display:flex; gap:4px; padding:0 16px; background:var(--card-background-color); position:sticky; top:56px; z-index:3;
              border-bottom:1px solid var(--divider-color); overflow-x:auto; }
        nav a { padding:12px 16px; cursor:pointer; border-bottom:3px solid transparent; white-space:nowrap; color:var(--secondary-text-color); }
        nav a.active { color:var(--primary-color); border-bottom-color:var(--primary-color); font-weight:500; }
        main { padding:0 20px 24px; max-width:1080px; margin:0 auto; }
        .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px;
                 max-width:1080px; margin:16px auto; padding:0 20px; }
        .tile { background:var(--card-background-color); border-radius:12px; padding:14px;
                box-shadow:var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.1)); }
        .tile .lbl { font-size:13px; color:var(--secondary-text-color); }
        .tile .val { font-size:20px; font-weight:600; margin-top:4px; }
        .card { background:var(--card-background-color); border-radius:12px; padding:16px; margin-bottom:18px;
                box-shadow:var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.1)); }
        .card h2 { font-size:16px; margin:0 0 12px; }
        table { width:100%; border-collapse:collapse; font-size:14px; }
        th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--divider-color); }
        th { color:var(--secondary-text-color); font-weight:500; }
        td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
        tr:last-child td { border-bottom:none; }
        .muted { color:var(--secondary-text-color); }
        form { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; align-items:end; }
        label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--secondary-text-color); }
        input,select { padding:8px; border-radius:8px; border:1px solid var(--divider-color);
                       background:var(--secondary-background-color); color:var(--primary-text-color); font-size:14px; }
        .progress { height:8px; border-radius:6px; background:var(--divider-color); overflow:hidden; margin-top:6px; }
        .progress>span { display:block; height:100%; background:var(--primary-color); }
        .pill { padding:2px 8px; border-radius:10px; font-size:12px; background:var(--divider-color); }
        .pill.coupon { background:var(--success-color,#43a047); color:#fff; }
        .pill.redemption { background:var(--warning-color,#ffa600); color:#111; }
        .pill.early { background:var(--info-color,#039be5); color:#fff; }
        .pill.reinv { background:var(--success-color,#43a047); color:#fff; }
        .pill.recv { background:var(--info-color,#039be5); color:#fff; }
        .row-actions { display:flex; gap:6px; }
        .rv-controls { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
        .rv-controls input, .rv-controls select { padding:6px 8px; font-size:13px; }
        .rv-controls input { max-width:150px; }
        th.sort { cursor:pointer; user-select:none; white-space:nowrap; }
        th.sort:hover { color:var(--primary-color); }
        .rv-pager { display:flex; align-items:center; gap:8px; margin-top:10px; flex-wrap:wrap; }
        .rv-pager .sp { flex:1; }
        .suggest { position:absolute; top:100%; left:0; right:0; z-index:6; margin-top:2px;
                   background:var(--card-background-color); border:1px solid var(--divider-color);
                   border-radius:8px; max-height:240px; overflow:auto; display:none;
                   box-shadow:var(--ha-card-box-shadow, 0 6px 16px rgba(0,0,0,.25)); }
        .suggest.show { display:block; }
        .suggest-item { padding:8px 10px; cursor:pointer; font-size:13px; white-space:nowrap;
                        overflow:hidden; text-overflow:ellipsis; }
        .suggest-item:hover { background:var(--secondary-background-color); }
        #cta { max-width:1080px; margin:0 auto; padding:0 20px; }
        .cta { background:var(--success-color,#43a047); color:#fff; border-radius:12px; padding:14px 18px;
               display:flex; align-items:center; gap:12px; flex-wrap:wrap; font-size:15px; }
        .cta b { font-weight:700; }
        .cta button { background:rgba(255,255,255,.22); margin-left:auto; }
        .bar { height:14px; border-radius:4px; display:inline-block; vertical-align:middle; }
        .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(80px);
                 padding:12px 20px; border-radius:10px; color:#fff; opacity:0; transition:.25s; z-index:9; max-width:80vw; }
        .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
        .toast.ok { background:var(--success-color, #43a047); } .toast.err { background:var(--error-color, #db4437); }
      </style>
      <header>
        <h1>ODD Invest</h1>
        <span class="sp"></span>
        <span id="avail" class="muted" style="color:inherit;opacity:.85"></span>
        <button class="ghost" id="refresh">↻ Оновити НБУ</button>
      </header>
      <nav>${TABS.map(([k, t]) => `<a data-tab="${k}">${t}</a>`).join("")}</nav>
      <div class="tiles" id="summary"></div>
      <div id="cta"></div>
      <main id="main"></main>
      <div id="toast" class="toast"></div>
    `;
    this.shadowRoot.querySelectorAll("nav a").forEach((a) =>
      a.addEventListener("click", () => { this._tab = a.dataset.tab; this._loadTab(); })
    );
    this.shadowRoot.getElementById("refresh").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { await this._api("POST", "refresh"); this._toast("Довідник НБУ оновлено"); this._loadTab(); }
      catch (err) { this._toast(String(err.message || err), false); }
      finally { e.target.disabled = false; }
    });
  }

  async _loadTab() {
    this.shadowRoot.querySelectorAll("nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.tab === this._tab));
    const main = this.shadowRoot.getElementById("main");
    main.innerHTML = `<div class="muted">Завантаження…</div>`;
    try {
      await this._loadSummary();
      if (this._tab === "portfolio") await this._renderPortfolio(main);
      else if (this._tab === "account") await this._renderAccount(main);
      else if (this._tab === "calendar") await this._renderCalendar(main);
      else if (this._tab === "ladder") await this._renderLadder(main);
      else if (this._tab === "dynamics") await this._renderDynamics(main);
      else if (this._tab === "projection") await this._renderProjection(main);
      else if (this._tab === "settings") await this._renderSettings(main);
    } catch (err) {
      main.innerHTML = `<div class="card">Помилка: ${esc(err.message || err)}</div>`;
    }
  }

  // ---------- постійне зведення (на всіх вкладках) ----------
  async _loadSummary() {
    const s = await this._api("GET", "summary");
    this._summary = s;
    const avail = this.shadowRoot.getElementById("avail");
    avail.textContent = s.generated_at ? "стан на " + new Date(s.generated_at).toLocaleString("uk-UA") : "";
    const tile = (l, v, extra = "") => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div>${extra}</div>`;
    const x = s.xirr || {};
    let html =
      tile("Вкладено (грн-екв.)", fmtUAH(s.invested_uah)) +
      tile("Номінал (грн-екв.)", fmtUAH(s.nominal_uah_eq)) +
      tile("Частка USD", (s.usd_share_pct || 0).toFixed(1) + "%") +
      tile("Частка EUR", (s.eur_share_pct || 0).toFixed(1) + "%") +
      tile("Місяць: план",
        `${fmtUAH(s.month_invested_uah)} / ${fmtUAH(s.month_target_uah)} (${s.month_progress_pct || 0}%)`,
        `<div class="progress"><span style="width:${Math.min(100, s.month_progress_pct || 0)}%"></span></div>`) +
      tile("Не перевкладено", fmtUAH(s.uninvested_uah)) +
      tile("Рахунок (грн-екв.)", fmtUAH(s.account_uah)) +
      tile("Разом (капітал)", fmtUAH((s.nominal_uah_eq || 0) + (s.account_uah || 0)));
    html += tile("Наступна виплата", s.next_payment
      ? `${esc(s.next_payment.date)} · ${Number(s.next_payment.amount).toLocaleString("uk-UA")} ${esc(s.next_payment.currency)}`
      : "—");
    html += tile("XIRR ₴", x.UAH != null ? x.UAH.toFixed(2) + "%" : "—");
    html += tile("XIRR $", x.USD != null ? x.USD.toFixed(2) + "%" : "—");
    html += tile("XIRR €", x.EUR != null ? x.EUR.toFixed(2) + "%" : "—");
    this.shadowRoot.getElementById("summary").innerHTML = html;

    // заклик до реінвестиції — по кожній валюті, де вистачає на папір
    const cta = this.shadowRoot.getElementById("cta");
    const acc = s.accounts || {}, rmin = s.reinvest_min || {};
    const ready = Object.keys(rmin).filter((c) => rmin[c] > 0 && (acc[c] || 0) >= rmin[c]);
    if (ready.length) {
      cta.innerHTML = ready.map((c) => {
        const n = Math.floor(acc[c] / rmin[c]);
        return `<div class="cta">💰 На рахунку <b>${fmtCur(acc[c], c)}</b> — вистачає на <b>${n}</b> ${esc(c)}-папер(и) (від ${fmtCur(rmin[c], c)}). <button data-cta="1">Реінвестувати →</button></div>`;
      }).join("");
      cta.querySelectorAll("[data-cta]").forEach((b) =>
        b.addEventListener("click", async () => {
          this._tab = "portfolio";
          await this._loadTab();
          const rc = this.shadowRoot.querySelector("#reinvestCard");
          const f = this.shadowRoot.querySelector("#lotForm");
          if (rc) rc.scrollIntoView({ behavior: "smooth", block: "center" });
          else if (f) { f.scrollIntoView({ behavior: "smooth", block: "center" }); f.isin.focus(); }
        }));
    } else {
      cta.innerHTML = "";
    }
  }

  // ---------- ПОМІЧНИК РЕІНВЕСТИЦІЇ: фільтри / сортування / пагінація ----------
  _rvOptions(kind, allLabel) {
    const set = new Set();
    for (const x of this._reinvestAll) {
      set.add(kind === "cur" ? x.currency : String(x.maturity).slice(0, 4));
    }
    const vals = [...set].filter(Boolean).sort();
    const sel = kind === "cur" ? this._rv.cur : this._rv.year;
    return `<option value="">${allLabel}</option>` +
      vals.map((v) => `<option value="${esc(v)}"${sel === v ? " selected" : ""}>${esc(v)}</option>`).join("");
  }

  _rvFilteredSorted() {
    const v = this._rv;
    let a = this._reinvestAll.filter((x) =>
      (!v.cur || x.currency === v.cur) &&
      (v.minRate === "" || parseFloat(x.rate_pct) >= parseFloat(v.minRate)) &&
      (!v.year || String(x.maturity).startsWith(v.year)) &&
      (!v.q || String(x.isin).toLowerCase().includes(v.q.toLowerCase())));
    if (v.sortKey) {
      const val = (x) => v.sortKey === "rate_pct" ? parseFloat(x.rate_pct)
        : v.sortKey === "nominal" ? Number(x.nominal && x.nominal.amount)
          : v.sortKey === "affordable" ? Number(x.affordable)
            : String(x.maturity);
      a = a.slice().sort((p, q) => { const pv = val(p), qv = val(q); return (pv < qv ? -1 : pv > qv ? 1 : 0) * v.sortDir; });
    }
    return a;
  }

  _rvRender(root) {
    const box = root.querySelector("#rvTable");
    if (!box) return;
    const v = this._rv;
    const rows = this._rvFilteredSorted();
    const total = rows.length;
    const size = v.pageSize === "all" ? (total || 1) : v.pageSize;
    const pages = Math.max(1, Math.ceil(total / size));
    if (v.page > pages) v.page = pages;
    const start = (v.page - 1) * size;
    const paged = v.pageSize === "all" ? rows : rows.slice(start, start + size);
    const arrow = (k) => v.sortKey === k ? (v.sortDir === 1 ? " ▲" : " ▼") : "";
    box.innerHTML = `
      <table><thead><tr>
        <th>ISIN</th>
        <th class="num sort" data-sort="rate_pct">Ставка${arrow("rate_pct")}</th>
        <th class="sort" data-sort="maturity">Погашення${arrow("maturity")}</th>
        <th class="num sort" data-sort="nominal">Номінал${arrow("nominal")}</th>
        <th class="num sort" data-sort="affordable">Вистачає${arrow("affordable")}</th>
        <th>Чому</th><th></th></tr></thead><tbody>
        ${paged.length ? paged.map((x) => `<tr>
          <td>${esc(x.isin)}</td><td class="num">${x.rate_pct}%</td><td>${esc(x.maturity)}</td>
          <td class="num">${fmtMoney(x.nominal)}</td><td class="num">${x.affordable}</td><td>${esc(x.reason)}</td>
          <td class="row-actions"><button class="sm" data-take="${esc(x.isin)}">Взяти</button></td></tr>`).join("")
        : `<tr><td colspan="7" class="muted">Нічого не знайдено за фільтром.</td></tr>`}
      </tbody></table>
      <div class="rv-pager">
        <span class="muted">${total} ${total === 1 ? "папір" : "паперів"}</span>
        <span class="sp"></span>
        <button class="sm ghost" data-pg="prev"${v.page <= 1 ? " disabled" : ""}>‹ Назад</button>
        <span class="muted">${v.page} / ${pages}</span>
        <button class="sm ghost" data-pg="next"${v.page >= pages ? " disabled" : ""}>Далі ›</button>
      </div>`;

    box.querySelectorAll("[data-sort]").forEach((th) =>
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (v.sortKey === k) v.sortDir *= -1;
        else { v.sortKey = k; v.sortDir = k === "maturity" ? 1 : -1; }
        this._rvRender(root);
      }));
    box.querySelectorAll("[data-pg]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.pg === "prev" && v.page > 1) v.page--;
        if (b.dataset.pg === "next") v.page++;
        this._rvRender(root);
      }));
    box.querySelectorAll("[data-take]").forEach((b) =>
      b.addEventListener("click", () => {
        const f = root.querySelector("#lotForm");
        f.isin.value = b.dataset.take;
        f.isin.dispatchEvent(new Event("change"));
        f.scrollIntoView({ behavior: "smooth", block: "center" });
        f.qty.focus();
      }));
  }

  // ---------- ПОРТФЕЛЬ ----------
  async _renderPortfolio(main) {
    const [positions, lots, sales, reinvest] = await Promise.all([
      this._api("GET", "positions"),
      this._api("GET", "lots"),
      this._api("GET", "sales"),
      this._api("GET", "reinvest").then((r) => r || []).catch(() => []),
    ]);
    this._reinvestAll = reinvest;
    this._rv.page = 1;
    main.innerHTML = `
      ${reinvest.length ? `<div class="card" id="reinvestCard">
        <h2>Помічник реінвестиції</h2>
        <div class="muted" style="margin-bottom:10px">Доступні папери під твій план: валюта, яку треба добрати → рік з «діркою» в драбині → ставка. «Дохідність» = купонна ставка (ОВДП біля номіналу). Обери й тисни «Взяти».</div>
        <div class="rv-controls">
          <select data-f="cur">${this._rvOptions("cur", "Валюта: всі")}</select>
          <select data-f="year">${this._rvOptions("year", "Рік: всі")}</select>
          <input data-f="minRate" inputmode="decimal" placeholder="Ставка ≥, %" value="${esc(this._rv.minRate)}">
          <input data-f="q" placeholder="Пошук ISIN" value="${esc(this._rv.q)}">
          <select data-f="pageSize">
            ${[10, 25, 50].map((n) => `<option value="${n}"${this._rv.pageSize === n ? " selected" : ""}>${n}/стор.</option>`).join("")}
            <option value="all"${this._rv.pageSize === "all" ? " selected" : ""}>усі</option>
          </select>
        </div>
        <div id="rvTable"></div>
      </div>` : ""}
      <div class="card">
        <h2>Нова покупка</h2>
        <form id="lotForm">
          <label style="position:relative">ISIN<input name="isin" required placeholder="UA4000..." autocomplete="off">
            <div id="bondSuggest" class="suggest"></div></label>
          <label>Кількість<input name="qty" type="number" min="1" step="1" required></label>
          <label>Ціна за папір (брудна)<input name="price_per_bond" inputmode="decimal" placeholder="995.00" required></label>
          <label>Комісія (сумарно)<input name="fee" inputmode="decimal" placeholder="0.00"></label>
          <label>Валюта<select name="currency">
            <option value="">авто (з довідника)</option>
            <option value="UAH">UAH</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select></label>
          <label>Дата купівлі<input name="buy_date" type="date" value="${today()}" required></label>
          <label>Канал<input name="channel" placeholder="Дія…"></label>
          <label>Нотатка<input name="note"></label>
          <button type="submit">Додати</button>
        </form>
        <div class="muted" id="bondInfo" style="margin-top:8px"></div>
      </div>

      <div class="card">
        <h2>Позиції</h2>
        ${positions.length ? `<table><thead><tr>
          <th>ISIN</th><th class="num">К-сть</th><th class="num">Вкладено</th><th class="num">Номінал</th>
          <th>Погашення</th><th class="num">Днів</th><th>Наст. виплата</th></tr></thead><tbody>
          ${positions.map((p) => `<tr>
            <td>${esc(p.isin)}</td><td class="num">${p.qty}</td><td class="num">${fmtMoney(p.invested)}</td>
            <td class="num">${fmtMoney(p.nominal)}</td><td>${esc(p.maturity)}</td><td class="num">${p.days_to_maturity}</td>
            <td>${p.next_pay_date ? esc(p.next_pay_date) + " · " + fmtMoney(p.next_pay_amount) : "—"}</td></tr>`).join("")}
          </tbody></table>` : `<div class="muted">Позицій немає.</div>`}
      </div>

      <div class="card">
        <h2>Лоти</h2>
        ${lots.length ? `<table><thead><tr>
          <th>ID</th><th>ISIN</th><th class="num">К-сть</th><th class="num">Залишок</th><th class="num">Ціна</th>
          <th class="num">Комісія</th><th>Куплено</th><th>Канал</th><th></th></tr></thead><tbody>
          ${lots.map((l) => `<tr>
            <td>${l.id}</td><td>${esc(l.isin)}</td><td class="num">${l.qty}</td><td class="num">${l.remaining}</td>
            <td class="num">${fmtMoney(l.price_per_bond)}</td><td class="num">${fmtMoney(l.fee)}</td>
            <td>${esc(l.buy_date)}</td><td>${esc(l.channel || "")}</td>
            <td class="row-actions"><button class="sm warn" data-del="${l.id}">✕</button></td></tr>`).join("")}
          </tbody></table>` : `<div class="muted">Лотів немає.</div>`}
      </div>

      <div class="card">
        <h2>Продаж (вторинний ринок)</h2>
        <form id="saleForm">
          <label>Лот<select name="lot_id" required>
            <option value="">— лот —</option>
            ${lots.filter((l) => l.remaining > 0).map((l) =>
              `<option value="${l.id}" data-cur="${l.price_per_bond.currency}">#${l.id} · ${esc(l.isin)} · зал. ${l.remaining}</option>`).join("")}
          </select></label>
          <label>Дата продажу<input name="sale_date" type="date" value="${today()}" required></label>
          <label>Кількість<input name="qty" type="number" min="1" step="1" required></label>
          <label>Чиста ціна/папір<input name="clean_per_bond" inputmode="decimal" placeholder="1001.50" required></label>
          <label>НКД (сумарно)<input name="accrued" inputmode="decimal" placeholder="0.00"></label>
          <label>Нотатка<input name="note"></label>
          <button type="submit">Записати</button>
        </form>
        ${sales.length ? `<table style="margin-top:14px"><thead><tr>
          <th>Дата</th><th>ISIN</th><th class="num">К-сть</th><th class="num">Чиста</th>
          <th class="num">НКД</th><th class="num">Результат</th></tr></thead><tbody>
          ${sales.map((s) => `<tr>
            <td>${esc(s.sale_date)}</td><td>${esc(s.isin)}</td><td class="num">${s.qty}</td>
            <td class="num">${fmtMoney(s.clean_per_bond)}</td><td class="num">${fmtMoney(s.accrued)}</td>
            <td class="num">${fmtMoney(s.realized_result)}</td></tr>`).join("")}</tbody></table>` : ""}
      </div>
    `;

    main.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Видалити лот #" + b.dataset.del + "?")) return;
        try { await this._api("DELETE", "lots/" + b.dataset.del); this._toast("Лот видалено"); this._loadTab(); }
        catch (err) { this._toast(String(err.message || err), false); }
      }));

    const rvCard = main.querySelector("#reinvestCard");
    if (rvCard) {
      rvCard.querySelectorAll("[data-f]").forEach((el) => {
        const ev = el.tagName === "SELECT" ? "change" : "input";
        el.addEventListener(ev, () => {
          const f = el.dataset.f;
          this._rv[f] = f === "pageSize" ? (el.value === "all" ? "all" : parseInt(el.value, 10)) : el.value;
          this._rv.page = 1;
          this._rvRender(main);
        });
      });
      this._rvRender(main);
    }


    const isinInput = main.querySelector('input[name="isin"]');
    const sug = main.querySelector("#bondSuggest");
    const hideSug = () => sug.classList.remove("show");
    let dbt;
    isinInput.addEventListener("input", () => {
      clearTimeout(dbt);
      const q = isinInput.value.trim();
      if (q.length < 2) { hideSug(); return; }
      dbt = setTimeout(async () => {
        try {
          const bonds = await this._api("GET", "bonds/search?q=" + encodeURIComponent(q));
          if (!bonds || !bonds.length) { hideSug(); return; }
          sug.innerHTML = bonds.map((b) =>
            `<div class="suggest-item" data-isin="${esc(b.isin)}">${esc(b.isin)} · ${esc(b.descr || "")} · ${b.rate_pct}% · до ${esc(b.maturity)}</div>`).join("");
          sug.classList.add("show");
        } catch (_) { hideSug(); }
      }, 300);
    });
    sug.addEventListener("mousedown", (e) => {
      const it = e.target.closest("[data-isin]");
      if (!it) return;
      e.preventDefault();
      isinInput.value = it.dataset.isin;
      hideSug();
      isinInput.dispatchEvent(new Event("change"));
    });
    isinInput.addEventListener("blur", () => setTimeout(hideSug, 150));

    // авто-заповнення з довідника при виборі ISIN — далі лише коригуєш
    isinInput.addEventListener("change", async () => {
      const isin = isinInput.value.trim();
      const info = main.querySelector("#bondInfo");
      if (!isin) { if (info) info.textContent = ""; return; }
      try {
        const b = await this._api("GET", "bonds/" + encodeURIComponent(isin));
        if (!b || !b.nominal) return;
        const f = main.querySelector("#lotForm");
        if (["UAH", "USD", "EUR"].includes(b.nominal.currency)) f.currency.value = b.nominal.currency;
        if (!f.price_per_bond.value.trim()) f.price_per_bond.value = b.nominal.amount;
        if (info) info.textContent = `${esc(b.descr || "")} · ${b.rate_pct}% · погашення ${esc(b.maturity)} · номінал ${fmtMoney(b.nominal)}`;
      } catch (_) { if (info) info.textContent = ""; }
    });

    main.querySelector("#lotForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await this._api("POST", "lots", {
          isin: f.isin.value.trim(), qty: parseInt(f.qty.value, 10),
          price_per_bond: f.price_per_bond.value.trim(), fee: f.fee.value.trim(),
          currency: f.currency.value.trim(), buy_date: f.buy_date.value,
          channel: f.channel.value.trim(), note: f.note.value.trim(),
        });
        this._toast("Лот додано"); this._loadTab();
      } catch (err) { this._toast(String(err.message || err), false); }
    });

    main.querySelector("#saleForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const opt = f.lot_id.selectedOptions[0];
      try {
        await this._api("POST", "sales", {
          lot_id: parseInt(f.lot_id.value, 10), sale_date: f.sale_date.value,
          qty: parseInt(f.qty.value, 10), clean_per_bond: f.clean_per_bond.value.trim(),
          accrued: f.accrued.value.trim(), currency: opt ? opt.dataset.cur : "UAH",
          note: f.note.value.trim(),
        });
        this._toast("Продаж записано"); this._loadTab();
      } catch (err) { this._toast(String(err.message || err), false); }
    });
  }

  // ---------- РАХУНОК ----------
  async _renderAccount(main) {
    const [deposits, conversions] = await Promise.all([
      this._api("GET", "deposits").catch(() => []),
      this._api("GET", "conversions").catch(() => []),
    ]);
    const s = this._summary || {};
    const a = s.accounts || {};
    const curOpts = (sel) => ["UAH", "USD", "EUR"].map((c) => `<option${c === sel ? " selected" : ""}>${c}</option>`).join("");
    const moves = [
      ...deposits.map((d) => ({ date: d.date, id: d.id, kind: "dep", amount: d.amount, note: d.note })),
      ...conversions.map((c) => ({ date: c.date, id: c.id, kind: "conv", from: c.from, to: c.to, note: c.note })),
    ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.id - x.id));
    main.innerHTML = `
      <div class="card">
        <h2>Рахунок (гаманець)</h2>
        <div class="tiles" style="margin:0 0 4px">
          <div class="tile"><div class="lbl">UAH</div><div class="val">${fmtUAH(a.UAH || 0)}</div></div>
          <div class="tile"><div class="lbl">USD</div><div class="val">${fmtCur(a.USD || 0, "$")}</div></div>
          <div class="tile"><div class="lbl">EUR</div><div class="val">${fmtCur(a.EUR || 0, "€")}</div></div>
          <div class="tile"><div class="lbl">Разом (грн-екв.)</div><div class="val">${fmtUAH(s.account_uah || 0)}</div></div>
        </div>
      </div>

      <div class="card">
        <h2>Додати рух</h2>
        <div class="muted" style="margin-bottom:10px">Поповнення (+) / зняття (−) у своїй валюті. Купівля лота й купони рухають рахунок автоматично.</div>
        <form id="depForm">
          <label>Сума (+ / −)<input name="amount" inputmode="decimal" placeholder="5000.00" required></label>
          <label>Валюта<select name="currency">${curOpts("UAH")}</select></label>
          <label>Дата<input name="date" type="date" value="${today()}"></label>
          <label>Нотатка<input name="note"></label>
          <button type="submit">Записати</button>
        </form>
      </div>

      <div class="card">
        <h2>Конвертація валют</h2>
        <div class="muted" style="margin-bottom:10px">Віддав → отримав (курс рахується сам із сум — те, що реально сталося на Monobank).</div>
        <form id="convForm">
          <label>Віддав<input name="from_amount" inputmode="decimal" placeholder="40000.00" required></label>
          <label>Валюта<select name="from_currency">${curOpts("UAH")}</select></label>
          <label>Отримав<input name="to_amount" inputmode="decimal" placeholder="1000.00" required></label>
          <label>Валюта<select name="to_currency">${curOpts("USD")}</select></label>
          <label>Дата<input name="date" type="date" value="${today()}"></label>
          <label>Нотатка<input name="note"></label>
          <button type="submit">Записати</button>
        </form>
      </div>

      <div class="card">
        <h2>Історія рухів</h2>
        ${moves.length ? `<table><thead><tr>
          <th>Дата</th><th>Тип</th><th>Сума</th><th>Нотатка</th><th></th></tr></thead><tbody>
          ${moves.map((m) => {
            if (m.kind === "dep") {
              const label = Number(m.amount.amount) >= 0 ? "Поповнення" : "Зняття";
              return `<tr><td>${esc(m.date)}</td><td>${label}</td><td class="num">${fmtMoney(m.amount)}</td>
                <td>${esc(m.note || "")}</td>
                <td class="row-actions"><button class="sm warn" data-deldep="${m.id}">✕</button></td></tr>`;
            }
            const rate = Number(m.from.amount) / Number(m.to.amount);
            return `<tr><td>${esc(m.date)}</td><td>Конвертація</td>
              <td class="num">${fmtMoney(m.from)} → ${fmtMoney(m.to)}</td>
              <td>${esc(m.note || "")}${isFinite(rate) ? ` (${rate.toFixed(4)})` : ""}</td>
              <td class="row-actions"><button class="sm warn" data-delconv="${m.id}">✕</button></td></tr>`;
          }).join("")}</tbody></table>` : `<div class="muted">Рухів ще немає.</div>`}
      </div>`;

    main.querySelector("#depForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await this._api("POST", "deposits", {
          amount: f.amount.value.trim(), currency: f.currency.value, date: f.date.value, note: f.note.value.trim(),
        });
        this._toast("Рух записано"); this._loadTab();
      } catch (err) { this._toast(String(err.message || err), false); }
    });
    main.querySelector("#convForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await this._api("POST", "conversions", {
          from_amount: f.from_amount.value.trim(), from_currency: f.from_currency.value,
          to_amount: f.to_amount.value.trim(), to_currency: f.to_currency.value,
          date: f.date.value, note: f.note.value.trim(),
        });
        this._toast("Конвертацію записано"); this._loadTab();
      } catch (err) { this._toast(String(err.message || err), false); }
    });
    main.querySelectorAll("[data-deldep]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await this._api("DELETE", "deposits/" + b.dataset.deldep); this._toast("Рух видалено"); this._loadTab(); }
        catch (err) { this._toast(String(err.message || err), false); }
      }));
    main.querySelectorAll("[data-delconv]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await this._api("DELETE", "conversions/" + b.dataset.delconv); this._toast("Конвертацію видалено"); this._loadTab(); }
        catch (err) { this._toast(String(err.message || err), false); }
      }));
  }

  // ---------- КАЛЕНДАР ----------
  async _renderCalendar(main) {
    const cal = await this._api("GET", "calendar?from=1970-01-01");
    const now = today();
    const rows = cal.slice().sort((a, b) => a.date.localeCompare(b.date));
    main.innerHTML = `
      <div class="card">
        <h2>Виплати</h2>
        <div class="muted" style="margin-bottom:10px">Минулі виплати можна позначати отримано / перевкладено.</div>
        ${rows.length ? `<table><thead><tr>
          <th>Дата</th><th>ISIN</th><th>Тип</th><th class="num">Сума</th><th>Статус</th><th></th></tr></thead><tbody>
          ${rows.map((c) => {
            const past = c.date <= now;
            const st = c.status || "";
            const pill = st === "reinvested" ? `<span class="pill reinv">перевкладено</span>`
              : st === "received" ? `<span class="pill recv">отримано</span>` : `<span class="muted">—</span>`;
            return `<tr>
              <td>${esc(c.date)}</td><td>${esc(c.isin)}</td>
              <td><span class="pill ${PAY_CLASS[c.type] || ""}">${PAY_TYPES[c.type] || c.type}</span></td>
              <td class="num">${fmtMoney(c.amount)}</td><td>${pill}</td>
              <td class="row-actions">${past ? `
                <button class="sm" data-isin="${esc(c.isin)}" data-date="${esc(c.date)}" data-st="received">Отримано</button>
                <button class="sm" data-isin="${esc(c.isin)}" data-date="${esc(c.date)}" data-st="reinvested">Перевкл.</button>` : ""}</td>
            </tr>`;
          }).join("")}</tbody></table>` : `<div class="muted">Виплат немає.</div>`}
      </div>`;
    main.querySelectorAll("[data-st]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await this._api("POST", "payments/status", { isin: b.dataset.isin, pay_date: b.dataset.date, status: b.dataset.st });
          this._toast("Статус збережено"); this._loadTab();
        } catch (err) { this._toast(String(err.message || err), false); }
      }));
  }

  // ---------- ДРАБИНА ----------
  async _renderLadder(main) {
    const lad = (this._summary && this._summary.ladder) || [];
    const maxV = Math.max(1, ...lad.map((r) => Math.max(r.uah || 0, r.usd || 0, r.eur || 0)));
    const bar = (v, color) => v > 0
      ? `<span class="bar" style="width:${Math.max(4, (v / maxV) * 120)}px;background:${color}"></span>` : "";
    const fx = (v, sym) => v ? Number(v).toLocaleString("uk-UA", { minimumFractionDigits: 2 }) + " " + sym : "—";
    main.innerHTML = `
      <div class="card">
        <h2>Драбина погашень</h2>
        <div class="muted" style="margin-bottom:10px">Скільки номіналу повертається за роками (окремо UAH / USD / EUR).</div>
        ${lad.length ? `<table><thead><tr>
          <th>Рік</th><th class="num">UAH</th><th></th><th class="num">USD</th><th></th><th class="num">EUR</th><th></th></tr></thead><tbody>
          ${lad.map((r) => `<tr>
            <td>${r.year}</td>
            <td class="num">${r.uah ? fmtUAH(r.uah) : "—"}</td><td>${bar(r.uah, "var(--primary-color)")}</td>
            <td class="num">${fx(r.usd, "$")}</td><td>${bar(r.usd, "var(--info-color,#039be5)")}</td>
            <td class="num">${fx(r.eur, "€")}</td><td>${bar(r.eur, "var(--warning-color,#ffa600)")}</td></tr>`).join("")}</tbody></table>`
          : `<div class="muted">Драбина порожня — додайте папери в портфель.</div>`}
      </div>`;
  }

  // ---------- ДИНАМІКА ----------
  _compact(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + "М";
    if (a >= 1e3) return Math.round(v / 1e3) + "к";
    return String(Math.round(v));
  }

  _chartSVG(dates, series) {
    const W = 760, H = 300, P = { l: 66, r: 14, t: 14, b: 40 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b, n = dates.length;
    let ymax = 0;
    series.forEach((s) => s.values.forEach((v) => { if (v > ymax) ymax = v; }));
    ymax = ymax > 0 ? ymax * 1.1 : 1;
    const x = (i) => P.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
    const y = (v) => P.t + ih - (ih * v) / ymax;
    let grid = "", ylabels = "";
    for (let r = 0; r <= 4; r++) {
      const gv = (ymax * r) / 4, gy = y(gv);
      grid += `<line x1="${P.l}" y1="${gy.toFixed(1)}" x2="${W - P.r}" y2="${gy.toFixed(1)}" stroke="var(--divider-color)" stroke-width="1"/>`;
      ylabels += `<text x="${P.l - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--secondary-text-color)">${this._compact(gv)}</text>`;
    }
    let xlabels = "";
    const step = Math.max(1, Math.floor(n / 5));
    for (let i = 0; i < n; i += step)
      xlabels += `<text x="${x(i).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--secondary-text-color)">${esc(dates[i].slice(5))}</text>`;
    const lines = series.map((s) => {
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" ${s.dash ? 'stroke-dasharray="6 5"' : ""} stroke-linejoin="round"/>`;
    }).join("");
    const legend = series.map((s) =>
      `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:13px">
        <span style="width:16px;height:3px;background:${s.color};display:inline-block"></span>${esc(s.name)}</span>`).join("");
    return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:520px;height:auto">
      ${grid}${ylabels}${xlabels}${lines}</svg></div><div style="margin-top:8px">${legend}</div>`;
  }

  async _renderDynamics(main) {
    const snaps = await this._api("GET", "snapshots");
    if (!snaps || snaps.length < 2) {
      main.innerHTML = `<div class="card"><h2>Портфель у часі (добові знімки)</h2>
        <div class="muted">Замало знімків для графіка. Вони пишуться щодня о 06:10
        (або одразу, коли натиснути «↻ Оновити НБУ») — лінія з'явиться, щойно буде ≥2 знімки.${snaps && snaps.length === 1 ? " Наразі є 1." : ""}</div></div>`;
      return;
    }
    const dates = snaps.map((s) => s.date);
    // План — накопичувальна сума фактично діючих цілей: кожен день додає
    // target_того_дня / днів_у_місяці. Тож зміна цілі впливає лише вперед,
    // а минула частина лінії лишається такою, якою план був тоді.
    const daysInMonth = (ds) => { const p = ds.split("-"); return new Date(+p[0], +p[1], 0).getDate(); };
    let acc = 0, anyTarget = false;
    const plan = snaps.map((s) => {
      const t = s.month_target_uah || 0;
      if (t > 0) anyTarget = true;
      acc += t / daysInMonth(s.date);
      return acc;
    });
    const series = [
      { name: "Вкладено (грн-екв.)", color: "var(--primary-color)", values: snaps.map((s) => s.invested_uah) },
      { name: "Номінал", color: "var(--info-color, #039be5)", values: snaps.map((s) => s.nominal_uah_eq) },
      { name: "Рахунок", color: "#8e24aa", values: snaps.map((s) => s.account_uah || 0) },
    ];
    if (anyTarget) series.push({ name: "План (накопич.)", color: "var(--warning-color, #ffa600)", values: plan, dash: true });
    main.innerHTML = `
      <div class="card"><h2>Портфель у часі · факт vs план</h2>${this._chartSVG(dates, series)}</div>
      <div class="card"><h2>Останні знімки</h2>
        <table><thead><tr><th>Дата</th><th class="num">Вкладено</th><th class="num">Номінал</th>
          <th class="num">Частка USD</th><th class="num">Не перевкл.</th></tr></thead>
        <tbody>${snaps.slice(-14).reverse().map((s) => `<tr>
          <td>${esc(s.date)}</td><td class="num">${fmtUAH(s.invested_uah)}</td><td class="num">${fmtUAH(s.nominal_uah_eq)}</td>
          <td class="num">${(s.usd_share_pct || 0).toFixed(1)}%</td><td class="num">${fmtUAH(s.uninvested_uah)}</td></tr>`).join("")}</tbody></table>
      </div>`;
  }

  // ---------- ПРОЄКЦІЇ ----------
  _fv(P0, C, annualPct, months) {
    const i = annualPct / 100 / 12;
    if (i <= 0) return P0 + C * months;
    const g = Math.pow(1 + i, months);
    return P0 * g + C * (g - 1) / i;
  }
  _requiredC(goal, P0, annualPct, months) {
    if (months <= 0) return null;
    const i = annualPct / 100 / 12;
    if (i <= 0) return (goal - P0) / months;
    const g = Math.pow(1 + i, months);
    return (goal - P0 * g) / ((g - 1) / i);
  }

  async _renderProjection(main) {
    const s = this._summary || {};
    const st = s.settings || {};
    const P0 = (s.nominal_uah_eq || 0) + (s.account_uah || 0);
    const C = s.month_target_uah || 0;
    const xirr = (s.xirr || {}).UAH;
    const assumed = st.assumed_rate_pct;
    const rate = (xirr != null && xirr > 0) ? xirr : (assumed || 0);
    const rateSrc = (xirr != null && xirr > 0) ? `XIRR ${xirr.toFixed(1)}%`
      : (assumed ? `очікувана ${assumed}%` : "ставка не задана");

    const rows = [1, 3, 5, 10].map((y) => {
      const n = y * 12;
      const base = P0 + C * n;
      const fv = this._fv(P0, C, rate, n);
      return `<tr><td>${y} р.</td><td class="num">${fmtUAH(base)}</td>
        <td class="num">${fmtUAH(fv)}</td><td class="num">${fmtUAH(fv - base)}</td></tr>`;
    }).join("");

    let goalHtml = `<div class="muted">Задай цільову суму й дату в «Налаштуваннях», щоб бачити трекер цілі.</div>`;
    if (st.goal_amount_uah && st.goal_date) {
      const now = new Date();
      const gd = new Date(st.goal_date);
      const months = Math.max(0, Math.round((gd - now) / (1000 * 60 * 60 * 24 * 30.4375)));
      const proj = this._fv(P0, C, rate, months);
      const diff = proj - st.goal_amount_uah;
      const reqC = this._requiredC(st.goal_amount_uah, P0, rate, months);
      const verdict = diff >= 0
        ? `<span style="color:var(--success-color,#43a047)">на шляху ✅ (запас ${fmtUAH(diff)})</span>`
        : `<span style="color:var(--error-color,#db4437)">бракує ${fmtUAH(-diff)}</span> — потрібно ≈ <b>${fmtUAH(Math.max(0, reqC))}</b>/міс (зараз ${fmtUAH(C)})`;
      goalHtml = `<div class="tiles" style="margin:0 0 10px">
          <div class="tile"><div class="lbl">Ціль</div><div class="val">${fmtUAH(st.goal_amount_uah)}</div></div>
          <div class="tile"><div class="lbl">Дата</div><div class="val">${esc(st.goal_date)}</div></div>
          <div class="tile"><div class="lbl">Місяців лишилось</div><div class="val">${months}</div></div>
          <div class="tile"><div class="lbl">Прогноз на дату</div><div class="val">${fmtUAH(proj)}</div></div>
        </div>
        <div>${verdict}</div>`;
    }

    main.innerHTML = `
      <div class="card">
        <h2>Проєкції капіталу</h2>
        <div class="muted" style="margin-bottom:10px">Старт = капітал ${fmtUAH(P0)}, внесок = ${fmtUAH(C)}/міс, ставка = ${rateSrc} (реінвест щомісяця). Це припущення, не гарантія.</div>
        <table><thead><tr><th>Горизонт</th><th class="num">Внесено (без %)</th><th class="num">З реінвестом</th><th class="num">Приріст</th></tr></thead>
          <tbody>${rows}</tbody></table>
      </div>
      <div class="card">
        <h2>Ціль</h2>
        ${goalHtml}
      </div>`;
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
          <label>Цільова частка EUR, %<input name="eur_target_share_pct" inputmode="decimal" value="${esc(s.eur_target_share_pct || "")}"></label>
          <label>Очікувана дохідність, %<input name="assumed_rate_pct" inputmode="decimal" placeholder="16" value="${esc(s.assumed_rate_pct || "")}"></label>
          <label>Ціль: сума, ₴<input name="goal_amount_uah" inputmode="decimal" value="${esc(s.goal_amount_uah || "")}"></label>
          <label>Ціль: дата<input name="goal_date" type="date" value="${esc(s.goal_date || "")}"></label>
          <button type="submit">Зберегти</button>
        </form>
      </div>`;
    main.querySelector("#setForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await this._api("PUT", "settings", {
          monthly_target_uah: f.monthly_target_uah.value.trim(),
          usd_target_share_pct: f.usd_target_share_pct.value.trim(),
          eur_target_share_pct: f.eur_target_share_pct.value.trim(),
          assumed_rate_pct: f.assumed_rate_pct.value.trim(),
          goal_amount_uah: f.goal_amount_uah.value.trim(),
          goal_date: f.goal_date.value.trim(),
        });
        this._toast("Налаштування збережено"); this._loadTab();
      } catch (err) { this._toast(String(err.message || err), false); }
    });
  }
}

if (!customElements.get("odd-invest-panel")) {
  customElements.define("odd-invest-panel", OddInvestPanel);
}
