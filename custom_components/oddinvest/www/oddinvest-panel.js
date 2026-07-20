// Бічна панель ODD Invest для Home Assistant.
// Повторює концепцію веб-UI бекенда (Портфель / Календар / Драбина /
// Динаміка / Налаштування + постійний рядок зведення), але операції
// йдуть через проксі /api/oddinvest/* -> REST, з HA-авторизацією і темою.

const PAY_TYPES = { 1: "купон", 2: "погашення", 3: "дострокове" };
const PAY_CLASS = { 1: "coupon", 2: "redemption", 3: "early" };
const TABS = [
  ["overview", "Огляд"],
  ["portfolio", "Портфель"],
  ["account", "Рахунок"],
  ["plan", "План"],
  ["future", "Майбутнє"],
  ["settings", "Налаштування"],
];

const fmtUAH = (v) =>
  (Number(v) || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₴";
const fmtCur = (v, cur) =>
  (Number(v) || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + cur;
const fmtMoney = (m) =>
  m ? `${Number(m.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${m.currency}` : "—";
const curSym = (c) => ({ UAH: "₴", USD: "$", EUR: "€" }[c] || c);
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

class OddInvestPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "overview";
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
        .banner { display:flex; align-items:flex-start; gap:12px; border-radius:12px; padding:14px 18px; margin-bottom:12px; }
        .banner .b-ic { font-size:18px; line-height:1.4; }
        .banner .b-tx { flex:1; }
        .banner .b-t { font-size:16px; }
        .banner .b-s { font-size:13px; opacity:.9; margin-top:3px; }
        .banner button { margin-left:auto; align-self:center; white-space:nowrap; }
        .banner.ok { background:var(--success-color,#43a047); color:#fff; }
        .banner.ok button { background:rgba(255,255,255,.24); color:#fff; }
        .banner.wait { background:var(--warning-color,#ffa600); color:#1b1b1b; }
        .banner.neutral { background:var(--card-background-color); border:1px solid var(--divider-color);
                          box-shadow:var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.1)); }
        .quick { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
        .quick button { flex:1; min-width:130px; background:var(--card-background-color);
                        color:var(--primary-text-color); border:1px solid var(--divider-color); }
        .quick button:hover { border-color:var(--primary-color); color:var(--primary-color); }
        .ov-grid { display:grid; grid-template-columns:1.5fr 1fr; gap:12px; align-items:start; }
        @media (max-width:820px) { .ov-grid { grid-template-columns:1fr; } }
        .pv-row { display:flex; justify-content:space-between; font-size:14px; padding:7px 0;
                  border-bottom:1px solid var(--divider-color); }
        .pv-row:last-of-type { border-bottom:none; }
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
      await this._loadSummaryData();
      if (this._tab === "overview") await this._renderOverview(main);
      else if (this._tab === "portfolio") await this._renderPortfolio(main);
      else if (this._tab === "account") await this._renderAccount(main);
      else if (this._tab === "plan") await this._renderPlan(main);
      else if (this._tab === "future") await this._renderFuture(main);
      else if (this._tab === "settings") await this._renderSettings(main);
    } catch (err) {
      main.innerHTML = `<div class="card">Помилка: ${esc(err.message || err)}</div>`;
    }
  }

  // ---------- дані зведення (без рендеру: плитки живуть у розділах) ----------
  async _loadSummaryData() {
    const s = await this._api("GET", "summary");
    this._summary = s;
    const avail = this.shadowRoot.getElementById("avail");
    avail.textContent = s.generated_at ? "стан на " + new Date(s.generated_at).toLocaleString("uk-UA") : "";
  }

  _tile(l, v, extra = "") {
    return `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div>${extra}</div>`;
  }

  // ---------- ОГЛЯД ----------
  // Банер дії показуємо ЗАВЖДИ — він ніколи не порожній і завжди каже,
  // що робити: почати, купити або накопичувати далі.
  _actionBannerHTML() {
    const s = this._summary || {};
    const acc = s.accounts || {}, rmin = s.reinvest_min || {};
    const hasPortfolio = (s.nominal_uah_eq || 0) > 0;
    const ready = Object.keys(rmin).filter((c) => rmin[c] > 0 && (acc[c] || 0) >= rmin[c]);
    const box = (cls, icon, title, sub, btn = "") =>
      `<div class="banner ${cls}"><div class="b-ic">${icon}</div><div class="b-tx">
         <div class="b-t">${title}</div>${sub ? `<div class="b-s">${sub}</div>` : ""}</div>${btn}</div>`;

    if (!hasPortfolio) {
      return box("neutral", "◦", "Почни з першої покупки",
        "Додай папір — і застосунок почне вести драбину, календар і проєкції.",
        `<button data-go="buy">Купити папір</button>`);
    }
    if (ready.length) {
      const parts = ready.map((c) => `<b>${Math.floor(acc[c] / rmin[c])}</b> ${esc(c)}-папер(и)`).join(", ");
      return box("ok", "●", `Можеш купити ${parts}`,
        ready.map((c) => `${esc(c)}: на рахунку ${fmtCur(acc[c], c)}, папір від ${fmtCur(rmin[c], c)}`).join(" · "),
        `<button data-go="buy">Купити</button>`);
    }
    const need = Math.max(0, (s.reinvest_min_uah || 0) - (s.account_uah || 0));
    const np = s.next_payment;
    // Скільки ще накопичувати за поточним темпом внесків — щоб банер казав
    // «коли», а не лише «скільки». Купон, що покриває нестачу, — окремо.
    const perDay = (s.month_target_uah || 0) / 30;
    const days = perDay > 0 ? Math.ceil(need / perDay) : 0;
    const eta = days > 0 ? ` ≈ <b>${days}</b> дн. за твоїм темпом` : "";
    const sub = `На рахунку ${fmtUAH(s.account_uah)}, найдешевший папір ${fmtUAH(s.reinvest_min_uah)}.` +
      (np ? ` Купон ${esc(np.date)} додасть ${Number(np.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${curSym(np.currency)}.` : "");
    return box("wait", "○", `Купувати ще рано — бракує ${fmtUAH(need)}${eta}`, sub);
  }

  // Три цілі з датою досягнення за поточним темпом. Дата — результат
  // симуляції, тож вона рухається разом із реальним темпом накопичення.
  _goalsHTML() {
    const s = this._summary || {};
    const goals = s.goals || [];
    if (!goals.length) {
      return `<div class="card"><h2>Цілі</h2><div class="muted">Задай суми цілей
        (песимістична / реалістична / оптимістична) у «Налаштуваннях» — і тут зʼявиться,
        коли кожна буде досягнута за твоїм темпом.</div></div>`;
    }
    const cap = (s.nominal_uah_eq || 0) + (s.account_uah || 0);
    const rows = goals.map((g) => {
      const pct = g.amount > 0 ? Math.min(100, (cap / g.amount) * 100) : 0;
      let when, color = "var(--secondary-text-color)";
      if (g.months === -1) { when = "вже досягнуто"; color = "var(--success-color,#43a047)"; }
      else if (g.months === 0) { when = "не досягається за 60 років"; color = "var(--error-color,#db4437)"; }
      else {
        const yrs = (g.months / 12).toFixed(1);
        when = `${esc(String(g.date).slice(0, 7))} · через ${yrs} р.`;
        if (g.before_deadline === true) color = "var(--success-color,#43a047)";
        else if (g.before_deadline === false) color = "var(--warning-color,#ffa600)";
      }
      const miss = g.before_deadline === false && g.required_monthly > 0
        ? `<div class="muted" style="font-size:12px;margin-top:2px">пізніше дедлайну — щоб устигнути, треба ${fmtUAH(g.required_monthly)}/міс</div>` : "";
      const fact = g.months_actual
        ? `<div class="muted" style="font-size:12px;margin-top:2px">за фактичним темпом: ${
            g.months_actual === -1 ? "вже досягнуто"
            : g.months_actual === 0 ? "не досягається"
            : `${esc(String(g.date_actual).slice(0, 7))} · через ${(g.months_actual / 12).toFixed(1)} р.`}</div>` : "";
      const auto = g.auto ? ` <span class="muted" style="font-size:12px">(прогноз на дедлайн)</span>` : "";
      return `<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <span>${esc(g.label)} · <b>${fmtUAH(g.amount)}</b>${auto}</span>
          <span style="font-size:13px;color:${color}">${when}</span>
        </div>
        <div class="progress" style="margin-top:6px"><span style="width:${pct}%"></span></div>
        <div class="muted" style="font-size:12px;margin-top:2px">накопичено ${pct.toFixed(1)}%</div>
        ${fact}${miss}</div>`;
    }).join("");
    const dl = s.settings && s.settings.goal_date
      ? `<div class="muted" style="font-size:12px">Дедлайн: ${esc(String(s.settings.goal_date).slice(0, 7))}</div>` : "";
    return `<div class="card"><h2>Цілі</h2>${rows}${dl}</div>`;
  }

  _paymentsPreviewHTML() {
    const rows = ((this._summary || {}).top_payments || []).slice(0, 4);
    const body = rows.length
      ? rows.map((p) => `<div class="pv-row"><span class="muted">${esc(p.date)}</span>
          <span>${Number(p.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${curSym(p.currency)}</span></div>`).join("")
      : `<div class="muted" style="font-size:13px">Виплат попереду немає.</div>`;
    return `<div class="card"><h2>Найближчі виплати</h2>${body}
      <div class="muted" style="font-size:12px;margin-top:8px">Повний календар — у «Майбутньому»</div></div>`;
  }

  _nbuStaleHTML() {
    const at = (this._summary || {}).nbu_refreshed_at;
    if (!at) return "";
    const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
    if (days < 3) return "";
    return `<div class="banner wait" style="padding:10px 16px"><div class="b-tx">
      <div class="b-s" style="opacity:1">Довідник НБУ не оновлювався <b>${days} дн.</b> —
      ставки й графіки виплат можуть бути несвіжі. Натисни «↻ Оновити НБУ».</div></div></div>`;
  }

  async _renderOverview(main) {
    const s = this._summary || {};
    const cap = (s.nominal_uah_eq || 0) + (s.account_uah || 0);
    const np = s.next_payment;
    const accrued = s.accrued_uah || 0;
    const tiles = `<div class="tiles" style="margin:0 0 12px;padding:0">
      ${this._tile("Капітал", fmtUAH(cap),
        accrued > 0 ? `<div class="muted" style="font-size:12px;margin-top:4px">+ ${fmtUAH(accrued)} НКД зароблено</div>` : "")}
      ${this._tile("Цей місяць", `${s.month_progress_pct || 0}%`,
        `<div class="progress"><span style="width:${Math.min(100, s.month_progress_pct || 0)}%"></span></div>
         <div class="muted" style="font-size:12px;margin-top:4px">${fmtUAH(s.month_invested_uah)} з ${fmtUAH(s.month_target_uah)}</div>`)}
      ${this._tile("Наступна виплата",
        np ? `${Number(np.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${curSym(np.currency)}` : "—",
        np ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(np.date)}</div>` : "")}
    </div>`;

    const chart = await this._chartBlockHTML();
    main.innerHTML = `
      ${this._nbuStaleHTML()}
      ${this._actionBannerHTML()}
      <div class="quick">
        <button data-go="buy">Купівля</button>
        <button data-go="deposit">Поповнення</button>
        <button data-go="convert">Конвертація</button>
      </div>
      ${tiles}
      ${this._goalsHTML()}
      <div class="ov-grid">${chart}${this._paymentsPreviewHTML()}</div>
      ${this._snapshotsTableHTML()}`;

    main.querySelectorAll("[data-go]").forEach((b) =>
      b.addEventListener("click", () => this._goto(b.dataset.go)));
  }

  // Швидкий перехід у потрібну форму з «Огляду».
  async _goto(what) {
    const map = { buy: "portfolio", deposit: "account", convert: "account" };
    this._tab = map[what] || "portfolio";
    await this._loadTab();
    const sel = { buy: "#lotForm", deposit: "#depForm", convert: "#convForm" }[what];
    const el = this.shadowRoot.querySelector(sel) || this.shadowRoot.querySelector("#lotForm");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const first = el.querySelector && el.querySelector("input");
      if (first) first.focus();
    }
  }

  // ---------- ПОРТФЕЛЬ ----------
  // Канали: задані в Налаштуваннях ∪ ті, що вже зустрічались у лотах.
  // Так новий канал доступний ще до першої покупки, а старі не губляться.
  _channelList(lots) {
    const st = (this._summary || {}).settings || {};
    const set = new Set(String(st.channels || "").split(",").map((c) => c.trim()).filter(Boolean));
    (lots || []).forEach((l) => { if (l.channel) set.add(String(l.channel).trim()); });
    return [...set].sort((a, b) => a.localeCompare(b, "uk"));
  }

  _channelOptions(lots) {
    return `<option value="">—</option>` +
      this._channelList(lots).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("") +
      `<option value="__other__">інший…</option>`;
  }

  async _renderPortfolio(main) {
    const s0 = this._summary || {};
    const [positions, lots, sales, reinvest] = await Promise.all([
      this._api("GET", "positions"),
      this._api("GET", "lots"),
      this._api("GET", "sales"),
    ]);
    // «Дохідність» — очікуване наперед (сер. купон), «XIRR» — фактично
    // реалізоване. Тримаємо поруч, бо сенс саме в порівнянні.
    const py = s0.portfolio_yield || {}, xr = s0.xirr || {};
    const pct = (v) => v != null ? v.toFixed(2) + "%" : "—";
    const xirrTiles = Object.keys(xr).length
      ? Object.entries(xr).map(([c, v]) => this._tile(`XIRR ${curSym(c)}`, pct(v))).join("")
      : this._tile("XIRR", "—",
          `<div class="muted" style="font-size:12px;margin-top:4px">потрібно 30 днів історії</div>`);
    const portTiles = `<div class="tiles" style="margin:0 0 12px;padding:0">
      ${this._tile("Вкладено (грн-екв.)", fmtUAH(s0.invested_uah))}
      ${this._tile("Номінал (грн-екв.)", fmtUAH(s0.nominal_uah_eq))}
      ${this._tile("Накопичений купон", fmtUAH(s0.accrued_uah || 0),
        `<div class="muted" style="font-size:12px;margin-top:4px">зароблено, ще не виплачено</div>`)}
      ${Object.entries(py).map(([c, v]) => this._tile(`Дохідність ${curSym(c)}`, pct(v),
        `<div class="muted" style="font-size:12px;margin-top:4px">очікувана</div>`)).join("")}
      ${xirrTiles}
    </div>`;
    main.innerHTML = `
      ${portTiles}
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
          <label>Канал<select name="channel_sel">${this._channelOptions(lots)}</select>
            <input name="channel" placeholder="назва каналу" style="margin-top:6px;display:none"></label>
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

    // «інший…» відкриває поле для нової назви каналу
    const chSel = main.querySelector('[name="channel_sel"]');
    const chIn = main.querySelector('[name="channel"]');
    if (chSel && chIn) {
      chSel.addEventListener("change", () => {
        const other = chSel.value === "__other__";
        chIn.style.display = other ? "" : "none";
        if (other) { chIn.value = ""; chIn.focus(); }
      });
    }

    main.querySelector("#lotForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const channel = f.channel_sel.value === "__other__"
        ? f.channel.value.trim()
        : f.channel_sel.value.trim();
      try {
        await this._api("POST", "lots", {
          isin: f.isin.value.trim(), qty: parseInt(f.qty.value, 10),
          price_per_bond: f.price_per_bond.value.trim(), fee: f.fee.value.trim(),
          currency: f.currency.value.trim(), buy_date: f.buy_date.value,
          channel: channel, note: f.note.value.trim(),
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
          <div class="tile"><div class="lbl">Не перевкладено</div><div class="val">${fmtUAH(s.uninvested_uah || 0)}</div>
            <div class="muted" style="font-size:12px;margin-top:4px">надійшло й ще не вкладено</div></div>
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

  // ---------- МАЙБУТНЄ: календар + проєкції + ціль ----------
  async _renderFuture(main) {
    await this._renderCalendar(main);
    main.insertAdjacentHTML("beforeend", this._projectionHTML());
  }

  // ---------- ПЛАН ----------
  // Валютне ребалансування: скільки бракує до цільових часток і чи це
  // взагалі досяжно (найдешевший папір може бути більший за цільову суму).
  _rebalanceCard() {
    const rows = (this._summary && this._summary.rebalance) || [];
    if (!rows.length) return "";
    const sym = { USD: "$", EUR: "€" };
    const num = (v, d = 2) => Number(v || 0).toLocaleString("uk-UA", { maximumFractionDigits: d });
    const body = rows.map((r) => {
      const s = sym[r.currency] || r.currency;
      const head = `<b>${esc(r.currency)}</b> — ціль ${r.target_pct}%, зараз ${r.current_pct}%`;
      if (r.deficit_uah <= 0) {
        return `<div style="margin-bottom:12px">${head} — <span style="color:var(--success-color,#43a047)">ціль досягнута ✅</span></div>`;
      }
      const need = `Бракує до цілі: <b>${fmtUAH(r.deficit_uah)}</b> (≈ ${num(r.deficit_native)} ${s})`;
      if (!r.feasible) {
        return `<div style="margin-bottom:12px">${head}<br>${need}<br>
          <span style="color:var(--warning-color,#ffa600)">⚠ Ще зарано:</span> найдешевший ${esc(r.currency)}-папір коштує
          ${fmtUAH(r.bond_cost_uah)} (${num(r.bond_cost_native, 0)} ${s}) — це більше за всю цільову суму.
          Один такий папір вписався б у ціль ${r.target_pct}% при капіталі <b>${fmtUAH(r.min_portfolio_uah)}</b>.</div>`;
      }
      const buy = r.can_buy > 0
        ? `вистачає на <b>${r.can_buy}</b> папер(и)`
        : `на папір бракує — сконвертуй ще ≈ <b>${fmtUAH(r.convert_uah)}</b>`;
      return `<div style="margin-bottom:12px">${head}<br>${need}<br>
        Найдешевший папір: ${num(r.bond_cost_native, 0)} ${s} ≈ ${fmtUAH(r.bond_cost_uah)}.
        Готівка: ${num(r.cash_native)} ${s} — ${buy}.</div>`;
    }).join("");
    return `<div class="card"><h2>Валютне ребалансування</h2>
      <div class="muted" style="margin-bottom:10px">Частки рахуються від сукупного капіталу (номінал + рахунок).</div>
      ${body}</div>`;
  }

  // Процентний ризик: дюрація за реальним графіком виплат + сценарії.
  _rateRiskCard() {
    const rr = this._summary && this._summary.rate_risk;
    if (!rr || !rr.duration_years) return "";
    const scen = (rr.scenarios || []).map((x) => {
      const col = x.change_pct >= 0 ? "var(--success-color,#43a047)" : "var(--error-color,#db4437)";
      const sgn = v => (v > 0 ? "+" : "");
      return `<tr><td>${sgn(x.delta_pp)}${x.delta_pp} п.п.</td>
        <td class="num" style="color:${col}">${sgn(x.change_pct)}${x.change_pct}%</td>
        <td class="num" style="color:${col}">${sgn(x.change_uah)}${fmtUAH(x.change_uah)}</td></tr>`;
    }).join("");
    const st = (this._summary && this._summary.settings) || {};
    const tgt = Number(st.target_duration_years || 0);
    let tgtHint = "";
    if (tgt > 0) {
      const d = rr.duration_years - tgt;
      tgtHint = Math.abs(d) < 0.15
        ? `<div style="margin-bottom:10px;color:var(--success-color,#43a047)">Дюрація на цілі: ${rr.duration_years} ≈ ${tgt} р. ✅</div>`
        : `<div style="margin-bottom:10px">Зараз <b>${rr.duration_years}</b> → ціль <b>${tgt}</b> р. —
           щоб зійтись, бери <b>${d < 0 ? "довші" : "коротші"}</b> папери.</div>`;
    }
    return `<div class="card"><h2>Ризик ставок</h2>
      <div class="tiles" style="margin:0 0 10px">
        <div class="tile"><div class="lbl">Дюрація (Маколея)</div><div class="val">${rr.duration_years} р.</div></div>
        <div class="tile"><div class="lbl">Цільова дюрація</div><div class="val">${tgt > 0 ? tgt + " р." : "—"}</div></div>
        <div class="tile"><div class="lbl">Модифікована</div><div class="val">${rr.modified_dur}</div></div>
        <div class="tile"><div class="lbl">Приведена вартість</div><div class="val">${fmtUAH(rr.pv_uah)}</div></div>
      </div>
      ${tgtHint}
      <table><thead><tr><th>Зміна ставок</th><th class="num">Вартість</th><th class="num">У грошах</th></tr></thead>
        <tbody>${scen}</tbody></table>
      <div class="muted" style="margin-top:8px;font-size:13px">Дюрація — середньозважений строк повернення грошей.
        Модифікована показує, на скільки % змінюється вартість при зміні ставок на 1 п.п.
        <b>Тримаєш до погашення — просадка лише паперова</b>: ризик реалізується при продажі на вторинці.</div>
    </div>`;
  }

  async _renderPlan(main) {
    const s = this._summary || {};
    const st = s.settings || {};
    const shareTile = (lbl, cur, tgt) => this._tile(lbl, (cur || 0).toFixed(1) + "%",
      tgt ? `<div class="muted" style="font-size:12px;margin-top:4px">ціль ${tgt}%</div>` : "");
    const shares = `<div class="tiles" style="margin:0 0 12px;padding:0">
      ${shareTile("Частка USD", s.usd_share_pct, st.usd_target_share_pct)}
      ${shareTile("Частка EUR", s.eur_share_pct, st.eur_target_share_pct)}
    </div>`;
    const lad = (this._summary && this._summary.ladder) || [];
    const maxV = Math.max(1, ...lad.map((r) => Math.max(r.uah || 0, r.usd || 0, r.eur || 0)));
    const bar = (v, color) => v > 0
      ? `<span class="bar" style="width:${Math.max(4, (v / maxV) * 120)}px;background:${color}"></span>` : "";
    const fx = (v, sym) => v ? Number(v).toLocaleString("uk-UA", { minimumFractionDigits: 2 }) + " " + sym : "—";
    main.innerHTML = `
      ${shares}
      ${this._rebalanceCard()}
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
      </div>
      ${this._rateRiskCard()}`;
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

  _snapNonZero(s) {
    return (s.invested_uah || 0) > 0 || (s.nominal_uah_eq || 0) > 0 || (s.account_uah || 0) > 0;
  }

  // Блок «Як росте» — живе на «Огляді» (дивишся часто, окрема вкладка зайва).
  async _chartBlockHTML() {
    const all = await this._api("GET", "snapshots").catch(() => []);
    // Порожні знімки до появи портфеля (зроблені автоматично о 06:10 ще без
    // даних) не малюємо — інакше вони «якорять» графік у нулі й лінія
    // виглядає як фейковий стрибок 0 → капітал за один день.
    let i = 0;
    while (i < (all || []).length && !this._snapNonZero(all[i])) i++;
    const snaps = (all || []).slice(i);
    this._snapsCache = snaps;
    if (snaps.length < 2) {
      return `<div class="card"><h2>Як росте</h2>
        <div class="muted">Крива будується з добових знімків (пишуться щодня о 06:10,
        або одразу після «↻ Оновити НБУ»). Потрібно ≥2 знімки з даними — наразі ${snaps.length}.
        Порожні знімки до появи портфеля не рахуються.</div></div>`;
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
      { name: "Вкладено (грн-екв.)", color: "#4da3ff", values: snaps.map((s) => s.invested_uah) },
      { name: "Номінал", color: "#2ecc71", values: snaps.map((s) => s.nominal_uah_eq) },
      { name: "Рахунок", color: "#8e24aa", values: snaps.map((s) => s.account_uah || 0) },
    ];
    if (anyTarget) series.push({ name: "План (накопич.)", color: "var(--warning-color, #ffa600)", values: plan, dash: true });
    const x = (this._summary || {}).xirr || {};
    const xp = Object.entries(x).filter(([, v]) => v != null).map(([c, v]) => `${curSym(c)} ${v.toFixed(2)}%`);
    const xirrLine = xp.length
      ? `Фактична дохідність (XIRR): <b>${xp.join(" · ")}</b> — деталі у «Портфелі»`
      : `Фактична дохідність (XIRR) з'явиться, коли набереться 30 днів історії`;
    return `<div class="card"><h2>Як росте</h2>${this._chartSVG(dates, series)}
      <div class="muted" style="margin-top:8px;font-size:13px">«План (накопич.)» — цільовий темп вкладень наростаючим підсумком (місячна ціль ÷ дні місяця). Факт вище пунктиру = випереджаєш план, нижче = відстаєш.</div>
      <div class="muted" style="margin-top:8px;font-size:13px;border-top:1px solid var(--divider-color);padding-top:8px">${xirrLine}</div></div>`;
  }

  _snapshotsTableHTML() {
    const snaps = this._snapsCache || [];
    if (snaps.length < 2) return "";
    return `<div class="card"><h2>Останні знімки</h2>
      <table><thead><tr><th>Дата</th><th class="num">Вкладено</th><th class="num">Номінал</th>
        <th class="num">Частка USD</th><th class="num">Не перевкл.</th></tr></thead>
      <tbody>${snaps.slice(-14).reverse().map((s) => `<tr>
        <td>${esc(s.date)}</td><td class="num">${fmtUAH(s.invested_uah)}</td><td class="num">${fmtUAH(s.nominal_uah_eq)}</td>
        <td class="num">${(s.usd_share_pct || 0).toFixed(1)}%</td><td class="num">${fmtUAH(s.uninvested_uah)}</td></tr>`).join("")}</tbody></table>
    </div>`;
  }

  // ---------- ПРОЄКЦІЇ (блок вкладки «Майбутнє») ----------
  _projectionHTML() {
    const s = this._summary || {};
    const st = s.settings || {};
    const P0 = (s.nominal_uah_eq || 0) + (s.account_uah || 0);
    const C = s.month_target_uah || 0;
    const rowsData = s.projection || [];
    const rate = s.projection_rate_pct || 0;
    const rateSrc = rate > 0 ? `за портфелем ${rate.toFixed(1)}% (сер. купон)` : "додай папери — і дохідність порахується сама";

    const hasActual = (s.actual_monthly_uah || 0) > 0;
    const rows = rowsData.length ? rowsData.map((r) =>
      `<tr><td>${r.years} р.</td><td class="num">${fmtUAH(r.contributed)}</td>
        <td class="num">${fmtUAH(r.with_reinvest)}</td>
        ${hasActual ? `<td class="num">${fmtUAH(r.with_reinvest_actual || 0)}</td>` : ""}
        <td class="num">${fmtUAH(r.with_reinvest - r.contributed)}</td></tr>`).join("")
      : `<tr><td colspan="${hasActual ? 5 : 4}" class="muted">Додай папери й ціль на місяць, щоб побачити проєкцію.</td></tr>`;
    const paceNote = hasActual
      ? `<div class="muted" style="margin-bottom:10px;font-size:13px">Фактичний темп поповнень: <b>${fmtUAH(s.actual_monthly_uah)}/міс</b> за ${s.actual_months} міс історії (план — ${fmtUAH(C)}/міс).</div>`
      : `<div class="muted" style="margin-bottom:10px;font-size:13px">Прогноз за фактичним темпом зʼявиться, коли назбирається 60 днів історії поповнень.</div>`;

    return `
      <div class="card">
        <h2>Проєкції капіталу</h2>
        <div class="muted" style="margin-bottom:10px">Старт = капітал ${fmtUAH(P0)}, внесок = ${fmtUAH(C)}/міс, ставка = ${rateSrc}. Модель: реальні купони й погашення наявних паперів + внески, реінвест під ставку; готівка не працює до реінвесту. Це припущення, не гарантія.</div>
        ${paceNote}
        <table><thead><tr><th>Горизонт</th><th class="num">Внесено (без %)</th>
          <th class="num">За планом</th>${hasActual ? `<th class="num">За фактом</th>` : ""}
          <th class="num">Приріст</th></tr></thead>
          <tbody>${rows}</tbody></table>
      </div>
      ${this._goalsHTML()}`;
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
          <label>Цільова дюрація, років<input name="target_duration_years" inputmode="decimal" placeholder="напр. 3" value="${esc(s.target_duration_years || "")}"></label>
          <label>Канали купівлі (через кому)<input name="channels" placeholder="mono, inzhur" value="${esc(s.channels || "")}"></label>
          <label>Ціль: песимістична, ₴<input name="goal_pessimistic_uah" inputmode="decimal" placeholder="мінімум" value="${esc(s.goal_pessimistic_uah || "")}"></label>
          <label>Ціль: реалістична, ₴<input name="goal_realistic_uah" inputmode="decimal" placeholder="порожньо = прогноз на дедлайн" value="${esc(s.goal_realistic_uah || "")}"></label>
          <label>Ціль: оптимістична, ₴<input name="goal_optimistic_uah" inputmode="decimal" placeholder="мрія" value="${esc(s.goal_optimistic_uah || "")}"></label>
          <label>Дедлайн (необовʼязково)<input name="goal_date" type="date" value="${esc(s.goal_date || "")}"></label>
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
          target_duration_years: f.target_duration_years.value.trim(),
          channels: f.channels.value.trim(),
          goal_pessimistic_uah: f.goal_pessimistic_uah.value.trim(),
          goal_realistic_uah: f.goal_realistic_uah.value.trim(),
          goal_optimistic_uah: f.goal_optimistic_uah.value.trim(),
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
