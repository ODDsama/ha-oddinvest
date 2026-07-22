// Бічна панель ODD Invest для Home Assistant.
// Повторює концепцію веб-UI бекенда (Портфель / Календар / Драбина /
// Динаміка / Налаштування + постійний рядок зведення), але операції
// йдуть через проксі /api/oddinvest/* -> REST, з HA-авторизацією і темою.

const PAY_TYPES = { 1: "купон", 2: "погашення", 3: "дострокове" };
const PAY_CLASS = { 1: "coupon", 2: "redemption", 3: "early" };
const FUND_KIND = { buy: "купівля", sell: "продаж", dividend: "дивіденд" };
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

// --- людські формати дат і строків ---
const MON_NOM = ["січень", "лютий", "березень", "квітень", "травень", "червень",
  "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const MON_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];

// Українська множина: 1 рік / 2-4 роки / 5+ років (з винятком 11-14).
function plural(n, one, few, many) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 10 || h >= 20)) return few;
  return many;
}
// 32 -> «2 роки 8 місяців» (замість «2.6 р.»)
function humanMonths(m) {
  m = Math.max(0, Math.round(m));
  const y = Math.floor(m / 12), mo = m % 12, parts = [];
  if (y) parts.push(`${y} ${plural(y, "рік", "роки", "років")}`);
  if (mo) parts.push(`${mo} ${plural(mo, "місяць", "місяці", "місяців")}`);
  return parts.join(" ") || "менше місяця";
}
// «2029-02-19» -> «лютий 2029»
function monthYear(iso) {
  const p = String(iso || "").split("-");
  if (p.length < 2) return String(iso || "");
  return `${MON_NOM[+p[1] - 1] || p[1]} ${p[0]}`;
}
// «2029-03-17» -> «березня 2027»: родовий відмінок для конструкцій
// «до <місяця>», де називний дав би «до березень».
function monthYearGen(iso) {
  const p = String(iso || "").split("-");
  if (p.length < 2) return String(iso || "");
  return `${MON_GEN[+p[1] - 1] || p[1]} ${p[0]}`;
}

// «2026-07-22» -> «22 липня», а якщо не цьогоріч — «20 січня 2027»,
// бо без року дата наступної виплати читається як «ось-ось».
function dayMonth(iso) {
  const p = String(iso || "").split("-");
  if (p.length < 3) return monthYear(iso);
  const d = `${+p[2]} ${MON_GEN[+p[1] - 1] || p[1]}`;
  return p[0] === String(new Date().getFullYear()) ? d : `${d} ${p[0]}`;
}

// --- пояснення «як це читати» для кожного графіка ---
const INFO = {
  broker: ["Частки по брокерах", "Кільце показує, яка частка вкладеного капіталу лежить у кожного брокера. Розмір сегмента = частка, у легенді — точний % і сума. Рахується за вартістю входу залишків (без готівки)."],
  growth: ["Як росте", "Фактична історія портфеля по днях: скільки вкладено, номінал паперів, гроші на рахунку, і пунктиром — цільовий темп вкладень. Факт вище пунктиру = випереджаєш план. Крива будується, коли є ≥2 добові знімки."],
  ladder: ["Драбина погашень", "Кожен стовпчик — скільки номіналу повертається того року (у грн-екв). Рівномірні стовпчики означають, що гроші рознесені в часі; один високий — усе гаситься одного року. Порожні роки («діри») варто заповнювати новими паперами. Наведи на стовпчик — точна сума."],
  income: ["Дохід по місяцях", "Скільки купонів і погашень надійде кожного місяця на рік наперед (грн-екв). Це твій потік для реінвесту — видно, коли назбирається на наступний папір. Порожній місяць = виплат немає."],
  currency: ["Валюта: факт vs ціль", "Синій стовпчик — поточна частка валюти в портфелі, сірий — твоя цільова частка з Налаштувань. Синій нижчий за сірий → валюту треба добирати; вищий → уже перебір."],
  capital: ["Крива капіталу", "Проєкція капіталу на 1/3/5/10 років. Сіра лінія — просто сума внесків без відсотків, синя — з реінвестом під дохідність портфеля. Розрив між ними — це робота складного відсотка. Модель — припущення, не гарантія."],
  import: ["Імпорт виписки", "Виписка Inzhur у .xlsx. Спершу «Переглянути» — застосунок покаже, що саме додасть, і нічого не запише. Рядки, які вже є в базі, позначені: щомісячна виписка містить і старі операції, тож повторний імпорт нічого не подвоює. Окремо позначаються КОНФЛІКТИ — коли та сама сума вже лежить у гаманці ручним рухом: доки обліку фондів не було, купівлі сертифікатів доводилось записувати як зняття, і тепер така пара порахувалась би двічі; такий ручний запис треба спершу видалити в «Рухах» нижче. Облігації імпорт свідомо пропускає — їх ти вносиш вручну. Жоден рядок не зникає мовчки: усе, що не імпортовано, показано з причиною."],
  reconcile: ["Звірка рахунку", "Введи баланс, який показує брокер, — застосунок порівняє його з тим, що виходить із записів. Розбіжність майже завжди означає одне з двох: плюс — надійшло щось незаписане (поповнення або купон, що прийшов раніше за графік); мінус — витрачено щось незаписане (купівля або комісія). Кнопка створює коригуюче поповнення рівно на різницю з поміткою «звірка», щоб баланс зійшовся, а сама розбіжність лишилась видимою в історії, а не розчинилась. Рахунки брокерів роздільні, тож звіряти треба кожен окремо."],
  funds: ["Сертифікати фондів", "Сертифікати фондів — інший інструмент, ніж ОВДП: немає ні погашення, ні номіналу, ні графіка купонів, зате є ринкова ціна й нерегулярні дивіденди. Ціна береться з останньої твоєї операції — виписка приносить її з собою, тож окреме джерело котирувань не потрібне; між виписками вона застаріває, і дата поруч це показує. Дохідність — ПІСЛЯ податку: дивіденд фонду оподатковується (зараз 14%: ПДФО 9% + військовий збір 5%), а купон ОВДП звільнений, тож до податку порівнювати їх означало б давати фонду фору. «Результат» — прибуток від уже закритих продажів за вирахуванням собівартості й податку."],
  fundops: ["Сертифікати фондів", "Розкладено так само, як облігації: позиції, лоти, продажі — плюс дивіденди, яких у ОВДП немає. Позиція — це стан фонду, а не окрема покупка: сертифікат безстроковий, партії розрізняти нема потреби, тож собівартість середньозважена, і продаж зменшує її пропорційно проданій частці. «Ціна» — з останньої твоєї операції (виписка приносить її з собою), тож між виписками вона старіє, і дата поруч це показує. «Прибуток» — паперовий, різниця ринкової вартості й вкладеного; окремо йде результат уже закритих продажів. «Дохідність» — дивіденди за 365 днів ПІСЛЯ податку до ринкової вартості: дивіденд фонду оподатковується (зараз 14%: ПДФО 9% + військовий збір 5%), а купон ОВДП звільнений, тож до податку порівнювати їх означало б давати фонду фору. Суми всюди ДОДАТНІ, напрямок задає сам розділ: купівля забирає гроші з рахунку брокера, продаж і дивіденд приносять. Податок ставиться окремо (для дивіденда це утримане при виплаті, для продажу — сплачене з прибутку). Імпорт виписки Inzhur пише в ці самі таблиці, тож дублікат видаляється звідси, а операцію, якої у виписці не було, тут же й дописуєш."],
  income: ["Пасивний дохід", "Скільки папери приноситимуть ЩОМІСЯЦЯ — тобто потік, який можна забирати, не проїдаючи тіло. Погашення сюди не входять: повернення номіналу це твої ж гроші, а не дохід. «Зараз» — середній купон за наступні 12 місяців із реального графіка виплат. Далі — симуляція: капітал на кожному горизонті помножений на ставку, під яку він працює на той момент (а вона сповзає до довгострокової). Усе в гривні сьогоднішньої купівельної спроможності, тож числа можна порівнювати з сьогоднішніми витратами. Рядок «за фактом» рахується від твого справжнього темпу поповнень, а не від плану."],
  reinvest: ["Що купити", "Папери відранжовані за РЕАЛЬНОЮ дохідністю — тією, що лишається в сьогоднішніх гривнях після знецінення. Саме вона робить гривневі й валютні папери порівнянними: гривневий під 16% при знеціненні 6%/рік дає ~9.4% реальних, а доларовий під 4% так і лишається 4%, бо долар купівельну спроможність тримає. YTM — дохідність до погашення за ціною входу; вона вища за купонну ставку, бо купон складається всередині року. Ціни в довіднику НБУ немає, тож рахуємо «за номіналом плюс НКД» — реальна ціна в брокера може відрізнятись, і тоді дохідність теж. «mono ×3» означає, скільки таких паперів тягне баланс саме цього брокера: рахунки роздільні, і гривня на inzhur не купить папір у mono. Це інструмент для порівняння, а не порада купувати."],
  forecast: ["Скільки треба вносити", "Головне число рядка — скільки треба вносити щомісяця, щоб дійти до цілі саме за цих допущень. Платіж під ціль один, але ринок вирішує, наскільки він посильний: за кращих ставок і слабшого знецінення ціль коштує дешевше, за гірших — дорожче. Саме тому віяло розкидає ПЛАТІЖ, а не суму на дедлайн: щойно внесок підбирається під ціль, сума на дедлайн у всіх трьох сценаріях однакова — це і є ціль. Рядок «За фактом» показує твій справжній темп поповнень і яку частку потрібного він покриває, а також скільки за ним вийде на дедлайн — там сума вже несе новину. Внески завжди в гривні, навіть у доларовому вигляді: відкладаєш ти гривні. Запис «₴ 15.7% → 11.0%» означає, що ставка не вічна: сьогоднішня це факт, далі вона лінійно сповзає до довгострокової. Кожна валюта рахується окремо у своїй валюті: гривневий рукав наприкінці переводиться в сьогоднішні гроші й тому втрачає, а долар і євро купівельну спроможність тримають."],
};
const infoBtn = (k) => `<button class="info" data-info="${k}" aria-label="Як це читати" title="Як це читати">i</button>`;

// --- маленькі SVG-графіки без бібліотек (sp-DOM, тож малюємо руками) ---
const compactUAH = (v) => { const a = Math.abs(v);
  return a >= 1e6 ? (v / 1e6).toFixed(1).replace(".", ",") + "М" : a >= 1e3 ? Math.round(v / 1e3) + "к" : String(Math.round(v)); };

function svgBars(items, { showVals = false } = {}) {
  const W = 320, H = 170, Pl = 6, Pr = 6, Pt = 18, Pb = 30, iw = W - Pl - Pr, ih = H - Pt - Pb, n = Math.max(1, items.length);
  const max = Math.max(1, ...items.map((i) => i.value)), gap = iw / n, bw = Math.min(46, gap * 0.62);
  let out = "";
  items.forEach((it, i) => {
    const h = it.value / max * ih, x = Pl + gap * i + (gap - bw) / 2, y = Pt + ih - h;
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${it.color || "#4da3ff"}"><title>${esc(it.label)}: ${Math.round(it.value).toLocaleString("uk")} ₴</title></rect>`;
    out += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--secondary-text-color)">${esc(it.label)}</text>`;
    if (showVals && it.value > 0) out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--secondary-text-color)">${compactUAH(it.value)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${out}</svg>`;
}

function svgGrouped(groups) {
  const W = 320, H = 170, Pl = 6, Pr = 6, Pt = 14, Pb = 30, iw = W - Pl - Pr, ih = H - Pt - Pb, n = Math.max(1, groups.length);
  const max = Math.max(1, ...groups.flatMap((g) => [g.a, g.b])), gap = iw / n, bw = Math.min(22, gap * 0.28);
  let out = "";
  groups.forEach((g, i) => {
    const cx = Pl + gap * i + gap / 2;
    [[g.a, "#4da3ff", -bw - 2], [g.b, "#8b949e", 2]].forEach(([v, col, dx]) => {
      const h = v / max * ih, x = cx + dx, y = Pt + ih - h;
      out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${col}"><title>${v.toFixed(1)}%</title></rect>`;
    });
    out += `<text x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--secondary-text-color)">${esc(g.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${out}</svg>`;
}

function svgLine(xlabels, series) {
  const W = 320, H = 170, Pl = 8, Pr = 8, Pt = 14, Pb = 28, iw = W - Pl - Pr, ih = H - Pt - Pb, n = Math.max(1, xlabels.length);
  const max = Math.max(1, ...series.flatMap((s) => s.values)), X = (i) => Pl + (n <= 1 ? iw / 2 : iw * i / (n - 1)), Y = (v) => Pt + ih - v / max * ih;
  const lines = series.map((s) => `<polyline points="${s.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`).join("");
  const xl = xlabels.map((l, i) => `<text x="${X(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--secondary-text-color)">${esc(l)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${lines}${xl}</svg>`;
}
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

class OddInvestPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "overview";
    this._inited = false;
    // Обрана одиниця прогнозу переживає перезавантаження: перемикати її
    // щоразу заново дратує більше, ніж сам перемикач допомагає.
    try { this._fcUnit = localStorage.getItem("oddinvest.fcUnit") || "UAH"; }
    catch (_) { this._fcUnit = "UAH"; }
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
        .unitbox { display:inline-flex; border:1px solid var(--divider-color); border-radius:8px; overflow:hidden; }
        .unitbox .unit { border:0; background:transparent; color:var(--secondary-text-color); font:inherit;
          font-size:13px; padding:2px 10px; cursor:pointer; }
        .unitbox .unit.on { background:var(--primary-color); color:#fff; }
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
        .chart-grid { display:flex; flex-wrap:wrap; gap:16px; margin-bottom:16px; align-items:stretch; }
        .chart-grid > .card { flex:1 1 300px; min-width:0; }
        .chart-grid > .card.wide { flex:2 1 420px; }
        .ov-grid > .card { min-width:0; }
        .chart-grid .card h4 { margin:0 0 8px; font-size:14px; display:flex; align-items:center; justify-content:space-between; }
        .lg { display:flex; gap:18px; flex-wrap:wrap; margin-top:8px; font-size:14px; color:var(--primary-text-color); }
        .lg span { display:inline-flex; align-items:center; gap:7px; }
        .lg i { width:14px; height:14px; border-radius:3px; display:inline-block; }
        .h-row { display:flex; align-items:center; }
        .info { width:20px; height:20px; border-radius:50%; border:1px solid var(--divider-color); background:none;
                color:var(--secondary-text-color); font:italic 600 12px Georgia, serif; cursor:pointer; flex:0 0 auto;
                line-height:1; padding:0; margin-left:8px; }
        .info:hover { border-color:var(--primary-color); color:var(--primary-color); }
        .infopop { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center;
                   justify-content:center; z-index:50; padding:20px; }
        .infopop.show { display:flex; }
        .infopop .box { background:var(--card-background-color); border:1px solid var(--divider-color);
                        border-radius:12px; padding:20px 22px; max-width:460px; }
        .infopop h4 { margin:0 0 10px; font-size:16px; }
        .infopop p { margin:0; color:var(--primary-text-color); line-height:1.6; font-size:14px; }
        .infopop .x { float:right; background:none; border:none; color:var(--secondary-text-color); font-size:20px;
                      cursor:pointer; margin:-6px -6px 0 0; }
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
      <div class="infopop" id="infoPop"><div class="box"></div></div>
    `;
    this.shadowRoot.querySelectorAll("nav a").forEach((a) =>
      a.addEventListener("click", () => { this._tab = a.dataset.tab; this._loadTab(); })
    );
    // попапи «як це читати» — делеговано на весь shadow root
    this.shadowRoot.addEventListener("click", (e) => {
      // перемикач ₴/$ — перемальовуємо лише картку прогнозу, без запиту
      const u = e.target.closest("[data-fcunit]");
      if (u) {
        this._fcUnit = u.dataset.fcunit;
        try { localStorage.setItem("oddinvest.fcUnit", this._fcUnit); } catch (_) {}
        const card = this.shadowRoot.getElementById("fcCard");
        if (card) card.outerHTML = this._goalsHTML();
        return;
      }
      const b = e.target.closest("[data-info]");
      const pop = this.shadowRoot.getElementById("infoPop");
      if (b) {
        const en = INFO[b.dataset.info];
        if (en) { pop.querySelector(".box").innerHTML = `<button class="x" data-closeinfo>×</button><h4>${en[0]}</h4><p>${en[1]}</p>`; pop.classList.add("show"); }
      } else if (e.target.closest("[data-closeinfo]") || e.target.id === "infoPop") {
        pop.classList.remove("show");
      }
    });
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
    const rmin = s.reinvest_min || {};
    const hasPortfolio = (s.nominal_uah_eq || 0) > 0;
    // Готовність рахуємо ПО БРОКЕРАХ: сумарний баланс може «вистачати»,
    // хоча в кожного окремо грошей замало — і банер брехав би.
    const brokers = s.brokers || {};
    const ready = [];
    for (const b of Object.keys(brokers)) {
      for (const c of Object.keys(brokers[b] || {})) {
        if (rmin[c] > 0 && brokers[b][c] >= rmin[c]) {
          ready.push({ broker: b, cur: c, n: Math.floor(brokers[b][c] / rmin[c]) });
        }
      }
    }
    const box = (cls, icon, title, sub, btn = "") =>
      `<div class="banner ${cls}"><div class="b-ic">${icon}</div><div class="b-tx">
         <div class="b-t">${title}</div>${sub ? `<div class="b-s">${sub}</div>` : ""}</div>${btn}</div>`;

    if (!hasPortfolio) {
      return box("neutral", "◦", "Почни з першої покупки",
        "Додай папір — і застосунок почне вести драбину, календар і проєкції.",
        `<button data-go="buy">Купити папір</button>`);
    }
    if (ready.length) {
      const parts = ready.map((r) => `<b>${r.n}</b> ${esc(r.cur)}-папер(и) у <b>${esc(r.broker)}</b>`).join(", ");
      return box("ok", "●", `Можеш купити ${parts}`,
        ready.map((r) => `${esc(r.broker)} · ${esc(r.cur)}: ${fmtCur(brokers[r.broker][r.cur], r.cur)}, папір від ${fmtCur(rmin[r.cur], r.cur)}`).join(" · "),
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
      (np ? ` Купон ${dayMonth(np.date)} додасть ${Number(np.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${curSym(np.currency)}.` : "");
    return box("wait", "○", `Купувати ще рано — бракує ${fmtUAH(need)}${eta}`, sub);
  }

  // Віяло розкидає ПОТРІБНИЙ ВНЕСОК, а не суму на дедлайн: щойно внесок
  // підбирається під ціль, сума на дедлайн у всіх сценаріях однакова —
  // це і є ціль. Корисне натомість те, скільки ціль КОШТУЄ щомісяця за
  // різного ринку.
  //
  // Верстка: спершу вилка «від і до» одним великим числом, бо саме вона
  // відповідає на «наскільки це реально». Далі рядки з допущеннями, з
  // яких прибрано все, що в них однакове: сьогоднішні ставки в усіх
  // рядках ті самі, тож вони винесені в шапку один раз, а в рядках
  // лишились тільки довгострокові. Смужки в ринкових рядках прибрано —
  // 72/85/100% візуально майже не відрізнялись і лише додавали шуму.
  //
  // Старий бекенд required_monthly у рядках не надсилає — тоді лишаємо
  // попередній вигляд (сума на дедлайн), щоб панель не показувала порожньо.
  _goalsHTML() {
    const s = this._summary || {};
    const f = s.forecast;
    if (!f || !(f.rows || []).length) {
      return `<div class="card" id="fcCard"><h2>Скільки треба вносити</h2><div class="muted">Задай ціль
        і дедлайн у «Налаштуваннях» — і тут зʼявиться, скільки треба відкладати щомісяця
        за песимістичного, реалістичного й оптимістичного сценаріїв.</div></div>`;
    }
    const rate0 = f.rate0_usd || 0;
    const usd = this._fcUnit === "USD" && rate0 > 0;
    const money = (v) => usd
      ? "$" + Math.round((v || 0) / rate0).toLocaleString("uk-UA")
      : fmtUAH(v);
    const goal = f.goal_amount || 0;
    const hist = Number(s.actual_months || 0);
    const asPayment = f.rows.some((r) => r.required_monthly > 0);
    // Внески лишаються в гривні навіть у доларовому вигляді: відкладаєш
    // ти гривні, і рішення про суму приймаєш теж у гривнях.
    const payOf = (r) => (r.key === "actual" ? r.contrib_monthly : r.required_monthly) || 0;
    const market = f.rows.filter((r) => r.key !== "actual");
    const actual = f.rows.find((r) => r.key === "actual");
    const real = market.find((r) => r.key === "realistic") || {};
    const need = payOf(real);
    const COLOR = { optimistic: "var(--success-color,#43a047)", realistic: "var(--primary-color,#7b6cf6)",
      pessimistic: "var(--warning-color,#ffa600)" };
    // Планові суми — без копійок: у числі «96 973,50 ₴/міс» дробова
    // частина не несе рішення, а заважає порівнювати рядки поглядом.
    const pay = (v) => Math.round(v || 0).toLocaleString("uk-UA") + " ₴";
    const goalFmt = (v) => usd ? money(v) : pay(v);

    // Вилка — головне число блока.
    let range = "";
    if (asPayment && market.length) {
      const vals = market.map(payOf).filter((v) => v > 0).sort((a, b) => a - b);
      if (vals.length) {
        range = `<div style="margin:2px 0 12px">
          <div style="font-size:22px;font-weight:600">${Math.round(vals[0]).toLocaleString("uk-UA")} — ${pay(vals[vals.length - 1])}<span style="font-size:14px;font-weight:400">/міс</span></div>
          ${need > 0 ? `<div class="muted" style="font-size:12px;margin-top:2px">найімовірніше ${pay(need)}/міс</div>` : ""}
        </div>`;
      }
    }

    // Довгострокові ставки — єдине, чим рядки відрізняються.
    const termRates = (r) => (r.by_currency || []).map((c) =>
      c.rate_terminal_pct && Math.abs(c.rate_terminal_pct - c.rate_pct) > 0.05
        ? `${curSym(c.currency)} →${c.rate_terminal_pct.toFixed(1)}%`
        : `${curSym(c.currency)} ${(c.rate_pct || 0).toFixed(1)}%`).join(" · ");

    const marketRows = market.map((r) => {
      const val = asPayment ? payOf(r) : (r.amount || 0);
      // Позначки «найімовірніше» тут немає: її вже сказано у вилці вище,
      // а реалістичний рядок і так виділений кольором.
      return `<div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="color:${COLOR[r.key] || "inherit"}">${esc(r.label)}</span>
          <span><b>${asPayment ? pay(val) + "/міс" : money(val)}</b></span>
        </div>
        <div class="muted" style="font-size:11px;margin-top:1px">${termRates(r)} · гривня слабшає ${(r.devaluation_pct || 0).toFixed(1)}%/рік</div>
      </div>`;
    }).join("");

    // Факт: головне тут не сума, а яку частку потрібного ти покриваєш.
    let actualBlock = "";
    if (actual) {
      const share = need > 0 ? Math.min(100, payOf(actual) / need * 100) : 0;
      const eta = actual.goal_months === -1 ? "вже досягнуто"
        : actual.goal_months > 0 ? `${monthYear(actual.goal_date)}`
        : "не досягається за 60 років";
      actualBlock = `<div style="border-top:1px solid var(--divider-color,#3334);padding-top:10px;margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span>За фактом ${hist > 0 ? `<span class="muted" style="font-size:12px">за ${humanMonths(hist)} історії</span>` : ""}</span>
          <span><b>${pay(payOf(actual))}/міс</b>${asPayment && need > 0
            ? ` <span style="color:var(--info-color,#039be5)">— ${share.toFixed(0)}% від потрібного</span>` : ""}</span>
        </div>
        ${asPayment && need > 0 ? `<div class="progress" style="margin-top:6px"><span style="width:${share}%;background:var(--info-color,#039be5)"></span></div>` : ""}
        <div class="muted" style="font-size:11px;margin-top:4px">на дедлайн ${goalFmt(actual.amount)}${
          goal > 0 ? ` — ${(actual.goal_pct || 0).toFixed(1)}% цілі` : ""} · за цим темпом ціль ${eta}</div>
      </div>`;
    } else {
      actualBlock = `<div class="muted" style="font-size:12px;border-top:1px solid var(--divider-color,#3334);padding-top:10px;margin-top:10px">
        Прогноз за фактичним темпом зʼявиться після першого поповнення.</div>`;
    }

    // Сьогоднішні ставки однакові в усіх рядках — кажемо їх один раз тут.
    const nowRates = (real.by_currency || []).map((c) =>
      `${curSym(c.currency)} ${(c.rate_pct || 0).toFixed(1)}%`).join(" · ");
    const unitBtn = (u, lbl) => `<button class="unit${usd === (u === "USD") ? " on" : ""}" data-fcunit="${u}">${lbl}</button>`;
    const toggle = rate0 > 0 ? `<span class="unitbox">${unitBtn("UAH", "₴")}${unitBtn("USD", "$")}</span>` : "";
    const head = `<div class="muted" style="font-size:12px">${
      asPayment && goal > 0 ? `щоб дійти до ${goalFmt(goal)} до ${monthYearGen(f.date)}` : `на ${monthYear(f.date)}`
      } · через ${humanMonths(f.months)}</div>
      ${nowRates ? `<div class="muted" style="font-size:11px;margin-top:2px">сьогодні ставки ${nowRates}${
        f.glide_years > 0 ? ` → сповзають до довгострокових за ${humanMonths(Math.round(f.glide_years * 12))}` : ""}</div>` : ""}`;
    return `<div class="card" id="fcCard"><h2 class="h-row" style="justify-content:space-between">
      <span>${asPayment ? "Скільки треба вносити" : "Скільки буде на дедлайн"} ${infoBtn("forecast")}</span>${toggle}</h2>
      ${head}${range}${marketRows}${actualBlock}</div>`;
  }

  _paymentsPreviewHTML() {
    const rows = ((this._summary || {}).top_payments || []).slice(0, 4);
    const body = rows.length
      ? rows.map((p) => `<div class="pv-row"><span class="muted">${dayMonth(p.date)}</span>
          <span>${Number(p.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${curSym(p.currency)}</span></div>`).join("")
      : `<div class="muted" style="font-size:13px">Виплат попереду немає.</div>`;
    return `<div class="card"><h2>Найближчі виплати</h2>${body}
      <div class="muted" style="font-size:12px;margin-top:8px">Повний календар — у «Майбутньому»</div></div>`;
  }

  // Кільце часток вкладеного капіталу по брокерах. Малюємо SVG-donut
  // руками (без зовнішніх бібліотек): кожен сегмент — коло зі stroke-
  // dasharray, зсунуте на суму попередніх. Група повернута на -90°, щоб
  // старт був угорі.
  _brokerDonutHTML() {
    const ibb = (this._summary || {}).invested_by_broker || {};
    const names = Object.keys(ibb).filter((n) => ibb[n] > 0).sort((a, b) => ibb[b] - ibb[a]);
    if (names.length < 2) return "";
    const total = names.reduce((s, n) => s + ibb[n], 0);
    const palette = ["#4da3ff", "#2ecc71", "#ffa600", "#8e24aa", "#f85149", "#26c6da", "#d4a5ff"];
    const R = 60, W = 22, C = 2 * Math.PI * R;
    let acc = 0;
    const arcs = names.map((n, i) => {
      const len = (ibb[n] / total) * C;
      const c = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${palette[i % palette.length]}"
        stroke-width="${W}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
        stroke-dashoffset="${(-acc).toFixed(2)}"/>`;
      acc += len;
      return c;
    }).join("");
    const legend = names.map((n, i) => {
      const pct = (ibb[n] / total) * 100;
      return `<div class="pv-row"><span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;
        background:${palette[i % palette.length]};margin-right:8px;vertical-align:-1px"></span>${esc(n)}</span>
        <span>${pct.toFixed(0)}% · ${fmtUAH(ibb[n])}</span></div>`;
    }).join("");
    return `<div class="card wide"><h4 class="h-row" style="justify-content:space-between">Частки по брокерах ${infoBtn("broker")}</h4>
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <svg viewBox="0 0 160 160" width="140" height="140" style="transform:rotate(-90deg);flex:0 0 auto">${arcs}</svg>
        <div style="flex:1;min-width:180px">${legend}</div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">За вкладеним капіталом (вартість входу залишків).</div></div>`;
  }

  _extraChartsHTML() {
    const s = this._summary || {};
    let html = this._brokerDonutHTML(); // донат тайлиться разом з рештою
    const lad = s.ladder_uah || [];
    if (lad.length) {
      html += `<div class="card"><h4>Драбина погашень ${infoBtn("ladder")}</h4>
        ${svgBars(lad.map((r) => ({ label: String(r.year), value: r.uah })), { showVals: true })}
        <div class="muted" style="font-size:13px">Номінал, що повертається щороку (грн-екв.).</div></div>`;
    }
    const inc = s.income_12m || [];
    if (inc.some((m) => m.amount > 0)) {
      html += `<div class="card"><h4>Дохід по місяцях ${infoBtn("income")}</h4>
        ${svgBars(inc.map((m) => ({ label: m.month.slice(5), value: m.amount, color: "#2ecc71" })))}
        <div class="muted" style="font-size:13px">Купони + погашення на рік наперед (грн-екв.).</div></div>`;
    }
    const st = s.settings || {};
    const usdT = Number(st.usd_target_share_pct || 0), eurT = Number(st.eur_target_share_pct || 0);
    if (usdT > 0 || eurT > 0) {
      const groups = [
        { label: "UAH", a: 100 - (s.usd_share_pct || 0) - (s.eur_share_pct || 0), b: Math.max(0, 100 - usdT - eurT) },
        { label: "USD", a: s.usd_share_pct || 0, b: usdT },
        { label: "EUR", a: s.eur_share_pct || 0, b: eurT },
      ];
      html += `<div class="card"><h4>Валюта: факт vs ціль ${infoBtn("currency")}</h4>${svgGrouped(groups)}
        <div class="lg"><span><i style="background:#4da3ff"></i>факт</span><span><i style="background:#8b949e"></i>ціль</span></div></div>`;
    }
    const proj = s.projection || [];
    if (proj.length) {
      html += `<div class="card"><h4>Крива капіталу ${infoBtn("capital")}</h4>
        ${svgLine(proj.map((p) => p.years + "р"), [
          { color: "#8b949e", values: proj.map((p) => p.contributed) },
          { color: "#4da3ff", values: proj.map((p) => p.with_reinvest) },
        ])}
        <div class="lg"><span><i style="background:#8b949e"></i>внесено</span><span><i style="background:#4da3ff"></i>з реінвестом</span></div></div>`;
    }
    return html ? `<div class="chart-grid">${html}</div>` : "";
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

  // Що купити: папери, відранжовані за РЕАЛЬНОЮ дохідністю в сьогоднішніх
  // гривнях. Показуємо кілька позицій ЗАВЖДИ — попередній варіант зникав
  // саме тоді, коли ти плануєш наступний крок, а ще був таблицею-звалищем
  // на весь довідник, тож тут свідомо лише верхівка.
  _reinvestHTML() {
    // По одному найкращому паперу на валюту, а не просто верхівка списку.
    // Верхівка збиралася з однієї валюти (сортування спершу дивиться на
    // валютний дефіцит), і чотири майже однакові папери не давали вибору —
    // тоді як порівняти гривню з доларом і є сенсом цього блоку.
    const byCur = new Map();
    for (const r of this._reinvest || []) {
      if (!byCur.has(r.currency)) byCur.set(r.currency, r);
    }
    const rows = [...byCur.values()].sort((a, b) => (b.real_pct || 0) - (a.real_pct || 0));
    if (!rows.length) return "";
    const s = this._summary || {};
    const purse = Object.entries(s.brokers || {})
      .flatMap(([b, byCur]) => Object.entries(byCur)
        .filter(([, v]) => v > 0)
        .map(([c, v]) => `${esc(b)} ${fmtCur(v, curSym(c))}`)).join(" · ");
    const items = rows.map((r) => {
      const fits = (r.brokers || []).map((f) => `${esc(f.broker)} ×${f.qty}`).join(" · ");
      const cost = r.cost_per_bond ? fmtCur(Number(r.cost_per_bond.amount), curSym(r.currency)) : "";
      // Коли не по кишені — кажемо СКІЛЬКИ бракує: «ще не по кишені» саме
      // по собі не підказує, скільки лишилось відкласти.
      const purseCur = Math.max(0, ...Object.values(s.brokers || {}).map((m) => m[r.currency] || 0));
      const need = Number((r.cost_per_bond || {}).amount || 0) - purseCur;
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span><b>${esc(r.isin)}</b> <span class="muted" style="font-size:12px">${curSym(r.currency)} · до ${monthYearGen(r.maturity)}</span></span>
          <span><b>${(r.real_pct || 0).toFixed(1)}%</b> <span class="muted" style="font-size:12px">реальних</span></span>
        </div>
        <div class="muted" style="font-size:11px;margin-top:2px">${cost} · YTM ${(r.ytm_pct || 0).toFixed(1)}%${
          fits ? ` · ${fits}` : need > 0 ? ` · бракує ${fmtCur(need, curSym(r.currency))}` : ""}</div>
        ${r.reason ? `<div class="muted" style="font-size:11px">${esc(r.reason)}</div>` : ""}
      </div>`;
    }).join("");
    return `<div class="card"><h2 class="h-row" style="justify-content:space-between">
      <span>Що купити ${infoBtn("reinvest")}</span></h2>
      ${purse ? `<div class="muted" style="font-size:12px;margin-bottom:8px">${purse}</div>` : ""}
      ${items}</div>`;
  }

  // Пасивний дохід: скільки папери приноситимуть щомісяця. Саме КУПОННИЙ
  // потік — погашення це повернення власного тіла, а не дохід, і плутати
  // їх означало б завищувати відповідь удвічі на коротких горизонтах.
  _incomeHTML() {
    const s = this._summary || {};
    const rows = (s.projection || []).filter((r) => r.income_monthly > 0);
    const now = Number(s.income_monthly_now || 0);
    if (!rows.length && now <= 0) return "";
    // Без копійок, як і в решті планових чисел: дробова частина місячного
    // доходу на горизонті в роки — це точність, якої в оцінці немає.
    const inc = (v) => Math.round(v || 0).toLocaleString("uk-UA") + " ₴";
    const line = (label, v, extra = "") => `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px">
      <span class="muted" style="font-size:13px">${label}</span>
      <span><b>${inc(v)}</b><span class="muted" style="font-size:12px">/міс</span>${extra}</span></div>`;
    const body = rows.map((r) => line(`через ${humanMonths(r.years * 12)}`, r.income_monthly,
      r.income_monthly_actual > 0 && Math.abs(r.income_monthly_actual - r.income_monthly) > 1
        ? ` <span class="muted" style="font-size:11px">· за фактом ${inc(r.income_monthly_actual)}</span>` : "")).join("");
    return `<div class="card"><h2 class="h-row" style="justify-content:space-between">
      <span>Пасивний дохід ${infoBtn("income")}</span></h2>
      <div class="muted" style="font-size:12px;margin-bottom:8px">скільки папери приноситимуть щомісяця, у сьогоднішніх гривнях</div>
      ${line("зараз", now)}
      <div style="border-top:1px solid var(--divider-color,#3334);padding-top:6px;margin-top:4px">${body}</div>
    </div>`;
  }

  // Сертифікати фондів. Показані ОКРЕМО від паперів, а не в спільному
  // портфелі: у них немає номіналу, тож ані в драбину, ані в дюрацію вони
  // не лягають, і зведення їх в одну таблицю з ОВДП зламало б обидві.
  _fundsHTML() {
    const s = this._summary || {};
    const rows = s.funds || [];
    if (!rows.length) return "";
    const body = rows.map((f) => {
      const pnl = f.market_value - f.cost_basis;
      const sign = pnl >= 0 ? "+" : "";
      const col = pnl >= 0 ? "var(--success-color,#43a047)" : "var(--error-color,#db4437)";
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span><b>${esc(f.fund)}</b> <span class="muted" style="font-size:12px">${f.qty} серт.</span></span>
          <span><b>${fmtUAH(f.market_value)}</b>${f.yield_net_pct > 0
            ? ` <span class="muted" style="font-size:12px">${f.yield_net_pct.toFixed(1)}% чистих</span>` : ""}</span>
        </div>
        <div class="muted" style="font-size:11px;margin-top:2px">по ${(f.last_price || 0).toFixed(4)} ₴${
          f.last_price_date ? ` від ${dayMonth(f.last_price_date)}` : ""} · вкладено ${fmtUAH(f.cost_basis)} ·
          <span style="color:${col}">${sign}${fmtUAH(pnl)}</span></div>
        <div class="muted" style="font-size:11px">дивідендів ${fmtUAH(f.dividends_net)} чистими${
          f.dividends_tax > 0 ? ` (податок ${fmtUAH(f.dividends_tax)})` : ""}${
          f.realized ? ` · результат продажів ${fmtUAH(f.realized)}` : ""}</div>
      </div>`;
    }).join("");
    return `<div class="card"><h2 class="h-row" style="justify-content:space-between">
      <span>Сертифікати фондів ${infoBtn("funds")}</span>
      <span class="muted" style="font-size:13px">${fmtUAH(s.funds_uah || 0)}</span></h2>${body}</div>`;
  }

  async _renderOverview(main) {
    const s = this._summary || {};
    const cap = (s.nominal_uah_eq || 0) + (s.account_uah || 0);
    const np = s.next_payment;
    const accrued = s.accrued_uah || 0;
    const tiles = `<div class="tiles" style="margin:0 0 12px;padding:0">
      ${this._tile("Капітал", fmtUAH(cap),
        accrued > 0 ? `<div class="muted" style="font-size:12px;margin-top:4px">+ ${fmtUAH(accrued)} НКД зароблено</div>` : "")}
      ${this._tile("Цей місяць", s.month_target_uah > 0 ? `${s.month_progress_pct || 0}%` : "—",
        s.month_target_uah > 0
          ? `<div class="progress"><span style="width:${Math.min(100, s.month_progress_pct || 0)}%"></span></div>
             <div class="muted" style="font-size:12px;margin-top:4px">${
               s.month_deposited_uah === undefined
                 ? `вкладено ${fmtUAH(s.month_invested_uah)}` // старий бекенд рахував купівлі
                 : `внесено ${fmtUAH(s.month_deposited_uah)}`} з ${fmtUAH(s.month_target_uah)}</div>
             ${s.month_withdrawn_uah > 0
               ? `<div class="muted" style="font-size:11px;margin-top:2px">нетто: поповнення ${
                   fmtUAH((s.month_deposited_uah || 0) + s.month_withdrawn_uah)} − зняття ${fmtUAH(s.month_withdrawn_uah)}</div>` : ""}`
          : `<div class="muted" style="font-size:12px;margin-top:4px">задай ціль і дедлайн — план порахується сам</div>`)}
      ${this._tile("Наступна виплата",
        np ? `${Number(np.amount).toLocaleString("uk-UA", { minimumFractionDigits: 2 })} ${curSym(np.currency)}` : "—",
        np ? `<div class="muted" style="font-size:12px;margin-top:4px">${dayMonth(np.date)}</div>` : "")}
    </div>`;

    // Помічник живе на окремому маршруті: тягнемо разом з оглядом, щоб
    // картка не «доїжджала» після решти.
    try { this._reinvest = await this._api("GET", "reinvest"); }
    catch (_) { this._reinvest = []; }
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
      ${this._reinvestHTML()}
      ${this._incomeHTML()}
      ${this._fundsHTML()}
      <div class="ov-grid">${chart}${this._paymentsPreviewHTML()}</div>
      ${this._extraChartsHTML()}
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
  // Брокери: задані в Налаштуваннях ∪ ті, що вже зустрічались у лотах і
  // балансах. Новий брокер доступний ще до першої покупки, старі не губляться.
  _brokerList(lots) {
    const s = this._summary || {};
    const set = new Set(String((s.settings || {}).channels || "")
      .split(",").map((c) => c.trim()).filter(Boolean));
    Object.keys(s.brokers || {}).forEach((b) => { if (b && b !== "—") set.add(b); });
    (lots || []).forEach((l) => { if (l.channel) set.add(String(l.channel).trim()); });
    return [...set].sort((a, b) => a.localeCompare(b, "uk"));
  }

  // Для форм грошей: без «інший…», бо рахунок має існувати заздалегідь.
  _brokerOptions(sel = "") {
    const list = this._brokerList();
    return `<option value="">—</option>` + list.map((c) =>
      `<option value="${esc(c)}"${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");
  }

  // Для форми покупки: плюс «інший…» на разовий випадок.
  _channelOptions(lots) {
    return `<option value="">—</option>` +
      this._brokerList(lots).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("") +
      `<option value="__other__">інший…</option>`;
  }

  // Довідково: скільки вкладено в папери по кожному брокеру (грн-екв.).
  _investedByBrokerHTML() {
    const ibb = (this._summary || {}).invested_by_broker || {};
    const names = Object.keys(ibb).sort((a, b) => ibb[b] - ibb[a]);
    if (names.length < 2) return ""; // при одному брокері розбивка = тій самій плитці
    const total = names.reduce((s, n) => s + ibb[n], 0);
    const rows = names.map((n) => {
      const pct = total > 0 ? (ibb[n] / total) * 100 : 0;
      return `<div class="pv-row"><span><b>${esc(n)}</b></span>
        <span>${fmtUAH(ibb[n])} <span class="muted" style="font-size:12px">(${pct.toFixed(0)}%)</span></span></div>`;
    }).join("");
    return `<div class="card"><h2>Вкладено по брокерах</h2>${rows}</div>`;
  }

  async _renderPortfolio(main) {
    const s0 = this._summary || {};
    const [positions, lots, sales, fundOps] = await Promise.all([
      this._api("GET", "positions"),
      this._api("GET", "lots"),
      this._api("GET", "sales"),
      this._api("GET", "funds").catch(() => []),
    ]);
    this._fundOps = fundOps || [];
    // «Дохідність» — YTM до погашення від сплаченої ціни, «XIRR» — фактично
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
        `<div class="muted" style="font-size:12px;margin-top:4px">до погашення, від сплаченої ціни</div>`)).join("")}
      ${xirrTiles}
    </div>
    ${this._investedByBrokerHTML()}`;
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
          <label>Брокер<select name="channel_sel">${this._channelOptions(lots)}</select>
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
          <th class="num">Комісія</th><th>Куплено</th><th>Брокер</th><th></th></tr></thead><tbody>
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

      ${this._fundOpsHTML()}
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

    this._wireFundOps(main);
  }

  // --- сертифікати фондів ---
  // Розкладено так само, як облігації: позиції, під ними лоти (купівлі),
  // далі продажі й дивіденди — кожне своєю таблицею з власною формою.
  // Спільного хронологічного журналу свідомо немає: у портфелі питання не
  // «що відбувалось», а «що в мене є і з чого воно склалось».
  //
  // Форма кожного розділу працює і на «додати», і на «виправити»:
  // прихований id перемикає POST на PUT, і другого набору полів не треба.
  _fundOpsHTML() {
    const ops = this._fundOps || [];
    const funds = (this._summary || {}).funds || [];
    if (!ops.length && !funds.length) return "";
    // Підказка фондів — з уже записаних операцій: назва має збігатися
    // символ у символ, інакше один фонд розпадеться на дві позиції.
    const names = [...new Set(ops.map((o) => o.fund).filter(Boolean))].sort((a, b) => a.localeCompare(b, "uk"));
    const money = (m) => m ? fmtCur(m.amount, curSym(m.currency)) : "—";
    const price = (o) => o.qty > 0 && o.amount ? (Number(o.amount.amount) / o.qty).toFixed(4) : "";
    const tax = (o) => o.tax && Number(o.tax.amount) > 0 ? money(o.tax) : "";
    const acts = (id) => `<td class="row-actions">
      <button class="sm" data-editfund="${id}">✎</button>
      <button class="sm warn" data-delfund="${id}">✕</button></td>`;
    // Найновіші зверху: правиш майже завжди щойно імпортоване.
    const of = (kind) => ops.filter((o) => o.kind === kind)
      .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
    const tail = (o) => `<td>${esc(o.date)}</td><td>${esc(o.broker || "")}</td>
      <td class="muted">${esc(o.note || "")}</td>${acts(o.id)}`;
    const table = (rows, head, cells, empty) => rows.length
      ? `<table><thead><tr>${head}<th>Дата</th><th>Брокер</th><th>Нотатка</th><th></th></tr></thead><tbody>
        ${rows.map((o) => `<tr><td class="num">${o.id}</td><td>${esc(o.fund)}</td>${cells(o)}${tail(o)}</tr>`).join("")}
        </tbody></table>`
      : `<div class="muted">${empty}</div>`;
    const fundField = `<label>Фонд<input name="fund" list="fundList" required autocomplete="off" placeholder="Inzhur..."></label>`;
    const curField = `<label>Валюта<select name="currency">
      <option value="UAH">UAH</option><option value="USD">USD</option><option value="EUR">EUR</option></select></label>`;
    const tailFields = `${curField}
      <label>Дата<input name="date" type="date" value="${today()}" required></label>
      <label>Брокер<select name="broker">${this._brokerOptions()}</select></label>
      <label>Нотатка<input name="note"></label>`;
    const buttons = (add) => `<div class="row-actions">
      <button type="submit">${add}</button>
      <button type="button" class="fundCancel" style="display:none;background:var(--divider-color);color:var(--primary-text-color)">Скасувати</button>
    </div>`;

    const positions = funds.length ? `<table><thead><tr>
      <th>Фонд</th><th class="num">К-сть</th><th class="num">Ціна</th><th class="num">Вартість</th>
      <th class="num">Вкладено</th><th class="num">Прибуток</th><th class="num">Дивіденди</th>
      <th class="num">Дохідність</th></tr></thead><tbody>
      ${funds.map((f) => {
        const pnl = f.market_value - f.cost_basis;
        const col = pnl >= 0 ? "var(--success-color,#43a047)" : "var(--error-color,#db4437)";
        return `<tr><td><b>${esc(f.fund)}</b></td><td class="num">${f.qty}</td>
          <td class="num">${(f.last_price || 0).toFixed(4)} ${curSym(f.currency)}${
            f.last_price_date ? `<div class="muted" style="font-size:11px">${dayMonth(f.last_price_date)}</div>` : ""}</td>
          <td class="num">${fmtUAH(f.market_value)}</td><td class="num">${fmtUAH(f.cost_basis)}</td>
          <td class="num" style="color:${col}">${pnl >= 0 ? "+" : ""}${fmtUAH(pnl)}${
            f.realized ? `<div class="muted" style="font-size:11px">продажі ${fmtUAH(f.realized)}</div>` : ""}</td>
          <td class="num">${fmtUAH(f.dividends_net)}${
            f.dividends_tax > 0 ? `<div class="muted" style="font-size:11px">податок ${fmtUAH(f.dividends_tax)}</div>` : ""}</td>
          <td class="num">${f.yield_net_pct > 0 ? f.yield_net_pct.toFixed(1) + "%" : "—"}</td></tr>`;
      }).join("")}</tbody></table>`
      : `<div class="muted">Сертифікатів немає — імпортуй виписку в «Рахунку» або додай купівлю вище.</div>`;

    return `<div class="card"><h2 class="h-row" style="justify-content:space-between">
        <span>Купівля сертифікатів ${infoBtn("fundops")}</span></h2>
        <div class="muted" style="margin-bottom:12px">Інший інструмент, ніж ОВДП: ні погашення, ні номіналу,
          ні графіка купонів — натомість ринкова ціна й нерегулярні дивіденди, з яких утримується податок.
          Ціна береться з останньої твоєї операції.</div>
        <form id="fundBuyForm">
          <input type="hidden" name="id">
          ${fundField}
          <datalist id="fundList">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
          <label>Кількість<input name="qty" type="number" min="1" step="1" placeholder="серт." required></label>
          <label>Сплачено разом<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
          ${tailFields}${buttons("Додати")}
        </form>
      </div>

      <div class="card"><h2>Позиції фондів</h2>${positions}</div>

      <div class="card"><h2>Лоти фондів</h2>
        ${table(of("buy"),
          `<th class="num">ID</th><th>Фонд</th><th class="num">К-сть</th><th class="num">Ціна</th><th class="num">Сплачено</th>`,
          (o) => `<td class="num">${o.qty}</td><td class="num">${price(o)}</td><td class="num">${money(o.amount)}</td>`,
          "Купівель ще немає.")}
      </div>

      <div class="card"><h2>Продаж сертифікатів</h2>
        <form id="fundSellForm">
          <input type="hidden" name="id">
          ${fundField}
          <label>Кількість<input name="qty" type="number" min="1" step="1" placeholder="серт." required></label>
          <label>Отримано разом<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
          <label>Податок<input name="tax" inputmode="decimal" placeholder="0.00"></label>
          ${tailFields}${buttons("Записати")}
        </form>
        <div style="margin-top:14px">${table(of("sell"),
          `<th class="num">ID</th><th>Фонд</th><th class="num">К-сть</th><th class="num">Ціна</th><th class="num">Отримано</th><th class="num">Податок</th>`,
          (o) => `<td class="num">${o.qty}</td><td class="num">${price(o)}</td><td class="num">${money(o.amount)}</td><td class="num">${tax(o)}</td>`,
          "Продажів ще не було.")}</div>
      </div>

      <div class="card"><h2>Дивіденди</h2>
        <form id="fundDivForm">
          <input type="hidden" name="id">
          ${fundField}
          <label>Нараховано (брутто)<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
          <label>Податок утримано<input name="tax" inputmode="decimal" placeholder="0.00"></label>
          ${tailFields}${buttons("Записати")}
        </form>
        <div style="margin-top:14px">${table(of("dividend"),
          `<th class="num">ID</th><th>Фонд</th><th class="num">Нараховано</th><th class="num">Податок</th><th class="num">Чистими</th>`,
          (o) => `<td class="num">${money(o.amount)}</td><td class="num">${tax(o)}</td>
            <td class="num">${fmtCur(Number(o.amount.amount) - Number((o.tax || {}).amount || 0), curSym(o.amount.currency))}</td>`,
          "Дивідендів ще не було.")}</div>
      </div>`;
  }

  // Правка веде в ту форму, якій операція належить: купівлю правиш там,
  // де купуєш. «Скасувати» видно лише в режимі правки — поки її не
  // натиснули, форма пам'ятає, що вона змінює, а не додає.
  _wireFundOps(main) {
    const SECTIONS = { buy: ["#fundBuyForm", "Додати"], sell: ["#fundSellForm", "Записати"],
      dividend: ["#fundDivForm", "Записати"] };
    const forms = {}, resets = {};

    for (const [kind, [sel, add]] of Object.entries(SECTIONS)) {
      const f = main.querySelector(sel);
      if (!f) continue;
      forms[kind] = f;
      const submit = f.querySelector("button[type=submit]");
      const cancel = f.querySelector(".fundCancel");
      resets[kind] = () => {
        f.reset(); f.id.value = ""; f.date.value = today();
        submit.textContent = add; cancel.style.display = "none";
      };
      cancel.addEventListener("click", resets[kind]);
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = f.id.value;
        try {
          // Кількості у дивіденда немає як поля: він нараховується на
          // позицію, а не на штуки, і бекенд її все одно обнулив би.
          await this._api(id ? "PUT" : "POST", id ? "funds/" + id : "funds", {
            date: f.date.value, fund: f.fund.value.trim(), kind,
            qty: f.qty ? (parseInt(f.qty.value, 10) || 0) : 0,
            amount: f.amount.value.trim(), tax: f.tax ? f.tax.value.trim() : "",
            currency: f.currency.value, broker: f.broker.value.trim(),
            note: f.note.value.trim(),
          });
          this._toast(id ? "Запис оновлено" : "Записано");
          this._loadTab();
        } catch (err) { this._toast(String(err.message || err), false); }
      });
      resets[kind]();
    }

    main.querySelectorAll("[data-editfund]").forEach((b) =>
      b.addEventListener("click", () => {
        const o = (this._fundOps || []).find((x) => x.id === +b.dataset.editfund);
        const f = o && forms[o.kind];
        if (!f) return;
        resets[o.kind]();
        f.id.value = o.id; f.date.value = o.date; f.fund.value = o.fund;
        if (f.qty) f.qty.value = o.qty || "";
        f.amount.value = o.amount ? o.amount.amount : "";
        if (f.tax) f.tax.value = o.tax && Number(o.tax.amount) > 0 ? o.tax.amount : "";
        f.currency.value = (o.amount && o.amount.currency) || "UAH";
        // Брокера операції може не бути у списку-підказці (його могли
        // прибрати з налаштувань) — тоді дописуємо опцію, інакше правка
        // мовчки стерла б прив'язку до рахунку.
        if (o.broker && ![...f.broker.options].some((x) => x.value === o.broker))
          f.broker.add(new Option(o.broker, o.broker));
        f.broker.value = o.broker || ""; f.note.value = o.note || "";
        f.querySelector("button[type=submit]").textContent = "Зберегти";
        f.querySelector(".fundCancel").style.display = "";
        f.scrollIntoView({ behavior: "smooth", block: "center" });
      }));

    main.querySelectorAll("[data-delfund]").forEach((b) =>
      b.addEventListener("click", async () => {
        const o = (this._fundOps || []).find((x) => x.id === +b.dataset.delfund);
        const what = o ? `${FUND_KIND[o.kind] || o.kind} ${o.fund} від ${o.date}` : "запис #" + b.dataset.delfund;
        if (!confirm(`Видалити ${what}? Позиція й ціна перерахуються.`)) return;
        try { await this._api("DELETE", "funds/" + b.dataset.delfund); this._toast("Запис видалено"); this._loadTab(); }
        catch (err) { this._toast(String(err.message || err), false); }
      }));
  }

  // ---------- РАХУНОК ----------
  // Баланси по брокерах: гроші в одного не купують папір в іншого, тож
  // «вистачає / не вистачає» має сенс лише в розрізі рахунку.
  _brokerBalancesHTML() {
    const s = this._summary || {};
    const brokers = s.brokers || {};
    const names = Object.keys(brokers).sort((a, b) => a.localeCompare(b, "uk"));
    if (!names.length) return "";
    const rmin = s.reinvest_min || {};
    const sym = { UAH: "₴", USD: "$", EUR: "€" };
    const rows = names.map((b) => {
      const cur = brokers[b] || {};
      const parts = Object.keys(cur).sort().map((c) => {
        const v = cur[c], min = rmin[c] || 0;
        const enough = min > 0 && v >= min;
        const hint = min > 0
          ? (enough ? `вистачає на ${Math.floor(v / min)}` : `до паперу ще ${fmtCur(min - v, sym[c] || c)}`)
          : "";
        return `<div class="pv-row"><span>${esc(c)} · <b>${fmtCur(v, sym[c] || c)}</b></span>
          <span class="${enough ? "" : "muted"}" style="${enough ? "color:var(--success-color,#43a047)" : ""}">${hint}</span></div>`;
      }).join("");
      return `<div style="margin-bottom:14px"><div style="margin-bottom:4px"><b>${esc(b)}</b></div>${parts}</div>`;
    }).join("");
    return `<div class="card"><h2>Рахунки по брокерах</h2>
      <div class="muted" style="margin-bottom:10px">Гроші в одного брокера не купують папір в іншого — тому баланси роздільні.</div>
      ${rows}</div>`;
  }

  // Звірка: рахунок за записами проти того, що показує брокер.
  // Коригування — звичайне поповнення з поміткою, а не окрема сутність:
  // так розбіжність лишається видимою в історії, а не ховається.
  _reconcileHTML() {
    const brokers = (this._summary || {}).brokers || {};
    const rows = Object.entries(brokers).flatMap(([b, byCur]) =>
      Object.entries(byCur).map(([c, v]) => ({ b, c, v })));
    if (!rows.length) return "";
    return `<div class="card"><h2 class="h-row" style="justify-content:space-between">
      <span>Звірка рахунку ${infoBtn("reconcile")}</span></h2>
      <table><thead><tr><th>Брокер</th><th class="num">За записами</th>
        <th class="num">Фактично</th><th class="num">Розбіжність</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-rec="${esc(r.b)}|${esc(r.c)}">
        <td>${esc(r.b)} ${curSym(r.c)}</td>
        <td class="num">${fmtCur(r.v, curSym(r.c))}</td>
        <td class="num"><input class="recAct" inputmode="decimal" style="width:110px;text-align:right"
          data-expected="${r.v}" placeholder="—"></td>
        <td class="num recDiff muted">—</td>
        <td class="num"><button class="recFix" disabled>виправити</button></td>
      </tr>`).join("")}</tbody></table></div>`;
  }

  _wireReconcile(main) {
    main.querySelectorAll("tr[data-rec]").forEach((tr) => {
      const inp = tr.querySelector(".recAct");
      const out = tr.querySelector(".recDiff");
      const btn = tr.querySelector(".recFix");
      const [broker, currency] = tr.dataset.rec.split("|");
      const recalc = () => {
        const raw = inp.value.trim().replace(/\s/g, "").replace(",", ".");
        const actual = Number(raw);
        if (!raw || Number.isNaN(actual)) {
          out.textContent = "—"; out.className = "num recDiff muted"; btn.disabled = true;
          return null;
        }
        const diff = Math.round((actual - Number(inp.dataset.expected)) * 100) / 100;
        out.textContent = diff === 0 ? "сходиться" : (diff > 0 ? "+" : "") + fmtCur(diff, curSym(currency));
        out.className = "num recDiff" + (diff === 0 ? " ok" : "");
        btn.disabled = diff === 0;
        return diff;
      };
      inp.addEventListener("input", recalc);
      btn.addEventListener("click", async () => {
        const diff = recalc();
        if (!diff) return;
        btn.disabled = true;
        try {
          await this._api("POST", "deposits", {
            amount: String(diff), currency, broker,
            note: diff > 0 ? "звірка: незаписане надходження" : "звірка: незаписана витрата",
          });
          this._toast("Коригування додано");
          await this._loadTab();
        } catch (err) {
          this._toast(String(err.message || err), false);
          btn.disabled = false;
        }
      });
    });
  }

  // Імпорт виписки. Два кроки навмисно: спершу показати, що буде
  // зроблено, і лише потім писати. Ціна помилки тут — подвоєний баланс,
  // а він знаходиться не одразу.
  _importHTML() {
    return `<div class="card"><h2 class="h-row" style="justify-content:space-between">
      <span>Імпорт виписки ${infoBtn("import")}</span></h2>
      <div class="muted" style="font-size:12px;margin-bottom:8px">Файл Inzhur (.xlsx). Спершу перегляд — нічого не записується.</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="impFile" accept=".xlsx">
        <button id="impPreview">Переглянути</button>
      </div>
      <div id="impOut" style="margin-top:10px"></div></div>`;
  }

  _wireImport(main) {
    const file = main.querySelector("#impFile");
    const out = main.querySelector("#impOut");
    if (!file || !out) return;

    const send = async (dry) => {
      if (!file.files || !file.files[0]) { this._toast("Обери файл", false); return null; }
      const fd = new FormData();
      fd.append("file", file.files[0]);
      const resp = await this._hass.fetchWithAuth(
        "/api/oddinvest/import/inzhur" + (dry ? "?dry=1" : ""), { method: "POST", body: fd });
      if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      return resp.json();
    };

    const KIND = { fund_buy: "купівля", fund_sell: "продаж", dividend: "дивіденд",
      deposit: "поповнення", withdrawal: "виведення" };
    const render = (res, dry) => {
      const rows = (res.rows || []).map((r) => {
        const tag = r.conflict
          ? `<div style="color:var(--error-color,#db4437);font-size:11px">⚠ ${esc(r.conflict)}</div>`
          : r.exists ? `<span class="muted" style="font-size:11px">вже є</span>` : "";
        return `<div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span>${dayMonth(r.date)} · ${KIND[r.kind] || r.kind}${
              r.fund ? ` <span class="muted">${esc(r.fund)}</span>` : ""}${
              r.qty ? ` <span class="muted">${r.qty} серт.</span>` : ""}</span>
            <span><b>${esc(r.amount)}</b>${r.tax && r.tax !== "0.00" ? ` <span class="muted" style="font-size:11px">податок ${esc(r.tax)}</span>` : ""} ${r.exists && !r.conflict ? `<span class="muted" style="font-size:11px">вже є</span>` : ""}</span>
          </div>${r.conflict ? tag : ""}</div>`;
      }).join("");
      const skipped = (res.skipped || []).map((s) =>
        `<div class="muted" style="font-size:11px">${dayMonth(s.Date || s.date)} · ${esc(s.Op || s.op)} — ${esc(s.Reason || s.reason)}</div>`).join("");
      const conflicts = (res.rows || []).filter((r) => r.conflict).length;
      out.innerHTML = `
        <div style="margin-bottom:8px">Знайдено ${(res.rows || []).length} операцій · <b>${res.new}</b> нових${
          conflicts ? ` · <span style="color:var(--error-color,#db4437)">${conflicts} з конфліктом</span>` : ""}</div>
        ${rows}
        ${skipped ? `<div style="border-top:1px solid var(--divider-color,#3334);margin-top:8px;padding-top:6px">
          <div class="muted" style="font-size:12px;margin-bottom:4px">пропущено:</div>${skipped}</div>` : ""}
        ${dry && res.new > 0 ? `<button id="impGo" style="margin-top:10px">Імпортувати ${res.new}</button>` : ""}
        ${!dry ? `<div style="margin-top:8px;color:var(--success-color,#43a047)">Записано ${res.imported}</div>` : ""}`;
      const go = out.querySelector("#impGo");
      if (go) {
        go.addEventListener("click", async () => {
          go.disabled = true;
          try { render(await send(false), false); this._toast("Імпортовано"); await this._loadTab(); }
          catch (err) { this._toast(String(err.message || err), false); go.disabled = false; }
        });
      }
    };

    main.querySelector("#impPreview").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const res = await send(true); if (res) render(res, true); }
      catch (err) { this._toast(String(err.message || err), false); }
      finally { e.target.disabled = false; }
    });
  }

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

      ${this._brokerBalancesHTML()}

      ${this._reconcileHTML()}

      ${this._importHTML()}

      <div class="card">
        <h2>Додати рух</h2>
        <div class="muted" style="margin-bottom:10px">Поповнення (+) / зняття (−) у своїй валюті. Купівля лота й купони рухають рахунок автоматично.</div>
        <form id="depForm">
          <label>Сума (+ / −)<input name="amount" inputmode="decimal" placeholder="5000.00" required></label>
          <label>Валюта<select name="currency">${curOpts("UAH")}</select></label>
          <label>Брокер<select name="broker">${this._brokerOptions()}</select></label>
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
          <label>Брокер<select name="broker">${this._brokerOptions()}</select></label>
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
          amount: f.amount.value.trim(), currency: f.currency.value, broker: f.broker.value,
          date: f.date.value, note: f.note.value.trim(),
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
          broker: f.broker.value, date: f.date.value, note: f.note.value.trim(),
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
    this._wireReconcile(main);
    this._wireImport(main);
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
    return `<div class="card"><h2>Ризик ставок</h2>
      <div class="tiles" style="margin:0 0 10px">
        <div class="tile"><div class="lbl">Дюрація (Маколея)</div><div class="val">${rr.duration_years} р.</div></div>
        <div class="tile"><div class="lbl">Модифікована</div><div class="val">${rr.modified_dur}</div></div>
        <div class="tile"><div class="lbl">Приведена вартість</div><div class="val">${fmtUAH(rr.pv_uah)}</div></div>
      </div>
      
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
      return `<div class="card"><h2 class="h-row">Як росте ${infoBtn("growth")}</h2>
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
    return `<div class="card"><h2 class="h-row">Як росте ${infoBtn("growth")}</h2>${this._chartSVG(dates, series)}
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
    // Ставка не вічна, тож у підписі показуємо ШЛЯХ, а не одну цифру:
    // інакше читач вважає, що воєнні 16-17% закладені на весь горизонт.
    const term = ((s.forecast || {}).rows || []).find((r) => r.key === "realistic") || {};
    const gy = (s.forecast || {}).glide_years || 0;
    const rateSrc = rate <= 0 ? "додай папери — і дохідність порахується сама"
      : term.rate_terminal_pct && gy > 0 && Math.abs(term.rate_terminal_pct - rate) > 0.05
        ? `за портфелем ${rate.toFixed(1)}% (YTM) сьогодні → ${term.rate_terminal_pct.toFixed(1)}% за ${humanMonths(Math.round(gy * 12))}`
        : `за портфелем ${rate.toFixed(1)}% (YTM до погашення)`;

    const hasActual = (s.actual_monthly_uah || 0) > 0;
    const rows = rowsData.length ? rowsData.map((r) =>
      `<tr><td>${r.years} р.</td><td class="num">${fmtUAH(r.contributed)}</td>
        <td class="num">${fmtUAH(r.with_reinvest)}</td>
        ${hasActual ? `<td class="num">${fmtUAH(r.with_reinvest_actual || 0)}</td>` : ""}
        <td class="num">${fmtUAH(r.with_reinvest - r.contributed)}</td></tr>`).join("")
      : `<tr><td colspan="${hasActual ? 5 : 4}" class="muted">Додай папери й ціль на місяць, щоб побачити проєкцію.</td></tr>`;
    const paceNote = hasActual
      ? `<div class="muted" style="margin-bottom:10px;font-size:13px">Фактичний темп поповнень: <b>${fmtUAH(s.actual_monthly_uah)}/міс</b> за ${s.actual_months} міс історії (план — ${fmtUAH(C)}/міс).</div>`
      : `<div class="muted" style="margin-bottom:10px;font-size:13px">Прогноз за фактичним темпом зʼявиться після першого поповнення.</div>`;

    return `
      <div class="card">
        <h2>Проєкції капіталу</h2>
        <div class="muted" style="margin-bottom:10px">Старт = капітал ${fmtUAH(P0)}, внесок = ${fmtUAH(C)}/міс, ставка = ${rateSrc}. Модель: реальні купони й погашення наявних паперів + внески, реінвест під ставку; готівка не працює до реінвесту. Обидві колонки — у гривні сьогоднішньої купівельної спроможності, тож «внесено» теж знецінюється: приріст показує, наскільки вкладати вигідніше, ніж просто відкладати. Це припущення, не гарантія.</div>
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
          <label>Цільова частка USD, %<input name="usd_target_share_pct" inputmode="decimal" value="${esc(s.usd_target_share_pct || "")}"></label>
          <label>Цільова частка EUR, %<input name="eur_target_share_pct" inputmode="decimal" value="${esc(s.eur_target_share_pct || "")}"></label>
          <label>Ціль, ₴<input name="goal_amount_uah" inputmode="decimal" placeholder="скільки хочу накопичити" value="${esc(s.goal_amount_uah || "")}"></label>
          <label>Дедлайн — коли<input name="goal_date" type="date" value="${esc(s.goal_date || "")}"></label>
          <label>Гривня слабшає, %/рік<input name="uah_devaluation_pct" inputmode="decimal" placeholder="порожньо = 6" value="${esc(s.uah_devaluation_pct || "")}"></label>
          <label>Довгострокова ставка ОВДП, %<input name="terminal_rate_pct" inputmode="decimal" placeholder="порожньо = 11" value="${esc(s.terminal_rate_pct || "")}"></label>
          <label>Ставка сповзає туди за, років<input name="rate_glide_years" inputmode="decimal" placeholder="порожньо = 5" value="${esc(s.rate_glide_years || "")}"></label>
          <button type="submit">Зберегти</button>
        </form>
      </div>

      ${this._brokerManagerHTML(s)}

      <div class="card">
        <h2>Бекап</h2>
        <div class="muted" style="margin-bottom:10px">Твої лоти, поповнення, конвертації, налаштування й статуси виплат.
          Довідник НБУ не входить — він відновлюється сам. Плюс сервер щодня пише копію поряд із БД (потрапляє в бекап Proxmox).</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" id="btnExport">Завантажити бекап</button>
          <label style="display:inline-block"><span class="muted" style="font-size:13px">Відновити з файлу:</span>
            <input type="file" id="importFile" accept="application/json,.json" style="margin-top:6px"></label>
        </div>
        <div class="muted" id="restoreMsg" style="margin-top:8px;font-size:13px"></div>
      </div>`;
    this._bindBackup(main);
    this._bindBrokers(main);
    main.querySelector("#setForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      // Збираємо payload лише з полів, які РЕАЛЬНО є у формі. Так
      // видалення поля не роняє сабміт і — головне — не шле порожнє
      // значення, яке затерло б налаштування (PUT часткове).
      // «channels» тут свідомо немає: брокерами керує окрема картка.
      const payload = {};
      for (const k of ["usd_target_share_pct", "eur_target_share_pct",
        "goal_amount_uah", "goal_date",
        "uah_devaluation_pct", "terminal_rate_pct", "rate_glide_years"]) {
        if (f.elements[k]) payload[k] = f.elements[k].value.trim();
      }
      try {
        await this._api("PUT", "settings", payload);
        this._toast("Налаштування збережено"); this._loadTab();
      } catch (err) { this._toast(String(err.message || err), false); }
    });
  }

  // Брокери — окремий керований список. Зберігаємо в тому ж налаштуванні
  // channels (через кому), але UI — повноцінний CRUD. Видалення прибирає
  // брокера лише зі списку-підказки: наявні лоти й баланси його не
  // втрачають (там брокер зберігається на кожному записі окремо).
  _parseBrokers(s) {
    return String((s || {}).channels || "").split(",").map((x) => x.trim()).filter(Boolean);
  }

  _brokerManagerHTML(s) {
    const list = this._parseBrokers(s);
    const rows = list.length
      ? list.map((b) => `<div class="pv-row"><span><b>${esc(b)}</b></span>
          <button class="sm warn" data-delbroker="${esc(b)}">✕</button></div>`).join("")
      : `<div class="muted" style="font-size:13px">Ще немає брокерів. Додай mono, inzhur…</div>`;
    return `<div class="card" id="brokerCard">
      <h2>Брокери</h2>
      <div class="muted" style="margin-bottom:10px">Рахунки для купівлі ОВДП. Зʼявляються у випадайках форм грошей і покупки.</div>
      ${rows}
      <form id="brokerAddForm" style="margin-top:10px;display:flex;gap:8px">
        <input name="broker" placeholder="назва брокера" style="flex:0 0 200px" autocomplete="off">
        <button type="submit">Додати</button>
      </form></div>`;
  }

  async _saveBrokers(list) {
    const uniq = [...new Set(list.map((x) => x.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "uk"));
    await this._api("PUT", "settings", { channels: uniq.join(", ") });
    this._loadTab();
  }

  _bindBrokers(main) {
    const card = main.querySelector("#brokerCard");
    if (!card) return;
    // джерело правди — те, що на екрані, а не можливо застарілий this._summary
    const shown = () => [...card.querySelectorAll("[data-delbroker]")].map((b) => b.dataset.delbroker);
    card.querySelector("#brokerAddForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = e.target.broker.value.trim();
      if (!name) return;
      if (shown().some((b) => b.toLowerCase() === name.toLowerCase())) {
        this._toast("Такий брокер уже є", false);
        return;
      }
      try { await this._saveBrokers([...shown(), name]); this._toast("Брокера додано"); }
      catch (err) { this._toast(String(err.message || err), false); }
    });
    card.querySelectorAll("[data-delbroker]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await this._saveBrokers(shown().filter((x) => x !== b.dataset.delbroker)); this._toast("Брокера прибрано"); }
        catch (err) { this._toast(String(err.message || err), false); }
      }));
  }

  _bindBackup(main) {
    // Експорт: тягнемо через проксі (з HA-авторизацією) і зберігаємо як файл.
    main.querySelector("#btnExport").addEventListener("click", async () => {
      try {
        const resp = await this._hass.fetchWithAuth("/api/oddinvest/backup");
        if (!resp.ok) throw new Error(await resp.text());
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "oddinvest-backup-" + today() + ".json";
        a.click();
        URL.revokeObjectURL(url);
        this._toast("Бекап завантажено");
      } catch (err) { this._toast(String(err.message || err), false); }
    });

    // Імпорт: читаємо файл, підтверджуємо (замінює ВСЕ), відновлюємо.
    main.querySelector("#importFile").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const msg = main.querySelector("#restoreMsg");
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const n = (data.lots || []).length;
        if (!confirm(`Відновити з бекапу? Це ЗАМІНИТЬ усі поточні дані (${n} лот(ів) у файлі). Дію не скасувати.`)) {
          e.target.value = "";
          return;
        }
        const res = await this._api("POST", "restore", data);
        const r = res.restored || {};
        msg.textContent = `Відновлено: ${r.lots || 0} лот(ів), ${r.deposits || 0} поповн., ${r.conversions || 0} конверт., ${r.snapshots || 0} знімк.`;
        this._toast("Відновлено з бекапу");
        this._loadTab();
      } catch (err) {
        msg.textContent = "Помилка: " + String(err.message || err);
        this._toast("Не вдалось відновити", false);
      }
      e.target.value = "";
    });
  }
}

if (!customElements.get("odd-invest-panel")) {
  customElements.define("odd-invest-panel", OddInvestPanel);
}
